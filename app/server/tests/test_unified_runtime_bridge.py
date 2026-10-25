"""Source-only Bridge patch replay with temporary SQLite and fake broker sends.

No receiver connection, production DB/config, firewall or service I/O. The HTTP
case uses its own temporary CA and random loopback HTTPS listener. All three
reviewed patches are composed, so the real startup migrator creates the schema.
"""
import ast
import hashlib
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import unified_live
from access_test_support import TEST_TOKEN, make_test_policy
from pairing_test_support import create_tls_fixture
from tls_support import bind_https, client_context, server_context


def assemble(raw, spec):
    if hashlib.sha256(raw).hexdigest() != spec['sourceSha256']:
        raise ValueError('Source digest mismatch')
    value = raw.decode('utf-8').replace('\r\n', '\n')
    for change in spec['changes']:
        before, after = change['before'], change['after']
        if not before or before == after or value.count(before) != 1:
            raise ValueError('Patch anchor must be unique and material')
        value = value.replace(before, after, 1)
    return value


class UnifiedBridgeRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = (ROOT / 'mqtt-bridge.py').read_bytes()
        cls.spec = json.loads((ROOT / 'patches' / 'udb-bridge-live.json').read_text(encoding='utf-8'))
        cls.live_source = assemble(cls.raw, cls.spec)
        cls.source = cls.raw.decode('utf-8').replace('\r\n', '\n')
        for name in ('c2-bridge.json', 'udb-bridge-api.json', 'udb-bridge-live.json'):
            specification = json.loads((ROOT / 'patches' / name).read_text(encoding='utf-8'))
            if hashlib.sha256(cls.raw).hexdigest() != specification['sourceSha256']:
                raise ValueError('Original source digest mismatch in composed candidate')
            for change in specification['changes']:
                if cls.source.count(change['before']) != 1 or change['before'] == change['after']:
                    raise ValueError('Composed candidate anchor must match exactly once')
                cls.source = cls.source.replace(change['before'], change['after'], 1)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='daty-unified-runtime-fixture-')
        self.addCleanup(self.directory.cleanup)
        path = Path(self.directory.name)
        self.environment = patch.dict(os.environ, {
            'DATY_DB_PATH': str(path / 'fixture.sqlite3'),
            'DATY_ACCESS_FILE': str(path / 'fixture-access.json'),
            'DATY_PAIRING_FILE': str(path / 'fixture-pairings.json'),
        })
        self.environment.start(); self.addCleanup(self.environment.stop)
        self.bridge = {'__file__': str(path / 'source-only-candidate.py'), '__name__': 'isolated_unified_candidate'}
        exec(compile(self.source, self.bridge['__file__'], 'exec'), self.bridge)
        self.addCleanup(self.bridge['_close_database'])
        self.logs, self.published = [], []
        self.bridge['_log'] = lambda tag, message: self.logs.append((tag, message))
        # No injected schema setup: _init_database from the composed candidate
        # has already run C2 and unified versioned migrations.
        self.runtime = self.bridge['_start_unified_runtime']()
        self.addCleanup(self.runtime.stop)
        self.bridge['_broker_publish_command'] = lambda payload, targets: self.published.append((dict(payload), list(targets))) or 1
        self.receiver = 'FAshe-MAC-020000000001'

    def send(self, topic, body):
        payload = {'client_id': self.receiver, 'receiver_id': self.receiver,
                   'receiver_mac': '02:00:00:00:00:01', 'receiver_ip': '192.0.2.102',
                   'brand': 'DATYaudio', 'control_protocol': 'fashe-realtime-v1', **body}
        self.bridge['_process_mqtt_message'](topic, json.dumps(payload), 'fixture-mqtt-client', 'fixture-session')
        result = self.runtime.wait_idle()
        self.assertTrue(result['drained'])
        self.assertTrue(result['complete'], (result, self.logs))

    def register(self, count=1):
        self.send(self.bridge['MQTT_TOPIC_REGISTER'], {'devices': [
            {'channel': channel, 'brand': 'DATYaudio', 'model': 'RX-8', 'name': f'CH{channel}',
             'freq_mhz': 641 + (channel - 1) * 0.25, 'rf_level': -60, 'af_level': -20,
             'battery': 75, 'muted': False, 'status': 'online'} for channel in range(1, count + 1)]})

    def sql(self, sql, args=()):
        with self.bridge['_db_session']() as connection:
            return [tuple(row) for row in connection.execute(sql, args).fetchall()]

    def test_patch_guards_exact_source_and_never_changes_production_file(self):
        self.assertEqual(hashlib.sha256((ROOT / 'mqtt-bridge.py').read_bytes()).hexdigest(), self.spec['sourceSha256'])
        with self.assertRaises(ValueError):
            assemble(self.raw + b'\n', self.spec)
        with self.assertRaises(ValueError):
            assemble(self.source.encode(), self.spec)

    def test_identity_target_auth_frequency_ack_predicates_and_api_are_unchanged(self):
        def nodes(source):
            return {item.name: ast.dump(item, include_attributes=False) for item in ast.parse(source).body
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
        original, candidate = nodes(self.raw.decode('utf-8')), nodes(self.live_source)
        names = ('_resolve_command_targets_locked', '_canonical_fashe_id', '_claim_receiver_source',
                 '_normalize_frequency_khz', '_normalize_af_dbfs', '_command_value_matches',
                 '_apply_mute_command', '_broker_publish_command', '_create_command_record',
                 '_publish_tracked_command', '_get_devices_snapshot', 'DatyAPIHandler', '_init_database')
        for name in names:
            self.assertEqual(candidate[name], original[name], name)
        self.assertNotIn('firewall', ' '.join(change['id'] for change in self.spec['changes']))

    def test_bootstrap_is_before_all_background_threads_and_listeners(self):
        main = next(item for item in ast.parse(self.source).body if isinstance(item, ast.FunctionDef) and item.name == 'main')
        calls = [node for node in ast.walk(main) if isinstance(node, ast.Call)]
        started = next(node.lineno for node in calls if isinstance(node.func, ast.Name) and node.func.id == '_start_unified_runtime')
        for node in calls:
            if isinstance(node.func, ast.Attribute) and node.func.attr in ('Thread', 'start', 'serve_forever'):
                self.assertLess(started, node.lineno)
            if isinstance(node.func, ast.Name) and node.func.id == 'bind_https':
                self.assertLess(started, node.lineno)

    def test_existing_register_and_up_create_relational_receiver_channels_and_exact_metrics(self):
        self.register(2)
        self.assertEqual(self.sql('SELECT COUNT(*) FROM live_receivers'), [(1,)])
        self.assertEqual(self.sql('SELECT channel_number FROM live_channels ORDER BY channel_number'), [(1,), (2,)])
        self.send(self.bridge['MQTT_TOPIC_UP'], {'channel': 2, 'freq_mhz': 642, 'af_level': 0, 'rf_level': -90, 'battery': 0})
        self.assertEqual(self.sql('SELECT frequency_khz,af_dbfs,rf_dbm,battery_percent FROM live_latest WHERE device_id=?',
                                  (self.receiver + '_ch2',)), [(642000, 0.0, -90.0, 0.0)])
        self.assertEqual(self.published, [])

    def test_receiver_local_mute_down_is_persisted_without_sending_a_command_or_inventing_ack(self):
        self.register()
        self.send(self.bridge['MQTT_TOPIC_DOWN'], {'type': 'device_command', 'command': 'mute', 'channel': 1, 'value': True})
        self.assertEqual(self.sql('SELECT muted FROM live_latest'), [(1,)])
        self.send(self.bridge['MQTT_TOPIC_DOWN'], {'type': 'device_command', 'command': 'unmute', 'channel': 1, 'value': False})
        self.assertEqual(self.sql('SELECT muted FROM live_latest'), [(0,)])
        self.assertEqual(self.sql('SELECT COUNT(*) FROM live_commands'), [(0,)])
        self.assertEqual(self.published, [])

    def test_existing_command_gate_rejects_wrong_ack_then_persists_true_ack_and_source_evidence(self):
        self.register()
        target = self.receiver + '_ch1'
        payload = {'command_id': 'fixture-command-a', 'command': 'set_freq', 'value': 641.25,
                   'device_id': target, 'channel_number': 1, 'receiver_id': self.receiver,
                   'receiver_ip': '192.0.2.102', 'receiver_mac': '02:00:00:00:00:01',
                   'brand': 'DATYaudio', 'expected_brand': 'DATYaudio',
                   '_authorized_actor': {'id': 'fixture-operator', 'name': '测试', 'role': 'operator'}}
        count, record = self.bridge['_publish_tracked_command'](payload, [target])
        self.assertEqual(count, 1)
        self.assertTrue(self.runtime.wait_idle()['complete'])
        self.assertEqual(self.sql('SELECT status FROM live_commands'), [('published',)])
        self.send(self.bridge['MQTT_TOPIC_UP'], {'channel': 1, 'freq_mhz': 641.25, 'command_id': 'wrong-command'})
        self.assertEqual(record['status'], 'published')
        self.assertEqual(self.sql('SELECT status FROM live_commands'), [('published',)])
        self.send(self.bridge['MQTT_TOPIC_UP'], {'channel': 1, 'freq_mhz': 641.25, 'command_id': 'fixture-command-a'})
        self.assertEqual(record['status'], 'acknowledged')
        stored = self.sql('SELECT status,record_json,ack_round_trip_ms FROM live_commands')[0]
        self.assertEqual(stored[0], 'acknowledged'); self.assertIsNotNone(stored[2])
        evidence = json.loads(stored[1])['ack_evidence']
        self.assertEqual(evidence['reported_command_id'], 'fixture-command-a')
        self.assertEqual(evidence['source_key'], 'fixture-mqtt-client:mqtt:fixture-session')
        self.assertTrue(evidence['requires_command_id'])
        self.assertNotIn('_persistence_ack_evidence', self.bridge['_command_public_view'](record))
        self.assertEqual(len(self.published), 1)  # Captured stub only, never network I/O.

    def test_full_reregistration_and_disconnect_inventory_soft_remove_not_delete_history(self):
        self.register(2)
        self.register(1)
        self.assertEqual(self.sql('SELECT removed FROM live_latest ORDER BY device_id'), [(0,), (1,)])
        self.assertEqual(self.sql('SELECT COUNT(*) FROM live_channels'), [(2,)])
        with self.bridge['_state_lock']:
            for value in self.bridge['_state']['devices'].values():
                value['_last_seen'] = 0
        self.bridge['_queue_unified_inventory']()
        self.assertTrue(self.runtime.wait_idle()['complete'])
        self.assertEqual(self.sql('SELECT removed FROM live_latest ORDER BY device_id'), [(1,), (1,)])
        self.assertEqual(self.sql('SELECT COUNT(*) FROM live_channels'), [(2,)])
        self.assertEqual(self.published, [])

    def test_runtime_status_is_memory_only_and_does_not_change_original_health_api(self):
        status = self.bridge['get_unified_runtime_status']()
        self.assertTrue(status['complete']); self.assertEqual(status['boot_id'], self.bridge['_clock_state']['server_id'])
        self.assertNotIn('get_unified_runtime_status', ast.get_source_segment(self.live_source,
            next(item for item in ast.parse(self.live_source).body if isinstance(item, ast.ClassDef) and item.name == 'DatyAPIHandler')))

    def test_composed_candidate_https_migration_auth_status_overview_and_history_are_real(self):
        directory = Path(self.directory.name)
        tls = create_tls_fixture(directory)
        server = bind_https(self.bridge['ThreadingHTTPServer'], ('127.0.0.1', 0),
                            self.bridge['DatyAPIHandler'], server_context(tls))
        server.access_policy = make_test_policy(SimpleNamespace(**self.bridge), directory)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        def stop_http():
            server.shutdown(); server.server_close(); worker.join(5)
        self.addCleanup(stop_http)
        def get(path, authorized=True):
            connection = http.client.HTTPSConnection('127.0.0.1', server.server_port, context=client_context(tls), timeout=5)
            try:
                headers = {'Authorization': 'Bearer ' + TEST_TOKEN} if authorized else {}
                connection.request('GET', path, headers=headers)
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()
        code, body = get('/api/database/status', authorized=False)
        self.assertEqual(code, 401); self.assertFalse(body['success'])
        code, body = get('/api/database/status')
        self.assertEqual(code, 200); self.assertTrue(body['success'])
        self.assertTrue(body['live_persistence']['complete'])
        self.assertTrue(self.sql("SELECT 1 FROM sqlite_master WHERE type='table' AND name='db_schema_migrations'"))
        self.register(2)
        code, body = get('/api/database/overview')
        self.assertEqual(code, 200); self.assertEqual((body['online_devices'], body['active_channels']), (1, 2))
        code, body = get('/api/database/channels?limit=1')
        self.assertEqual(code, 200); self.assertEqual(body['count'], 1)
        self.assertFalse(body['channels'][0]['control_target']); self.assertIsNotNone(body['next_cursor'])
        with self.bridge['_state_lock']:
            for value in self.bridge['_state']['devices'].values():
                value['_last_seen'] = 0
        self.bridge['_queue_unified_inventory'](); self.assertTrue(self.runtime.wait_idle()['complete'])
        code, body = get('/api/database/overview')
        self.assertEqual(code, 200); self.assertEqual((body['online_devices'], body['known_channels']), (0, 2))
        self.assertEqual(self.published, [])


if __name__ == '__main__':
    unittest.main()
