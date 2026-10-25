"""Bounded private pipe to the sole M6 observation writer.

The parent keeps the existing database/RPC lock until the child confirms FULL
commit (or has been terminated). There is one outstanding request, no network
listener, replay, extra database, sample reduction or expanded ingress queue.
"""
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time


def active_seconds():
    """Windows sleep is not time spent waiting for an executing child."""
    if os.name == 'nt':
        import ctypes
        value = ctypes.c_ulonglong()
        if not ctypes.windll.kernel32.QueryUnbiasedInterruptTime(ctypes.byref(value)):
            raise OSError('Active clock unavailable')
        return value.value / 10_000_000
    return time.monotonic()


def wait_active(future, timeout, clock=active_seconds):
    deadline = clock() + timeout
    while not future.done():
        remaining = deadline - clock()
        if remaining <= 0:
            raise FutureTimeout('Writer active deadline exceeded')
        try:
            return future.result(min(.1, remaining))
        except FutureTimeout:
            if future.done():
                return future.result()
    return future.result()


def safe_error(error):
    # Never expose SQL, observations, paths or arbitrary exception messages.
    result = {'type': type(error).__name__}
    name = getattr(error, 'sqlite_errorname', None)
    if isinstance(name, str) and name.startswith('SQLITE_') and name.replace('_', '').isalnum():
        result['sqlite_code'] = name
    return result


# An already encoded observation can double when quoted in the pipe envelope.
# This is framing overhead; the authoritative input budget remains 16 MiB.
MAX_FRAME = 32 * 1024 * 1024 + 64 * 1024


def read_frame(stream):
    header = stream.read(4)
    if len(header) != 4:
        raise EOFError('Writer pipe closed')
    size = int.from_bytes(header, 'big')
    if not 0 < size <= MAX_FRAME:
        raise ValueError('Invalid writer frame size')
    chunks, remaining = [], size
    while remaining:
        part = stream.read(remaining)
        if not part:
            raise EOFError('Incomplete writer frame')
        chunks.append(part)
        remaining -= len(part)
    return json.loads(b''.join(chunks))


def write_frame(stream, value):
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    if not 0 < len(raw) <= MAX_FRAME:
        raise ValueError('Invalid writer frame size')
    stream.write(len(raw).to_bytes(4, 'big'))
    stream.write(raw)
    stream.flush()


class WriterProcess:
    def __init__(self, database, boot_id, *, timeout=5):
        from m6_job import own_process_tree
        own_process_tree()  # Children die even after os._exit / parent crash.
        self.timeout, self.sequence, self.failed = timeout, 0, False
        self.last_fault = None
        self.lock = threading.Lock()
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('m6_writer_worker.py')), str(database), boot_id],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        self.io = ThreadPoolExecutor(max_workers=1, thread_name_prefix='daty-writer-pipe')

    def _exchange(self, request):
        write_frame(self.process.stdin, request)
        return read_frame(self.process.stdout)

    def call(self, operation, **body):
        with self.lock:
            if self.failed or self.process.poll() is not None:
                if self.last_fault is None:
                    self.last_fault = {'code': 'WRITER_PROCESS_EXITED', 'exit_code': self.process.poll()}
                raise RuntimeError('Writer unavailable; request will not be replayed')
            self.sequence += 1
            sequence = self.sequence
            try:
                reply = wait_active(self.io.submit(self._exchange, {'sequence': sequence, 'operation': operation, **body}), self.timeout)
                if (type(reply) is not dict or reply.get('sequence') != sequence
                        or reply.get('committed') is not True):
                    self.last_fault = {'code': 'WRITER_COMMIT_UNCONFIRMED', 'operation': operation,
                        'sequence': sequence}
                    if type(reply) is dict and type(reply.get('error')) is dict:
                        self.last_fault['worker_error'] = {k:v for k,v in reply['error'].items()
                            if k in ('type','sqlite_code') and isinstance(v,str) and v.replace('_','').isalnum()}
                    raise RuntimeError('Writer commit unconfirmed')
                return reply
            except BaseException as error:
                self.failed = True
                if self.last_fault is None:
                    self.last_fault = {'code': 'WRITER_ACTIVE_TIMEOUT' if isinstance(error, FutureTimeout) else 'WRITER_PIPE_FAILURE',
                        'operation': operation, 'sequence': sequence, **safe_error(error)}
                # A lost reply may follow a successful commit. Never replay it.
                # Stop the child BEFORE releasing the caller's database lock.
                self._terminate()
                self.last_fault['exit_code'] = self.process.returncode
                # Worker stderr contains one sanitized JSON object, never a traceback.
                try:
                    detail = json.loads(self.process.stderr.read(4096))
                    self.last_fault['worker_error'] = {k:v for k,v in detail.items()
                        if k in ('type','sqlite_code') and isinstance(v,str) and v.replace('_','').isalnum()}
                except (ValueError, TypeError):
                    pass
                raise

    def _terminate(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=5)

    def close(self):
        with self.lock:
            if self.process.poll() is None:
                # EOF is a clean shutdown; no pending request reaches here.
                self.process.stdin.close()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._terminate()
            self.io.shutdown(wait=True, cancel_futures=True)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if stream is not None and not stream.closed:
                    stream.close()
