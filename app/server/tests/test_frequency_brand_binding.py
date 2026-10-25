"""Frequency brand binding against isolated loopback HTTP and a temporary database.

No production receiver, service, or project is contacted. MQTT publication is mocked.
"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http_test_support import json_headers
from pairing_test_support import PairingFixture


class FrequencyBrandBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-brand-binding-')
        spec = importlib.util.spec_from_file_location(
            'daty_brand_binding_test', Path(__file__).resolve().parents[1] / 'mqtt-bridge.py')
        cls.b = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'DATY_DB_PATH': str(Path(cls.temp.name) / 'test.sqlite3')}):
            spec.loader.exec_module(cls.b)
        cls.b._log = lambda *args, **kwargs: None
        cls.http = cls.b.ThreadingHTTPServer(('127.0.0.1', 0), cls.b.DatyAPIHandler)
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.worker.join(timeout=2)
        cls.b._close_database()
        cls.temp.cleanup()

    def setUp(self):
        b = self.b
        for name in ('devices', 'clients', 'receivers', 'receiver_aliases',
                     'source_epochs', 'receiver_epoch_fences', 'commands'):
            b._state[name].clear()
        b._state['sse_queues'].clear()
        self.did = 'isolated-brand-receiver_ch1'
        b._state['devices'][self.did] = {
            'id': self.did, 'brand': 'DATYaudio', 'channel_number': 1,
            '_receiver_id': 'isolated-brand-receiver', 'receiver_ip': '127.0.0.2',
            '_source': 'isolated-brand-receiver:mqtt:session',
            'control_protocol': 'fashe-realtime-v1', 'freq': 641000,
        }

    def post(self, **overrides):
        cmd = {'command': 'set_freq', 'device_id': self.did, 'channel_number': 1,
               'value': 642.25, **overrides}
        request = Request(f'http://127.0.0.1:{self.http.server_port}/api/command',
                          data=json.dumps(cmd).encode(), headers=json_headers())
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, json.load(error)

    def test_brand_aliases_match_and_forward_authoritative_brand_on_frequency_and_ack_record(self):
        for target, aliases, canonical in (
            ('DATYaudio', ('DATY', 'datyaudio', ' DATY_audio '), 'DATYaudio'),
            ('AMSaudio', ('AMS', 'amsaudio', 'AMS-audio'), 'AMSaudio'),
            ('Sennheiser', ('Senn', 'SENNHEISER', ' Sennheiser '), 'Sennheiser'),
        ):
            self.b._state['devices'][self.did]['brand'] = target
            for alias in aliases:
                with self.subTest(target=target, alias=alias), \
                     patch.object(self.b, '_broker_publish_command', return_value=1) as publish:
                    status, body = self.post(expected_brand=alias, brand='spoofed-other-brand')
                    self.assertEqual(status, 200, body)
                    self.assertEqual(publish.call_count, 1)
                    command = publish.call_args.args[0]
                    self.assertEqual(command['brand'], canonical)
                    self.assertEqual(command['expected_brand'], canonical)
                    self.assertEqual(command['device_id'], self.did)
                    self.assertEqual(command['channel_number'], 1)
                    self.assertEqual(body['command_record']['brand'], canonical)
                    self.assertEqual(body['command_record']['expected_brand'], canonical)

    def test_wrong_brand_is_rejected_before_any_command_record_or_publish(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            for brand in ('AMSaudio', 'Shure', 'Senn', 'unknown'):
                status, body = self.post(expected_brand=brand)
                self.assertEqual(status, 409, body)
                self.assertFalse(body['success'])
                self.assertEqual(body['target_brand'], 'DATYaudio')
            publish.assert_not_called()
        self.assertEqual(self.b._state['commands'], {})

    def test_present_but_empty_or_non_string_expectation_is_rejected(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            for brand in ('', ' _- ', None, False, 1, [], {}):
                with self.subTest(brand=brand):
                    status, body = self.post(expected_brand=brand)
                    self.assertEqual(status, 400, body)
            publish.assert_not_called()

    def test_missing_authoritative_brand_cannot_match_client_expectation(self):
        self.b._state['devices'][self.did].pop('brand')
        with patch.object(self.b, '_publish_tracked_command') as publish:
            self.assertEqual(self.post(expected_brand='DATYaudio')[0], 409)
            publish.assert_not_called()

    def test_legacy_frequency_without_expectation_and_mute_behavior_are_preserved(self):
        with patch.object(self.b, '_broker_publish_command', return_value=1) as publish:
            status, body = self.post()
            self.assertEqual(status, 200, body)
            self.assertNotIn('expected_brand', publish.call_args.args[0])
            self.assertNotIn('expected_brand', body['command_record'])
            for name in ('mute', 'unmute'):
                status, body = self.post(command=name, expected_brand='Shure')
                self.assertEqual(status, 200, body)
                self.assertEqual(body['cmd']['value'], name == 'mute')
                self.assertNotIn('expected_brand', body['command_record'])

    def test_shure_remains_read_only_even_with_matching_brand_and_mqtt_source(self):
        for brand in ('Shure', ' SHURE ', 'Sh_ure'):
            self.b._state['devices'][self.did]['brand'] = brand
            with patch.object(self.b, '_publish_tracked_command') as publish:
                status, body = self.post(expected_brand='Shure')
                self.assertEqual(status, 403, body)
                self.assertEqual(body['capabilities']['adapter'], 'shure-scp-readonly')
                publish.assert_not_called()

    def test_brand_change_after_http_preflight_is_rejected_at_broker_publish(self):
        pairing = PairingFixture(self.temp.name)
        credential = pairing.credentials[0]
        self.b._pairing_policy = pairing.policy
        session = {'pairing': pairing.principal(), 'connection_token': 'brand-preflight-session'}
        self.b._broker_clients.clear()
        self.b._broker_clients[credential.client_id] = session
        self.b._state['devices'][self.did].update({
            '_receiver_id': credential.receiver_id, 'receiver_mac': credential.receiver_mac,
            '_source': self.b._mqtt_source_key(credential.client_id, session['connection_token'])})
        with patch.object(self.b, '_broker_publish_topic', return_value=1) as publish:
            command = {'command': 'set_freq', 'expected_brand': 'DATYaudio'}
            self.b._state['devices'][self.did]['brand'] = 'AMSaudio'
            self.assertEqual(self.b._broker_publish_command(command, [self.did]), 0)
            publish.assert_not_called()
            self.b._state['devices'][self.did]['brand'] = 'DATY'
            self.assertEqual(self.b._broker_publish_command(command, [self.did]), 1)
            self.assertEqual(publish.call_count, 1)
            self.assertEqual(publish.call_args.args[2], {credential.client_id})
            self.assertIs(publish.call_args.args[3][credential.client_id], session)

    def test_ack_uses_authoritative_brand_not_packet_brand_and_preserves_request_id(self):
        request_id = 'frequency-brand-request-0001'
        with patch.object(self.b, '_broker_publish_command', return_value=1):
            status, body = self.post(expected_brand='DATY', client_request_id=request_id)
        self.assertEqual(status, 200, body)
        command_id = body['command_id']
        self.b._state['devices'][self.did]['brand'] = 'AMSaudio'
        self.assertEqual(self.b._reconcile_commands_for_device(
            self.did, {'freq': 642250, 'brand': 'DATYaudio'}, command_id), [])
        self.b._state['devices'][self.did]['brand'] = 'DATYaudio'
        records = self.b._reconcile_commands_for_device(self.did, {'freq': 642250}, command_id)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['client_request_id'], request_id)
        self.assertEqual(records[0]['expected_brand'], 'DATYaudio')
        self.assertEqual(records[0]['actual_value'], 642.25)

    def test_reused_request_identifier_cannot_bypass_brand_validation(self):
        request_id = 'frequency-brand-request-0002'
        with patch.object(self.b, '_broker_publish_command', return_value=1) as publish:
            self.assertEqual(self.post(expected_brand='DATYaudio', client_request_id=request_id)[0], 200)
            self.assertEqual(self.post(expected_brand='AMSaudio', client_request_id=request_id)[0], 409)
            self.assertEqual(publish.call_count, 1)

    def test_capability_advertises_server_side_brand_binding_without_unlocking_shure(self):
        raw = self.b._state['devices'][self.did]
        capability = self.b._device_capabilities(raw, raw)
        self.assertEqual(capability['frequency_control']['brand_binding'], 'expected-brand-v1')
        self.assertEqual(capability['frequency_control']['ack_mode'], 'command-id')
        self.assertFalse(self.b._device_capabilities({**raw, 'brand': 'Shure'})['write_frequency'])


if __name__ == '__main__':
    unittest.main()
