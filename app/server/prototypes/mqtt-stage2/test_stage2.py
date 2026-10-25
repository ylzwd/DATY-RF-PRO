"""Actual isolated Bridge HTTPS/SSE vs canonical feed -> Mosquitto -> MQTT5/WSS.
No production imports without an isolated DB; no control or discovery calls.
"""
import argparse
import asyncio
import http.client
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(HERE), str(ROOT), str(ROOT / 'tests'), str(HERE.parent / 'mqtt-stage1')]
if '--paho-root' in sys.argv:
    sys.path.insert(0, sys.argv[sys.argv.index('--paho-root') + 1])
from pairing_test_support import create_tls_fixture, PairingFixture
from tls_support import server_context, client_context
from security_storage import secure_directory
from broker_client import BrokerClient
from device_feed import CanonicalFeed
from readonly_gateway import ReadonlyGateway, LOGICAL, PREFIX
from mqtt_wire import packet, utf, number, string, WSReader, split
import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

OPTIONS = None


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class SSE:
    def __init__(self, port, tls):
        self.conn = http.client.HTTPSConnection('127.0.0.1', port, context=client_context(tls), timeout=5)
        self.conn.request('GET', '/api/updates')
        self.response = self.conn.getresponse()
        assert self.response.status == 200

    def next(self):
        kind, data = None, None
        while True:
            line = self.response.readline().decode('utf-8').strip()
            if line.startswith('event: '):
                kind = line[7:]
            if line.startswith('data: '):
                data = json.loads(line[6:])
            if not line and data is not None:
                return kind, data

    def close(self):
        # Explicit socket shutdown unblocks both SSE and the handler immediately.
        try:
            self.response.fp.raw._sock.shutdown(socket.SHUT_RDWR)
        except (AttributeError, OSError):
            pass
        self.response.close()
        self.conn.close()


class Integration(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-mqtt-stage2-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.base = Path(cls.temp.name)
        (cls.base / '.daty-mqtt-stage2-fixture').write_text('isolated-only')
        cls.tls = create_tls_fixture(cls.base)
        cls.material = json.loads(cls.tls.read_text(encoding='utf-8'))
        cls.security = cls.base / 'security'
        secure_directory(cls.security)
        cls.secrets = {user: secrets.token_urlsafe(32) for user in ('producer', 'reader')}
        passwd = cls.security / 'broker-passwords'
        passwd.write_text(''.join(f'{u}:{p}\n' for u, p in cls.secrets.items()), encoding='ascii')
        exe = Path(OPTIONS.broker).resolve()
        subprocess.run([str(exe.with_name('mosquitto_passwd.exe')), '-U', str(passwd)], check=True,
            capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        acl = cls.security / 'broker-acl'
        # Mosquitto pattern ACL applies to both users; producer still cannot write commands.
        acl.write_text(f'user producer\ntopic write {PREFIX}/#\nuser reader\n'
            f'pattern read {PREFIX}/%c/events\n', encoding='ascii')
        cls.tcp = free_port()
        conf = cls.base / 'broker.conf'
        conf.write_text('\n'.join(['allow_anonymous false', f'password_file {passwd.as_posix()}',
            f'acl_file {acl.as_posix()}', 'persistence false', 'retain_available false',
            'max_packet_size 1048576', 'max_queued_messages 64', 'max_inflight_messages 8',
            'log_type error', 'log_type warning', f'listener {cls.tcp} 127.0.0.1', 'protocol mqtt',
            f'certfile {Path(cls.material["certificate_file"]).as_posix()}',
            f'keyfile {Path(cls.material["private_key_file"]).as_posix()}', 'tls_version tlsv1.2']) + '\n')
        cls.log = open(Path(OPTIONS.output) / 'broker.log', 'wb')
        cls.addClassCleanup(cls.log.close)
        cls.process = subprocess.Popen([str(exe), '-c', str(conf)], stdout=cls.log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        cls.addClassCleanup(cls.stop_broker)
        for _ in range(100):
            if cls.process.poll() is not None:
                raise RuntimeError('Broker startup failed')
            try:
                with socket.create_connection(('127.0.0.1', cls.tcp), timeout=.1):
                    break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError('Broker startup timeout')
        cls.transcript = []

    @classmethod
    def stop_broker(cls):
        if cls.process.poll() is None:
            cls.process.terminate()
            cls.process.wait(timeout=5)

    async def asyncSetUp(self):
        case = self.base / self._testMethodName
        case.mkdir()
        self.fixture = PairingFixture(case, macs=('02:00:00:00:00:98', '02:00:00:00:00:99'))
        data = json.loads(self.fixture.path.read_text())
        data['receiver_groups'] = {'02:00:00:00:00:98': 11, '02:00:00:00:00:99': 4}
        self.fixture.path.write_text(json.dumps(data))
        spec = importlib.util.spec_from_file_location('stage2_' + self._testMethodName, ROOT / 'mqtt-bridge.py')
        self.b = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'DATY_DB_PATH': str(case / 'isolated.sqlite3'),
                'DATY_ARCHIVE_PATH': str(case / 'archives')}):
            spec.loader.exec_module(self.b)
        self.addAsyncCleanup(asyncio.to_thread, self.b._close_database)
        self.b._pairing_policy = self.fixture.policy
        self.b._log = lambda *args: None
        self.b.time = SimpleNamespace(time=lambda: 1900000000.0, monotonic=time.monotonic, sleep=time.sleep)
        self.feed = CanonicalFeed(self.b)
        self.publisher = await asyncio.to_thread(BrokerClient, port=self.tcp,
            ca=self.material['ca_file'], username='producer', password=self.secrets['producer'])
        self.addAsyncCleanup(asyncio.to_thread, self.publisher.close)
        self.gateway = ReadonlyGateway(self.feed, self.publisher, broker_port=self.tcp,
            broker_tls=client_context(self.tls), username='reader', password=self.secrets['reader'], fixture_root=self.base)
        self.port = await self.gateway.start(server_context(self.tls))
        self.addAsyncCleanup(self.gateway.close)
        self.uri = f'wss://127.0.0.1:{self.port}/mqtt-readonly'
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), self.b.DatyAPIHandler)
        self.http.socket = server_context(self.tls).wrap_socket(self.http.socket, server_side=True)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.addAsyncCleanup(asyncio.to_thread, self.stop_http)

    def stop_http(self):
        with self.b._state_lock:
            queues = list(self.b._state['sse_queues'])
        for q in queues:
            while not q.empty():
                q.get_nowait()
            q.put_nowait(None)
        self.http.shutdown()
        self.http.server_close()

    def seed(self, count=50):
        for index, (mac, ip, model) in enumerate((('02:00:00:00:00:98', '192.0.2.102', 'DATY-X1'),
                                                ('02:00:00:00:00:99', '192.0.2.103', 'RF PRO'))):
            for ch in range(count, 0, -1):
                rid = self.fixture.credentials[index].receiver_id
                did = rid + '_ch' + str(ch)
                self.b._state['devices'][did] = {'id': did, '_receiver_id': rid, 'receiver_ip': ip,
                    'receiver_mac': mac, 'brand': 'DATYaudio', 'model': model, 'channel_number': ch,
                    'freq': 640000 + ch * 250, 'rf': -45, 'af_dbfs': 0 if ch % 2 else None,
                    'batt': 0, 'muted': False, 'status': 'online', '_source': rid + ':mqtt:fixture',
                    '_last_seen': self.b.time.time()}

    async def connect(self, **kwargs):
        ws = await websockets.connect(self.uri, ssl=client_context(self.tls), subprotocols=['mqtt'], **kwargs)
        self.addAsyncCleanup(ws.close)
        await ws.send(packet(0x10, utf('MQTT') + b'\x05\x02\x00\x0a\x00' + utf('')))
        reader = WSReader(ws)
        head, body = await asyncio.wait_for(reader.read(), 3)
        self.assertEqual(head, 0x20)
        self.assertEqual(body[:2], b'\0\0')
        stream = body[-37:].decode('ascii')  # "view-" + 32 hex characters
        self.assertTrue(stream.startswith('view-'))
        return ws, reader, stream

    async def subscribe(self, ws, reader, topic=LOGICAL):
        await ws.send(packet(0x82, b'\0\x01\0' + utf(topic) + b'\x01'))
        head, body = await asyncio.wait_for(reader.read(), 3)
        self.assertEqual((head, body), (0x90, b'\0\x01\0\x01'))

    async def event(self, ws, reader, heartbeat=False):
        for _ in range(10):
            head, body = await asyncio.wait_for(reader.read(), 4)
            self.assertEqual(head >> 4, 3)
            topic, pos = string(body)
            self.assertEqual(topic, LOGICAL)
            if head & 6:
                pid, pos = body[pos:pos + 2], pos + 2
                await ws.send(packet(0x40, pid))
            size, pos = number(body, pos)
            event = json.loads(body[pos + size:])
            if heartbeat or event['kind'] != 'heartbeat':
                return event
        self.fail('No device event')

    async def test_a_snapshot_delta_offline_reconnect_and_empty_match_actual_sse(self):
        self.seed()
        sse = await asyncio.to_thread(SSE, self.http.server_port, self.tls)
        self.addAsyncCleanup(asyncio.to_thread, sse.close)
        ws, reader, stream = await self.connect(origin='https://127.0.0.1:8080')
        await self.subscribe(ws, reader)

        async def compare(label):
            event, original = await asyncio.gather(self.event(ws, reader, heartbeat=True), asyncio.to_thread(sse.next))
            while event['kind'] == 'heartbeat':
                self.transcript.append({'label': 'heartbeat', 'sse': None, 'mqtt': event})
                event = await self.event(ws, reader, heartbeat=True)
            self.assertEqual((event['kind'], event['payload']), original)
            self.assertEqual(event['stream_id'], stream)
            self.transcript.append({'label': label, 'sse': {'kind': original[0], 'payload': original[1]}, 'mqtt': event})
            return event

        first = await compare('snapshot-100')
        self.assertEqual(first['seq'], 1)
        self.assertEqual(len(first['payload']['devices']), 100)
        ids = list(self.b._state['devices'])
        cases = [
            ('sparse-zero-null', [{'id': ids[0], 'af_dbfs': 0, 'batt': None}, {'id': ids[50], 'af_dbfs': None, 'batt': 0}]),
            ('omission-preserves', [{'id': ids[0], 'muted': True}]),
            ('group-change', [{'id': ids[0], 'group_number': 2, 'group': 999, 'group_source': 'server-fifo-v1'}]),
            ('unknown-group', [{'id': ids[50], 'group_number': None, 'group_source': None}]),
            ('ip-change', [{'id': ids[0], 'receiver_ip': '192.0.2.190'}]),
            ('receiver-offline', [{'id': did, '_online': False, 'status': 'offline'} for did in ids[:50]]),
            ('empty-delta', [])]
        for label, devices in cases:
            self.b._push_sse_event('device_update', devices)
            await compare(label)
        # Backlogged ordered updates are compared without sleeps or polling.
        for n in range(20):
            self.b._push_sse_event('device_update', [{'id': ids[n], 'rf': -30 - n}])
        for n in range(20):
            await compare('burst-' + str(n))
        await ws.close()
        self.transcript.append({'label': 'transport-disconnect', 'offline': True})
        ws, reader, new_stream = await self.connect()
        self.assertNotEqual(new_stream, stream)
        stream = new_stream
        await self.subscribe(ws, reader)
        restored = await self.event(ws, reader)
        self.assertEqual(restored['seq'], 1)
        self.assertEqual(restored['payload'], first['payload'])
        self.transcript.append({'label': 'fresh-reconnect', 'sse': {'kind': 'device_list', 'payload': first['payload']}, 'mqtt': restored})
        self.b._state['devices'].clear()
        self.b._push_sse_event('device_list', [])
        await compare('empty-snapshot')
        Path(OPTIONS.output, 'comparison.json').write_text(json.dumps(self.transcript, ensure_ascii=False, indent=2), encoding='utf-8')

    async def test_b_two_readers_have_unique_streams(self):
        a, ar, aid = await self.connect()
        b, br, bid = await self.connect()
        self.assertNotEqual(aid, bid)
        await self.subscribe(a, ar)
        await self.subscribe(b, br)
        ea, eb = await asyncio.gather(self.event(a, ar), self.event(b, br))
        self.assertEqual(ea['payload'], eb['payload'])
        self.assertEqual(ea['stream_id'], aid)
        self.assertEqual(eb['stream_id'], bid)

    async def test_c_origins_paths_and_browser_navigation_rejected(self):
        for options in ({'origin': 'null'}, {'origin': 'https://evil.invalid:8080'},
                {'origin': 'http://127.0.0.1:8080'}, {'origin': 'https://127.0.0.1:8080/'},
                {'additional_headers': {'Sec-Fetch-Site': 'cross-site'}},
                {'origin': 'https://127.0.0.1:8080', 'additional_headers': {'Sec-Fetch-Mode': 'navigate'}},
                {'origin': 'https://127.0.0.1:8080', 'additional_headers': {'Origin': 'https://127.0.0.1:8080'}}):
            with self.subTest(options=options), self.assertRaises(InvalidStatus):
                await websockets.connect(self.uri, ssl=client_context(self.tls), subprotocols=['mqtt'], **options)
        with self.assertRaises(InvalidStatus):
            await websockets.connect(self.uri + '?other=1', ssl=client_context(self.tls), subprotocols=['mqtt'])

    async def test_d_publish_commands_wildcards_and_foreign_stream_denied(self):
        for topic in ('#', 'daty/rf/devices/down', PREFIX + '/view-other/events'):
            ws, reader, _ = await self.connect()
            await ws.send(packet(0x82, b'\0\x01\0' + utf(topic) + b'\x01'))
            with self.assertRaises(ConnectionClosed):
                await reader.read()
            self.assertEqual(ws.close_code, 1008)
        for topic in (LOGICAL, 'daty/rf/devices/down'):
            ws, reader, _ = await self.connect()
            await ws.send(packet(0x30, utf(topic) + b'\0{}'))
            with self.assertRaises(ConnectionClosed):
                await reader.read()
            self.assertEqual(ws.close_code, 1008)

    async def test_e_client_identity_credentials_will_and_session_resume_denied(self):
        bodies = [utf('MQTT') + b'\x05\x02\x00\x0a\x00' + utf('chosen-id'),
            utf('MQTT') + b'\x05\xc2\x00\x0a\x00' + utf('') + utf('reader') + utf('bad'),
            utf('MQTT') + b'\x05\x06\x00\x0a\x00' + utf(''),
            utf('MQTT') + b'\x05\x02\x00\x0a\x05\x11\0\0\0\x01' + utf('')]
        for body in bodies:
            async with websockets.connect(self.uri, ssl=client_context(self.tls), subprotocols=['mqtt']) as ws:
                await ws.send(packet(0x10, body))
                with self.assertRaises(ConnectionClosed):
                    await ws.recv()
                self.assertEqual(ws.close_code, 1008)

    async def test_f_canonical_queue_overflow_requires_new_snapshot(self):
        sub = self.feed.subscribe()
        for n in range(51):
            self.b._push_sse_event('device_update', [{'id': 'fake', 'rf': n}])
        with self.assertRaises(ConnectionError):
            sub.next(.1)
        self.assertNotIn(sub.queue, self.b._state['sse_queues'])
        sub.close()
        ws, reader, _ = await self.connect()
        await self.subscribe(ws, reader)
        self.assertEqual((await self.event(ws, reader))['seq'], 1)
        # Blocking this event-loop turn fills the actual attached queue; no fake close.
        for n in range(52):
            self.b._push_sse_event('device_update', [{'id': 'wire-overflow', 'rf': n}])
        with self.assertRaises(ConnectionClosed):
            while True:
                await asyncio.wait_for(reader.read(), 4)
        self.assertEqual(ws.close_code, 1013)

    async def test_g_source_failure_and_publisher_failure_close_view(self):
        ws, reader, _ = await self.connect()
        await self.subscribe(ws, reader)
        await self.event(ws, reader)
        self.b._state['sse_queues'][0].put_nowait(None)
        with self.assertRaises(ConnectionClosed):
            await asyncio.wait_for(reader.read(), 3)
        self.assertEqual(ws.close_code, 1013)
        ws, reader, _ = await self.connect()
        await self.subscribe(ws, reader)
        await self.event(ws, reader)
        await asyncio.to_thread(self.publisher.close)
        with self.assertRaises(ConnectionClosed):
            await asyncio.wait_for(reader.read(), 3)
        self.assertEqual(ws.close_code, 1013)

    async def test_h_commands_filtered_heartbeat_and_fragmented_packets(self):
        ws, reader, stream = await self.connect()
        message = packet(0x82, b'\0\x01\0' + utf(LOGICAL) + b'\x01')
        for part in (message[:1], message[1:5], message[5:]):
            await ws.send(part)
        self.assertEqual((await reader.read())[0], 0x90)
        await self.event(ws, reader)
        self.b._push_sse_event('command_update', {'command_id': 'must-not-leak'})
        async def command_traffic():
            for _ in range(30):
                self.b._push_sse_event('command_update', {'command_id': 'must-not-leak'})
                await asyncio.sleep(.05)
        traffic = asyncio.create_task(command_traffic())
        e = await asyncio.wait_for(self.event(ws, reader, heartbeat=True), 1.4)
        await traffic
        self.assertEqual((e['kind'], e['seq'], e['payload']), ('heartbeat', 2, None))
        self.assertEqual(e['stream_id'], stream)
        await ws.send(b'\xc0\0\xc0\0')
        self.assertEqual(await reader.read(), (0xd0, b''))
        self.assertEqual(await reader.read(), (0xd0, b''))

    async def test_i_mature_broker_acl_rejects_reader_writes_and_foreign_delivery(self):
        client = await asyncio.to_thread(BrokerClient, port=self.tcp, ca=self.material['ca_file'],
            username='reader', password=self.secrets['reader'])
        self.addAsyncCleanup(asyncio.to_thread, client.close)
        code = await asyncio.to_thread(client.publish_sync, PREFIX + '/foreign/events', {'forged': True})
        self.assertGreaterEqual(code, 128)
        await asyncio.to_thread(client.subscribe, PREFIX + '/foreign/events')
        await self.publisher.publish(PREFIX + '/foreign/events', {'canary': 'private'})
        import queue
        with self.assertRaises(queue.Empty):
            await asyncio.to_thread(client.receive, .2)

    async def test_j_existing_browser_mqttjs_library_over_verified_wss(self):
        self.seed()
        node = await asyncio.create_subprocess_exec(OPTIONS.node, str(HERE / 'mqttjs-live.cjs'), self.uri,
            self.material['ca_file'], str(ROOT.parent / 'FAshe/vendor/mqtt-5.10.4/mqtt.upstream.min.js'),
            OPTIONS.ws_bundle, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            line = await asyncio.wait_for(node.stdout.readline(), 10)
            if line != b'READY\n' and line != b'READY\r\n':
                out, err = await asyncio.wait_for(node.communicate(), 10)
                self.fail((line + out + err).decode('utf-8', errors='replace'))
            ids = list(self.b._state['devices'])
            self.b._push_sse_event('device_update', [{'id': ids[0], 'af_dbfs': None}, {'id': ids[50], 'af_dbfs': 0}])
            out, err = await asyncio.wait_for(node.communicate(), 10)
            self.assertEqual(node.returncode, 0, err.decode('utf-8', errors='replace'))
            result = json.loads(out)
            self.assertTrue(result['ok'])
            Path(OPTIONS.output, 'mqttjs-live.json').write_text(json.dumps(result, indent=2))
        finally:
            if node.returncode is None:
                node.kill()
                await node.wait()

    async def test_z_broker_loss_closes_view(self):
        ws, reader, _ = await self.connect()
        await self.subscribe(ws, reader)
        await self.event(ws, reader)
        await asyncio.to_thread(self.stop_broker)
        with self.assertRaises(ConnectionClosed):
            await asyncio.wait_for(reader.read(), 3)
        self.assertEqual(ws.close_code, 1013)

    async def test_k_gateway_restart_changes_boot_not_receiver_identity(self):
        self.seed(count=2)
        ws, reader, old_stream = await self.connect()
        await self.subscribe(ws, reader)
        old = await self.event(ws, reader)
        await self.gateway.close()
        with self.assertRaises(ConnectionClosed):
            await reader.read()
        self.gateway.feed = CanonicalFeed(self.b)
        self.port = await self.gateway.start(server_context(self.tls))
        self.uri = f'wss://127.0.0.1:{self.port}/mqtt-readonly'
        ws, reader, new_stream = await self.connect()
        await self.subscribe(ws, reader)
        new = await self.event(ws, reader)
        self.assertNotEqual(old_stream, new_stream)
        self.assertNotEqual(old['boot_id'], new['boot_id'])
        self.assertEqual(new['seq'], 1)
        self.assertEqual(old['payload'], new['payload'])

    async def test_l_captured_live_sse_shadow_replay_not_independent_production_feed(self):
        if not OPTIONS.live_capture:
            self.skipTest('Optional explicit read-only production capture not supplied')
        rows = json.loads(Path(OPTIONS.live_capture).read_text(encoding='utf-8'))
        self.assertEqual(rows[0]['kind'], 'device_list')
        original_subscribe = self.feed.subscribe

        def replay_subscribe():
            sub = original_subscribe()
            sub.snapshot = rows[0]['payload']
            return sub

        self.feed.subscribe = replay_subscribe
        ws, reader, _ = await self.connect()
        await self.subscribe(ws, reader)
        transcript = []
        for index, row in enumerate(rows):
            if index:
                # Explicit lab replay of captured SSE. No production MQTT attachment.
                self.b._state['sse_queues'][0].put_nowait(json.dumps(row['payload']))
            event = await self.event(ws, reader, heartbeat=True)
            while event['kind'] == 'heartbeat':
                transcript.append({'label': 'heartbeat', 'sse': None, 'mqtt': event})
                event = await self.event(ws, reader, heartbeat=True)
            self.assertEqual((event['kind'], event['payload']), (row['kind'], row['payload']))
            transcript.append({'label': 'captured-live-shadow-' + str(index), 'sse': row, 'mqtt': event})
        Path(OPTIONS.output, 'live-comparison.json').write_text(json.dumps(transcript, ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--broker', required=True)
    ap.add_argument('--paho-root', required=True)
    ap.add_argument('--output', required=True)
    ap.add_argument('--node', default='node')
    ap.add_argument('--ws-bundle', required=True)
    ap.add_argument('--case', help='Run one named test while developing this isolated fixture')
    ap.add_argument('--live-capture', help='Optional explicit read-only SSE capture for labeled shadow replay')
    OPTIONS = ap.parse_args()
    Path(OPTIONS.output).mkdir(parents=True, exist_ok=True)
    suite = (unittest.TestSuite([Integration(OPTIONS.case)]) if OPTIONS.case else
             unittest.defaultTestLoader.loadTestsFromTestCase(Integration))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    Path(OPTIONS.output, 'result.json').write_text(json.dumps({'tests': result.testsRun,
        'failures': len(result.failures), 'errors': len(result.errors), 'success': result.wasSuccessful(),
        'broker_stopped': Integration.process.poll() is not None}, indent=2))
    sys.exit(0 if result.wasSuccessful() else 1)
