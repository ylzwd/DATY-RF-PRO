"""M4 JSON RPC contract. Candidate only; no arbitrary HTTP/SQL dispatch."""
import json
import re

SERVER = 'stage4-server'
SCHEMA = 'daty-mqtt-data-v1'
MAX_BYTES = 768 * 1024
READS = {
    'database.activity.list', 'database.activity.get', 'database.catalog', 'database.status', 'database.resources.list', 'database.resources.get',
    'database.operations.get', 'database.channels', 'database.overview',
    'database.draft.get', 'database.business_snapshot', 'database.import.preview',
    'projects.list', 'projects.get', 'timeline.list', 'discovery.status',
    'state.health', 'state.stats', 'state.capabilities', 'state.clock',
    'operations.get',
}
WRITES = {'database.write', 'database.batch', 'database.draft.save', 'database.import.commit',
          'projects.save', 'planning.run.create', 'timeline.append', 'discovery.scan', 'discovery.cancel'}
METHODS = READS | WRITES


class DataError(Exception):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code, self.status = code, status


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':'))


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch('[A-Za-z0-9_-]{16,80}', value):
        raise DataError('INVALID_OPERATION_ID')
    return value


def fields(body, required=(), optional=()):
    if not isinstance(body, dict) or not set(required) <= body.keys() or body.keys() - set(required) - set(optional):
        raise DataError('INVALID_METHOD_FIELDS')


def validate_request(request):
    fields(request, ('schema','server_id','boot_id','client_session_id','request_id','method','deadline_at_ms','body'))
    if request['schema'] != SCHEMA or request['server_id'] != SERVER or request['method'] not in METHODS:
        raise DataError('INVALID_DATA_REQUEST')
    for name in ('boot_id','client_session_id','request_id'):
        if not isinstance(request[name],str) or not re.fullmatch('[A-Za-z0-9_-]{16,80}', request[name]):
            raise DataError('INVALID_REQUEST_IDENTITY')
    if type(request['deadline_at_ms']) is not int or not isinstance(request['body'],dict):
        raise DataError('INVALID_DATA_REQUEST')
    if len(encoded(request).encode()) > MAX_BYTES:
        raise DataError('MESSAGE_TOO_LARGE_USE_M5',413)
    if request['method'] in WRITES:
        identifier(request['body'].get('operation_id'))
        if not isinstance(request['body'].get('epoch'),str):
            raise DataError('DATABASE_EPOCH_REQUIRED',428)
    return request
