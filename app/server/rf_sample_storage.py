"""Lossless RF snapshot storage, independent of receiver protocols and live state.

SQLite owns the transaction. Dictionaries are immutable per channel/session and
UTC minute; they never supply live values. Each sample retains its original JSON
digest and queryable scalar columns. Old plain-JSON samples remain readable.
Design references and boundaries: docs/rf-storage-lite.md.
"""
import hashlib
import json
import zlib

FORMAT = 'daty-rf-zdict-v1'
SAMPLE_KIND = 'bridge-snapshot+zdict-v1'
PERIOD_MS = 60_000
MAX_RAW_BYTES = 64 * 1024 * 1024
TABLES = ('live_sample_blocks', 'live_sample_payloads')
DDL = (
    '''CREATE TABLE IF NOT EXISTS live_sample_blocks (
      block_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, session_id TEXT NOT NULL,
      start_at_ms INTEGER NOT NULL CHECK(start_at_ms>=0), period_ms INTEGER NOT NULL CHECK(period_ms=60000),
      format TEXT NOT NULL CHECK(format='daty-rf-zdict-v1'),
      dictionary BLOB NOT NULL CHECK(length(dictionary)<=32768), dictionary_sha256 TEXT NOT NULL,
      UNIQUE(device_id,session_id,start_at_ms),
      FOREIGN KEY(device_id) REFERENCES live_channels(device_id),
      FOREIGN KEY(session_id) REFERENCES live_sessions(session_id)) STRICT''',
    '''CREATE TABLE IF NOT EXISTS live_sample_payloads (
      sample_id INTEGER PRIMARY KEY, block_id TEXT NOT NULL,
      raw_bytes INTEGER NOT NULL CHECK(raw_bytes>=2 AND raw_bytes<=67108864),
      payload BLOB NOT NULL,
      FOREIGN KEY(sample_id) REFERENCES live_samples(id) ON DELETE CASCADE,
      FOREIGN KEY(block_id) REFERENCES live_sample_blocks(block_id)) STRICT''',
)


class CorruptSampleError(ValueError):
    pass


def available(connection):
    return connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_sample_payloads'").fetchone() is not None


def store(connection, sample_id, device_id, session_id, observed_at_ms, raw):
    if not connection.in_transaction:
        raise ValueError('Sample storage requires caller transaction')
    data = raw.encode('utf-8')
    if not 2 <= len(data) <= MAX_RAW_BYTES:
        raise ValueError('Snapshot exceeds supported size')
    start = observed_at_ms // PERIOD_MS * PERIOD_MS
    key = json.dumps([device_id, session_id, start], separators=(',', ':')).encode('utf-8')
    block_id = hashlib.sha256(key).hexdigest()
    existing = connection.execute('SELECT device_id,session_id,start_at_ms,format,dictionary,dictionary_sha256 FROM live_sample_blocks WHERE block_id=?', (block_id,)).fetchone()
    if existing is None:
        dictionary = data[-32768:]
        connection.execute('INSERT INTO live_sample_blocks VALUES(?,?,?,?,?,?,?,?)',
                           (block_id, device_id, session_id, start, PERIOD_MS, FORMAT,
                            dictionary, hashlib.sha256(dictionary).hexdigest()))
    else:
        if tuple(existing[:4]) != (device_id, session_id, start, FORMAT):
            raise CorruptSampleError('Sample block identity mismatch')
        dictionary = existing[4]
        if hashlib.sha256(dictionary).hexdigest() != existing[5]:
            raise CorruptSampleError('Sample dictionary checksum mismatch')
    encoder = zlib.compressobj(level=1, wbits=zlib.MAX_WBITS, zdict=dictionary)
    payload = encoder.compress(data) + encoder.flush()
    connection.execute('INSERT INTO live_sample_payloads VALUES(?,?,?,?)',
                       (sample_id, block_id, len(data), payload))


def load_snapshot(connection, sample_id):
    """Materialize exactly one historical JSON string; never publish as live."""
    row = connection.execute('SELECT snapshot_json,snapshot_sha256,sample_kind,device_id,session_id,observed_at_ms FROM live_samples WHERE id=?', (sample_id,)).fetchone()
    if row is None:
        raise KeyError(sample_id)
    if row[2] == 'bridge-snapshot':
        raw = row[0].encode('utf-8')
    elif row[2] == SAMPLE_KIND:
        packed = connection.execute('''SELECT p.raw_bytes,p.payload,b.format,b.dictionary,b.dictionary_sha256,
          b.device_id,b.session_id,b.start_at_ms,b.period_ms
          FROM live_sample_payloads p JOIN live_sample_blocks b ON b.block_id=p.block_id
          WHERE p.sample_id=?''', (sample_id,)).fetchone()
        if packed is None:
            raise CorruptSampleError('Sample payload missing')
        size, payload, version, dictionary, checksum, device, session, start, period = packed
        if (version != FORMAT or not 2 <= size <= MAX_RAW_BYTES or period != PERIOD_MS
                or (device, session) != (row[3], row[4])
                or start != row[5] // PERIOD_MS * PERIOD_MS
                or hashlib.sha256(dictionary).hexdigest() != checksum):
            raise CorruptSampleError('Sample envelope invalid')
        try:
            decoder = zlib.decompressobj(wbits=zlib.MAX_WBITS, zdict=dictionary)
            raw = decoder.decompress(payload, size + 1)
        except zlib.error as error:
            raise CorruptSampleError('Sample payload invalid') from error
        if len(raw) != size or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            raise CorruptSampleError('Sample length/stream invalid')
    else:
        raise CorruptSampleError('Unsupported sample encoding')
    if hashlib.sha256(raw).hexdigest() != row[1]:
        raise CorruptSampleError('Sample checksum mismatch')
    try:
        text = raw.decode('utf-8')
        if not isinstance(json.loads(text), dict):
            raise ValueError('Snapshot must be an object')
    except (UnicodeError, ValueError) as error:
        raise CorruptSampleError('Sample JSON invalid') from error
    return text
