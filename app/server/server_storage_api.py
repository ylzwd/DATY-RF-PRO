"""Direct-control server storage routes; called after the unchanged Origin gate."""
import hashlib
import json
import time
import re
from urllib.parse import parse_qs, urlsplit

import unified_database as db
import unified_browser_import as browser_import
from unified_import import ImportError


def latest_draft(connection, project_id):
    row=connection.execute('''SELECT s.id FROM db_legacy_snapshots s
        JOIN db_resource_versions v ON v.kind='legacy_snapshots' AND v.id=s.id AND v.revision=1
        WHERE s.source_key=? ORDER BY v.audit_seq DESC LIMIT 1''',('planner-draft:'+project_id,)).fetchone()
    return db.get_resource(connection,'legacy_snapshots',row[0]) if row else None


def handle(handler, method, target, *, db_session, read_json, actor, archive):
    parsed=urlsplit(target);path=parsed.path
    if path not in ('/api/database/browser-import/preview','/api/database/browser-import/commit','/api/database/draft','/api/database/business-snapshot'):
        return archive.handle(handler,method,path,read_json,actor)
    payload=None;code=200
    try:
        body=read_json(handler) if method=='POST' else None
        with db_session() as connection:
            connection.execute('BEGIN IMMEDIATE' if method=='POST' else 'BEGIN')
            meta=db.status(connection)
            if path=='/api/database/business-snapshot' and method=='GET':
                if parsed.query:raise db.DatabaseError('业务快照不接受查询参数')
                rows=connection.execute('SELECT kind,id FROM db_resources ORDER BY kind,id').fetchall()
                payload={'success':True,**meta,'schema':'daty-server-business-json-v1','generatedAtMs':int(time.time()*1000),
                         'source':'server-sqlite','resources':[db.get_resource(connection,kind,identifier) for kind,identifier in rows],
                         'scope':'All current business resources, including tombstones. Complete table/version/audit/telemetry history is in the full ZIP archive.'}
                if len(json.dumps(payload,ensure_ascii=False).encode('utf-8'))>db.MAX_DOCUMENT_BYTES:
                    raise db.DatabaseError('业务JSON超过64 MiB，请使用服务器完整ZIP存档',status=413)
            elif path.startswith('/api/database/browser-import/') and method=='POST':
                source=body.get('backup');preference_id='view:'+actor['id']
                if path.endswith('/preview'):
                    preview=browser_import.preview_import(connection,source,preference_id=preference_id)
                    payload={'success':True,**meta,**{k:v for k,v in preview.items() if k not in ('draftWrites',)}}
                else:
                    result=browser_import.apply_import(connection,source,preference_id=preference_id,confirmed=body.get('confirmed'),
                        expected_preview_digest=body.get('previewDigest'),operation_id=body.get('operation_id'),
                        epoch=body.get('epoch'),actor=actor,now_ms=int(time.time()*1000))
                    payload={'success':True,**meta,'receipt':result}
            elif path=='/api/database/draft':
                query=parse_qs(parsed.query,keep_blank_values=True,strict_parsing=True)
                if set(query)-{'project_id'} or any(len(v)!=1 for v in query.values()):raise db.DatabaseError('草稿查询参数无效')
                project_id=body.get('projectId') if body is not None else query.get('project_id',['default'])[0]
                db._text(project_id,'项目ID',256)
                if not connection.execute('SELECT 1 FROM projects WHERE id=?',(project_id,)).fetchone():raise db.DatabaseError('项目不存在',status=404)
                previous=latest_draft(connection,project_id)
                if method=='GET':payload={'success':True,**meta,'draft':previous}
                elif method=='POST':
                    if set(body)!={'projectId','fields','expected_draft_id','operation_id','epoch'}:raise db.DatabaseError('草稿字段无效')
                    fields=body['fields']
                    if not isinstance(fields,dict) or not fields or len(fields)>40 or any(not isinstance(k,str) or not k.startswith('planner') or not isinstance(v,str) or len(v)>1048576 for k,v in fields.items()):raise db.DatabaseError('规划草稿必须为原始输入字符串')
                    if not isinstance(body['operation_id'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}',body['operation_id']):raise db.DatabaseError('草稿操作标识无效')
                    if body['epoch']!=meta['epoch']:raise db.DatabaseError('数据库代次已变化，请重新核对草稿',code='EPOCH_CHANGED',status=409)
                    identifier='draft-'+body['operation_id'];db._text(identifier,'草稿ID')
                    value={'sourceOrigin':'server-planner-draft','sourceKey':'planner-draft:'+project_id,
                           'payload':{'projectId':project_id,'fields':fields,'sourceKind':'ui-draft','deploymentEligible':False}}
                    existing=db.get_resource(connection,'legacy_snapshots',identifier)
                    if existing:
                        receipt=db.get_operation(connection,body['operation_id'],actor['id'])
                        if existing['value']!=value or not receipt:raise db.DatabaseError('草稿操作已用于另一份内容或来源',status=409)
                        payload={'success':True,**meta,'draft':existing}
                    else:
                        if body['expected_draft_id']!=(previous['id'] if previous else None):raise db.DatabaseError('服务器已有更新的草稿，当前输入保留，请核对后保存',code='DRAFT_CONFLICT',status=409)
                        receipt=db.put_resource(connection,{'kind':'legacy_snapshots','id':identifier,'operation_id':body['operation_id'],
                            'epoch':body['epoch'],'expected_revision':0,'value':value},actor,int(time.time()*1000))
                        payload={'success':True,**meta,'draft':receipt['resource']}
                else:raise db.DatabaseError('不支持此方法',status=405)
            else:raise db.DatabaseError('存储接口不存在',status=404)
    except (db.DatabaseError,ImportError) as error:payload={'success':False,'error':str(error),'code':error.code};code=error.status
    except (ValueError,TypeError,KeyError):payload={'success':False,'error':'服务器存储请求无效'};code=400
    handler._json(payload,status=code);return True
