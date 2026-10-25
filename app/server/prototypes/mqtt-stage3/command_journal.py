"""Durable at-most-once dispatch decisions for the isolated M3 candidate.

SQLite FULL commit precedes the only dispatch attempt. Interrupted decisions
remain unknown, never become a retry queue. This is not exactly-once hardware.
"""
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import time
import uuid


class ProcessLease:
    """OS-released single-controller lease, including after an abrupt crash."""
    def __init__(self, path):
        self.file = open(path, 'a+b')
        if self.file.seek(0, 2) == 0:
            self.file.write(b'0')
            self.file.flush()
        self.file.seek(0)
        try:
            import msvcrt
            msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
        except BaseException:
            self.file.close()
            raise CommandError('CONTROLLER_ALREADY_RUNNING')

    def close(self):
        self.file.close()

TERMINAL = {'readback_confirmed', 'acknowledged', 'rejected', 'not_sent', 'timeout', 'unknown'}
INFLIGHT = {'reserved', 'dispatching', 'published'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


class CommandError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class Journal:
    def __init__(self, path, *, fixture_root, active_entry='mqtt'):
        base, path = Path(fixture_root).resolve(), Path(path).resolve()
        if not (base / '.daty-mqtt-stage3-fixture').is_file() or not path.is_relative_to(base):
            raise ValueError('Isolated journal required')
        if active_entry not in ('mqtt', 'https'):
            raise ValueError('One active entry required')
        self.lease = ProcessLease(str(path) + '.owner.lock')
        self.lock, self.entry, self.poisoned = threading.RLock(), active_entry, False
        self.db = sqlite3.connect(path, timeout=3, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS operations(
            operation_id TEXT PRIMARY KEY, command_id TEXT UNIQUE NOT NULL,
            digest TEXT NOT NULL, entry TEXT NOT NULL, body TEXT NOT NULL,
            device_id TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL,
            error TEXT, actual_json TEXT, evidence_json TEXT, created_at REAL NOT NULL,
            updated_at REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS requests(
            request_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
            digest TEXT NOT NULL, entry TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS transitions(
            id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, revision INTEGER NOT NULL,
            state TEXT NOT NULL, details TEXT NOT NULL, created_at REAL NOT NULL);
        ''')
        # A second live controller must never adopt this database; the process
        # lease is acquired by the controller before creating this Journal.
        with self.transaction():
            rows = self.db.execute("SELECT operation_id FROM operations WHERE state IN ('reserved','dispatching','published')").fetchall()
            for row in rows:
                self._change(row['operation_id'], 'unknown', 'PROCESS_INTERRUPTED')

    def transaction(self):
        journal = self
        class Transaction:
            def __enter__(self):
                journal.lock.acquire()
                if journal.poisoned:
                    journal.lock.release()
                    raise CommandError('JOURNAL_UNAVAILABLE')
                try:
                    journal.db.execute('BEGIN IMMEDIATE')
                except BaseException:
                    journal.lock.release()
                    raise
            def __exit__(self, typ, value, tb):
                try:
                    if typ:
                        journal.db.rollback()
                    else:
                        try:
                            journal.commit()
                        except BaseException:
                            # Commit outcome cannot authorize dispatch or replay.
                            journal.poisoned = True
                            raise
                finally:
                    journal.lock.release()
        return Transaction()

    def commit(self):
        """Fault-injection seam; FULL synchronous commit remains the authority."""
        self.db.commit()

    def _view(self, row):
        if row is None:
            raise CommandError('NOT_FOUND')
        body = json.loads(row['body'])
        return {'operation_id': row['operation_id'], 'command_id': row['command_id'],
                'entry': row['entry'], 'state': row['state'], 'revision': row['revision'],
                'target': body['body']['target'], 'command': body['body']['command'],
                'expected_value': body['body']['expected_value'],
                'deadline_at_ms': body['deadline_at_ms'], 'server_id': body['server_id'],
                'boot_id': body['boot_id'], 'attempts': row['attempts'], 'error': row['error'],
                'actual_value': json.loads(row['actual_json']) if row['actual_json'] else None,
                'execution_evidence': json.loads(row['evidence_json']) if row['evidence_json'] else None}

    def get(self, operation_id):
        with self.lock:
            if self.poisoned:
                raise CommandError('JOURNAL_UNAVAILABLE')
            return self._view(self.db.execute('SELECT * FROM operations WHERE operation_id=?', (operation_id,)).fetchone())

    def by_command(self, command_id):
        with self.lock:
            if self.poisoned:
                raise CommandError('JOURNAL_UNAVAILABLE')
            row = self.db.execute('SELECT * FROM operations WHERE command_id=?', (command_id,)).fetchone()
            return self._view(row) if row else None

    def reserve(self, request, entry):
        if entry != self.entry:
            raise CommandError('CONTROL_ENTRY_DISABLED')
        # Connection/correlation IDs do not change intent; expiration, boot,
        # exact target/session and value do. An operation cannot change meaning.
        content = {key: request[key] for key in ('server_id', 'boot_id', 'deadline_at_ms', 'body')}
        text = canonical(content)
        digest = hashlib.sha256(text.encode()).hexdigest()
        oid, rid = request['body']['operation_id'], request['request_id']
        with self.transaction():
            prior_request = self.db.execute('SELECT * FROM requests WHERE request_id=?', (rid,)).fetchone()
            if prior_request and (prior_request['operation_id'] != oid or prior_request['digest'] != digest or prior_request['entry'] != entry):
                raise CommandError('REQUEST_ID_CONFLICT')
            prior = self.db.execute('SELECT * FROM operations WHERE operation_id=?', (oid,)).fetchone()
            if prior and (prior['digest'] != digest or prior['entry'] != entry):
                raise CommandError('OPERATION_ID_CONFLICT')
            if not prior:
                target = content['body']['target']['device_id']
                blocked = self.db.execute("SELECT 1 FROM operations WHERE device_id=? AND state IN ('reserved','dispatching','published','timeout','unknown')", (target,)).fetchone()
                if blocked:
                    raise CommandError('TARGET_PENDING_OR_UNCERTAIN')
                now = time.time()
                self.db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    (oid, uuid.uuid4().hex, digest, entry, text, target, 'reserved', 1, None, None, None, now, now, 0))
                self.db.execute('INSERT INTO transitions(operation_id,revision,state,details,created_at) VALUES(?,?,?,?,?)',
                    (oid, 1, 'reserved', '{}', now))
            self.db.execute('INSERT OR IGNORE INTO requests VALUES(?,?,?,?)', (rid, oid, digest, entry))
        return self.get(oid), prior is None

    def _change(self, oid, state, error=None, actual=None, evidence=None, *, attempt=False):
        current = self.db.execute('SELECT * FROM operations WHERE operation_id=?', (oid,)).fetchone()
        if not current:
            raise CommandError('NOT_FOUND')
        revision, now = current['revision'] + 1, time.time()
        self.db.execute('UPDATE operations SET state=?, revision=?, error=?, actual_json=?, evidence_json=?, updated_at=?, attempts=attempts+? WHERE operation_id=?',
            (state, revision, error, canonical(actual) if actual is not None else None,
             canonical(evidence) if evidence is not None else None, now, int(attempt), oid))
        self.db.execute('INSERT INTO transitions(operation_id,revision,state,details,created_at) VALUES(?,?,?,?,?)',
            (oid, revision, state, canonical({'error': error, 'actual': actual, 'evidence': evidence}), now))

    def transition(self, oid, expected, state, **kwargs):
        with self.transaction():
            row = self.db.execute('SELECT state FROM operations WHERE operation_id=?', (oid,)).fetchone()
            if row and row['state'] in expected:
                self._change(oid, state, **kwargs)
        return self.get(oid)

    def pending(self):
        with self.lock:
            return [self._view(r) for r in self.db.execute("SELECT * FROM operations WHERE state IN ('reserved','dispatching','published')")]

    def close(self):
        with self.lock:
            self.db.close()
            self.lease.close()
