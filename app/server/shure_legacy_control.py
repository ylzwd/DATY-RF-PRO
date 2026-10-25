"""Compatibility methods attached only to an installed Shure control adapter.

The package retains modern SCP control. Direct legacy ULXD uses local-link MAC
and a fresh SCP profile; older explicit SystemAPI bindings remain compatible.
No command is retried and a separate connection confirms the resulting value.
"""
import asyncio
import time

from command_journal import CommandError
from shure_hardware import frequency_limits
from shure_legacy import systemapi_identity,local_receiver_mac,direct_model
from shure_protocol import ShureReply,extract_framed_messages,MAX_REPLY


class LegacyControl:
    def __init__(self,control):
        self.control=control
        self.original_binding=control.binding
        self.original_send=control.send
        self.identity_provider=systemapi_identity
        self.mac_provider=local_receiver_mac

    def binding(self,did):
        result=self.original_binding(did)
        target,d,_,_=result;s=d.get('shure',{}).get('settings',{})
        if s.get('legacy_scp'):
            if s.get('identity_source')=='direct-scp':
                if not d.get('shure',{}).get('receiver_firmware'):raise CommandError('SHURE_IDENTITY_UNVERIFIED')
                return result
            if (s.get('legacy_control_identity') is not True or s.get('receiver_mac_source')!='windows-arp'
                or s.get('identity_source')!='local-shure-systemapi' or not s.get('receiver_serial')
                or not s.get('systemapi_device_id') or target['receiver_id']!='Shure-'+s['systemapi_device_id']
                or not d.get('shure',{}).get('receiver_firmware')):
                raise CommandError('SHURE_IDENTITY_UNVERIFIED')
        return result

    async def identity(self,d,allowed):
        ip=d['receiver_ip'];s=d['shure']['settings']
        if not allowed():raise CommandError('DISPATCH_CANCELLED_OR_EXPIRED')
        if s.get('identity_source')=='direct-scp':
            mac=await asyncio.to_thread(self.mac_provider,ip)
            if not allowed():raise CommandError('DISPATCH_CANCELLED_OR_EXPIRED')
            if not mac or mac!=s.get('receiver_mac'):raise CommandError('SHURE_LIVE_IDENTITY_MISMATCH')
            return {'ip':ip,'model':d['model'],'firmware':d['shure']['receiver_firmware'],'mac':mac}
        identity,mac=await asyncio.gather(asyncio.to_thread(self.identity_provider,ip),asyncio.to_thread(self.mac_provider,ip))
        if not allowed():raise CommandError('DISPATCH_CANCELLED_OR_EXPIRED')
        if (not identity or identity.get('ip')!=ip or identity.get('device_id')!=s.get('systemapi_device_id')
            or identity.get('serial')!=s.get('receiver_serial') or identity.get('model')!=d['model']
            or identity.get('firmware')!=d['shure']['receiver_firmware'] or not mac or mac!=s.get('receiver_mac')):
            raise CommandError('SHURE_LIVE_IDENTITY_MISMATCH')
        return identity

    async def query(self,d,key,ch,allowed):
        # Complete REP snapshot: old devices reject MODEL/NET_SETTINGS and CRLF.
        reader,writer=await asyncio.wait_for(asyncio.open_connection(d['receiver_ip'],self.control.port),.75)
        try:
            if not allowed():raise CommandError('DISPATCH_CANCELLED_OR_EXPIRED')
            writer.write(b'< GET 0 ALL >');await writer.drain()
            r=ShureReply();pending='';total=0;end=time.monotonic()+1.5
            while allowed() and time.monotonic()<end:
                chunk=await asyncio.wait_for(reader.read(8192),max(.001,end-time.monotonic()))
                if not chunk:break
                total+=len(chunk)
                if total>MAX_REPLY:raise ValueError('SHURE_REPLY_LIMIT')
                frames,pending=extract_framed_messages(pending+chunk.decode('ascii'))
                for frame in frames:r.feed(frame)
                if r.firmware and r.firmware!=d['shure']['receiver_firmware']:
                    raise CommandError('SHURE_LIVE_IDENTITY_MISMATCH')
                if d['shure']['settings'].get('identity_source')=='direct-scp':
                    # GET ALL can arrive channel by channel. Do not classify a
                    # partial dual/quad snapshot as a different single receiver.
                    expected_channels={'ULXD4':1,'ULXD4D':2,'ULXD4Q':4}.get(d['model'],1)
                    if len(r.channels)<expected_channels:continue
                    observed_model=direct_model(r)
                    if observed_model and observed_model!=d['model']:raise CommandError('SHURE_LIVE_IDENTITY_MISMATCH')
                    if not observed_model:continue
                    r.model=observed_model
                else:r.model=d['model']
                if r.firmware and key in r.channel_values().get(ch,{}) and (key!='frequency_khz' or
                    all(k in r.settings for k in ('frequency_diversity_mode','high_density'))):
                    return r,writer
            raise TimeoutError('SHURE_READBACK_TIMEOUT')
        except BaseException:
            writer.close()
            try:await writer.wait_closed()
            except Exception:pass
            raise

    async def send(self,record,*,allowed):
        control=self.control;target,d,_,_=control.validate(record['target'],record['command'])
        if not d.get('shure',{}).get('settings',{}).get('legacy_scp'):
            return await self.original_send(record,allowed=allowed)
        rid=target['receiver_id']
        if rid in control.busy:raise CommandError('SHURE_RECEIVER_BUSY')
        control.busy.add(rid);writers=[];sent=False
        try:
            ch=target['channel_number'];command=record['command'];value=record['expected_value']
            key='frequency_khz' if command=='set_freq' else 'muted'
            identity=await self.identity(d,allowed)
            before,w=await self.query(d,key,ch,allowed);writers.append(w)
            if command=='set_freq':
                band=frequency_limits(d['model'],{**d['shure']['settings'],**before.settings})
                if (not band['verified'] or type(value) is not int or not band['min_khz']<=value<=band['max_khz']
                    or (value-band['origin_khz'])%band['step_khz']):raise CommandError('SHURE_FREQUENCY_OUTSIDE_HARDWARE_BAND')
                if before.settings.get('frequency_diversity_mode')!='OFF' or before.settings.get('high_density') is not False:
                    raise CommandError('SHURE_MODE_REQUIRES_SEPARATE_COORDINATION')
            elif type(value) is not bool or value!=(command=='mute'):raise CommandError('INVALID_MUTE_VALUE')
            control.validate(target,command)
            if not allowed():raise CommandError('DISPATCH_CANCELLED_OR_EXPIRED')
            wire=f'< SET {ch} FREQUENCY {value:06d} >' if command=='set_freq' else f'< SET {ch} AUDIO_MUTE {"ON" if value else "OFF"} >'
            sent=True;sent_at=int(time.time()*1000)
            w.write(wire.encode('ascii'));await w.drain();w.close();await w.wait_closed()
            opened=int(time.time()*1000)
            after,rw=await self.query(d,key,ch,allowed);writers.append(rw)
            if await self.identity(d,allowed)!=identity:raise RuntimeError('SHURE_IDENTITY_CHANGED_DURING_READBACK')
            control.validate(target,command)
            if command=='set_freq' and (after.settings.get('frequency_diversity_mode')!='OFF'
                or after.settings.get('high_density') is not False
                or frequency_limits(d['model'],{**d['shure']['settings'],**after.settings})!=band):
                raise RuntimeError('SHURE_MODE_OR_BAND_CHANGED_DURING_READBACK')
            actual=after.channel_values()[ch].get(key)
            if type(actual) is not type(value) or actual!=value:raise RuntimeError('SHURE_READBACK_MISMATCH')
            if not allowed():raise RuntimeError('SHURE_READBACK_AFTER_DEADLINE')
            return {'source':'shure-post-write-readback','target':target,'command':command,'actual_value':actual,
                'model':after.model,'sent_at_ms':sent_at,'readback_connection_at_ms':opened,
                'received_at_ms':int(time.time()*1000),'execution_ack_supported':False,
                'identity_basis':'direct-scp-and-local-link' if d['shure']['settings'].get('identity_source')=='direct-scp' else 'systemapi-serial-uuid-and-local-arp',
                'receiver_serial':identity.get('serial'),'systemapi_device_id':identity.get('device_id'),'firmware':identity['firmware']}
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
            control.busy.discard(rid)


def attach_legacy_control(control):
    support=LegacyControl(control)
    control.binding=support.binding;control.send=support.send;control.legacy=support
