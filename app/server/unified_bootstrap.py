"""Strict candidate database bootstrap, before any listener or receiver work.

Existing files are schema-checked read-only before opening for writes. Only a
previously nonexistent path exclusively created by this call may be initialized
as a new empty database. No repair, reset, legacy import, or archive activation.
"""
from pathlib import Path
import sqlite3

import unified_database as database
from unified_schema import LEGACY_DDL, SchemaError, validate_schema


class _Connection(sqlite3.Connection):
    pass


def _path(value):
    path = Path(value).absolute()
    for item in (path, *path.parents):
        if item.is_symlink() or (hasattr(item, 'is_junction') and item.is_junction()):
            raise database.DatabaseError('Database path contains a link', status=503, code='SCHEMA_UNSUPPORTED')
    path = path.resolve()
    if not path.parent.is_dir() or path.name.endswith(('-wal', '-shm', '-journal')):
        raise database.DatabaseError('Database path is invalid', status=503, code='SCHEMA_UNSUPPORTED')
    if path.exists() and (not path.is_file() or path.stat().st_nlink != 1):
        raise database.DatabaseError('Database must be an ordinary file', status=503, code='SCHEMA_UNSUPPORTED')
    return path


def _supported(connection):
    try:
        return validate_schema(connection)
    except (SchemaError, sqlite3.DatabaseError) as error:
        raise database.DatabaseError('Existing database schema is unsupported; no repair was attempted',
                                     status=503, code='SCHEMA_UNSUPPORTED') from error


def open_database(value, *, timeout=5):
    """Return the original Row/thread-compatible connection without setting WAL.

    An existing empty/corrupt file is not a request to create a new database.
    A failed newly-created bootstrap leaves its file for manual inspection.
    """
    path = _path(value)
    created = False
    if path.exists():
        reader = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=timeout)
        try:
            reader.execute('PRAGMA query_only=ON')
            reader.execute('PRAGMA trusted_schema=OFF')
            reader.execute('BEGIN')
            _supported(reader)
        finally:
            reader.close()
    else:
        if any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')):
            raise database.DatabaseError('New database has pre-existing sidecars', status=503, code='SCHEMA_UNSUPPORTED')
        # No exists()+connect(create) race can mistake another process's file
        # for an authorized new database: exclusive creation must succeed.
        with path.open('xb'):
            pass
        created = True
    identity = path.stat().st_dev, path.stat().st_ino
    connection = sqlite3.connect(path.as_uri() + '?mode=rw', uri=True, timeout=timeout,
                                 check_same_thread=False, factory=_Connection)
    try:
        if _path(path) != path or identity != (path.stat().st_dev, path.stat().st_ino):
            raise database.DatabaseError('Database changed during opening', status=503, code='SCHEMA_UNSUPPORTED')
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        connection._daty_created_here = created
        return connection
    except Exception:
        connection.close()
        raise


def initialize(connection, now_ms):
    """Caller commits/rolls back; all CREATE/ALTER/default rows are one transaction."""
    database._int(now_ms, 'Server time')
    database._begin(connection)
    empty = connection.execute('SELECT 1 FROM sqlite_master LIMIT 1').fetchone() is None
    if empty:
        if (getattr(connection, '_daty_created_here', False) is not True
                or connection.execute('PRAGMA user_version').fetchone()[0] != 0
                or connection.execute('PRAGMA application_id').fetchone()[0] != 0):
            raise database.DatabaseError('An existing empty file is not a new-database request',
                                         status=503, code='SCHEMA_UNSUPPORTED')
        for statement in LEGACY_DDL:
            connection.execute(statement)
        connection.execute('INSERT INTO projects VALUES(?,?,?,?,?)',
                           ('default', '默认项目', '{}', now_ms / 1000, now_ms / 1000))
    else:
        # Pin and repeat the gate inside the caller's transaction, not only at
        # the earlier read-only open. No missing object is filled in beforehand.
        _supported(connection)
    return database.migrate(connection, now_ms)


def enable_wal(connection):
    """Called only after successful bootstrap COMMIT, under the original lock."""
    if connection.in_transaction:
        raise database.DatabaseError('Bootstrap must commit before WAL configuration', status=503)
    _supported(connection)
    if connection.execute('PRAGMA journal_mode=WAL').fetchone()[0].lower() != 'wal':
        raise database.DatabaseError('Database WAL configuration failed', status=503)
