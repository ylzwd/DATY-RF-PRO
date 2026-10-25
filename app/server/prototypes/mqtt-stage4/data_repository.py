"""Reuse current domain validators and transactions; never opens production paths.

RPC receipts live in the same existing SQLite legacy_snapshots extension domain.
No second receipt database or schema bypass. Mutation + audit + receipt commit
atomically. All transport-specific records have a reserved namespace.
"""
from contextlib import contextmanager
import hashlib
import ipaddress
import json
from pathlib import Path
import sqlite3
import time
import uuid
from urllib.parse import urlencode

import unified_database as db
import unified_api
import unified_browser_import as browser_import
from unified_schema import validate_schema
from project_store import save_project, PROJECT_REVISION_PROTOCOL
from project_api import handle_get
from server_storage_api import latest_draft
from command_journal import ProcessLease
from data_contract import DataError, fields, identifier, encoded, MAX_BYTES

PREFIX = 'mqtt4-operation:'
REQUEST_PREFIX = 'mqtt4-request:'


class Capture:
    def __init__(self):
        self.result = None
    def _json(self, body, status=200):
        if self.result is not None:
            raise RuntimeError('Duplicate domain response')
        self.result = {'status':status,'body':body}


class Repository:
    def __init__(self, bridge, *, fixture_root=None, runtime_scope=None):
        path = Path(bridge._db_path).resolve()
        if runtime_scope is not None:
            from m6_scope import checked_scope
            checked_scope(runtime_scope).check_bridge(bridge)
        else:
            root = Path(fixture_root).resolve()
            production=Path(__file__).resolve().parents[2]
            if not (root / '.daty-mqtt-stage4-fixture').is_file() or not path.is_relative_to(root) or path.is_relative_to(production):
                raise ValueError('Isolated M4 database required')
        self.bridge, self.path = bridge, path
        self.lease = ProcessLease(str(path) + '.mqtt4-owner.lock')
        self.poisoned = False
        self.before_commit = lambda connection: None
        self.after_commit = lambda connection: None
        with self.connection() as c:
            validate_schema(c)

    @contextmanager
    def connection(self):
        c = sqlite3.connect(self.path, timeout=3, isolation_level=None)
        c.row_factory = sqlite3.Row
        try:
            c.execute('PRAGMA foreign_keys=ON')
            c.execute('PRAGMA synchronous=FULL')
            if c.execute('PRAGMA journal_mode').fetchone()[0].lower() != 'wal':
                raise DataError('WAL_REQUIRED',503)
            yield c
        finally:
            c.close()

    def commit(self,c):
        try:
            self.before_commit(c)
            c.commit()
            self.after_commit(c)
        except BaseException:
            self.poisoned = True
            raise

    def close(self):
        self.lease.close()

    @staticmethod
    def actor(peer_ip):
        ip = str(ipaddress.ip_address(peer_ip))
        return {'id':'network:'+ip,'kind':'network-peer','authenticated':False,'ip':ip}

    def get_receipt(self,c,oid,actor):
        resource = self.internal(c,PREFIX + identifier(oid))
        if not resource:
            return None
        value = resource['value']['payload']
        if value['actor'] != actor['id']:
            raise DataError('OPERATION_OWNER_MISMATCH',403)
        if value['epoch'] != db.status(c)['epoch']:
            raise DataError('DATABASE_EPOCH_CHANGED',409)
        return value

    @staticmethod
    def internal(c,key):
        row=c.execute("SELECT s.id FROM db_legacy_snapshots s JOIN db_resource_versions v ON v.kind='legacy_snapshots' AND v.id=s.id AND v.revision=1 WHERE s.source_origin='daty-mqtt-stage4' AND s.source_key=? ORDER BY v.audit_seq DESC LIMIT 1",(key,)).fetchone()
        return db.get_resource(c,'legacy_snapshots',row[0]) if row else None

    def put_internal(self,c,key,value,actor):
        previous = self.internal(c,key)
        revision = previous['value']['payload']['receipt_revision'] if previous else 0
        value={**value,'receipt_revision':revision+1}
        operation = 'm4internal_' + hashlib.sha256((key+'\0'+str(revision+1)).encode()).hexdigest()
        return db.put_resource(c,{'operation_id':operation,'epoch':db.status(c)['epoch'],
            'kind':'legacy_snapshots','id':key+':'+str(revision+1),'expected_revision':0,
            'value':{'sourceOrigin':'daty-mqtt-stage4','sourceKey':key,'payload':value}},actor,int(time.time()*1000))

    def bind_request(self,c,request,actor,digest):
        key = REQUEST_PREFIX + request['request_id']
        existing = self.internal(c,key)
        value = {'operation_id':request['body']['operation_id'],'digest':digest,'actor':actor['id']}
        if existing and {k:v for k,v in existing['value']['payload'].items() if k!='receipt_revision'} != value:
            raise DataError('REQUEST_ID_CONFLICT',409)
        if not existing:
            self.put_internal(c,key,value,actor)

    def save_receipt(self,c,record,actor):
        self.put_internal(c,PREFIX+record['operation_id'],record,actor)

    @staticmethod
    def public(record):
        return {k:v for k,v in record.items() if k not in ('digest','actor')}

    @staticmethod
    def unreserved(body):
        items=body.get('writes',[body])
        if not isinstance(items,list) or any(not isinstance(item,dict) for item in items):
            raise DataError('INVALID_WRITE_ITEMS')
        for item in items:
            value=item.get('value')
            reserved_source=isinstance(value,dict) and (value.get('sourceOrigin')=='daty-mqtt-stage4' or str(value.get('sourceKey','')).startswith((PREFIX,REQUEST_PREFIX)))
            if str(item.get('id','')).startswith((PREFIX,REQUEST_PREFIX)) or str(item.get('operation_id','')).startswith('m4internal_') or reserved_source:
                raise DataError('RESERVED_RPC_NAMESPACE',409)

    def read(self,c,method,b,actor):
        meta = {'success':True,**db.status(c)}
        if method == 'database.status':
            fields(b)
            return {**meta,'storage_source':actor,'control_protocol':'daty-direct-control-v1',
                    'live_persistence':self.bridge.get_unified_runtime_status()}
        if method == 'database.activity.list':
            from unified_activity import list_activity
            fields(b,('source',),('category','limit','cursor','from_ms','to_ms','target'))
            return list_activity(c,**b)
        if method == 'database.activity.get':
            from unified_activity import get_activity
            fields(b,('source','id'))
            return get_activity(c,**b)
        if method == 'database.catalog':
            from unified_catalog import list_catalog
            fields(b,('kind',),('limit','cursor','project_id'))
            return list_catalog(c,**b)
        if method == 'database.resources.list':
            fields(b,optional=('kind','limit','cursor','since','since_epoch','project_id'))
            return db.list_resources(c,b.get('kind'),b.get('limit',100),b.get('cursor'),since=b.get('since'),since_epoch=b.get('since_epoch'),project_id=b.get('project_id'))
        if method == 'database.resources.get':
            fields(b,('kind','id'))
            resource = db.get_resource(c,b['kind'],b['id'])
            if resource is None: raise DataError('RESOURCE_NOT_FOUND',404)
            return {**meta,'resource':resource}
        if method in ('database.operations.get','operations.get'):
            fields(b,('operation_id',))
            oid = identifier(b['operation_id'])
            if method == 'operations.get':
                record = self.get_receipt(c,oid,actor)
                if record: return {**meta,'operation':self.public(record)}
            operation = db.get_operation(c,oid,actor['id'])
            if not operation: raise DataError('OPERATION_NOT_FOUND',404)
            return {**meta,'operation':operation}
        if method in ('database.channels','database.overview'):
            fields(b,optional=('limit','cursor','receiver_id'))
            query = urlencode(b)
            return {**meta,**unified_api.live_reader(self.bridge._clock_state['server_id'])(c,
                '/api/database/'+method.split('.')[1],query)}
        if method == 'database.draft.get':
            fields(b,optional=('project_id',))
            pid = b.get('project_id','default'); self.project(c,pid)
            return {**meta,'draft':latest_draft(c,pid)}
        if method == 'database.business_snapshot':
            fields(b)
            return {**meta,'schema':'daty-server-business-json-v1','generatedAtMs':int(time.time()*1000),
                'source':'server-sqlite','resources':[db.get_resource(c,r[0],r[1]) for r in c.execute(
                    'SELECT kind,id FROM db_resources ORDER BY kind,id')],
                'scope':'All current business resources including tombstones; full archive contains all versions and telemetry.'}
        if method == 'database.import.preview':
            fields(b,('backup',))
            preview = browser_import.preview_import(c,b['backup'],preference_id='view:'+actor['id'])
            return {**meta,**{k:v for k,v in preview.items() if k != 'draftWrites'}}
        if method in ('projects.get','projects.list'):
            fields(b,('id',) if method.endswith('.get') else ())
            from urllib.parse import quote
            capture = Capture()
            @contextmanager
            def session(): yield c
            handle_get(capture,'/api/projects'+('/'+quote(db._text(b['id'],'Project ID'),safe='') if 'id' in b else ''),db_session=session)
            if capture.result['status'] != 200:
                raise DataError(capture.result['body'].get('code','PROJECT_READ_FAILED'),capture.result['status'])
            return capture.result['body']
        if method == 'timeline.list':
            fields(b,optional=('limit','project_id','device_id','event_type'))
            limit = db._int(b.get('limit',200),'Timeline limit',1,1000)
            clauses,values=[],[]
            for field in ('project_id','device_id','event_type'):
                if field in b:
                    clauses.append(field+'=?');values.append(db._text(b[field],field))
            rows=c.execute('SELECT * FROM timeline_events'+(' WHERE '+' AND '.join(clauses) if clauses else '')+
                ' ORDER BY ts DESC,id DESC LIMIT ?',[*values,limit]).fetchall()
            events=[]
            for row in rows:
                event=dict(row);event['details']=json.loads(event.pop('details_json') or '{}');events.append(event)
            return {'success':True,'events':events,'count':len(events)}
        raise DataError('METHOD_NOT_IMPLEMENTED',404)

    @staticmethod
    def project(c,pid):
        db._text(pid,'Project ID',256)
        if not c.execute('SELECT 1 FROM projects WHERE id=?',(pid,)).fetchone():
            raise DataError('PROJECT_NOT_FOUND',404)

    def write(self,c,method,b,actor):
        from data_retirement import check_request
        check_request(method,b)
        self.unreserved(b)
        now = int(time.time()*1000);meta={'success':True,**db.status(c)}
        if method == 'database.write': return db.put_resource(c,b,actor,now)
        if method == 'database.batch': return db.put_batch(c,b,actor,now)
        if method == 'database.import.commit':
            fields(b,('backup','confirmed','previewDigest','operation_id','epoch'))
            return {**meta,'receipt':browser_import.apply_import(c,b['backup'],preference_id='view:'+actor['id'],
                confirmed=b['confirmed'],expected_preview_digest=b['previewDigest'],operation_id=b['operation_id'],
                epoch=b['epoch'],actor=actor,now_ms=now)}
        if method == 'database.draft.save':
            fields(b,('projectId','fields','expected_draft_id','operation_id','epoch'))
            self.project(c,b['projectId']);values=b['fields']
            if not isinstance(values,dict) or not values or len(values)>40 or any(
                not isinstance(k,str) or not k.startswith('planner') or not isinstance(v,str) or len(v)>1048576 for k,v in values.items()):
                raise DataError('INVALID_DRAFT_FIELDS')
            previous=latest_draft(c,b['projectId'])
            if b['expected_draft_id'] != (previous['id'] if previous else None):
                raise DataError('DRAFT_CONFLICT',409)
            receipt=db.put_resource(c,{'kind':'legacy_snapshots','id':'draft-'+b['operation_id'],
                'operation_id':b['operation_id'],'epoch':b['epoch'],'expected_revision':0,
                'value':{'sourceOrigin':'server-planner-draft','sourceKey':'planner-draft:'+b['projectId'],
                'payload':{'projectId':b['projectId'],'fields':values,'sourceKind':'ui-draft','deploymentEligible':False}}},actor,now)
            return {**meta,'draft':receipt['resource']}
        if method == 'projects.save':
            fields(b,('operation_id','epoch','expected_revision'),('id','name','data','devices'))
            pid=db._text(b.get('id') or 'project-'+b['operation_id'],'Project ID')
            return {'success':True,'revision_protocol':PROJECT_REVISION_PROTOCOL,
                    **save_project(c,b,actor,now/1000,pid)}
        if method == 'planning.run.create':
            fields(b,('operation_id','epoch'),('project_id','input','result','baseline'))
            pid=b.get('project_id','default');self.project(c,pid)
            run_id='run-'+b['operation_id']
            c.execute('INSERT INTO coordination_runs(id,project_id,input_json,result_json,baseline_json,created_at) VALUES(?,?,?,?,?,?)',
                (run_id,pid,db._safe_json(b.get('input') or {}),db._safe_json(b.get('result') or {}),
                 db._safe_json(b['baseline']) if b.get('baseline') is not None else None,now/1000))
            c.execute('INSERT INTO timeline_events(project_id,ts,event_type,summary,details_json) VALUES(?,?,?,?,?)',
                (pid,now/1000,'coordination.completed','频率协调计算完成',encoded({'run_id':run_id,'actor':actor})))
            return {'success':True,'run_id':run_id}
        if method == 'timeline.append':
            fields(b,('operation_id','epoch','event_type','summary'),('details','device_id','command_id','project_id'))
            event_type=db._text(b['event_type'],'Event type'); summary=db._text(b['summary'],'Summary',8192)
            if event_type.startswith(('command.','access.','project.','coordination.')):
                raise DataError('SERVER_EVENT_TYPE_RESERVED')
            pid=b.get('project_id','default');self.project(c,pid)
            details={'client_details':b.get('details'),'actor':{k:v for k,v in actor.items() if k!='id'}}
            event=c.execute('INSERT INTO timeline_events(project_id,ts,event_type,device_id,command_id,summary,details_json) VALUES(?,?,?,?,?,?,?)',
                (pid,now/1000,event_type,b.get('device_id'),b.get('command_id'),summary,db._safe_json(details))).lastrowid
            return {'success':True,'event_id':event}
        raise DataError('METHOD_NOT_IMPLEMENTED',404)

    @staticmethod
    def bound(value):
        if len(encoded(value).encode()) > MAX_BYTES:
            raise DataError('MESSAGE_TOO_LARGE_USE_M5',413)
        return value
