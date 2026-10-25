"""Candidate project-revision HTTP adapter; not loaded by the running Bridge.

The caller retains its existing Origin, authorization and JSON-body gates. Call
handle_save only AFTER project.write authorization and strict body decoding.
The supplied db_session owns lock/commit/rollback; no connection is opened here.
Responses are emitted only after the transaction context exits successfully.
There is no receiver transport, retry, credential storage, or startup action.
"""
import json
import re
from urllib.parse import unquote

from project_store import (MAX_PROJECT_REVISION, PROJECT_REVISION_PROTOCOL,
                           ProjectStoreError, save_project)


def _identifier(value):
    if (not isinstance(value, str) or not value.strip()
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise ProjectStoreError('项目 ID 必须是非空文本且不能含控制字符', code='INVALID_PROJECT_ID')
    try:
        value.encode('utf-8', errors='strict')
    except UnicodeError as error:
        raise ProjectStoreError('项目 ID 包含无效 Unicode', code='INVALID_PROJECT_ID') from error
    return value


def _path_identifier(path):
    encoded = path[len('/api/projects/'):]
    if not encoded or '/' in encoded:
        raise ProjectStoreError('项目路径不存在', status=404, code='PROJECT_ROUTE_NOT_FOUND')
    if re.search(r'%(?![0-9a-fA-F]{2})', encoded):
        raise ProjectStoreError('项目 ID 编码无效', code='INVALID_PROJECT_ID')
    try:
        decoded = unquote(encoded, encoding='utf-8', errors='strict')
    except UnicodeError as error:
        raise ProjectStoreError('项目 ID 编码无效', code='INVALID_PROJECT_ID') from error
    # Decode exactly once. An encoded slash belongs to the ID, not a new route;
    # '+' remains a literal plus and a double-encoded '%' is not decoded again.
    return _identifier(decoded)


def _revision(value):
    if type(value) is not int or value < 1 or value > MAX_PROJECT_REVISION:
        raise ProjectStoreError('项目版本数据无效', status=503, code='PROJECT_READ_FAILED')
    return value


def _response(data):
    result = {'revision_protocol': PROJECT_REVISION_PROTOCOL, **data}
    # Existing rows may predate UTF-8/JSON validation. Never start HTTP headers
    # and then discover bad text, nonfinite JSON or excessive nesting halfway.
    json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8', errors='strict')
    return result


def handle_get(handler, path, *, db_session):
    """Handle project list/detail only; return False for unrelated paths.

    Project rows and their device list are read in a single SQLite snapshot,
    including when another connection writes while the read is in progress.
    GET still uses the caller's original public-read/Origin access policy.
    """
    if path != '/api/projects' and not path.startswith('/api/projects/'):
        return False
    try:
        project_id = None if path == '/api/projects' else _path_identifier(path)
        with db_session() as connection:
            if not connection.in_transaction:
                connection.execute('BEGIN')
            if project_id is None:
                rows = connection.execute(
                    'SELECT id,name,created_at,updated_at,revision FROM projects '
                    'ORDER BY updated_at DESC,id').fetchall()
            else:
                row = connection.execute(
                    'SELECT id,name,project_json,created_at,updated_at,revision FROM projects WHERE id=?',
                    (project_id,)).fetchone()
                devices = connection.execute(
                    'SELECT device_json FROM project_devices WHERE project_id=? ORDER BY device_id',
                    (project_id,)).fetchall() if row is not None else []
        # Rows are now a consistent immutable read snapshot. Parsing/encoding a
        # large project must not unnecessarily hold the Bridge database lock.
        if project_id is None:
            projects = [{'id': row[0], 'name': row[1], 'created_at': row[2], 'updated_at': row[3],
                         'revision': _revision(row[4]), 'revision_protocol': PROJECT_REVISION_PROTOCOL}
                        for row in rows]
            payload, status = {'success': True, 'projects': projects}, 200
        elif row is None:
            payload, status = {'success': False, 'accepted': False, 'code': 'PROJECT_NOT_FOUND',
                               'error': '项目不存在'}, 404
        else:
            data = json.loads(row[2])
            if not isinstance(data, dict):
                raise ValueError('invalid stored project data')
            project = {'id': row[0], 'name': row[1], 'data': data,
                       'created_at': row[3], 'updated_at': row[4], 'revision': _revision(row[5]),
                       'revision_protocol': PROJECT_REVISION_PROTOCOL,
                       'devices': [json.loads(device[0]) for device in devices]}
            if any(not isinstance(device, dict) for device in project['devices']):
                raise ValueError('invalid stored device data')
            payload, status = {'success': True, 'project': project}, 200
        payload = _response(payload)
    except ProjectStoreError as error:
        payload, status = _response(error.to_response()), error.status
    except Exception:
        payload, status = _response({'success': False, 'accepted': False, 'code': 'PROJECT_READ_FAILED',
                                     'error': '项目读取失败，未返回不完整数据'}), 503
    # Network failures here must not attempt a second reply or retry a write.
    handler._json(payload, status=status)
    return True


def handle_save(handler, body, actor, *, db_session, now, new_id):
    """Save after the unchanged HTTP authorization and body-validation gates.

    `now` and `new_id` are callables. Omitted ID supports create-only clients;
    a supplied ID must remain an exact string (no lossy coercion/normalization).
    Missing revision reaches the store's 428 rather than legacy UPSERT.
    """
    try:
        if not isinstance(body, dict):
            raise ProjectStoreError('项目请求必须是对象')
        project_id = _identifier(body['id']) if 'id' in body else _identifier(new_id())
        if 'id' not in body and 'expected_revision' in body and body['expected_revision'] != 0:
            raise ProjectStoreError('更新已有项目必须提供项目 ID', code='INVALID_PROJECT_ID')
        with db_session() as connection:
            result = save_project(connection, body, actor, now(), project_id)
            payload = _response({'success': True, **result})
        # Commit (including deferred SQLite constraints) has succeeded here.
        status = 200
    except ProjectStoreError as error:
        payload, status = _response(error.to_response()), error.status
    except Exception:
        payload, status = _response({'success': False, 'accepted': False, 'code': 'PROJECT_STORE_FAILED',
                                     'error': '项目事务保存失败，未确认同步成功'}), 503
    handler._json(payload, status=status)
