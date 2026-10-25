"""Explicit old-SQL project/coordination import; never runs during startup.

Both preview and apply require a caller-owned stable transaction. No database
path, service, browser origin or receiver transport is opened here. Old tables
are never changed. Existing different targets block rather than being replaced.
Browser-origin import and old telemetry/command/scan conversion are separate.
"""
import hashlib
import json
import re

import unified_database as database
import unified_domains as domains
from unified_schema import validate_schema


PROTOCOL = 'daty-legacy-sql-import-v1'
SOURCE_ORIGIN = 'legacy-sqlite:projects'
SOURCE_TABLES = ('projects', 'project_devices', 'coordination_runs')
UNTOUCHED_TABLES = ('scan_datasets', 'commands', 'telemetry_samples', 'timeline_events')
ATOMIC_FIELDS = frozenset({'planningHistory', 'deletedRecordIds', 'currentPlanningRecordId',
    'constraints', 'constraintFields', 'last_coordination_at'})


class ImportError(ValueError):
    def __init__(self, message, code='IMPORT_INVALID', status=400):
        super().__init__(message)
        self.code, self.status = code, status


def _fail(message, code='IMPORT_INVALID', status=400):
    raise ImportError(message, code, status)


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':'))


def _digest(value):
    return hashlib.sha256(_json(value).encode('utf-8')).hexdigest()


def _text(value, label):
    try:
        return database._text(value, label)
    except database.DatabaseError as error:
        raise ImportError('Invalid legacy source identifier', 'INVALID_LEGACY_ID') from error


def _selection(project_ids):
    if project_ids is None:
        return None
    if type(project_ids) is not list or not project_ids or len(project_ids) > 1000:
        _fail('Select 1 to 1000 explicit project IDs')
    values = [_text(item, 'project ID') for item in project_ids]
    if len(set(values)) != len(values):
        _fail('Project selection contains duplicates')
    return sorted(values)


def _require_transaction(connection):
    if not connection.in_transaction:
        _fail('A caller-owned stable read/write transaction is required', 'TRANSACTION_REQUIRED')
    validate_schema(connection, allow_legacy=False)


def _rows(connection, sql, values=(), budget=None):
    cursor = connection.execute(sql, values)
    names, rows = [item[0] for item in cursor.description], []
    for row in cursor:
        item = dict(zip(names, row))
        if budget is not None:
            budget[0] -= len(_json(item).encode('utf-8'))
            if budget[0] < 0:
                _fail('Selected legacy project data exceeds 64 MiB; use a smaller project selection', 'IMPORT_SOURCE_TOO_LARGE')
        rows.append(item)
    return rows


def _load_source(connection, selection):
    budget = [database.MAX_DOCUMENT_BYTES]
    projects = (_rows(connection, 'SELECT * FROM projects ORDER BY id LIMIT 1001', budget=budget) if selection is None else
                [row for identifier in selection for row in _rows(connection, 'SELECT * FROM projects WHERE id=?', (identifier,), budget)])
    if selection is not None and {row['id'] for row in projects} != set(selection):
        _fail('A selected legacy project no longer exists', 'LEGACY_PROJECT_MISSING', 409)
    if len(projects) > 1000:
        _fail('Source project scope exceeds the bounded import size')
    result = []
    if selection is None:
        for table in ('project_devices', 'coordination_runs'):
            if connection.execute('SELECT 1 FROM ' + table + ' s LEFT JOIN projects p ON p.id=s.project_id WHERE p.id IS NULL LIMIT 1').fetchone():
                _fail('Legacy project source contains orphan foreign-key rows', 'LEGACY_PROJECT_ID_CONFLICT')
    for project in projects:
        identifier = _text(project['id'], 'project ID')
        result.append({'project': project,
            'devices': _rows(connection, 'SELECT * FROM project_devices WHERE project_id=? ORDER BY device_id', (identifier,), budget),
            'runs': _rows(connection, 'SELECT * FROM coordination_runs WHERE project_id=? ORDER BY id', (identifier,), budget)})
    # A deliberately bounded import, not a whole-database in-memory backup.
    try:
        if len(_json(result).encode('utf-8')) > database.MAX_DOCUMENT_BYTES:
            _fail('Selected legacy project data exceeds 64 MiB; use a smaller project selection')
    except (UnicodeError, ValueError, TypeError) as error:
        if isinstance(error, ImportError):
            raise
        raise ImportError('Legacy source contains invalid scalar JSON/encoding') from error
    return result


def _parse(raw, label, *, nullable=False):
    if raw is None and nullable:
        return None
    if type(raw) is not str:
        _fail('Legacy JSON field is not text: ' + label, 'INVALID_LEGACY_JSON')
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                _fail('Legacy JSON contains duplicate fields', 'INVALID_LEGACY_JSON')
            out[key] = value
        return out
    def finite(_):
        _fail('Legacy JSON contains nonfinite values', 'INVALID_LEGACY_JSON')
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=finite)
        # Check parsed content even though archival SQL JSON text remains exact.
        domains._clone(value)
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise ImportError('Legacy JSON is invalid or contains forbidden credentials', 'INVALID_LEGACY_JSON') from error


def _snapshot(table, key, row, *, attribution=None):
    payload = {'table': table, 'row': row}
    if attribution:
        payload['attribution'] = attribution
    value = {'sourceOrigin': 'legacy-sqlite:' + table, 'sourceKey': key, 'payload': payload}
    identifier = 'legacy-sql-' + _digest(value)
    return {'kind': 'legacy_snapshots', 'id': identifier, 'expected_revision': 0, 'value': value}


def _write(kind, identifier, value):
    return {'kind': kind, 'id': identifier, 'expected_revision': 0, 'value': value}


def _safe_device(value):
    domains._object(value, 'legacy project device')
    domains._device_key(value.get('id'))
    for key in ('freq', 'planned'):
        if value.get(key) is not None:
            domains._frequency(value[key], 'legacy device.' + key)
    return value


def preview_import(connection, project_ids=None):
    """Read-only source/target preview; draftWrites are not authorization to run.

    Current DTO matches the candidate legacy project adapter: unknown project
    data in project_metadata.data; atomic fields/devices in planning_current.
    Deleted source histories stay in immutable source archives, never transient
    active records. No receiver identity is derived from a numeric device ID.
    """
    _require_transaction(connection)
    selection = _selection(project_ids)
    source = _load_source(connection, selection)
    state = database.status(connection)
    source_digest = _digest(source)
    drafts, snapshots, skipped, conflicts, archived_deleted, assumed = [], [], [], [], [], []
    source_targets = set()

    def conflict(code, kind=None, identifier=None):
        conflicts.append({'code': code, 'kind': kind, 'id': identifier})

    def propose(write):
        key = (write['kind'], write['id'])
        if key in source_targets:
            conflict('DUPLICATE_SOURCE_TARGET', *key)
            return
        source_targets.add(key)
        try:
            database._safe_json(write['value'])
            database._validate(write['kind'], write['id'], write['value'], False)
            existing = database.get_resource(connection, *key)
            if existing is not None:
                if not existing['deleted'] and _digest(existing['value']) == _digest(write['value']):
                    skipped.append({'kind': key[0], 'id': key[1], 'revision': existing['revision']})
                else:
                    conflict('EXISTING_TARGET_DIFFERS', *key)
            else:
                drafts.append(write)
        except (database.DatabaseError, domains.DomainError, ValueError, TypeError) as error:
            conflict(getattr(error, 'code', 'INVALID_LEGACY_DOCUMENT'), *key)

    for group in source:
        project = group['project']
        project_id = project['id']
        try:
            data = _parse(project['project_json'], 'projects.project_json')
            domains._object(data, 'legacy project data')
            _text(project['name'], 'project name')
            history = domains._array(data.get('planningHistory', []), 'planningHistory')
            tombstones = domains._array(data.get('deletedRecordIds', []), 'deletedRecordIds')
            for identifier in tombstones:
                _text(identifier, 'deleted record ID')
            if len(set(tombstones)) != len(tombstones):
                _fail('Repeated legacy tombstones', 'INVALID_LEGACY_TOMBSTONES')
            existing_tombstones = [row[0] for row in connection.execute(
                'SELECT record_id FROM biz_planning_tombstones WHERE project_id=? ORDER BY record_id', (project_id,))]
            deleted_ids = sorted(set(tombstones) | set(existing_tombstones))
            devices, device_ids = [], set()
            for row in group['devices']:
                device = _safe_device(_parse(row['device_json'], 'project_devices.device_json'))
                key = str(device['id'])
                if key in device_ids or key != row['device_id']:
                    _fail('Legacy project device identity is duplicate or differs from its SQL key', 'LEGACY_DEVICE_ID_CONFLICT')
                device_ids.add(key)
                devices.append(device)
                snapshots.append(_snapshot('project_devices', project_id + '/' + row['device_id'], row))
            attribution, records, history_ids = [], [], set()
            for index, original in enumerate(history):
                domains._object(original, 'planning record')
                identifier = _text(original.get('id'), 'planning record ID')
                if identifier in history_ids:
                    _fail('Repeated history ID in one project', 'DUPLICATE_SOURCE_TARGET')
                history_ids.add(identifier)
                record = domains._clone(original)
                if 'projectId' not in record:
                    record['projectId'] = project_id
                    attribution.append({'path': '/planningHistory/' + str(index) + '/projectId',
                        'value': project_id, 'basis': 'parent projects.id foreign-key ownership'})
                elif record['projectId'] != project_id:
                    _fail('History record belongs to another project', 'LEGACY_PROJECT_ID_CONFLICT')
                domains.validate_document('planning_records', identifier, record)
                if identifier in deleted_ids:
                    archived_deleted.append({'projectId': project_id, 'id': identifier})
                else:
                    records.append(_write('planning_records', identifier, record))
            current_id = data.get('currentPlanningRecordId')
            if current_id is not None:
                _text(current_id, 'current planning record ID')
                if current_id in deleted_ids:
                    # Existing/newer target deletion takes priority over old
                    # selection, but a self-contradictory source is not guessed.
                    if current_id in tombstones:
                        _fail('Source selects its own deleted planning record', 'INVALID_LEGACY_CURRENT')
                    current_id = None
                    assumed.append({'projectId': project_id, 'rule': 'existing-tombstone-clears-stale-selection'})
                elif current_id not in history_ids:
                    _fail('Current planning record is not present in source history', 'INVALID_LEGACY_CURRENT')
            metadata = {'id': project_id, 'name': project['name'],
                        'data': {key: value for key, value in data.items() if key not in ATOMIC_FIELDS}}
            current = {'projectId': project_id, 'currentRecordId': current_id,
                       'deletedRecordIds': deleted_ids, 'devices': devices}
            for key in ('constraints', 'constraintFields', 'last_coordination_at'):
                if key in data:
                    current[key] = data[key]
            if 'constraints' in current:
                domains._constraints(current['constraints'])
            propose(_write('project_metadata', project_id, metadata))
            for write in records:
                propose(write)
            propose(_write('planning_current', project_id, current))
            snapshots.append(_snapshot('projects', project_id, project, attribution=attribution))
            for row in group['runs']:
                identifier = _text(row['id'], 'coordination run ID')
                if row['project_id'] != project_id:
                    _fail('Coordination run project identity differs', 'LEGACY_PROJECT_ID_CONFLICT')
                inputs = _parse(row['input_json'], 'coordination_runs.input_json')
                result = _parse(row['result_json'], 'coordination_runs.result_json')
                baseline = _parse(row['baseline_json'], 'coordination_runs.baseline_json', nullable=True)
                value = {'projectId': project_id, 'input': inputs, 'result': result,
                         'baseline': baseline, 'purpose': 'coordination-history', 'profileRefs': [],
                         'legacySource': {'origin': 'legacy-sqlite:coordination_runs', 'id': identifier,
                                          'createdAtSeconds': row['created_at']},
                         'inputVerification': 'legacy-unverified', 'deploymentEligible': False}
                # Do not infer scan/profile revision or transferable deployment
                # capability from an old result blob. It is an immutable record.
                propose(_write('planning_runs', identifier, value))
                snapshots.append(_snapshot('coordination_runs', identifier, row))
        except (ImportError, domains.DomainError, database.DatabaseError, ValueError, TypeError, KeyError) as error:
            conflict(getattr(error, 'code', 'INVALID_LEGACY_PROJECT'), 'project_metadata', project_id)
    for snapshot in snapshots:
        propose(snapshot)
    if len(drafts) > 1000:
        conflict('IMPORT_BATCH_TOO_LARGE')
    try:
        if len(_json(drafts).encode('utf-8')) > database.MAX_DOCUMENT_BYTES:
            conflict('IMPORT_BATCH_TOO_LARGE')
    except (UnicodeError, ValueError):
        conflict('INVALID_LEGACY_ENCODING')
    body = {'protocol': PROTOCOL, 'epoch': state['epoch'], 'instanceId': state['instance_id'],
            'selectedProjectIds': selection, 'sourceProjectIds': [item['project']['id'] for item in source],
            'sourceDigest': source_digest, 'sourceTables': list(SOURCE_TABLES),
            'untouchedLegacyTables': list(UNTOUCHED_TABLES), 'draftWrites': drafts, 'skipped': skipped,
            'conflicts': conflicts, 'archivedDeletedRecords': archived_deleted, 'attribution': assumed}
    body['previewDigest'] = _digest(body)
    body['ready'] = not conflicts
    return body


def apply_import(connection, *, project_ids=None, confirmed=False, expected_preview_digest,
                 operation_id, epoch, actor, now_ms):
    """Apply an explicitly confirmed, unchanged preview in caller transaction.

    No commit occurs here. Caller MUST roll back on any error and may expose
    success only after commit. Replaying the same confirmed import returns its
    committed import receipt, never replays its writes or overwrites new data.
    """
    _require_transaction(connection)
    if confirmed is not True:
        _fail('Explicit confirmation is required', 'IMPORT_CONFIRMATION_REQUIRED', 409)
    selection = _selection(project_ids)
    if type(expected_preview_digest) is not str or not re.fullmatch('[a-f0-9]{64}', expected_preview_digest):
        _fail('An exact preview digest is required')
    if type(operation_id) is not str or not re.fullmatch('[A-Za-z0-9_-]{16,80}', operation_id):
        _fail('A stable import operation ID is required')
    if type(actor) is not dict:
        _fail('Verified actor is required', 'IMPORT_ACTOR_REQUIRED', 403)
    actor_id = _text(actor.get('id'), 'actor ID')
    if epoch != database.status(connection)['epoch']:
        _fail('Database epoch changed; import was not applied', 'DATABASE_EPOCH_CHANGED', 409)
    database._int(now_ms, 'import time')
    old = connection.execute('SELECT state,manifest_json FROM db_import_batches WHERE id=?', (operation_id,)).fetchone()
    if old:
        manifest = json.loads(old[1])
        if (old[0] != 'committed' or manifest.get('previewDigest') != expected_preview_digest
                or manifest.get('actorId') != actor_id or manifest.get('epoch') != epoch
                or manifest.get('selectedProjectIds') != selection):
            _fail('Import operation ID belongs to another confirmed intent', 'IMPORT_OPERATION_CONFLICT', 409)
        return {'success': True, 'replayedReceipt': True, **manifest}
    if connection.execute('SELECT 1 FROM db_operations WHERE operation_id=? UNION ALL SELECT 1 FROM db_batches WHERE operation_id=?',
                          (operation_id, operation_id)).fetchone():
        _fail('Operation ID is already used outside this import', 'IMPORT_OPERATION_CONFLICT', 409)
    preview = preview_import(connection, selection)
    if preview['previewDigest'] != expected_preview_digest:
        _fail('Source or target changed since preview; preview again', 'IMPORT_PREVIEW_CHANGED', 409)
    if not preview['ready']:
        _fail('Legacy import has blocking conflicts; no writes applied', 'IMPORT_BLOCKED', 409)
    writes = preview['draftWrites']
    receipt = database.put_batch(connection, {'operation_id': operation_id, 'epoch': epoch, 'writes': writes}, actor, now_ms) if writes else None
    manifest = {'protocol': PROTOCOL, 'operationId': operation_id, 'epoch': epoch, 'actorId': actor_id,
                'selectedProjectIds': selection, 'sourceProjectIds': preview['sourceProjectIds'],
                'sourceDigest': preview['sourceDigest'], 'previewDigest': expected_preview_digest,
                'written': len(writes), 'skipped': len(preview['skipped']),
                'batchOperationId': operation_id if receipt else None,
                'resources': receipt['resources'] if receipt else [], 'committedAtMs': now_ms}
    connection.execute('INSERT INTO db_import_batches VALUES(?,?,?,?,?,?)',
        (operation_id, SOURCE_ORIGIN, preview['sourceDigest'], 'committed', database._safe_json(manifest), now_ms))
    return {'success': True, 'replayedReceipt': False, **manifest}
