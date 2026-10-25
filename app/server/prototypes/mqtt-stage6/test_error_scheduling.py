"""Real SQLite/lock regression for inline, file and review error responses."""
import asyncio
from contextlib import closing
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

ROOT=Path(os.environ.get('DATY_M6_TEST_SOURCE',Path(__file__).resolve().parents[2]))
sys.path[:0]=[str(ROOT),*[str(ROOT/'prototypes'/f'mqtt-stage{n}') for n in (6,5,4,3,2,1)]]
import unified_bootstrap
from m6_repository import Repository
from m6_data import DataService
from data_contract import DataError,SCHEMA,SERVER


class ErrorSchedulingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='m6-error-scheduling-')
        self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name)
        (root/'.daty-mqtt-stage4-fixture').write_text('isolated')
        path=root/'business.sqlite3'
        with closing(unified_bootstrap.open_database(path)) as c:
            unified_bootstrap.initialize(c,1000);c.commit();unified_bootstrap.enable_wal(c)
        self.lock=threading.RLock()
        self.repo=Repository(SimpleNamespace(_db_path=str(path),_db_lock=self.lock),fixture_root=root)
        self.addCleanup(self.repo.close)
        self.data=DataService(self.repo,discovery=None)

    async def exercise(self,entry):
        loop_thread=threading.get_ident()
        entered,held,release,watchdog=(threading.Event() for _ in range(4))
        execution_threads=[]
        original=self.data.domain_error
        def domain_error(error):
            execution_threads.append(threading.get_ident());entered.set()
            return original(error)
        def hold_database():
            with self.lock:
                held.set()
                if not release.wait(1):watchdog.set()
        holder=threading.Thread(target=hold_database)
        holder.start();self.assertTrue(await asyncio.to_thread(held.wait,2))
        request={'schema':SCHEMA,'server_id':SERVER,'boot_id':self.data.boot_id,
            'client_session_id':uuid.uuid4().hex,'request_id':uuid.uuid4().hex,
            'method':'database.resources.get','deadline_at_ms':int(time.time()*1000)+10000,'body':{}}
        error=DataError('RESOURCE_REVISION_CONFLICT',409)
        args=dict(entry='mqtt',current=lambda:True,peer_ip='127.0.0.1')
        try:
            with patch.object(self.data,'domain_error',domain_error),patch.object(self.data,'run',side_effect=error),patch.object(self.data,'review_discovery',side_effect=error):
                if entry=='inline':task=asyncio.create_task(self.data.request(request,**args))
                elif entry=='file':task=asyncio.create_task(self.data.invoke({'method':request['method'],'body':{}},request,'network:127.0.0.1',lambda:True))
                else:task=asyncio.create_task(self.data.review_request(request,**args))
                self.assertTrue(await asyncio.to_thread(entered.wait,2))
                # This coroutine can continue while metadata waits on the real
                # shared DB lock. The old code only resumes after its watchdog.
                still_waiting=not task.done()
                release.set()
                result=await task
                self.assertNotIn(loop_thread,execution_threads,'Database error path blocked the socket loop')
                self.assertFalse(watchdog.is_set())
                self.assertTrue(still_waiting)
                self.assertEqual(result['status'],409)
                self.assertEqual(result['body']['code'],'RESOURCE_REVISION_CONFLICT')
                self.assertFalse(result['body']['success'])
                self.assertFalse(result['body']['accepted'])
                self.assertIsInstance(result['body']['epoch'],str)
        finally:
            release.set();holder.join(2)

    async def test_inline_error_metadata_waits_outside_socket_loop(self):await self.exercise('inline')
    async def test_file_error_metadata_waits_outside_socket_loop(self):await self.exercise('file')
    async def test_review_error_metadata_waits_outside_socket_loop(self):await self.exercise('review')

if __name__=='__main__':unittest.main(verbosity=2)
