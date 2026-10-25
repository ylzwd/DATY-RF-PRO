"""Explicit release of consumed temporary bytes; business archives untouched."""
from m5_files import FileStore as BaseStore
from m5_contract import M5Error,fields,CHUNK,integer
import json
import hashlib
import os
import shutil
import threading
import time

# File bytes are streamed; the limits bound staging disk usage, not RAM.
MAX_DOWNLOAD=64*1024**3
MAX_STAGING=128*1024**3

class FileStore(BaseStore):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.download_cancels={}
        try:
            # Only finish previously confirmed releases. Keep every receipt and
            # all unfinished/unknown uploads; never age-delete business data.
            for path in self.root.glob('uploads/*/manifest.json'):
                record=json.loads(self.safe(path).read_text('utf-8'))
                if record.get('state')=='releasing':
                    self.release({'upload_id':record['id'],'sha256':record['sha256'],'consumed':True},record['actor'])
            for path in self.root.glob('downloads/*/manifest.json'):
                record=json.loads(self.safe(path).read_text('utf-8'))
                if record.get('state') in ('preparing','writing','cancelling'):
                    record.update(state='interrupted',error='PROCESS_INTERRUPTED')
                    self.save('downloads',record)
                elif record.get('state')=='closing':self.close_download(record['id'],record['actor'])
        except BaseException:
            self.close();raise

    def release(self,body,actor,allowed=lambda:True):
        fields(body,('upload_id','sha256','consumed'))
        if body['consumed'] is not True:raise M5Error('CONSUMED_CONFIRMATION_REQUIRED',409)
        with self.lock:
            if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
            record=self.read('uploads',body['upload_id'],actor)
            if record['sha256']!=body['sha256']:raise M5Error('FILE_DIGEST_MISMATCH',409)
            if record['state']=='closed':return self.public(record)
            if record['state'] not in ('ready','releasing'):raise M5Error('READY_UPLOAD_REQUIRED',409)
            # A retained immutable receipt proves which bytes were released.
            # Domain outcomes are queried by their own operation IDs, never
            # reconstructed or replayed from a removed upload.
            record['state']='releasing';self.save('uploads',record)
            folder=self.folder('uploads',record['id'])
            names={'content','content.pending'}|{str(n)+suffix for n in range(0,record['bytes'],CHUNK) for suffix in ('.chunk','.pending')}
            paths=[]
            for path in folder.iterdir():
                self.safe(path)
                if path.name in ('manifest.json','manifest.pending'):continue
                if path.name not in names or not path.is_file():raise M5Error('UNEXPECTED_STAGING_FILE',409)
                paths.append(path)
            for path in paths:path.unlink()
            record['state']='closed';record['release_reason']='consumed-temporary-upload';self.save('uploads',record)
            return self.public(record)

    def capacity(self,extra=0):
        records=list(self.root.glob('*/*/manifest.json'))
        if len(records)>=8192:raise M5Error('STAGING_RECORD_LIMIT',429)
        reserved=0
        for path in records:
            if path.parent.parent.name not in ('uploads','downloads'):continue
            record=json.loads(self.safe(path).read_text('utf-8'))
            if record.get('state') in ('closed','cancelled'):continue
            size=record.get('bytes',0)
            reserved+=size*2 if path.parent.parent.name=='uploads' else size+((size+CHUNK-1)//CHUNK)*32
        if reserved+extra>MAX_STAGING or shutil.disk_usage(self.root).free<extra+64*1024**2:
            raise M5Error('STAGING_CAPACITY',507)

    def prepare_snapshot(self,oid,actor,intent,size):
        with self.lock:
            folder=self.folder('downloads',oid)
            if folder.exists():
                old=self.read('downloads',oid,actor)
                if old['intent']!=intent:raise M5Error('DOWNLOAD_INTENT_CONFLICT',409)
                return self.public(old)
            integer(size,MAX_DOWNLOAD);self.capacity(size+((size+CHUNK-1)//CHUNK)*32)
            record={'id':oid,'actor':actor,'intent':intent,'state':'preparing','bytes':size,'prepared_bytes':0,
                    'index_format':'sha256-binary-v1','created_at_ms':int(time.time()*1000)}
            self.save('downloads',record);self.download_cancels[oid]=threading.Event()
            return self.public(record)

    def write_snapshot(self,oid,actor,*,source=None,raw=None,expected=None,allowed=lambda:True):
        with self.lock:
            record=self.read('downloads',oid,actor)
            if record['state'] not in ('preparing','cancelling'):raise M5Error('DOWNLOAD_NOT_PREPARING',409)
            cancel=self.download_cancels[oid];folder=self.folder('downloads',oid)
            pending=self.safe(folder/'content.pending');index=self.safe(folder/'hashes.pending')
        sha=hashlib.sha256();total=0;last_save=time.monotonic()
        def blocks():
            if raw is not None:
                for offset in range(0,len(raw),CHUNK):yield raw[offset:offset+CHUNK]
            else:
                with self.safe(source).open('rb') as stream:
                    while True:
                        block=stream.read(CHUNK)
                        if not block:break
                        yield block
        try:
            if cancel.is_set() or not allowed():raise M5Error('DOWNLOAD_PREPARATION_STOPPED',409)
            with pending.open('xb') as output,index.open('xb') as hashes:
                for block in blocks():
                    if cancel.is_set() or not allowed():raise M5Error('DOWNLOAD_PREPARATION_STOPPED',409)
                    if total+len(block)>record['bytes']:raise M5Error('SOURCE_SIZE_CHANGED',409)
                    output.write(block);hashes.write(hashlib.sha256(block).digest());sha.update(block);total+=len(block)
                    if time.monotonic()-last_save>=1:
                        with self.lock:
                            if not cancel.is_set():
                                record['prepared_bytes']=total;self.save('downloads',record)
                        last_save=time.monotonic()
                output.flush();os.fsync(output.fileno());hashes.flush();os.fsync(hashes.fileno())
            digest=sha.hexdigest()
            if total!=record['bytes'] or (expected and digest!=expected):raise M5Error('SOURCE_DIGEST_MISMATCH',503)
            with self.lock:
                if cancel.is_set() or not allowed():raise M5Error('DOWNLOAD_PREPARATION_STOPPED',409)
                os.replace(pending,self.safe(folder/'content'));os.replace(index,self.safe(folder/'hashes'))
                record.update(state='ready',sha256=digest,prepared_bytes=total)
                self.save('downloads',record);return self.public(record)
        except BaseException as error:
            with self.lock:
                record.update(state='failed',error=getattr(error,'code','SNAPSHOT_PREPARATION_FAILED'),prepared_bytes=total)
                self.save('downloads',record)
            raise
        finally:
            with self.lock:
                self.download_cancels.pop(oid,None)
                if cancel.is_set():self.close_download(oid,actor)

    def snapshot(self,oid,actor,intent,*,source=None,raw=None,expected=None,allowed=lambda:True):
        # Bounded inline JSON replies also use the compact index. Archive files
        # call prepare/write separately through the durable background job.
        with self.lock:
            if self.folder('downloads',oid).exists():
                old=self.read('downloads',oid,actor)
                if old['intent']!=intent:raise M5Error('DOWNLOAD_INTENT_CONFLICT',409)
                if old['state']!='ready':raise M5Error('DOWNLOAD_INTERRUPTED_NEW_ID_REQUIRED',409)
                return self.public(old)
            size=len(raw) if raw is not None else self.safe(source).stat().st_size
            self.prepare_snapshot(oid,actor,intent,size)
        return self.write_snapshot(oid,actor,source=source,raw=raw,expected=expected,allowed=allowed)

    def download_chunk(self,body,actor):
        import base64
        fields(body,('download_id','offset','sha256'))
        with self.lock:
            record=self.read('downloads',body['download_id'],actor)
            if record.get('index_format')!='sha256-binary-v1':return super().download_chunk(body,actor)
            if record['state']!='ready' or body['sha256']!=record['sha256']:raise M5Error('DOWNLOAD_CHANGED',409)
            offset=integer(body['offset'],record['bytes'])
            if offset%CHUNK:raise M5Error('INVALID_OFFSET')
            folder=self.folder('downloads',record['id']);path=self.safe(folder/'content');index=self.safe(folder/'hashes')
            if path.stat().st_size!=record['bytes'] or index.stat().st_size!=((record['bytes']+CHUNK-1)//CHUNK)*32:
                raise M5Error('DOWNLOAD_CORRUPT',503)
            with path.open('rb') as stream:stream.seek(offset);raw=stream.read(CHUNK)
            with index.open('rb') as stream:stream.seek(offset//CHUNK*32);expected=stream.read(32)
            digest=hashlib.sha256(raw)
            if offset==record['bytes']:expected=hashlib.sha256(b'').digest()
            if digest.digest()!=expected:raise M5Error('DOWNLOAD_CORRUPT',503)
            return {'download_id':record['id'],'offset':offset,'bytes':len(raw),'sha256':digest.hexdigest(),
                    'file_sha256':record['sha256'],'eof':offset+len(raw)==record['bytes'],'data':base64.b64encode(raw).decode()}

    def close_download(self,oid,actor):
        with self.lock:
            record=self.read('downloads',oid,actor)
            cancel=self.download_cancels.get(oid)
            if cancel is not None:
                cancel.set();record['state']='cancelling';self.save('downloads',record);return self.public(record)
            record['state']='closing';self.save('downloads',record)
            for name in ('content','content.pending','hashes','hashes.pending'):
                path=self.safe(self.folder('downloads',oid)/name)
                if path.is_file():path.unlink()
            record['state']='closed';self.save('downloads',record);return self.public(record)
