"""Read-only activity views over existing audit/event tables; no new history.

Saved business revisions, receiver observations and command outcomes are separate
sources. Lists never read scan payloads or telemetry sample tables. The caller
owns a read transaction so each cursor high-water mark is consistent.
"""
import base64,json,sqlite3,time
from functools import wraps
import unified_database as db

PROTOCOL='daty-activity-v1'
MODULES={
    'devices':('device_overrides','manual_devices'),
    'settings':('settings',),
    'spectrum':('scans','scan_current','simulation_settings'),
    'planning':('planning_records','planning_current','planning_runs','profiles'),
    'projects':('project_metadata',),
    'preferences':('preferences',),
    'plugins':('plugins',),
}
KINDS={k for values in MODULES.values() for k in values}
DEFAULT_KINDS=KINDS-{'preferences','profiles'}
EVENTS={'all':(), 'commands':('command.',),'devices':('device.','receiver.'),'planning':('planning.','project.','coordination.'),'discovery':('discovery.',)}
TABLES={'operations':('db_audit','seq','occurred_at_ms'),'timeline':('timeline_events','id','ts'),'live':('live_events','id','observed_at_ms')}
RETENTION_SOURCE='daty-operation-audit-retention-v1'
RETENTION_ACTOR='maintenance:operation-audit-retention'

def operation_boundary(c,epoch):
    # This is an immutable maintenance receipt, never a business-version delete.
    # Network peers cannot assert the maintenance actor through the MQTT API.
    row=c.execute('''SELECT json_extract(s.payload_json,'$.protocol'),json_extract(s.payload_json,'$.epoch'),
        json_extract(s.payload_json,'$.clearedThrough'),json_extract(s.payload_json,'$.clearedAtMs'),
        json_extract(s.payload_json,'$.recordCount')
        FROM db_legacy_snapshots s INDEXED BY idx_db_legacy_source
        JOIN db_resource_versions v ON v.kind='legacy_snapshots' AND v.id=s.id AND v.revision=1
        JOIN db_audit a ON a.seq=v.audit_seq
        WHERE s.source_origin=? AND s.source_key='operation-audit'
          AND json_extract(a.actor_json,'$.id')=? ORDER BY v.audit_seq DESC LIMIT 1''',
        (RETENTION_SOURCE,RETENTION_ACTOR)).fetchone()
    if row is None:return {'cleared_through':0,'cleared_at_ms':None,'cleared_count':0}
    if row[0]!=RETENTION_SOURCE or row[1]!=epoch or any(type(v) is not int or v<0 for v in row[2:]):
        raise db.DatabaseError('操作审计清空回执需核对',code='ACTIVITY_BOUNDARY_INVALID',status=503)
    return {'cleared_through':row[2],'cleared_at_ms':row[3],'cleared_count':row[4]}

def bounded_query(fn):
    @wraps(fn)
    def run(c,*args,**kwargs):
        deadline=time.monotonic()+2
        c.set_progress_handler(lambda:int(time.monotonic()>=deadline),1000)
        try:return fn(c,*args,**kwargs)
        except sqlite3.OperationalError as error:
            if getattr(error,'sqlite_errorcode',None)==sqlite3.SQLITE_INTERRUPT:
                raise db.DatabaseError('查询超过时限，请缩小时间或目标范围后重试',code='ACTIVITY_QUERY_TIMEOUT',status=503) from error
            raise
        finally:c.set_progress_handler(None,0)
    return run

def token(value):return base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).decode()
def parse_cursor(cursor):
    try:
        if not isinstance(cursor,str) or not 1<=len(cursor)<=4096:raise ValueError()
        value=json.loads(base64.b64decode(cursor.encode('ascii'),altchars=b'-_',validate=True))
        if not isinstance(value,dict):raise ValueError()
        return value
    except (ValueError,TypeError,UnicodeError) as error:raise db.DatabaseError('分页游标无效，请刷新',code='INVALID_CURSOR',status=409) from error

@bounded_query
def list_activity(c,source,*,category='all',limit=20,cursor=None,from_ms=0,to_ms=None,target=''):
    if not isinstance(source,str) or source not in TABLES:raise db.DatabaseError('活动来源无效')
    db._int(limit,'每页条数',1,50);db._int(from_ms,'开始时间')
    if to_ms is not None:db._int(to_ms,'结束时间',from_ms)
    if not isinstance(target,str) or len(target)>128 or any(ord(ch)<32 for ch in target):raise db.DatabaseError('目标筛选无效')
    if not isinstance(category,str) or (source=='operations' and category not in {'all',*MODULES} or source=='timeline' and category not in EVENTS or source=='live' and category!='all'):raise db.DatabaseError('活动分类无效')
    meta=db.status(c);table,pk,timecol=TABLES[source]
    binding={'source':source,'category':category,'from_ms':from_ms,'to_ms':to_ms,'target':target,'epoch':meta['epoch']}
    maximum=c.execute(f'SELECT COALESCE(MAX({pk}),0) FROM {table}').fetchone()[0]
    boundary=operation_boundary(c,meta['epoch']) if source=='operations' else {}
    if boundary:
        if boundary['cleared_through']>maximum:raise db.DatabaseError('清空水位超出当前数据库',code='ACTIVITY_BOUNDARY_INVALID',status=503)
        binding['cleared_through']=boundary['cleared_through']
    upper=maximum;after=None
    if cursor is not None:
        state=parse_cursor(cursor)
        if set(state)!={*binding,'upper','after'} or any(state[k]!=v for k,v in binding.items()):raise db.DatabaseError('分页来源或筛选条件已变化',code='INVALID_CURSOR',status=409)
        upper=db._int(state['upper'],'分页水位',0,maximum);after=state['after']
        if source=='operations':db._int(after,'分页位置',1,upper)
        elif not isinstance(after,list) or len(after)!=2 or type(after[0]) not in (int,float) or not 0<=after[0]<=db.MAX_REVISION:
            raise db.DatabaseError('事件分页位置无效')
        else:db._int(after[1],'事件分页标识',1,upper)
    if source=='operations':
        # Each domain uses the existing (kind,audit_seq,id) index. Frequent alert
        # touches/internal MQTT receipts cannot force an all-history scan.
        kinds=DEFAULT_KINDS if category=='all' else MODULES[category];candidates=[]
        for kind in sorted(kinds):
            sql='''SELECT a.seq,a.occurred_at_ms,a.kind,a.resource_id,a.revision,a.operation_id,v.deleted
                FROM db_resource_versions v INDEXED BY idx_db_versions_history JOIN db_audit a ON a.seq=v.audit_seq
                WHERE v.kind=? AND v.audit_seq<=? AND v.audit_seq>? AND a.occurred_at_ms>=?'''
            values=[kind,upper,boundary['cleared_through'],from_ms]
            if after is not None:sql+=' AND v.audit_seq<?';values.append(after)
            if to_ms is not None:sql+=' AND a.occurred_at_ms<=?';values.append(to_ms)
            if target:sql+=' AND instr(a.resource_id,?)>0';values.append(target)
            sql+=' ORDER BY v.audit_seq DESC LIMIT ?';values.append(limit+1)
            candidates.extend(c.execute(sql,values).fetchall())
        rows=sorted(candidates,key=lambda r:r[0],reverse=True)[:limit+1]
        items=[{'source':source,'id':r[0],'time_ms':r[1],'kind':r[2],'target':r[3],'revision':r[4],'operation_id':r[5],'outcome':'deleted' if r[6] else 'committed'} for r in rows[:limit]]
        last=rows[limit-1][0] if len(rows)>limit else None
    else:
        columns='id,ts,event_type,device_id,project_id,summary,command_id' if source=='timeline' else 'id,observed_at_ms,event_type,device_id,receiver_id'
        sql=f'SELECT {columns} FROM {table} WHERE id<=? AND {timecol}>=?';values=[upper,from_ms/1000 if source=='timeline' else from_ms]
        if to_ms is not None:sql+=f' AND {timecol}<=?';values.append(to_ms/1000 if source=='timeline' else to_ms)
        if after is not None:sql+=f' AND ({timecol}<? OR ({timecol}=? AND id<?))';values.extend([after[0],after[0],after[1]])
        if source=='timeline' and EVENTS[category]:
            sql+=' AND ('+' OR '.join('event_type LIKE ?' for _ in EVENTS[category])+')';values.extend(p+'%' for p in EVENTS[category])
        if target:sql+=" AND instr(COALESCE(device_id,''),?)>0";values.append(target)
        sql+=f' ORDER BY {timecol} DESC,id DESC LIMIT ?';values.append(limit+1)
        query=c.execute(sql,values);names=[d[0] for d in query.description];rows=[dict(zip(names,r)) for r in query.fetchall()]
        # No details JSON or telemetry samples are read for a list.
        items=[{'source':source,'id':r['id'],'time_ms':r[timecol]*(1000 if source=='timeline' else 1),'kind':r['event_type'],
            'target':r['device_id'] or (r.get('receiver_id') if source=='live' else r.get('project_id')) or '—',
            'summary':r.get('summary'),'command_id':r.get('command_id'),'outcome':r['event_type'].split('.',1)[-1] if source=='timeline' and r['event_type'].startswith('command.') else 'observed'} for r in rows[:limit]]
        last=[rows[limit-1][timecol],rows[limit-1]['id']] if len(rows)>limit else None
    return {'success':True,**meta,**boundary,'activity_protocol':PROTOCOL,'source':source,'items':items,'next_cursor':token({**binding,'upper':upper,'after':last}) if last is not None else None,'as_of':upper}

FIELDS={
 'settings':['rfWeakDbm','batteryLowPercent','afOverloadDbfs','enabled'],
 'device_overrides':['receiverId','channelNumber','alias'],
 'manual_devices':['name','brand','model','configuredChannelNumber','configuredFrequencyKHz','configuredIp'],
 'scans':['projectId','name','sourceKind','frequencyUnit','levelUnit'],
 'scan_current':['projectId','scanId'],
 'simulation_settings':['projectId','sourceKind','options'],
 'planning_records':['projectId','name','timestamp','channels','algo'],
 'planning_current':['projectId','currentRecordId'],
 'planning_runs':['projectId','engineVersion','scanId'],
 'profiles':['id','manufacturer','models','source'],
 'project_metadata':['id','name'],
 'preferences':['specStartFreq','specEndFreq','spectrumStartKHz','spectrumEndKHz','channelPage','devicePage','historyPage','alertPage','timelinePage','activePanel'],
 'plugins':['id','name','status','installed'],
}
def revision_summary(c,kind,id,revision):
    if revision<1:return None
    fields=FIELDS[kind];expressions=['json_extract(value_json,?)' for _ in fields]
    row=c.execute('SELECT deleted,digest,'+','.join(expressions)+' FROM db_resource_versions WHERE kind=? AND id=? AND revision=?',
                  [*['$.'+f for f in fields],kind,id,revision]).fetchone()
    if not row:raise db.DatabaseError('历史版本缺失',status=503)
    return {'revision':revision,'deleted':bool(row[0]),'digest':row[1],'fields':{f:v for f,v in zip(fields,row[2:]) if v is not None}}

@bounded_query
def get_activity(c,source,id):
    if not isinstance(source,str) or source not in TABLES:raise db.DatabaseError('活动来源无效')
    db._int(id,'记录标识',1);table,pk,_=TABLES[source]
    if source=='operations' and id<=operation_boundary(c,db.status(c)['epoch'])['cleared_through']:
        raise db.DatabaseError('该记录已从操作审计清空，关联业务历史保留',status=404)
    query=c.execute(f'SELECT * FROM {table} WHERE {pk}=?',(id,));row=query.fetchone()
    if not row:raise db.DatabaseError('记录不存在',status=404)
    record=dict(zip([d[0] for d in query.description],row))
    if source=='operations':
        kind=record['kind']
        if kind not in KINDS:raise db.DatabaseError('不属于业务操作审计',status=404)
        record['actor']=json.loads(record.pop('actor_json'))
        record['before']=revision_summary(c,kind,record['resource_id'],record['revision']-1)
        record['after']=revision_summary(c,kind,record['resource_id'],record['revision'])
    else:record['details']=json.loads(record.pop('details_json') or '{}')
    return {'success':True,**db.status(c),'activity_protocol':PROTOCOL,'source':source,'id':id,'record':record}
