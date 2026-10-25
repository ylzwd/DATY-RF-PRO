"""Real Mosquitto + TLS/WSS tests. All credentials and sockets are isolated.

Usage: python test_stage1.py --broker <portable mosquitto.exe> --output <evidence>
Requires paho-mqtt on PYTHONPATH. No production receivers, keys, DB or services.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import queue
import secrets
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(HERE), str(ROOT), str(ROOT / 'tests')]
if '--paho-root' in sys.argv:
    sys.path.insert(0, str(Path(sys.argv[sys.argv.index('--paho-root') + 1]).resolve()))
from pairing_test_support import PairingFixture, create_tls_fixture, connect_packet, mqtt_packet, mqtt_utf, subscribe_packet
from receiver_pairing import ReceiverPairingPolicy, PairingError
from tls_support import server_context, client_context
from security_storage import secure_directory
from receiver_gateway import ReceiverGateway, KINDS
from broker_client import BrokerClient
import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

PREFIX = 'daty/prototype/v2/stage1-server'
OPTIONS = None


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def pub(topic, body, *, qos=0, retain=False, pid=1):
    payload = body if isinstance(body, bytes) else json.dumps(body).encode()
    return mqtt_packet(0x30 | (qos << 1) | int(retain),
        mqtt_utf(topic) + (struct.pack('>H', pid) if qos else b'') + payload)


class Integration(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-mqtt-stage1-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.base = Path(cls.temp.name)
        (cls.base / '.daty-mqtt-stage1-fixture').write_text('isolated-only', encoding='ascii')
        cls.tls = create_tls_fixture(cls.base)
        cls.material = json.loads(cls.tls.read_text(encoding='utf-8'))
        cls.security = cls.base / 'security'
        secure_directory(cls.security)
        cls.secrets = {user: secrets.token_urlsafe(32) for user in ('ingress', 'business', 'ui')}
        passwd = cls.security / 'broker-passwords'
        passwd.write_text(''.join(f'{u}:{p}\n' for u, p in cls.secrets.items()), encoding='ascii')
        exe = Path(OPTIONS.broker).resolve()
        subprocess.run([str(exe.with_name('mosquitto_passwd.exe')), '-U', str(passwd)], check=True,
            capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        acl = cls.security / 'broker-acl'
        acl.write_text(f'user ingress\ntopic write {PREFIX}/ingress/#\n'
            f'user business\ntopic read {PREFIX}/ingress/#\ntopic write {PREFIX}/state/#\n'
            f'user ui\ntopic read {PREFIX}/state/#\n', encoding='ascii')
        cls.tcp, cls.wss = free_port(), free_port()
        while cls.tcp == cls.wss:
            cls.wss = free_port()
        conf = cls.base / 'broker.conf'
        lines = ['allow_anonymous false', f'password_file {passwd.as_posix()}',
            f'acl_file {acl.as_posix()}', 'persistence false', 'retain_available false',
            'max_packet_size 1048576', 'max_queued_messages 64', 'max_inflight_messages 8',
            'log_type error', 'log_type warning']
        for port, protocol in ((cls.tcp, 'mqtt'), (cls.wss, 'websockets')):
            lines.extend([f'listener {port} 127.0.0.1', f'protocol {protocol}',
                f'certfile {Path(cls.material["certificate_file"]).as_posix()}',
                f'keyfile {Path(cls.material["private_key_file"]).as_posix()}', 'tls_version tlsv1.2'])
        conf.write_text('\n'.join(lines) + '\n', encoding='ascii')
        cls.log = open(Path(OPTIONS.output) / 'broker.log', 'wb')
        cls.addClassCleanup(cls.log.close)
        cls.process = subprocess.Popen([str(exe), '-c', str(conf)], stdout=cls.log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        cls.addClassCleanup(cls.stop_broker)
        end = time.monotonic() + 10
        while time.monotonic() < end:
            if cls.process.poll() is not None:
                raise RuntimeError('Isolated Broker failed; inspect broker.log')
            try:
                with socket.create_connection(('127.0.0.1', cls.tcp), timeout=.2):
                    break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError('Isolated Broker startup timed out')

    @classmethod
    def stop_broker(cls):
        if cls.process.poll() is None:
            cls.process.terminate()
            try:
                cls.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.process.kill()
                cls.process.wait(timeout=5)

    def client(self, user, *, websocket=False, password=None):
        return BrokerClient(port=self.wss if websocket else self.tcp,
            ca=self.material['ca_file'], username=user, password=password or self.secrets[user], websocket=websocket)

    async def asyncSetUp(self):
        self.fixture = PairingFixture(self.base, macs=('02:00:00:00:00:98', '02:00:00:00:00:99'), max_channels=50)
        data = json.loads(self.fixture.path.read_text(encoding='utf-8'))
        data['receiver_groups'] = {self.fixture.credentials[0].receiver_mac: 11, self.fixture.credentials[1].receiver_mac: 4}
        self.fixture.path.write_text(json.dumps(data), encoding='utf-8')
        self.ingress = await asyncio.to_thread(self.client, 'ingress')
        self.business = await asyncio.to_thread(self.client, 'business')
        self.ui = await asyncio.to_thread(self.client, 'ui', websocket=True)
        self.addAsyncCleanup(asyncio.to_thread, self.ingress.close)
        self.addAsyncCleanup(asyncio.to_thread, self.business.close)
        self.addAsyncCleanup(asyncio.to_thread, self.ui.close)
        await asyncio.to_thread(self.business.subscribe, PREFIX + '/ingress/#')
        await asyncio.to_thread(self.ui.subscribe, PREFIX + '/#')
        self.gateway = ReceiverGateway(self.fixture.policy, self.ingress, server_id='stage1-server', fixture_root=self.base)
        self.port = await self.gateway.start(server_context(self.tls))
        self.addAsyncCleanup(self.gateway.close)
        self.uri = f'wss://127.0.0.1:{self.port}/mqtt'

    async def receiver(self, n=0, **kwargs):
        ws = await websockets.connect(self.uri, ssl=client_context(self.tls), subprotocols=['mqtt'], **kwargs)
        self.addAsyncCleanup(ws.close)
        await ws.send(connect_packet(self.fixture.credentials[n]))
        self.assertEqual(await asyncio.wait_for(ws.recv(), 2), b'\x20\x02\x00\x00')
        return ws

    async def event(self):
        topic, raw = await asyncio.to_thread(self.business.receive)
        event = json.loads(raw)
        contract = json.loads((ROOT / 'contracts' / 'mqtt-v2-stage1.json').read_text(encoding='utf-8'))
        self.assertEqual(set(event), set(contract['ingress']['required']))
        self.assertEqual(set(event['source']), set(contract['ingress']['sourceRequired']))
        self.assertEqual(event['schema'], contract['ingress']['schema'])
        self.assertIn(event['kind'], contract['ingress']['kinds'])
        self.assertTrue(self.gateway.current_event(topic, event))
        return topic, event

    async def no_message(self, client):
        with self.assertRaises(queue.Empty):
            await asyncio.to_thread(client.receive, .2)

    async def denied(self, topic, payload, **options):
        ws = await self.receiver()
        await ws.send(pub(topic, payload, **options))
        with self.assertRaises(ConnectionClosed):
            await asyncio.wait_for(ws.recv(), 2)
        self.assertEqual(ws.close_code, 1008)
        await self.no_message(self.business)

    async def test_actual_socket_ip_not_forwarded_headers(self):
        ws = await self.receiver(additional_headers={'X-Forwarded-For': '192.0.2.102'})
        await ws.send(pub('daty/rf/devices/up', {'channel': 9, 'af_level': 0, 'battery': None, 'group': 999}))
        topic, event = await self.event()
        self.assertEqual(event['source']['peer_ip'], '127.0.0.1')
        self.assertEqual(event['source']['group_number'], 11)
        self.assertEqual(event['payload']['af_level'], 0)
        self.assertIsNone(event['payload']['battery'])
        self.assertIn('/ingress/' + self.fixture.credentials[0].receiver_id + '/', topic)
        self.assertEqual(event['payload']['receiver_id'], self.fixture.credentials[0].receiver_id)
        await self.no_message(self.ui)

    async def test_two_socket_peers_and_existing_groups(self):
        for n, address, group in ((0, '127.0.0.2', 11), (1, '127.0.0.3', 4)):
            ws = await self.receiver(n, local_addr=(address, 0))
            await ws.send(pub('daty/rf/devices/register', {'type': 'device_list',
                'devices': [{'channel': ch, 'af_level': None} for ch in range(1, 51)]}, qos=1))
            self.assertEqual(await asyncio.wait_for(ws.recv(), 2), b'\x40\x02\x00\x01')
            _, event = await self.event()
            self.assertEqual(event['source']['peer_ip'], address)
            self.assertEqual(event['source']['group_number'], group)
            self.assertEqual(len(event['payload']['devices']), 50)
            self.assertTrue(all(d['group_number'] == group for d in event['payload']['devices']))

    async def test_foreign_payload_ip_denied(self):
        await self.denied('daty/rf/devices/up', {'channel': 1, 'receiver_ip': '192.0.2.102'})

    async def test_foreign_mac_and_channel_and_brand_denied(self):
        for field in ({'receiver_mac': self.fixture.credentials[1].receiver_mac}, {'channel': 51}, {'brand': 'Shure'}):
            await self.denied('daty/rf/devices/up', {'channel': 1, **field})

    async def test_forged_trusted_metadata_denied(self):
        await self.denied('daty/rf/devices/up', {'channel': 1, 'source': {'peer_ip': '192.0.2.102'}})
        await self.denied('daty/rf/devices/up', {'channel': 1, 'metadata': {'secret': 'never-forward'}})

    async def test_receiver_cannot_publish_internal_or_ui_topic(self):
        for topic in (PREFIX + '/state/devices', PREFIX + '/ingress/fake', 'daty/v2/server/ui/a/request'):
            await self.denied(topic, {'channel': 1})

    async def test_receiver_wildcard_and_other_topics_denied(self):
        ws = await self.receiver()
        await ws.send(subscribe_packet(['#', PREFIX + '/#', 'daty/rf/devices/down']))
        self.assertEqual(await asyncio.wait_for(ws.recv(), 2), b'\x90\x05\x00\x01\x80\x80\x00')

    async def test_local_operation_is_event_never_broadcast(self):
        first, second = await self.receiver(0), await self.receiver(1)
        await second.send(subscribe_packet(['daty/rf/devices/down']))
        await asyncio.wait_for(second.recv(), 2)
        await first.send(pub('daty/rf/devices/down', {'type': 'device_command', 'command': 'mute', 'channel': 1, 'value': True}))
        topic, event = await self.event()
        self.assertTrue(topic.endswith('/local-event'))
        self.assertEqual(event['kind'], 'local-event')
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(second.recv(), .2)

    async def test_wrong_credentials_denied(self):
        async with websockets.connect(self.uri, ssl=client_context(self.tls), subprotocols=['mqtt']) as ws:
            await ws.send(connect_packet(self.fixture.credentials[0], password='incorrect'))
            self.assertEqual(await asyncio.wait_for(ws.recv(), 2), b'\x20\x02\x00\x05')
        await self.no_message(self.business)

    async def test_revoke_closes_idle_connection(self):
        ws = await self.receiver()
        self.fixture.records[0]['revoked'] = True
        self.fixture.save()
        with self.assertRaises(ConnectionClosed):
            await asyncio.wait_for(ws.recv(), 2)
        self.assertEqual(ws.close_code, 4003)

    async def test_expiry_closes_idle_connection(self):
        self.fixture.records[0]['expires_at'] = time.time() + .5
        self.fixture.save()
        ws = await self.receiver()
        with self.assertRaises(ConnectionClosed):
            await asyncio.wait_for(ws.recv(), 2)
        self.assertEqual(ws.close_code, 4003)

    async def test_new_session_replaces_old_preserves_identity(self):
        first = await self.receiver()
        await first.send(pub('daty/rf/devices/up', {'channel': 1}))
        previous_topic, previous = await self.event()
        second = await self.receiver()
        await first.wait_closed()
        self.assertEqual(first.close_code, 4001)
        self.assertFalse(self.gateway.current_event(previous_topic, previous))
        await second.send(pub('daty/rf/devices/up', {'channel': 1}))
        _, current = await self.event()
        for field in ('receiver_id', 'receiver_mac', 'peer_ip', 'group_number', 'brand'):
            self.assertEqual(previous['source'][field], current['source'][field])
        self.assertNotEqual(previous['source']['session_id'], current['source']['session_id'])
        self.assertEqual(current['sequence'], 1)

    async def test_dhcp_address_change_keeps_paired_identity_and_group(self):
        previous = None
        for peer in ('127.0.0.2', '127.0.0.3'):
            ws = await self.receiver(local_addr=(peer, 0))
            await ws.send(pub('daty/rf/devices/up', {'channel': 2}))
            _, event = await self.event()
            self.assertEqual(event['source']['peer_ip'], peer)
            if previous:
                for field in ('receiver_id', 'receiver_mac', 'group_number', 'brand'):
                    self.assertEqual(previous['source'][field], event['source'][field])
            previous = event
            await ws.close()

    async def test_gateway_restart_keeps_identity_and_changes_boot(self):
        ws = await self.receiver()
        await ws.send(pub('daty/rf/devices/up', {'channel': 1}))
        topic, previous = await self.event()
        registry_before = self.fixture.path.read_bytes()
        await self.gateway.close()
        self.gateway = ReceiverGateway(ReceiverPairingPolicy(self.fixture.path), self.ingress,
            server_id='stage1-server', fixture_root=self.base)
        self.addAsyncCleanup(self.gateway.close)
        self.port = await self.gateway.start(server_context(self.tls))
        self.uri = f'wss://127.0.0.1:{self.port}/mqtt'
        next_ws = await self.receiver()
        await next_ws.send(pub('daty/rf/devices/up', {'channel': 1}))
        _, current = await self.event()
        self.assertFalse(self.gateway.current_event(topic, previous))
        self.assertNotEqual(current['boot_id'], previous['boot_id'])
        for field in ('receiver_id', 'receiver_mac', 'group_number', 'brand'):
            self.assertEqual(previous['source'][field], current['source'][field])
        self.assertEqual(registry_before, self.fixture.path.read_bytes())

    async def test_mqtt_fragmentation_and_ping_remain_compatible(self):
        async with websockets.connect(self.uri, ssl=client_context(self.tls), subprotocols=['mqtt']) as ws:
            packet = connect_packet(self.fixture.credentials[0])
            await ws.send(packet[:3])
            await ws.send(packet[3:] + b'\xc0\x00')
            self.assertEqual(await asyncio.wait_for(ws.recv(), 2), b'\x20\x02\x00\x00')
            self.assertEqual(await asyncio.wait_for(ws.recv(), 2), b'\xd0\x00')

    async def test_queued_event_stale_after_revoke_or_boot_change(self):
        ws = await self.receiver()
        await ws.send(pub('daty/rf/devices/up', {'channel': 1}))
        topic, event = await self.event()
        modified = {**event, 'boot_id': 'another-boot'}
        self.assertFalse(self.gateway.current_event(topic, modified))
        self.assertFalse(self.gateway.current_event(topic.replace('/ingress/', '/state/'), event))
        self.fixture.records[0]['revoked'] = True
        self.fixture.save()
        self.assertFalse(self.gateway.current_event(topic, event))

    async def test_sparse_zero_null_and_sequence_preserved(self):
        ws = await self.receiver()
        for index, value in enumerate(({}, {'af_level': None}, {'af_level': 0}), 1):
            await ws.send(pub('daty/rf/devices/up', {'channel': 10, **value}))
            _, event = await self.event()
            self.assertEqual(event['sequence'], index)
            if not value:
                self.assertNotIn('af_level', event['payload'])
            else:
                self.assertEqual(event['payload']['af_level'], value['af_level'])

    async def test_retained_and_duplicate_json_denied(self):
        await self.denied('daty/rf/devices/up', {'channel': 1}, retain=True)
        await self.denied('daty/rf/devices/up', b'{"channel":1,"channel":2}')
        await self.denied('daty/rf/devices/up', b'{"channel":1,"af_level":NaN}')

    async def test_broker_ui_and_ingress_acl(self):
        for client, destination in ((self.ui, '/ingress/forged'), (self.ui, '/state/devices'),
                                    (self.business, '/ingress/forged'), (self.ingress, '/state/forged')):
            rc = await asyncio.to_thread(client.publish_sync, PREFIX + destination, {'forged': True})
            self.assertGreaterEqual(rc, 128)
        await asyncio.to_thread(self.business.publish_sync, PREFIX + '/state/devices', {'fixture': True, 'devices': []})
        topic, value = await asyncio.to_thread(self.ui.receive)
        self.assertEqual(topic, PREFIX + '/state/devices')
        self.assertEqual(json.loads(value)['devices'], [])
        await self.no_message(self.business)

    async def test_broker_rejects_bad_password(self):
        with self.assertRaises(ConnectionError):
            await asyncio.to_thread(self.client, 'ui', password='wrong')

    async def test_untrusted_ca_and_cross_origin_denied(self):
        import ssl
        with self.assertRaises(ssl.SSLCertVerificationError):
            async with websockets.connect(self.uri, ssl=ssl.create_default_context(), subprotocols=['mqtt']):
                pass
        with self.assertRaises(InvalidStatus):
            async with websockets.connect(self.uri, ssl=client_context(self.tls), subprotocols=['mqtt'], origin='https://foreign.invalid'):
                pass

    async def test_disconnected_broker_is_not_acknowledged_or_replayed(self):
        await asyncio.to_thread(self.ingress.close)
        ws = await self.receiver()
        await ws.send(pub('daty/rf/devices/up', {'channel': 1}, qos=1))
        with self.assertRaises(ConnectionClosed):
            await asyncio.wait_for(ws.recv(), 2)
        self.assertEqual(ws.close_code, 1013)
        await self.no_message(self.business)

    async def test_production_paths_and_listener_rejected(self):
        with self.assertRaises(ValueError):
            ReceiverGateway(ReceiverPairingPolicy(), self.ingress, server_id='stage1-server', fixture_root=self.base)
        with self.assertRaises(ValueError):
            await self.gateway.start(server_context(self.tls), host='0.0.0.0')
        with self.assertRaises(ValueError):
            await self.gateway.start(server_context(self.tls), port=8083)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--broker', required=True)
    parser.add_argument('--paho-root', required=True)
    parser.add_argument('--output', required=True)
    OPTIONS = parser.parse_args()
    Path(OPTIONS.output).mkdir(parents=True, exist_ok=False)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(Integration)
    with (Path(OPTIONS.output) / 'tests.log').open('w', encoding='utf-8') as log:
        result = unittest.TextTestRunner(stream=log, verbosity=2).run(suite)
    report = {'schema': 'daty-mqtt-stage1-test-v1', 'tests': result.testsRun,
        'failures': len(result.failures), 'errors': len(result.errors), 'skipped': len(result.skipped),
        'passed': result.wasSuccessful(), 'production_connections': 0, 'device_commands': 0,
        'broker_sha256': hashlib.sha256(Path(OPTIONS.broker).read_bytes()).hexdigest(),
        'transport': ['MQTT5/TLS', 'MQTT5/WSS', 'legacy MQTT3.1.1/WSS'],
        'broker_process_stopped': getattr(Integration, 'process', None) is None or Integration.process.poll() is not None}
    (Path(OPTIONS.output) / 'result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))
    sys.exit(0 if result.wasSuccessful() else 1)
