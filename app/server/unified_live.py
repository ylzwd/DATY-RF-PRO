"""Receiver-independent persistence of already verified Bridge observations.

No connection, socket, commit, device lookup or ACK decision occurs here. The
caller supplies trusted Bridge snapshots/command records and owns transaction,
lock, commit/rollback and storage-failure reporting. Database history must never
be inserted back into the Bridge's active control-target/session dictionaries.
"""
import hashlib
import ipaddress
import json
from functools import lru_cache
import math
import re
import rf_sample_storage


PROTOCOL = 'daty-unified-live-v1'
MAX_INTEGER = 9007199254740991
_CONTROL_TEXT = re.compile(r'[\x00-\x1f\x7f]')
BASE_TABLES = ('live_boots', 'live_receivers', 'live_channels', 'live_sessions',
          'live_latest', 'live_samples', 'live_events', 'live_commands', 'live_command_events')
TABLES = (*BASE_TABLES, *rf_sample_storage.TABLES)


class LiveStoreError(ValueError):
    """Invalid input or identity; messages intentionally contain no input values."""


def schema_statements(version=3):
    """Single statements for the caller's versioned, transactional migrator."""
    base = (
        '''CREATE TABLE IF NOT EXISTS live_boots (
          boot_id TEXT PRIMARY KEY, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER)''',
        '''CREATE UNIQUE INDEX IF NOT EXISTS idx_live_active_boot
          ON live_boots((1)) WHERE ended_at_ms IS NULL''',
        '''CREATE TABLE IF NOT EXISTS live_receivers (
          receiver_id TEXT PRIMARY KEY, receiver_mac TEXT, receiver_ip TEXT,
          brand TEXT, model TEXT, group_number INTEGER, first_seen_at_ms INTEGER NOT NULL,
          observed_at_ms INTEGER NOT NULL, metadata_json TEXT NOT NULL)''',
        '''CREATE UNIQUE INDEX IF NOT EXISTS idx_live_receiver_mac
          ON live_receivers(receiver_mac) WHERE receiver_mac IS NOT NULL''',
        '''CREATE TABLE IF NOT EXISTS live_channels (
          device_id TEXT PRIMARY KEY, receiver_id TEXT NOT NULL, channel_number INTEGER NOT NULL,
          name TEXT, first_seen_at_ms INTEGER NOT NULL, observed_at_ms INTEGER NOT NULL,
          UNIQUE(receiver_id,channel_number),
          FOREIGN KEY(receiver_id) REFERENCES live_receivers(receiver_id))''',
        '''CREATE TABLE IF NOT EXISTS live_sessions (
          session_id TEXT PRIMARY KEY, boot_id TEXT NOT NULL, receiver_id TEXT NOT NULL,
          source_key TEXT, started_at_ms INTEGER NOT NULL, observed_at_ms INTEGER NOT NULL,
          ended_at_ms INTEGER, end_reason TEXT,
          FOREIGN KEY(boot_id) REFERENCES live_boots(boot_id),
          FOREIGN KEY(receiver_id) REFERENCES live_receivers(receiver_id))''',
        '''CREATE INDEX IF NOT EXISTS idx_live_session_receiver
          ON live_sessions(receiver_id,boot_id,ended_at_ms)''',
        '''CREATE TABLE IF NOT EXISTS live_latest (
          device_id TEXT PRIMARY KEY, boot_id TEXT NOT NULL, session_id TEXT NOT NULL,
          observed_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER, declared_online INTEGER,
          removed INTEGER NOT NULL DEFAULT 0, frequency_khz INTEGER, rf_dbm REAL, af_dbfs REAL,
          battery_percent REAL, muted INTEGER, reported_status TEXT, snapshot_json TEXT NOT NULL,
          FOREIGN KEY(device_id) REFERENCES live_channels(device_id),
          FOREIGN KEY(session_id) REFERENCES live_sessions(session_id))''',
        '''CREATE TABLE IF NOT EXISTS live_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, boot_id TEXT NOT NULL,
          session_id TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER,
          frequency_khz INTEGER, rf_dbm REAL, af_dbfs REAL, battery_percent REAL, muted INTEGER,
          declared_online INTEGER, reported_status TEXT, snapshot_json TEXT NOT NULL,
          snapshot_sha256 TEXT NOT NULL, sample_kind TEXT NOT NULL DEFAULT 'bridge-snapshot',
          UNIQUE(device_id,boot_id,observed_at_ms,snapshot_sha256))''',
        '''CREATE INDEX IF NOT EXISTS idx_live_sample_device_time
          ON live_samples(device_id,observed_at_ms,id)''',
        '''CREATE TABLE IF NOT EXISTS live_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL, device_id TEXT, receiver_id TEXT, boot_id TEXT NOT NULL,
          observed_at_ms INTEGER NOT NULL, origin TEXT NOT NULL DEFAULT 'bridge.snapshot',
          details_json TEXT NOT NULL)''',
        '''CREATE INDEX IF NOT EXISTS idx_live_events_time ON live_events(observed_at_ms,id)''',
        '''CREATE TABLE IF NOT EXISTS live_commands (
          command_id TEXT PRIMARY KEY, device_id TEXT, receiver_id TEXT, channel_number INTEGER,
          command TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER, updated_at_ms INTEGER,
          acknowledged_at_ms INTEGER, observed_at_ms INTEGER NOT NULL, ack_round_trip_ms REAL,
          target_json TEXT NOT NULL, actor_json TEXT NOT NULL, expected_json TEXT NOT NULL,
          actual_json TEXT NOT NULL, record_json TEXT NOT NULL,
          origin TEXT NOT NULL DEFAULT 'bridge.command-record')''',
        '''CREATE TABLE IF NOT EXISTS live_command_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL, record_sha256 TEXT NOT NULL,
          status TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, record_json TEXT NOT NULL,
          origin TEXT NOT NULL DEFAULT 'bridge.command-record', UNIQUE(command_id,record_sha256))''',
        '''CREATE INDEX IF NOT EXISTS idx_live_command_events_id
          ON live_command_events(command_id,id)''',
    )
    return (*base, *rf_sample_storage.DDL) if version >= 3 else base


def _begin(connection):
    if not connection.in_transaction:
        connection.execute('BEGIN IMMEDIATE')


def _text(value, required=False):
    if value is None and not required:
        return None
    if not isinstance(value, str) or (required and not value.strip()):
        raise LiveStoreError('Identity and text fields must be valid text')
    try:
        value.encode('utf-8', 'strict')
    except UnicodeError as failure:
        raise LiveStoreError('Invalid Unicode text') from failure
    if _CONTROL_TEXT.search(value):
        raise LiveStoreError('Control characters are not allowed in identity fields')
    return value


def _integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_INTEGER:
        raise LiveStoreError('Expected a safe integer in the supported range')
    return value


def _number(value, minimum=-math.inf, maximum=math.inf):
    if type(value) not in (int, float):
        return None
    try:
        return value if math.isfinite(value) and minimum <= value <= maximum else None
    except OverflowError:
        return None


def _seconds_ms(value):
    value = _number(value, 0, MAX_INTEGER / 1000)
    return None if value is None else round(value * 1000)


def _bool(value):
    return int(value) if type(value) is bool else None


@lru_cache(maxsize=512)
def _short_secret_key(key):
    normalized = re.sub('[^a-z0-9]', '', key.lower())
    return (any(part in normalized for part in ('password', 'secret', 'privatekey', 'bearer', 'authorization', 'token'))
            or normalized in {'token', 'accesstoken', 'refreshtoken', 'apikey', 'accesskey',
                              'pairing', 'credentials', 'credential', 'cookie', 'setcookie', 'csrf'})


def _secret_key(key):
    # Cache common field names only, never retain arbitrarily large extensions.
    return _short_secret_key(key) if len(key) <= 128 else _short_secret_key.__wrapped__(key)


def _clean(value, depth=0, seen=None):
    """Keep ordinary JSON extensions, never credentials attached to a DTO."""
    if depth > 64:
        raise LiveStoreError('Observation JSON is too deeply nested')
    if value is None or type(value) is bool:
        return value
    if isinstance(value, str):
        try:
            value.encode('utf-8', 'strict')
        except UnicodeError as failure:
            raise LiveStoreError('Invalid JSON Unicode') from failure
        return value
    if type(value) in (int, float):
        return _number(value)
    if type(value) not in (dict, list):
        raise LiveStoreError('Observation extensions must be ordinary JSON')
    seen = set() if seen is None else seen
    if id(value) in seen:
        raise LiveStoreError('Observation JSON cannot contain cycles')
    seen.add(id(value))
    try:
        if isinstance(value, list):
            return [_clean(item, depth + 1, seen) for item in value]
        result = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise LiveStoreError('Observation JSON keys must be strings')
            if not _secret_key(key):
                result[key] = _clean(item, depth + 1, seen)
        return result
    finally:
        seen.remove(id(value))


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':'))


def _digest(value):
    return hashlib.sha256(_json(value).encode('utf-8')).hexdigest()


def _small_strings(values):
    # Pure-result caches contain only bounded immutable identity fields. Never
    # cache observations, database rows, authorization or online/session state.
    return all(value is None or type(value) is str and len(value) <= 256 for value in values)


@lru_cache(maxsize=512)
def _normalized_mac(value):
    if not isinstance(value, str) or not re.fullmatch(r'(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}|[0-9a-fA-F]{12}', value):
        raise LiveStoreError('Receiver MAC is invalid')
    compact = value.replace(':', '').replace('-', '').upper()
    return ':'.join(compact[index:index + 2] for index in range(0, 12, 2))


@lru_cache(maxsize=512)
def _normalized_ip(value):
    try:
        return str(ipaddress.ip_address(value))
    except ValueError as failure:
        raise LiveStoreError('Receiver peer IP is invalid') from failure


@lru_cache(maxsize=512)
def _receiver_metadata(mac, ip, brand, model, group):
    return _json(dict(receiver_mac=mac, receiver_ip=ip, brand=brand, model=model, group_number=group))


@lru_cache(maxsize=1024)
def _session_digest(boot_id, receiver, source):
    return _digest([boot_id, receiver, source])


def _row(connection, sql, values=()):
    cursor = connection.execute(sql, values)
    result = cursor.fetchone()
    return None if result is None else dict(zip((item[0] for item in cursor.description), result))


def _event(connection, kind, boot_id, observed, device=None, receiver=None, details=None):
    details = details or {}
    key = _digest([kind, boot_id, observed, device, receiver, details])
    return connection.execute('''INSERT OR IGNORE INTO live_events
      (event_key,event_type,device_id,receiver_id,boot_id,observed_at_ms,details_json)
      VALUES(?,?,?,?,?,?,?)''', (key, kind, device, receiver, boot_id, observed, _json(details))).rowcount


def _activate_boot(connection, boot_id, observed):
    previous = _row(connection, 'SELECT * FROM live_boots WHERE ended_at_ms IS NULL')
    if previous and previous['boot_id'] == boot_id:
        return
    if connection.execute('SELECT 1 FROM live_boots WHERE boot_id=?', (boot_id,)).fetchone():
        raise LiveStoreError('A finished server boot cannot become active again')
    if previous:
        if observed < previous['started_at_ms']:
            raise LiveStoreError('A stale observation cannot replace the current server boot')
        connection.execute('UPDATE live_boots SET ended_at_ms=? WHERE ended_at_ms IS NULL', (observed,))
        connection.execute("UPDATE live_sessions SET ended_at_ms=?,end_reason='server-restarted' WHERE ended_at_ms IS NULL", (observed,))
        rows = connection.execute('''SELECT l.device_id,c.receiver_id FROM live_latest l
          JOIN live_channels c ON c.device_id=l.device_id WHERE l.removed=0 AND l.declared_online=1''').fetchall()
        for device, receiver in rows:
            _event(connection, 'channel.offline', boot_id, observed, device, receiver, {'reason': 'server-restarted'})
        connection.execute('UPDATE live_latest SET declared_online=0 WHERE removed=0')
    connection.execute('INSERT INTO live_boots(boot_id,started_at_ms) VALUES(?,?)', (boot_id, observed))
    _event(connection, 'server.boot', boot_id, observed)


@lru_cache(maxsize=1024, typed=True)
def _identity_fields(device, receiver, channel, mac, ip, group, brand, model, name, source):
    """Only normalize exact metadata values; DB ownership is checked each time."""
    device, receiver, channel = _text(device, True), _text(receiver, True), _integer(channel, 1)
    if mac is not None:
        mac = (_normalized_mac(mac) if type(mac) is str and len(mac) <= 32
               else _normalized_mac.__wrapped__(mac))
    if ip is not None:
        ip = (_normalized_ip(ip) if type(ip) is str and len(ip) <= 128
              else _normalized_ip.__wrapped__(ip))
    if group is not None and type(group) is not int:
        match = re.fullmatch(r'(?:GUP|GROUP)?([1-9][0-9]*)', str(group), re.I)
        group = int(match[1]) if match else None
    group = _integer(group, 1) if group is not None else None
    return (device, receiver, channel, mac, ip, group,
            _text(brand), _text(model), _text(name), _text(source))


def _observation(value, observed):
    if type(value) is not dict:
        raise LiveStoreError('Each Bridge snapshot must be an ordinary object')
    identity = (value.get('id'), value.get('receiver_id') or value.get('_receiver_id'),
                value.get('channel_number'), value.get('receiver_mac') or value.get('mac'),
                value.get('receiver_ip') or value.get('ip') or None,
                value.get('group_number', value.get('group')), value.get('brand'),
                value.get('model'), value.get('name'), value.get('_source'))
    bounded = all(item is None or type(item) is str and len(item) <= 256
                  or type(item) is int and 0 <= item <= MAX_INTEGER for item in identity)
    device, receiver, channel, mac, ip, group, brand, model, name, source = (
        _identity_fields(*identity) if bounded else _identity_fields.__wrapped__(*identity))
    online = _bool(value.get('_online'))
    age = _number(value.get('_age_s'), 0, MAX_INTEGER / 1000)
    last_seen = (max(0, observed - round(age * 1000)) if age is not None
                 else _seconds_ms(value.get('_last_seen')))
    invalid_age = ('_age_s' in value and age is None) or ('_last_seen' in value and _seconds_ms(value['_last_seen']) is None)
    if invalid_age:
        last_seen, online = None, None
    if last_seen is None and online == 1 and not invalid_age:
        last_seen = observed  # Trusted Bridge's explicit online observation, not self-reported status.
    if last_seen is not None and last_seen > observed:
        last_seen = None
        online = None
    frequency = value.get('freq', value.get('frequency_khz'))
    frequency = frequency if type(frequency) is int and 0 < frequency <= MAX_INTEGER else None
    clean = _clean(value)
    for key in ('actor', '_authorized_actor'):
        if key in clean:
            clean[key] = _actor(clean[key])
    return dict(device_id=device, receiver_id=receiver, channel_number=channel, receiver_mac=mac,
                receiver_ip=ip, brand=brand, model=model,
                group_number=group, name=name, source_key=source,
                last_seen_at_ms=last_seen, declared_online=online, frequency_khz=frequency,
                rf_dbm=_number(value.get('rf')), af_dbfs=_number(value.get('af_dbfs'), -40, 0),
                battery_percent=_number(value.get('batt'), 0, 100), muted=_bool(value.get('muted')),
                reported_status=_text(value.get('status')) if isinstance(value.get('status'), str) else None,
                snapshot_json=_json(clean))


def record_snapshot(connection, boot_id, devices, observed_at_ms, full=False):
    """Append verified Bridge snapshots. full is a complete Bridge-wide inventory.

    No downsampling: live_samples are accepted Bridge snapshots, not original RF
    measurements. Sparse calls only update supplied channels; missing full-list
    channels are tombstoned. The caller must roll back any exception.
    """
    boot_id, observed = _text(boot_id, True), _integer(observed_at_ms)
    if type(devices) is not list or type(full) is not bool:
        raise LiveStoreError('Snapshots require an array and explicit boolean full flag')
    prepared = [_observation(value, observed) for value in devices]
    identities, receiver_channels, receiver_metadata = set(), set(), {}
    for item in prepared:
        key = (item['receiver_id'], item['channel_number'])
        if item['device_id'] in identities or key in receiver_channels:
            raise LiveStoreError('Duplicate receiver/channel identity in one snapshot')
        identities.add(item['device_id']); receiver_channels.add(key)
        metadata = tuple(item[field] for field in ('receiver_mac', 'receiver_ip', 'brand', 'model', 'group_number', 'source_key'))
        if item['receiver_id'] in receiver_metadata and receiver_metadata[item['receiver_id']] != metadata:
            raise LiveStoreError('Channels of one receiver have conflicting receiver metadata')
        receiver_metadata[item['receiver_id']] = metadata
    _begin(connection)
    _activate_boot(connection, boot_id, observed)
    result = dict(boot_id=boot_id, received=len(prepared), updated=0, samples=0, removed=0, ignored=0)
    compact = rf_sample_storage.available(connection)
    for item in prepared:
        device, receiver = item['device_id'], item['receiver_id']
        channel = _row(connection, 'SELECT * FROM live_channels WHERE device_id=?', (device,))
        if channel and (channel['receiver_id'] != receiver or channel['channel_number'] != item['channel_number']):
            raise LiveStoreError('A stored channel identity cannot be silently rebound')
        latest = _row(connection, '''SELECT observed_at_ms,removed,boot_id,frequency_khz,
          muted,declared_online,reported_status FROM live_latest WHERE device_id=?''', (device,))
        asset = _row(connection, 'SELECT * FROM live_receivers WHERE receiver_id=?', (receiver,))
        if latest and latest['observed_at_ms'] > observed or asset and asset['observed_at_ms'] > observed:
            result['ignored'] += 1
            continue
        if asset and asset['receiver_mac'] and item['receiver_mac'] and asset['receiver_mac'] != item['receiver_mac']:
            raise LiveStoreError('A stored receiver MAC cannot be silently rebound')
        if item['receiver_mac'] and connection.execute(
                'SELECT 1 FROM live_receivers WHERE receiver_mac=? AND receiver_id<>?',
                (item['receiver_mac'], receiver)).fetchone():
            raise LiveStoreError('One receiver MAC cannot create another receiver identity')
        metadata = {field: item[field] for field in ('receiver_mac', 'receiver_ip', 'brand', 'model', 'group_number')}
        metadata_args = tuple(metadata.values())
        metadata_json = (_receiver_metadata(*metadata_args) if _small_strings(metadata_args[:4])
                         else _receiver_metadata.__wrapped__(*metadata_args))
        connection.execute('''INSERT INTO live_receivers
          (receiver_id,receiver_mac,receiver_ip,brand,model,group_number,first_seen_at_ms,observed_at_ms,metadata_json)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(receiver_id) DO UPDATE SET
          receiver_mac=COALESCE(excluded.receiver_mac,live_receivers.receiver_mac),
          receiver_ip=COALESCE(excluded.receiver_ip,live_receivers.receiver_ip),
          brand=COALESCE(excluded.brand,live_receivers.brand), model=COALESCE(excluded.model,live_receivers.model),
          group_number=COALESCE(excluded.group_number,live_receivers.group_number),
          observed_at_ms=excluded.observed_at_ms,metadata_json=excluded.metadata_json''',
          (receiver, *metadata_args, observed, observed, metadata_json))
        connection.execute('''INSERT INTO live_channels
          (device_id,receiver_id,channel_number,name,first_seen_at_ms,observed_at_ms) VALUES(?,?,?,?,?,?)
          ON CONFLICT(device_id) DO UPDATE SET name=COALESCE(excluded.name,live_channels.name),observed_at_ms=excluded.observed_at_ms''',
          (device, receiver, item['channel_number'], item['name'], observed, observed))
        session_args = (boot_id, receiver, item['source_key'])
        session_id = (_session_digest(*session_args) if _small_strings(session_args)
                      else _session_digest.__wrapped__(*session_args))
        session = _row(connection, 'SELECT * FROM live_sessions WHERE session_id=?', (session_id,))
        if session and session['ended_at_ms'] is not None:
            raise LiveStoreError('A closed receiver source cannot become current again')
        connection.execute('''UPDATE live_sessions SET ended_at_ms=?,end_reason='source-replaced'
          WHERE receiver_id=? AND ended_at_ms IS NULL AND session_id<>?''', (observed, receiver, session_id))
        connection.execute('''INSERT INTO live_sessions
          (session_id,boot_id,receiver_id,source_key,started_at_ms,observed_at_ms) VALUES(?,?,?,?,?,?)
          ON CONFLICT(session_id) DO UPDATE SET observed_at_ms=excluded.observed_at_ms''',
          (session_id, boot_id, receiver, item['source_key'], observed, observed))
        fields = ('last_seen_at_ms', 'frequency_khz', 'rf_dbm', 'af_dbfs', 'battery_percent', 'muted', 'declared_online', 'reported_status', 'snapshot_json')
        values = tuple(item[field] for field in fields)
        sample_values = (*values[:-1], '{}') if compact else values
        inserted = connection.execute('''INSERT OR IGNORE INTO live_samples
          (device_id,boot_id,session_id,observed_at_ms,last_seen_at_ms,frequency_khz,rf_dbm,af_dbfs,battery_percent,
           muted,declared_online,reported_status,snapshot_json,snapshot_sha256,sample_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
          (device, boot_id, session_id, observed, *sample_values, hashlib.sha256(item['snapshot_json'].encode()).hexdigest(),
           rf_sample_storage.SAMPLE_KIND if compact else 'bridge-snapshot'))
        result['samples'] += inserted.rowcount
        if compact and inserted.rowcount:
            rf_sample_storage.store(connection, inserted.lastrowid, device, session_id, observed, item['snapshot_json'])
        connection.execute('''INSERT INTO live_latest
          (device_id,boot_id,session_id,observed_at_ms,last_seen_at_ms,frequency_khz,rf_dbm,af_dbfs,battery_percent,
           muted,declared_online,reported_status,snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(device_id) DO UPDATE SET boot_id=excluded.boot_id,session_id=excluded.session_id,
          observed_at_ms=excluded.observed_at_ms,last_seen_at_ms=excluded.last_seen_at_ms,frequency_khz=excluded.frequency_khz,
          rf_dbm=excluded.rf_dbm,af_dbfs=excluded.af_dbfs,battery_percent=excluded.battery_percent,muted=excluded.muted,
          declared_online=excluded.declared_online,reported_status=excluded.reported_status,snapshot_json=excluded.snapshot_json,removed=0''',
          (device, boot_id, session_id, observed, *values))
        meaningful = {key: item[key] for key in ('frequency_khz', 'muted', 'declared_online', 'reported_status')}
        before = {key: latest[key] for key in meaningful} if latest else None
        if not latest or latest['removed'] or latest['boot_id'] != boot_id:
            _event(connection, 'channel.observed', boot_id, observed, device, receiver, meaningful)
        elif before != meaningful:
            _event(connection, 'channel.changed', boot_id, observed, device, receiver, {'before': before, 'after': meaningful})
        result['updated'] += 1
    if full:
        cursor = connection.execute('''SELECT l.device_id,c.receiver_id FROM live_latest l JOIN live_channels c
          ON c.device_id=l.device_id WHERE l.removed=0 AND l.observed_at_ms<=?''', (observed,))
        for device, receiver in cursor.fetchall():
            if device in identities:
                continue
            # Retain a deletion watermark: an older queued delta cannot revive
            # this channel merely because its last measurement was earlier.
            connection.execute('UPDATE live_latest SET removed=1,declared_online=0,observed_at_ms=? WHERE device_id=?', (observed, device))
            _event(connection, 'channel.removed', boot_id, observed, device, receiver, {'reason': 'absent-from-full-snapshot'})
            result['removed'] += 1
    return result


def record_device_history(connection, record):
    """Append the Bridge's existing 1 Hz telemetry and device Timeline evidence.

    The caller captures the original wall time and meaningful transition before
    queuing. No throttle, identity inference, ACK or transaction boundary here.
    Both rows belong to the same per-observation savepoint in UnifiedRuntime.
    """
    device, observed = record['device_id'], record['ts']
    if record.get('sample') is not None:
        sample = record['sample']
        connection.execute('''INSERT INTO telemetry_samples
          (device_id,ts,frequency_khz,rf_dbm,af_dbfs,battery_percent,muted,status)
          VALUES(?,?,?,?,?,?,?,?)''',
          (device, observed, *(sample.get(key) for key in ('freq', 'rf', 'af_dbfs', 'batt', 'muted', 'status'))))
    if False:  # Retired Timeline audit copy; telemetry above remains enabled.
        event = record['event']
        connection.execute('''INSERT INTO timeline_events
          (project_id,ts,event_type,device_id,command_id,summary,details_json)
          VALUES('default',?,?,?,?,?,?)''',
          (observed, event['event_type'], device, None, event['summary'], _json(event['details'])))


def _actor(value):
    if not isinstance(value, dict):
        return {}
    return {key: _text(value[key]) for key in ('id', 'name', 'role') if isinstance(value.get(key), str)}


def record_command(connection, record, observed_at_ms):
    """Persist existing Bridge decisions, not raw device ACK or HTTP acceptance.

    No ACK recalculation, status promotion, retry or command sending. Every
    distinct observed record is immutable evidence; late records cannot regress
    a newer/terminal latest record. No credentials are retained in JSON.
    """
    observed = _integer(observed_at_ms)
    if type(record) is not dict:
        raise LiveStoreError('A verified Bridge command record is required')
    identifier = _text(record.get('command_id'), True)
    command, status = record.get('command'), record.get('status')
    if command not in ('mute', 'unmute', 'set_freq') or status not in ('prepared', 'published', 'acknowledged', 'failed', 'timeout'):
        raise LiveStoreError('Unsupported Bridge command or status')
    cleaned = _clean(record)
    cleaned['actor'] = _actor(record.get('actor'))
    cleaned.pop('_authorized_actor', None)
    encoded, digest = _json(cleaned), _digest(cleaned)
    fields = ('device_id', 'target_device_ids', 'receiver_id', 'receiver_ip', 'receiver_mac',
              'channel_number', 'channel', 'brand', 'expected_brand', 'client_request_id', 'published_subscribers')
    target = {key: cleaned[key] for key in fields if key in cleaned}
    device = _text(record.get('device_id'))
    receiver = _text(record.get('receiver_id'))
    channel = record.get('channel_number', record.get('channel'))
    channel = _integer(channel, 1) if channel is not None else None
    created, updated, acknowledged = (_seconds_ms(record.get(key)) for key in ('created_at', 'updated_at', 'acknowledged_at'))
    _begin(connection)
    previous = _row(connection, 'SELECT * FROM live_commands WHERE command_id=?', (identifier,))
    if previous and (previous['command'] != command or previous['device_id'] != device or previous['receiver_id'] != receiver or previous['channel_number'] != channel):
        raise LiveStoreError('An existing command cannot be rebound to another target')
    if previous:
        prior_target = json.loads(previous['target_json'])
        stable = {key: value for key, value in target.items() if key != 'published_subscribers'}
        prior_stable = {key: value for key, value in prior_target.items() if key != 'published_subscribers'}
        if _json(stable) != _json(prior_stable) or previous['expected_json'] != _json(cleaned.get('expected_value')):
            raise LiveStoreError('An existing command cannot change its target or expected value')
    inserted = connection.execute('''INSERT OR IGNORE INTO live_command_events
      (command_id,record_sha256,status,observed_at_ms,record_json) VALUES(?,?,?,?,?)''',
      (identifier, digest, status, observed, encoded)).rowcount
    newer = not previous or ((updated if updated is not None else observed) >=
                            (previous['updated_at_ms'] if previous['updated_at_ms'] is not None else previous['observed_at_ms'])
                            and (previous['status'] in ('prepared', 'published') or previous['status'] == status)
                            and not (previous['status'] == 'published' and status == 'prepared'))
    if newer:
        connection.execute('''INSERT INTO live_commands
          (command_id,device_id,receiver_id,channel_number,command,status,created_at_ms,updated_at_ms,acknowledged_at_ms,
           observed_at_ms,ack_round_trip_ms,target_json,actor_json,expected_json,actual_json,record_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET
          status=excluded.status,updated_at_ms=excluded.updated_at_ms,acknowledged_at_ms=excluded.acknowledged_at_ms,
          observed_at_ms=excluded.observed_at_ms,ack_round_trip_ms=excluded.ack_round_trip_ms,target_json=excluded.target_json,
          actor_json=excluded.actor_json,actual_json=excluded.actual_json,record_json=excluded.record_json''',
          (identifier, device, receiver, channel, command, status, created, updated, acknowledged, observed,
           _number(record.get('ack_round_trip_ms'), 0), _json(target), _json(cleaned['actor']),
           _json(cleaned.get('expected_value')), _json(cleaned.get('actual_value')), encoded))
    return {'command_id': identifier, 'event_inserted': bool(inserted), 'latest_updated': bool(newer)}


def _channel_rows(connection, receiver_id=None, cursor=None, limit=None):
    clauses, values = [], []
    if receiver_id is not None:
        clauses.append('c.receiver_id=?'); values.append(_text(receiver_id, True))
    if cursor is not None:
        clauses.append('c.device_id>?'); values.append(_text(cursor, True))
    sql = '''SELECT c.*,r.receiver_mac,r.receiver_ip,r.brand,r.model,r.group_number,
      l.boot_id,l.session_id,l.last_seen_at_ms,l.declared_online,l.removed,l.frequency_khz,l.rf_dbm,l.af_dbfs,
      l.battery_percent,l.muted,l.reported_status,l.snapshot_json,l.observed_at_ms AS snapshot_at_ms,
      s.ended_at_ms AS session_ended_at_ms,b.ended_at_ms AS boot_ended_at_ms
      FROM live_channels c JOIN live_receivers r ON r.receiver_id=c.receiver_id
      JOIN live_latest l ON l.device_id=c.device_id JOIN live_sessions s ON s.session_id=l.session_id
      JOIN live_boots b ON b.boot_id=l.boot_id'''
    if clauses:
        sql += ' WHERE ' + ' AND '.join(clauses)
    sql += ' ORDER BY c.device_id'
    if limit is not None:
        sql += ' LIMIT ?'; values.append(limit)
    result = connection.execute(sql, values)
    names = [item[0] for item in result.description]
    return [dict(zip(names, row)) for row in result]


def _online(row, boot_id, now, window):
    seen = row['last_seen_at_ms']
    return (row['boot_id'] == boot_id and row['boot_ended_at_ms'] is None and row['session_ended_at_ms'] is None
            and not row['removed'] and row['declared_online'] == 1 and seen is not None and 0 <= now - seen < window)


def query_channels(connection, boot_id, now_ms, limit=50, cursor=None, receiver_id=None, online_window_ms=15000):
    """Stable ID cursor over current AND historical/removed channel assets."""
    boot_id, now = _text(boot_id, True), _integer(now_ms)
    _integer(limit, 1); _integer(online_window_ms, 1)
    if limit > 500:
        raise LiveStoreError('Channel page limit cannot exceed 500')
    rows = _channel_rows(connection, receiver_id, cursor, limit + 1)
    output = []
    for row in rows[:limit]:
        online = _online(row, boot_id, now, online_window_ms)
        snapshot = json.loads(row['snapshot_json'])
        snapshot.update(id=row['device_id'], receiver_id=row['receiver_id'], channel_number=row['channel_number'],
                        receiver_mac=row['receiver_mac'], receiver_ip=row['receiver_ip'], brand=row['brand'], model=row['model'],
                        group_number=row['group_number'], freq=row['frequency_khz'], rf=row['rf_dbm'], af_dbfs=row['af_dbfs'], af=row['af_dbfs'],
                        batt=row['battery_percent'], muted=None if row['muted'] is None else bool(row['muted']),
                        _online=online, status='online' if online else 'offline', removed=bool(row['removed']),
                        last_seen_at_ms=row['last_seen_at_ms'], observed_at_ms=row['snapshot_at_ms'], boot_id=row['boot_id'],
                        _age_s=None if row['last_seen_at_ms'] is None else max(0, now-row['last_seen_at_ms']) / 1000,
                        storage_origin='bridge.snapshot', control_target=False)
        if isinstance(snapshot.get('heartbeat'), dict) and not online:
            snapshot['heartbeat'] = {**snapshot['heartbeat'], 'status': 'offline', 'rtt_ms': None}
        output.append(snapshot)
    return {'channels': output, 'count': len(output), 'next_cursor': rows[limit - 1]['device_id'] if len(rows) > limit else None}


def get_overview(connection, boot_id, now_ms, online_window_ms=15000):
    boot_id, now = _text(boot_id, True), _integer(now_ms)
    _integer(online_window_ms, 1)
    rows = _channel_rows(connection)
    active = [row for row in rows if _online(row, boot_id, now, online_window_ms)]
    receivers = {row['receiver_id']: row['brand'] for row in active}
    brands = {brand: 0 for brand in ('DATYaudio', 'AMSaudio', 'Shure', 'Sennheiser')}
    for brand in receivers.values():
        brands[brand or 'unknown'] = brands.get(brand or 'unknown', 0) + 1
    return {'online_devices': len(receivers), 'online_receivers': len(receivers), 'active_channels': len(active),
            'known_channels': len(rows), 'brand_counts': brands, 'boot_id': boot_id, 'observed_at_ms': now}
