"""共享固定单位数据 + 隔离 HTTP 检查，不向现场设备发送指令。"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http_test_support import json_headers


class P0FrequencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-p0-')
        root = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('daty_p0_frequency', root / 'mqtt-bridge.py')
        cls.b = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'DATY_DB_PATH': str(Path(cls.temp.name) / 'test.sqlite3')}):
            spec.loader.exec_module(cls.b)
        cls.b._log = lambda *args, **kwargs: None
        cls.fixture = json.loads((root / 'tests/fixtures/p0-reference.json').read_text(encoding='utf-8'))

    @classmethod
    def tearDownClass(cls):
        cls.b._close_database()
        cls.temp.cleanup()

    def test_shared_frontend_backend_frequency_fixtures(self):
        for case in self.fixture['frequencyCases']:
            with self.subTest(case=case):
                self.assertEqual(self.b._normalize_frequency_khz(case['value'], case['unit']), case['expectedKHz'])

    def test_explicit_payload_units_aliases_invalid_and_missing(self):
        for payload in ({'freq_mhz': 641.25}, {'frequency_hz': 641250000},
                        {'freq': 641.25, 'frequency_unit': 'MHz'}, {'frequencyKHz': 641250}):
            self.assertEqual(self.b._frequency_from_payload(payload), 641250)
        self.assertIsNone(self.b._frequency_from_payload({'frequencyKHz': None, 'freq': 641250}, 620000))
        self.assertIsNone(self.b._frequency_from_payload({'freq': 641.25, 'frequency_unit': 'bad'}))
        self.assertIsNone(self.b._frequency_from_payload({'freq': 641.25, 'frequency_unit': None, 'freq_unit': 'MHz'}))
        self.assertEqual(self.b._frequency_from_payload({}, 620000), 620000)

    def test_http_rejects_fractional_khz_before_resolving_or_sending_command(self):
        server = self.b.ThreadingHTTPServer(('127.0.0.1', 0), self.b.DatyAPIHandler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with patch.object(self.b, '_broker_publish_command') as publish:
                for value in (641.2505, True, None, 'bad', 641250):
                    request = Request(f'http://127.0.0.1:{server.server_port}/api/command',
                        json.dumps({'command': 'set_freq', 'value': value, 'ip': '127.0.0.2', 'channel': 1}).encode(),
                        json_headers(), method='POST')
                    with self.assertRaises(HTTPError) as response:
                        urlopen(request, timeout=2)
                    self.assertEqual(response.exception.code, 400)
                publish.assert_not_called()
        finally:
            server.shutdown(); server.server_close(); worker.join(timeout=3)

    def test_ack_frequency_requires_exact_valid_integer_khz(self):
        record = {'command': 'set_freq', 'expected_value': 641.25}
        self.assertTrue(self.b._command_value_matches(record, 641.25))
        for value in (None, True, 641250, 641.2504, 641.249, '641_250', 'NaN'):
            self.assertFalse(self.b._command_value_matches(record, value))
        for value in (None, True, 641250.4, 'bad'):
            self.assertIsNone(self.b._command_actual_value('set_freq', {'freq': value}))

    def test_frequency_ack_only_matches_target_receiver_and_channel(self):
        b = self.b
        target = 'FAshe-192.0.2.102_ch2'
        with patch.object(b, '_persist_command'), patch.object(b, '_record_timeline'), patch.dict(b._state, {'commands': {}}):
            command = b._create_command_record({'command_id': 'isolated-freq-ack', 'command': 'set_freq',
                'device_id': target, 'value': 641.25}, [target], 1)
            for other in ('FAshe-192.0.2.102_ch1', 'FAshe-192.0.2.103_ch2'):
                self.assertEqual(b._reconcile_commands_for_device(other, {'freq': 641250}), [])
                self.assertEqual(command['status'], 'published')
            for value in (None, 641251, 641250.4):
                self.assertEqual(b._reconcile_commands_for_device(target, {'freq': value}), [])
                self.assertEqual(command['status'], 'published')
            ack = b._reconcile_commands_for_device(target, {'freq': 641250})
            self.assertEqual(len(ack), 1)
            self.assertEqual(ack[0]['status'], 'acknowledged')
            self.assertEqual(ack[0]['actual_value'], 641.25)
            self.assertEqual(b._reconcile_commands_for_device(target, {'freq': 641250}), [])
