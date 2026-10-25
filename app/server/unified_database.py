"""Versioned DATY business database. No file/network/startup/commit side effects.

The caller owns one transaction: migration, normalized projections, immutable
versions, audit and operation receipts either all commit or all roll back.
Credentials and live receiver controls are deliberately outside this repository.
"""
import base64
import hashlib
import ipaddress
import json
import math
import re
import uuid

import data_retirement
import unified_domains
import unified_live
from project_store import migrate_projects

PROTOCOL = 'daty-business-db-v1'
SCHEMA_VERSION = 3
MAX_REVISION = 9007199254740991
MAX_DOCUMENT_BYTES = 64 * 1024 * 1024
LEGACY_TABLES = {'projects','project_devices','scan_datasets','coordination_runs','commands','telemetry_samples','timeline_events'}
KINDS = frozenset({'settings','profiles','planning_records','planning_current','alerts',
                   'device_overrides','preferences','plugins','scans','planning_runs',
                   'project_metadata','manual_devices','legacy_snapshots','simulation_settings','scan_current'})
CORE_DDL = (
    '''CREATE TABLE db_schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL,
       applied_at_ms INTEGER NOT NULL) STRICT''',
    '''CREATE TABLE db_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
       instance_id TEXT NOT NULL, epoch TEXT NOT NULL, created_at_ms INTEGER NOT NULL) STRICT''',
    '''CREATE TABLE db_resources(kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
       PRIMARY KEY(kind,id)) STRICT''',
    '''CREATE TABLE db_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
       kind TEXT NOT NULL, resource_id TEXT NOT NULL, revision INTEGER NOT NULL,
       actor_json TEXT NOT NULL CHECK(json_valid(actor_json)), occurred_at_ms INTEGER NOT NULL) STRICT''',
    '''CREATE TABLE db_resource_versions(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,
       value_json TEXT NOT NULL CHECK(json_valid(value_json)),deleted INTEGER NOT NULL CHECK(deleted IN(0,1)),
       digest TEXT NOT NULL, audit_seq INTEGER NOT NULL UNIQUE, PRIMARY KEY(kind,id,revision),
       FOREIGN KEY(kind,id) REFERENCES db_resources(kind,id),FOREIGN KEY(audit_seq) REFERENCES db_audit(seq)) STRICT''',
    '''CREATE TABLE db_operations(operation_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
       request_digest TEXT NOT NULL, actor_id TEXT NOT NULL, kind TEXT NOT NULL,
       resource_id TEXT NOT NULL, revision INTEGER NOT NULL, committed_at_ms INTEGER NOT NULL,
       FOREIGN KEY(kind,resource_id,revision) REFERENCES db_resource_versions(kind,id,revision)) STRICT''',
    '''CREATE TABLE db_batches(operation_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
       request_digest TEXT NOT NULL, actor_id TEXT NOT NULL, committed_at_ms INTEGER NOT NULL) STRICT''',
    '''CREATE TABLE db_batch_items(batch_id TEXT NOT NULL,ordinal INTEGER NOT NULL,operation_id TEXT NOT NULL UNIQUE,
       PRIMARY KEY(batch_id,ordinal),FOREIGN KEY(batch_id) REFERENCES db_batches(operation_id),
       FOREIGN KEY(operation_id) REFERENCES db_operations(operation_id)) STRICT''',
    '''CREATE TABLE db_import_batches(id TEXT PRIMARY KEY,source_origin TEXT NOT NULL,
       source_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('staged','committed','rejected')),
       manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),created_at_ms INTEGER NOT NULL) STRICT''',
    '''CREATE TABLE db_project_metadata(id TEXT PRIMARY KEY,name TEXT NOT NULL,revision INTEGER NOT NULL,
       deleted INTEGER NOT NULL CHECK(deleted IN(0,1)),metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
       FOREIGN KEY(id) REFERENCES projects(id)) STRICT''',
    '''CREATE TABLE db_manual_devices(id TEXT PRIMARY KEY,brand TEXT NOT NULL,model TEXT,name TEXT,
       configured_frequency_khz INTEGER,configured_channel_number INTEGER,configured_ip TEXT,
       revision INTEGER NOT NULL,deleted INTEGER NOT NULL CHECK(deleted IN(0,1)),
       metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json))) STRICT''',
    '''CREATE TABLE db_legacy_snapshots(id TEXT PRIMARY KEY,source_origin TEXT NOT NULL,source_key TEXT NOT NULL,
       payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),payload_sha256 TEXT NOT NULL,
       revision INTEGER NOT NULL CHECK(revision=1)) STRICT''',
    '''CREATE TABLE db_simulation_settings(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,peak_width_khz REAL NOT NULL,
       floor_dbm REAL NOT NULL,ripple_db REAL NOT NULL,texture_step_khz REAL NOT NULL,threshold_dbm REAL NOT NULL,
       imd_suppression_db REAL NOT NULL,include_imd INTEGER NOT NULL CHECK(include_imd IN(0,1)),
       include_fifth INTEGER NOT NULL CHECK(include_fifth IN(0,1)),include_three_tone INTEGER NOT NULL CHECK(include_three_tone IN(0,1)),
       revision INTEGER NOT NULL,deleted INTEGER NOT NULL CHECK(deleted IN(0,1)),metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
       FOREIGN KEY(project_id) REFERENCES projects(id)) STRICT''',
    '''CREATE TABLE db_scans(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,name TEXT NOT NULL,
       source_kind TEXT NOT NULL CHECK(source_kind IN('imported_csv','instrument','simulation')),
       point_count INTEGER NOT NULL CHECK(point_count>=2),min_khz INTEGER NOT NULL,max_khz INTEGER NOT NULL,
       points_digest TEXT NOT NULL,revision INTEGER NOT NULL,metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
       FOREIGN KEY(project_id) REFERENCES projects(id)) STRICT''',
    '''CREATE TABLE db_scan_points(scan_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),
       frequency_khz INTEGER NOT NULL CHECK(frequency_khz>0),level_dbm REAL NOT NULL CHECK(level_dbm>=-200 AND level_dbm<=100),
       PRIMARY KEY(scan_id,ordinal),UNIQUE(scan_id,frequency_khz),FOREIGN KEY(scan_id) REFERENCES db_scans(id)) STRICT''',
    '''CREATE TABLE db_scan_originals(scan_id TEXT PRIMARY KEY,file_name TEXT NOT NULL,content_utf8 BLOB NOT NULL,
       sha256 TEXT NOT NULL,byte_count INTEGER NOT NULL,FOREIGN KEY(scan_id) REFERENCES db_scans(id)) STRICT''',
    '''CREATE TABLE db_scan_current(id TEXT PRIMARY KEY,scan_id TEXT NOT NULL,revision INTEGER NOT NULL,
       FOREIGN KEY(id) REFERENCES projects(id),FOREIGN KEY(scan_id) REFERENCES db_scans(id)) STRICT''',
    '''CREATE TABLE db_planning_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,
       input_json TEXT NOT NULL CHECK(json_valid(input_json)),result_json TEXT NOT NULL CHECK(json_valid(result_json)),
       engine_version TEXT,scan_id TEXT,profile_refs_json TEXT NOT NULL CHECK(json_valid(profile_refs_json)),revision INTEGER NOT NULL,
       FOREIGN KEY(project_id) REFERENCES projects(id),FOREIGN KEY(scan_id) REFERENCES db_scans(id)) STRICT''',
    'CREATE INDEX idx_db_versions_history ON db_resource_versions(kind,audit_seq,id)',
)
CORE_TABLES = {re.search(r'CREATE TABLE (\w+)', sql)[1] for sql in CORE_DDL if sql.startswith('CREATE TABLE')}


class DatabaseError(ValueError):
    def __init__(self, message, *, code='INVALID_DATABASE_DATA', status=400):
        super().__init__(message)
        self.code, self.status = code, status


def _text(value, field, limit=512):
    if (not isinstance(value,str) or not value.strip() or len(value)>limit
            or any(ord(c)<32 or ord(c)==127 for c in value)):
        raise DatabaseError(field+' 必须是非空文本')
    try:
        value.encode('utf-8',errors='strict')
    except UnicodeError as error:
        raise DatabaseError(field+' 包含无效编码') from error
    return value


def _int(value, field, minimum=0, maximum=MAX_REVISION):
    if type(value) is not int or not minimum<=value<=maximum:
        raise DatabaseError(field+' 必须是有效整数')
    return value


def _safe_json(value):
    """Plain JSON only; credentials never enter business version/audit history."""
    def visit(item,depth=0):
        if depth>60:
            raise DatabaseError('数据嵌套过深')
        if isinstance(item,dict):
            for key,entry in item.items():
                if not isinstance(key,str) or re.search(r'password|passwd|secret|token|authorization|credential|private.?key|access.?key',key,re.I) or key in ('__proto__','constructor','prototype'):
                    raise DatabaseError('业务数据不能包含凭据或不安全字段')
                visit(entry,depth+1)
        elif isinstance(item,list):
            for entry in item:
                visit(entry,depth+1)
        elif item is not None and type(item) not in (str,int,float,bool):
            raise DatabaseError('数据必须是标准 JSON')
    visit(value)
    try:
        text=json.dumps(value,ensure_ascii=False,allow_nan=False,sort_keys=True,separators=(',',':'))
        encoded=text.encode('utf-8',errors='strict')
    except (ValueError,TypeError,UnicodeError,RecursionError) as error:
        raise DatabaseError('数据不是合法的有限值 JSON') from error
    if len(encoded)>MAX_DOCUMENT_BYTES:
        raise DatabaseError('业务文档超过 64 MiB',status=413)
    return text


def _digest(value):
    return hashlib.sha256(_safe_json(value).encode()).hexdigest()


def _begin(connection):
    if connection.execute('PRAGMA foreign_keys').fetchone()[0]!=1:
        raise DatabaseError('数据库必须启用外键约束',status=503)
    if not connection.in_transaction:
        connection.execute('BEGIN IMMEDIATE')


# Additive indexes only: no telemetry rewrite, retention or loss of versions.
INDEX_V2_DDL = (
    'CREATE INDEX idx_db_versions_snapshot ON db_resource_versions(kind,id,audit_seq DESC)',
    "CREATE INDEX idx_db_versions_project ON db_resource_versions(json_extract(value_json,'$.projectId'),id,audit_seq) WHERE kind='planning_records'",
    'CREATE INDEX idx_db_legacy_source ON db_legacy_snapshots(source_origin,source_key)',
)


def schema_statements(version=SCHEMA_VERSION):
    if version not in (1,2,3):
        raise ValueError('Unsupported schema version')
    base=(*CORE_DDL,*unified_domains.schema_statements(),*unified_live.schema_statements(version))
    return base if version==1 else (*base,*INDEX_V2_DDL)


def migration_checksums(version=SCHEMA_VERSION):
    return [(v,hashlib.sha256('\n'.join(schema_statements(v)).encode()).hexdigest()) for v in range(1,version+1)]


def supported_tables(version=SCHEMA_VERSION):
    return LEGACY_TABLES | CORE_TABLES | set(unified_domains.TABLES) | set(unified_live.TABLES if version>=3 else unified_live.BASE_TABLES)


def migrate(connection, now_ms, new_id=lambda:uuid.uuid4().hex):
    """Add versioned business tables to the existing seven-table DATY database.

    Existing data is NEVER coerced, deleted or imported just by starting a server.
    Read/preview legacy migration separately. Unknown schemas fail before DDL.
    """
    _int(now_ms,'服务器时间')
    _begin(connection)
    from unified_schema import validate_schema,SchemaError
    try:
        validate_schema(connection)
    except SchemaError as error:
        raise DatabaseError(str(error),status=503,code=error.code) from error
    objects=connection.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall()
    tables={r[1] for r in objects if r[0]=='table'}
    if any(r[0] in ('view','trigger') or 'VIRTUAL TABLE' in (r[2] or '').upper() for r in objects):
        raise DatabaseError('未知视图/触发器结构，停止自动迁移',status=503,code='SCHEMA_UNSUPPORTED')
    if not LEGACY_TABLES.issubset(tables) or tables-supported_tables():
        raise DatabaseError('不是受支持的 DATY 业务数据库',status=503,code='SCHEMA_UNSUPPORTED')
    if 'db_schema_migrations' in tables:
        version=connection.execute('PRAGMA user_version').fetchone()[0]
        if version==1:
            for sql in INDEX_V2_DDL:
                connection.execute(sql)
            connection.execute('INSERT INTO db_schema_migrations VALUES(?,?,?)',(*migration_checksums()[1],now_ms))
            connection.execute('PRAGMA user_version=2')
            version=2
        if version==2:
            for sql in unified_live.rf_sample_storage.DDL:
                connection.execute(sql)
            connection.execute('INSERT INTO db_schema_migrations VALUES(?,?,?)',(*migration_checksums()[2],now_ms))
            connection.execute('PRAGMA user_version=3')
        validate_schema(connection,allow_legacy=False)
        return status(connection)
    if tables!=LEGACY_TABLES or connection.execute('PRAGMA user_version').fetchone()[0]!=0:
        raise DatabaseError('数据库含未确认迁移，停止升级',status=503,code='SCHEMA_UNSUPPORTED')
    migrate_projects(connection)
    for sql in schema_statements():
        connection.execute(sql)
    connection.execute('INSERT INTO db_identity VALUES(1,?,?,?)',(_text(new_id(),'数据库身份'),_text(new_id(),'数据库代次'),now_ms))
    for version,checksum in migration_checksums():
        connection.execute('INSERT INTO db_schema_migrations VALUES(?,?,?)',(version,checksum,now_ms))
    connection.execute('PRAGMA user_version='+str(SCHEMA_VERSION))
    validate_schema(connection,allow_legacy=False)
    return status(connection)


def status(connection):
    row=connection.execute('SELECT instance_id,epoch FROM db_identity WHERE singleton=1').fetchone()
    if not row:
        raise DatabaseError('数据库身份缺失',status=503)
    return {'protocol':PROTOCOL,'schema_version':connection.execute('PRAGMA user_version').fetchone()[0],'instance_id':row[0],'epoch':row[1]}


def rollback_index_migration(connection,expected_epoch):
    """Explicit OFFLINE maintenance only; never exposed via API/startup.

    Returns the exact r18 schema without restoring stale business data. Caller
    must stop all writers and own the commit/rollback transaction.
    """
    _begin(connection)
    from unified_schema import validate_schema
    checked=validate_schema(connection,allow_legacy=False)
    if checked['schema_version']>2:
        raise DatabaseError('压缩样本数据库不能通过旧索引回退工具降级',status=409,code='SCHEMA_DOWNGRADE_REQUIRES_CONVERSION')
    if checked['epoch']!=expected_epoch:
        raise DatabaseError('离线回退数据库代次不匹配',status=409,code='DATABASE_EPOCH_CHANGED')
    if checked['schema_version']==2:
        for sql in INDEX_V2_DDL:
            name=re.match(r'CREATE INDEX (\w+)',sql)[1]
            connection.execute('DROP INDEX '+name)
        connection.execute('DELETE FROM db_schema_migrations WHERE version=2')
        connection.execute('PRAGMA user_version=1')
    validate_schema(connection,allow_legacy=False)
    return status(connection)


def rollback_sample_storage(connection,expected_epoch):
    """OFFLINE primitive: restore JSON in current rows, never restore stale DB.

    Caller holds the runtime lease and owns the transaction. No API/startup hook.
    Decode errors must roll back the entire operation, including previous rows.
    """
    _begin(connection)
    from unified_schema import validate_schema
    from rf_sample_storage import load_snapshot,SAMPLE_KIND
    checked=validate_schema(connection,allow_legacy=False)
    if checked['epoch']!=expected_epoch:
        raise DatabaseError('离线转换数据库代次不匹配',status=409,code='DATABASE_EPOCH_CHANGED')
    if checked['schema_version']!=3:
        raise DatabaseError('离线转换只支持 schema 3',status=409,code='SCHEMA_UNSUPPORTED')
    last=0
    while True:
        ids=connection.execute('SELECT id FROM live_samples WHERE id>? AND sample_kind=? ORDER BY id LIMIT 256',(last,SAMPLE_KIND)).fetchall()
        if not ids:break
        for (sample_id,) in ids:
            raw=load_snapshot(connection,sample_id)
            connection.execute("UPDATE live_samples SET snapshot_json=?,sample_kind='bridge-snapshot' WHERE id=?",(raw,sample_id))
            last=sample_id
    for table in ('live_sample_payloads','live_sample_blocks'):
        connection.execute('DROP TABLE '+table)
    connection.execute('DELETE FROM db_schema_migrations WHERE version=3')
    connection.execute('PRAGMA user_version=2')
    validate_schema(connection,allow_legacy=False)
    return status(connection)


def _resource(connection,kind,id,revision=None):
    if revision is None:
        row=connection.execute('SELECT revision FROM db_resources WHERE kind=? AND id=?',(kind,id)).fetchone()
        if not row:
            return None
        revision=row[0]
    row=connection.execute('SELECT value_json,deleted FROM db_resource_versions WHERE kind=? AND id=? AND revision=?',(kind,id,revision)).fetchone()
    if row is None:
        raise DatabaseError('业务版本引用损坏',status=503)
    return {'kind':kind,'id':id,'revision':revision,'value':json.loads(row[0]),'deleted':bool(row[1])}


def get_resource(connection,kind,id):
    if kind not in KINDS:
        raise DatabaseError('未知业务域')
    return _resource(connection,kind,_text(id,'业务标识'))


def get_operation(connection,operation_id,actor_id):
    batch=connection.execute('SELECT epoch,actor_id FROM db_batches WHERE operation_id=?',(operation_id,)).fetchone()
    if batch:
        if batch[1]!=actor_id:
            raise DatabaseError('不能读取其他操作者的操作回执',status=403,code='OPERATION_OWNER_MISMATCH')
        if batch[0]!=status(connection)['epoch']:
            raise DatabaseError('数据库已恢复，旧回执不能用于当前确认',status=409,code='DATABASE_EPOCH_CHANGED')
        receipts=[get_operation(connection,row[0],actor_id)['resource'] for row in connection.execute(
            'SELECT operation_id FROM db_batch_items WHERE batch_id=? ORDER BY ordinal',(operation_id,)).fetchall()]
        return {'operation_id':operation_id,'status':'committed','resources':receipts}
    row=connection.execute('SELECT epoch,actor_id,kind,resource_id,revision FROM db_operations WHERE operation_id=?',(operation_id,)).fetchone()
    if not row:
        return None
    if row[1]!=actor_id:
        raise DatabaseError('不能读取其他操作者的操作回执',status=403,code='OPERATION_OWNER_MISMATCH')
    if row[0]!=status(connection)['epoch']:
        raise DatabaseError('数据库已恢复，旧回执不能用于当前确认',status=409,code='DATABASE_EPOCH_CHANGED')
    return {'operation_id':operation_id,'status':'committed','resource':_resource(connection,row[2],row[3],row[4])}


def _validate_scan(value):
    if not isinstance(value,dict) or value.get('sourceKind') not in ('imported_csv','instrument','simulation'):
        raise DatabaseError('扫描必须明确真实导入、仪器或仿真来源')
    _text(value.get('projectId'),'扫描项目');_text(value.get('name'),'扫描名称')
    if value.get('frequencyUnit')!='kHz' or value.get('levelUnit')!='dBm':
        raise DatabaseError('扫描数据库只接收明确 kHz/dBm 单位')
    points=value.get('points')
    if not isinstance(points,list) or not 2<=len(points)<=1000000:
        raise DatabaseError('扫描点数必须为 2 至 1000000')
    previous=0
    for p in points:
        if not isinstance(p,dict):
            raise DatabaseError('扫描点格式无效')
        f=_int(p.get('frequencyKHz'),'扫描频率',30000,3000000)
        level=p.get('levelDbm')
        if f<=previous or type(level) not in (int,float) or not math.isfinite(level) or not -200<=level<=50:
            raise DatabaseError('扫描频率须严格升序不重复，电平须是有限 dBm')
        previous=f
    original=value.get('original')
    if original is not None:
        if not isinstance(original,dict) or not isinstance(original.get('text'),str):
            raise DatabaseError('扫描原文件必须是明确的 UTF-8 文本')
        _text(original.get('name'),'原文件名')
        content=original['text'].encode('utf-8',errors='strict')
        if len(content)>16*1024*1024:
            raise DatabaseError('扫描原文件超过 16 MiB',status=413)
        if original.get('sha256') is not None and original['sha256']!=hashlib.sha256(content).hexdigest():
            raise DatabaseError('扫描原文件摘要不匹配')


def _project_scan(connection,id,value,revision,deleted):
    if connection.execute('SELECT 1 FROM db_planning_runs WHERE scan_id=? UNION ALL SELECT 1 FROM db_scan_current WHERE scan_id=?',(id,id)).fetchone():
        raise DatabaseError('扫描已被规划运行引用，请用新扫描 ID 保存，不能改写历史输入',status=409,code='SCAN_REFERENCED')
    connection.execute('DELETE FROM db_scan_points WHERE scan_id=?',(id,))
    connection.execute('DELETE FROM db_scan_originals WHERE scan_id=?',(id,))
    connection.execute('DELETE FROM db_scans WHERE id=?',(id,))
    if deleted:
        return
    points=value['points'];metadata={k:v for k,v in value.items() if k not in ('points','original')}
    connection.execute('INSERT INTO db_scans VALUES(?,?,?,?,?,?,?,?,?,?)',
        (id,value['projectId'],value['name'],value['sourceKind'],len(points),points[0]['frequencyKHz'],points[-1]['frequencyKHz'],_digest(points),revision,_safe_json(metadata)))
    connection.executemany('INSERT INTO db_scan_points VALUES(?,?,?,?)',[(id,i,p['frequencyKHz'],p['levelDbm']) for i,p in enumerate(points)])
    original=value.get('original')
    if original is not None:
        content=original['text'].encode('utf-8')
        connection.execute('INSERT INTO db_scan_originals VALUES(?,?,?,?,?)',(id,original['name'],content,hashlib.sha256(content).hexdigest(),len(content)))


def _validate(kind,id,value,deleted):
    if deleted:
        if value is not None:
            raise DatabaseError('删除墓碑的 value 必须为 null')
        return
    if kind=='simulation_settings':
        if not isinstance(value,dict) or set(value)!={'projectId','sourceKind','options'} or value.get('projectId')!=id or value.get('sourceKind')!='simulation':
            raise DatabaseError('仿真设置必须明确当前项目和 simulation 来源')
        options=value['options'];ranges={'peakWidthKHz':(5,1000,1),'floorDbm':(-120,-40,1),'rippleDb':(0,10,0.5),
            'textureStepKHz':(0.5,100,0.5),'thresholdDbm':(-110,-30,1),'imdSuppressionDb':(5,100,1)}
        flags={'includeImd','includeFifth','includeThreeTone'}
        if not isinstance(options,dict) or set(options)!=(set(ranges)|flags):raise DatabaseError('仿真参数字段不完整')
        for key,(low,high,step) in ranges.items():
            number=options[key]
            if type(number) not in (int,float) or not math.isfinite(number) or not low<=number<=high or number/step!=int(number/step):
                raise DatabaseError('仿真参数超出原界面范围或步进：'+key)
        if any(type(options[key]) is not bool for key in flags):raise DatabaseError('仿真互调开关必须是布尔值')
        if not options['includeImd'] and (options['includeFifth'] or options['includeThreeTone']):raise DatabaseError('关闭互调时不能选择互调阶次')
    elif kind=='project_metadata':
        if not isinstance(value,dict) or value.get('id')!=id:
            raise DatabaseError('项目 ID 必须与文档 ID 一致')
        _text(value.get('name'),'项目名称',256)
    elif kind=='manual_devices':
        if not isinstance(value,dict) or value.get('id')!=id or value.get('source')!='manual':
            raise DatabaseError('人工设备需明确 ID 和 manual 来源')
        allowed={'id','source','brand','model','name','configuredFrequencyKHz','configuredChannelNumber','configuredIp','notes','provenance'}
        if set(value)-allowed:raise DatabaseError('人工设备不能写入实时身份、在线、静音或 ACK 状态')
        _text(value.get('brand'),'人工设备品牌')
        for field in ('model','name'):
            if value.get(field) is not None:_text(value[field],field,256)
        if value.get('configuredFrequencyKHz') is not None:_int(value['configuredFrequencyKHz'],'人工设定频率',30000,3000000)
        if value.get('configuredChannelNumber') is not None:_int(value['configuredChannelNumber'],'人工登记CH',1,10000)
        if value.get('configuredIp') not in (None,''):
            if not isinstance(value['configuredIp'],str) or '%' in value['configuredIp']:raise DatabaseError('人工登记 IP 无效')
            try:ipaddress.ip_address(value['configuredIp'])
            except ValueError as error:raise DatabaseError('人工登记 IP 无效') from error
    elif kind=='legacy_snapshots':
        if not isinstance(value,dict) or set(value)!={'sourceOrigin','sourceKey','payload'}:
            raise DatabaseError('旧数据快照需包含明确来源、键和原始业务内容')
        _text(value['sourceOrigin'],'旧数据来源');_text(value['sourceKey'],'旧数据键')
        # This is an archived source, never trusted telemetry or a control target.
        unified_domains._clone(value['payload'])
    elif kind=='scans':
        _validate_scan(value)
    elif kind=='scan_current':
        if not isinstance(value,dict) or set(value)!={'projectId','scanId'} or value.get('projectId')!=id:
            raise DatabaseError('当前扫描需含明确 projectId/scanId，项目标识须一致')
        _text(value['scanId'],'当前扫描标识')
    elif kind=='planning_runs':
        if not isinstance(value,dict) or not isinstance(value.get('input'),dict) or not isinstance(value.get('result'),dict):
            raise DatabaseError('规划运行需包含完整 input/result')
        _text(value.get('projectId'),'运行项目')
        for field in ('scanId','engineVersion'):
            if value.get(field) is not None:_text(value[field],field)
        if value.get('purpose','coordination-history') not in ('coordination-history','simulation-study'):
            raise DatabaseError('运行用途必须区分规划历史与仿真研究')
        refs=value.get('profileRefs',[])
        if not isinstance(refs,list) or len(refs)>1000:
            raise DatabaseError('Profile 引用列表无效')
        seen=set()
        for ref in refs:
            if not isinstance(ref,dict) or set(ref)!={'id','revision'}:
                raise DatabaseError('Profile 引用须含明确 id/revision')
            key=(_text(ref['id'],'Profile ID'),_int(ref['revision'],'Profile版本',1))
            if key in seen:raise DatabaseError('Profile 引用不能重复')
            seen.add(key)
    else:
        unified_domains.validate_document(kind,id,value,deleted=deleted)


def check_scan_input_evidence(connection,value,*,epoch=None):
    """Check captured computation evidence in the SAME transaction as the run.

    A preceding client's GET is not CAS protection. Historical recovery keeps
    the original evidence epoch; only creation compares it with the live epoch.
    This links inputs, not a server recomputation or hardware certification.
    """
    evidence=value.get('inputEvidence')
    if evidence is None:return
    if not isinstance(evidence,dict) or evidence.get('protocol')!='daty-planning-input-evidence-v1':
        raise DatabaseError('规划输入证据格式无效')
    proof=evidence.get('scan')
    if proof is None:
        if value.get('scanId') is not None:
            raise DatabaseError('运行扫描引用与输入证据不一致',status=409,code='SCAN_EVIDENCE_CONFLICT')
        return
    if not isinstance(proof,dict) or set(proof)!={'id','revision','epoch'}:
        raise DatabaseError('扫描输入证据须含精确 id/revision/epoch')
    _text(proof['id'],'扫描输入标识');_int(proof['revision'],'扫描输入版本',1);_text(proof['epoch'],'扫描输入代次')
    scan=_resource(connection,'scans',proof['id'])
    options=value['result'].get('options')
    points=options.get('scanPoints') if isinstance(options,dict) else None
    if (value.get('scanId')!=proof['id'] or evidence.get('scanUse')!='used'
        or epoch is not None and proof['epoch']!=epoch or not scan or scan['deleted']
        or scan['revision']!=proof['revision'] or scan['value']['projectId']!=value['projectId']
        or not isinstance(points,list) or _digest(points)!=_digest(scan['value']['points'])):
        raise DatabaseError('扫描输入在计算后发生变化，运行未保存；请重新核对规划',status=409,code='SCAN_EVIDENCE_CONFLICT')


def put_resource(connection,body,actor,now_ms,*,_batch_child=False):
    if isinstance(body,dict):data_retirement.check_resource(body.get("kind"),body.get("value"))
    """Validate/CAS/project/audit/receipt as ONE caller-owned transaction."""
    if not isinstance(body,dict):
        raise DatabaseError('写入请求须是对象')
    if set(body)-{'operation_id','epoch','kind','id','expected_revision','value','deleted'}:
        raise DatabaseError('写入请求含未知控制字段')
    _int(now_ms,'服务器时间')
    operation_id=body.get('operation_id')
    if not isinstance(operation_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}',operation_id):
        raise DatabaseError('operation_id 必须是 16 至 80 位稳定操作标识')
    if operation_id.startswith('batch_') and not _batch_child:
        raise DatabaseError('批量子操作标识由服务器保留',status=409,code='RESERVED_OPERATION_ID')
    kind,id=body.get('kind'),_text(body.get('id'),'业务标识')
    if kind not in KINDS:
        raise DatabaseError('未知业务域')
    if 'expected_revision' not in body:
        raise DatabaseError('需要明确 expected_revision',code='REVISION_REQUIRED',status=428)
    expected=_int(body['expected_revision'],'预期版本',0,MAX_REVISION-1)
    deleted=body.get('deleted',False)
    if type(deleted) is not bool:
        raise DatabaseError('deleted 必须为布尔值')
    if not isinstance(actor,dict):
        raise DatabaseError('缺少已验证操作者',status=403)
    public_actor={k:actor[k] for k in ('id','name','role','kind','authenticated','ip') if k in actor}
    actor_id=_text(public_actor.get('id'),'操作者');_safe_json(public_actor)
    value=body.get('value');value_json=_safe_json(value)
    normalized={**body,'deleted':deleted,'value':value}
    request_digest=_digest(normalized)
    _begin(connection)
    meta=status(connection)
    if body.get('epoch')!=meta['epoch']:
        raise DatabaseError('数据库代次已变化，请重新核对，未写入',status=409,code='DATABASE_EPOCH_CHANGED')
    if connection.execute('SELECT 1 FROM db_batches WHERE operation_id=?',(operation_id,)).fetchone():
        raise DatabaseError('操作标识已用于批量事务',status=409,code='OPERATION_ID_CONFLICT')
    prior=connection.execute('SELECT request_digest,actor_id FROM db_operations WHERE operation_id=?',(operation_id,)).fetchone()
    if prior:
        if prior[0]!=request_digest or prior[1]!=actor_id:
            raise DatabaseError('操作标识已用于另一笔请求',status=409,code='OPERATION_ID_CONFLICT')
        receipt=get_operation(connection,operation_id,actor_id)
        return {'success':True,**meta,'operation_id':operation_id,'resource':receipt['resource'],'replayed_receipt':True}
    _validate(kind,id,value,deleted)
    current=connection.execute('SELECT revision FROM db_resources WHERE kind=? AND id=?',(kind,id)).fetchone()
    if (current[0] if current else 0)!=expected:
        raise DatabaseError('业务版本冲突，当前数据未被覆盖',status=409,code='RESOURCE_REVISION_CONFLICT')
    revision=expected+1
    if kind=='profiles':
        old=_resource(connection,kind,id) if current else None
        if old and not old['deleted'] and old['value'].get('source')=='planning-snapshot':
            raise DatabaseError('规划使用的 Profile 快照不可改写或删除',status=409,code='IMMUTABLE_PROFILE_SNAPSHOT')
        if not deleted and (id.startswith('run-profile:')!=(value.get('source')=='planning-snapshot')):
            raise DatabaseError('规划 Profile 快照须使用专用标识与明确来源')
    if kind=='simulation_settings':
        if deleted:
            if not current:raise DatabaseError('仿真设置不存在',status=404)
            connection.execute('UPDATE db_simulation_settings SET revision=?,deleted=1 WHERE id=?',(revision,id))
        else:
            options=value['options']
            fields=['peakWidthKHz','floorDbm','rippleDb','textureStepKHz','thresholdDbm','imdSuppressionDb','includeImd','includeFifth','includeThreeTone']
            connection.execute('INSERT INTO db_simulation_settings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET '
                'peak_width_khz=excluded.peak_width_khz,floor_dbm=excluded.floor_dbm,ripple_db=excluded.ripple_db,texture_step_khz=excluded.texture_step_khz,'
                'threshold_dbm=excluded.threshold_dbm,imd_suppression_db=excluded.imd_suppression_db,include_imd=excluded.include_imd,'
                'include_fifth=excluded.include_fifth,include_three_tone=excluded.include_three_tone,revision=excluded.revision,deleted=0,metadata_json=excluded.metadata_json',
                (id,value['projectId'],*[options[field] for field in fields],revision,value_json))
    elif kind=='project_metadata':
        if deleted:
            raise DatabaseError('项目关联历史不能在通用接口删除，请保留历史',status=409)
        connection.execute('INSERT OR IGNORE INTO projects(id,name,project_json,created_at,updated_at) VALUES(?,?,?,?,?)',
            (id,value['name'],'{}',now_ms/1000,now_ms/1000))
        connection.execute('INSERT INTO db_project_metadata VALUES(?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET '
            'name=excluded.name,revision=excluded.revision,deleted=0,metadata_json=excluded.metadata_json',
            (id,value['name'],revision,value_json))
    elif kind=='manual_devices':
        if deleted:
            if not current:raise DatabaseError('人工设备不存在',status=404)
            connection.execute('UPDATE db_manual_devices SET revision=?,deleted=1 WHERE id=?',(revision,id))
        else:
            connection.execute('INSERT INTO db_manual_devices VALUES(?,?,?,?,?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET '
                'brand=excluded.brand,model=excluded.model,name=excluded.name,configured_frequency_khz=excluded.configured_frequency_khz,'
                'configured_channel_number=excluded.configured_channel_number,configured_ip=excluded.configured_ip,'
                'revision=excluded.revision,deleted=0,metadata_json=excluded.metadata_json',
                (id,value['brand'],value.get('model'),value.get('name'),value.get('configuredFrequencyKHz'),value.get('configuredChannelNumber'),value.get('configuredIp'),revision,value_json))
    elif kind=='legacy_snapshots':
        if current or deleted:raise DatabaseError('旧数据来源快照只读、不可改写或删除',status=409,code='IMMUTABLE_LEGACY_SOURCE')
        payload_json=_safe_json(value['payload'])
        connection.execute('INSERT INTO db_legacy_snapshots VALUES(?,?,?,?,?,1)',
            (id,value['sourceOrigin'],value['sourceKey'],payload_json,hashlib.sha256(payload_json.encode()).hexdigest()))
    elif kind=='scans':
        _project_scan(connection,id,value,revision,deleted)
    elif kind=='scan_current':
        if deleted:
            connection.execute('DELETE FROM db_scan_current WHERE id=?',(id,))
        else:
            scan=connection.execute('SELECT project_id,source_kind FROM db_scans WHERE id=?',(value['scanId'],)).fetchone()
            if not scan or scan[0]!=id:
                raise DatabaseError('当前扫描必须引用同项目已保存的扫描',status=409,code='SCAN_REFERENCE_CONFLICT')
            if scan[1]=='simulation':
                raise DatabaseError('仿真不能作为当前真实扫描',status=409,code='SIMULATION_NOT_MEASUREMENT')
            connection.execute('INSERT INTO db_scan_current VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET scan_id=excluded.scan_id,revision=excluded.revision',
                (id,value['scanId'],revision))
    elif kind=='planning_runs':
        if current:
            raise DatabaseError('已保存的规划运行不可覆盖或删除',status=409,code='IMMUTABLE_RUN')
        if deleted:
            raise DatabaseError('不能删除不存在的规划运行')
        check_scan_input_evidence(connection,value,epoch=meta['epoch'])
        if value.get('scanId'):
            scan=connection.execute('SELECT project_id,source_kind FROM db_scans WHERE id=?',(value['scanId'],)).fetchone()
            if not scan or scan[0]!=value['projectId']:
                raise DatabaseError('运行必须引用同项目已保存的扫描',status=409,code='SCAN_REFERENCE_CONFLICT')
            if scan[1]=='simulation' and value.get('purpose')!='simulation-study':
                raise DatabaseError('仿真扫描不能当成实测规划输入',status=409,code='SIMULATION_NOT_MEASUREMENT')
        for ref in value.get('profileRefs',[]):
            available=connection.execute("SELECT deleted FROM db_resource_versions WHERE kind='profiles' AND id=? AND revision=?",(ref['id'],ref['revision'])).fetchone()
            if available is None or available[0]:
                raise DatabaseError('Profile 引用版本缺失或已删除',status=409,code='PROFILE_REFERENCE_CONFLICT')
            profile=_resource(connection,'profiles',ref['id'],ref['revision'])
            if profile is None or profile['deleted']:
                raise DatabaseError('Profile 引用版本缺失或已删除',status=409,code='PROFILE_REFERENCE_CONFLICT')
        connection.execute('INSERT INTO db_planning_runs VALUES(?,?,?,?,?,?,?,?)',(id,value['projectId'],_safe_json(value['input']),
            _safe_json(value['result']),value.get('engineVersion'),value.get('scanId'),_safe_json(value.get('profileRefs',[])),revision))
    else:
        unified_domains.project_document(connection,kind,id,{} if deleted else value,revision,deleted=deleted)
    # A project tombstone must change the generic immutable history as well as
    # the normalized projection. Historical operation receipts stay unchanged;
    # list cursors before this transaction still see their old snapshot.
    if kind=='planning_current' and not deleted:
        for record_id in value['deletedRecordIds']:
            prior_record=_resource(connection,'planning_records',record_id)
            if prior_record and not prior_record['deleted']:
                child_revision=prior_record['revision']+1
                if child_revision>MAX_REVISION:
                    raise DatabaseError('规划历史版本已耗尽',status=409)
                connection.execute('UPDATE biz_planning_records SET revision=? WHERE id=?',(child_revision,record_id))
                derived='derived:'+hashlib.sha256((operation_id+'\0'+record_id).encode()).hexdigest()
                _write_version(connection,'planning_records',record_id,child_revision,None,True,derived,public_actor,now_ms)
    _write_version(connection,kind,id,revision,value,deleted,operation_id,public_actor,now_ms)
    connection.execute('INSERT INTO db_operations VALUES(?,?,?,?,?,?,?,?)',(operation_id,meta['epoch'],request_digest,actor_id,kind,id,revision,now_ms))
    return {'success':True,**meta,'operation_id':operation_id,'resource':_resource(connection,kind,id,revision)}


def _write_version(connection,kind,id,revision,value,deleted,operation_id,public_actor,now_ms):
    value_json=_safe_json(value)
    connection.execute('INSERT INTO db_resources VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision',(kind,id,revision))
    event=connection.execute('INSERT INTO db_audit(operation_id,kind,resource_id,revision,actor_json,occurred_at_ms) VALUES(?,?,?,?,?,?)',
        (operation_id,kind,id,revision,_safe_json(public_actor),now_ms)).lastrowid
    connection.execute('INSERT INTO db_resource_versions VALUES(?,?,?,?,?,?,?)',(kind,id,revision,value_json,int(deleted),hashlib.sha256(value_json.encode()).hexdigest(),event))


def put_batch(connection,body,actor,now_ms):
    """One durable operation for an ordered, CAS-protected set of resources.

    Callers put new history before current selection, and clear selection before
    deleting history. Any validation/CAS failure rolls back every item. Replaying
    the exact operation only retrieves a receipt; it never repeats side effects.
    No device commands are accepted here.
    """
    if not isinstance(body,dict) or set(body)!={'operation_id','epoch','writes'}:
        raise DatabaseError('批量事务必须含 operation_id/epoch/writes')
    operation_id=body['operation_id']
    if not isinstance(operation_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}',operation_id):
        raise DatabaseError('批量操作标识无效')
    if operation_id.startswith('batch_'):
        raise DatabaseError('批量子操作标识由服务器保留',status=409,code='RESERVED_OPERATION_ID')
    writes=body['writes']
    if not isinstance(writes,list) or not 1<=len(writes)<=1000:
        raise DatabaseError('一次事务需包含 1 至 1000 项业务变更')
    _int(now_ms,'服务器时间')
    if not isinstance(actor,dict):
        raise DatabaseError('缺少已验证操作者',status=403)
    actor_id=_text(actor.get('id'),'操作者')
    request_digest=_digest(body);seen=set()
    for item in writes:
        if not isinstance(item,dict) or set(item)-{'kind','id','expected_revision','value','deleted'}:
            raise DatabaseError('批量变更包含无效控制字段')
        target=(item.get('kind'),_text(item.get('id'),'业务标识'))
        if target[0] not in KINDS or target in seen:
            raise DatabaseError('批量事务不能重复写同一目标或使用未知业务域')
        seen.add(target)
    _begin(connection);meta=status(connection)
    if body['epoch']!=meta['epoch']:
        raise DatabaseError('数据库代次已变化，批量未写入',status=409,code='DATABASE_EPOCH_CHANGED')
    if connection.execute('SELECT 1 FROM db_operations WHERE operation_id=?',(operation_id,)).fetchone():
        raise DatabaseError('操作标识已用于单项事务',status=409,code='OPERATION_ID_CONFLICT')
    prior=connection.execute('SELECT request_digest,actor_id FROM db_batches WHERE operation_id=?',(operation_id,)).fetchone()
    if prior:
        if tuple(prior)!=(request_digest,actor_id):
            raise DatabaseError('批量操作标识已用于另一请求',status=409,code='OPERATION_ID_CONFLICT')
        return {'success':True,**meta,**get_operation(connection,operation_id,actor_id),'replayed_receipt':True}
    # Persistent receipt is committed only when all projections have succeeded.
    connection.execute('INSERT INTO db_batches VALUES(?,?,?,?,?)',(operation_id,meta['epoch'],request_digest,actor_id,now_ms))
    resources=[]
    for ordinal,item in enumerate(writes):
        child_id='batch_'+hashlib.sha256((operation_id+'\0'+str(ordinal)).encode()).hexdigest()
        receipt=put_resource(connection,{**item,'operation_id':child_id,'epoch':meta['epoch']},actor,now_ms,_batch_child=True)
        resources.append(receipt['resource'])
        connection.execute('INSERT INTO db_batch_items VALUES(?,?,?)',(operation_id,ordinal,child_id))
    # A later item can produce a dependent tombstone; returning that batch's
    # final version is required for clients to establish a correct baseline.
    for item,resource in zip(writes,resources):
        if _resource(connection,item['kind'],item['id'])!=resource:
            raise DatabaseError('同批依赖变更再次修改目标，请拆分该操作意图',status=409,code='BATCH_DEPENDENT_WRITE')
    return {'success':True,**meta,'operation_id':operation_id,'resources':resources}


def list_resources(connection,kind,limit=100,cursor=None,*,since=None,since_epoch=None,project_id=None):
    """Snapshot keysets; changes include tombstones, never a moving current head."""
    if kind not in KINDS:
        raise DatabaseError('未知业务域')
    _int(limit,'每页条数',1,200)
    meta=status(connection);last=''
    maximum=connection.execute('SELECT COALESCE(MAX(seq),0) FROM db_audit').fetchone()[0]
    upper=maximum
    if since is not None:
        if since_epoch!=meta['epoch']:
            raise DatabaseError('增量读取数据库代次已变化',status=409,code='EPOCH_CHANGED')
        _int(since,'增量版本',0,maximum)
    elif since_epoch is not None:
        raise DatabaseError('增量代次需要起始版本')
    if project_id is not None:
        _text(project_id,'项目标识')
        if kind!='planning_records':
            raise DatabaseError('项目筛选仅支持规划历史')
    filters={'since':since,'since_epoch':since_epoch,'project_id':project_id}
    if cursor:
        try:
            if not isinstance(cursor,str) or len(cursor)>4096:
                raise ValueError()
            state=json.loads(base64.urlsafe_b64decode(cursor.encode()))
            if (set(state)!={'epoch','kind','after','upper',*filters}
                    or state['kind']!=kind or state['epoch']!=meta['epoch']
                    or any(state[k]!=v for k,v in filters.items())):
                raise ValueError()
            last=state['after'];_text(last,'分页标识');upper=_int(state['upper'],'分页版本',0,maximum)
            if since is not None and since>upper:
                raise ValueError()
        except (ValueError,TypeError,KeyError,UnicodeError) as error:
            raise DatabaseError('分页游标无效或数据库已变化',status=409,code='INVALID_CURSOR') from error
    if since is not None:
        # The audit index visits only changes since the last completed snapshot.
        candidates='SELECT DISTINCT id FROM db_resource_versions INDEXED BY idx_db_versions_history WHERE kind=? AND audit_seq>? AND audit_seq<=? AND id>?'
        args=[kind,since,upper,last]
    elif project_id is not None:
        # Historical ownership, not today's mutable normalized projection.
        candidates="SELECT DISTINCT id FROM db_resource_versions WHERE kind='planning_records' AND json_extract(value_json,'$.projectId')=? AND id>? AND audit_seq<=?"
        args=[project_id,last,upper]
    else:
        candidates='SELECT id FROM db_resources WHERE kind=? AND id>?'
        args=[kind,last]
    # Keep candidate IDs as the outer loop. Reordering this join can inspect
    # every historical version even when the page contains only 200 heads.
    sql='SELECT v.id,v.revision FROM ('+candidates+""") h CROSS JOIN db_resource_versions v
        ON v.kind=? AND v.id=h.id AND v.audit_seq=(SELECT s.audit_seq FROM db_resource_versions s
            WHERE s.kind=? AND s.id=h.id AND s.audit_seq<=? ORDER BY s.audit_seq DESC LIMIT 1)"""
    args.extend([kind,kind,upper])
    if project_id is not None:
        # Deleted versions contain JSON null. Attribute their tombstone to the
        # last live owner at this same high-water mark, including old snapshots.
        sql+=""" WHERE (CASE WHEN v.deleted=0 THEN json_extract(v.value_json,'$.projectId')
            ELSE (SELECT json_extract(p.value_json,'$.projectId') FROM db_resource_versions p
                WHERE p.kind=v.kind AND p.id=v.id AND p.audit_seq<=? AND p.deleted=0
                ORDER BY p.audit_seq DESC LIMIT 1) END)=?"""
        args.extend([upper,project_id])
    sql+=' ORDER BY h.id LIMIT ?';args.append(limit+1)
    rows=connection.execute(sql,args).fetchall()
    result=[_resource(connection,kind,r[0],r[1]) for r in rows[:limit]]
    next_cursor=None
    if len(rows)>limit:
        next_cursor=base64.urlsafe_b64encode(_safe_json({'epoch':meta['epoch'],'kind':kind,'after':rows[limit-1][0],'upper':upper,**filters}).encode()).decode()
    return {'success':True,**meta,'resources':result,'next_cursor':next_cursor,'as_of':upper,
            'since':since,'project_id':project_id}


def rotate_recovery_epoch(connection,expected_epoch,new_epoch):
    """Offline restore activation ONLY; not exposed through HTTP or startup.

    The maintenance owner must stop clients/writers, verify restored data, and
    call this BEFORE serving it. Merely copying this epoch in a backup is unsafe.
    """
    _begin(connection);_text(new_epoch,'新恢复代次')
    if new_epoch==expected_epoch or status(connection)['epoch']!=expected_epoch:
        raise DatabaseError('恢复代次条件不匹配',status=409,code='DATABASE_EPOCH_CHANGED')
    connection.execute('UPDATE db_identity SET epoch=? WHERE singleton=1',(new_epoch,))
    return status(connection)
