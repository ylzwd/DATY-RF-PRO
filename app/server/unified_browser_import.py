"""Explicit 15-key browser backup -> normalized SQLite import candidate.

No browser storage, path discovery, network, service or receiver access. The
caller supplies a backup and owns one stable transaction, authentication and
the final commit/rollback. Preview never writes. Raw storage strings are kept
with their actual browser origin/key/digest; archives are not normalized data.
This bounded version rejects mixed-project history instead of guessing owners.
"""
import hashlib
import json
import re
from urllib.parse import urlsplit

import unified_database as database
import unified_domains as domains
from unified_import import ImportError, _require_transaction, _digest, _text, _write

PROTOCOL = 'daty-browser-sql-import-v1'
FORMAT = 'daty-browser-business-backup-v1'
MAX_BYTES = 10 * 1024 * 1024
TYPES = {
    'daty_devices': list, 'daty_alerts': list, 'daty_db_alerts': list,
    'daty_pending_alerts_v1': list, 'daty_alert_archive_meta_v1': dict,
    'daty_equipment_profiles_v1': list, 'daty_equipment_profiles_v2': list,
    'daty_planning_history_v1': dict, 'daty_planner_constraints_v1': dict,
    'daty_alert_thresholds_v1': dict, 'daty_receiver_group_numbers_v1': dict,
    'daty_alert_sound_v1': dict, 'daty_auto_frequency_v1': dict,
    'specStartFreq': str, 'specEndFreq': str,
}
ARCHIVE_ONLY = frozenset({'daty_devices', 'daty_alerts', 'daty_alert_archive_meta_v1',
    'daty_planner_constraints_v1', 'daty_receiver_group_numbers_v1'})


def _fail(code, message, status=400):
    raise ImportError(message, code, status)


def _parse_json(raw):
    def pairs(items):
        value = {}
        for key, child in items:
            if key in value:
                _fail('INVALID_BROWSER_JSON', 'Duplicate JSON fields are not accepted')
            value[key] = child
        return value
    def nonfinite(_):
        _fail('INVALID_BROWSER_JSON', 'Nonfinite JSON values are not accepted')
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite)
    except (ValueError, TypeError, RecursionError) as error:
        if isinstance(error, ImportError):
            raise
        raise ImportError('Browser backup contains invalid JSON', 'INVALID_BROWSER_JSON') from error


def _source(backup):
    try:
        if type(backup) is str:
            if len(backup.encode('utf-8')) > MAX_BYTES:
                _fail('BROWSER_BACKUP_TOO_LARGE', 'Browser backup exceeds 10 MiB')
            body = _parse_json(backup)
        elif type(backup) is dict:
            body = backup
        else:
            _fail('INVALID_BROWSER_BACKUP', 'An explicit backup object or JSON text is required')
        if (type(body) is not dict or set(body) - {'format', 'version', 'sourceOrigin', 'createdAt', 'values'}
                or body.get('format') != FORMAT or type(body.get('version')) is not int or body['version'] != 1
                or type(body.get('values')) is not dict):
            _fail('INVALID_BROWSER_BACKUP', 'Expected the DATY 15-key browser business backup format')
        # Validate every envelope field, but never serialize parsed values back
        # over the exact original strings supplied by the operator.
        body = domains._clone(body)
        origin = body.get('sourceOrigin')
        if type(origin) is not str or not origin or any(char.isspace() or ord(char) < 32 for char in origin):
            _fail('INVALID_SOURCE_ORIGIN', 'A real HTTP/HTTPS browser origin is required')
        parsed = urlsplit(origin)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.path or parsed.query or parsed.fragment
                or origin != parsed.scheme + '://' + parsed.netloc or '\\' in origin):
            _fail('INVALID_SOURCE_ORIGIN', 'Source must be a credential-free browser origin, not a URL path')
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            _fail('INVALID_SOURCE_ORIGIN', 'Source browser port is invalid')
        if 'createdAt' in body and type(body['createdAt']) is not str:
            _fail('INVALID_BROWSER_BACKUP', 'Backup creation metadata must be text')
        values = {}
        for key, raw in body['values'].items():
            if key not in TYPES or type(raw) is not str:
                _fail('UNKNOWN_BROWSER_KEY', 'Unknown browser key or non-string storage value')
            if TYPES[key] is str:
                if not re.fullmatch(r'\d+(?:\.\d+)?', raw) or not 0 < float(raw) <= 3000:
                    _fail('INVALID_BROWSER_FREQUENCY', 'Spectrum preference must be an explicit MHz string')
                value = raw
            else:
                value = _parse_json(raw)
                if type(value) is not TYPES[key]:
                    _fail('INVALID_BROWSER_TYPE', 'Browser storage value has an invalid top-level type')
                value = domains._clone(value)
            values[key] = value
        if len(database._safe_json(body).encode('utf-8')) > MAX_BYTES:
            _fail('BROWSER_BACKUP_TOO_LARGE', 'Browser backup exceeds 10 MiB')
        return body, values
    except (domains.DomainError, database.DatabaseError, UnicodeError, RecursionError, TypeError, ValueError) as error:
        if isinstance(error, ImportError):
            raise
        # Deliberately do not echo raw JSON, host credentials or original values.
        raise ImportError('Invalid browser backup, origin or forbidden business fields', 'INVALID_BROWSER_BACKUP') from error


def _snapshot(origin, key, raw):
    digest = hashlib.sha256(raw.encode('utf-8')).hexdigest()
    value = {'sourceOrigin': origin, 'sourceKey': key,
             'payload': {'type': 'browser-storage-value', 'raw': raw, 'sha256': digest}}
    return _write('legacy_snapshots', 'legacy-browser-' + _digest(value), value)


def preview_import(connection, backup, *, preference_id=None):
    """Only inspect explicit source/target; no implicit selection or overwrite."""
    _require_transaction(connection)
    from fresh_start_policy import reject_legacy_cache
    reject_legacy_cache(connection)
    source, values = _source(backup)
    if preference_id is not None:
        preference_id = _text(preference_id, 'explicit preference scope')
        if not preference_id.startswith('view:'):
            _fail('INVALID_PREFERENCE_SCOPE', 'Select an explicit public view preference scope')
    state = database.status(connection)
    drafts, skipped, conflicts, attribution = [], [], [], []
    normalized, unsupported = set(), set()
    source_targets = {}

    def conflict(code, source_key, kind=None, identifier=None):
        conflicts.append({'code': code, 'sourceKey': source_key, 'kind': kind, 'id': identifier})
        unsupported.add(source_key)

    def propose(kind, identifier, value, source_key):
        key = (kind, identifier)
        try:
            database._safe_json(value)
            database._validate(kind, identifier, value, False)
            digest = _digest(value)
            if key in source_targets:
                if source_targets[key] != digest:
                    conflict('SOURCE_TARGET_CONTENT_CONFLICT', source_key, kind, identifier)
                return
            source_targets[key] = digest
            existing = database.get_resource(connection, kind, identifier)
            if existing is None:
                drafts.append(_write(kind, identifier, value))
            elif not existing['deleted'] and _digest(existing['value']) == digest:
                skipped.append({'kind': kind, 'id': identifier, 'revision': existing['revision']})
            else:
                conflict('EXISTING_TARGET_DIFFERS', source_key, kind, identifier)
        except (domains.DomainError, database.DatabaseError, ValueError, TypeError) as error:
            conflict(getattr(error, 'code', 'INVALID_BROWSER_DOCUMENT'), source_key, kind, identifier)

    for key, identifier in [('daty_alert_thresholds_v1', 'alert_thresholds'),
                            ('daty_alert_sound_v1', 'alert_sound'), ('daty_auto_frequency_v1', 'auto_frequency')]:
        if key in values:
            propose('settings', identifier, values[key], key)
            normalized.add(key)

    # v2 is inspected first, but a different v1 definition of the same ID is a
    # blocking conflict. Equal duplicates have one exact normalized write.
    for key in ('daty_equipment_profiles_v2', 'daty_equipment_profiles_v1'):
        if key not in values:
            continue
        seen = set()
        for profile in values[key]:
            try:
                identifier = _text(profile.get('id'), 'profile ID')
                if identifier in seen:
                    conflict('DUPLICATE_PROFILE_ID', key, 'profiles', identifier)
                else:
                    seen.add(identifier)
                    propose('profiles', identifier, profile, key)
            except (AttributeError, ImportError):
                conflict('INVALID_PROFILE_ID', key)
        normalized.add(key)

    key = 'daty_planning_history_v1'
    if key in values:
        try:
            body = values[key]
            project = domains._object(body.get('project'), 'browser project')
            project_id, name = _text(project.get('id'), 'project ID'), _text(project.get('name'), 'project name')
            records = domains._array(body.get('records'), 'planning records')
            deleted = domains._array(body.get('deletedRecordIds'), 'planning tombstones')
            if any(type(item) is not str or not item.strip() for item in deleted) or len(set(deleted)) != len(deleted):
                _fail('INVALID_BROWSER_TOMBSTONES', 'Browser tombstones are invalid')
            by_id, active = {}, []
            for index, original in enumerate(records):
                record = domains._clone(domains._object(original, 'planning record'))
                identifier = _text(record.get('id'), 'planning record ID')
                if identifier in by_id:
                    _fail('DUPLICATE_PLANNING_RECORD', 'Browser planning record IDs repeat')
                if 'projectId' not in record:
                    record['projectId'] = project_id
                    attribution.append({'sourceKey': key, 'path': '/records/' + str(index) + '/projectId',
                        'value': project_id, 'basis': 'explicit backup parent project.id'})
                if record['projectId'] != project_id:
                    _fail('UNSUPPORTED_MULTI_PROJECT_HISTORY', 'Separate mixed-project browser history explicitly before import')
                domains.validate_document('planning_records', identifier, record)
                by_id[identifier] = record
                if identifier not in deleted:
                    active.append(record)
            selected = body.get('currentRecordId')
            if selected is not None and (selected not in by_id or selected in deleted):
                _fail('INVALID_BROWSER_CURRENT', 'Selected planning history is missing or deleted')
            data = domains._clone(project.get('data', {}))
            domains._object(data, 'browser project data')
            reserved = {'planningHistory', 'deletedRecordIds', 'currentPlanningRecordId',
                        'constraints', 'constraintFields', 'last_coordination_at'}
            current = {'projectId': project_id, 'currentRecordId': selected, 'deletedRecordIds': deleted,
                       'devices': domains._clone(by_id[selected]['devices']) if selected else []}
            for field in ('constraints', 'constraintFields', 'last_coordination_at'):
                if field in data:
                    current[field] = data[field]
            if selected:
                chosen = by_id[selected]
                if 'options' in chosen or 'constraints' in chosen:
                    current['constraints'] = chosen.get('options', chosen.get('constraints'))
                if 'constraintFields' in chosen:
                    current['constraintFields'] = chosen['constraintFields']
            if 'constraints' in current:
                domains._constraints(current['constraints'])
            existing_dead = {row[0] for row in connection.execute('SELECT record_id FROM biz_planning_tombstones WHERE project_id=?', (project_id,))}
            if not existing_dead.issubset(deleted):
                _fail('EXISTING_TOMBSTONE_CONFLICT', 'Browser history cannot discard existing deletions')
            for identifier in deleted:
                owner = connection.execute('SELECT project_id FROM biz_planning_records WHERE id=?', (identifier,)).fetchone()
                if owner and owner[0] != project_id:
                    _fail('PLANNING_PROJECT_CONFLICT', 'Browser tombstone targets another project')
            propose('project_metadata', project_id, {'id': project_id, 'name': name,
                'data': {field: value for field, value in data.items() if field not in reserved}}, key)
            for record in active:
                propose('planning_records', record['id'], record, key)
            propose('planning_current', project_id, current, key)
            normalized.add(key)
        except (ImportError, domains.DomainError, database.DatabaseError, KeyError, ValueError, TypeError) as error:
            conflict(getattr(error, 'code', 'INVALID_BROWSER_PLANNING'), key)

    for key in ('daty_db_alerts', 'daty_pending_alerts_v1'):
        if key not in values:
            continue
        for item in values[key]:
            if (type(item) is not dict or type(item.get('archiveId')) is not str or not item['archiveId'].strip()
                    or type(item.get('firstSeen')) is not int):
                conflict('ALERT_STABLE_IDENTITY_REQUIRED', key)
                continue
            propose('alerts', item['archiveId'], item, key)
        normalized.add(key)

    range_keys = {'specStartFreq', 'specEndFreq'} & values.keys()
    if range_keys:
        if len(range_keys) != 2 or preference_id is None:
            for key in range_keys:
                conflict('PREFERENCE_SCOPE_OR_PAIR_REQUIRED', key)
        else:
            propose('preferences', preference_id, {key: values[key] for key in sorted(range_keys)}, 'specStartFreq')
            normalized.update(range_keys)

    for key, raw in source['values'].items():
        item = _snapshot(source['sourceOrigin'], key, raw)
        propose(item['kind'], item['id'], item['value'], key)
    if len(drafts) > 1000:
        conflicts.append({'code': 'IMPORT_BATCH_TOO_LARGE', 'sourceKey': None, 'kind': None, 'id': None})
    body = {'protocol': PROTOCOL, 'epoch': state['epoch'], 'instanceId': state['instance_id'],
        'sourceOrigin': source['sourceOrigin'], 'sourceDigest': _digest(source), 'preferenceId': preference_id,
        'sourceKeys': sorted(values), 'normalizedKeys': sorted(normalized - unsupported),
        'archivedOnlyKeys': sorted(ARCHIVE_ONLY & values.keys()), 'unsupportedKeys': sorted(unsupported),
        'draftWrites': drafts, 'skipped': skipped, 'conflicts': conflicts, 'attribution': attribution,
        'limitations': ['Only one explicit parent project per planning backup is normalized',
                       'Device/cache/GROUP/draft/meta archives never become receiver identity, online state or commands']}
    body['previewDigest'] = _digest(body)
    body['ready'] = not conflicts
    return body


def apply_import(connection, backup, *, preference_id=None, confirmed=False,
                 expected_preview_digest, operation_id, epoch, actor, now_ms):
    """Caller must commit only on success, rollback on any exception.

    Returned success means transaction prepared, not yet durable. A committed
    same-operation receipt is replayed without applying or overwriting again.
    """
    _require_transaction(connection)
    if confirmed is not True:
        _fail('IMPORT_CONFIRMATION_REQUIRED', 'Explicit import confirmation is required', 409)
    source, _ = _source(backup)
    source_digest = _digest(source)
    if type(expected_preview_digest) is not str or not re.fullmatch('[a-f0-9]{64}', expected_preview_digest):
        _fail('INVALID_PREVIEW_DIGEST', 'An exact preview digest is required')
    if type(operation_id) is not str or not re.fullmatch('[A-Za-z0-9_-]{16,80}', operation_id):
        _fail('INVALID_IMPORT_OPERATION', 'A stable import operation ID is required')
    if type(actor) is not dict:
        _fail('IMPORT_ACTOR_REQUIRED', 'A verified actor is required', 403)
    actor_id = _text(actor.get('id'), 'actor ID')
    if epoch != database.status(connection)['epoch']:
        _fail('DATABASE_EPOCH_CHANGED', 'Database epoch changed; no import was applied', 409)
    database._int(now_ms, 'import time')
    old = connection.execute('SELECT state,manifest_json FROM db_import_batches WHERE id=?', (operation_id,)).fetchone()
    if old:
        manifest = json.loads(old[1])
        expected = {'protocol': PROTOCOL, 'previewDigest': expected_preview_digest, 'actorId': actor_id,
                    'epoch': epoch, 'sourceDigest': source_digest, 'sourceOrigin': source['sourceOrigin'], 'preferenceId': preference_id}
        if old[0] != 'committed' or any(manifest.get(key) != value for key, value in expected.items()):
            _fail('IMPORT_OPERATION_CONFLICT', 'Import operation belongs to a different confirmed intent', 409)
        return {'success': True, 'replayedReceipt': True, **manifest}
    if connection.execute('SELECT 1 FROM db_operations WHERE operation_id=? UNION ALL SELECT 1 FROM db_batches WHERE operation_id=?', (operation_id, operation_id)).fetchone():
        _fail('IMPORT_OPERATION_CONFLICT', 'Operation ID already belongs to another write', 409)
    preview = preview_import(connection, source, preference_id=preference_id)
    if preview['previewDigest'] != expected_preview_digest:
        _fail('IMPORT_PREVIEW_CHANGED', 'Source or target changed; preview again', 409)
    if not preview['ready']:
        _fail('IMPORT_BLOCKED', 'Browser import has conflicts; nothing was written', 409)
    writes = preview['draftWrites']
    receipt = database.put_batch(connection, {'operation_id': operation_id, 'epoch': epoch, 'writes': writes}, actor, now_ms) if writes else None
    manifest = {key: preview[key] for key in ('protocol', 'epoch', 'sourceOrigin', 'sourceDigest', 'previewDigest',
        'preferenceId', 'sourceKeys', 'normalizedKeys', 'archivedOnlyKeys', 'unsupportedKeys')}
    manifest.update(operationId=operation_id, actorId=actor_id, written=len(writes), skipped=len(preview['skipped']),
                    batchOperationId=operation_id if receipt else None, resources=receipt['resources'] if receipt else [], committedAtMs=now_ms)
    connection.execute('INSERT INTO db_import_batches VALUES(?,?,?,?,?,?)',
        (operation_id, source['sourceOrigin'], source_digest, 'committed', database._safe_json(manifest), now_ms))
    return {'success': True, 'replayedReceipt': False, **manifest}
