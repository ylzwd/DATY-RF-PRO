"""Existing observer contract, with SQLite work in a separate interpreter.

The inherited immutable queue, byte/item bounds, FIFO, gap accounting, API and
stop/drain contract remain authoritative. The child runs the original live-store
functions, per-observation savepoints and FULL commits in the same database.
"""
from collections import deque
from pathlib import Path
import json
import math
import queue
import sys
import time

from unified_runtime import UnifiedRuntime
from m6_writer_process import WriterProcess, safe_error
from m6_scheduling import SchedulingLease
from m6_cpu_placement import CpuPlacementLease


def persistence_ready(state):
    # Historical gaps remain visible; only a verified current writer can reopen.
    if 'writable' in state:
        return state['writable'] is True and state.get('accepting') is True
    return bool(state.get('accepting', True) and not state.get('failed', 0) and not state.get('refused', 0))


class ProcessRuntime(UnifiedRuntime):
    def __init__(self, bridge, **kwargs):
        super().__init__(bridge._db_session, bridge._clock_state['server_id'], **kwargs)
        if self._max_bytes > 16 * 1024 * 1024:
            raise ValueError('M6 retains the 16 MiB input budget')
        self._writer_lock, self._database = bridge._db_lock, bridge._db_path
        self._worker = None
        self._writer_fault = False
        self._epoch = self._file_identity = None
        self._recovery_attempts = self._recoveries = 0
        self._retry_at = 0
        self._retry_delay = .5
        self._recovery_history = []
        self._recovery_error = None
        self._diagnostic = getattr(bridge, '_log', lambda *args: None)
        self._worker_totals = dict(work_ms=0.0, work_cpu_ms=0.0, commit_ms=0.0, commit_cpu_ms=0.0)
        self._max_worker_work_ms = self._max_worker_commit_ms = 0.0
        self._batch_budget_s = .05
        self._cpu_placement = {'policy': 'hybrid-performance-cores', 'reason': 'not-started', 'applied': False}

    def status(self):
        with self._condition:
            worker = self._worker
            alive = bool(worker and worker.process.poll() is None)
            if self._startup_ok and not self._stopping and worker and not alive:
                if not self._writer_fault:
                    self._writer_fault = True
                    self._record_gap('WRITER_PROCESS_UNAVAILABLE', 'writer', self._sequence)
            state = super().status()
            if self._writer_fault:
                state['accepting'] = state['complete'] = False
            state['writable'] = bool(state['accepting'] and alive and not worker.failed)
            state['recovery'] = {'attempts': self._recovery_attempts, 'recoveries': self._recoveries,
                'state': 'stopped' if self._stopping else ('ready' if state['writable'] else 'recovering'),
                'last_error': self._recovery_error, 'history': list(self._recovery_history)}
            state['writer'] = {'kind': 'isolated-process',
                'parent_switch_ms': sys.getswitchinterval() * 1000,
                'pid': worker.process.pid if worker else None,
                'running': alive,
                'last_fault': worker.last_fault if worker else None,
                'cpu_placement': dict(self._cpu_placement),
                **{k: round(v, 3) for k, v in self._worker_totals.items()},
                'max_work_ms': round(self._max_worker_work_ms, 3),
                'max_commit_ms': round(self._max_worker_commit_ms, 3)}
            return state

    def _submit(self, kind, payload, observed):
        with self._condition:
            if (self._startup_ok and not self._stopping and self._worker
                    and (self._writer_fault or self._worker.failed or self._worker.process.poll() is not None)):
                return self._refuse('WRITER_PROCESS_UNAVAILABLE', kind)
        return super()._submit(kind, payload, observed)

    def _recover_worker(self, pending):
        """Writer thread only: fence old child, discard unconfirmed work, prove new commit."""
        with self._condition:
            if not self._writer_fault:
                self._writer_fault = True
                self._record_gap('WRITER_PROCESS_UNAVAILABLE', 'writer', self._sequence)
            if not self._retry_at:
                self._retry_at = time.monotonic() + .5
            # These items were accepted before the fault, never replay old work.
            while True:
                try: item = pending.popleft() if pending else self._queue.get_nowait()
                except queue.Empty: break
                sequence, kind, observed, encoded, size = item
                self._failed += 1
                self._record_gap('WRITER_RECOVERY_NOT_REPLAYED', kind, sequence)
                self._bytes -= size; self._outstanding -= 1; self._queue.task_done()
            self._condition.notify_all()
            if self._stopping:
                return
            remaining = self._retry_at - time.monotonic()
            if remaining > 0:
                self._condition.wait(min(.05, remaining))
                return
            self._recovery_attempts += 1
        candidate = None
        try:
            with self._writer_lock:
                old = self._worker
                old.close()  # Old child and pipe thread must be gone first.
                path = Path(self._database)
                if not path.is_file() or (path.stat().st_dev, path.stat().st_ino) != self._file_identity:
                    raise ValueError('Recovery file identity changed')
                with self._condition:
                    if self._stopping: return
                candidate = WriterProcess(self._database, self.boot_id)
                reply = candidate.call('resume', epoch=self._epoch)
                if reply.get('boot_id') != self.boot_id or reply.get('epoch') != self._epoch or reply.get('synchronous') != 2:
                    raise ValueError('Recovery commit identity mismatch')
                with self._condition:
                    if self._stopping:
                        candidate.close(); return
                    self._worker = candidate
                    self._writer_fault = False
                    self._recoveries += 1
                    self._retry_delay = .5; self._retry_at = 0
                    self._recovery_error = None
                    # Never erase gap counters or claim missing observations were saved.
                    self._state = 'degraded' if self._failed or self._refused or self._gaps else 'running'
                    event = {'at_ms': self._clock(), 'outcome': 'recovered', 'old_pid': old.process.pid,
                        'pid': candidate.process.pid, 'fault': old.last_fault or {'code':'WRITER_PROCESS_EXITED','exit_code':old.process.returncode}}
                    self._recovery_history.append(event); del self._recovery_history[:-16]
                    self._condition.notify_all()
            try:self._diagnostic('DB', '写入进程已恢复，历史缺口保留: '+json.dumps(event, ensure_ascii=False))
            except Exception:pass
        except Exception as error:
            if candidate is not None: candidate.close()
            with self._condition:
                self._recovery_error = {'code': 'WRITER_RECOVERY_UNCONFIRMED', **safe_error(error),
                    'fault': candidate.last_fault if candidate else None}
                self._retry_at = time.monotonic() + self._retry_delay
                self._retry_delay = min(5, self._retry_delay * 2)
                event = {'at_ms': self._clock(), 'outcome': 'blocked', **self._recovery_error}
                self._recovery_history.append(event); del self._recovery_history[:-16]
            try:self._diagnostic('DB', '写入恢复尚未确认: '+json.dumps(event, ensure_ascii=False))
            except Exception:pass

    def _run(self):
        scheduling = SchedulingLease()
        placement = CpuPlacementLease()
        self._cpu_placement = placement.state
        try:
            self._run_owned()
        finally:
            try:
                if self._worker is not None:
                    self._worker.close()
            finally:
                try:placement.close()
                finally:scheduling.close()

    def _run_owned(self):
        try:
            with self._writer_lock:
                path = Path(self._database)
                self._file_identity = (path.stat().st_dev, path.stat().st_ino)
                self._worker = WriterProcess(self._database, self.boot_id)
                reply = self._worker.call('boot', observed=self._clock())
                if reply.get('boot_id') != self.boot_id or reply.get('synchronous') != 2:
                    raise RuntimeError('Writer startup unconfirmed')
                self._epoch = reply['epoch']
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
        pending = deque()
        while True:
            with self._condition:
                if self._stopping and self._outstanding == 0:
                    self._state = 'stopped'
                    self._condition.notify_all()
                    return
            if self._writer_fault or self._worker.failed or self._worker.process.poll() is not None:
                self._recover_worker(pending)
                self._notify_errors()
                continue
            try:
                first = pending.popleft() if pending else self._queue.get(timeout=.05)
            except queue.Empty:
                self._notify_errors()
                continue
            collecting = time.monotonic()
            batch = [first]
            while len(batch) < self._batch_limit:
                remaining = self._batch_budget_s - (time.monotonic() - collecting)
                if remaining <= 0:
                    break
                try:
                    batch.append(pending.popleft() if pending else self._queue.get(timeout=min(self._batch_idle_s, remaining)))
                except queue.Empty:
                    break
            requested = time.monotonic()
            budget = max(.001, self._batch_budget_s - (requested - collecting))
            started = None
            successes, committed, reply = [], False, None
            try:
                with self._writer_lock:
                    started = time.monotonic()
                    reply = self._worker.call('batch', items=batch, budget=budget)
                    successes = reply.get('successes')
                    if (type(successes) is not list or not 1 <= len(successes) <= len(batch)
                            or any(type(value) is not bool for value in successes)
                            or any(type(reply.get(key)) not in (int, float)
                                   or not math.isfinite(reply[key]) or reply[key] < 0
                                   for key in self._worker_totals)):
                        # An invalid response cannot release a live writer lock
                        # and then quietly retry an uncertain transaction.
                        self._worker.failed = True
                        self._worker._terminate()
                        raise RuntimeError('Writer batch response invalid')
                    count = len(successes)
                    pending.extendleft(reversed(batch[count:]))
                    batch = batch[:count]
                    committed = True
            except Exception:
                with self._condition:
                    self._writer_fault = True
                # Explicit gaps below; no ambiguous transaction replay.
            finally:
                with self._condition:
                    if started is not None:
                        self._max_db_wait_ms = max(self._max_db_wait_ms, (started - requested) * 1000)
                    if committed:
                        for key in self._worker_totals:
                            self._worker_totals[key] += reply[key]
                        self._max_worker_work_ms = max(self._max_worker_work_ms, reply['work_ms'])
                        self._max_worker_commit_ms = max(self._max_worker_commit_ms, reply['commit_ms'])
                        self._max_batch_work_ms = max(self._max_batch_work_ms, reply['work_ms'])
                        self._max_commit_ms = max(self._max_commit_ms, reply['commit_ms'])
                    self._write_batches += 1
                    self._largest_batch = max(self._largest_batch, len(batch))
                    for index, (sequence, kind, observed, encoded, size) in enumerate(batch):
                        if committed and successes[index]:
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
