"""Real child/SQLite fixtures only. No Bridge import, network or site devices."""
from contextlib import contextmanager, closing
import copy
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[2])]
import unified_bootstrap
from unified_runtime import UnifiedRuntime, RuntimeStartupError
from m6_process_runtime import ProcessRuntime


def device(**fields):
    return {'id': 'rx_ch1', 'receiver_id': 'rx', 'receiver_mac': '02:00:00:00:00:01',
            'receiver_ip': '127.0.0.1', 'group_number': 11, 'channel_number': 1,
            'brand': 'DATYaudio', 'model': 'RF PRO', '_source': 'rx:mqtt:session-a',
            '_online': True, '_age_s': 0, 'freq': 641000, 'rf': -60,
            'af_dbfs': 0, 'batt': 0, 'muted': False, **fields}


class WriterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='daty-m6-writer-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'business.sqlite3'
        with closing(unified_bootstrap.open_database(self.path)) as c:
            unified_bootstrap.initialize(c, 1000)
            c.commit()
            unified_bootstrap.enable_wal(c)
        self.lock = threading.RLock()
        self.bridge = SimpleNamespace(_db_session=lambda: None, _db_path=str(self.path),
                                      _db_lock=self.lock, _clock_state={'server_id': 'boot-a'})

    def runtime(self, **kwargs):
        r = ProcessRuntime(self.bridge, now_ms=lambda: 1000, **kwargs)
        def cleanup():
            self.assertTrue(r.stop(timeout=10)['stopped'])
            if r._worker:
                self.assertIsNotNone(r._worker.process.poll())
        self.addCleanup(cleanup)
        r.start()
        return r

    def rows(self, sql):
        with closing(sqlite3.connect(self.path)) as c:
            return c.execute(sql).fetchall()

    def test_full_domain_parity_against_original_all_tables(self):
        baseline = self.path.with_name('baseline.sqlite3')
        shutil.copyfile(self.path, baseline)
        c = unified_bootstrap.open_database(baseline)
        self.addCleanup(c.close)
        @contextmanager
        def session():
            try:
                yield c
                c.commit()
            except Exception:
                c.rollback()
                raise
        old = UnifiedRuntime(session, 'boot-a', now_ms=lambda: 1000)
        self.addCleanup(old.stop)
        old.start()
        new = self.runtime()
        for index in range(180):
            value = device(rf=-50-index/100, af_dbfs=None if index % 2 else 0,
                           muted=bool(index % 3), group_number=4 if index > 80 else 11,
                           extra={'nested': [0, None, True], 'access_token': 'not-for-storage'})
            if index in (23, 91):
                value['channel_number'] = 0  # Independent savepoint failure.
            for r in (old, new):
                self.assertTrue(r.snapshot([copy.deepcopy(value)], observed_at_ms=2000+index)['accepted'])
            if index % 60 == 59:
                self.assertTrue(old.wait_idle()['drained'])
                self.assertTrue(new.wait_idle()['drained'])
        command = {'command_id': 'command-a', 'device_id': 'rx_ch1', 'receiver_id': 'rx',
                   'channel_number': 1, 'command': 'mute', 'status': 'published',
                   'expected_value': True, 'actual_value': None, 'created_at': 3, 'updated_at': 3}
        history = {'device_id': 'rx_ch1', 'ts': 4.125,
                   'sample': {'freq': 641000, 'rf': None, 'af_dbfs': 0, 'batt': 0, 'muted': 0, 'status': 'online'},
                   'event': {'event_type': 'device.discovered', 'summary': '真实编组', 'details': {'group': 4}}}
        for r in (old, new):
            r.command(command, observed_at_ms=3000)
            r.device_history(history)
            r.snapshot([], full=True, observed_at_ms=4000)
            r.snapshot([device()], observed_at_ms=3999)  # Cannot revive removal watermark.
            state = r.wait_idle()
            self.assertEqual((state['committed'], state['failed'], state['refused'], state['outstanding']), (182, 2, 0, 0))
        with closing(sqlite3.connect(self.path)) as target:
            self.assertEqual('\n'.join(target.iterdump()), '\n'.join(c.iterdump()))
            self.assertEqual(target.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
            self.assertEqual(target.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_child_time_slices_keep_every_dequeued_observation_in_order(self):
        r = self.runtime()
        original = r._worker._exchange
        def small(request):
            if request['operation'] == 'batch':
                request = {**request, 'budget': .000001}
            return original(request)
        r._worker._exchange = small
        for index in range(160):
            self.assertTrue(r.snapshot([device()], observed_at_ms=2000+index)['accepted'])
        state = r.wait_idle(10)
        self.assertTrue(state['complete'], state)
        self.assertEqual(state['queue_bytes'], 0)
        self.assertEqual(self.rows('SELECT observed_at_ms FROM live_samples ORDER BY id'), [(2000+n,) for n in range(160)])

    def test_acceptance_is_immutable_and_not_durability_while_rpc_lock_held(self):
        r = self.runtime()
        with self.lock:
            value = device(extra={'before': True})
            reply = r.snapshot([value], observed_at_ms=2000)
            value['extra']['before'] = False
            time.sleep(.03)
            self.assertTrue(reply['accepted'])
            self.assertFalse(reply['persisted'])
            self.assertEqual(r.status()['committed'], 0)
            self.assertEqual(self.rows('SELECT COUNT(*) FROM live_samples')[0][0], 0)
        self.assertTrue(r.wait_idle()['complete'])
        from rf_sample_storage import load_snapshot
        with closing(sqlite3.connect(self.path)) as c:
            self.assertTrue(json.loads(load_snapshot(c, c.execute('SELECT id FROM live_samples').fetchone()[0]))['extra']['before'])

    def test_lost_commit_reply_is_unconfirmed_and_never_replayed(self):
        r = self.runtime()
        exchange = r._worker._exchange
        def lose_reply(request):
            reply = exchange(request)
            if request['operation'] == 'batch':
                raise OSError('private diagnostic must not escape')
            return reply
        r._worker._exchange = lose_reply
        r.snapshot([device()], observed_at_ms=2000)
        state = r.wait_idle()
        self.assertEqual((state['committed'], state['failed'], state['outstanding']), (0, 1, 0))
        self.assertIsNotNone(r._worker.process.poll())
        self.assertEqual(self.rows('SELECT COUNT(*) FROM live_samples')[0][0], 1)
        self.assertFalse(r.snapshot([device()], observed_at_ms=3000)['accepted'])
        self.assertEqual(r.wait_idle()['failed'], 1)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM live_samples')[0][0], 1)
        self.assertNotIn('private', json.dumps(r.status()))

    def test_timeout_kills_actual_inflight_transaction_before_releasing_lock(self):
        r = self.runtime()
        with self.lock, closing(sqlite3.connect(self.path)) as c:
            c.execute('''CREATE TRIGGER slow_sample BEFORE INSERT ON live_samples BEGIN
              SELECT sum(x) FROM (WITH RECURSIVE slow(x) AS
              (SELECT 1 UNION ALL SELECT x+1 FROM slow WHERE x<100000000) SELECT x FROM slow);
              END''')
            c.commit()
        r._worker.timeout = .15
        r.snapshot([device()], observed_at_ms=2000)
        state = r.wait_idle(5)
        self.assertEqual((state['committed'], state['failed'], state['outstanding']), (0, 1, 0))
        self.assertIsNotNone(r._worker.process.poll())
        with closing(sqlite3.connect(self.path, timeout=0)) as c:
            c.execute('BEGIN IMMEDIATE')
            self.assertEqual(c.execute('SELECT COUNT(*) FROM live_samples').fetchone()[0], 0)
            self.assertEqual(c.execute('SELECT COUNT(*) FROM live_channels').fetchone()[0], 0)
            c.rollback()

    def test_same_queue_item_and_byte_backpressure_remains_latched(self):
        r = self.runtime(capacity=1, max_queue_bytes=4096)
        with self.lock:
            r.snapshot([device()], observed_at_ms=2000)
            time.sleep(.03)  # First batch is waiting for the same RPC lock.
            self.assertTrue(r.snapshot([device()], observed_at_ms=3000)['accepted'])
            self.assertEqual(r.snapshot([device()], observed_at_ms=4000)['code'], 'QUEUE_BACKPRESSURE')
        state = r.wait_idle()
        self.assertEqual((state['committed'], state['refused']), (2, 1))
        self.assertFalse(state['complete'])
        self.assertEqual(r.snapshot([device(extra='x'*5000)])['code'], 'QUEUE_BYTE_BACKPRESSURE')

    def test_missing_database_fails_closed_without_creating_replacement(self):
        self.bridge._db_path = str(self.path.with_name('missing.sqlite3'))
        r = ProcessRuntime(self.bridge, now_ms=lambda: 1000)
        self.addCleanup(r.stop)
        with self.assertRaises(RuntimeStartupError):
            r.start()
        self.assertFalse(Path(self.bridge._db_path).exists())
        self.assertFalse(r.snapshot([device()])['accepted'])

    def test_stop_drains_and_restart_does_not_reactivate_old_channels(self):
        one = self.runtime()
        one.snapshot([device()], observed_at_ms=1000)
        self.assertTrue(one.stop()['stopped'])
        self.assertEqual(one.status()['committed'], 1)
        self.assertFalse(one.snapshot([device()])['accepted'])
        self.bridge._clock_state['server_id'] = 'boot-b'
        two = self.runtime()
        self.assertEqual(self.rows('SELECT declared_online FROM live_latest'), [(0,)])
        self.assertEqual(self.rows('SELECT COUNT(*) FROM live_samples'), [(1,)])
        self.assertTrue(two.status()['complete'])

    def test_idle_child_exit_is_unavailable_without_waiting_for_new_data(self):
        r = self.runtime()
        r._worker.process.kill()
        r._worker.process.wait(3)
        state = r.status()
        self.assertFalse(state['accepting'])
        self.assertFalse(state['complete'])
        self.assertEqual(state['last_error']['code'], 'WRITER_PROCESS_UNAVAILABLE')
        self.assertFalse(r.snapshot([device()])['accepted'])

    def test_scheduling_lease_restores_host_and_respects_shorter_interval(self):
        from m6_scheduling import SchedulingLease
        previous = sys.getswitchinterval()
        self.addCleanup(sys.setswitchinterval, previous)
        sys.setswitchinterval(.005)
        one, two = SchedulingLease(), SchedulingLease()
        try:
            self.assertEqual(sys.getswitchinterval(), .001)
            one.close()
            self.assertEqual(sys.getswitchinterval(), .001)
        finally:
            one.close()
            two.close()
        self.assertEqual(sys.getswitchinterval(), .005)
        sys.setswitchinterval(.0005)
        one = SchedulingLease()
        one.close()
        self.assertEqual(sys.getswitchinterval(), .0005)


if __name__ == '__main__':
    unittest.main()
