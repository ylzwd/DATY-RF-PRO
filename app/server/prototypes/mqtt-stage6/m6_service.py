"""Single application dispatcher; original domains behind explicit MQTT DTOs."""
import asyncio
import copy
import time
import uuid

import data_contract as data_contract
import m5_contract as file_contract
from m5_contract import M5Error, fields
from m6_contract import validate_request, COMMAND_METHODS
from plugin_install import PluginError
import data_retirement
from m6_commands import CommandService as BaseCommands, validate_request as validate_command
from m6_repository import ACTOR
from command_journal import CommandError

class Commands(BaseCommands):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.fence_times={}
        self.executing={}
        self.reconciliation_task=None
        self.reconciliation_error=None

    async def start(self):
        await super().start()
        self.reconciliation_task=asyncio.create_task(self.reconciliation_loop())

    async def close(self):
        self.accepting=False
        if self.reconciliation_task:
            # Let an in-progress FULL commit finish before closing its repository.
            await self.reconciliation_task
        await super().close()

    def automatic_observation(self,record):
        oid=record['operation_id']
        cutoff=max(record['deadline_at_ms']+2000,record['updated_at_ms'])
        if not self.accepting or oid in self.executing or self.wall_ms()<cutoff:
            raise CommandError('AUTOMATIC_REVIEW_WAITING')
        observed=self.observation(record)
        target,device,_,_=self.adapter.binding(record['target']['device_id'])
        if target!=observed['target'] or int(device.get('_last_seen',0)*1000)<cutoff:
            raise CommandError('CURRENT_RECEIVER_OBSERVATION_REQUIRED')
        key='frequency_khz' if record['command']=='set_freq' else 'muted'
        value=observed[key]
        if (key=='frequency_khz' and (type(value) is not int or value<=0)) or (key=='muted' and type(value) is not bool):
            raise CommandError('CURRENT_RECEIVER_OBSERVATION_REQUIRED')
        if device.get('_source')=='shure-scp':
            s=device.get('shure') or {};field='frequency_khz' if key=='frequency_khz' else 'muted'
            if field in s.get('stale_fields',[]) or s.get('field_times',{}).get(field,0)<cutoff:
                raise CommandError('CURRENT_RECEIVER_OBSERVATION_REQUIRED')
        return observed

    async def reconcile_once(self):
        records=await asyncio.to_thread(self.journal.unresolved_records)
        for record in records:
            if not self.accepting:return
            try:
                observed=self.automatic_observation(record)
                def current():
                    try:return self.automatic_observation(record)==observed
                    except CommandError:return False
                reviewed=await asyncio.to_thread(self.journal.auto_review,record['operation_id'],record['revision'],observed,current)
                await self.notify(reviewed)
            except CommandError as error:
                if error.code in ('JOURNAL_UNAVAILABLE','DATABASE_BUSY'):self.reconciliation_error=error.code
                # Offline, changed identity/value and a competing review retain
                # the original evidence. A later pass may use fresh telemetry.

    async def reconciliation_loop(self):
        while self.accepting:
            try:
                self.reconciliation_error=None
                await self.reconcile_once()
            except Exception as error:
                self.reconciliation_error=type(error).__name__
            await asyncio.sleep(1)


    async def change(self,oid,expected,state,**kwargs):
        result=await super().change(oid,expected,state,**kwargs)
        if oid in self.fenced:
            self.fence_times[oid]=self.monotonic()
        # All dispatch lifetimes are capped at 30 s plus 2 s socket timeout.
        # Keep fences beyond that cap; do not accumulate them during a long run.
        for key,at in tuple(self.fence_times.items()):
            if self.monotonic()-at>60:
                self.fenced.discard(key);self.fence_times.pop(key,None)
        return result

    def observation(self,record):
        target,device,_,_=self.adapter.binding(record['target']['device_id'])
        for key in ('device_id','receiver_id','receiver_mac','channel_number','expected_brand'):
            if target[key]!=record['target'][key]:
                raise CommandError('REVIEW_RECEIVER_IDENTITY_CHANGED')
        return {'target':target,'frequency_khz':self.adapter.b._normalize_frequency_khz(device.get('freq'),'kHz'),
                'muted':self.adapter.b._strict_bool(device.get('muted'),None)}

    async def request(self,request,*,entry,current=lambda:True,peer_ip):
        validate_request(request,'app')
        if entry!='mqtt':raise CommandError('CONTROL_ENTRY_DISABLED')
        if request['boot_id']!=self.boot_id:raise CommandError('SERVER_BOOT_CHANGED')
        remaining=request['deadline_at_ms']-self.wall_ms()
        if remaining<=0 or remaining>30000:raise CommandError('REQUEST_EXPIRED_OR_TOO_LONG')
        if not current() or not self.accepting:raise CommandError('CLIENT_DISCONNECTED')
        actor=self.journal.repo.actor(peer_ip)
        m,b=request['method'],request['body']
        token=ACTOR.set(actor)
        try:
            if m=='commands.uncertain':
                fields(b)
                records=await asyncio.to_thread(self.journal.uncertain,actor)
                for r in records:
                    try:r['current_observation']=self.observation(r)
                    except CommandError:r['current_observation']=None
                return {'operations':records}
            if m=='commands.review':
                fields(b,('operation_id','expected_revision','confirmed','note','observation'))
                record=await asyncio.to_thread(self.journal.owned,b['operation_id'],actor)
                observed=self.observation(record)
                if b['observation']!=observed:raise CommandError('REVIEW_OBSERVATION_CHANGED')
                if not current() or self.wall_ms()>=request['deadline_at_ms']:
                    raise CommandError('REVIEW_EXPIRED')
                end=self.monotonic()+remaining/1000
                def review_current():
                    return current() and self.accepting and self.monotonic()<end and self.wall_ms()<request['deadline_at_ms'] and self.observation(record)==observed
                return await asyncio.to_thread(self.journal.review,b['operation_id'],b['expected_revision'],
                    b['confirmed'],b['note'],observed,actor,review_current)
            if m=='commands.get':
                validate_command(request)
                return await asyncio.to_thread(self.journal.owned,b['operation_id'],actor)
            if m=='commands.by_id':
                fields(b,('command_id',))
                record=await asyncio.to_thread(self.journal.by_command,b['command_id'])
                if record is None:raise CommandError('NOT_FOUND')
                return await asyncio.to_thread(self.journal.owned,record['operation_id'],actor)
            oid=b.get('operation_id') if m=='commands.request' else None
            if oid:self.executing[oid]=self.executing.get(oid,0)+1
            try:return await super().request(request,entry=entry,current=current)
            finally:
                if oid:
                    count=self.executing[oid]-1
                    if count:self.executing[oid]=count
                    else:self.executing.pop(oid,None)
        finally:
            ACTOR.reset(token)

class Application:
    def __init__(self,commands,data,files,enrollment,bridge,boot_id,*,mode='app',network_status,plugins=None):
        self.commands,self.data,self.files,self.enrollment=commands,data,files,enrollment
        self.bridge,self.boot_id,self.mode=bridge,boot_id,mode
        self.network_status=network_status
        self.plugins=plugins
        self.accepting=True
        self.wall_ms=lambda:int(time.time()*1000)
        for service in (commands,data,files,enrollment):
            service.boot_id=boot_id

    def disconnected(self,sid):
        if self.mode=='enrollment':self.enrollment.disconnected(sid)

    async def request(self,request,*,entry,current,peer_ip):
        validate_request(request,self.mode)
        if entry!='mqtt':raise M5Error('LEGACY_ENTRY_DISABLED',410)
        if request['boot_id']!=self.boot_id:raise M5Error('SERVER_BOOT_CHANGED',409)
        if not self.accepting or not current():raise M5Error('CONNECTION_CHANGED',409)
        if not 0<request['deadline_at_ms']-self.wall_ms()<=30000:raise M5Error('REQUEST_EXPIRED',408)
        method=request['method']
        try:data_retirement.check_request(method,request['body'])
        except data_retirement.RetiredDataError as error:raise M5Error(error.code,error.status) from error
        def active():return self.accepting and current()
        args={'entry':'mqtt','current':active,'peer_ip':peer_ip}
        if method in ('discovery.scan','discovery.cancel') and self.plugins and 'shure-scp' not in self.plugins.active:
            raise M5Error('BRAND_PLUGIN_NOT_INSTALLED',409)
        if method=='discovery.scan' and self.plugins and 'shure-scp' in self.plugins.removal.draining:
            raise M5Error('PLUGIN_REMOVAL_PENDING',409)
        if method.startswith('plugins.'):
            if self.plugins is None:raise M5Error('PLUGIN_SERVICE_UNAVAILABLE',503)
            body=request['body']
            def allowed():return active() and self.wall_ms()<request['deadline_at_ms']
            try:
                if method=='plugins.status':
                    fields(body);return await asyncio.to_thread(self.plugins.status)
                if method=='plugins.remove_exported':
                    fields(body,('plugin_id','sha256','operation_id','expected_revision','export_sha256','export_bytes'))
                    return await asyncio.to_thread(self.plugins.removal.request,body,'network:'+peer_ip,allowed)
                if method=='plugins.operation':
                    fields(body,('operation_id',))
                    return await asyncio.to_thread(self.plugins.store.operation,body['operation_id'],'network:'+peer_ip)
                if method=='plugins.scan.start':
                    return await asyncio.to_thread(self.plugins.scans.start,request,peer_ip,allowed)
                if method=='plugins.scan.cancel':
                    return await asyncio.to_thread(self.plugins.scans.cancel,request,peer_ip,allowed)
                if method=='plugins.scan.status':
                    result=await asyncio.to_thread(self.plugins.scans.status,body,peer_ip)
                    return await self.result_or_transfer(result,request,peer_ip,allowed)
                if method=='plugins.scan_file':
                    fields(body,('plugin_id','file_base64','file_sha256'))
                    result=await asyncio.to_thread(self.plugins.read_scan_file,body['plugin_id'],body['file_base64'],body['file_sha256'],allowed=allowed)
                    if not allowed():raise M5Error('SCAN_READ_CANCELLED',409)
                    return await self.result_or_transfer(result,request,peer_ip,allowed)
                fields(body,('package_base64',) if method=='plugins.preview' else ('package_base64','operation_id','expected_revision','sha256'))
                item=await asyncio.to_thread(self.plugins.store.catalog.decode,body['package_base64'])
                if not allowed():raise M5Error('INSTALL_REQUEST_EXPIRED',409)
                if method=='plugins.preview':return await asyncio.to_thread(self.plugins.store.preview,item['raw'])
                if item['sha256']!=body['sha256']:raise M5Error('PLUGIN_PACKAGE_CHANGED',409)
                return await asyncio.to_thread(self.plugins.store.install,item['raw'],operation_id=body['operation_id'],
                    expected_revision=body['expected_revision'],actor='network:'+peer_ip,allowed=allowed,activate=self.plugins.activate)
            except PluginError as error:raise M5Error(error.code,error.status) from error
        if method in COMMAND_METHODS:
            return await self.commands.request(request,**args)
        if method in ('discovery.uncertain','discovery.review'):
            return await self.data.review_request(request,**args)
        if method=='uploads.release':
            end=time.monotonic()+(request['deadline_at_ms']-self.wall_ms())/1000
            return await asyncio.to_thread(self.files.store.release,request['body'],'network:'+peer_ip,
                lambda:active() and time.monotonic()<end and self.wall_ms()<request['deadline_at_ms'])
        if method=='network.status':
            fields(request['body'])
            result=await asyncio.to_thread(self.network_status)
            return {**result,'peer_ip':peer_ip,'transport':'mqtt','server_id':request['server_id']}
        if method=='devices.snapshot':
            fields(request['body'])
            devices=await asyncio.to_thread(self.bridge._get_devices_snapshot)
            return {'success':True,'devices':devices,'server_time_ms':self.wall_ms()}
        if method in file_contract.FILE_METHODS | file_contract.ENROLL_METHODS:
            mode='enrollment' if method in file_contract.ENROLL_METHODS else 'files'
            inner={**request,'schema':file_contract.schema(mode),'server_id':file_contract.SERVER}
            return await (self.enrollment if mode=='enrollment' else self.files).request(inner,**args)
        inner={**request,'schema':data_contract.SCHEMA,'server_id':data_contract.SERVER}
        result=await self.data.request(inner,**args)
        if method=='state.capabilities' and result.get('status')==200 and self.plugins:
            result['body']=self.plugins.filter_capabilities(result['body'])
        if method=='state.capabilities' and result.get('status')==200:
            result['body']['data_storage']=data_retirement.capabilities()
        if method=='discovery.status' and result.get('status')==200:
            result['body']['active_operation_id']=self.data.active_scan
        return await self.result_or_transfer(result,request,peer_ip,lambda:active() and self.wall_ms()<request['deadline_at_ms'])

    async def result_or_transfer(self,result,request,peer_ip,allowed):
        raw=await asyncio.to_thread(lambda:file_contract.encoded(result).encode())
        if request['method']=='plugins.scan_file' and not allowed():raise M5Error('SCAN_READ_CANCELLED',409)
        if len(raw)<=file_contract.MAX_BYTES-2048:return result
        descriptor=await asyncio.to_thread(self.files.store.snapshot,uuid.uuid4().hex,'network:'+peer_ip,
            {'kind':'rpc-result','request_id':request['request_id']},raw=raw,
            allowed=allowed)
        return {'transfer':descriptor,'encoding':'json-utf8','status':'download_required'}
