"""Bounded non-blocking observer of already verified Bridge business events.

The producer never opens SQLite, waits for a database lock, retries a command,
or decides an ACK. A single writer commits each observation's normalized data
and immutable evidence in the caller-owned transaction. Queue acceptance is
NOT durability. Overflow/write failure remain explicit, latched health gaps.
"""
import json
import queue
import threading
import time

import unified_live


PROTOCOL = 'daty-unified-runtime-v1'


class RuntimeStartupError(RuntimeError):
    pass


class UnifiedRuntime:
    def __init__(self, db_session, boot_id, *, capacity=256, max_queue_bytes=16 * 1024 * 1024,
                 now_ms=None, on_error=None):
        if not callable(db_session) or not isinstance(boot_id, str) or not boot_id.strip():
            raise ValueError('A transaction provider and stable server boot ID are required')
        if type(capacity) is not int or not 1 <= capacity <= 65536:
            raise ValueError('Invalid persistence queue capacity')
        if type(max_queue_bytes) is not int or max_queue_bytes < 1024:
            raise ValueError('Invalid persistence byte budget')
        self._db_session, self.boot_id = db_session, boot_id
        self._now = now_ms or (lambda: int(time.time() * 1000))
        self._on_error = on_error
        self._queue, self._capacity = queue.Queue(capacity), capacity
        self._max_bytes, self._bytes = max_queue_bytes, 0
        self._condition = threading.Condition(threading.RLock())
        self._ready, self._thread = threading.Event(), None
        self._started = self._stopping = self._startup_ok = False
        self._state = 'not-started'
        self._sequence = self._accepted = self._persisted = self._failed = self._refused = 0
        self._outstanding = self._last_committed_sequence = 0
        self._gaps, self._gap_records_truncated, self._last_error = [], 0, None
        self._error_notified = 0
        # A short idle grace amortizes FULL sync during bursts. All observations
        # keep FIFO order and their own savepoint; no sample coalescing.
        self._batch_limit, self._batch_budget_s = 128, 0.016
        self._batch_idle_s = 0.002
        self._write_batches = self._largest_batch = 0
        self._max_db_wait_ms = self._max_batch_work_ms = self._max_commit_ms = 0.0

    def _clock(self):
        value = self._now()
        if type(value) is not int or not 0 <= value <= unified_live.MAX_INTEGER:
            raise ValueError('Persistence clock must return epoch milliseconds')
        return value

    def start(self, *, timeout=5):
        """Commit boot invalidation before any server listener is allowed to start."""
        with self._condition:
            if self._started:
                if self._startup_ok and not self._stopping:
                    return self.status()
                raise RuntimeStartupError('Persistence runtime cannot be restarted in-place')
            self._started, self._state = True, 'starting'
            self._thread = threading.Thread(target=self._run, name='daty-business-writer', daemon=True)
            self._thread.start()
        if not self._ready.wait(timeout):
            with self._condition:
                self._stopping = True
                self._record_gap('STARTUP_TIMEOUT', 'bootstrap', 0)
                self._state = 'startup-failed'
            raise RuntimeStartupError('Business database bootstrap was not confirmed; listeners must not start')
        with self._condition:
            if not self._startup_ok:
                raise RuntimeStartupError('Business database bootstrap failed; listeners must not start')
        return self.status()

    def snapshot(self, devices, *, observed_at_ms=None, full=False):
        if type(devices) is not list or type(full) is not bool:
            return self._refuse('INVALID_OBSERVATION', 'snapshot')
        return self._submit('snapshot', {'devices': devices, 'full': full}, observed_at_ms)

    def command(self, record, *, observed_at_ms=None):
        if type(record) is not dict:
            return self._refuse('INVALID_OBSERVATION', 'command')
        return self._submit('command', {'record': record}, observed_at_ms)

    def device_history(self, record):
        if type(record) is not dict:
            return self._refuse('INVALID_OBSERVATION', 'device_history')
        return self._submit('device_history', {'record': record}, None)

    def _record_gap(self, code, kind, sequence):
        # Lock held by caller. Never log raw payloads, exception strings or SQL.
        self._last_error = {'code': code, 'kind': kind, 'sequence': sequence}
        if self._gaps and self._gaps[-1]['code'] == code and self._gaps[-1]['last_sequence'] + 1 == sequence:
            self._gaps[-1]['last_sequence'] = sequence
            self._gaps[-1]['count'] += 1
        else:
            self._gaps.append({'code': code, 'first_sequence': sequence, 'last_sequence': sequence, 'count': 1})
            if len(self._gaps) > 32:
                self._gaps.pop(0)
                self._gap_records_truncated += 1
        if self._state == 'running':
            self._state = 'degraded'

    def _refuse(self, code, kind):
        with self._condition:
            self._sequence += 1
            self._refused += 1
            self._record_gap(code, kind, self._sequence)
            self._condition.notify_all()
            return {'accepted': False, 'persisted': False, 'code': code, 'sequence': self._sequence}

    def _submit(self, kind, payload, observed):
        # Serialization makes the queued record immutable without DB/receiver I/O.
        try:
            observed = self._clock() if observed is None else observed
            if type(observed) is not int or not 0 <= observed <= unified_live.MAX_INTEGER:
                raise ValueError()
            encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
            size = len(encoded.encode('utf-8', 'strict'))
        except (TypeError, ValueError, UnicodeError, OverflowError, RecursionError):
            return self._refuse('INVALID_OBSERVATION', kind)
        with self._condition:
            self._sequence += 1
            sequence = self._sequence
            code = None
            if not self._startup_ok or self._stopping:
                code = 'RUNTIME_NOT_ACCEPTING'
            elif self._bytes + size > self._max_bytes:
                code = 'QUEUE_BYTE_BACKPRESSURE'
            else:
                try:
                    self._queue.put_nowait((sequence, kind, observed, encoded, size))
                except queue.Full:
                    code = 'QUEUE_BACKPRESSURE'
            if code:
                self._refused += 1
                self._record_gap(code, kind, sequence)
                return {'accepted': False, 'persisted': False, 'code': code, 'sequence': sequence}
            self._bytes += size
            self._accepted += 1
            self._outstanding += 1
            return {'accepted': True, 'persisted': False, 'sequence': sequence}

    def _notify_errors(self):
        # Only the writer invokes optional logging, never the real-time producer.
        with self._condition:
            count = self._failed + self._refused
            if count == self._error_notified or self._last_error is None:
                return
            self._error_notified = count
            error = dict(self._last_error)
        if self._on_error:
            try:
                self._on_error(error)
            except Exception:
                pass  # A logging sink cannot discard the explicit status gap.

    def _run(self):
        try:
            with self._db_session() as connection:
                unified_live.record_snapshot(connection, self.boot_id, [], self._clock(), full=False)
            with self._condition:
                if self._stopping:
                    self._state = 'startup-failed'
                else:
                    self._startup_ok, self._state = True, 'running'
        except Exception:
            with self._condition:
                self._state = 'startup-failed'
                self._record_gap('STARTUP_DATABASE_FAILED', 'bootstrap', 0)
            return
        finally:
            self._ready.set()
        if not self._startup_ok:
            return
        while True:
            with self._condition:
                if self._stopping and self._outstanding == 0:
                    self._state = 'stopped'
                    self._condition.notify_all()
                    return
            try:
                item = self._queue.get(timeout=0.05)
            except queue.Empty:
                self._notify_errors()
                continue
            batch, item_success, committed = [], [], False
            requested = time.monotonic()
            started = commit_started = None
            try:
                # One FULL-synchronous commit for a bounded FIFO batch. A bad
                # observation rolls back its own savepoint, not adjacent data.
                # An ambiguous commit never reports success and is never retried.
                with self._db_session() as connection:
                    started = time.monotonic()
                    if not connection.in_transaction:
                        connection.execute('BEGIN IMMEDIATE')
                    while True:
                        batch.append(item)
                        sequence, kind, observed, encoded, size = item
                        connection.execute('SAVEPOINT observation')
                        try:
                            payload = json.loads(encoded)
                            if kind == 'snapshot':
                                unified_live.record_snapshot(connection, self.boot_id, payload['devices'], observed, full=payload['full'])
                            elif kind == 'device_history':
                                unified_live.record_device_history(connection, payload['record'])
                            else:
                                unified_live.record_command(connection, payload['record'], observed)
                        except Exception:
                            connection.execute('ROLLBACK TO observation')
                            item_success.append(False)
                        else:
                            item_success.append(True)
                        connection.execute('RELEASE observation')
                        remaining = self._batch_budget_s - (time.monotonic() - started)
                        if len(batch) >= self._batch_limit or remaining <= 0:
                            break
                        try:
                            item = self._queue.get(timeout=min(self._batch_idle_s, remaining))
                        except queue.Empty:
                            break
                    commit_started = time.monotonic()
                committed = True
            except Exception:
                # Includes failures entering the transaction or acknowledging its
                # commit; even an already-dequeued first item must be accounted.
                if not batch:
                    batch.append(item)
            finally:
                with self._condition:
                    finished = time.monotonic()
                    if started is not None:
                        self._max_db_wait_ms = max(self._max_db_wait_ms, (started - requested) * 1000)
                    if commit_started is not None:
                        self._max_batch_work_ms = max(self._max_batch_work_ms, (commit_started - started) * 1000)
                        self._max_commit_ms = max(self._max_commit_ms, (finished - commit_started) * 1000)
                    self._write_batches += 1
                    self._largest_batch = max(self._largest_batch, len(batch))
                    for index, (sequence, kind, observed, encoded, size) in enumerate(batch):
                        if committed and index < len(item_success) and item_success[index]:
                            self._persisted += 1
                            self._last_committed_sequence = sequence
                        else:
                            self._failed += 1
                            self._record_gap('DATABASE_WRITE_UNCONFIRMED', kind, sequence)
                        self._bytes -= size
                        self._outstanding -= 1
                        self._queue.task_done()
                    self._condition.notify_all()
            self._notify_errors()

    def status(self):
        """Memory-only health. Gaps stay latched even after later successful writes."""
        with self._condition:
            return {'protocol': PROTOCOL, 'boot_id': self.boot_id, 'state': self._state,
                    'started': self._startup_ok, 'accepting': self._startup_ok and not self._stopping,
                    'accepted': self._accepted, 'committed': self._persisted, 'failed': self._failed,
                    'refused': self._refused, 'outstanding': self._outstanding, 'queue_count': self._queue.qsize(),
                    'queue_capacity': self._capacity, 'queue_bytes': self._bytes, 'max_queue_bytes': self._max_bytes,
                    'write_batches': self._write_batches, 'largest_batch': self._largest_batch,
                    'batch_limit': self._batch_limit, 'batch_budget_ms': self._batch_budget_s * 1000,
                    'last_sequence': self._sequence, 'last_committed_sequence': self._last_committed_sequence,
                    'max_db_wait_ms': round(self._max_db_wait_ms, 3),
                    'max_batch_work_ms': round(self._max_batch_work_ms, 3),
                    'max_commit_ms': round(self._max_commit_ms, 3),
                    'batch_idle_grace_ms': self._batch_idle_s * 1000,
                    'complete': self._startup_ok and self._outstanding == 0 and self._failed == 0 and self._refused == 0,
                    'last_error': dict(self._last_error) if self._last_error else None,
                    'gaps': [dict(gap) for gap in self._gaps], 'gap_records_truncated': self._gap_records_truncated,
                    'gap_scope': 'this-process-lifetime; restart does not prove prior gaps were saved'}

    def wait_idle(self, timeout=5):
        """Administrative/test wait only. Never called by telemetry/ACK producers."""
        deadline = time.monotonic() + timeout
        with self._condition:
            while self._outstanding and time.monotonic() < deadline:
                self._condition.wait(max(0, deadline - time.monotonic()))
            return {**self.status(), 'drained': self._outstanding == 0}

    def stop(self, timeout=5):
        with self._condition:
            self._stopping = True
            thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout)
        result = self.status()
        return {**result, 'stopped': thread is None or not thread.is_alive()}
