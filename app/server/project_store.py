"""Isolated project revision store, awaiting explicit Bridge integration.

This module opens no database or network connection and never commits. The
caller owns the supplied SQLite connection and MUST commit on success and roll
back on every exception. It does not dispatch receiver commands, retry writes,
authorize an actor, or restore production data. Revision is independent of the
browser's edit-generation counter and device command/ACK identifiers.
"""
import json
import math
import sqlite3


PROJECT_REVISION_PROTOCOL = 'daty-project-revision-v1'
MAX_PROJECT_REVISION = 9007199254740991  # Exactly representable by JS clients.


class ProjectStoreError(Exception):
    def __init__(self, message, *, status=400, code='INVALID_PROJECT', **details):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details

    def to_response(self):
        return {'success': False, 'accepted': False, 'code': self.code,
                'error': str(self), **self.details}


def _begin_if_needed(connection):
    # ALTER TABLE does not implicitly start a transaction in Python sqlite3.
    # Also protect callers using isolation_level=None from partial writes.
    # Do not commit/release an outermost savepoint here: the caller owns commit.
    if not connection.in_transaction:
        connection.execute('BEGIN IMMEDIATE')


def _literal_default_one(value):
    if not isinstance(value, str):
        return False
    value = value.strip()
    while value.startswith('(') and value.endswith(')'):
        value = value[1:-1].strip()
    return value == '1'


def migrate_projects(connection):
    """Add revision to the existing project table in the caller's transaction.

    Idempotent; returns whether a column was added. On an exception the caller
    must roll back. Existing project JSON, devices, timestamps and audit rows
    are not rewritten, and an unfamiliar/broken revision schema is rejected.
    """
    _begin_if_needed(connection)
    columns = {row[1]: row for row in connection.execute('PRAGMA table_info(projects)')}
    if not {'id', 'name', 'project_json', 'created_at', 'updated_at'} <= columns.keys():
        raise ProjectStoreError('项目表结构不受支持', status=503,
                                code='PROJECT_SCHEMA_UNSUPPORTED')
    added = 'revision' not in columns
    if added:
        connection.execute('ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
    else:
        column = columns['revision']
        if (str(column[2]).upper() != 'INTEGER' or column[3] != 1
                or not _literal_default_one(column[4])):
            raise ProjectStoreError('项目版本字段结构不受支持', status=503,
                                    code='PROJECT_SCHEMA_UNSUPPORTED')
    invalid = connection.execute(
        "SELECT 1 FROM projects WHERE typeof(revision) <> 'integer' "
        'OR revision < 1 OR revision > ? LIMIT 1', (MAX_PROJECT_REVISION,)
    ).fetchone()
    if invalid:
        raise ProjectStoreError('项目版本数据无效，不能自动修复', status=503,
                                code='PROJECT_SCHEMA_UNSUPPORTED')
    return added


def _utf8_text(value, field):
    try:
        value.encode('utf-8', errors='strict')
    except UnicodeError as error:
        raise ProjectStoreError(f'{field}包含无效的 Unicode 文本') from error
    return value


def _json_text(value, field):
    try:
        text = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    except (TypeError, ValueError, OverflowError, RecursionError) as error:
        raise ProjectStoreError(f'{field}必须是有效 JSON 数据') from error
    return _utf8_text(text, field)


def _device_rows(devices, project_id):
    if not isinstance(devices, list):
        raise ProjectStoreError('devices 必须是数组')
    rows = []
    seen = set()
    for device in devices:
        if not isinstance(device, dict):
            raise ProjectStoreError('设备快照必须是对象')
        identity = device.get('id')
        if type(identity) not in (str, int) or not str(identity).strip():
            raise ProjectStoreError('设备 ID 缺失或无效，不能保存项目')
        device_id = _utf8_text(str(identity), '设备 ID')
        if device_id in seen:
            raise ProjectStoreError('设备 ID 重复，不能保存项目')
        seen.add(device_id)
        rows.append((project_id, device_id, _json_text(device, '设备快照')))
    return rows


def _conflict(connection, project_id, expected):
    row = connection.execute('SELECT revision FROM projects WHERE id=?', (project_id,)).fetchone()
    return ProjectStoreError(
        '服务器项目已变化，请保留本机历史并读取最新版本后再确认保存',
        status=409, code='PROJECT_REVISION_CONFLICT', project_id=project_id,
        expected_revision=expected, current_revision=row[0] if row else None)


def save_project(connection, body, actor, now, project_id):
    """Conditionally save one project, device set and audit event atomically.

    expected_revision=0 means create-only; a positive value means update-only.
    Missing preconditions never fall back to the former unconditional UPSERT.
    Omitted data keeps the existing API's empty-object replacement semantics;
    omitted devices preserves the previous set, while [] explicitly clears it.
    Validation precedes writes. Caller must roll back even for audit failures.
    """
    if not isinstance(body, dict):
        raise ProjectStoreError('项目请求必须是对象')
    if 'expected_revision' not in body:
        raise ProjectStoreError('项目保存需要版本条件，请刷新客户端后重试', status=428,
                                code='PROJECT_PRECONDITION_REQUIRED')
    expected = body['expected_revision']
    if type(expected) is not int or expected < 0 or expected > MAX_PROJECT_REVISION:
        raise ProjectStoreError('expected_revision 必须是非负安全整数',
                                code='INVALID_PROJECT_REVISION')
    if not isinstance(project_id, str) or not project_id.strip():
        raise ProjectStoreError('项目 ID 不能为空')
    _utf8_text(project_id, '项目 ID')
    name = str(body.get('name') or '未命名项目').strip()
    if not name:
        raise ProjectStoreError('项目名称不能为空')
    _utf8_text(name, '项目名称')
    data = body.get('data', {})
    if not isinstance(data, dict):
        raise ProjectStoreError('data 必须是对象')
    project_json = _json_text(data, '项目 data')
    devices = _device_rows(body['devices'], project_id) if 'devices' in body else None
    try:
        valid_time = type(now) in (int, float) and math.isfinite(now)
    except OverflowError:
        valid_time = False
    if not valid_time:
        raise ProjectStoreError('保存时间必须是有限的 epoch 秒')
    # Authorization happens in the HTTP layer. Never persist credential or
    # arbitrary extra fields accidentally attached to its principal object.
    if actor is not None and not isinstance(actor, dict):
        raise ProjectStoreError('操作身份格式无效')
    public_actor = {key: actor[key] for key in ('id', 'name', 'role')
                    if isinstance(actor, dict) and key in actor}
    if any(not isinstance(value, str) for value in public_actor.values()):
        raise ProjectStoreError('操作身份公开字段必须是字符串')
    if expected == MAX_PROJECT_REVISION:
        raise ProjectStoreError('项目版本已达安全整数上限，不能继续写入', status=409,
                                code='PROJECT_REVISION_EXHAUSTED')
    revision = 1 if expected == 0 else expected + 1
    details = _json_text({'project_id': project_id, 'revision': revision,
                          'actor': public_actor}, '保存审计')
    try:
        _begin_if_needed(connection)
        if expected == 0:
            cursor = connection.execute(
                'INSERT INTO projects(id,name,project_json,created_at,updated_at,revision) '
                'VALUES(?,?,?,?,?,1) ON CONFLICT(id) DO NOTHING',
                (project_id, name, project_json, now, now))
        else:
            cursor = connection.execute(
                'UPDATE projects SET name=?,project_json=?,updated_at=?,revision=revision+1 '
                'WHERE id=? AND revision=?', (name, project_json, now, project_id, expected))
        if cursor.rowcount != 1:
            raise _conflict(connection, project_id, expected)
        if devices is not None:
            connection.execute('DELETE FROM project_devices WHERE project_id=?', (project_id,))
            connection.executemany(
                'INSERT INTO project_devices(project_id,device_id,device_json) VALUES(?,?,?)', devices)
        # Project revision/CAS remains; the separate audit history is retired.
    except sqlite3.Error as error:
        # Do not leak database paths, SQL or user data through the HTTP reply.
        raise ProjectStoreError('项目事务保存失败，未确认同步成功', status=503,
                                code='PROJECT_STORE_FAILED') from error
    return {'project_id': project_id, 'revision': revision, 'updated_at': now}
