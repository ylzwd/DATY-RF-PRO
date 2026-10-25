"""Read-only business-version/projection consistency audit for CLOSED copies.

No source rows are returned or logged. A small in-memory domain projection is
rebuilt one document at a time using the production candidate validator, so
derived DATY spacing/grid values are not confused with missing original fields.
The caller supplies a budget callback and owns the stable read snapshot.
"""
import hashlib
import json
import sqlite3

import unified_domains as domains
from unified_schema import validate_schema


class ConsistencyError(ValueError):
    def __init__(self, code, *, kind=None, identifier=None, field=None):
        super().__init__('Business consistency check failed: ' + code)
        self.code, self.kind, self.identifier, self.field = code, kind, identifier, field


def _fail(code, kind=None, identifier=None, field=None):
    raise ConsistencyError(code, kind=kind, identifier=identifier, field=field)


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':'))


def _dict(row, cursor):
    return dict(zip((field[0] for field in cursor.description), row))


def _one(connection, sql, params=()):
    cursor = connection.execute(sql, params)
    row = cursor.fetchone()
    return _dict(row, cursor) if row is not None else None


_DOMAIN_TABLES = {
    'settings': [('biz_settings', 'id')],
    'profiles': [('biz_profiles', 'id'), ('biz_profile_models', 'profile_id'),
                 ('biz_profile_bands', 'profile_id'), ('biz_profile_modes', 'profile_id')],
    'planning_records': [('biz_planning_records', 'id'), ('biz_planning_channels', 'record_id'),
                         ('biz_planning_constraints', 'record_id'), ('biz_planning_backups', 'record_id')],
    'planning_current': [('biz_planning_current', 'project_id')],
    'alerts': [('biz_alerts', 'id')],
    'device_overrides': [('biz_device_overrides', 'id')],
    'preferences': [('biz_preferences', 'id'), ('biz_preference_values', 'preference_id')],
    'plugins': [('biz_plugins', 'id')],
}
_CORE_TABLES = {kind: 'db_' + kind for kind in ('project_metadata', 'manual_devices',
    'legacy_snapshots', 'simulation_settings', 'scan_current', 'scans', 'planning_runs')}


def _project_exists(connection, project, kind, identifier):
    if not connection.execute('SELECT 1 FROM projects WHERE id=?', (project,)).fetchone():
        _fail('MISSING_PROJECT_REFERENCE', kind, identifier)


def _core_document(database, kind, identifier, revision, value, deleted):
    if kind in ('legacy_snapshots', 'planning_runs') and (deleted or revision != 1):
        _fail('IMMUTABLE_CORE_VERSION_INVALID', kind, identifier)
    if kind == 'project_metadata' and deleted:
        _fail('IMMUTABLE_PROJECT_DELETED', kind, identifier)
    try:
        database._safe_json(value)
        database._validate(kind, identifier, value, bool(deleted))
    except (database.DatabaseError, domains.DomainError, TypeError, KeyError) as error:
        raise ConsistencyError('CORE_DOCUMENT_INVALID', kind=kind, identifier=identifier) from error


def _scan_reference(connection, scan_id, project, kind, identifier, *, simulation=False):
    row = _one(connection, '''SELECT s.project_id,s.source_kind,v.deleted
        FROM db_scans s JOIN db_resources r ON r.kind='scans' AND r.id=s.id
        JOIN db_resource_versions v ON v.kind=r.kind AND v.id=r.id AND v.revision=r.revision
        WHERE s.id=?''', (scan_id,))
    if row is None or row['deleted'] or row['project_id'] != project:
        _fail('SCAN_REFERENCE_CONFLICT', kind, identifier)
    if row['source_kind'] == 'simulation' and not simulation:
        _fail('SIMULATION_NOT_MEASUREMENT', kind, identifier)


def _core_projection(connection, kind, identifier, revision, value, deleted):
    table = _CORE_TABLES[kind]
    row = _one(connection, 'SELECT * FROM ' + table + ' WHERE id=?', (identifier,))
    if kind == 'scan_current':
        if deleted:
            if row is not None:
                _fail('DELETED_SCAN_POINTER_HAS_PROJECTION', kind, identifier)
            return
        _project_exists(connection, identifier, kind, identifier)
        _scan_reference(connection, value['scanId'], identifier, kind, identifier)
        expected = {'id':identifier, 'scan_id':value['scanId'], 'revision':revision}
    else:
        if deleted:
            prior = connection.execute('''SELECT value_json FROM db_resource_versions
                WHERE kind=? AND id=? AND deleted=0 AND revision<? ORDER BY revision DESC LIMIT 1''',
                (kind, identifier, revision)).fetchone()
            if prior is None:
                _fail('DELETED_CORE_HAS_NO_HISTORY', kind, identifier)
            value = json.loads(prior[0])
        metadata = _json(value)
        expected = {'id':identifier, 'revision':revision, 'deleted':int(deleted), 'metadata_json':metadata}
        if kind == 'project_metadata':
            # Legacy projects.project_json/name remain source history. Only the
            # normalized metadata document is current; do not rewrite history.
            _project_exists(connection, identifier, kind, identifier)
            expected['name'] = value['name']
        elif kind == 'manual_devices':
            expected.update(brand=value['brand'], model=value.get('model'), name=value.get('name'),
                configured_frequency_khz=value.get('configuredFrequencyKHz'),
                configured_channel_number=value.get('configuredChannelNumber'), configured_ip=value.get('configuredIp'))
        elif kind == 'legacy_snapshots':
            payload = _json(value['payload'])
            expected = {'id':identifier, 'source_origin':value['sourceOrigin'], 'source_key':value['sourceKey'],
                'payload_json':payload, 'payload_sha256':hashlib.sha256(payload.encode('utf-8')).hexdigest(), 'revision':1}
        elif kind == 'simulation_settings':
            _project_exists(connection, value['projectId'], kind, identifier)
            expected['project_id'] = value['projectId']
            names = {'peak_width_khz':'peakWidthKHz', 'floor_dbm':'floorDbm', 'ripple_db':'rippleDb',
                'texture_step_khz':'textureStepKHz', 'threshold_dbm':'thresholdDbm',
                'imd_suppression_db':'imdSuppressionDb', 'include_imd':'includeImd',
                'include_fifth':'includeFifth', 'include_three_tone':'includeThreeTone'}
            expected.update({column:value['options'][field] for column,field in names.items()})
    if row != expected:
        _fail('CORE_PROJECTION_MISMATCH', kind, identifier, table)


def _rows(connection, table, key, identifier):
    info = connection.execute('PRAGMA table_info(' + table + ')').fetchall()
    primary = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
    return connection.execute('SELECT * FROM ' + table + ' WHERE ' + key + '=? ORDER BY '
                              + ','.join(primary), (identifier,))


def _domain_projection(connection, kind, identifier, revision, value, deleted, check):
    if deleted:
        old = connection.execute('''SELECT value_json FROM db_resource_versions WHERE kind=? AND id=?
          AND deleted=0 AND revision<? ORDER BY revision DESC LIMIT 1''', (kind, identifier, revision)).fetchone()
        if old is None:
            _fail('DELETED_DOMAIN_HAS_NO_HISTORY', kind, identifier)
        value = json.loads(old[0])
    expected = sqlite3.connect(':memory:')
    try:
        expected.execute('PRAGMA foreign_keys=ON')
        expected.execute('CREATE TABLE projects(id TEXT PRIMARY KEY)')
        for statement in domains.schema_statements():
            expected.execute(statement)
        expected.execute('BEGIN')
        if value.get('projectId') is not None:
            expected.execute('INSERT INTO projects VALUES(?)', (value['projectId'],))
        if kind == 'planning_current' and value.get('currentRecordId') is not None:
            expected.execute('INSERT INTO biz_planning_records VALUES(?,?,?,?,?,?,?)',
                (value['currentRecordId'], value['projectId'], 0, 0, 1, 0, '{}'))
        domains.project_document(expected, kind, identifier, value, revision)
        main_table, main_key = _DOMAIN_TABLES[kind][0]
        if deleted:
            expected.execute('UPDATE ' + main_table + ' SET deleted=1 WHERE ' + main_key + '=?', (identifier,))
        for table, key in _DOMAIN_TABLES[kind]:
            actual_rows = iter(_rows(connection, table, key, identifier))
            for row in _rows(expected, table, key, identifier):
                check()
                actual = next(actual_rows, None)
                if actual is None or tuple(actual) != tuple(row):
                    _fail('DOMAIN_PROJECTION_MISMATCH', kind, identifier, table)
            if next(actual_rows, None) is not None:
                _fail('EXTRA_DOMAIN_PROJECTION_ROW', kind, identifier, table)
    except domains.DomainError as error:
        raise ConsistencyError('DOMAIN_DOCUMENT_INVALID', kind=kind, identifier=identifier) from error
    finally:
        expected.close()


def _scan_projection(connection, identifier, revision, value, deleted, check):
    scan = _one(connection, 'SELECT * FROM db_scans WHERE id=?', (identifier,))
    if deleted:
        if scan is not None or connection.execute('''SELECT 1 FROM db_scan_points WHERE scan_id=?
                UNION ALL SELECT 1 FROM db_scan_originals WHERE scan_id=?''', (identifier, identifier)).fetchone():
            _fail('DELETED_SCAN_HAS_PROJECTION', 'scans', identifier)
        return
    if scan is None:
        _fail('MISSING_SCAN_PROJECTION', 'scans', identifier)
    _project_exists(connection, value['projectId'], 'scans', identifier)
    points = value['points']
    metadata = {key: item for key, item in value.items() if key not in ('points', 'original')}
    fields = {'id': identifier, 'project_id': value['projectId'], 'name': value['name'],
        'source_kind': value['sourceKind'], 'point_count': len(points), 'min_khz': points[0]['frequencyKHz'],
        'max_khz': points[-1]['frequencyKHz'], 'points_digest': hashlib.sha256(_json(points).encode()).hexdigest(),
        'revision': revision, 'metadata_json': _json(metadata)}
    if scan != fields:
        _fail('SCAN_METADATA_MISMATCH', 'scans', identifier)
    actual = iter(connection.execute('SELECT ordinal,frequency_khz,level_dbm FROM db_scan_points WHERE scan_id=? ORDER BY ordinal', (identifier,)))
    for index, point in enumerate(points):
        check()
        row = next(actual, None)
        if row is None or tuple(row) != (index, point['frequencyKHz'], point['levelDbm']):
            _fail('SCAN_POINTS_MISMATCH', 'scans', identifier)
    if next(actual, None) is not None:
        _fail('EXTRA_SCAN_POINT', 'scans', identifier)
    original = _one(connection, 'SELECT * FROM db_scan_originals WHERE scan_id=?', (identifier,))
    desired = value.get('original')
    if desired is None:
        if original is not None:
            _fail('EXTRA_SCAN_ORIGINAL', 'scans', identifier)
    else:
        content = desired['text'].encode('utf-8')
        if original != {'scan_id': identifier, 'file_name': desired['name'], 'content_utf8': content,
                         'sha256': hashlib.sha256(content).hexdigest(), 'byte_count': len(content)}:
            _fail('SCAN_ORIGINAL_MISMATCH', 'scans', identifier)


def _run_projection(connection, identifier, revision, value, deleted, check):
    if deleted:
        _fail('IMMUTABLE_RUN_DELETED', 'planning_runs', identifier)
    row = _one(connection, 'SELECT * FROM db_planning_runs WHERE id=?', (identifier,))
    expected = {'id': identifier, 'project_id': value['projectId'], 'input_json': _json(value['input']),
        'result_json': _json(value['result']), 'engine_version': value.get('engineVersion'),
        'scan_id': value.get('scanId'), 'profile_refs_json': _json(value.get('profileRefs', [])), 'revision': revision}
    if row != expected:
        _fail('RUN_PROJECTION_MISMATCH', 'planning_runs', identifier)
    _project_exists(connection, value['projectId'], 'planning_runs', identifier)
    import unified_database as database
    try:
        database.check_scan_input_evidence(connection,value)
    except database.DatabaseError as error:
        raise ConsistencyError('RUN_SCAN_EVIDENCE_MISMATCH',kind='planning_runs',identifier=identifier) from error
    if value.get('scanId'):
        _scan_reference(connection, value['scanId'], value['projectId'], 'planning_runs', identifier,
                        simulation=value.get('purpose') == 'simulation-study')
    for reference in value.get('profileRefs', []):
        check()
        profile = connection.execute('''SELECT value_json,deleted FROM db_resource_versions
            WHERE kind='profiles' AND id=? AND revision=?''', (reference['id'], reference['revision'])).fetchone()
        if profile is None or profile[1]:
            _fail('PROFILE_REFERENCE_CONFLICT', 'planning_runs', identifier)
        try:
            domains.validate_document('profiles', reference['id'], json.loads(profile[0]))
        except domains.DomainError as error:
            raise ConsistencyError('INVALID_REFERENCED_PROFILE', kind='planning_runs', identifier=identifier) from error


def verify_consistency(connection, *, check=lambda: None, schema_checked=False):
    """Return counts only; raise on inconsistency. Requires a stable DB snapshot."""
    import unified_database as database
    schema = None if schema_checked else validate_schema(connection)
    if (schema is not None and schema['schema_kind'] != 'unified') or not connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='db_resources'").fetchone():
        return {'status': 'legacy-not-applicable', 'versions_checked': 0, 'projections_checked': 0}
    check()
    invalid = connection.execute('''SELECT r.kind,r.id FROM db_resources r
        WHERE r.revision != (SELECT COALESCE(MAX(v.revision),0) FROM db_resource_versions v
          WHERE v.kind=r.kind AND v.id=r.id) LIMIT 1''').fetchone()
    if invalid:
        _fail('LATEST_REVISION_MISMATCH', *invalid)
    invalid = connection.execute('''SELECT v.kind,v.id FROM db_resource_versions v
        LEFT JOIN db_audit a ON a.seq=v.audit_seq WHERE a.seq IS NULL OR a.kind!=v.kind
        OR a.resource_id!=v.id OR a.revision!=v.revision LIMIT 1''').fetchone()
    if invalid:
        _fail('VERSION_AUDIT_MISMATCH', *invalid)
    count = 0
    for kind, identifier, revision, raw, deleted, digest in connection.execute(
            'SELECT kind,id,revision,value_json,deleted,digest FROM db_resource_versions ORDER BY kind,id,revision'):
        check()
        if hashlib.sha256(raw.encode('utf-8')).hexdigest() != digest:
            _fail('VERSION_DIGEST_MISMATCH', kind, identifier)
        value = json.loads(raw)
        if kind not in database.KINDS or deleted not in (0, 1) or (deleted and value is not None):
            _fail('INVALID_VERSION_DOCUMENT', kind, identifier)
        if kind in _CORE_TABLES:
            _core_document(database, kind, identifier, revision, value, deleted)
        count += 1
    for operation, kind, identifier, revision, actor, audit_operation, actor_json in connection.execute('''
        SELECT o.operation_id,o.kind,o.resource_id,o.revision,o.actor_id,a.operation_id,a.actor_json
        FROM db_operations o LEFT JOIN db_resource_versions v
          ON v.kind=o.kind AND v.id=o.resource_id AND v.revision=o.revision
        LEFT JOIN db_audit a ON a.seq=v.audit_seq'''):
        check()
        audit_actor = json.loads(actor_json or 'null')
        if operation != audit_operation or not isinstance(audit_actor, dict) or audit_actor.get('id') != actor:
            _fail('OPERATION_AUDIT_MISMATCH', kind, identifier)
    projections, checked_kinds, unchecked_kinds = 0, set(), set()
    for kind, identifier, revision, raw, deleted in connection.execute('''
        SELECT r.kind,r.id,r.revision,v.value_json,v.deleted FROM db_resources r
        JOIN db_resource_versions v ON v.kind=r.kind AND v.id=r.id AND v.revision=r.revision
        ORDER BY r.kind,r.id'''):
        check()
        value = json.loads(raw)
        if kind in _DOMAIN_TABLES:
            _domain_projection(connection, kind, identifier, revision, value, bool(deleted), check)
        elif kind == 'scans':
            _scan_projection(connection, identifier, revision, value, bool(deleted), check)
        elif kind == 'planning_runs':
            _run_projection(connection, identifier, revision, value, bool(deleted), check)
        elif kind in _CORE_TABLES:
            _core_projection(connection, kind, identifier, revision, value, bool(deleted))
        else:
            # Newly introduced kinds still receive full schema/FK/whole-table
            # digests and generic version/audit checks. Do not misrepresent a
            # not-yet-implemented field projection checker as verified.
            unchecked_kinds.add(kind)
            continue
        checked_kinds.add(kind)
        projections += 1
    for kind, tables in _DOMAIN_TABLES.items():
        table, key = tables[0]
        orphan = connection.execute('SELECT p.' + key + ' FROM ' + table + ' p LEFT JOIN db_resources r ON r.kind=? AND r.id=p.'
                                     + key + ' WHERE r.id IS NULL LIMIT 1', (kind,)).fetchone()
        if orphan:
            _fail('ORPHAN_DOMAIN_PROJECTION', kind, orphan[0])
    for kind, table in _CORE_TABLES.items():
        orphan = connection.execute('SELECT p.id FROM ' + table + ' p LEFT JOIN db_resources r ON r.kind=? AND r.id=p.id WHERE r.id IS NULL LIMIT 1', (kind,)).fetchone()
        if orphan:
            _fail('ORPHAN_CORE_PROJECTION', kind, orphan[0])
    for project, record, _revision in connection.execute('SELECT project_id,record_id,revision FROM biz_planning_tombstones'):
        check()
        row = _one(connection, 'SELECT project_id,deleted FROM biz_planning_records WHERE id=?', (record,))
        if row and (row['project_id'] != project or row['deleted'] != 1):
            _fail('TOMBSTONE_RECORD_MISMATCH', 'planning_records', record)
        documented = False
        for raw, in connection.execute("SELECT value_json FROM db_resource_versions WHERE kind='planning_current' AND id=? AND deleted=0", (project,)):
            if record in json.loads(raw).get('deletedRecordIds', []):
                documented = True
                break
        if not documented:
            documented = bool(connection.execute("SELECT 1 FROM db_resource_versions WHERE kind='planning_records' AND id=? AND deleted=1 LIMIT 1", (record,)).fetchone())
        if not documented:
            _fail('UNDOCUMENTED_PLANNING_TOMBSTONE', 'planning_records', record)
    return {'status': 'verified' if not unchecked_kinds else 'generic-verified-projection-partial',
            'versions_checked': count, 'projections_checked': projections,
            'checked_kinds': sorted(checked_kinds), 'unchecked_projection_kinds': sorted(unchecked_kinds),
            'projection_scope':'current-business-documents',
            'reference_scope':'current-scan-pointers-and-immutable-run-inputs',
            'live_stream_semantics':'not-verified', 'legacy_business_semantics':'not-reinterpreted'}
