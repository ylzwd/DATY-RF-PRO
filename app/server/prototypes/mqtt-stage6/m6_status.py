"""Best-effort diagnostic status under Windows reader/rename contention.

Only this local status file is retried; business writes, ACKs, pairing and
archive receipts continue to use their original durability/error semantics.
"""
import asyncio
from server_archive import atomic_json


class RuntimeStatus:
    def __init__(self, path, *, write=atomic_json):
        self.path, self.write = path, write
        self.permission_failures = self.skipped_snapshots = 0

    async def publish(self, value):
        for delay in (0, .05, .1, .2):
            if delay:
                await asyncio.sleep(delay)
            snapshot = {**value, 'status_io': {
                'permission_failures': self.permission_failures,
                'skipped_snapshots': self.skipped_snapshots}}
            try:
                await asyncio.to_thread(self.write, self.path, snapshot)
                return True
            except PermissionError as error:
                if getattr(error, 'winerror', None) not in (5, 32, 33):
                    raise
                self.permission_failures += 1
        self.skipped_snapshots += 1
        print('Runtime status snapshot deferred after Windows access contention; '
              'business services remain active; skipped='+str(self.skipped_snapshots), flush=True)
        return False
