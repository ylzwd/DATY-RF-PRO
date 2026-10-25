"""Integrated local development: temporary TLS, registry, SQLite and fake transport.

Never reads production credentials or contacts live services/receivers. The real
Bridge command/ACK implementation is exercised with broker publication injected.
"""
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from email.message import Message
from types import SimpleNamespace
from unittest.mock import Mock, patch

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
from access_control import (AccessPolicy, HttpAccessMixin, LOCAL_DEVELOPMENT_HEADER,
                            LOCAL_DEVELOPMENT_PRINCIPAL, ROLE_PERMISSIONS)
import tls_support as tls

TOKEN = 'daty_0123456789abcdef_' + 'A' * 43


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, PROJECT / filename)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


class IntegratedLocalAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-integrated-local-access-')
        cls.directory = Path(cls.temp.name)
        cls.registry = cls.directory / 'security' / 'access-control.json'
        with patch.dict(os.environ, {
            'DATY_DB_PATH': str(cls.directory / 'fixture.sqlite3'),
            'DATY_ACCESS_FILE': str(cls.registry),
            'DATY_PAIRING_FILE': str(cls.directory / 'unused-pairing.json'),
        }):
            cls.bridge = module('daty_integrated_local_bridge', 'mqtt-bridge.py')
            cls.ip = module('daty_integrated_local_ip', 'ip-service.py')
        cls.bridge._log = lambda *args, **kwargs: None
        manager = module('daty_integrated_local_tls', 'manage-tls.py')
        cls.tls_config = cls.directory / 'security' / 'tls-config.json'
        manager.install_material(cls.tls_config, manager.create_material(['localhost', '127.0.0.1'], days=2))
        cls.context = tls.client_context(cls.tls_config)
        cls.registry.parent.mkdir(exist_ok=True)
        cls.policy = AccessPolicy(cls.registry)
        cls.servers = []
        for owner, handler in ((cls.bridge, cls.bridge.DatyAPIHandler), (cls.ip, cls.ip.DatyServiceHandler)):
            server = tls.bind_https(owner.ThreadingHTTPServer, ('127.0.0.1', 0), handler,
                                    tls.server_context(cls.tls_config))
            server.access_policy = cls.policy
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            cls.servers.append((server, worker))
        cls.http = cls.servers[0][0]
        cls.ip_http = cls.servers[1][0]

    @classmethod
    def tearDownClass(cls):
        for server, worker in cls.servers:
            server.shutdown()
            server.server_close()
            worker.join(3)
        cls.bridge._close_database()
        cls.temp.cleanup()

    def setUp(self):
        self.write_registry()
        for name in ('devices', 'clients', 'receivers', 'receiver_aliases',
                     'source_epochs', 'receiver_epoch_fences', 'commands'):
            self.bridge._state[name].clear()
        self.bridge._broker_clients.clear()
        self.did = 'isolated-local-receiver_ch1'
        for channel in (1, 2):
            device_id = f'isolated-local-receiver_ch{channel}'
            self.bridge._state['devices'][device_id] = {
                'id': device_id, 'brand': 'DATYaudio', 'channel_number': channel,
                '_receiver_id': 'isolated-local-receiver', 'receiver_ip': '127.0.0.2',
                '_source': 'isolated-local-receiver:mqtt:session',
                'control_protocol': 'fashe-realtime-v1', 'freq': 641000, 'muted': False,
            }

    def write_registry(self, *, enabled=True, keys=True, **changes):
        data = {'version': 1, 'allowed_origins': [], 'local_development_enabled': enabled,
                'keys': [{'id': '0123456789abcdef', 'name': 'Fixture operator', 'role': 'operator',
                          'token_sha256': hashlib.sha256(TOKEN.encode()).hexdigest(),
                          'created_at': time.time() - 1, 'expires_at': time.time() + 3600,
                          'revoked': False}] if keys else []}
        data.update(changes)
        self.registry.write_text(json.dumps(data), encoding='utf-8')
        return data

    def request(self, path='/api/auth/status', *, method='GET', body=None, server=None,
                headers=None, native=False, marker=True, duplicate=None):
        server = server or self.http
        request_headers = {}
        if marker:
            request_headers[LOCAL_DEVELOPMENT_HEADER] = '1'
        if not native:
            request_headers.update({'Origin': 'https://localhost:8080',
                'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Site': 'cross-site'})
        request_headers.update(headers or {})
        request_headers = {key: value for key, value in request_headers.items() if value is not None}
        encoded = json.dumps(body).encode() if body is not None else None
        if encoded is not None:
            request_headers['Content-Type'] = 'application/json'
        connection = http.client.HTTPSConnection('127.0.0.1', server.server_port,
                                                 timeout=4, context=self.context)
        try:
            if duplicate:
                connection.putrequest(method, path)
                for key, value in request_headers.items():
                    connection.putheader(key, value)
                connection.putheader(*duplicate)
                if encoded is not None:
                    connection.putheader('Content-Length', str(len(encoded)))
                connection.endheaders(encoded)
            else:
                connection.request(method, path, body=encoded, headers=request_headers)
            response = connection.getresponse()
            content = response.read()
            return response.status, dict(response.headers), json.loads(content) if content else None
        finally:
            connection.close()

    def command(self, **kwargs):
        body = kwargs.pop('body', {'command': 'mute', 'device_id': self.did, 'channel_number': 1})
        return self.request('/api/command', method='POST', body=body, **kwargs)

    def test_browser_and_native_receive_explicit_local_identity_without_secret(self):
        for native in (False, True):
            status, _, data = self.request(native=native)
            self.assertEqual(status, 200)
            self.assertEqual(data['auth']['mode'], 'local-development')
            self.assertTrue(data['auth']['configured'])
            self.assertTrue(data['auth']['authenticated'])
            self.assertEqual(data['auth']['principal'], LOCAL_DEVELOPMENT_PRINCIPAL)
            self.assertEqual(set(data['auth']['permissions']), set(ROLE_PERMISSIONS['operator']))
            self.assertNotIn(TOKEN, json.dumps(data))
            self.assertNotIn('token_sha256', json.dumps(data))

    def test_missing_flag_defaults_closed_and_toggle_hot_reloads_same_policy(self):
        original_policy = self.http.access_policy
        self.write_registry(enabled=False)
        self.assertEqual(self.command()[0], 401)
        self.assertFalse(self.request()[2]['auth']['authenticated'])
        with patch.object(self.bridge, '_broker_publish_command', return_value=1):
            self.write_registry(enabled=True)
            self.assertEqual(self.command()[0], 200)
        data = self.write_registry()
        data.pop('local_development_enabled')
        self.registry.write_text(json.dumps(data), encoding='utf-8')
        self.assertEqual(self.command()[0], 401)
        self.assertIs(self.http.access_policy, original_policy)

    def test_enabled_empty_registry_supports_local_control_without_issuing_keys(self):
        self.write_registry(keys=False)
        self.assertTrue(self.policy.configured())
        self.assertEqual(self.request()[2]['auth']['mode'], 'local-development')
        with patch.object(self.bridge, '_broker_publish_command', return_value=1):
            self.assertEqual(self.command()[0], 200)
        self.assertEqual(self.command(marker=False)[0], 503)
        self.assertEqual(list(self.registry.parent.glob('key-*.txt')), [])

    def test_invalid_flag_or_registry_fails_closed_and_discards_cache(self):
        self.assertEqual(self.request()[2]['auth']['mode'], 'local-development')
        for enabled in (1, 0, 'true', None, [], {}):
            self.write_registry(enabled=enabled)
            self.assertEqual(self.command()[0], 503)
        for content in ('{broken', 'null'):
            self.registry.write_text(content, encoding='utf-8')
            self.assertEqual(self.command()[0], 503)
        self.registry.unlink()
        self.assertEqual(self.command()[0], 503)

    def test_explicit_invalid_empty_duplicate_expired_revoked_and_viewer_bearer_never_fall_back(self):
        with patch.object(self.bridge, '_publish_tracked_command') as publish:
            for value in ('', 'Basic fixture', 'Bearer invalid', 'Bearer ' + TOKEN + 'x'):
                for path, method in (('/api/auth/status', 'GET'), ('/api/command', 'POST')):
                    self.assertEqual(self.request(path, method=method, body={} if method == 'POST' else None,
                                     headers={'Authorization': value})[0], 401)
            self.assertEqual(self.command(headers={'Authorization': ''}, duplicate=('Authorization', ''))[0], 401)
            for change, status in (({'revoked': True}, 401), ({'expires_at': time.time() - 1}, 401),
                                   ({'role': 'viewer'}, 403)):
                data = self.write_registry()
                data['keys'][0].update(change)
                self.registry.write_text(json.dumps(data), encoding='utf-8')
                self.assertEqual(self.command(headers={'Authorization': 'Bearer ' + TOKEN})[0], status)
            publish.assert_not_called()

    def test_valid_bearer_keeps_original_identity_and_permission_contract(self):
        status, _, data = self.request(headers={'Authorization': 'Bearer ' + TOKEN})
        self.assertEqual(status, 200)
        self.assertEqual(data['auth']['mode'], 'control')
        self.assertEqual(data['auth']['principal']['id'], '0123456789abcdef')

    def test_marker_host_and_proxy_failures_do_not_publish(self):
        variants = [{LOCAL_DEVELOPMENT_HEADER: None}, {LOCAL_DEVELOPMENT_HEADER: 'true'},
            {'Host': 'evil.example:' + str(self.http.server_port)}, {'Host': 'localhost:8080'},
            {'Host': 'localhost'}, {'Host': '127.0.0.1:' + str(self.http.server_port) + '.evil'},
            {'Host': 'localhost.:' + str(self.http.server_port)}]
        variants.extend({key: '127.0.0.1'} for key in ('Forwarded', 'X-Forwarded-For',
                        'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP', 'Via'))
        with patch.object(self.bridge, '_publish_tracked_command') as publish:
            for headers in variants:
                with self.subTest(headers=headers):
                    self.assertEqual(self.command(headers=headers)[0], 401)
            for header in ('Host', LOCAL_DEVELOPMENT_HEADER):
                self.assertEqual(self.command(duplicate=(header, '1'))[0], 401)
            publish.assert_not_called()

    def test_untrusted_even_configured_origins_do_not_get_local_authority(self):
        self.write_registry(allowed_origins=['https://trusted-remote.example'])
        with patch.object(self.bridge, '_publish_tracked_command') as publish:
            for origin in ('null', 'https://evil.example', 'http://localhost:8080',
                           'https://localhost:9000', 'https://trusted-remote.example',
                           'https://localhost:8080.evil.example'):
                self.assertIn(self.command(headers={'Origin': origin})[0], (401, 403))
            self.assertEqual(self.command(duplicate=('Origin', 'https://localhost:8080'))[0], 403)
            publish.assert_not_called()

    def test_navigation_images_no_cors_and_originless_browser_metadata_are_denied(self):
        variants = [{'Sec-Fetch-Mode': 'navigate'}, {'Sec-Fetch-Mode': 'no-cors'},
                    {'Sec-Fetch-Dest': 'image'}, {'Origin': None},
                    {'Origin': None, 'Sec-Fetch-Mode': None, 'Sec-Fetch-Dest': None}]
        with patch.object(self.ip, 'get_local_ips') as ips, patch.object(self.ip, '_background_scan') as scan:
            for headers in variants:
                self.assertEqual(self.request('/api/ip/refresh', server=self.ip_http, headers=headers)[0], 401)
            self.assertEqual(self.request('/api/discover?force=1', server=self.ip_http, marker=False)[0], 401)
            self.assertEqual(self.request('/api/ip/refresh', server=self.ip_http, marker=False, native=True)[0], 401)
            ips.assert_not_called()
            scan.assert_not_called()

    def test_discovery_uses_shared_authority_and_retains_original_refresh(self):
        for native in (False, True):
            self.assertEqual(self.request(server=self.ip_http, native=native)[2]['auth']['mode'], 'local-development')
        with patch.object(self.ip, 'get_local_ips', return_value=['127.0.0.2']) as ips:
            self.assertEqual(self.request('/api/ip/refresh', server=self.ip_http)[0], 200)
            ips.assert_called_once_with(force_refresh=True)

    def test_preflight_allows_only_existing_origins_and_fixed_marker_without_side_effect(self):
        headers = {'Access-Control-Request-Method': 'GET',
                   'Access-Control-Request-Headers': LOCAL_DEVELOPMENT_HEADER.lower()}
        status, response_headers, _ = self.request(method='OPTIONS', headers=headers)
        self.assertEqual(status, 204)
        self.assertIn(LOCAL_DEVELOPMENT_HEADER.lower(), response_headers['Access-Control-Allow-Headers'].lower())
        self.assertEqual(response_headers['Access-Control-Allow-Origin'], 'https://localhost:8080')
        self.assertEqual(self.request(method='OPTIONS', headers={**headers, 'Origin': 'https://evil.example'})[0], 403)

    def test_direct_peer_local_address_and_real_tls_are_required(self):
        headers = Message()
        headers['Host'] = '127.0.0.1:8802'
        headers[LOCAL_DEVELOPMENT_HEADER] = '1'
        context = HttpAccessMixin()
        context.server = SimpleNamespace(access_policy=self.policy)
        context.headers = headers
        context.connection = Mock(spec=ssl.SSLSocket)
        context.connection.getpeername.return_value = ('127.0.0.1', 55555)
        context.connection.getsockname.return_value = ('127.0.0.1', 8802)
        self.assertTrue(context._local_development_allowed())
        for peer, local in (('192.0.2.2', '127.0.0.1'), ('127.0.0.1', '192.0.2.1'),
                            ('127.0.0.1', '0.0.0.0')):
            context.connection.getpeername.return_value = (peer, 55555)
            context.connection.getsockname.return_value = (local, 8802)
            self.assertFalse(context._local_development_allowed())
        context.connection = Mock()
        self.assertFalse(context._local_development_allowed())

    def test_plain_http_cannot_gain_local_authority(self):
        server = self.bridge.ThreadingHTTPServer(('127.0.0.1', 0), self.bridge.DatyAPIHandler)
        server.access_policy = self.policy
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
        try:
            connection.request('POST', '/api/command', body=b'{}', headers={
                LOCAL_DEVELOPMENT_HEADER: '1', 'Content-Type': 'application/json'})
            response = connection.getresponse()
            self.assertEqual(response.status, 401, response.read())
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            worker.join(3)

    def test_control_target_brand_and_actual_ack_checks_remain_enforced(self):
        for command, value, actual in (('mute', None, {'muted': True}),
                                       ('set_freq', 642.25, {'freq': 642250})):
            body = {'command': command, 'device_id': self.did, 'channel_number': 1,
                    'expected_brand': 'DATYaudio'}
            if value is not None:
                body['value'] = value
            with patch.object(self.bridge, '_broker_publish_command', return_value=1) as publish:
                status, _, result = self.command(body=body)
            self.assertEqual(status, 200, result)
            self.assertEqual(publish.call_count, 1)
            self.assertEqual(publish.call_args.args[1], [self.did])
            command_id = result['command_id']
            record = self.bridge._state['commands'][command_id]
            self.assertEqual(record['status'], 'published')
            self.assertEqual(record['actor'], LOCAL_DEVELOPMENT_PRINCIPAL)
            self.assertEqual(self.bridge._reconcile_commands_for_device(self.did, actual, 'wrong-id'), [])
            self.assertEqual(self.bridge._reconcile_commands_for_device('isolated-local-receiver_ch2', actual, command_id), [])
            wrong = {'muted': False} if command == 'mute' else {'freq': 641000}
            self.assertEqual(self.bridge._reconcile_commands_for_device(self.did, wrong, command_id), [])
            acknowledged = self.bridge._reconcile_commands_for_device(self.did, actual, command_id)
            self.assertEqual(len(acknowledged), 1)
            self.assertEqual(acknowledged[0]['status'], 'acknowledged')
            self.assertNotIn(TOKEN, json.dumps(publish.call_args.args[0]))
            self.assertNotIn(LOCAL_DEVELOPMENT_HEADER, json.dumps(publish.call_args.args[0]))
        with patch.object(self.bridge, '_publish_tracked_command') as publish:
            self.assertEqual(self.command(body={'command': 'set_freq', 'device_id': self.did,
                'channel_number': 1, 'expected_brand': 'Shure', 'value': 642.25})[0], 409)
            publish.assert_not_called()

    def test_cli_toggle_is_explicit_preserves_keys_and_creates_no_secret(self):
        before = json.loads(self.registry.read_text(encoding='utf-8'))['keys']
        for flag, enabled in (('--disable', False), ('--enable', True)):
            result = subprocess.run([sys.executable, '-B', str(PROJECT / 'manage-access.py'),
                '--registry', str(self.registry), 'local-development', flag],
                capture_output=True, encoding='utf-8', errors='replace', timeout=30,
                env=dict(os.environ, PYTHONIOENCODING='utf-8'),
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(self.registry.read_text(encoding='utf-8'))
            self.assertIs(data['local_development_enabled'], enabled)
            self.assertEqual(data['keys'], before)
            self.assertNotIn(TOKEN, result.stdout + result.stderr)
            self.assertNotIn('token_sha256', result.stdout + result.stderr)
        self.assertEqual(list(self.registry.parent.glob('key-*.txt')), [])


if __name__ == '__main__':
    unittest.main()
