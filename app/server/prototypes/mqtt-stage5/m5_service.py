"""M5 application ports: existing archives, M4 atomic data authority, original enrollment."""
import asyncio
import json
import shutil
import time
import uuid

from data_contract import validate_request as validate_data, WRITES, DataError, SCHEMA as DATA_SCHEMA, SERVER as DATA_SERVER
from data_repository import Repository
from data_service import DataService
from receiver_gateway import strict_json
from receiver_enrollment import ReceiverEnrollment, EnrollmentError
from m5_contract import M5Error, MAX_BYTES, MAX_UPLOAD, fields, identifier, encoded, validate_request
from m5_files import hash_bytes
import data_retirement

class LargeRepository(Repository):
    @staticmethod
    def bound(value):
        if len(encoded(value).encode())>MAX_UPLOAD:raise DataError('DOCUMENT_TOO_LARGE',413)
        return value

class LargeDataService(DataService):
    async def invoke(self,document,request,actor,allowed):
        fields(document,('method','body'))
        method,body=document['method'],document['body']
        if not isinstance(method,str) or not isinstance(body,dict):raise M5Error('INVALID_DATA_DOCUMENT')
        try:data_retirement.check_request(method,body)
        except data_retirement.RetiredDataError as error:raise M5Error(error.code,error.status) from error
        if method.startswith('discovery.') or method.startswith('state.'):
            raise M5Error('USE_M4_INLINE_QUERY')
        inner={**request,'schema':DATA_SCHEMA,'server_id':DATA_SERVER,'boot_id':self.boot_id,'method':method,'body':body}
        # Retain the original allowlist/envelope/epoch checks. Only its inline
        # size gate is replaced by the verified, bounded file transport.
        skeleton={'operation_id':body.get('operation_id'),'epoch':body.get('epoch')} if method in WRITES else {}
        validate_data({**inner,'body':skeleton})
        try:return await asyncio.to_thread(self.run,inner,self.repo.actor(actor[8:]),allowed)
        except Exception as error:
            if hasattr(error,'code'):return await self.error_result(error)
            raise

class ServiceBase:
    mode='files'
    def __init__(self):
        self.boot_id=uuid.uuid4().hex;self.accepting=True
        self.wall_ms=lambda:int(time.time()*1000)

    def gate(self,request,current):
        validate_request(request,self.mode)
        if request['boot_id']!=self.boot_id:raise M5Error('SERVER_BOOT_CHANGED',409)
        remaining=request['deadline_at_ms']-self.wall_ms()
        if remaining<=0 or remaining>30000:raise M5Error('REQUEST_EXPIRED',408)
        end=time.monotonic()+remaining/1000
        def allowed():return self.accepting and current() and time.monotonic()<end and self.wall_ms()<request['deadline_at_ms']
        if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
        return allowed

class FileService(ServiceBase):
    def __init__(self,store,archive,data):
        super().__init__();self.store,self.archive,self.data=store,archive,data
        self.data_lock=asyncio.Lock()

    async def request(self,request,*,entry,current,peer_ip):
        allowed=self.gate(request,current)
        if entry!='mqtt':raise M5Error('FILE_ENTRY_DISABLED',409)
        actor='network:'+peer_ip;m=request['method'];b=request['body']
        if m=='data.invoke':
            fields(b,('upload_id','sha256'))
            async with self.data_lock:
                if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
                record=await asyncio.to_thread(self.store.read,'uploads',b['upload_id'],actor)
                if record['media_type']!='application/json':raise M5Error('JSON_UPLOAD_REQUIRED')
                raw=await asyncio.to_thread(self.store.bytes_for,b,actor)
                document=await asyncio.to_thread(strict_json,raw)
                result=await self.data.invoke(document,request,actor,allowed)
                raw=await asyncio.to_thread(lambda:encoded(result).encode())
        else:
            result=await asyncio.to_thread(self.run,m,b,actor,allowed,request['request_id'])
            raw=await asyncio.to_thread(lambda:encoded(result).encode())
        if len(raw)<=MAX_BYTES-2048:return result
        descriptor=await asyncio.to_thread(self.store.snapshot,uuid.uuid4().hex,actor,
            {'kind':'rpc-result','request_id':request['request_id']},raw=raw,allowed=allowed)
        return {'transfer':descriptor,'encoding':'json-utf8','status':'download_required'}

    def run(self,m,b,actor,allowed,rid):
        with self.store.lock:
            if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
            if m=='uploads.begin':return self.store.begin(b,actor)
            if m=='uploads.chunk':return self.store.chunk(b,actor,allowed)
            if m=='uploads.finish':return self.store.finish(b,actor,allowed)
            if m in ('uploads.status','downloads.status'):
                fields(b,('id',));return self.store.status(m.split('.')[0],b['id'],actor)
            if m=='uploads.cancel':
                fields(b,('upload_id',));return self.store.cancel(b['upload_id'],actor)
            if m=='downloads.chunk':return self.store.download_chunk(b,actor)
            if m=='downloads.close':
                fields(b,('download_id',));return self.store.close_download(b['download_id'],actor)
            if m=='file.operations.get':
                fields(b,('operation_id',));return self.operation_status(b['operation_id'],actor)
            if m=='storage.status':
                fields(b)
                return {'protocol':'daty-server-archive-v1','databaseBytes':self.archive.source.stat().st_size,
                    'archiveDirectory':str(self.archive.directory),'diskFreeBytes':shutil.disk_usage(self.archive.directory).free,
                    'archives':len(self.archive.list('archives')),'exports':len(self.archive.list('exports')),
                    'cleanupProtocol':'daty-archive-cleanup-v1','archiveBusy':bool(self.archive.active)}
            if m in ('archives.list','exports.list'):
                fields(b);return {'items':self.archive.list(m.split('.')[0])}
            if m in ('archives.get','exports.get','cleanups.get'):
                fields(b,('id',))
                return self.archive.get_cleanup(b['id']) if m=='cleanups.get' else self.archive.get(m.split('.')[0],b['id'])
            return self.mutate(m,b,actor,allowed,rid)

    def operation_status(self,oid,actor):
        record=self.store.read('operations',oid,actor)
        if record['state']=='started':
            # Query existing durable domain receipts only. No write replay.
            m=record['intent']['method'];b=record['intent']['body']
            try:
                if m in ('archives.create','exports.create'):
                    result=self.archive.get(m.split('.')[0],oid)
                elif m in ('cleanups.prepare','cleanups.commit'):
                    result=self.archive.get_cleanup(b.get('cleanup_id',oid))
                elif m=='downloads.open':result=self.store.status('downloads',oid,actor)
                else:result=None
            except Exception:result=None
            return {**self.store.public(record),'state':'unknown','domain_status':result}
        return self.store.public(record)

    def mutate(self,m,b,actor,allowed,rid):
        required={
            'exports.create':('operation_id','upload_id','sha256','fileName','mimeType','source'),
            'archives.create':('operation_id',),
            'downloads.open':('operation_id','category','id','sha256'),
            'cleanups.prepare':('operation_id','selection'),
            'cleanups.commit':('operation_id','cleanup_id','confirmed','planSha256')}
        if m not in required:raise M5Error('INVALID_METHOD')
        fields(b,required[m]);oid=identifier(b['operation_id'])
        intent={'method':m,'body':b};intent_hash=hash_bytes(encoded(intent).encode())
        # Request IDs cannot acquire a different operation/intent, even on reconnect.
        if self.store.folder('requests',rid).exists():
            prior=self.store.read('requests',rid,actor)
            if prior['intent_hash']!=intent_hash:raise M5Error('REQUEST_ID_CONFLICT',409)
        else:
            self.store.capacity();self.store.save('requests',{'id':rid,'actor':actor,'intent_hash':intent_hash})
        if self.store.folder('operations',oid).exists():
            record=self.store.read('operations',oid,actor)
            if record['intent']!=intent:raise M5Error('OPERATION_ID_CONFLICT',409)
            return self.operation_status(oid,actor)
        self.store.capacity()
        record={'id':oid,'actor':actor,'intent':intent,'state':'started','created_at_ms':self.wall_ms()}
        self.store.save('operations',record)
        if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
        if m=='exports.create':
            raw=self.store.bytes_for({'upload_id':b['upload_id'],'sha256':b['sha256']},actor)
            text=raw.decode('utf-8',errors='strict')
            if text.encode('utf-8')!=raw:raise M5Error('TEXT_ROUNDTRIP_FAILED')
            result=self.archive.export({k:b[k] for k in ('operation_id','fileName','mimeType','source')}|{'text':text},actor)
            if result['sha256']!=b['sha256'] or result['bytes']!=len(raw):raise M5Error('EXPORT_DIGEST_MISMATCH',503)
        elif m=='archives.create':result=self.archive.create(b,actor)
        elif m=='cleanups.prepare':result=self.archive.prepare_cleanup(b,actor)
        elif m=='cleanups.commit':
            result=self.archive.commit_cleanup(b['cleanup_id'],{k:b[k] for k in ('confirmed','planSha256')},actor)
        else:
            if b['category'] not in ('exports','archives'):raise M5Error('INVALID_CATEGORY')
            key=(b['category'],b['id'])
            with self.archive.lock:
                original=self.archive.get(*key)
                if original['status']!='saved' or original['sha256']!=b['sha256']:raise M5Error('ARCHIVE_CHANGED',409)
                self.archive.downloads[key]=self.archive.downloads.get(key,0)+1
                try:
                    path=self.archive._folder(*key)/('content' if key[0]=='exports' else 'archive.zip')
                    result=self.store.snapshot(oid,actor,intent,source=path,expected=b['sha256'],allowed=allowed)
                finally:
                    self.archive.downloads[key]-=1
                    if not self.archive.downloads[key]:del self.archive.downloads[key]
        record.update(state='completed',result=result,completed_at_ms=self.wall_ms())
        self.store.save('operations',record);return self.store.public(record)

class EnrollmentService(ServiceBase):
    mode='enrollment'
    def __init__(self,enrollment):
        super().__init__();self.enrollment=enrollment;self.pending={};self.lock=asyncio.Lock()

    async def request(self,request,*,entry,current,peer_ip):
        allowed=self.gate(request,current)
        if entry!='mqtt':raise M5Error('ENROLLMENT_ENTRY_DISABLED',409)
        async with self.lock:
            if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
            sid=request['client_session_id'];body=request['body']
            self.pending={k:v for k,v in self.pending.items() if v['end']>time.monotonic()}
            try:
                if request['method']=='receivers.challenge':
                    fields(body,('protocol','receiver_mac','brand','channel_count','public_key'))
                    if len(self.pending)>=128:raise M5Error('CHALLENGE_LIMIT',429)
                    result=await asyncio.to_thread(self.enrollment.challenge,body,peer_ip)
                    self.pending[result['challenge_id']]={'sid':sid,'peer':peer_ip,'end':time.monotonic()+30}
                    return result
                fields(body,('challenge_id','signature'))
                prior=self.pending.get(body['challenge_id'])
                if not prior or prior['sid']!=sid or prior['peer']!=peer_ip:raise M5Error('CHALLENGE_CONNECTION_CHANGED',403)
                self.pending.pop(body['challenge_id'])
                if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
                # No durable RPC receipt or secret cache. A lost response requires
                # a fresh signed challenge; never replay a completed enrollment.
                return await asyncio.to_thread(self.enrollment.complete,body,peer_ip)
            except EnrollmentError as error:raise M5Error(error.code,error.status)

    def disconnected(self,sid):
        self.pending={k:v for k,v in self.pending.items() if v['sid']!=sid}
