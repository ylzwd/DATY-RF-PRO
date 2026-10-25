"""真实回环 HTTP/MQTT/SSE + 临时数据库；不触碰现场设备或项目数据。"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import queue
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http_test_support import json_headers
from pairing_test_support import PairingFixture, connect_packet, create_tls_fixture
from tls_support import server_context, client_context, bind_https


class RealtimeControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-control-test-')
        spec = importlib.util.spec_from_file_location('daty_control_test', Path(__file__).resolve().parents[1] / 'mqtt-bridge.py')
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
        for name in ('devices', 'clients', 'receivers', 'receiver_aliases', 'source_epochs', 'receiver_epoch_fences', 'commands'):
            b._state[name].clear()
        b._state['sse_queues'].clear()
        b._offline_announced.clear()
        b._broker_clients.clear()
        self.pairings = PairingFixture(self.temp.name)
        b._pairing_policy = self.pairings.policy

    def register(self, count=4, modern=True):
        payload = {'type': 'device_list', 'client_id': 'isolated-a', 'receiver_ip': '127.0.0.2',
                   'receiver_mac': '02:00:00:00:00:98',
                   'devices': [{'channel': ch, 'brand': 'DATYaudio', 'freq_mhz': 641+ch/4, 'muted': False}
                               for ch in range(1, count+1)]}
        if modern:
            payload['control_protocol'] = 'fashe-realtime-v1'
        self.b._process_mqtt_message(self.b.MQTT_TOPIC_REGISTER, json.dumps(payload), 'isolated-a')
        return payload

    def test_capabilities_session_source_and_private_receiver_survive_public_snapshot(self):
        for source in ('client:mqtt', 'client:mqtt:connection-token'):
            raw = {'brand': 'DATYaudio', '_source': source, '_receiver_id': 'receiver-a',
                   'control_protocol': 'fashe-realtime-v1'}
            public = {k: v for k, v in raw.items() if k != '_receiver_id'}
            caps = self.b._device_capabilities(public, raw)
            self.assertEqual(caps['adapter'], 'fashe-mqtt')
            self.assertTrue(caps['write_frequency'])
            self.assertEqual(caps['frequency_control']['ack_mode'], 'command-id')
            self.assertEqual(caps['frequency_control']['min_khz'], 400000)
            self.assertEqual(caps['frequency_control']['max_khz'], 900000)
            self.assertEqual(caps['frequency_control']['step_khz'], 1)
        self.assertFalse(self.b._device_capabilities({'brand': 'Shure'}, raw)['write_frequency'])
        self.assertFalse(self.b._device_capabilities({'brand': 'DATYaudio', '_source': 'manual'})['write_frequency'])
        legacy = self.b._device_capabilities({'brand': 'DATYaudio', '_source': 'legacy:mqtt'})
        self.assertEqual(legacy['frequency_control']['ack_mode'], 'telemetry')

    def test_delta_snapshot_has_one_channel_not_all_receivers(self):
        for count in (1, 2, 4, 8, 32, 50, 64):
            payload = self.register(count)
            payload.pop('devices')
            packets = queue.Queue()
            self.b._state['sse_queues'][:] = [packets]
            self.b._process_mqtt_message(self.b.MQTT_TOPIC_UP, json.dumps({**payload, 'type': 'device_status_update',
                'channel': count, 'af_level': 0, 'muted': True}), 'isolated-a')
            event = json.loads(packets.get_nowait())
            self.assertEqual(event['type'], 'device_update')
            self.assertEqual(len(event['devices']), 1)
            self.assertEqual(event['devices'][0]['channel_number'], count)
            self.assertEqual(event['devices'][0]['af_dbfs'], 0)
            self.assertEqual(len(self.b._get_devices_snapshot()), count)

    def test_fast_ack_before_publish_returns_is_not_lost_or_overwritten_in_database(self):
        b = self.b
        self.register()
        did = 'FAshe-MAC-020000000098_ch2'
        cmd = {'command_id': 'instant-ack', 'client_request_id':'request-before-http-0001', 'command': 'mute', 'value': True, 'channel': 2}
        def publish(payload, targets):
            record = b._state['commands'][payload['command_id']]
            self.assertEqual(record['status'], 'published')
            b._reconcile_commands_for_device(did, {'muted': True}, payload['command_id'], push=True)
            return 1
        with patch.object(b, '_broker_publish_command', side_effect=publish):
            sent, record = b._publish_tracked_command(cmd, [did])
        self.assertEqual(sent, 1)
        self.assertEqual(record['status'], 'acknowledged')
        self.assertEqual(b._command_public_view(record)['client_request_id'],'request-before-http-0001')
        # 模拟迟到的初始数据库写入，终态不可倒退。
        b._persist_command({**record, 'status': 'published', 'updated_at': record['created_at']})
        with b._db_session() as db:
            self.assertEqual(db.execute('SELECT status FROM commands WHERE command_id=?', ('instant-ack',)).fetchone()[0], 'acknowledged')

    def test_reused_database_keeps_full_sync_and_rolls_back_failed_transactions(self):
        b = self.b
        with b._db_session() as first:
            self.assertEqual(first.execute('PRAGMA synchronous').fetchone()[0], 2)  # FULL, not NORMAL/OFF
        with self.assertRaises(RuntimeError):
            with b._db_session() as second:
                self.assertIs(first, second)
                second.execute("INSERT INTO projects(id,name,project_json,created_at,updated_at) VALUES('rolled-back','test','{}',0,0)")
                raise RuntimeError('rollback')
        with b._db_session() as connection:
            self.assertIsNone(connection.execute("SELECT id FROM projects WHERE id='rolled-back'").fetchone())
        b._close_database()
        with b._db_session() as reopened:
            self.assertIsNot(reopened, first)
            self.assertIsNotNone(reopened.execute("SELECT id FROM projects WHERE id='default'").fetchone())

    def test_number_target_value_and_missing_report_cannot_fake_ack(self):
        b = self.b
        self.register()
        did = 'FAshe-MAC-020000000098_ch1'
        with patch.object(b, '_broker_publish_command', return_value=1):
            _, record = b._publish_tracked_command({'command_id': 'strict-ack', 'command': 'unmute', 'channel': 1}, [did])
        for target, state, command_id in [(did, {'muted': False}, None), (did, {'muted': False}, 'wrong'),
                                         (did, {'muted': True}, 'strict-ack'), (did, {}, 'strict-ack'),
                                         (did, {'muted': 'invalid'}, 'strict-ack'),
                                         ('other_ch1', {'muted': False}, 'strict-ack')]:
            self.assertEqual(b._reconcile_commands_for_device(target, state, command_id), [])
        self.assertEqual(record['status'], 'published')
        self.assertEqual(len(b._reconcile_commands_for_device(did, {'muted': 'false'}, 'strict-ack')), 1)

    def test_old_receiver_keeps_state_confirmation_and_send_failure_is_not_success(self):
        b = self.b
        self.register(modern=False)
        did = 'FAshe-MAC-020000000098_ch1'
        with patch.object(b, '_broker_publish_command', return_value=1):
            _, record = b._publish_tracked_command({'command_id': 'legacy-ack', 'command': 'mute'}, [did])
        self.assertEqual(len(b._reconcile_commands_for_device(did, {'muted': True})), 1)
        with patch.object(b, '_broker_publish_command', return_value=0):
            _, failed = b._publish_tracked_command({'command_id': 'failed-send', 'command': 'mute'}, [did])
        self.assertEqual(failed['status'], 'failed')
        self.assertEqual(b._reconcile_commands_for_device(did, {'muted': True}, 'failed-send'), [])

    def test_ui_push_precedes_disk_work_and_command_persistence_does_not_hold_state_lock(self):
        b = self.b
        payload = self.register()
        payload.pop('devices')
        did = 'FAshe-MAC-020000000098_ch1'
        b._create_command_record({'command_id': 'push-first', 'command': 'mute'}, [did], 1)
        operations = []
        def persist(record):
            self.assertFalse(b._state_lock._is_owned())
            operations.append('command-disk')
        with patch.object(b, '_push_sse_event', side_effect=lambda kind, data: operations.append(kind)), \
             patch.object(b, '_persist_command', side_effect=persist), \
             patch.object(b, '_record_timeline', side_effect=lambda *a, **k: operations.append('timeline')), \
             patch.object(b, '_record_device_state', side_effect=lambda *a: operations.append('telemetry-disk')):
            b._process_mqtt_message(b.MQTT_TOPIC_UP, json.dumps({**payload, 'type': 'device_status_update',
                                    'channel': 1, 'command_id': 'push-first', 'muted': True}), 'isolated-a')
        self.assertEqual(operations, ['device_update', 'command_update', 'command-disk', 'timeline', 'telemetry-disk'])

    def test_slow_sse_client_gets_reconnect_sentinel_instead_of_silent_stale_connection(self):
        b = self.b
        slow, fast = queue.Queue(maxsize=1), queue.Queue(maxsize=5)
        slow.put('old')
        b._state['sse_queues'][:] = [slow, fast]
        b._push_sse_event('command_update', {'command_id': 'x', 'status': 'acknowledged'})
        self.assertIsNone(slow.get_nowait())
        self.assertNotIn(slow, b._state['sse_queues'])
        self.assertEqual(json.loads(fast.get_nowait())['data']['command_id'], 'x')

    def test_invalid_request_ids_are_rejected_before_any_control_publish(self):
        b = self.b
        http = b.ThreadingHTTPServer(('127.0.0.1',0), b.DatyAPIHandler)
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        try:
            with patch.object(b, '_publish_tracked_command') as publish:
                for value in (True, {}, 'short', 'x'*81, '<invalid-request-id>'):
                    request = Request(f'http://127.0.0.1:{http.server_port}/api/command',
                        data=json.dumps({'command':'mute','client_request_id':value}).encode(),
                        headers=json_headers())
                    with self.assertRaises(HTTPError) as failure:
                        urlopen(request,timeout=3)
                    self.assertEqual(failure.exception.code,400)
                    failure.exception.close()
                publish.assert_not_called()
        finally:
            http.shutdown(); http.server_close(); worker.join(timeout=2)

    def test_real_loopback_http_mqtt_up_sse_ack_with_8_channels(self):
        import websockets
        b = self.b
        http = bind_https(b.ThreadingHTTPServer, ('127.0.0.1', 0), b.DatyAPIHandler, server_context(self.tls_config))
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        endpoint = f'https://127.0.0.1:{http.server_port}'
        observed, condition, stop = [], threading.Condition(), threading.Event()
        def read_events():
            try:
                with urlopen(endpoint+'/api/updates', timeout=5, context=client_context(self.tls_config)) as response:
                    while not stop.is_set():
                        line = response.readline()
                        if not line:
                            break
                        if line.startswith(b'data: '):
                            with condition:
                                observed.append((time.perf_counter(), json.loads(line[6:])))
                                condition.notify_all()
            except (OSError, TimeoutError):
                pass
        reader = threading.Thread(target=read_events, daemon=True)
        reader.start()
        def wait_ack(command_id):
            deadline = time.monotonic()+3
            with condition:
                while time.monotonic() < deadline:
                    for received_at, payload in observed:
                        cmd = payload.get('data') or {}
                        if cmd.get('command_id') == command_id and cmd.get('status') == 'acknowledged':
                            return received_at, cmd
                    condition.wait(timeout=max(.001, deadline-time.monotonic()))
            raise AssertionError('No pushed command ACK')
        def utf(value):
            data = value.encode()
            return struct.pack('>H', len(data))+data
        def post(command):
            with urlopen(Request(endpoint+'/api/command', data=json.dumps(command).encode(),
                                 headers=json_headers()), timeout=3, context=client_context(self.tls_config)) as response:
                return json.load(response)
        async def scenario():
            b._broker_loop = asyncio.get_running_loop()
            async with websockets.serve(b._handle_mqtt_websocket, '127.0.0.1', 0, subprotocols=['mqtt'], compression=None,
                                        ssl=server_context(self.tls_config)) as server:
                async with websockets.connect(f'wss://127.0.0.1:{server.sockets[0].getsockname()[1]}/mqtt',
                                               subprotocols=['mqtt'], compression=None, ssl=client_context(self.tls_config)) as client:
                    await client.send(connect_packet(self.pairings.credentials[0]))
                    self.assertEqual((await client.recv())[0], 0x20)
                    registration = {'type': 'device_list', 'client_id': 'FAshe-127.0.0.1', 'receiver_ip': '127.0.0.1',
                                    'receiver_mac': '02:00:00:00:00:98', 'control_protocol': 'fashe-realtime-v1',
                                    'devices': [{'channel':ch,'brand':'DATYaudio','freq_mhz':641+ch/4,'muted':False}
                                                for ch in range(1,9)]}
                    await client.send(b._build_mqtt_publish_packet(b.MQTT_TOPIC_REGISTER, json.dumps(registration)))
                    subscription = struct.pack('>H', 1)+utf(b.MQTT_TOPIC_DOWN)+bytes([0])
                    await client.send(bytes([0x82])+b._mqtt_encode_remaining_length(len(subscription))+subscription)
                    self.assertEqual((await client.recv())[0], 0x90)
                    for _ in range(100):
                        if len(b._state['devices']) == 8:
                            break
                        await asyncio.sleep(.005)
                    self.assertEqual(len(b._state['devices']),8)
                    snapshot = b._get_devices_snapshot()
                    self.assertEqual(len(snapshot), 8)
                    for device in snapshot:
                        self.assertNotIn('_receiver_id', device)
                        self.assertEqual(device['capabilities']['adapter'], 'fashe-mqtt')
                        self.assertEqual(device['capabilities']['frequency_control']['ack_mode'], 'command-id')
                    timings = []
                    for i in range(24):
                        channel = i % 8 + 1
                        action = 'mute' if i < 8 else ('unmute' if i < 16 else 'set_freq')
                        value = 650.125 if action == 'set_freq' else action == 'mute'
                        did = f'FAshe-MAC-020000000098_ch{channel}'
                        started = time.perf_counter()
                        request_id = f'isolated-browser-request-{i:04d}'
                        posting = asyncio.create_task(asyncio.to_thread(post, {'device_id': did, 'command': action, 'value':value,
                                                                             'client_request_id':request_id}))
                        packet = await asyncio.wait_for(client.recv(), 3)
                        _, offset = b._mqtt_decode_remaining_length(packet, 1)
                        topic, offset = b._extract_utf_string(packet, offset)
                        self.assertEqual(topic,b.MQTT_TOPIC_DOWN)
                        command = json.loads(packet[offset:])
                        self.assertEqual(command['channel_number'],channel)
                        report = {**registration, 'type':'device_status_update', 'channel':channel,
                                  'command_id':command['command_id'], 'muted':action=='mute'}
                        report.pop('devices')
                        if action == 'set_freq': report['freq_mhz'] = value
                        await client.send(b._build_mqtt_publish_packet(b.MQTT_TOPIC_UP, json.dumps(report)))
                        response = await posting
                        received_at, ack = await asyncio.to_thread(wait_ack, response['command_id'])
                        self.assertEqual(ack['device_id'],did)
                        self.assertEqual(ack['client_request_id'],request_id)
                        self.assertEqual(ack['actual_value'],value)
                        self.assertGreaterEqual(ack['ack_round_trip_ms'],0)
                        timings.append((received_at-started)*1000)
                    await asyncio.wait_for(b._get_mqtt_dispatch_queue().join(),3)
                    ordered = sorted(timings)
                    print(f'\nISOLATED LOOPBACK HTTP→MQTT→up→SSE, n=24: median={ordered[12]:.3f} ms, p95={ordered[22]:.3f} ms, max={max(timings):.3f} ms')
                    self.assertEqual(len(b._state['devices']),8)
                    self.assertTrue(all(not dev['muted'] for dev in b._state['devices'].values()))
        try:
            asyncio.run(scenario())
        finally:
            stop.set()
            b._push_sse_event('test_stop', {})
            reader.join(timeout=2)
            b._broker_loop = None
            http.shutdown(); http.server_close(); worker.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
