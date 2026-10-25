"""Reproduce Windows status rename denial with a real non-delete-sharing reader."""
import asyncio
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

HERE=Path(__file__).resolve().parent
sys.path[:0]=[str(HERE),str(HERE.parents[1])]
from m6_status import RuntimeStatus
from server_archive import atomic_json


@unittest.skipUnless(os.name=='nt','Windows share-mode regression')
class StatusContention(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='daty-status-contention-')
        self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'runtime-status.json'
        atomic_json(self.path,{'state':'previous'})
        self.kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        self.kernel.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,wintypes.LPVOID,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
        self.kernel.CreateFileW.restype=wintypes.HANDLE
        self.kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        self.handle=None
        self.addCleanup(self.unlock)

    def lock(self):
        self.handle=self.kernel.CreateFileW(str(self.path),0x80000000,1,None,3,0x80,None)
        self.assertNotEqual(self.handle,wintypes.HANDLE(-1).value)

    def unlock(self):
        if self.handle is not None:
            self.kernel.CloseHandle(self.handle);self.handle=None

    async def test_original_failure_reproduced_then_short_lock_recovers(self):
        self.lock()
        with self.assertRaises(PermissionError):atomic_json(self.path,{'state':'blocked'})
        reporter=RuntimeStatus(self.path)
        async def release():
            await asyncio.sleep(.12);self.unlock()
        release_task=asyncio.create_task(release())
        self.assertTrue(await reporter.publish({'state':'running','boot_id':'new'}))
        await release_task
        value=json.loads(self.path.read_text())
        self.assertEqual(value['state'],'running')
        self.assertGreater(value['status_io']['permission_failures'],0)

    async def test_long_lock_does_not_stop_loop_and_next_snapshot_recovers(self):
        reporter=RuntimeStatus(self.path);self.lock()
        ticks=0
        async def heartbeat():
            nonlocal ticks
            while True:
                ticks+=1;await asyncio.sleep(.01)
        task=asyncio.create_task(heartbeat())
        try:
            self.assertFalse(await reporter.publish({'state':'running','boot_id':'one'}))
            self.assertGreater(ticks,10)
            self.assertEqual(json.loads(self.path.read_text()),{'state':'previous'})
            self.unlock()
            self.assertTrue(await reporter.publish({'state':'running','boot_id':'two'}))
            value=json.loads(self.path.read_text())
            self.assertEqual(value['boot_id'],'two')
            self.assertEqual(value['status_io']['skipped_snapshots'],1)
            self.assertEqual(value['status_io']['permission_failures'],4)
        finally:
            task.cancel();await asyncio.gather(task,return_exceptions=True)

    async def test_unrelated_writer_errors_remain_errors(self):
        for error in (PermissionError('non-Windows policy denial'),OSError('disk error')):
            def fail(*args):raise error
            with self.assertRaises(type(error)):
                await RuntimeStatus(self.path,write=fail).publish({'state':'running'})


if __name__=='__main__':unittest.main(verbosity=2)
