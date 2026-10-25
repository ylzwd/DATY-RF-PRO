"""Integrated candidate wire contract; exact methods, no generic HTTP proxy."""
from data_contract import METHODS as DATA_METHODS
from m5_contract import (FILE_METHODS, ENROLL_METHODS, M5Error, fields, identifier,
                         encoded, MAX_BYTES)

SERVER = 'daty-rf-pro'
COMMAND_METHODS = {'commands.request', 'commands.get', 'commands.targets',
                   'commands.review', 'commands.uncertain', 'commands.by_id'}
PLUGIN_METHODS = {'plugins.status','plugins.preview','plugins.install','plugins.operation','plugins.remove_exported','plugins.scan_file','plugins.scan.start','plugins.scan.status','plugins.scan.cancel'}
APP_METHODS = PLUGIN_METHODS | set(DATA_METHODS) | set(FILE_METHODS) | COMMAND_METHODS | {'network.status','devices.snapshot','uploads.release','discovery.uncertain','discovery.review'}

def schema(mode):
    return 'daty-mqtt6-' + mode + '-v1'

def prefix(mode):
    return 'daty/private/v2/' + SERVER + '/' + mode

def topic(mode, suffix):
    return 'daty/v2/' + SERVER + '/' + mode + '/' + suffix

def validate_request(request, mode):
    fields(request, ('schema','server_id','boot_id','client_session_id','request_id',
                     'method','deadline_at_ms','body'))
    if mode not in ('app','enrollment') or request['schema'] != schema(mode) or request['server_id'] != SERVER:
        raise M5Error('WRONG_SERVER_OR_SCHEMA')
    if request['method'] not in (APP_METHODS if mode == 'app' else ENROLL_METHODS):
        raise M5Error('METHOD_NOT_SUPPORTED')
    for key in ('boot_id','client_session_id','request_id'):
        identifier(request[key])
    if type(request['deadline_at_ms']) is not int or not isinstance(request['body'], dict):
        raise M5Error('INVALID_REQUEST')
    if len(encoded(request).encode()) > (16384 if mode == 'enrollment' else MAX_BYTES):
        raise M5Error('MESSAGE_TOO_LARGE',413)
    return request
