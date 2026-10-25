"""Pairing policy and real trusted WSS/HTTPS boundary tests, isolated fixtures."""
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import ssl
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import websockets
from websockets.exceptions import ConnectionClosed

from http_test_support import json_headers
from pairing_test_support import (PairingFixture, connect_packet, create_tls_fixture,
                                  mqtt_packet, mqtt_utf, subscribe_packet)
from receiver_pairing import (MqttPacketBuffer, PairingError, ReceiverPairingPolicy,
                              mqtt_body, parse_connect)
from tls_support import server_context, client_context, bind_https

PROJECT = Path(__file__).resolve().parents[1]


class ReceiverPairingPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='daty-pairing-policy-')
        self.addCleanup(self.temp.cleanup)
        self.fixture = PairingFixture(self.temp.name, max_channels=8)
        self.policy = self.fixture.policy
        self.credential = self.fixture.credentials[0]

    def test_missing_malformed_and_revoked_registry_fail_closed(self):
        missing = ReceiverPairingPolicy(Path(self.temp.name) / 'missing.json')
        self.assertFalse(missing.configured())
        principal = self.fixture.principal()
        for replacement in ('{}', '{', '{"version":1,"receivers":false}',
                            json.dumps({'version': True, 'receivers': self.fixture.records})):
            self.fixture.path.write_text(replacement, encoding='utf-8')
            self.assertFalse(self.policy.configured())
            self.assertFalse(self.policy.is_active(principal))
        self.fixture.records[0]['revoked'] = True
        self.fixture.save()
        self.assertFalse(self.policy.is_active(principal))
        with self.assertRaises(PairingError):
            self.fixture.principal()

    def test_authentication_binds_secret_client_id_and_optional_peer_ip(self):
        principal = self.fixture.principal()
        self.assertEqual(principal['receiver_id'], self.credential.receiver_id)
        self.assertEqual(principal['_peer_ip'], '127.0.0.1')
        self.assertNotIn('secret_sha256', principal)
        for values in ((self.credential.username, 'wrong', self.credential.client_id, '127.0.0.1'),
                       (self.credential.username, self.credential.secret, 'unbound-client', '127.0.0.1'),
                       ('rx_' + 'f' * 16, self.credential.secret, self.credential.client_id, '127.0.0.1')):
            with self.assertRaises(PairingError):
                self.policy.authenticate(*values)
        self.fixture.records[0]['receiver_ip'] = '127.0.0.2'
        self.fixture.save()
        with self.assertRaises(PairingError):
            self.fixture.principal()
        self.assertEqual(self.fixture.principal(peer_ip='127.0.0.2')['_peer_ip'], '127.0.0.2')

    def test_batch_uses_one_registry_version_and_next_packet_sees_revocation(self):
        principal=self.fixture.principal();self.policy.ensure_group(principal)
        payload={'devices':[{'channel':ch,'brand':'DATYaudio'} for ch in range(1,9)]}
        with mock.patch.object(self.policy,'_load',wraps=self.policy._load) as load:
            checked=self.policy.validate_payload(principal,'daty/rf/devices/register',payload)
        self.assertEqual(load.call_count,1)
        self.assertTrue(all(item['group']==checked['group'] for item in checked['devices']))
        self.fixture.records[0]['revoked']=True;self.fixture.save()
        with self.assertRaises(PairingError):
            self.policy.validate_payload(principal,'daty/rf/devices/register',payload)

    def test_changed_or_expired_record_invalidates_existing_principal(self):
        principal = self.fixture.principal()
        self.fixture.records[0]['max_channels'] = 4
        self.fixture.save()
        self.assertFalse(self.policy.is_active(principal))
        self.fixture.records[0]['expires_at'] = time.time() - 1
        self.fixture.save()
        with self.assertRaises(PairingError):
            self.fixture.principal()

    def test_duplicate_active_receiver_mac_invalidates_registry(self):
        other = dict(self.fixture.records[0], credential_id='rx_' + 'b' * 16)
        self.fixture.records.append(other)
        self.fixture.save()
        self.assertFalse(self.policy.configured())

    def test_sparse_telemetry_keeps_unknown_measurements_unknown(self):
        checked = self.policy.validate_payload(self.fixture.principal(), 'daty/rf/devices/up', {'channel': 1})
        self.assertEqual(checked['receiver_id'], self.credential.receiver_id)
        self.assertEqual(checked['brand'], 'DATYaudio')
        self.assertEqual(checked['channel_number'], 1)
        for field in ('af_level', 'rf_level', 'battery', 'muted', 'freq_mhz'):
            self.assertNotIn(field, checked)

    def test_unsupported_updates_and_malformed_devices_batches_are_rejected(self):
        for payload in ({'updates': [{'channel': 1}]}, {'updates': [], 'devices': [{'channel': 1}]},
                        {'devices': 'invalid', 'channel': 1}):
            with self.subTest(payload=payload):
                with self.assertRaises(PairingError):
                    self.policy.validate_payload(self.fixture.principal(), 'daty/rf/devices/up', payload)

    def test_payload_aliases_cannot_impersonate_another_receiver_or_channel(self):
        principal = self.fixture.principal()
        invalid = ({'receiver_mac': '02:00:00:00:00:99'}, {'mac': '02:00:00:00:00:99'},
                   {'receiver_ip': '127.0.0.2'}, {'ip': '127.0.0.2'}, {'brand': 'Shure'},
                   {'client_id': 'FAshe-127.0.0.2'}, {'receiver_id': 'foreign'},
                   {'channel': 9}, {'channel': 0}, {'channel': True}, {'channel_key': 'CH2'},
                   {'channel_no': 2}, {'id': self.credential.receiver_id + '_ch2'},
                   {'device_id': self.credential.receiver_id + '_ch2'})
        for changed in invalid:
            with self.subTest(changed=changed):
                with self.assertRaises(PairingError):
                    self.policy.validate_payload(principal, 'daty/rf/devices/up', {'channel': 1, **changed})
        with self.assertRaises(PairingError):
            self.policy.validate_payload(principal, 'daty/rf/devices/register',
                                          {'devices': [{'channel': 1}, {'channel': 1}]})

    def test_connect_buffer_handles_split_and_concatenated_frames(self):
        packet = connect_packet(self.credential)
        decoder = MqttPacketBuffer()
        packets = []
        for byte in packet:
            packets.extend(decoder.feed(bytes([byte])))
        self.assertEqual(packets, [packet])
        parsed = parse_connect(packets[0])
        self.assertEqual(parsed, (self.credential.client_id, self.credential.username, self.credential.secret, 30))
        self.assertEqual(MqttPacketBuffer().feed(packet + b'\xc0\x00'), [packet, b'\xc0\x00'])

    def test_connect_rejects_anonymous_flags_keepalive_and_malformed_lengths(self):
        for packet in (connect_packet(self.credential, flags=2), connect_packet(self.credential, flags=0xC6),
                       connect_packet(self.credential, keepalive=0), connect_packet(self.credential, keepalive=121)):
            with self.assertRaises(PairingError):
                parse_connect(packet)
        for data in (b'\x10\x80\x00', b'\x10\xff\xff\xff\xff\x01', 'text CONNECT'):
            with self.assertRaises(PairingError):
                MqttPacketBuffer().feed(data)


class ReceiverPairingNetworkTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-pairing-network-')
        spec = importlib.util.spec_from_file_location('daty_pairing_bridge_test', PROJECT / 'mqtt-bridge.py')
        cls.b = importlib.util.module_from_spec(spec)
        with mock.patch.dict(os.environ, {'DATY_DB_PATH': str(Path(cls.temp.name) / 'isolated.sqlite3')}):
            spec.loader.exec_module(cls.b)
        cls.b._init_database()
        cls.tls_config = create_tls_fixture(cls.temp.name)

    @classmethod
    def tearDownClass(cls):
        cls.b._close_database()
        cls.temp.cleanup()

    async def asyncSetUp(self):
        b = self.b
        for key in ('devices', 'clients', 'receivers', 'receiver_aliases', 'source_epochs', 'receiver_epoch_fences', 'commands'):
            b._state[key].clear()
        b._state['sse_queues'].clear()
        b._broker_clients.clear()
        b._offline_announced.clear()
        b._receiver_diagnostic_times.clear()
        b._clock_state.update(server_id='isolated-pairing-clock', sequence=0, pending={}, clients={})
        self.fixture = PairingFixture(self.temp.name, ('02:00:00:00:00:98', '02:00:00:00:00:99'), max_channels=8)
        b._pairing_policy = self.fixture.policy
        self.logs = []
        b._log = lambda *args: self.logs.append(' '.join(map(str, args)))
        b._broker_loop = asyncio.get_running_loop()
        self.server = await websockets.serve(b._handle_mqtt_websocket, '127.0.0.1', 0,
            ssl=server_context(self.tls_config), subprotocols=['mqtt'], compression=None)
        self.url = f'wss://127.0.0.1:{self.server.sockets[0].getsockname()[1]}/mqtt'
        self.clients = []

    async def asyncTearDown(self):
        for client in self.clients:
            await client.close()
        self.server.close()
        await self.server.wait_closed()
        self.b._broker_loop = None
        for credential in self.fixture.credentials:
            self.assertNotIn(credential.secret, '\n'.join(self.logs))
            self.assertNotIn(hashlib.sha256(credential.secret.encode()).hexdigest(), '\n'.join(self.logs))

    async def connection(self, index=0, packet=None, authenticate=True):
        client = await websockets.connect(self.url, ssl=client_context(self.tls_config),
                                           subprotocols=['mqtt'], compression=None)
        self.clients.append(client)
        if authenticate:
            await client.send(packet if packet is not None else connect_packet(self.fixture.credentials[index]))
            self.assertEqual(await asyncio.wait_for(client.recv(), 2), b'\x20\x02\x00\x00')
        return client

    def registration(self, index=0):
        credential = self.fixture.credentials[index]
        return {'type': 'device_list', 'client_id': credential.receiver_id,
                'receiver_mac': credential.receiver_mac, 'receiver_ip': '127.0.0.1',
                'control_protocol': 'fashe-realtime-v1',
                'devices': [{'channel': 1, 'brand': 'DATYaudio', 'freq_mhz': 641.0, 'muted': False}]}

    async def publish(self, client, topic, payload, retained=False):
        packet = self.b._build_mqtt_publish_packet(topic, json.dumps(payload))
        if retained:
            packet = bytes([packet[0] | 1]) + packet[1:]
        await client.send(packet)

    async def wait_for(self, predicate):
        for _ in range(200):
            if predicate():
                return
            await asyncio.sleep(.005)
        self.fail('Expected isolated broker state not reached')

    def connection_events(self):
        with self.b._db_lock, self.b._db_session() as connection:
            rows = connection.execute("SELECT details_json FROM timeline_events WHERE event_type='receiver.connection' ORDER BY id").fetchall()
        return [json.loads(row[0]) for row in rows]

    async def test_handshake_timeout_is_not_reported_as_bad_credentials(self):
        with mock.patch.object(self.b, 'MQTT_CONNECT_TIMEOUT_SECONDS', .05):
            client = await self.connection(authenticate=False)
            self.assertEqual(await client.recv(), b'\x20\x02\x00\x03')
            with self.assertRaises(ConnectionClosed) as result:
                await client.recv()
            self.assertEqual(result.exception.rcvd.code, 4008)
        await self.wait_for(lambda: any(e['reason'] == 'handshake-timeout' for e in self.connection_events()))
        self.assertEqual(self.b._broker_clients, {})

    async def test_keepalive_timeout_is_persisted_without_interrupting_other_receiver(self):
        client = await self.connection(packet=connect_packet(self.fixture.credentials[0], keepalive=1))
        other = await self.connection(index=1)
        with self.assertRaises(ConnectionClosed):
            await asyncio.wait_for(client.recv(), 3)
        await self.wait_for(lambda: any(e['reason'] == 'keepalive-timeout' for e in self.connection_events()))
        event = next(e for e in reversed(self.connection_events()) if e['reason'] == 'keepalive-timeout')
        self.assertEqual(event['keepalive_s'], 1)
        self.assertEqual(event['receiver_id'], self.fixture.credentials[0].receiver_id)
        self.assertEqual(event['close_sent_code'], 1008)
        await other.send(b'\xc0\x00')
        self.assertEqual(await other.recv(), b'\xd0\x00')
        serialized = json.dumps(self.connection_events())
        for credential in self.fixture.credentials:
            self.assertNotIn(credential.secret, serialized)
            self.assertNotIn(credential.username, serialized)

    async def test_connection_diagnostic_allowlist_and_storage_failure(self):
        with mock.patch.object(self.b, '_record_timeline') as persist:
            await self.b._record_receiver_connection('connected', '127.0.0.1', 'isolated',
                keepalive_s=30, password=self.fixture.credentials[0].secret, raw_packet='private')
            self.assertEqual(persist.call_args.kwargs['details'], {
                'reason':'connected','receiver_ip':'127.0.0.1','receiver_id':'isolated','keepalive_s':30})
        with mock.patch.object(self.b, '_record_timeline', side_effect=OSError('private fixture error')):
            await self.b._record_receiver_connection('transport-closed', '127.0.0.1', 'isolated')
        self.assertNotIn('private fixture error', '\n'.join(self.logs))

    async def test_fragmented_authenticated_connect_and_coalesced_ping(self):
        client = await self.connection(authenticate=False)
        packet = connect_packet(self.fixture.credentials[0])
        await client.send(packet[:5])
        self.assertEqual(self.b._broker_clients, {})
        await client.send(packet[5:] + b'\xc0\x00')
        self.assertEqual(await client.recv(), b'\x20\x02\x00\x00')
        self.assertEqual(await client.recv(), b'\xd0\x00')

    async def test_anonymous_wrong_password_and_malformed_connect_cannot_register(self):
        invalid = (connect_packet(self.fixture.credentials[0], flags=2),
                   connect_packet(self.fixture.credentials[0], password='wrong'), b'\x10\x80\x00')
        for packet in invalid:
            client = await self.connection(authenticate=False)
            await client.send(packet)
            self.assertEqual(await asyncio.wait_for(client.recv(), 2), b'\x20\x02\x00\x05')
            with self.assertRaises(ConnectionClosed):
                await client.recv()
            self.assertEqual(self.b._broker_clients, {})
            self.assertEqual(self.b._state['devices'], {})

    async def test_invalid_duplicate_client_id_cannot_evict_authenticated_receiver(self):
        authorized = await self.connection()
        prior = self.b._broker_clients[self.fixture.credentials[0].client_id]
        intruder = await self.connection(authenticate=False)
        await intruder.send(connect_packet(self.fixture.credentials[0], password='wrong'))
        self.assertEqual(await intruder.recv(), b'\x20\x02\x00\x05')
        self.assertIs(self.b._broker_clients[self.fixture.credentials[0].client_id], prior)
        await authorized.send(b'\xc0\x00')
        self.assertEqual(await authorized.recv(), b'\xd0\x00')

    async def test_unpaired_subscribe_is_rejected_before_any_session(self):
        client = await self.connection(authenticate=False)
        await client.send(subscribe_packet(['#']))
        self.assertEqual(await client.recv(), b'\x20\x02\x00\x05')
        self.assertEqual(self.b._broker_clients, {})

    async def test_paired_wildcard_subscription_denied_without_telemetry_leak(self):
        client = await self.connection()
        await client.send(subscribe_packet(['#', 'daty/rf/+', 'daty/rf/devices/up']))
        self.assertEqual(await client.recv(), b'\x90\x05\x00\x01\x80\x80\x80')
        self.assertEqual(self.b._broker_clients[self.fixture.credentials[0].client_id]['subscriptions'], set())
        self.assertEqual(self.b._broker_publish_topic(self.b.MQTT_TOPIC_UP, '{}'), 0)

    async def test_cross_mac_brand_ip_channel_and_receiver_alias_rejected(self):
        for changed in ({'receiver_mac': '02:00:00:00:00:99'}, {'receiver_ip': '127.0.0.2'},
                        {'client_id': 'FAshe-MAC-020000000099'}, {'brand': 'Shure'}, {'channel': 9}):
            with self.subTest(changed=changed):
                client = await self.connection()
                await self.publish(client, self.b.MQTT_TOPIC_UP, {'type': 'device_status_update', 'channel': 1, **changed})
                with self.assertRaises(ConnectionClosed):
                    await asyncio.wait_for(client.recv(), 2)
                self.assertEqual(self.b._state['devices'], {})

    async def test_retained_telemetry_cannot_create_devices(self):
        client = await self.connection()
        await self.publish(client, self.b.MQTT_TOPIC_REGISTER, self.registration(), retained=True)
        with self.assertRaises(ConnectionClosed):
            await client.recv()
        self.assertEqual(self.b._state['devices'], {})

    async def test_business_rejection_does_not_log_raw_payload_or_accidental_credentials(self):
        client = await self.connection()
        before = self.b._state['stats']['total_messages']
        await self.publish(client, self.b.MQTT_TOPIC_DOWN, {'type': 'device_command', 'channel': 1,
            'command': 'mute', 'secret': self.fixture.credentials[0].secret})
        await self.wait_for(lambda: self.b._state['stats']['total_messages'] > before)
        await asyncio.wait_for(self.b._get_mqtt_dispatch_queue().join(), 2)
        self.assertNotIn(self.fixture.credentials[0].secret, '\n'.join(self.logs))
        self.assertEqual(self.b._state['devices'], {})

    async def test_receiver_cannot_publish_server_clock(self):
        client = await self.connection()
        await self.publish(client, self.b.MQTT_TOPIC_CLOCK_SYNC, {'type': 'clock_sync', 'channel': 1})
        with self.assertRaises(ConnectionClosed):
            await client.recv()
        self.assertEqual(self.b._clock_state['pending'], {})
        self.assertEqual(self.b._clock_state['clients'], {})

    async def test_clock_ack_cannot_borrow_other_receivers_pending_sequence(self):
        first, second = await self.connection(), await self.connection(1)
        await second.send(subscribe_packet([self.b.MQTT_TOPIC_CLOCK_SYNC]))
        self.assertEqual((await second.recv())[0], 0x90)
        packet = await second.recv()
        _, offset = self.b._mqtt_decode_remaining_length(packet, 1)
        _, offset = self.b._extract_utf_string(packet, offset)
        payload = {**json.loads(packet[offset:]), 'type': 'clock_sync_ack'}
        await self.publish(first, self.b.MQTT_TOPIC_CLOCK_ACK, payload)
        await first.send(b'\xc0\x00')
        self.assertEqual(await first.recv(), b'\xd0\x00')
        self.assertEqual(self.b._clock_state['clients'], {})
        await self.publish(second, self.b.MQTT_TOPIC_CLOCK_ACK, payload)
        await self.wait_for(lambda: self.fixture.credentials[1].client_id in self.b._clock_state['clients'])
        self.assertNotIn(self.fixture.credentials[0].client_id, self.b._clock_state['clients'])

    async def test_sparse_telemetry_preserves_values_but_cannot_supply_cached_ack(self):
        client = await self.connection()
        registration = self.registration()
        registration['devices'][0].update(af_level=-12, rf_level=-65, battery=74)
        await self.publish(client, self.b.MQTT_TOPIC_REGISTER, registration)
        did = self.fixture.credentials[0].receiver_id + '_ch1'
        await self.wait_for(lambda: did in self.b._state['devices'])
        for command, value, field in (('unmute', False, 'muted'), ('set_freq', 641.0, 'freq_mhz')):
            with mock.patch.object(self.b, '_broker_publish_command', return_value=1):
                _, record = self.b._publish_tracked_command({'command_id': 'sparse-' + command,
                    'command': command, 'channel': 1, 'value': value}, [did])
            for changed in ({}, {field: None}, {field: 'invalid'}):
                before = self.b._state['stats']['total_messages']
                await self.publish(client, self.b.MQTT_TOPIC_UP, {'channel': 1,
                    'command_id': record['command_id'], **changed})
                await self.wait_for(lambda: self.b._state['stats']['total_messages'] > before)
                await asyncio.wait_for(self.b._get_mqtt_dispatch_queue().join(), 2)
                self.assertEqual(record['status'], 'published')
                self.assertEqual(self.b._state['devices'][did]['af_dbfs'], -12)
                self.assertEqual(self.b._state['devices'][did]['rf'], -65)
                self.assertEqual(self.b._state['devices'][did]['batt'], 74)
            await self.publish(client, self.b.MQTT_TOPIC_UP,
                               {'channel': 1, 'command_id': record['command_id'], field: value})
            await self.wait_for(lambda: record['status'] == 'acknowledged')

    async def test_typed_sparse_devices_batch_does_not_delete_sibling_or_clear_telemetry(self):
        client = await self.connection()
        registration = self.registration()
        registration['devices'][0].update(af_level=-12, rf_level=-65, battery=74)
        registration['devices'].append({'channel': 2, 'brand': 'DATYaudio', 'freq_mhz': 642.0, 'muted': True})
        await self.publish(client, self.b.MQTT_TOPIC_REGISTER, registration)
        await self.wait_for(lambda: len(self.b._state['devices']) == 2)
        before = self.b._state['stats']['total_messages']
        await self.publish(client, self.b.MQTT_TOPIC_UP,
                           {'type': 'device_status_update', 'devices': [{'channel': 1, 'rf_level': -75}]})
        await self.wait_for(lambda: self.b._state['stats']['total_messages'] > before)
        await asyncio.wait_for(self.b._get_mqtt_dispatch_queue().join(), 2)
        self.assertEqual(len(self.b._state['devices']), 2)
        first = self.b._state['devices'][self.fixture.credentials[0].receiver_id + '_ch1']
        second = self.b._state['devices'][self.fixture.credentials[0].receiver_id + '_ch2']
        self.assertEqual(first['rf'], -75)
        self.assertEqual(first['af_dbfs'], -12)
        self.assertEqual(first['batt'], 74)
        self.assertEqual(first['freq'], 641000)
        self.assertTrue(second['muted'])

    async def test_local_receiver_down_never_forwards_to_other_receiver(self):
        first, second = await self.connection(), await self.connection(1)
        for index, client in enumerate((first, second)):
            await self.publish(client, self.b.MQTT_TOPIC_REGISTER, self.registration(index))
            await client.send(subscribe_packet([self.b.MQTT_TOPIC_DOWN]))
            self.assertEqual((await client.recv())[0], 0x90)
        await self.wait_for(lambda: len(self.b._state['devices']) == 2)
        await self.publish(first, self.b.MQTT_TOPIC_DOWN, {'type': 'device_command', 'channel': 1,
                           'command': 'mute', 'value': True, 'muted': True})
        own = self.fixture.credentials[0].receiver_id + '_ch1'
        other = self.fixture.credentials[1].receiver_id + '_ch1'
        await self.wait_for(lambda: self.b._state['devices'][own]['muted'])
        self.assertFalse(self.b._state['devices'][other]['muted'])
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(second.recv(), .1)

    async def test_revoked_principal_drops_queued_data_and_outbound_commands(self):
        client = await self.connection()
        credential = self.fixture.credentials[0]
        session = self.b._broker_clients[credential.client_id]
        self.fixture.records[0]['revoked'] = True
        self.fixture.save()
        with mock.patch.object(self.b, '_process_mqtt_message') as process:
            self.b._process_queued_mqtt_message(self.b.MQTT_TOPIC_UP, '{"channel":1}',
                                               credential.client_id, session['connection_token'])
            process.assert_not_called()
        self.assertFalse(await self.b._send_paired_packet(credential.client_id, session, b'NO'))
        self.assertFalse(await self.b._send_clock_payload(credential.client_id, session, self.b._clock_sync_payload()))
        with self.assertRaises(ConnectionClosed):
            await asyncio.wait_for(client.recv(), 2)

    async def test_reused_client_id_requires_fresh_full_session_source_before_control(self):
        first = await self.connection()
        await self.publish(first, self.b.MQTT_TOPIC_REGISTER, self.registration())
        did = self.fixture.credentials[0].receiver_id + '_ch1'
        await self.wait_for(lambda: did in self.b._state['devices'])
        old_source = self.b._state['devices'][did]['_source']
        replacement = await self.connection()
        await replacement.send(subscribe_packet([self.b.MQTT_TOPIC_DOWN]))
        self.assertEqual((await replacement.recv())[0], 0x90)
        self.assertEqual(self.b._state['devices'][did]['_source'], old_source)
        with mock.patch.object(self.b, '_broker_publish_topic') as publish:
            self.assertEqual(self.b._broker_publish_command({'command': 'mute', 'channel': 1}, [did]), 0)
            publish.assert_not_called()
        await self.publish(replacement, self.b.MQTT_TOPIC_REGISTER, self.registration())
        await self.wait_for(lambda: self.b._state['devices'][did]['_source'] != old_source)
        with mock.patch.object(self.b, '_broker_publish_topic', return_value=1) as publish:
            self.assertEqual(self.b._broker_publish_command({'command': 'mute', 'channel': 1}, [did]), 1)
            publish.assert_called_once()

    async def test_restored_snapshot_must_match_pairing_identity_brand_and_channel_limit(self):
        client = await self.connection()
        await self.publish(client, self.b.MQTT_TOPIC_REGISTER, self.registration())
        did = self.fixture.credentials[0].receiver_id + '_ch1'
        await self.wait_for(lambda: did in self.b._state['devices'])
        original = dict(self.b._state['devices'][did])
        for changed in ({'_receiver_id': self.fixture.credentials[1].receiver_id},
                        {'receiver_mac': self.fixture.credentials[1].receiver_mac}, {'brand': 'Shure'},
                        {'channel_number': 9}):
            self.b._state['devices'][did] = {**original, **changed}
            with self.subTest(changed=changed), mock.patch.object(self.b, '_broker_publish_topic') as publish:
                self.assertEqual(self.b._broker_publish_command({'command': 'mute', 'channel': 1}, [did]), 0)
                publish.assert_not_called()
        self.b._state['devices'][did] = original

    async def test_session_replacement_between_preflight_and_topic_selection_cannot_publish(self):
        client = await self.connection()
        await self.publish(client, self.b.MQTT_TOPIC_REGISTER, self.registration())
        await client.send(subscribe_packet([self.b.MQTT_TOPIC_DOWN]))
        self.assertEqual((await client.recv())[0], 0x90)
        credential = self.fixture.credentials[0]
        did = credential.receiver_id + '_ch1'
        await self.wait_for(lambda: did in self.b._state['devices'])
        original_session = self.b._broker_clients[credential.client_id]
        replacement = {**original_session, 'connection_token': 'isolated-race-replacement',
                       'ws': mock.AsyncMock()}
        original_publish = self.b._broker_publish_topic
        def replace_after_preflight(topic, payload, targets, expected_sessions=None):
            self.assertIs(expected_sessions[credential.client_id], original_session)
            # Deterministic scheduling barrier: the receiver reconnects with
            # the SAME authenticated client ID after preflight releases lock.
            with self.b._broker_lock:
                self.b._broker_clients[credential.client_id] = replacement
            return original_publish(topic, payload, targets, expected_sessions)
        try:
            with mock.patch.object(self.b, '_broker_publish_topic', side_effect=replace_after_preflight), \
                    mock.patch.object(asyncio, 'run_coroutine_threadsafe') as schedule:
                sent = self.b._broker_publish_command({'command': 'mute', 'channel': 1}, [did])
                self.assertEqual(sent, 0)
                schedule.assert_not_called()
            self.assertFalse(await self.b._send_paired_packet(credential.client_id, original_session, b'NO_SEND'))
            replacement['ws'].send.assert_not_awaited()
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(client.recv(), .05)
        finally:
            with self.b._broker_lock:
                self.b._broker_clients[credential.client_id] = original_session

    async def test_unknown_ca_rejected_before_mqtt_authentication(self):
        with self.assertRaises(ssl.SSLCertVerificationError):
            await websockets.connect(self.url, ssl=ssl.create_default_context(), subprotocols=['mqtt'])
        self.assertEqual(self.b._broker_clients, {})

    async def test_wrong_tls_hostname_rejected_before_mqtt_authentication(self):
        with self.assertRaises(ssl.SSLCertVerificationError):
            await websockets.connect(self.url, ssl=client_context(self.tls_config),
                                      server_hostname='wrong.invalid', subprotocols=['mqtt'])
        self.assertEqual(self.b._broker_clients, {})

    async def test_https_command_without_target_never_reaches_publisher(self):
        server = bind_https(self.b.ThreadingHTTPServer, ('127.0.0.1', 0), self.b.DatyAPIHandler,
                            server_context(self.tls_config))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request():
            for authorization in (None, 'Bearer wrong'):
                headers = {'Content-Type': 'application/json'}
                if authorization:
                    headers['Authorization'] = authorization
                item = Request(f'https://127.0.0.1:{server.server_port}/api/command',
                    data=b'{"command":"mute","channel":1}', headers=headers)
                with self.assertRaises(HTTPError) as error:
                    urlopen(item, timeout=2, context=client_context(self.tls_config))
                self.assertEqual(error.exception.code, 409)
                error.exception.close()
        try:
            with mock.patch.object(self.b, '_publish_tracked_command') as publish:
                await asyncio.to_thread(request)
                publish.assert_not_called()
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()
            thread.join(2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
