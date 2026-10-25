"""Existing authorized journal -> one SCP SET -> fresh connection state readback.

Readback is an observation, not a correlated hardware execution ACK. Never
retry a SET, including after timeout, socket failure or uncertain FULL commit.
"""
import asyncio
import copy
import time
from command_journal import CommandError
from shure_protocol import ShureReply, extract_framed_messages, MAX_REPLY, MODELS
from shure_hardware import band_identity

class ShureControlRouter:
    def __init__(self,bus,*,port=2202):
        self.bus,self.b,self.port=bus,bus.b,port
        self.busy=set()
    @property
    def service(self):return self.bus.service
    @service.setter
    def service(self,value):self.bus.service=value
    def is_shure(self,did):
        with self.b._state_lock:return self.b._state['devices'].get(did,{}).get('_source')=='shure-scp'
    def binding(self,did):
        if not self.is_shure(did):return self.bus.binding(did)
        with self.b._state_lock:d=copy.deepcopy(self.b._state['devices'][did])
        s=d.get('shure') or {};settings=s.get('settings') or {};ch=d.get('channel_number')
        if (time.time()-d.get('_last_seen',0)>=self.b.DEVICE_ONLINE_SECONDS or s.get('meter_state')!='live'
            or time.time()*1000-s.get('meter_received_at_ms',0)>2000):raise CommandError('TARGET_OFFLINE')
        if (d.get('brand')!='Shure' or d.get('model') not in MODELS or type(ch) is not int
            or not 1<=ch<=MODELS[d['model']][1] or not settings.get('receiver_mac')
            or not s.get('meter_stream_id') or settings.get('network_ip')!=d.get('receiver_ip')):
            raise CommandError('SHURE_IDENTITY_UNVERIFIED')
        target={'device_id':did,'receiver_id':d['receiver_id'],'receiver_mac':settings['receiver_mac'],
            'receiver_ip':d['receiver_ip'],'receiver_session_id':s['meter_stream_id'],
            'channel_number':ch,'expected_brand':'Shure'}
        return target,d,None,None
    def targets(self):
        result=self.bus.targets()
        with self.b._state_lock:ids=list(self.b._state['devices'])
        for did in ids:
            if not self.is_shure(did):continue
            try:
                target,d,_,_=self.binding(did);caps=self.b._device_capabilities(d,d)
                if caps['mute'] or caps['write_frequency']:
                    result.append({'target':target,'group_number':d.get('group_number'),
                        'group_source':d.get('group_source'),'model':d['model'],'capabilities':caps})
            except CommandError:pass
        return sorted(result,key=lambda x:(x['group_number'] if type(x.get('group_number')) is int else float('inf'),x['target']['channel_number']))
    def validate(self,target,command):
        if not self.is_shure(target['device_id']):return self.bus.validate(target,command)
        bound,d,_,_=self.binding(target['device_id'])
        if bound!=target:raise CommandError('TARGET_BINDING_CHANGED')
        cap='write_frequency' if command=='set_freq' else 'mute'
        if command not in ('set_freq','mute','unmute') or not self.b._device_capabilities(d,d).get(cap):
            raise CommandError('SHURE_CAPABILITY_OR_BAND_UNVERIFIED')
        return bound,d,None,None
    async def query(self,ip,commands,predicate,allowed):
        reader,writer=await asyncio.wait_for(asyncio.open_connection(ip,self.port),.75)
        try:
            if not allowed():raise CommandError('DISPATCH_CANCELLED_OR_EXPIRED')
            writer.write(('\r\n'.join(commands)+'\r\n').encode('ascii'));await writer.drain()
            reply=ShureReply();pending='';total=0;end=time.monotonic()+1.5
            while time.monotonic()<end and allowed():
                chunk=await asyncio.wait_for(reader.read(8192),max(.001,end-time.monotonic()))
                if not chunk:break
                total+=len(chunk)
                if total>MAX_REPLY:raise ValueError('SHURE_REPLY_LIMIT')
                frames,pending=extract_framed_messages(pending+chunk.decode('ascii'))
                for frame in frames:reply.feed(frame)
                if predicate(reply):return reply,writer
            raise TimeoutError('SHURE_READBACK_TIMEOUT')
        except BaseException:
            writer.close()
            try:await writer.wait_closed()
            except Exception:pass
            raise
    async def send(self,record,*,allowed):
        if not self.is_shure(record['target']['device_id']):return await self.bus.send(record,allowed=allowed)
        target,d,_,_=self.validate(record['target'],record['command']);rid=target['receiver_id']
        if rid in self.busy:raise CommandError('SHURE_RECEIVER_BUSY')
        self.busy.add(rid);writers=[];sent=False
        try:
            ch=target['channel_number'];command=record['command'];value=record['expected_value']
            key='FREQUENCY' if command=='set_freq' else 'AUDIO_MUTE'
            queries=['< GET MODEL >','< GET NET_SETTINGS SC >',f'< GET {ch} {key} >']
            if command=='set_freq':queries+=['< GET FREQUENCY_DIVERSITY_MODE >','< GET HIGH_DENSITY >']
            def identity(r):
                return bool(r.model and r.settings.get('receiver_mac') and r.settings.get('network_ip'))
            def observed(r):return ('frequency_khz' if command=='set_freq' else 'muted') in r.channel_values().get(ch,{})
            def ready(r):return identity(r) and observed(r) and (command!='set_freq' or all(k in r.settings for k in ('frequency_diversity_mode','high_density')))
            # Mute is an absolute SET: its old value is not used by any check.
            # Keep fresh MODEL/MAC/IP and current session/capability validation;
            # retain the full independent post-write query and all frequency checks.
            prequeries = queries if command=='set_freq' else queries[:2]
            preready = ready if command=='set_freq' else identity
            before,w=await self.query(target['receiver_ip'],prequeries,preready,allowed);writers.append(w)
            def check(r):
                if r.model!=d['model'] or r.settings.get('receiver_mac')!=target['receiver_mac'] or r.settings.get('network_ip')!=target['receiver_ip']:
                    raise CommandError('SHURE_LIVE_IDENTITY_MISMATCH')
            check(before)
            if command=='set_freq':
                band=band_identity(d['model'],{**d['shure']['settings'],**before.settings})
                if (not band['verified'] or type(value) is not int or not band['min_khz']<=value<=band['max_khz']
                    or (value-band['origin_khz'])%band['step_khz']):raise CommandError('SHURE_FREQUENCY_OUTSIDE_HARDWARE_BAND')
                if before.settings.get('frequency_diversity_mode')!='OFF' or before.settings.get('high_density') is not False:
                    raise CommandError('SHURE_MODE_REQUIRES_SEPARATE_COORDINATION')
            elif type(value) is not bool or value!=(command=='mute'):raise CommandError('INVALID_MUTE_VALUE')
            self.validate(target,command)
            if not allowed():raise CommandError('DISPATCH_CANCELLED_OR_EXPIRED')
            wire=f'< SET {ch} {key} {value:06d} >' if command=='set_freq' else f'< SET {ch} {key} {"ON" if value else "OFF"} >'
            sent=True;sent_at=int(time.time()*1000)
            w.write((wire+'\r\n').encode('ascii'));await w.drain()
            # A new socket cannot contain pre-write buffered telemetry. No SET
            # reply is called an ACK, and no matching historical sample is used.
            w.close();await w.wait_closed()
            opened=int(time.time()*1000)
            after,rw=await self.query(target['receiver_ip'],queries,ready,allowed);writers.append(rw)
            check(after);self.validate(target,command)
            if command=='set_freq' and (after.settings.get('frequency_diversity_mode')!='OFF'
                or after.settings.get('high_density') is not False
                or band_identity(d['model'],{**d['shure']['settings'],**after.settings})!=band):
                raise RuntimeError('SHURE_MODE_OR_BAND_CHANGED_DURING_READBACK')
            actual=after.channel_values()[ch].get('frequency_khz' if command=='set_freq' else 'muted')
            if type(actual) is not type(value) or actual!=value:raise RuntimeError('SHURE_READBACK_MISMATCH')
            if not allowed():raise RuntimeError('SHURE_READBACK_AFTER_DEADLINE')
            return {'source':'shure-post-write-readback','target':target,'command':command,'actual_value':actual,
                'model':after.model,'sent_at_ms':sent_at,'readback_connection_at_ms':opened,
                'received_at_ms':int(time.time()*1000),'execution_ack_supported':False}
        except CommandError as error:
            if sent:raise RuntimeError('SHURE_OUTCOME_UNKNOWN') from error
            raise
        except Exception as error:
            if sent:raise
            raise CommandError('SHURE_PRECHECK_FAILED_NOT_SENT') from error
        finally:
            for writer in writers:
                writer.close()
                try:await writer.wait_closed()
                except Exception:pass
            self.busy.discard(rid)
