"""Isolated M5 contracts. File data and enrollment never share a topic tree."""
import json
import re

SERVER = 'stage5-server'
CHUNK = 128 * 1024
MAX_BYTES = 256 * 1024
MAX_UPLOAD = 64 * 1024 * 1024
MAX_DOWNLOAD = 1024 * 1024 * 1024
FILE_METHODS = frozenset(('uploads.begin','uploads.status','uploads.chunk','uploads.finish',
    'uploads.cancel','downloads.open','downloads.chunk','downloads.close','downloads.status',
    'archives.create','archives.list','archives.get','exports.create','exports.list','exports.get',
    'cleanups.prepare','cleanups.get','cleanups.commit','data.invoke','file.operations.get','storage.status'))
ENROLL_METHODS = frozenset(('receivers.challenge','receivers.enroll'))

class M5Error(Exception):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code, self.status = code, status

def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',',':'))

def fields(value, required=(), optional=()):
    if not isinstance(value,dict) or not set(required)<=value.keys() or value.keys()-set(required)-set(optional):
        raise M5Error('INVALID_FIELDS')

def identifier(value):
    if not isinstance(value,str) or not re.fullmatch('[A-Za-z0-9_-]{16,80}',value):
        raise M5Error('INVALID_IDENTIFIER')
    return value

def sha256(value):
    if not isinstance(value,str) or not re.fullmatch('[a-f0-9]{64}',value):
        raise M5Error('INVALID_SHA256')
    return value

def integer(value, maximum, minimum=0):
    if type(value) is not int or not minimum<=value<=maximum: raise M5Error('INVALID_INTEGER')
    return value

def schema(mode): return 'daty-mqtt-'+mode+'-v1'
def prefix(mode): return 'daty/prototype/v2/'+SERVER+'/'+mode
def topic(mode, suffix): return 'daty/v2/'+SERVER+'/'+mode+'/'+suffix

def validate_request(request, mode):
    fields(request,('schema','server_id','boot_id','client_session_id','request_id','method','deadline_at_ms','body'))
    methods = FILE_METHODS if mode=='files' else ENROLL_METHODS
    if request['schema']!=schema(mode) or request['server_id']!=SERVER or request['method'] not in methods:
        raise M5Error('INVALID_M5_REQUEST')
    for k in ('boot_id','client_session_id','request_id'): identifier(request[k])
    if type(request['deadline_at_ms']) is not int or not isinstance(request['body'],dict): raise M5Error('INVALID_REQUEST')
    if len(encoded(request).encode())>(16384 if mode=='enrollment' else MAX_BYTES): raise M5Error('MESSAGE_TOO_LARGE',413)
    return request
