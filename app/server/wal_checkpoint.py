"""Passive WAL maintenance outside the receiver/transaction critical path.

FULL-synchronous commits remain owned by the original writer. This connection
only checkpoints already committed pages, never truncates, deletes or replays
business data. A pinned reader may prevent progress; report that explicitly.
"""
from pathlib import Path
import sqlite3
import threading
import time


class WalCheckpointer:
    def __init__(self, database_path, *, interval=1.0, threshold_bytes=16 * 1024 * 1024):
        self.path = Path(database_path).resolve()
        self.interval, self.threshold = interval, threshold_bytes
        self._stop, self._ready = threading.Event(), threading.Event()
        self._lock, self._thread = threading.Lock(), None
        self._state = dict(protocol='daty-passive-checkpoint-v1', state='not-started',
                           runs=0, failures=0, busy=0, wal_bytes=0, log_frames=None,
                           checkpointed_frames=None, pending_frames=None, max_duration_ms=0.0,
                           last_error=None, scope='this-process-lifetime')

    def status(self):
        with self._lock:
            return dict(self._state)

    def start(self, timeout=5):
        if self._thread is not None:
            raise RuntimeError('WAL maintenance cannot be restarted in-place')
        self._thread = threading.Thread(target=self._run, name='daty-wal-checkpoint', daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout) or self.status()['state'] != 'running':
            self.stop(timeout)
            raise RuntimeError('Background WAL maintenance did not start')

    def _run(self):
        connection = None
        try:
            # Existing database only; never bootstrap an empty path by accident.
            connection = sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True, timeout=0)
            if connection.execute('PRAGMA journal_mode').fetchone()[0].lower() != 'wal':
                raise RuntimeError('WAL mode required')
            connection.execute('PRAGMA synchronous=FULL')
            connection.execute('PRAGMA busy_timeout=0')
            with self._lock:
                self._state['state'] = 'running'
            self._ready.set()
            while not self._stop.wait(self.interval):
                try:
                    wal = Path(str(self.path) + '-wal')
                    size = wal.stat().st_size if wal.exists() else 0
                    with self._lock:
                        self._state['wal_bytes'] = size
                    if size < self.threshold:
                        continue
                    started = time.monotonic()
                    busy, log, saved = connection.execute('PRAGMA wal_checkpoint(PASSIVE)').fetchone()
                    elapsed = (time.monotonic() - started) * 1000
                    with self._lock:
                        self._state.update(runs=self._state['runs'] + 1,
                            busy=self._state['busy'] + int(bool(busy)), log_frames=log,
                            checkpointed_frames=saved, pending_frames=max(0, log - saved),
                            max_duration_ms=round(max(self._state['max_duration_ms'], elapsed), 3))
                except (sqlite3.Error, OSError):
                    with self._lock:
                        self._state['failures'] += 1
                        self._state['last_error'] = 'CHECKPOINT_UNCONFIRMED'
                    # Never hide failures or delete/rebuild a WAL to recover space.
        except Exception:
            with self._lock:
                self._state.update(state='failed', last_error='CHECKPOINT_STARTUP_FAILED')
        finally:
            self._ready.set()
            if connection is not None:
                connection.close()
            with self._lock:
                if self._state['state'] != 'failed':
                    self._state['state'] = 'stopped'

    def stop(self, timeout=5):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
        return {'stopped': self._thread is None or not self._thread.is_alive()}
