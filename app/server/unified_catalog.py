"""Bounded, read-only business catalogs over existing normalized projections.

No schema migration, telemetry scan, JSON document load, or write side effects.
Pagination is invalidated by a change in the selected domain, so a catalog never
mixes revisions. The caller owns the read transaction, as for other M4 reads.
"""
import base64
import json
import unified_database as db

# Table/column expressions are constants; request text is always a bound value.
DOMAINS = {
    'device_overrides': ('biz_device_overrides', 'id', None, ('alias','receiver_id','channel_number')),
    'manual_devices': ('db_manual_devices', 'id', None, ('name','brand','model','configured_channel_number','configured_frequency_khz')),
    'scans': ('db_scans', 'id', 'project_id', ('name','source_kind','point_count','min_khz','max_khz')),
    'simulation_settings': ('db_simulation_settings', 'id', 'project_id', ('floor_dbm','threshold_dbm')),
    'scan_current': ('db_scan_current', 'id', 'id', ('scan_id',)),
    'profiles': ('biz_profiles', 'id', None, ('manufacturer','start_khz','end_khz','source')),
    'planning_runs': ('db_planning_runs', 'id', 'project_id', ('engine_version','scan_id')),
    'planning_current': ('biz_planning_current', 'project_id', 'project_id', ('current_record_id',)),
    'settings': ('biz_settings', 'id', None, ('setting_type','rf_weak_dbm','battery_low_percent','af_overload_dbfs','enabled')),
    'preferences': ('biz_preferences', 'id', None, ()),
    'plugins': ('biz_plugins', 'id', None, ('status','installed')),
}
PROTOCOL = 'daty-business-catalog-v1'


def list_catalog(connection, kind, *, limit=20, cursor=None, project_id=None):
    if not isinstance(kind, str) or kind not in DOMAINS:
        raise db.DatabaseError('不支持的数据目录')
    db._int(limit, '目录分页大小', 1, 50)
    table, key, project_column, columns = DOMAINS[kind]
    if project_column:
        db._text(project_id, '目录项目标识')
        if not connection.execute('SELECT 1 FROM projects WHERE id=?', (project_id,)).fetchone():
            raise db.DatabaseError('项目不存在', status=404)
    elif project_id is not None:
        raise db.DatabaseError('全局目录不接受项目筛选')
    meta = db.status(connection)
    upper = connection.execute('SELECT COALESCE(MAX(audit_seq),0) FROM db_resource_versions WHERE kind=?', (kind,)).fetchone()[0]
    identity = {'protocol': PROTOCOL, 'epoch': meta['epoch'], 'kind': kind, 'project_id': project_id, 'as_of': upper}
    after = ''
    if cursor is not None:
        try:
            if not isinstance(cursor, str) or not 1 <= len(cursor) <= 4096:
                raise ValueError()
            state = json.loads(base64.b64decode(cursor.encode('ascii'), altchars=b'-_', validate=True))
            if not isinstance(state, dict) or set(state) != {*identity, 'after'} or any(state[k] != v for k, v in identity.items()):
                raise ValueError()
            after = db._text(state['after'], '分页位置')
        except (ValueError, TypeError, KeyError, UnicodeError) as error:
            raise db.DatabaseError('目录已变化或游标无效，请刷新列表', status=409, code='CATALOG_CHANGED') from error
    selection = ','.join('p.' + name for name in columns)
    sql = f'''SELECT h.id,h.revision,v.digest,a.occurred_at_ms{',' + selection if selection else ''}
        FROM db_resources h CROSS JOIN db_resource_versions v
          ON v.kind=h.kind AND v.id=h.id AND v.revision=h.revision
        JOIN {table} p ON p.{key}=h.id AND p.revision=h.revision
        JOIN db_audit a ON a.seq=v.audit_seq
        WHERE h.kind=? AND h.id>? AND v.deleted=0'''
    args = [kind, after]
    if project_column:
        sql += f' AND p.{project_column}=?'
        args.append(project_id)
    sql += ' ORDER BY h.id LIMIT ?'
    args.append(limit + 1)
    rows = connection.execute(sql, args).fetchall()
    items = [{'kind': kind, 'id': r[0], 'revision': r[1], 'digest': r[2], 'saved_at_ms': r[3],
              'project_id': project_id, 'summary': dict(zip(columns, r[4:]))} for r in rows[:limit]]
    next_cursor = None
    if len(rows) > limit:
        next_cursor = base64.urlsafe_b64encode(json.dumps({**identity, 'after': rows[limit-1][0]}, separators=(',', ':')).encode()).decode()
    return {'success': True, **meta, 'catalog_protocol': PROTOCOL, 'kind': kind, 'project_id': project_id,
            'as_of': upper, 'items': items, 'next_cursor': next_cursor}
