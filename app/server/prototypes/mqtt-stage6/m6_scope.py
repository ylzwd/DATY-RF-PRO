"""Explicit, leased runtime resources; no fixture markers or permissive switch.

Opening this context validates an EXISTING database epoch/schema and matching
TLS trust identity. Provisioning, copying data and changing Windows tasks remain
separate deployment actions. This module never creates a replacement identity.
"""
from contextlib import closing
import ipaddress
import json
from pathlib import Path
import socket
import sqlite3

from command_journal import ProcessLease
from receiver_pairing import ReceiverPairingPolicy
from security_storage import validate_path
from tls_support import load_config
from unified_schema import validate_schema
import unified_database as db


def plain_path(value):
    if not isinstance(value,str) or not Path(value).is_absolute():
        raise ValueError('Runtime resources require absolute paths')
    path=Path(value).absolute()
    for part in (path,*path.parents):
        if part.is_symlink() or (hasattr(part,'is_junction') and part.is_junction()):
            raise ValueError('Runtime resource links forbidden')
    if path.is_file() and path.stat().st_nlink!=1:
        raise ValueError('Runtime resource hardlinks forbidden')
    return path.resolve()


def validate_database(database, expected_epoch, *, full_check=False):
    """Read-only startup metadata checks; full scans are explicit maintenance.

    Routine startup must not walk all telemetry pages before opening the web
    listener. SQLite WAL recovery and normal read/write error handling remain
    enabled. full_check=True is for an explicitly arranged maintenance window.
    Metadata validation alone does not certify every historical row or page.
    """
    with closing(sqlite3.connect(database.as_uri()+'?mode=ro',uri=True)) as connection:
        connection.row_factory=sqlite3.Row
        validate_schema(connection)
        if connection.execute('PRAGMA journal_mode').fetchone()[0].lower()!='wal':
            raise ValueError('Existing WAL database required')
        if db.status(connection)['epoch']!=expected_epoch:
            raise ValueError('Business database epoch changed')
        if full_check:
            if [row[0] for row in connection.execute('PRAGMA quick_check')]!=['ok']:
                raise ValueError('Business database integrity failed')
            if connection.execute('PRAGMA foreign_key_check').fetchone() is not None:
                raise ValueError('Business database foreign keys failed')


class RuntimeScope:
    FIELDS={'schema','database','database_epoch','archives','staging','runtime_directory',
            'pairing','tls','ca_sha256','bind_host','mqtt_port','web_port','public_directory'}

    def __init__(self,config):
        config_path=plain_path(str(config))
        if config_path.stat().st_size>32768:raise ValueError('Runtime config too large')
        settings=json.loads(config_path.read_text('utf-8-sig'))
        if set(settings)!=self.FIELDS or settings['schema']!='daty-mqtt6-runtime-v1':
            raise ValueError('Invalid runtime config')
        self.closed=True;self.lease=None;self.mqtt_socket=None;self.web_socket=None
        for name in ('database','archives','staging','runtime_directory','pairing','tls','public_directory'):
            setattr(self,name,plain_path(settings[name]))
        data_dirs=(self.archives,self.staging,self.runtime_directory)
        if any(a.is_relative_to(b) or b.is_relative_to(a) for i,a in enumerate(data_dirs) for b in data_dirs[i+1:]):
            raise ValueError('Runtime, staging and archive directories must be separate')
        if any(self.database.is_relative_to(p) for p in data_dirs):
            raise ValueError('Database cannot be stored in removable/generated directories')
        private=(*data_dirs,self.database,self.pairing,self.tls)
        if any(p.is_relative_to(self.public_directory) or self.public_directory.is_relative_to(p) for p in private):
            raise ValueError('Runtime resources must be outside public assets')
        if any(self.pairing.is_relative_to(p) or self.tls.is_relative_to(p) for p in data_dirs):
            raise ValueError('Existing identities must be outside generated runtime data')
        validate_path(self.pairing);validate_path(self.tls)
        self.material,self.tls_metadata=load_config(self.tls)
        if settings['ca_sha256']!=self.tls_metadata['ca_sha256']:
            raise ValueError('Runtime trust identity changed')
        self.policy=ReceiverPairingPolicy(self.pairing)
        self.policy._load()  # Validate without rewriting credentials or GROUP.
        if not self.database.is_file():raise ValueError('Existing business database required')
        validate_database(self.database, settings['database_epoch'])
        self.epoch=settings['database_epoch']
        self.bind_host=str(ipaddress.IPv4Address(settings['bind_host']))
        for name in ('mqtt_port','web_port'):
            port=settings[name]
            if type(port) is not int or not 0<=port<=65535:raise ValueError('Invalid listener port')
            setattr(self,name,port)
        if not (self.public_directory/'unirf-app.html').is_file():raise ValueError('Built server page required')
        from m6_static import verify_assets
        verify_assets(self.public_directory)
        try:
            self.runtime_directory.mkdir(parents=True,exist_ok=True)
            self.lease=ProcessLease(str(self.database)+'.mqtt6-runtime-owner.lock')
            # Reserve both public ports exclusively BEFORE importing Bridge (its
            # import opens SQLite). Never evict an old server or use SO_REUSEADDR.
            self.mqtt_socket=self.reserve(self.mqtt_port)
            self.web_socket=self.reserve(self.web_port)
            self.closed=False
        except BaseException:
            self.close();raise

    def reserve(self,port):
        sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
        try:
            if hasattr(socket,'SO_EXCLUSIVEADDRUSE'):
                sock.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
            sock.bind((self.bind_host,port));sock.listen(128)
            return sock
        except BaseException:sock.close();raise

    def check_bridge(self,bridge):
        if self.closed or plain_path(str(bridge._db_path))!=self.database or plain_path(str(bridge._pairing_policy.path))!=self.pairing:
            raise ValueError('Bridge does not match leased runtime resources')

    def check_database(self,path):
        if self.closed or plain_path(str(path))!=self.database:raise ValueError('Unleased database')

    def check_staging(self,path):
        if self.closed or plain_path(str(path))!=self.staging:raise ValueError('Unleased staging path')

    def close(self):
        self.closed=True
        for name in ('mqtt_socket','web_socket'):
            sock=getattr(self,name,None)
            if sock:sock.close();setattr(self,name,None)
        if self.lease:self.lease.close();self.lease=None


def checked_scope(scope):
    if type(scope) is not RuntimeScope or scope.closed or not scope.lease:
        raise ValueError('A validated live runtime resource scope is required')
    return scope
