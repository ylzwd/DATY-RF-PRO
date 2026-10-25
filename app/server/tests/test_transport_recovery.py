import asyncio
import json
import time
from unittest.mock import patch
from test_stage6 import Integration
from m6_test_support import eventually,oid
from tls_support import client_context
from mqtt_wire import WSReader,packet,utf,string,number
import websockets

class TransportRecovery(Integration):
    async def recovered(self, previous):
        r=self.runtime
        await eventually(lambda:r.transport.recoveries>previous and r.transport.ready,timeout=15)
        for rx in self.receivers:
            await rx.close();await rx.start()
        self.ui=await self.new_ui()
        return await self.rpc('devices.snapshot')

    async def read_stream_snapshot(self):
        async with websockets.connect(self.runtime.uri+'/mqtt-readonly',ssl=client_context(self.tls),subprotocols=['mqtt'],proxy=None) as ws:
            reader=WSReader(ws)
            await ws.send(packet(0x10,utf('MQTT')+b'\x05\x02\x00\x0a\x00'+utf('')))
            self.assertEqual((await reader.read())[0],0x20)
            await ws.send(packet(0x82,b'\x00\x01\x00'+utf('daty/v2/daty-rf-pro/devices/read')+b'\x01'))
            self.assertEqual((await reader.read())[0],0x90)
            h,b=await asyncio.wait_for(reader.read(),3);self.assertEqual(h>>4,3)
            _,pos=string(b);mid=b[pos:pos+2];size,pos=number(b,pos+2)
            value=json.loads(b[pos+size:]);await ws.send(packet(0x40,mid))
            self.assertEqual((value['seq'],value['kind']),(1,'device_list'))
            return value

    async def test_internal_disconnect_recovers_without_runtime_restart(self):
        r=self.runtime;boot=r.boot_id;repo=r.repo;pid=r.process.pid
        old=self.ui.sid
        await asyncio.to_thread(r.gateways['/mqtt-app'].business.client.disconnect)
        await eventually(lambda:not r.gateways['/mqtt-app'].business.client.is_connected())
        await asyncio.sleep(.6)
        async def query():
            last=None
            for _ in range(20):
                try:
                    ui=await asyncio.wait_for(self.new_ui(),1)
                    return await self.rpc('devices.snapshot',ui=ui),ui
                except Exception as error:
                    last=error;await asyncio.sleep(.2)
            raise AssertionError('RPC never recovered without restarting Runtime') from last
        snapshot,ui=await query()
        self.assertNotEqual(old,ui.sid)
        self.assertEqual(boot,r.boot_id);self.assertIs(repo,r.repo);self.assertEqual(pid,r.process.pid)
        snapshot=await self.recovered(0)
        self.assertEqual(len(snapshot['devices']),4)
        self.assertTrue(all(not rx.executions for rx in self.receivers))

    async def test_transport_each_private_role_reconnects_fresh_and_preserves_settings(self):
        r=self.runtime
        write={'kind':'settings','id':'alert_sound','value':{'enabled':True},'deleted':False,'expected_revision':0,'epoch':self.epoch,'operation_id':oid()}
        await self.rpc('database.write',write)
        settings=await self.rpc('database.resources.get',{'kind':'settings','id':'alert_sound'})
        identities=[(d['id'],d['group_number']) for d in (await self.rpc('devices.snapshot'))['devices']]
        first=await self.read_stream_snapshot()
        for role in ('app-business','enrollment-business','view-publisher','rx-ingress','rx-business'):
            with self.subTest(role=role):
                previous=r.transport.recoveries;old_clients=list(r.clients);old_sid=self.ui.sid
                c=next(c for c in r.clients if c.role==role)
                await asyncio.to_thread(c.client.disconnect)
                snapshot=await self.recovered(previous)
                self.assertEqual(identities,[(d['id'],d['group_number']) for d in snapshot['devices']])
                self.assertNotEqual(old_sid,self.ui.sid)
                self.assertTrue(all(c not in old_clients for c in r.clients))
                self.assertTrue(all(not c.client.is_connected() for c in old_clients))
                self.assertEqual(settings,await self.rpc('database.resources.get',{'kind':'settings','id':'alert_sound'}))
                stream=await self.read_stream_snapshot();self.assertNotEqual(first['stream_id'],stream['stream_id'])
                self.assertEqual(first['boot_id'],stream['boot_id']);first=stream
                enroll=await self.new_ui(mode='enrollment');self.assertNotEqual(enroll.sid,self.ui.sid)
                self.assertTrue(r.b._mqtt_dispatch_status()['consumer_running'])
                self.assertTrue(r.transport.snapshot()['ready'])
        self.assertEqual(r.transport.recoveries,5)
        self.assertTrue(all(not rx.executions for rx in self.receivers))

    async def test_transport_broker_exit_retries_and_restores_same_database(self):
        r=self.runtime;pid=r.process.pid;boot=r.boot_id;repo=r.repo;journal=r.journal
        before=await self.rpc('database.resources.list',{'kind':'settings','limit':50})
        real=r.start_private_broker;count=0;observed=[]
        async def unavailable():
            nonlocal count
            count+=1;observed.append(r.transport.snapshot())
            if count<=2:raise ConnectionError('isolated delayed broker recovery')
            await real()
        with patch.object(r,'start_private_broker',unavailable):
            r.process.terminate();await asyncio.to_thread(r.process.wait,5)
            snapshot=await self.recovered(0)
        self.assertEqual(count,3);self.assertTrue(all(not s['ready'] for s in observed))
        self.assertNotEqual(pid,r.process.pid);self.assertEqual(boot,r.boot_id)
        self.assertIs(repo,r.repo);self.assertIs(journal,r.journal)
        self.assertEqual(before,await self.rpc('database.resources.list',{'kind':'settings','limit':50}))
        self.assertEqual(len(snapshot['devices']),4)
        await self.read_stream_snapshot()

    async def test_transport_lost_ack_never_replays_control(self):
        r=self.runtime;rx=self.receivers[0];rx.acknowledge=False;intent=self.intent()
        await self.rpc('commands.request',intent)
        await eventually(lambda:len(rx.executions)==1)
        r.process.terminate();await asyncio.to_thread(r.process.wait,5)
        await self.recovered(0)
        record=await self.rpc('commands.get',{'operation_id':intent['operation_id']})
        self.assertIn(record['state'],('unknown','timeout'));self.assertEqual(record['attempts'],1)
        self.assertIsNone(record['execution_evidence'])
        await asyncio.sleep(.3);self.assertEqual(len(rx.executions),1)
        # A new user action on a different target still obtains a real ACK.
        fresh=self.intent(index=1);result=await self.rpc('commands.request',fresh)
        await eventually(lambda:len(self.receivers[1].executions)==1)
        for _ in range(30):
            result=await self.rpc('commands.get',{'operation_id':fresh['operation_id']})
            if result['state']=='acknowledged':break
            await asyncio.sleep(.05)
        self.assertEqual(result['state'],'acknowledged')
        self.assertEqual(len(rx.executions),1)

    async def test_transport_committed_write_lost_reply_queries_original_receipt(self):
        r=self.runtime;g=r.gateways['/mqtt-app'];reply=g.reply;written=asyncio.Event();operation=oid()
        async def lose_reply(sid,**body):
            if body.get('method')=='database.write' and body.get('ok'):
                await asyncio.to_thread(g.business.client.disconnect);written.set()
            return await reply(sid,**body)
        g.reply=lose_reply
        task=asyncio.create_task(self.ui.call('database.write',{'kind':'settings','id':'alert_sound','value':{'enabled':True},'deleted':False,'expected_revision':0,'epoch':self.epoch,'operation_id':operation}))
        await asyncio.wait_for(written.wait(),5)
        with self.assertRaises(Exception):await task
        g.reply=reply;await self.recovered(0)
        value=await self.rpc('database.resources.get',{'kind':'settings','id':'alert_sound'})
        receipt=await self.rpc('database.operations.get',{'operation_id':operation})
        self.assertEqual(receipt['body']['operation']['operation_id'],operation)
        self.assertEqual(value['body']['resource']['revision'],1)
        self.assertEqual(value['body']['resource']['value'],{'enabled':True})
        with r.repo.connection() as c:
            self.assertEqual(c.execute("SELECT revision FROM biz_settings WHERE id='alert_sound'").fetchone()[0],1)
        self.assertTrue(all(not rx.executions for rx in self.receivers))

    async def test_transport_dispatch_task_exit_is_restarted(self):
        r=self.runtime;old=r.b._mqtt_dispatch_task
        old.cancel();await asyncio.gather(old,return_exceptions=True)
        await self.recovered(0)
        self.assertIsNot(old,r.b._mqtt_dispatch_task)
        self.assertFalse(r.b._mqtt_dispatch_task.done())

    async def test_transport_durable_failure_is_not_cleared_by_reconnect(self):
        r=self.runtime;r.repo.poisoned=True
        try:
            await eventually(lambda:r.transport.state=='blocked')
            self.assertFalse(r.transport.ready)
            await asyncio.sleep(.4)
            self.assertTrue(r.repo.poisoned);self.assertEqual(r.transport.recoveries,0)
        finally:r.repo.poisoned=False

    async def test_transport_disconnect_during_dispatch_fences_old_send(self):
        r=self.runtime;entered=asyncio.Event();release=asyncio.Event();old=self.intent()
        async def before_send(record):
            entered.set();await release.wait()
        r.bus.before_send=before_send
        pending=asyncio.create_task(self.ui.call('commands.request',old))
        try:
            await asyncio.wait_for(entered.wait(),5)
            await asyncio.to_thread(r.gateways['/mqtt-app'].business.client.disconnect)
            await eventually(lambda:not r.transport.ready)
        finally:release.set()
        await asyncio.gather(pending,return_exceptions=True)
        await self.recovered(0);r.bus.before_send=None
        record=await self.rpc('commands.get',{'operation_id':old['operation_id']})
        self.assertIn(record['state'],('not_sent','unknown','timeout'))
        self.assertEqual(record['attempts'],1);self.assertIsNone(record['execution_evidence'])
        self.assertTrue(all(not rx.executions for rx in self.receivers))

    async def test_transport_bounded_queue_overflow_has_diagnosis_and_recovers(self):
        from types import SimpleNamespace
        import queue
        r=self.runtime;c=r.view.publisher;c.messages=queue.Queue(maxsize=1)
        packet=SimpleNamespace(topic='unused',payload=b'fixture')
        c._message(c.client,None,packet);c._message(c.client,None,packet)
        await self.recovered(0)
        entry=r.transport.history[-1]
        detail=next(d for d in entry['clients'] if d['role']=='view-publisher')
        self.assertEqual(detail['disconnect'],'RECEIVE_QUEUE_FULL')
        self.assertEqual(detail['queue_overflows'],1)
        self.assertTrue(r.transport.ready)

    async def test_transport_shutdown_during_retry_does_not_restart_or_leak(self):
        r=self.runtime;created=[];real=r.client
        async def fail(user):
            await asyncio.sleep(.05)
            if user=='app-business':raise ConnectionError('fixture unavailable')
            c=await real(user);created.append(c);return c
        with patch.object(r,'client',fail):
            await asyncio.to_thread(r.view.publisher.client.disconnect)
            await eventually(lambda:r.transport.attempts>=1 and r.transport.last_error is not None)
            await asyncio.wait_for(r.close(),8)
        count=len(created);await asyncio.sleep(.3)
        self.assertEqual(len(created),count)
        self.assertTrue(all(not c.client.is_connected() for c in created))
        self.assertTrue(r.transport.task.done());self.assertIsNotNone(r.process.poll())

    async def test_transport_old_session_cannot_submit_after_recovery(self):
        r=self.runtime;old=self.ui.request('commands.request',self.intent())
        await asyncio.to_thread(r.view.publisher.client.disconnect)
        await self.recovered(0)
        await self.ui.send(old)
        with self.assertRaises(Exception):await asyncio.wait_for(self.ui.message(),3)
        self.assertTrue(all(not rx.executions for rx in self.receivers))
