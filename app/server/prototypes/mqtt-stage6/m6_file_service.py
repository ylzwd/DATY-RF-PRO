"""Durable asynchronous read snapshots; original archive mutations stay in M5.

Acceptance pins the immutable source against cleanup. Socket loss does not
cancel an accepted copy. Queries never start/restart it. After process loss the
staging result is interrupted, not silently rebuilt or reported ready.
"""
import asyncio
import time
from concurrent.futures import ThreadPoolExecutor

from m5_service import FileService as BaseService
from m5_contract import M5Error,fields,identifier,encoded
from m5_files import hash_bytes

class FileService(BaseService):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.executor=ThreadPoolExecutor(max_workers=1,thread_name_prefix='mqtt-file-snapshot')
        self.pending=set()

    async def close(self):
        self.accepting=False
        await asyncio.to_thread(self.executor.shutdown,wait=True)

    async def request(self,request,*,entry,current,peer_ip):
        if request['method']!='downloads.open':return await super().request(request,entry=entry,current=current,peer_ip=peer_ip)
        allowed=self.gate(request,current)
        if entry!='mqtt':raise M5Error('FILE_ENTRY_DISABLED',409)
        return await asyncio.to_thread(self.prepare,request['body'],'network:'+peer_ip,allowed,request['request_id'])

    def operation_status(self,oid,actor):
        with self.store.lock:
            record=self.store.read('operations',oid,actor)
            if record['intent']['method']!='downloads.open' or record['state']!='preparing':
                return super().operation_status(oid,actor)
            transfer=self.store.status('downloads',oid,actor)
            if transfer['state'] in ('interrupted','failed','closed'):
                # Do not rewrite the accepted receipt during a query. The
                # download manifest is the durable preparation outcome.
                return {**self.store.public(record),'state':'failed','error':transfer.get('error','DOWNLOAD_CLOSED'),'result':transfer}
            return {**self.store.public(record),'result':transfer}

    def prepare(self,body,actor,allowed,rid):
        fields(body,('operation_id','category','id','sha256'))
        oid=identifier(body['operation_id']);intent={'method':'downloads.open','body':body}
        intent_hash=hash_bytes(encoded(intent).encode());key=(body['category'],body['id'])
        with self.store.lock:
            if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
            if self.store.folder('requests',rid).exists():
                prior=self.store.read('requests',rid,actor)
                if prior['intent_hash']!=intent_hash:raise M5Error('REQUEST_ID_CONFLICT',409)
            else:
                self.store.capacity();self.store.save('requests',{'id':rid,'actor':actor,'intent_hash':intent_hash})
            if self.store.folder('operations',oid).exists():
                old=self.store.read('operations',oid,actor)
                if old['intent']!=intent:raise M5Error('OPERATION_ID_CONFLICT',409)
                return self.operation_status(oid,actor)
            if len(self.pending)>=2:raise M5Error('SNAPSHOT_PREPARATION_BUSY',429)
            if body['category'] not in ('exports','archives'):raise M5Error('INVALID_CATEGORY')
            with self.archive.lock:
                original=self.archive.get(*key)
                if original['status']!='saved' or original['sha256']!=body['sha256']:raise M5Error('ARCHIVE_CHANGED',409)
                path=self.archive._folder(*key)/('content' if key[0]=='exports' else 'archive.zip')
                size=self.store.safe(path).stat().st_size
                if size!=original['bytes']:raise M5Error('SOURCE_SIZE_CHANGED',409)
                descriptor=self.store.prepare_snapshot(oid,actor,intent,size)
                self.archive.downloads[key]=self.archive.downloads.get(key,0)+1
            record={'id':oid,'actor':actor,'intent':intent,'state':'preparing','result':descriptor,'created_at_ms':self.wall_ms()}
            try:
                self.store.save('operations',record)
                self.pending.add(oid)
                self.executor.submit(self.copy,record,key,path)
            except BaseException:
                self.pending.discard(oid)
                with self.archive.lock:
                    self.archive.downloads[key]-=1
                    if not self.archive.downloads[key]:del self.archive.downloads[key]
                self.store.download_cancels.pop(oid,None)
                self.store.close_download(oid,actor)
                raise
            return self.store.public(record)

    def copy(self,record,key,path):
        oid=record['id'];actor=record['actor']
        try:
            descriptor=self.store.write_snapshot(oid,actor,source=path,expected=record['intent']['body']['sha256'],allowed=lambda:self.accepting)
            record.update(state='completed',result=descriptor,completed_at_ms=self.wall_ms())
        except BaseException as error:
            record.update(state='failed',error=getattr(error,'code','SNAPSHOT_PREPARATION_FAILED'),completed_at_ms=self.wall_ms())
        finally:
            with self.store.lock:
                try:self.store.save('operations',record)
                finally:
                    self.pending.discard(oid)
                    with self.archive.lock:
                        self.archive.downloads[key]-=1
                        if not self.archive.downloads[key]:del self.archive.downloads[key]
