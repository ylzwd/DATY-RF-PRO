"""Bounded 50-channel WAL/FULL disk fixture; no service or receiver transport."""
from contextlib import contextmanager
from pathlib import Path
import json
import sqlite3
import tempfile
import threading
import time
import unittest

import unified_database as database
import unified_live
from unified_runtime import UnifiedRuntime
from unified_schema import LEGACY_DDL


class RuntimeDiskLoadTests(unittest.TestCase):
    def test_hundred_channel_sparse_bursts_keep_every_sample_and_reduce_commits(self):
        with tempfile.TemporaryDirectory(prefix='daty-unified-burst-') as directory:
            connection=sqlite3.connect(Path(directory)/'fixture.sqlite3',check_same_thread=False)
            connection.execute('PRAGMA journal_mode=WAL'); connection.execute('PRAGMA synchronous=FULL')
            for statement in unified_live.schema_statements():connection.execute(statement)
            connection.commit(); lock=threading.RLock(); gate=threading.Event(); entered=threading.Event(); blocked=False
            @contextmanager
            def session():
                if blocked:entered.set();gate.wait(5)
                with lock:
                    try:yield connection;connection.commit()
                    except Exception:connection.rollback();raise
            runtime=UnifiedRuntime(session,'fixture-burst');runtime.start()
            try:
                blocked=True
                for ch in range(100):
                    device={'id':f'rx-{ch//50}_ch{ch%50+1}','receiver_id':f'rx-{ch//50}',
                        'channel_number':ch%50+1,'brand':'DATYaudio','_source':f'fixture-{ch//50}',
                        '_online':True,'_age_s':0,'freq':640000+250*ch,'rf':-60,'af_dbfs':-20,'batt':75,'muted':False}
                    self.assertTrue(runtime.snapshot([device],observed_at_ms=2000+ch)['accepted'])
                self.assertTrue(entered.wait(1)); self.assertEqual(runtime.status()['committed'],0)
                gate.set();status=runtime.wait_idle(timeout=20)
                self.assertTrue(status['complete'],status);self.assertEqual(status['committed'],100)
                self.assertLess(status['write_batches'],100)
                with lock:
                    self.assertEqual(connection.execute('SELECT COUNT(*) FROM live_samples').fetchone()[0],100)
                    self.assertEqual(connection.execute('SELECT COUNT(*) FROM live_latest').fetchone()[0],100)
                    self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            finally:
                gate.set();self.assertTrue(runtime.stop(timeout=20)['stopped']);connection.close()

    def test_fifty_channels_and_business_cas_keep_all_committed_samples(self):
        with tempfile.TemporaryDirectory(prefix='daty-unified-load-') as directory:
            file=Path(directory)/'fixture.sqlite3'
            @contextmanager
            def session():
                connection=sqlite3.connect(file,timeout=5)
                try:
                    connection.execute('PRAGMA foreign_keys=ON')
                    connection.execute('PRAGMA synchronous=FULL')
                    yield connection
                    connection.commit()
                except Exception:
                    connection.rollback()
                    raise
                finally:
                    connection.close()
            with session() as c:
                c.execute('PRAGMA journal_mode=WAL')
                for statement in LEGACY_DDL:c.execute(statement)
                state=database.migrate(c,1000)
            runtime=UnifiedRuntime(session,'fixture-boot',capacity=256,now_ms=lambda:1000)
            producer=[];started=time.monotonic();runtime.start()
            try:
                for frame in range(50):
                    devices=[{'id':f'rx-{ch//8}_ch{ch%8+1}','receiver_id':f'rx-{ch//8}',
                        'channel_number':ch%8+1,'brand':'DATYaudio','_source':f'fixture-session-{ch//8}',
                        '_online':True,'_age_s':0,'freq':640000+250*ch,'rf':-60-frame%10,
                        'af_dbfs':-20,'batt':75,'muted':False} for ch in range(50)]
                    before=time.monotonic()
                    receipt=runtime.snapshot(devices,observed_at_ms=2000+frame*100,full=True)
                    producer.append((time.monotonic()-before)*1000)
                    self.assertTrue(receipt['accepted']);self.assertFalse(receipt['persisted'])
                    if frame==25:
                        with session() as c:
                            database.put_resource(c,{'operation_id':'fixture_parallel_business_123','epoch':state['epoch'],
                                'kind':'settings','id':'alert_sound','expected_revision':0,'value':{'enabled':True}},
                                {'id':'fixture-operator'},3000)
                status=runtime.wait_idle(timeout=20)
                self.assertTrue(status['complete'],status)
                with session() as c:
                    self.assertEqual(c.execute('SELECT COUNT(*) FROM live_samples').fetchone()[0],2500)
                    self.assertEqual(c.execute('SELECT COUNT(*) FROM live_latest').fetchone()[0],50)
                    self.assertEqual(c.execute('SELECT COUNT(*) FROM live_commands').fetchone()[0],0)
                    self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(),[])
                    self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0],'ok')
                    self.assertEqual(unified_live.get_overview(c,'fixture-boot',7000)['online_devices'],7)
                    self.assertEqual(database.get_resource(c,'settings','alert_sound')['revision'],1)
                print(json.dumps({'fixture':'50-channel-disk-wal-full','samples':2500,'frames':50,
                    'elapsed_seconds':round(time.monotonic()-started,3),
                    'producer_max_ms':round(max(producer),3),'producer_mean_ms':round(sum(producer)/len(producer),3),
                    'productionWrites':0,'deviceCommands':0,'timingsAreMachineSpecific':True}))
            finally:
                self.assertTrue(runtime.stop(timeout=20)['stopped'])


if __name__=='__main__':unittest.main()
