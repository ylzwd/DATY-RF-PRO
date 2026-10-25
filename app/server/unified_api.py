"""Authenticated unified business API adapter, independent from device commands.

Mount only after the existing handler's Origin gate. Both reads and writes use
the existing project.write operator permission; no new anonymous business read.
Outer db_session commits before a success response; _json is outside try/except
so a lost reply never triggers another write or a misleading second response.
"""
import json
import re
import time
from urllib.parse import parse_qs, unquote, urlsplit

import unified_database as db
import unified_domains
import unified_live


def _decode(value):
    if not value or re.search(r'%(?![0-9a-fA-F]{2})',value):
        raise db.DatabaseError('业务地址编码无效')
    try:
        return db._text(unquote(value,encoding='utf-8',errors='strict'),'业务标识')
    except UnicodeError as error:
        raise db.DatabaseError('业务地址编码无效') from error


def read_json(handler):
    """Same framing/media/security requirements as the old 4 MiB reader.

    This authenticated business route alone permits up to 64 MiB for a 16 MiB
    original CSV plus its validated points. Device/control limits stay unchanged.
    """
    lengths=handler.headers.get_all('Content-Length',[])
    if handler.headers.get('Transfer-Encoding') or len(lengths)!=1 or not re.fullmatch(r'[0-9]{1,10}',lengths[0]):
        raise db.DatabaseError('需要单一有效 Content-Length')
    length=int(lengths[0])
    if length>db.MAX_DOCUMENT_BYTES:
        raise db.DatabaseError('业务请求超过 64 MiB',status=413)
    if handler.headers.get_content_type()!='application/json':
        raise db.DatabaseError('请求必须为 application/json',status=415)
    handler.connection.settimeout(10)
    def pairs(items):
        out={}
        for key,value in items:
            if key in out:
                raise ValueError('duplicate JSON field')
            out[key]=value
        return out
    def nonfinite(_):
        raise ValueError('nonfinite JSON')
    try:
        raw=handler.rfile.read(length)
        if len(raw)!=length:
            raise ValueError('incomplete')
        value=json.loads(raw,object_pairs_hook=pairs,parse_constant=nonfinite)
        if not isinstance(value,dict):
            raise ValueError('not object')
        return value
    except (ValueError,UnicodeError,OSError,RecursionError) as error:
        raise db.DatabaseError('请求不是完整、无重复字段的 JSON 对象') from error


def live_reader(boot_id, now_ms=lambda:int(time.time()*1000)):
    """Read-only projection, never a replacement for the control target registry."""
    def read(connection,path,query_string):
        query=parse_qs(query_string,keep_blank_values=True,strict_parsing=True)
        if set(query)-{'limit','cursor','receiver_id'} or any(len(v)!=1 for v in query.values()):
            raise db.DatabaseError('实时历史查询参数无效')
        if path=='/api/database/overview':
            if query:raise db.DatabaseError('概览不接受分页参数')
            return unified_live.get_overview(connection,boot_id,now_ms())
        raw_limit=query.get('limit',['50'])[0]
        if not re.fullmatch('[0-9]{1,3}',raw_limit):raise db.DatabaseError('通道分页大小无效')
        return unified_live.query_channels(connection,boot_id,now_ms(),limit=int(raw_limit),
            cursor=query.get('cursor',[None])[0],receiver_id=query.get('receiver_id',[None])[0])
    return read


def network_actor(handler):
    peer = handler._request_actor()
    return {'id': 'network:' + peer['ip'], **peer}


def handle(handler,method,target,*,db_session,now_ms=lambda:int(time.time()*1000),live_reader=None,runtime_status=None,actor=None):
    parsed=urlsplit(target);path=parsed.path
    if not path.startswith('/api/database/'):
        return False
    # The running direct-control Bridge supplies its real network peer.
    # The optional legacy gate is retained only for historical isolated fixtures.
    if actor is None:
        if not handler._authorize('project.write'): return True
        actor = handler._principal
    payload=None;meta={'protocol':db.PROTOCOL};status_code=200
    try:
        if method not in ('GET','POST'):
            raise db.DatabaseError('业务方法不支持',status=405)
        body=read_json(handler) if method=='POST' else None
        with db_session() as connection:
            # Pin status/resource/operation to a single read transaction too.
            if not connection.in_transaction:
                connection.execute('BEGIN IMMEDIATE' if method=='POST' else 'BEGIN')
            meta=db.status(connection)
            if method=='GET' and path=='/api/database/status':
                payload={'success':True,**meta,'storage_source':actor,'control_protocol':'daty-direct-control-v1'}
                if runtime_status is not None:payload['live_persistence']=runtime_status()
            elif method=='GET' and path=='/api/database/resources':
                query=parse_qs(parsed.query,keep_blank_values=True,strict_parsing=True)
                if set(query)-{'kind','limit','cursor','since','since_epoch','project_id'} or any(len(v)!=1 for v in query.values()):
                    raise db.DatabaseError('查询参数无效')
                raw_limit=query.get('limit',['100'])[0]
                if not re.fullmatch('[0-9]{1,3}',raw_limit):
                    raise db.DatabaseError('分页大小无效')
                raw_since=query.get('since',[None])[0]
                if raw_since is not None and not re.fullmatch('[0-9]{1,16}',raw_since):
                    raise db.DatabaseError('增量版本无效')
                payload=db.list_resources(connection,query.get('kind',[None])[0],int(raw_limit),query.get('cursor',[None])[0],
                    since=int(raw_since) if raw_since is not None else None,since_epoch=query.get('since_epoch',[None])[0],project_id=query.get('project_id',[None])[0])
            elif method=='GET' and path.startswith('/api/database/resources/'):
                pieces=path[len('/api/database/resources/'):].split('/')
                if len(pieces)!=2:
                    raise db.DatabaseError('业务资源路径不存在',status=404)
                value=db.get_resource(connection,_decode(pieces[0]),_decode(pieces[1]))
                if value is None:
                    payload={'success':False,**meta,'code':'RESOURCE_NOT_FOUND'};status_code=404
                else:
                    payload={'success':True,**meta,'resource':value}
            elif method=='GET' and path.startswith('/api/database/operations/'):
                operation_id=path[len('/api/database/operations/'):]
                if not re.fullmatch(r'[A-Za-z0-9_-]{16,80}',operation_id):
                    raise db.DatabaseError('操作标识无效')
                receipt=db.get_operation(connection,operation_id,actor['id'])
                if receipt is None:
                    payload={'success':False,**meta,'code':'OPERATION_NOT_FOUND'};status_code=404
                else:
                    payload={'success':True,**meta,'operation':receipt}
            elif method=='POST' and path=='/api/database/write' and not parsed.query:
                payload=db.put_resource(connection,body,actor,now_ms())
            elif method=='POST' and path=='/api/database/batch' and not parsed.query:
                payload=db.put_batch(connection,body,actor,now_ms())
            elif method=='GET' and live_reader and path in ('/api/database/overview','/api/database/channels'):
                payload={'success':True,**meta,**live_reader(connection,path,parsed.query)}
            else:
                raise db.DatabaseError('业务接口不存在',status=404)
            # Validate encoding before exiting/committing, not halfway through
            # a network response after a business write has already committed.
            json.dumps(payload,ensure_ascii=False,allow_nan=False).encode('utf-8',errors='strict')
    except db.DatabaseError as error:
        status_code=error.status
        payload={'success':False,'accepted':False,**meta,'code':error.code,'error':str(error)}
    except unified_domains.DomainError as error:
        status_code=getattr(error,'status',400)
        payload={'success':False,'accepted':False,**meta,'code':getattr(error,'code','INVALID_DOMAIN_DATA'),'error':str(error)}
    except (ValueError,TypeError,KeyError):
        status_code=400
        payload={'success':False,'accepted':False,**meta,'code':'INVALID_DATABASE_REQUEST','error':'业务请求或存储数据格式无效，未确认保存'}
    except Exception:
        status_code=503
        payload={'success':False,'accepted':False,**meta,'code':'DATABASE_UNAVAILABLE','error':'业务事务未完成，请保留本机数据并先核对操作回执'}
    handler._json(payload,status=status_code)
    return True
