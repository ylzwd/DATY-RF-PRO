"""Server-owned immutable exports and consistent full business archives.

All paths are generated here. No security files, device commands, live database
replacement, or automatic pruning. SQLite backup includes WAL consistently.
"""
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import base64
import csv
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from urllib.parse import quote
import zipfile

import unified_database as db

PROTOCOL = 'daty-server-archive-v1'
ID = re.compile(r'[A-Za-z0-9_-]{16,80}')
CLEANUP_PROTOCOL = 'daty-archive-cleanup-v1'
PAYLOAD_FILES = {
    'exports': frozenset(('content', 'content.partial')),
    'archives': frozenset(('archive.zip', 'archive.zip.partial', 'database.sqlite3',
                           'database.sqlite3-wal', 'database.sqlite3-shm', 'database.sqlite3-journal')),
}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): value.update(block)
    return value.hexdigest()


def atomic_json(path, value):
    temporary = path.with_suffix('.pending')
    with temporary.open('w', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)
        stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)


def checked_id(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise db.DatabaseError('存档操作标识无效')
    return value


class ArchiveService:
    def __init__(self, source, directory):
        self.source, self.directory = Path(source).resolve(), Path(directory).absolute()
        for item in (self.directory, *self.directory.parents):
            if item.is_symlink() or (hasattr(item, 'is_junction') and item.is_junction()):
                raise ValueError('Archive directory cannot be a link')
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock(); self.active = set(); self.downloads = {}; self.cleaning = set()

    def _save(self, folder, record):
        with self.lock: atomic_json(folder/'manifest.json', record)

    def _folder(self, category, identifier):
        if category not in (*PAYLOAD_FILES, 'cleanups'):
            raise db.DatabaseError('存档类型无效')
        checked_id(identifier)
        path = self.directory / category / identifier
        for item in (path, *path.parents):
            if item.is_symlink() or (hasattr(item, 'is_junction') and item.is_junction()):
                raise db.DatabaseError('存档路径无效', status=503)
        if not path.resolve().is_relative_to(self.directory.resolve()):
            raise db.DatabaseError('存档路径超出范围', status=503)
        return path

    def _record(self, category, identifier):
        path = self._folder(category, identifier) / 'manifest.json'
        if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
            raise db.DatabaseError('存档清单路径无效', status=503)
        if not path.is_file(): raise db.DatabaseError('存档不存在', status=404)
        return json.loads(path.read_text(encoding='utf-8'))

    def list(self, category, *, strict=False):
        self._folder(category,'0'*16)  # Validate the root/category even when the directory is empty.
        parent = self.directory / category
        values = []
        if parent.exists():
            for path in parent.iterdir():
                if ID.fullmatch(path.name) and path.is_dir():
                    try:
                        record = self.get(category, path.name)
                        if record['status'] != 'deleted': values.append(record)
                    except (ValueError, OSError):
                        if strict:raise
                        continue
        return sorted(values, key=lambda item: (item['createdAtMs'], item['id']), reverse=True)

    def get(self, category, identifier):
        with self.lock:
            value = self._record(category, identifier)
            if value['status'] in ('queued', 'running', 'writing') and identifier not in self.active:
                value = {**value, 'status':'interrupted', 'error':'服务器进程曾中断，此文件未标记完成；请新建存档'}
            if value['status'] == 'deleting':
                value = {**value, 'status':'interrupted', 'error':'文件清理曾中断，请重新确认清理剩余文件'}
            return value

    def export(self, body, actor):
        if set(body) - {'operation_id', 'text', 'fileName', 'mimeType', 'source'}:
            raise db.DatabaseError('导出请求含未知字段')
        identifier = checked_id(body.get('operation_id'))
        text, name, mime = body.get('text'), body.get('fileName'), body.get('mimeType')
        if not isinstance(text, str) or not isinstance(name, str) or not name or len(name)>180 or re.search(r'[\\/:*?"<>|\x00-\x1f]', name):
            raise db.DatabaseError('导出内容或文件名称无效')
        if not isinstance(mime, str) or len(mime)>120 or re.search(r'[\r\n]',mime):
            raise db.DatabaseError('导出文件格式无效')
        content = text.encode('utf-8'); sha = hashlib.sha256(content).hexdigest()
        if len(content)>db.MAX_DOCUMENT_BYTES: raise db.DatabaseError('导出内容超过64 MiB',status=413)
        source = body.get('source', 'application-export')
        db._text(source, '导出来源', 256)
        if source=='browser-origin-before-server-storage':
            from fresh_start_policy import reject_legacy_cache
            with closing(sqlite3.connect(self.source.as_uri()+'?mode=ro',uri=True,timeout=3)) as connection:
                reject_legacy_cache(connection)
        with self.lock:
            folder=self._folder('exports',identifier)
            if folder.exists():
                record=self._record('exports',identifier)
                if record.get('sha256')!=sha or record.get('fileName')!=name or record.get('mimeType')!=mime:
                    raise db.DatabaseError('此操作标识已用于另一份导出',status=409)
                if record['status']!='deleted':
                    if record['status']!='saved' or digest(folder/'content')!=sha:
                        raise db.DatabaseError('原导出尚未确认完整，请核对存档',status=409)
                    return record
            folder.mkdir(parents=True, exist_ok=True)
            record={'protocol':PROTOCOL,'id':identifier,'status':'writing','fileName':name,'mimeType':mime,
                    'sha256':sha,'bytes':len(content),'source':source,'actor':actor,'createdAtMs':int(time.time()*1000),
                    'generation':uuid.uuid4().hex}
            self._save(folder,record)
            with (folder/'content.partial').open('xb') as file:
                file.write(content);file.flush();os.fsync(file.fileno())
            os.replace(folder/'content.partial',folder/'content')
            record['status']='saved';self._save(folder,record)
            return record

    def create(self, body, actor):
        if set(body)!={'operation_id'}: raise db.DatabaseError('完整存档仅接受operation_id')
        identifier=checked_id(body['operation_id'])
        with self.lock:
            folder=self._folder('archives',identifier)
            if folder.exists():return self.get('archives',identifier)
            if self.active:raise db.DatabaseError('已有完整存档正在生成，请等待完成',status=409)
            folder.mkdir(parents=True)
            record={'protocol':PROTOCOL,'id':identifier,'status':'queued','createdAtMs':int(time.time()*1000),
                    'fileName':'DATY_Server_Archive_'+datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')+'.zip',
                    'actor':actor,'source':'server-business-database','stage':'准备一致性快照'}
            self._save(folder,record);self.active.add(identifier)
            threading.Thread(target=self._build,args=(folder,record),name='daty-archive',daemon=True).start()
            return record

    def _build(self, folder, record):
        try:
            record.update(status='running',stage='正在保存数据库一致性快照');self._save(folder,record)
            deadline=time.monotonic()+300
            def progress(*args):
                if time.monotonic()>deadline:raise TimeoutError('数据库快照超过5分钟，未发布存档')
            database=folder/'database.sqlite3'
            with closing(sqlite3.connect(self.source.as_uri()+'?mode=ro',uri=True,timeout=10)) as reader:
                with closing(sqlite3.connect(database)) as writer:
                    reader.backup(writer,pages=1024,progress=progress,sleep=0.01)
                    if writer.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:raise ValueError('数据库完整性检查失败')
                    if writer.execute('PRAGMA foreign_key_check').fetchall():raise ValueError('数据库外键检查失败')
            record.update(stage='正在导出所有数据表和已存档文件');self._save(folder,record)
            snapshot_completed=int(time.time()*1000)
            export_inventory=self.list('exports');export_inventory_at=int(time.time()*1000)
            # Export a CLOSED snapshot. It cannot drift between tables.
            metadata={'protocol':PROTOCOL,'createdAtMs':record['createdAtMs'],'snapshotSha256':digest(database),
                      'snapshotCompletedAtMs':snapshot_completed,'exportInventoryAtMs':export_inventory_at,
                      'consistency':'Database tables share one SQLite snapshot; immutable export files are enumerated separately after that snapshot.',
                      'units':{'frequency':'integer kHz','time':'per-column seconds or milliseconds','RF':'dBm','AF':'dBFS'},
                      'csvEncoding':'UTF-8 BOM; BLOB fields use base64: prefix; SQLite retains exact types/nulls',
                      'tables':[],'exports':[],'integrity':'ok','foreignKeys':'ok'}
            with closing(sqlite3.connect(database.as_uri()+'?mode=ro',uri=True)) as connection:
                with zipfile.ZipFile(folder/'archive.zip.partial','x',compression=zipfile.ZIP_DEFLATED,compresslevel=1,allowZip64=True) as output:
                    output.write(database,'database.sqlite3')
                    tables=[row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
                    for table in tables:
                        quoted='"'+table.replace('"','""')+'"';cursor=connection.execute('SELECT * FROM '+quoted)
                        columns=[column[0] for column in cursor.description];count=0
                        with output.open('tables/'+table+'.csv','w',force_zip64=True) as binary:
                            with io.TextIOWrapper(binary,encoding='utf-8-sig',newline='') as stream:
                                rows=csv.writer(stream);rows.writerow(columns)
                                for row in cursor:
                                    rows.writerow(['base64:'+base64.b64encode(value).decode('ascii') if isinstance(value,bytes) else value for value in row]);count+=1
                        metadata['tables'].append({'name':table,'columns':columns,'rows':count})
                    for item in export_inventory:
                        if item['status']!='saved':continue
                        exported=self._folder('exports',item['id'])/'content'
                        if digest(exported)!=item['sha256']:raise ValueError('已有导出文件校验失败')
                        output.write(exported,'exports/'+item['id']+'/'+item['fileName']);metadata['exports'].append(item)
                    output.writestr('manifest.json',json.dumps(metadata,ensure_ascii=False,indent=2))
            with (folder/'archive.zip.partial').open('r+b') as stream:os.fsync(stream.fileno())
            os.replace(folder/'archive.zip.partial',folder/'archive.zip')
            record.update(status='saved',stage='存档已保存在服务器',completedAtMs=int(time.time()*1000),
                          sha256=digest(folder/'archive.zip'),bytes=(folder/'archive.zip').stat().st_size,
                          tables=len(metadata['tables']),rows=sum(item['rows'] for item in metadata['tables']),exports=len(metadata['exports']),integrity='ok')
            self._save(folder,record)
        except Exception as error:
            record.update(status='failed',error=str(error),stage='存档未完成，已有数据保留');self._save(folder,record)
        finally:
            with self.lock:self.active.discard(record['id'])

    def download(self, handler, category, identifier):
        key=(category,identifier)
        with self.lock:
            self.downloads[key]=self.downloads.get(key,0)+1
        try:
            self._download(handler,category,identifier)
        finally:
            with self.lock:
                self.downloads[key]-=1
                if not self.downloads[key]: del self.downloads[key]

    def _download(self, handler, category, identifier):
        record=self.get(category,identifier)
        if record['status']!='saved':raise db.DatabaseError('文件尚未完成，不能下载',status=409)
        path=self._folder(category,identifier)/('archive.zip' if category=='archives' else 'content')
        if not path.is_file() or digest(path)!=record['sha256']:raise db.DatabaseError('服务器文件校验失败',status=503)
        handler.send_response(200)
        handler.send_header('Content-Type','application/zip' if category=='archives' else record['mimeType'])
        handler.send_header('Content-Length',str(path.stat().st_size))
        handler.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(record['fileName']))
        handler.send_header('X-Content-Type-Options','nosniff');handler.send_header('Cache-Control','no-store')
        handler._cors_headers();handler.end_headers()
        try:
            with path.open('rb') as stream:shutil.copyfileobj(stream,handler.wfile,1024*1024)
        except OSError:
            # A disconnected download is not another JSON response or another write.
            handler.close_connection=True

    def _payloads(self, category, identifier):
        """Only generated direct children may be unlinked; never traverse a tree."""
        folder=self._folder(category,identifier);files=[]
        for child in folder.iterdir():
            if child.name not in PAYLOAD_FILES[category] | {'manifest.json', 'manifest.pending'}:
                raise db.DatabaseError('存档目录含未知文件，未清理：'+identifier,status=409)
            if child.is_symlink() or (hasattr(child,'is_junction') and child.is_junction()) or not child.is_file():
                raise db.DatabaseError('存档目录含链接或非普通文件，未清理',status=409)
            if child.name in PAYLOAD_FILES[category]:
                if child.resolve()==self.source or child.stat().st_nlink>1:
                    raise db.DatabaseError('存档文件与其他数据共享路径，未清理',status=409)
                files.append(child)
        return files

    def prepare_cleanup(self, body, actor):
        if not isinstance(body,dict) or set(body)!={'operation_id','selection'}:
            raise db.DatabaseError('清理准备字段无效')
        identifier=checked_id(body['operation_id']);selection=body['selection']
        if not isinstance(selection,dict) or set(selection) not in ({'category'},{'category','id'}) or selection['category'] not in ('all',*PAYLOAD_FILES):
            raise db.DatabaseError('清理范围无效')
        if 'id' in selection:
            checked_id(selection['id'])
            if selection['category']=='all':raise db.DatabaseError('单文件清理必须指定类型')
        with self.lock:
            folder=self._folder('cleanups',identifier)
            if folder.exists():
                previous=self._record('cleanups',identifier)
                if previous['selection']!=selection or previous['actor']!=actor:
                    raise db.DatabaseError('清理操作标识已被使用',status=409)
                return self.get_cleanup(identifier)
            if self.active:raise db.DatabaseError('完整存档正在生成，请完成后再清理',status=409)
            items=[]
            for category in PAYLOAD_FILES if selection['category']=='all' else (selection['category'],):
                records=[self.get(category,selection['id'])] if 'id' in selection else self.list(category,strict=True)
                for item in records:
                    if item['status']=='deleted':continue
                    if (category,item['id']) in self.downloads:
                        raise db.DatabaseError('选中的文件正在下载，请下载结束后再清理',status=409)
                    files=self._payloads(category,item['id'])
                    items.append({'category':category,'id':item['id'],'fileName':item.get('fileName',item['id']),
                                  'bytes':sum(p.stat().st_size for p in files),
                                  'fingerprint':fingerprint(self._record(category,item['id']))})
            if len(items)>10000:raise db.DatabaseError('文件超过10000份，请按类型分次清理',status=413)
            plan={'protocol':CLEANUP_PROTOCOL,'id':identifier,'status':'prepared','createdAtMs':int(time.time()*1000),
                  'selection':selection,'items':items,'count':len(items),'bytes':sum(i['bytes'] for i in items),'actor':actor}
            plan['planSha256']=fingerprint(plan)
            folder.mkdir(parents=True);self._save(folder,plan)
            return plan

    def get_cleanup(self, identifier):
        with self.lock:
            value=self._record('cleanups',identifier)
            if value['status']=='running' and identifier not in self.cleaning:
                # Reconcile only durable per-file tombstones, never resume deletion on a read.
                confirmed=[]
                for item in value['items']:
                    record=self._record(item['category'],item['id'])
                    if record.get('status')=='deleted' and record.get('cleanupId')==identifier:confirmed.append(item)
                value={**value,'status':'interrupted','deletedCount':len(confirmed),
                       'error':'清理曾中断，请刷新列表后重新确认剩余文件'}
            return value

    def commit_cleanup(self, identifier, body, actor):
        if not isinstance(body,dict) or set(body)!={'confirmed','planSha256'} or body['confirmed'] is not True:
            raise db.DatabaseError('必须明确确认文件清理')
        with self.lock:
            plan=self.get_cleanup(identifier);folder=self._folder('cleanups',identifier)
            if body['planSha256']!=plan['planSha256'] or plan['actor']!=actor:
                raise db.DatabaseError('清理确认与原范围不匹配',status=409)
            # A receipt replay never repeats filesystem deletion, including partial/unknown outcomes.
            if plan['status']!='prepared':return plan
            if int(time.time()*1000)-plan['createdAtMs']>600000:
                raise db.DatabaseError('清理确认已超过10分钟，请刷新后重新确认',status=409)
            if self.active:raise db.DatabaseError('完整存档正在生成，请完成后重新确认',status=409)
            for item in plan['items']:
                key=(item['category'],item['id'])
                if key in self.downloads:raise db.DatabaseError('选中文件正在下载，未执行清理',status=409)
                if fingerprint(self._record(*key))!=item['fingerprint']:
                    raise db.DatabaseError('文件已变化，请刷新列表并重新确认清理',status=409)
                self._payloads(*key)
            plan.update(status='running',deletedCount=0,freedBytes=0,results=[])
            self._save(folder,plan);self.cleaning.add(identifier)
            try:
                for item in plan['items']:
                    category,key=item['category'],item['id'];target=self._folder(category,key)
                    record=self._record(category,key);freed=0
                    try:
                        record.update(status='deleting',cleanupId=identifier);self._save(target,record)
                        for file in self._payloads(category,key):
                            size=file.stat().st_size;file.unlink();freed+=size
                        record.update(status='deleted',deletedAtMs=int(time.time()*1000),deletedBy=actor)
                        self._save(target,record);plan['deletedCount']+=1
                        result={'category':category,'id':key,'status':'deleted','freedBytes':freed}
                    except (OSError,ValueError,db.DatabaseError):
                        result={'category':category,'id':key,'status':'failed','freedBytes':freed,
                                'error':'文件清理未完成，请核对磁盘权限后重新确认剩余文件'}
                    plan['freedBytes']+=freed;plan['results'].append(result);self._save(folder,plan)
                plan.update(status='completed' if plan['deletedCount']==plan['count'] else 'partial',completedAtMs=int(time.time()*1000))
                self._save(folder,plan);return plan
            finally:self.cleaning.discard(identifier)

    def handle(self, handler, method, path, read_json, actor):
        prefix='/api/database/'
        if not path.startswith(prefix):return False
        route=path[len(prefix):].split('/')
        if route[0] not in ('archives','exports','storage-status','archive-cleanups'):return False
        if route[0]=='storage-status' and (route!=['storage-status'] or method!='GET'):
            handler._json({'success':False,'error':'存储状态仅支持读取'},status=405);return True
        payload=None;code=200
        try:
            if route[0]=='archive-cleanups':
                if route==['archive-cleanups'] and method=='POST':result=self.prepare_cleanup(read_json(handler),actor)
                elif len(route)==2 and method=='GET':result=self.get_cleanup(checked_id(route[1]))
                elif len(route)==3 and route[2]=='commit' and method=='POST':result=self.commit_cleanup(checked_id(route[1]),read_json(handler),actor)
                else:raise db.DatabaseError('清理接口不存在',status=404)
                payload={'success':True,'protocol':CLEANUP_PROTOCOL,'record':result}
            elif route==['storage-status'] and method=='GET':
                usage=shutil.disk_usage(self.directory)
                payload={'success':True,'protocol':PROTOCOL,'databaseBytes':self.source.stat().st_size,
                         'archiveDirectory':str(self.directory),'diskFreeBytes':usage.free,
                         'archives':len(self.list('archives')),'exports':len(self.list('exports')),
                         'cleanupProtocol':CLEANUP_PROTOCOL,'archiveBusy':bool(self.active)}
            elif len(route)==3 and route[2]=='download' and method=='GET':
                self.download(handler,route[0],checked_id(route[1]));return True
            elif len(route)==1 and method=='GET':payload={'success':True,'protocol':PROTOCOL,'items':self.list(route[0])}
            elif len(route)==2 and method=='GET':payload={'success':True,'protocol':PROTOCOL,'record':self.get(route[0],checked_id(route[1]))}
            elif len(route)==1 and method=='POST':
                result=(self.create if route[0]=='archives' else self.export)(read_json(handler),actor)
                payload={'success':True,'protocol':PROTOCOL,'record':result};code=202 if result['status'] in ('queued','running') else 200
            else:raise db.DatabaseError('存档接口不存在',status=404)
        except db.DatabaseError as error:payload={'success':False,'protocol':PROTOCOL,'error':str(error),'code':error.code};code=error.status
        except (OSError,ValueError,sqlite3.Error):payload={'success':False,'protocol':PROTOCOL,'error':'服务器存储失败，未确认保存'};code=503
        handler._json(payload,status=code);return True
