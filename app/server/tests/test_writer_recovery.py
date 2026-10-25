"""Recovery against real child processes/SQLite and loopback TLS/MQTT only."""
import asyncio
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import closing
import sqlite3
import time
import unittest
from test_process_persistence import WriterTests, device
from test_transport_recovery import TransportRecovery
from m6_test_support import eventually


def until(predicate, timeout=5):
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        if predicate(): return
        time.sleep(.02)
    raise AssertionError('Recovery did not complete')


class Recovery(WriterTests):
    def test_idle_exit_recovers_original_database_without_restarting_runtime(self):
        r=self.runtime();old=r._worker
        r.snapshot([device()], observed_at_ms=2000);self.assertTrue(r.wait_idle()['complete'])
        old.process.kill();old.process.wait(3)
        self.assertFalse(r.status()['accepting'])
        self.assertFalse(r.snapshot([device()],observed_at_ms=2500)['accepted'])
        until(lambda:r.status().get('recovery',{}).get('recoveries',0)==1)
        self.assertIsNot(r._worker,old);self.assertIsNotNone(old.process.poll())
        self.assertTrue(r.status()['writable']);self.assertEqual(r.boot_id,'boot-a')
        self.assertGreater(r.status()['refused'],0);self.assertFalse(r.status()['complete'])
        self.assertTrue(r.snapshot([device(freq=642000)],observed_at_ms=3000)['accepted'])
        self.assertTrue(r.wait_idle()['drained'])
        self.assertEqual(self.rows('SELECT frequency_khz FROM live_samples ORDER BY id'),[(641000,),(642000,)])
        self.assertEqual(self.rows('SELECT count(*) FROM live_boots'),[(1,)])

    def test_committed_reply_loss_stays_unknown_no_duplicate_after_recovery(self):
        r=self.runtime();old=r._worker;exchange=old._exchange
        def lose(request):
            result=exchange(request)
            if request['operation']=='batch':raise OSError('secret observation must not be logged')
            return result
        old._exchange=lose
        r.snapshot([device()],observed_at_ms=2000);state=r.wait_idle()
        self.assertEqual((state['committed'],state['failed']),(0,1))
        until(lambda:r.status()['recovery']['recoveries']==1)
        self.assertEqual(self.rows('SELECT count(*) FROM live_samples'),[(1,)])
        self.assertTrue(r.snapshot([device()],observed_at_ms=3000)['accepted']);r.wait_idle()
        self.assertEqual(self.rows('SELECT observed_at_ms FROM live_samples ORDER BY id'),[(2000,),(3000,)])
        self.assertEqual((r.status()['committed'],r.status()['failed']),(1,1))
        self.assertNotIn('secret',str(r.status()))
        self.assertEqual(r.status()['recovery']['history'][0]['fault']['code'],'WRITER_PIPE_FAILURE')

    def test_resume_refuses_changed_epoch_and_recovers_only_after_original_returns(self):
        r=self.runtime();old=r._worker
        old.process.kill();old.process.wait(3)
        with closing(sqlite3.connect(self.path)) as c:
            original=c.execute('SELECT epoch FROM db_identity').fetchone()[0]
            c.execute("UPDATE db_identity SET epoch='foreign-epoch'");c.commit()
        try:
            until(lambda:r.status()['recovery']['last_error'] is not None)
            self.assertFalse(r.status()['writable']);self.assertEqual(r.status()['recovery']['recoveries'],0)
            self.assertEqual(self.rows('SELECT count(*) FROM live_boots'),[(1,)])
        finally:
            with closing(sqlite3.connect(self.path)) as c:c.execute('UPDATE db_identity SET epoch=?',(original,));c.commit()
        until(lambda:r.status()['recovery']['recoveries']==1)

    def test_missing_database_is_not_created_and_shutdown_during_retry_is_bounded(self):
        r=self.runtime();old=r._worker;missing=self.path.with_name('missing.sqlite3')
        old.process.kill();old.process.wait(3);r._database=str(missing)
        until(lambda:r.status()['recovery']['last_error'] is not None)
        self.assertFalse(missing.exists());self.assertFalse(r.status()['writable'])
        attempts=r.status()['recovery']['attempts'];start=time.monotonic()
        self.assertTrue(r.stop(2)['stopped']);self.assertLess(time.monotonic()-start,1)
        time.sleep(.15);self.assertEqual(r.status()['recovery']['attempts'],attempts)

    def test_repeated_exits_keep_one_writer_and_resume_new_writes(self):
        r=self.runtime();previous=[]
        for i in range(3):
            old=r._worker;previous.append(old);old.process.kill();old.process.wait(3)
            until(lambda:r.status()['recovery']['recoveries']==i+1)
            self.assertTrue(all(p.process.poll() is not None for p in previous))
            self.assertTrue(r.snapshot([device()],observed_at_ms=2000+i)['accepted']);r.wait_idle()
        self.assertEqual(self.rows('SELECT count(*) FROM live_samples'),[(3,)])
        self.assertEqual(self.rows('SELECT count(*) FROM live_boots'),[(1,)])

    def test_schema_damage_blocks_recovery_and_preserves_evidence(self):
        r=self.runtime();old=r._worker;old.process.kill();old.process.wait(3)
        with closing(sqlite3.connect(self.path)) as c:
            c.execute('CREATE TABLE unexpected_recovery_table(value TEXT)');c.commit()
        try:
            until(lambda:r.status()['recovery']['last_error'] is not None)
            self.assertFalse(r.status()['writable']);self.assertEqual(r.status()['recovery']['recoveries'],0)
            self.assertEqual(self.rows('SELECT count(*) FROM live_samples'),[(0,)])
        finally:
            with closing(sqlite3.connect(self.path)) as c:c.execute('DROP TABLE unexpected_recovery_table');c.commit()
        until(lambda:r.status()['recovery']['recoveries']==1)

    def test_active_timeout_kills_child_and_reports_reason_then_recovers(self):
        r=self.runtime();old=r._worker;exchange=old._exchange
        def delay(request):
            if request['operation']=='batch':time.sleep(.25)
            return exchange(request)
        old._exchange=delay;old.timeout=.06
        r.snapshot([device()],observed_at_ms=2000);self.assertEqual(r.wait_idle()['failed'],1)
        self.assertIsNotNone(old.process.poll())
        until(lambda:r.status()['recovery']['recoveries']==1)
        self.assertEqual(old.last_fault['code'],'WRITER_ACTIVE_TIMEOUT')
        self.assertEqual(self.rows('SELECT count(*) FROM live_samples'),[(0,)])
        r.snapshot([device()],observed_at_ms=3000);r.wait_idle()
        self.assertEqual(self.rows('SELECT observed_at_ms FROM live_samples'),[(3000,)])


class Clock(unittest.TestCase):
    def test_suspended_time_does_not_exhaust_active_deadline(self):
        from m6_writer_process import wait_active
        with ThreadPoolExecutor(max_workers=1) as pool:
            # Simulated OS suspend: wall time advances but active clock is stopped.
            future=pool.submit(lambda:(time.sleep(.18),'committed')[1])
            self.assertEqual(wait_active(future,.03,clock=lambda:1),'committed')
            future=pool.submit(lambda:time.sleep(.18))
            with self.assertRaises(TimeoutError):wait_active(future,.03,clock=time.monotonic)


class Chain(TransportRecovery):
    async def test_writer_exit_restores_rpc_stream_and_settings_without_server_restart(self):
        r=self.runtime;p=self.b._unified_runtime
        initial=await self.rpc('devices.snapshot');boot=r.boot_id;epoch=self.epoch
        identities=[(d['id'],d['group_number']) for d in initial['devices']]
        settings=await self.rpc('database.resources.list',{'kind':'settings','limit':50})
        old=p._worker;old.process.kill();await asyncio.to_thread(old.process.wait,3)
        snapshot=await self.recovered(0)
        self.assertEqual([(d['id'],d['group_number']) for d in snapshot['devices']],identities)
        self.assertEqual(r.boot_id,boot);self.assertEqual(self.epoch,epoch)
        self.assertTrue(p.status()['writable']);self.assertGreater(p.status()['recovery']['recoveries'],0)
        self.assertEqual(settings,await self.rpc('database.resources.list',{'kind':'settings','limit':50}))
        await self.read_stream_snapshot()
        before=p.status()['committed']
        await self.receivers[0].publish('daty/rf/devices/up',{'type':'device_status_update',
            'control_protocol':'fashe-realtime-v1','channel':1,'channel_number':1,'freq_mhz':640.25,'muted':False})
        await eventually(lambda:p.status()['committed']>before)
        self.assertTrue(all(not rx.executions for rx in self.receivers))

    async def test_writer_failure_does_not_replay_inflight_device_command(self):
        r=self.runtime;rx=self.receivers[0];rx.acknowledge=False;intent=self.intent()
        await self.rpc('commands.request',intent);await eventually(lambda:len(rx.executions)==1)
        old=self.b._unified_runtime._worker;old.process.kill();await asyncio.to_thread(old.process.wait,3)
        await self.recovered(0)
        result=await self.rpc('commands.get',{'operation_id':intent['operation_id']})
        self.assertEqual(result['attempts'],1);self.assertIsNone(result['execution_evidence'])
        await asyncio.sleep(.2);self.assertEqual(len(rx.executions),1)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([loader.loadTestsFromTestCase(Clock),
        *(Recovery(n) for n in Recovery.__dict__ if n.startswith('test_')),
        *(Chain(n) for n in Chain.__dict__ if n.startswith('test_'))])
