"""Local queue and temporary WAL fixtures; no production imports or transport."""
import asyncio
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest

from mqtt_dispatch import MqttDispatchQueue
from wal_checkpoint import WalCheckpointer


class QueueTests(unittest.TestCase):
    def test_count_and_byte_limits_are_independent_fifo_and_release_exactly(self):
        q=MqttDispatchQueue(maxsize=3,max_bytes=10)
        a=('up',{},'a','s',6);b=('up',{},'b','s',4)
        q.put_nowait(a);q.put_nowait(b)
        with self.assertRaises(asyncio.QueueFull):q.put_nowait(('up',{},'c','s',1))
        q.put_nowait(None)
        with self.assertRaises(asyncio.QueueFull):q.put_nowait(None)
        self.assertEqual(q.status()['refused'],2);self.assertEqual(q.get_nowait(),a);q.task_done()
        self.assertEqual(q.queued_bytes,4);self.assertEqual(q.get_nowait(),b);q.task_done()
        self.assertIsNone(q.get_nowait());q.task_done();self.assertEqual(q.queued_bytes,0)
        self.assertEqual(q.status()['peak_bytes'],10);asyncio.run(q.join())

    def test_invalid_size_never_mutates_queue(self):
        q=MqttDispatchQueue()
        for size in (-1,True,'1'):
            with self.assertRaises(ValueError):q.put_nowait(('up',{},'a','s',size))
        self.assertEqual(q.qsize(),0);self.assertEqual(q.queued_bytes,0)


class CheckpointTests(unittest.TestCase):
    def test_existing_wal_full_commits_and_pinned_reader_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix='daty-wal-test-') as temp:
            path=Path(temp)/'fixture.sqlite3';writer=sqlite3.connect(path)
            writer.execute('PRAGMA journal_mode=WAL');writer.execute('PRAGMA synchronous=FULL')
            writer.execute('PRAGMA wal_autocheckpoint=0');writer.execute('CREATE TABLE evidence(id PRIMARY KEY,value)')
            writer.execute('INSERT INTO evidence VALUES(0,?)',('original',));writer.commit()
            reader=sqlite3.connect(path);reader.execute('BEGIN');reader.execute('SELECT * FROM evidence').fetchall()
            worker=WalCheckpointer(path,interval=.01,threshold_bytes=1);worker.start()
            try:
                for i in range(1,31):
                    writer.execute('INSERT INTO evidence VALUES(?,?)',(i,'x'*8192));writer.commit()
                deadline=time.monotonic()+3
                while worker.status()['pending_frames'] in (None,0) and time.monotonic()<deadline:time.sleep(.01)
                self.assertGreater(worker.status()['pending_frames'],0)
                self.assertEqual(reader.execute('SELECT COUNT(*) FROM evidence').fetchone()[0],1)
                reader.rollback()
                deadline=time.monotonic()+3
                while worker.status()['pending_frames']!=0 and time.monotonic()<deadline:time.sleep(.01)
                self.assertEqual(worker.status()['pending_frames'],0)
                self.assertEqual(writer.execute('PRAGMA synchronous').fetchone()[0],2)
                self.assertEqual(reader.execute('SELECT COUNT(*) FROM evidence').fetchone()[0],31)
                self.assertEqual(reader.execute('PRAGMA integrity_check').fetchone()[0],'ok')
                self.assertEqual(worker.status()['failures'],0)
            finally:
                reader.close();self.assertTrue(worker.stop()['stopped']);writer.close()

    def test_missing_database_never_created_and_non_wal_never_changed(self):
        with tempfile.TemporaryDirectory(prefix='daty-wal-missing-') as temp:
            path=Path(temp)/'missing.sqlite3'
            with self.assertRaises(RuntimeError):WalCheckpointer(path).start()
            self.assertFalse(path.exists())
            with closing(sqlite3.connect(path)) as c:c.execute('CREATE TABLE evidence(value)');c.commit()
            with self.assertRaises(RuntimeError):WalCheckpointer(path).start()
            with closing(sqlite3.connect(path)) as c:self.assertEqual(c.execute('PRAGMA journal_mode').fetchone()[0],'delete')


if __name__=='__main__':unittest.main()
