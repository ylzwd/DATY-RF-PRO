"""RTT 回归：临时数据库、隔离 MQTT 会话，不向现场设备发送消息。"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import urlopen
from pairing_test_support import PairingFixture, connect_packet, create_tls_fixture
from tls_support import server_context, client_context, bind_https


class FakeSocket:
    def __init__(self, fail=False):
        self.packets = []
        self.fail = fail

    async def send(self, packet):
        if self.fail:
            raise OSError('closed')
        self.packets.append(packet)


class ClockRttTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-rtt-test-')
        spec = importlib.util.spec_from_file_location('daty_rtt_test', Path(__file__).resolve().parents[1] / 'mqtt-bridge.py')
        cls.b = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'DATY_DB_PATH': str(Path(cls.temp.name) / 'test.sqlite3')}):
            spec.loader.exec_module(cls.b)
        cls.b._log = lambda *args, **kwargs: None
        cls.tls_config = create_tls_fixture(cls.temp.name)

    @classmethod
    def tearDownClass(cls):
        cls.b._close_database()
        cls.temp.cleanup()

    def setUp(self):
        b = self.b
        b._clock_state.update(server_id='test-server', sequence=0, pending={}, clients={})
        b._broker_clients.clear()
        for name in ('devices', 'clients', 'receivers', 'receiver_aliases', 'source_epochs', 'receiver_epoch_fences'):
            b._state[name].clear()
        b._offline_announced.clear()
        self.events = []
        self.pairings = PairingFixture(self.temp.name, ('02:00:00:00:00:77', '02:00:00:00:00:78'))
        b._pairing_policy = self.pairings.policy
        b._push_sse_event = lambda kind, data: self.events.append((kind, data))

    def session(self, client='receiver-a', token='session-a', fail=False):
        session = {'ws': FakeSocket(fail), 'connection_token': token,
                   'pairing': self.pairings.principal(1 if client == 'receiver-b' else 0),
                   'subscriptions': {self.b.MQTT_TOPIC_CLOCK_SYNC}}
        self.b._broker_clients[client] = session
        return session

    def send(self, client='receiver-a', token='session-a', at=100.0, payload=None, fail=False):
        session = self.b._broker_clients.get(client) or self.session(client, token, fail)
        payload = payload or self.b._clock_sync_payload()
        with patch.object(self.b.time, 'monotonic', return_value=at):
            result = asyncio.run(self.b._send_clock_payload(client, session, payload))
        return payload, result

    def ack(self, payload, client='receiver-a', token='session-a', at=100.0123, **changes):
        ack = {'type':'clock_sync_ack', 'protocol':self.b.CLOCK_PROTOCOL_VERSION, 'server_id':payload['server_id'],
               'sequence':payload['sequence'], 'offset_ms':9999999, 'client_epoch_ms':-123, **changes}
        with patch.object(self.b.time, 'monotonic', return_value=at):
            return self.b._record_clock_ack(ack, client, token)

    def test_real_send_time_and_monotonic_clock_not_payload_time_or_offset(self):
        payload = self.b._clock_sync_payload()
        self.assertEqual(self.b._clock_state['pending'], {})
        self.send(at=100, payload=payload)  # generation -> scheduling time is excluded
        with patch.object(self.b.time, 'time', return_value=42):  # server wall clock jumped
            self.assertTrue(self.ack(payload, at=100.0123))
        sample = self.b._clock_state['clients']['receiver-a']
        self.assertEqual(sample['rtt_ms'], 12.3)
        self.assertEqual(sample['last_ack_ms'], 42000)

    def test_unmatched_server_sequence_protocol_and_session_are_rejected(self):
        payload, _ = self.send()
        for changes in ({'server_id':'old-server'}, {'sequence':9999}, {'sequence':True}, {'sequence':1.5},
                        {'sequence':'1.0'}, {'sequence':0}, {'protocol':'unknown'}):
            with self.subTest(changes=changes):
                self.assertFalse(self.ack(payload, **changes))
        self.session('receiver-b', 'session-b')
        self.assertFalse(self.ack(payload, client='receiver-b', token='session-b'))
        self.assertFalse(self.ack(payload, token='replaced-session'))
        self.assertTrue(self.ack(payload))

    def test_duplicate_and_out_of_order_acks_do_not_refresh_or_replace_sample(self):
        older, _ = self.send(at=100)
        newer, _ = self.send(at=101)
        self.assertTrue(self.ack(newer, at=101.020))
        sample = dict(self.b._clock_state['clients']['receiver-a'])
        self.assertFalse(self.ack(newer, at=102))
        self.assertFalse(self.ack(older, at=102))
        self.assertEqual(self.b._clock_state['clients']['receiver-a'], sample)

    def test_expired_pending_and_failed_send_do_not_create_rtt(self):
        payload, _ = self.send()
        self.assertFalse(self.ack(payload, at=121))
        self.assertEqual(self.b._clock_state['clients'], {})
        self.b._broker_clients.clear()
        failed, sent = self.send(fail=True)
        self.assertFalse(sent)
        self.assertEqual(self.b._clock_state['pending'], {})
        self.assertFalse(self.ack(failed))

    def test_receiver_mapping_uses_transport_session_not_claimed_ip_or_client_id(self):
        payload, _ = self.send()
        self.assertTrue(self.ack(payload, client_id='receiver-b', receiver_ip='192.0.2.200'))
        own = {'_source':self.b._mqtt_source_key('receiver-a', 'session-a')}
        other = {'_source':self.b._mqtt_source_key('receiver-b', 'session-b')}
        self.assertEqual(self.b._receiver_heartbeat_snapshot(own, True, 100.1)['rtt_ms'], 12.3)
        self.assertIsNone(self.b._receiver_heartbeat_snapshot(other, True, 100.1)['rtt_ms'])

    def test_stale_offline_and_replaced_sessions_do_not_keep_rtt(self):
        payload, _ = self.send(); self.ack(payload)
        own = {'_source':self.b._mqtt_source_key('receiver-a', 'session-a')}
        stale = self.b._receiver_heartbeat_snapshot(own, True, 121)
        self.assertEqual(stale['status'], 'stale'); self.assertIsNone(stale['rtt_ms'])
        self.assertEqual(self.b._receiver_heartbeat_snapshot(own, False, 101)['status'], 'offline')
        self.session(token='new-session')
        self.assertFalse(self.ack(payload))
        other = {'_source':self.b._mqtt_source_key('receiver-a', 'new-session')}
        self.assertIsNone(self.b._receiver_heartbeat_snapshot(other, True, 101)['rtt_ms'])
        self.b._forget_clock_session('receiver-a', 'session-a')
        self.assertEqual(self.b._clock_state['clients'], {})

    def test_clock_endpoint_age_uses_monotonic_time_and_hides_stale_rtt(self):
        payload, _ = self.send(); self.ack(payload)
        with patch.object(self.b.time, 'monotonic', return_value=105.0123), patch.object(self.b.time, 'time', return_value=0):
            snapshot = self.b._clock_status_snapshot()['clients'][0]
        self.assertEqual(snapshot['age_ms'], 5000)
        self.assertEqual(snapshot['rtt_ms'], 12.3)
        self.assertFalse(any(key.startswith('_') for key in snapshot))
        with patch.object(self.b.time, 'monotonic', return_value=125):
            snapshot = self.b._clock_status_snapshot()['clients'][0]
        self.assertIsNone(snapshot['rtt_ms']); self.assertEqual(snapshot['status'], 'stale')

    def test_two_receivers_share_broadcast_sequence_but_not_rtt(self):
        payload, _ = self.send()
        self.send('receiver-b', 'session-b', at=100.1, payload=payload)
        self.assertTrue(self.ack(payload, at=100.020))
        self.assertTrue(self.ack(payload, 'receiver-b', 'session-b', at=100.155))
        self.assertEqual(self.b._clock_state['clients']['receiver-a']['rtt_ms'], 20.0)
        self.assertEqual(self.b._clock_state['clients']['receiver-b']['rtt_ms'], 55.0)

    def test_ack_pushes_device_snapshot_without_creating_channels_or_changing_mute(self):
        now = time.time()
        for ch in (1, 2):
            self.b._state['devices'][f'a_ch{ch}'] = {'id':f'a_ch{ch}', 'channel_number':ch, 'brand':'DATYaudio',
                '_source':self.b._mqtt_source_key('receiver-a', 'session-a'), '_receiver_id':'receiver-a',
                '_last_seen':now, 'muted':ch == 1, 'freq':620000, 'heartbeat':{'rtt_ms':1}}
        payload, _ = self.send()
        ack = {'type':'clock_sync_ack', 'protocol':self.b.CLOCK_PROTOCOL_VERSION, 'server_id':payload['server_id'], 'sequence':payload['sequence']}
        with patch.object(self.b.time, 'monotonic', return_value=100.008):
            self.b._process_mqtt_message(self.b.MQTT_TOPIC_CLOCK_ACK, json.dumps(ack), 'receiver-a', 'session-a')
        kind, devices = self.events[-1]
        self.assertEqual(kind, 'device_update'); self.assertEqual(len(devices), 2)
        self.assertEqual([item['heartbeat']['rtt_ms'] for item in devices], [8.0, 8.0])
        self.assertEqual([item['muted'] for item in devices], [True, False])
        self.assertEqual(len(self.b._state['devices']), 2)

    def test_old_session_send_and_cleanup_do_not_affect_replacement(self):
        old = self.session()
        new = self.session(token='new-token')
        payload = self.b._clock_sync_payload()
        self.assertFalse(asyncio.run(self.b._send_clock_payload('receiver-a', old, payload)))
        self.send(token='new-token', payload=payload)
        self.assertTrue(self.ack(payload, token='new-token'))
        self.b._forget_clock_session('receiver-a', 'session-a')
        self.assertEqual(self.b._clock_state['clients']['receiver-a']['rtt_ms'], 12.3)
        self.assertEqual(len(new['ws'].packets), 1)

    def test_real_websocket_initial_and_broadcast_ack_reach_http_snapshot(self):
        """走真实 MQTT 帧/WS、发送协程、ACK 入口及 HTTP API（均为回环随机端口）。"""
        import websockets
        b = self.b
        http = bind_https(b.ThreadingHTTPServer, ('127.0.0.1', 0), b.DatyAPIHandler, server_context(self.tls_config))
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()

        def utf(text):
            encoded = text.encode('utf-8')
            return struct.pack('>H', len(encoded)) + encoded

        async def scenario():
            b._broker_loop = asyncio.get_running_loop()
            credential = self.pairings.credentials[0]
            async with websockets.serve(b._handle_mqtt_websocket, '127.0.0.1', 0, subprotocols=['mqtt'],
                                        ssl=server_context(self.tls_config)) as server:
                port = server.sockets[0].getsockname()[1]
                async with websockets.connect(f'wss://127.0.0.1:{port}/mqtt', subprotocols=['mqtt'],
                                               ssl=client_context(self.tls_config)) as client:
                    await client.send(connect_packet(credential))
                    self.assertEqual((await asyncio.wait_for(client.recv(), 2))[0], 0x20)
                    registration = {'type':'device_list', 'client_id':'FAshe-127.0.0.1', 'receiver_ip':'127.0.0.1',
                                    'receiver_mac':'02:00:00:00:00:77', 'devices':[{'channel':1, 'brand':'DATYaudio', 'freq':620000}]}
                    await client.send(b._build_mqtt_publish_packet(b.MQTT_TOPIC_REGISTER, json.dumps(registration)))
                    subscription = struct.pack('>H', 1) + utf(b.MQTT_TOPIC_CLOCK_SYNC) + bytes([0])
                    await client.send(bytes([0x82]) + b._mqtt_encode_remaining_length(len(subscription)) + subscription)
                    self.assertEqual((await asyncio.wait_for(client.recv(), 2))[0], 0x90)
                    for broadcast in (False, True):
                        if broadcast:
                            payload = b._clock_sync_payload()
                            self.assertEqual(b._broker_publish_topic(b.MQTT_TOPIC_CLOCK_SYNC, json.dumps(payload)), 1)
                        packet = await asyncio.wait_for(client.recv(), 2)
                        _, offset = b._mqtt_decode_remaining_length(packet, 1)
                        topic, offset = b._extract_utf_string(packet, offset)
                        self.assertEqual(topic, b.MQTT_TOPIC_CLOCK_SYNC)
                        payload = json.loads(packet[offset:])
                        await asyncio.sleep(.01)
                        ack = {**payload, 'type':'clock_sync_ack', 'client_id':credential.receiver_id, 'offset_ms':-90000}
                        await client.send(b._build_mqtt_publish_packet(b.MQTT_TOPIC_CLOCK_ACK, json.dumps(ack)))
                        for _ in range(100):
                            if b._clock_state['clients'].get(credential.client_id, {}).get('sequence') == payload['sequence']:
                                break
                            await asyncio.sleep(.01)
                        self.assertEqual(b._clock_state['clients'][credential.client_id]['sequence'], payload['sequence'])

                    await asyncio.wait_for(b._get_mqtt_dispatch_queue().join(), 2)

                    def snapshot():
                        with urlopen(f'https://127.0.0.1:{http.server_port}/api/devices', timeout=2,
                                     context=client_context(self.tls_config)) as response:
                            return json.load(response)
                    result = await asyncio.to_thread(snapshot)
                    self.assertTrue(result['success'])
                    self.assertEqual(len(result['devices']), 1)
                    heartbeat = result['devices'][0]['heartbeat']
                    self.assertEqual(heartbeat['status'], 'measured')
                    self.assertGreaterEqual(heartbeat['rtt_ms'], 10)
                    self.assertEqual(heartbeat['sequence'], payload['sequence'])
                    self.assertTrue(any(kind == 'device_update' for kind, _ in self.events))
            self.assertNotIn(credential.client_id, b._clock_state['clients'])

        try:
            asyncio.run(scenario())
        finally:
            b._broker_loop = None
            http.shutdown(); http.server_close(); worker.join(timeout=3)

    def test_real_ack_bypasses_blocked_telemetry_database_and_state_lock(self):
        """业务线程即使等数据库并持有状态锁，网络循环仍能校验真实 ACK。"""
        import websockets
        b = self.b
        entered, release = threading.Event(), threading.Event()

        def slow_database(*args):
            with b._state_lock:
                entered.set()
                if not release.wait(4):
                    raise TimeoutError('test failed to release isolated database stall')

        def utf(value):
            raw = value.encode()
            return struct.pack('>H', len(raw)) + raw

        async def scenario():
            credential = self.pairings.credentials[0]
            async with websockets.serve(b._handle_mqtt_websocket, '127.0.0.1', 0,
                                        subprotocols=['mqtt'], compression=None,
                                        ssl=server_context(self.tls_config)) as server:
                async with websockets.connect(f'wss://127.0.0.1:{server.sockets[0].getsockname()[1]}/mqtt',
                                              subprotocols=['mqtt'], ssl=client_context(self.tls_config)) as client:
                    await client.send(connect_packet(credential))
                    self.assertEqual((await client.recv())[0], 0x20)
                    registration = {'type': 'device_list', 'client_id': credential.receiver_id,
                        'receiver_ip': '127.0.0.1', 'devices': [{'channel': 1, 'brand': 'DATYaudio'}]}
                    stats_before = b._state['stats']['total_messages']
                    await client.send(b._build_mqtt_publish_packet(b.MQTT_TOPIC_REGISTER, json.dumps(registration)))
                    for _ in range(200):
                        if entered.is_set():
                            break
                        await asyncio.sleep(.005)
                    self.assertTrue(entered.is_set())
                    subscription = struct.pack('>H', 1) + utf(b.MQTT_TOPIC_CLOCK_SYNC) + bytes([0])
                    await client.send(bytes([0x82]) + b._mqtt_encode_remaining_length(len(subscription)) + subscription)
                    self.assertEqual((await asyncio.wait_for(client.recv(), 1))[0], 0x90)
                    packet = await asyncio.wait_for(client.recv(), 1)
                    _, offset = b._mqtt_decode_remaining_length(packet, 1)
                    _, offset = b._extract_utf_string(packet, offset)
                    payload = json.loads(packet[offset:])
                    ack = {**payload, 'type': 'clock_sync_ack', 'client_version': 'fashe-fast-ack-v1',
                           'client_ack_prepare_ms': 15.625}
                    await client.send(b._build_mqtt_publish_packet(b.MQTT_TOPIC_CLOCK_ACK, json.dumps(ack)))
                    for _ in range(200):
                        if credential.client_id in b._clock_state['clients']:
                            break
                        await asyncio.sleep(.005)
                    sample = b._clock_state['clients'][credential.client_id]
                    self.assertEqual(sample['sequence'], payload['sequence'])
                    self.assertEqual(sample['client_version'], 'fashe-fast-ack-v1')
                    self.assertEqual(sample['client_ack_prepare_ms'], 15.625)
                    self.assertGreaterEqual(sample['rtt_ms'], 0)
                    self.assertFalse(release.is_set())
                    self.assertEqual(b._state['stats']['total_messages'], stats_before + 2)
                    release.set()
                    await asyncio.wait_for(b._get_mqtt_dispatch_queue().join(), 2)
                    self.assertTrue(any(kind == 'device_update' for kind, _ in self.events))

        try:
            with patch.object(b, '_record_device_state', side_effect=slow_database):
                asyncio.run(scenario())
        finally:
            release.set()

    def test_business_queue_keeps_fifo_and_drops_replaced_connection_messages(self):
        b = self.b
        received = []

        async def scenario():
            self.session(token='replacement')
            work = b._get_mqtt_dispatch_queue()
            # Queue real authorized topic/payload; markers retain original FIFO assertions.
            payload = {'channel': 1, '_test_order': 'register'}
            work.put_nowait((b.MQTT_TOPIC_UP, json.dumps(payload), 'receiver-a', 'session-a'))
            for topic in ('register', 'up-ch1', 'mute-ch2', 'up-ch2'):
                work.put_nowait((b.MQTT_TOPIC_UP, json.dumps({**payload, '_test_order': topic}), 'receiver-a', 'replacement'))
            await asyncio.wait_for(work.join(), 2)

        with patch.object(b, '_process_mqtt_message', side_effect=lambda *args:
                          received.append((json.loads(args[1])['_test_order'], *args[1:]))):
            asyncio.run(scenario())
        self.assertEqual([item[0] for item in received], ['register', 'up-ch1', 'mute-ch2', 'up-ch2'])
        self.assertTrue(all(item[3] == 'replacement' for item in received))

    def test_clock_snapshot_coalesces_and_full_queue_never_blocks_ack_sample(self):
        b = self.b

        async def scenario():
            work = b._get_mqtt_dispatch_queue()
            for _ in range(50):
                b._defer_clock_snapshot()
            self.assertEqual(work.qsize(), 1)
            await asyncio.wait_for(work.join(), 2)
            self.assertEqual(len(self.events), 1)
            # No yield while filling, so consumer cannot drain until join below.
            for _ in range(b.MQTT_DISPATCH_QUEUE_SIZE):
                work.put_nowait(('up', '{}', 'gone-client', 'gone-token'))
            with self.assertRaises(asyncio.QueueFull):
                work.put_nowait(('up', '{}', 'gone-client', 'gone-token'))
            b._defer_clock_snapshot()  # no wait / exception / loss of stored RTT
            self.assertFalse(b._clock_refresh_queued)
            await asyncio.wait_for(work.join(), 3)
            b._defer_clock_snapshot()
            await asyncio.wait_for(work.join(), 2)
            self.assertEqual(len(self.events), 2)

        asyncio.run(scenario())

    def test_persistence_pressure_yields_loop_then_preserves_packet_fifo(self):
        b=self.b;received=[];pressure={'value':True}
        class Runtime:
            def status(self):
                return dict(accepting=True,queue_count=200 if pressure['value'] else 0,
                            queue_capacity=256,queue_bytes=0,max_queue_bytes=16000000)
        async def scenario():
            work=b._get_mqtt_dispatch_queue()
            for i in range(40):work.put_nowait(('up',str(i),'fixture','session'))
            await asyncio.sleep(.02);self.assertEqual(received,[])
            pressure['value']=False;await asyncio.wait_for(work.join(),2)
        with patch.object(b,'_unified_runtime',Runtime()),patch.object(b,'_process_queued_mqtt_message',
                side_effect=lambda *args:received.append(int(args[1]))):asyncio.run(scenario())
        self.assertEqual(received,list(range(40)))

    def test_cancelling_pressure_wait_accounts_for_dequeued_item(self):
        b=self.b
        class Runtime:
            def status(self):return dict(accepting=True,queue_count=256,queue_capacity=256,queue_bytes=0,max_queue_bytes=16000000)
        async def scenario():
            work=b._get_mqtt_dispatch_queue();work.put_nowait(('up','{}','fixture','session'))
            await asyncio.sleep(.01);b._mqtt_dispatch_task.cancel()
            await asyncio.gather(b._mqtt_dispatch_task,return_exceptions=True)
            await asyncio.wait_for(work.join(),1)
        with patch.object(b,'_unified_runtime',Runtime()):asyncio.run(scenario())

    def test_history_enqueue_keeps_throttle_and_never_waits_for_database(self):
        b=self.b;records=[]
        class Runtime:
            def device_history(self,record):records.append(record);return {'accepted':True,'persisted':False}
        current={'name':'test','freq':641000,'rf':None,'af_dbfs':0,'batt':0,'muted':False,'status':'online'}
        b._telemetry_last_write.pop('history-fixture',None)
        with patch.object(b,'_unified_runtime',Runtime()),patch.object(b,'_db_session',side_effect=AssertionError('No producer IO')):
            with patch.object(b.time,'time',return_value=100):b._record_device_state('history-fixture',{},current)
            with patch.object(b.time,'time',return_value=100.5):b._record_device_state('history-fixture',current,{**current,'muted':True})
            with patch.object(b.time,'time',return_value=101):b._record_device_state('history-fixture',current,current)
        self.assertEqual([record['ts'] for record in records],[100,100.5,101])
        self.assertIsNone(records[1]['sample']);self.assertIsNone(records[2]['event'])
        self.assertEqual(records[0]['sample']['af_dbfs'],0);self.assertIsNone(records[0]['sample']['rf'])


if __name__ == '__main__':
    unittest.main()
