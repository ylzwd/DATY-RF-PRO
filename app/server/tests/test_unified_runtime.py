"""In-memory SQLite/thread fixtures only; never imports or starts a live Bridge."""
from contextlib import contextmanager
import json
import sqlite3
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unified_live
from unified_runtime import UnifiedRuntime, RuntimeStartupError


def device(**extra):
    return {'id': 'rx_ch1', 'receiver_id': 'rx', 'channel_number': 1, 'brand': 'DATYaudio',
            '_source': 'receiver:mqtt:session-a', '_online': True, '_age_s': 0,
            'freq': 641000, 'rf': -60, 'af_dbfs': -20, 'batt': 75, 'muted': False, **extra}


def command(**extra):
    return {'command_id': 'command-a', 'device_id': 'rx_ch1', 'receiver_id': 'rx', 'channel_number': 1,
            'command': 'mute', 'status': 'published', 'expected_value': True, 'actual_value': None,
            'created_at': 1, 'updated_at': 1, **extra}


class UnifiedRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:', check_same_thread=False)
        self.db.execute('PRAGMA foreign_keys=ON')
        for statement in unified_live.schema_statements():
            self.db.execute(statement)
        self.db.commit()
        self.lock = threading.RLock()
        self.io_threads, self.errors = [], []
        self.block = None
        self.entered = threading.Event()
        self.fail_write = self.fail_after_commit = False
        self.runtimes = []

    def tearDown(self):
        if self.block:
            self.block.set()
        for runtime in self.runtimes:
            self.assertTrue(runtime.stop()['stopped'])
        self.db.close()

    @contextmanager
    def session(self):
        self.io_threads.append(threading.get_ident())
        if self.block:
            self.entered.set()
            self.block.wait(2)
        with self.lock:
            try:
                if self.fail_write:
                    raise sqlite3.OperationalError('SQL secret: must-not-leak')
                yield self.db
                self.db.commit()
                if self.fail_after_commit:
                    raise sqlite3.OperationalError('commit reply secret: must-not-leak')
            except Exception:
                self.db.rollback()
                raise

    def runtime(self, **options):
        instance = UnifiedRuntime(self.session, options.pop('boot_id', 'boot-a'), now_ms=lambda: 1000,
                                  on_error=self.errors.append, **options)
        self.runtimes.append(instance)
        return instance

    def test_startup_commits_boot_before_reporting_ready_without_opening_connections(self):
        runtime = self.runtime()
        state = runtime.start()
        self.assertTrue(state['started']); self.assertTrue(state['complete'])
        self.assertEqual(self.db.execute('SELECT boot_id FROM live_boots').fetchone()[0], 'boot-a')
        self.assertTrue(all(identifier != threading.get_ident() for identifier in self.io_threads))

    def test_missing_schema_fails_startup_and_never_claims_ready(self):
        self.db.execute('DROP TABLE live_boots'); self.db.commit()
        runtime = self.runtime()
        with self.assertRaises(RuntimeStartupError):
            runtime.start()
        self.assertFalse(runtime.status()['started']); self.assertFalse(runtime.status()['complete'])
        self.assertEqual(runtime.status()['last_error']['code'], 'STARTUP_DATABASE_FAILED')

    def test_startup_timeout_cannot_later_become_usable(self):
        self.block = threading.Event()
        runtime = self.runtime()
        with self.assertRaises(RuntimeStartupError):
            runtime.start(timeout=0.01)
        self.block.set()
        self.assertTrue(runtime.stop()['stopped'])
        self.assertFalse(runtime.status()['started'])
        self.assertFalse(runtime.snapshot([device()])['accepted'])

    def test_producer_capture_is_immutable_and_queue_acceptance_is_not_commit(self):
        runtime = self.runtime(); runtime.start()
        self.block = threading.Event()
        value = device(extra={'future': 1})
        receipt = runtime.snapshot([value], observed_at_ms=2000)
        self.assertTrue(receipt['accepted']); self.assertFalse(receipt['persisted'])
        self.assertTrue(self.entered.wait(1))
        value['muted'] = True; value['extra']['future'] = 2
        self.assertFalse(runtime.status()['complete'])
        self.block.set()
        self.assertTrue(runtime.wait_idle()['complete'])
        from rf_sample_storage import load_snapshot
        stored = json.loads(load_snapshot(self.db, self.db.execute('SELECT id FROM live_samples').fetchone()[0]))
        self.assertFalse(stored['muted']); self.assertEqual(stored['extra']['future'], 1)

    def test_queue_backpressure_is_nonblocking_explicit_and_remains_latched(self):
        runtime = self.runtime(capacity=1); runtime.start()
        self.block = threading.Event()
        runtime.snapshot([device()], observed_at_ms=2000)
        self.assertTrue(self.entered.wait(1))
        self.assertTrue(runtime.command(command())['accepted'])
        started = time.monotonic()
        refused = runtime.snapshot([device()], observed_at_ms=3000)
        self.assertLess(time.monotonic() - started, 0.25)
        self.assertEqual(refused['code'], 'QUEUE_BACKPRESSURE')
        self.block.set()
        status = runtime.wait_idle()
        self.assertTrue(status['drained']); self.assertFalse(status['complete'])
        self.assertEqual((status['committed'], status['refused']), (2, 1))
        self.assertEqual(status['state'], 'degraded')

    def test_byte_backpressure_is_explicit_without_enqueuing_or_truncating(self):
        runtime = self.runtime(max_queue_bytes=1024); runtime.start()
        receipt = runtime.snapshot([device(extra='x' * 2000)])
        self.assertEqual(receipt['code'], 'QUEUE_BYTE_BACKPRESSURE')
        self.assertEqual(runtime.status()['accepted'], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM live_samples').fetchone()[0], 0)

    def test_write_failure_rolls_back_normalized_rows_and_evidence_together(self):
        runtime = self.runtime(); runtime.start()
        self.db.execute("CREATE TRIGGER fail_samples BEFORE INSERT ON live_samples BEGIN SELECT RAISE(ABORT,'secret SQL'); END")
        self.db.commit()
        runtime.snapshot([device()], observed_at_ms=2000)
        state = runtime.wait_idle()
        self.assertEqual((state['committed'], state['failed']), (0, 1))
        self.assertFalse(state['complete'])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM live_channels').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM live_samples').fetchone()[0], 0)
        self.assertNotIn('secret', json.dumps(state))

    def test_commit_reply_failure_is_unknown_not_false_durable_success_or_retry(self):
        runtime = self.runtime(); runtime.start()
        self.fail_after_commit = True
        runtime.command(command())
        state = runtime.wait_idle()
        self.assertEqual((state['committed'], state['failed']), (0, 1))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM live_command_events').fetchone()[0], 1)
        self.assertEqual(state['last_error']['code'], 'DATABASE_WRITE_UNCONFIRMED')
        self.assertFalse(state['complete']); self.assertNotIn('must-not-leak', json.dumps(state))

    def test_later_success_cannot_hide_an_earlier_unconfirmed_write(self):
        runtime = self.runtime(); runtime.start()
        self.fail_write = True
        runtime.snapshot([device()], observed_at_ms=2000)
        self.assertEqual(runtime.wait_idle()['failed'], 1)
        self.fail_write = False
        runtime.snapshot([device()], observed_at_ms=3000)
        state = runtime.wait_idle()
        self.assertEqual((state['committed'], state['failed']), (1, 1)); self.assertFalse(state['complete'])

    def test_fifo_local_mute_and_full_removal_are_kept_without_recreating_assets(self):
        runtime = self.runtime(); runtime.start()
        runtime.snapshot([device()], observed_at_ms=2000, full=True)
        runtime.snapshot([device(muted=True)], observed_at_ms=3000)
        runtime.snapshot([], observed_at_ms=4000, full=True)
        self.assertTrue(runtime.wait_idle()['complete'])
        self.assertEqual(self.db.execute('SELECT muted FROM live_samples ORDER BY id').fetchall(), [(0,), (1,)])
        self.assertEqual(self.db.execute('SELECT removed FROM live_latest').fetchone()[0], 1)

    def test_command_evidence_stays_exact_and_matching_value_does_not_invent_ack(self):
        runtime = self.runtime(); runtime.start()
        runtime.command(command(actual_value=True, ack_evidence={'source_key': 'rx:mqtt:source'}))
        self.assertTrue(runtime.wait_idle()['complete'])
        row = self.db.execute('SELECT status,record_json FROM live_commands').fetchone()
        self.assertEqual(row[0], 'published')
        self.assertEqual(json.loads(row[1])['ack_evidence']['source_key'], 'rx:mqtt:source')

    def test_boot_switch_does_not_restore_old_receivers_or_command_sending(self):
        one = self.runtime(); one.start()
        one.snapshot([device()], observed_at_ms=1000)
        one.command(command())
        self.assertTrue(one.wait_idle()['complete']); one.stop()
        two = self.runtime(boot_id='boot-b'); two.start()
        self.assertEqual(unified_live.get_overview(self.db, 'boot-b', 1000)['active_channels'], 0)
        self.assertEqual(self.db.execute('SELECT status FROM live_commands').fetchone()[0], 'published')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM live_command_events').fetchone()[0], 1)

    def test_logging_errors_and_receiver_payload_secrets_do_not_escape_diagnostics_or_db(self):
        runtime = self.runtime(); runtime.start()
        runtime.command(command(actor={'id': 'operator', 'role': 'operator', 'token': 'must-not-leak'},
                                private_key='must-not-leak'))
        self.assertTrue(runtime.wait_idle()['complete'])
        self.assertNotIn('must-not-leak', self.db.execute('SELECT record_json FROM live_commands').fetchone()[0])
        self.fail_write = True; runtime.command(command(command_id='command-b'))
        runtime.wait_idle()
        self.assertNotIn('must-not-leak', json.dumps(runtime.status()))

    def test_stop_drains_accepted_work_and_refuses_new_work(self):
        runtime = self.runtime(); runtime.start()
        runtime.snapshot([device()])
        stopped = runtime.stop()
        self.assertTrue(stopped['stopped']); self.assertEqual(stopped['committed'], 1)
        self.assertFalse(runtime.command(command())['accepted'])

    def test_invalid_serialization_is_explicit_and_never_reaches_writer(self):
        runtime = self.runtime(); runtime.start()
        circular = {}; circular['cycle'] = circular
        self.assertEqual(runtime.command(circular)['code'], 'INVALID_OBSERVATION')
        self.assertEqual(runtime.snapshot('bad')['code'], 'INVALID_OBSERVATION')
        self.assertEqual(runtime.status()['accepted'], 0)

    def test_fifo_burst_batches_commits_without_dropping_samples_or_early_durability(self):
        runtime = self.runtime(); runtime.start()
        self.block = threading.Event()
        for number in range(64):
            self.assertTrue(runtime.snapshot([device(rf=-60-number/100)], observed_at_ms=2000+number)['accepted'])
        self.assertTrue(self.entered.wait(1))
        self.assertEqual(runtime.status()['committed'], 0)
        self.block.set()
        status = runtime.wait_idle()
        self.assertTrue(status['complete'], status)
        self.assertEqual(status['committed'], 64)
        self.assertLess(status['write_batches'], 64)
        self.assertGreater(status['largest_batch'], 1)
        self.assertLessEqual(status['largest_batch'], status['batch_limit'])
        self.assertEqual(self.db.execute('SELECT observed_at_ms FROM live_samples ORDER BY id').fetchall(),
                         [(2000+n,) for n in range(64)])

    def test_bad_observation_rolls_back_only_itself_inside_fifo_batch(self):
        runtime = self.runtime(); runtime.start(); self.block = threading.Event()
        runtime.snapshot([device()], observed_at_ms=2000)
        self.assertTrue(self.entered.wait(1))
        runtime.snapshot([device(channel_number=0)], observed_at_ms=3000)
        runtime.snapshot([device(muted=True)], observed_at_ms=4000)
        self.block.set(); status = runtime.wait_idle()
        self.assertEqual((status['committed'], status['failed']), (2, 1))
        self.assertFalse(status['complete'])
        self.assertEqual(self.db.execute('SELECT observed_at_ms,muted FROM live_samples ORDER BY id').fetchall(),
                         [(2000,0),(4000,1)])

    def test_ambiguous_batch_commit_accounts_every_dequeued_item_without_retry(self):
        runtime = self.runtime(); runtime.start(); self.block = threading.Event()
        runtime.snapshot([device()], observed_at_ms=2000)
        self.assertTrue(self.entered.wait(1))
        runtime.snapshot([device(muted=True)], observed_at_ms=3000)
        self.fail_after_commit = True; self.block.set(); status = runtime.wait_idle()
        self.assertEqual((status['committed'], status['failed'], status['outstanding']), (0,2,0))
        self.assertEqual(status['queue_bytes'], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM live_samples').fetchone()[0], 2)
        self.assertFalse(status['complete'])

    def test_time_budget_releases_transaction_even_with_more_work_queued(self):
        runtime = self.runtime(); runtime.start(); runtime._batch_budget_s = 0
        self.block = threading.Event()
        for number in range(8): runtime.snapshot([device()], observed_at_ms=2000+number)
        self.assertTrue(self.entered.wait(1)); self.block.set(); status = runtime.wait_idle()
        self.assertTrue(status['complete']); self.assertEqual(status['write_batches'], 8)
        self.assertEqual(status['largest_batch'], 1)

    def history_schema(self):
        from unified_schema import LEGACY_DDL
        for statement in LEGACY_DDL:
            self.db.execute(statement)
        self.db.commit()

    def history(self):
        return {'device_id':'rx_ch1','ts':12.345,
                'sample':{'freq':641000,'rf':None,'af_dbfs':0,'batt':0,'muted':0,'status':'online'},
                'event':{'event_type':'device.discovered','summary':'设备上线：CH1',
                         'details':{'freq':641000,'muted':False,'status':'online'}}}

    def test_legacy_sample_captures_timestamp_null_zero_without_retired_event(self):
        self.history_schema(); runtime=self.runtime();runtime.start();self.block=threading.Event()
        record=self.history();receipt=runtime.device_history(record)
        self.assertTrue(receipt['accepted']);self.assertFalse(receipt['persisted'])
        self.assertTrue(self.entered.wait(1));record['sample']['freq']=690000;record['event']['details']['muted']=True
        self.block.set();self.assertTrue(runtime.wait_idle()['complete'])
        self.assertEqual(self.db.execute('SELECT ts,frequency_khz,rf_dbm,af_dbfs,battery_percent,muted FROM telemetry_samples').fetchone(),
                         (12.345,641000,None,0,0,0))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM timeline_events').fetchone()[0],0)

    def test_legacy_sample_failure_rolls_back_but_next_observation_survives(self):
        self.history_schema(); runtime=self.runtime();runtime.start();self.block=threading.Event()
        self.db.execute("CREATE TRIGGER broken_history BEFORE INSERT ON telemetry_samples BEGIN SELECT RAISE(ABORT,'fixture'); END")
        self.db.commit();runtime.device_history(self.history());self.assertTrue(self.entered.wait(1))
        runtime.snapshot([device()],observed_at_ms=3000);self.block.set();state=runtime.wait_idle()
        self.assertEqual((state['committed'],state['failed']),(1,1));self.assertFalse(state['complete'])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM telemetry_samples').fetchone()[0],0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM live_samples').fetchone()[0],1)

    def test_legacy_ambiguous_commit_is_reported_without_replay(self):
        self.history_schema();runtime=self.runtime();runtime.start();self.fail_after_commit=True
        runtime.device_history(self.history());state=runtime.wait_idle()
        self.assertEqual((state['committed'],state['failed']),(0,1))
        self.assertEqual(state['last_error']['kind'],'device_history')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM telemetry_samples').fetchone()[0],1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM timeline_events').fetchone()[0],0)


if __name__ == '__main__':
    unittest.main()
