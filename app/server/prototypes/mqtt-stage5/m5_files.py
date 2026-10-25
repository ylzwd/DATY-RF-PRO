"""Durable bounded transfer staging. Not a business database or security store.

One owner process; one serialized chunk in flight per transfer. Chunk ACK means
fsync + manifest publication. Resume queries the manifest, never a PUBACK.
Incomplete uploads are never eligible for domain calls or archives.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import threading
import time
import uuid

from command_journal import ProcessLease
from server_archive import atomic_json, digest
from m5_contract import CHUNK, MAX_UPLOAD, MAX_DOWNLOAD, M5Error, fields, identifier, sha256, integer, encoded

def hash_bytes(value): return hashlib.sha256(value).hexdigest()

class FileStore:
    def __init__(self, directory, *, fixture_root=None, runtime_scope=None):
        self.root=Path(directory).absolute()
        if runtime_scope is not None:
            from m6_scope import checked_scope
            checked_scope(runtime_scope).check_staging(self.root)
        else:
            root=Path(fixture_root).resolve()
            if not (root/'.daty-mqtt-stage5-fixture').is_file() or not self.root.resolve().is_relative_to(root):
                raise ValueError('Isolated M5 staging required')
        self.safe(self.root);self.root.mkdir(parents=True,exist_ok=True)
        self.lease=ProcessLease(str(self.root)+'.owner.lock')
        self.lock=threading.RLock();self.after_chunk=lambda:None;self.before_ready=lambda:None

    def close(self): self.lease.close()

    def safe(self,path):
        for item in (path,*path.parents):
            if item.is_symlink() or (hasattr(item,'is_junction') and item.is_junction()): raise M5Error('LINK_FORBIDDEN',503)
        if path.exists() and path.is_file() and path.stat().st_nlink!=1: raise M5Error('HARDLINK_FORBIDDEN',503)
        return path

    def folder(self,kind,oid):
        if kind not in ('uploads','downloads','operations','requests'): raise M5Error('INVALID_KIND')
        return self.safe(self.root/kind/identifier(oid))

    def read(self,kind,oid,actor):
        path=self.safe(self.folder(kind,oid)/'manifest.json')
        if not path.is_file(): raise M5Error('TRANSFER_NOT_FOUND',404)
        record=json.loads(path.read_text('utf-8'))
        if record['actor']!=actor: raise M5Error('TRANSFER_OWNER_MISMATCH',403)
        return record

    def save(self,kind,record):
        folder=self.folder(kind,record['id']);folder.mkdir(parents=True,exist_ok=True)
        self.safe(folder/'manifest.json');self.safe(folder/'manifest.pending')
        atomic_json(folder/'manifest.json',record)

    def capacity(self, extra=0):
        records=list(self.root.glob('*/*/manifest.json'))
        if len(records)>=8192: raise M5Error('STAGING_RECORD_LIMIT',429)
        reserved=0
        for p in records:
            if p.parent.parent.name not in ('uploads','downloads'):continue
            record=json.loads(self.safe(p).read_text('utf-8'))
            if record.get('state') in ('closed','cancelled'):continue
            reserved+=record.get('bytes',0)*(2 if p.parent.parent.name=='uploads' else 1)
        if reserved+extra>2*MAX_DOWNLOAD or shutil.disk_usage(self.root).free<extra+64*1024*1024:
            raise M5Error('STAGING_CAPACITY',507)

    def begin(self,body,actor):
        fields(body,('operation_id','bytes','sha256','media_type'))
        oid=identifier(body['operation_id']);size=integer(body['bytes'],MAX_UPLOAD);sha256(body['sha256'])
        if body['media_type'] not in ('application/json','text/plain','text/csv'): raise M5Error('INVALID_MEDIA_TYPE')
        with self.lock:
            if self.folder('uploads',oid).exists():
                old=self.read('uploads',oid,actor)
                if old['intent']!=body: raise M5Error('TRANSFER_INTENT_CONFLICT',409)
                return self.public(old)
            self.capacity(size*2)
            old={'id':oid,'actor':actor,'intent':body,'bytes':size,'sha256':body['sha256'],
                 'media_type':body['media_type'],'state':'uploading','offset':0,'chunks':[], 'created_at_ms':int(time.time()*1000)}
            self.save('uploads',old);return self.public(old)

    @staticmethod
    def public(record):
        return {k:v for k,v in record.items() if k not in ('actor','intent','chunks','path')}

    def status(self,kind,oid,actor):
        with self.lock:return self.public(self.read(kind,oid,actor))

    def chunk(self,body,actor,allowed):
        fields(body,('upload_id','offset','sha256','data'))
        sha256(body['sha256']);offset=integer(body['offset'],MAX_UPLOAD)
        if not isinstance(body['data'],str) or len(body['data'])>4*((CHUNK+2)//3): raise M5Error('CHUNK_TOO_LARGE',413)
        try: raw=base64.b64decode(body['data'],validate=True)
        except ValueError: raise M5Error('INVALID_BASE64')
        if not raw or len(raw)>CHUNK or hash_bytes(raw)!=body['sha256']: raise M5Error('CHUNK_DIGEST_MISMATCH',409)
        with self.lock:
            record=self.read('uploads',body['upload_id'],actor)
            if record['state']!='uploading': raise M5Error('UPLOAD_NOT_WRITABLE',409)
            if offset%CHUNK or offset>record['offset'] or len(raw)!=min(CHUNK,record['bytes']-offset): raise M5Error('CHUNK_OFFSET_OR_LENGTH',409)
            if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
            folder=self.folder('uploads',record['id']);target=self.safe(folder/(str(offset)+'.chunk'))
            if offset<record['offset']:
                expected=record['chunks'][offset//CHUNK]
                if expected!=body['sha256'] or not target.exists() or digest(target)!=expected:raise M5Error('CHUNK_CONFLICT',409)
                return self.public(record)
            if target.exists():
                if digest(target)!=body['sha256'] or target.stat().st_size!=len(raw): raise M5Error('CHUNK_CONFLICT',409)
            else:
                pending=self.safe(folder/(str(offset)+'.pending'))
                with pending.open('wb') as stream: stream.write(raw);stream.flush();os.fsync(stream.fileno())
                os.replace(pending,target)
            self.after_chunk()  # crash here leaves exact unacknowledged chunk, checked on resume
            if not allowed(): raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
            record['chunks'].append(body['sha256']);record['offset']+=len(raw)
            self.save('uploads',record);return self.public(record)

    def finish(self,body,actor,allowed):
        fields(body,('upload_id','sha256'))
        with self.lock:
            record=self.read('uploads',body['upload_id'],actor)
            if body['sha256']!=record['sha256']:raise M5Error('FILE_DIGEST_MISMATCH',409)
            if record['state']=='ready':self.payload(record,actor);return self.public(record)
            if record['state']!='uploading' or record['offset']!=record['bytes']: raise M5Error('UPLOAD_INCOMPLETE',409)
            folder=self.folder('uploads',record['id']);pending=self.safe(folder/'content.pending')
            with pending.open('wb') as stream:
                for i,sha in enumerate(record['chunks']):
                    if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
                    part=self.safe(folder/(str(i*CHUNK)+'.chunk'))
                    raw=part.read_bytes()
                    if hash_bytes(raw)!=sha: raise M5Error('STORED_CHUNK_CORRUPT',503)
                    stream.write(raw)
                stream.flush();os.fsync(stream.fileno())
            if pending.stat().st_size!=record['bytes'] or digest(pending)!=record['sha256']: raise M5Error('FILE_DIGEST_MISMATCH',409)
            self.before_ready()
            if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
            os.replace(pending,self.safe(folder/'content'))
            record['state']='ready';self.save('uploads',record);return self.public(record)

    def payload(self,record,actor):
        if record['actor']!=actor or record['state']!='ready': raise M5Error('UPLOAD_NOT_READY',409)
        path=self.safe(self.folder('uploads',record['id'])/'content')
        if not path.is_file() or path.stat().st_size!=record['bytes'] or digest(path)!=record['sha256']: raise M5Error('UPLOAD_CORRUPT',503)
        return path

    def bytes_for(self,ref,actor):
        fields(ref,('upload_id','sha256'))
        record=self.read('uploads',ref['upload_id'],actor)
        if ref['sha256']!=record['sha256']:raise M5Error('FILE_DIGEST_MISMATCH',409)
        return self.payload(record,actor).read_bytes()

    def cancel(self,oid,actor):
        with self.lock:
            record=self.read('uploads',oid,actor)
            if record['state']=='ready':raise M5Error('COMPLETED_UPLOAD_IMMUTABLE',409)
            record['state']='cancelling';self.save('uploads',record)
            folder=self.folder('uploads',oid)
            # Validate all generated direct payload names before removing any.
            names={'content.pending','content'}|{str(n)+suffix for n in range(0,record['bytes'],CHUNK) for suffix in ('.chunk','.pending')}
            targets=[]
            for path in folder.iterdir():
                self.safe(path)
                if path.name in ('manifest.json','manifest.pending'):continue
                if path.name not in names or not path.is_file():raise M5Error('UNEXPECTED_STAGING_FILE',409)
                targets.append(path)
            for path in targets:path.unlink()
            record['state']='cancelled';self.save('uploads',record)
            return self.public(record)

    def snapshot(self,oid,actor,intent,*,source=None,raw=None,expected=None,allowed=lambda:True):
        with self.lock:
            folder=self.folder('downloads',oid)
            if folder.exists():
                old=self.read('downloads',oid,actor)
                if old['intent']!=intent:raise M5Error('DOWNLOAD_INTENT_CONFLICT',409)
                if old['state']!='ready':raise M5Error('DOWNLOAD_INTERRUPTED_NEW_ID_REQUIRED',409)
                return self.public(old)
            size=len(raw) if raw is not None else self.safe(source).stat().st_size
            integer(size,MAX_DOWNLOAD);self.capacity(size)
            record={'id':oid,'actor':actor,'intent':intent,'state':'writing','bytes':size,'created_at_ms':int(time.time()*1000)}
            self.save('downloads',record);pending=self.safe(folder/'content.pending')
            chunks=[]
            with pending.open('xb') as output:
                if raw is not None:
                    for offset in range(0,len(raw),CHUNK):
                        block=raw[offset:offset+CHUNK];output.write(block);chunks.append(hash_bytes(block))
                else:
                    with source.open('rb') as input:
                        while True:
                            block=input.read(CHUNK)
                            if not block:break
                            if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
                            output.write(block);chunks.append(hash_bytes(block))
                output.flush();os.fsync(output.fileno())
            sha=digest(pending)
            if pending.stat().st_size!=size or (expected and sha!=expected):raise M5Error('SOURCE_DIGEST_MISMATCH',503)
            if not allowed():raise M5Error('REQUEST_NO_LONGER_CURRENT',409)
            os.replace(pending,self.safe(folder/'content'))
            record.update(state='ready',sha256=sha,chunks=chunks);self.save('downloads',record);return self.public(record)

    def download_chunk(self,body,actor):
        fields(body,('download_id','offset','sha256'))
        with self.lock:
            record=self.read('downloads',body['download_id'],actor)
            if record['state']!='ready' or body['sha256']!=record['sha256']:raise M5Error('DOWNLOAD_CHANGED',409)
            offset=integer(body['offset'],record['bytes'])
            if offset%CHUNK:raise M5Error('INVALID_OFFSET')
            path=self.safe(self.folder('downloads',record['id'])/'content')
            if path.stat().st_size!=record['bytes']:raise M5Error('DOWNLOAD_CORRUPT',503)
            with path.open('rb') as stream:stream.seek(offset);raw=stream.read(CHUNK)
            expected=record['chunks'][offset//CHUNK] if offset<record['bytes'] else hash_bytes(b'')
            if hash_bytes(raw)!=expected:raise M5Error('DOWNLOAD_CORRUPT',503)
            return {'download_id':record['id'],'offset':offset,'bytes':len(raw),'sha256':hash_bytes(raw),
                    'file_sha256':record['sha256'],'eof':offset+len(raw)==record['bytes'],'data':base64.b64encode(raw).decode()}

    def close_download(self,oid,actor):
        with self.lock:
            record=self.read('downloads',oid,actor);record['state']='closing';self.save('downloads',record)
            # A closed receipt remains; only generated direct payloads are removed.
            folder=self.folder('downloads',oid)
            for name in ('content','content.pending'):
                path=self.safe(folder/name)
                if path.is_file():path.unlink()
            record['state']='closed';self.save('downloads',record)
            return self.public(record)
