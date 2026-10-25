"""Bounded snapshot I/O for isolated test evidence, never business storage.

Readers close the file before parsing. Windows can still deny replacement
while any reader holds it open; writers retry briefly without deleting the
last valid snapshot. No sharing-flag assumption is required.
"""
import errno
import json
import os
from pathlib import Path
import time


def _retry(operation, retry_seconds=2):
    if not 0 <= retry_seconds <= 2:
        raise ValueError('Invalid progress retry budget')
    began = time.monotonic()
    retries = 0
    while True:
        try:
            result = operation()
            return result, {'replace_retries': retries,
                            'replace_wait_ms': (time.monotonic()-began)*1000 if retries else 0}
        except OSError as error:
            remaining = retry_seconds-(time.monotonic()-began)
            transient = (getattr(error, 'winerror', None) in (5, 32, 33)
                         or error.errno in (errno.EACCES, errno.EPERM, errno.EBUSY))
            if os.name != 'nt' or not transient or remaining <= 0:
                raise
            retries += 1
            time.sleep(min(.025*min(retries, 8), remaining))


def read_progress(path, *, missing_ok=False, retry_seconds=2):
    def read():
        with open(path, 'r', encoding='utf-8') as stream:
            raw = stream.read(2*1024*1024+1)
        if len(raw) > 2*1024*1024:
            raise ValueError('Progress snapshot too large')
        # Malformed evidence is an error, never a silently reused old snapshot.
        return json.loads(raw)
    try:
        return _retry(read, retry_seconds)[0]
    except FileNotFoundError:
        if missing_ok:
            return {}
        raise


def write_progress(path, value, *, retry_seconds=2):
    path = Path(path)
    if path.suffix != '.json':
        raise ValueError('Progress destination must end in .json')
    temporary = path.with_suffix('.pending')
    payload = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2)
    with temporary.open('w', encoding='utf-8', newline='\n') as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    return _retry(lambda: os.replace(temporary, path), retry_seconds)[1]
