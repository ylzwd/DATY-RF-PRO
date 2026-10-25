"""Exact supported-schema verification with no file or caller-database writes.

Reference DDL is trusted application code, never DDL found in a selected file.
The unified reference is built from the current candidate schema_statements(),
not migrate(), so the migrator may call this module without a dependency cycle.
Legacy schema is the unchanged seven-table mqtt-bridge.py _init_database schema.
"""
import hashlib
import json
import re
import sqlite3


LEGACY_DDL = (
    """CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
       project_json TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL, updated_at REAL NOT NULL)""",
    """CREATE TABLE project_devices (project_id TEXT NOT NULL, device_id TEXT NOT NULL,
       device_json TEXT NOT NULL, PRIMARY KEY(project_id, device_id),
       FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE)""",
    """CREATE TABLE scan_datasets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
       points_json TEXT NOT NULL, source TEXT NOT NULL, created_at REAL NOT NULL,
       FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE)""",
    """CREATE TABLE coordination_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
       input_json TEXT NOT NULL, result_json TEXT NOT NULL, baseline_json TEXT,
       created_at REAL NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE)""",
    """CREATE TABLE commands (command_id TEXT PRIMARY KEY, device_id TEXT, command TEXT NOT NULL,
       expected_json TEXT, actual_json TEXT, status TEXT NOT NULL, error TEXT,
       created_at REAL NOT NULL, updated_at REAL NOT NULL, acknowledged_at REAL)""",
    """CREATE TABLE telemetry_samples (id INTEGER PRIMARY KEY AUTOINCREMENT,
       device_id TEXT NOT NULL, ts REAL NOT NULL, frequency_khz INTEGER, rf_dbm REAL,
       af_dbfs REAL, battery_percent REAL, muted INTEGER, status TEXT)""",
    'CREATE INDEX idx_telemetry_device_ts ON telemetry_samples(device_id, ts DESC)',
    """CREATE TABLE timeline_events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT,
       ts REAL NOT NULL, event_type TEXT NOT NULL, device_id TEXT, command_id TEXT,
       summary TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}')""",
    'CREATE INDEX idx_timeline_ts ON timeline_events(ts DESC)',
)
LEGACY_TABLES = frozenset({'projects', 'project_devices', 'scan_datasets',
    'coordination_runs', 'commands', 'telemetry_samples', 'timeline_events'})


class SchemaError(ValueError):
    code = 'SCHEMA_UNSUPPORTED'
    status = 503


def _quote(value):
    return '"' + value.replace('"', '""') + '"'


def _sql_tokens(sql):
    # Preserve quoted data/identifier tokens, ignoring only insignificant SQL
    # whitespace and case in unquoted keywords. CHECK/partial index expressions
    # remain part of the fingerprint, unlike PRAGMA table_info alone.
    if sql is None:
        return None
    tokens = re.findall(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_]\w*|\d+(?:\.\d+)?|[^\s]", sql)
    result, index = [], 0
    while index < len(tokens):
        if [t.lower() for t in tokens[index:index + 3]] == ['if', 'not', 'exists']:
            index += 3
            continue
        token = tokens[index]
        result.append(token if token[:1] in ('\'', '"', '`', '[') else token.lower())
        index += 1
    return result


def describe_schema(connection):
    """Metadata only. Includes indexes, hidden columns, FK, CHECK and STRICT."""
    objects = connection.execute('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').fetchall()
    if any(row[0] not in ('table', 'index') for row in objects):
        raise SchemaError('Views/triggers and unknown schema objects are unsupported')
    tables, indexes = {}, {}
    for kind, name, owner, sql in objects:
        if kind == 'table':
            if name.startswith('sqlite_') and name != 'sqlite_sequence':
                raise SchemaError('Unknown internal table is unsupported')
            if sql and re.search(r'\bvirtual\s+table\b', sql, re.I):
                raise SchemaError('Virtual tables are unsupported')
            columns = [tuple(row) for row in connection.execute('PRAGMA main.table_xinfo(' + _quote(name) + ')')]
            foreign = [tuple(row) for row in connection.execute('PRAGMA main.foreign_key_list(' + _quote(name) + ')')]
            listed = [tuple(row)[1:] for row in connection.execute('PRAGMA main.index_list(' + _quote(name) + ')')]
            tables[name] = {'sql': _sql_tokens(sql), 'columns': columns,
                            'foreign_keys': sorted(foreign), 'indexes': sorted(listed)}
        else:
            indexes[name] = {'owner': owner, 'sql': _sql_tokens(sql),
                'columns': [tuple(row) for row in connection.execute('PRAGMA main.index_xinfo(' + _quote(name) + ')')]}
    flags = sorted(tuple(row)[1:] for row in connection.execute('PRAGMA main.table_list')
                   if row[0] == 'main' and row[1] != 'sqlite_schema')
    return {'tables': tables, 'indexes': indexes, 'table_flags': flags,
            'application_id': connection.execute('PRAGMA main.application_id').fetchone()[0],
            'user_version': connection.execute('PRAGMA main.user_version').fetchone()[0]}


def schema_fingerprint(description):
    encoded = json.dumps(description, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _reference(variant, version=None):
    # Lazy import prevents unified_database -> unified_schema -> database cycle.
    import unified_database as database
    connection = sqlite3.connect(':memory:')
    try:
        connection.execute('PRAGMA foreign_keys=ON')
        for sql in LEGACY_DDL:
            connection.execute(sql)
        if variant != 'legacy':
            connection.execute('ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
        if variant == 'unified':
            for sql in database.schema_statements(version or database.SCHEMA_VERSION):
                connection.execute(sql)
            connection.execute('PRAGMA user_version=' + str(version or database.SCHEMA_VERSION))
        return describe_schema(connection)
    finally:
        connection.close()


def _identity_metadata(connection):
    import unified_database as database
    rows = connection.execute('SELECT version,checksum,applied_at_ms FROM db_schema_migrations ORDER BY version').fetchall()
    version=connection.execute('PRAGMA user_version').fetchone()[0]
    expected=database.migration_checksums(version)
    checksum=expected[-1][1]
    if ([tuple(row[:2]) for row in rows] != expected
            or any(type(row[2]) is not int or row[2]<0 for row in rows)):
        raise SchemaError('Database migration version/checksum is unsupported')
    identities = connection.execute('SELECT singleton,instance_id,epoch,created_at_ms FROM db_identity').fetchall()
    if len(identities) != 1 or identities[0][0] != 1:
        raise SchemaError('Database identity must be a single valid row')
    _, instance, epoch, created = identities[0]
    for text in (instance, epoch):
        if (not isinstance(text, str) or not text.strip() or len(text) > 512
                or any(ord(c) < 32 or ord(c) == 127 for c in text)):
            raise SchemaError('Database identity/epoch is invalid')
        try:
            text.encode('utf-8', errors='strict')
        except UnicodeError as error:
            raise SchemaError('Database identity/epoch encoding is invalid') from error
    if type(created) is not int or created < 0:
        raise SchemaError('Database identity time is invalid')
    return {'instance_id': instance, 'epoch': epoch, 'migration_checksum': checksum}


def validate_schema(connection, *, allow_legacy=True, verify_metadata=True):
    """Validate main against trusted exact schemas without modifying caller DB.

    verify_metadata=False is only for a migrator checking DDL before identity
    insertion. Backup verification must retain the default True.
    """
    import unified_database as database
    actual = describe_schema(connection)
    tables = set(actual['tables']) - {'sqlite_sequence'}
    version=actual['user_version']
    variants = ['unified'] if version in (1,2,3) and tables == database.supported_tables(version) else (
        ['legacy', 'legacy-revision'] if allow_legacy and tables == LEGACY_TABLES else [])
    for variant in variants:
        version=actual['user_version']
        if variant=='unified' and version not in (1,2,3):
            continue
        if actual == _reference(variant,version):
            metadata = _identity_metadata(connection) if variant == 'unified' and verify_metadata else {}
            return {'schema_kind': variant, 'schema_version': actual['user_version'],
                    'schema_sha256': schema_fingerprint(actual),
                    'tables': sorted(tables), 'system_tables': ['sqlite_sequence'], **metadata}
    raise SchemaError('Database tables/columns/keys/constraints/indexes do not match a supported schema')
