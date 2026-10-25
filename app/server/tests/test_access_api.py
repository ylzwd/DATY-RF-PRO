"""P0 access regression: ephemeral HTTP port, temporary SQLite, mocked hardware.

No request is sent to a running project service or physical receiver. Credentials
are fixed public test values written only below TemporaryDirectory.
"""
import importlib.util
import http.client
import json
import os
from pathlib import Path
import threading
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from access_test_support import TEST_TOKEN, make_test_policy


class AccessApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-access-api-')
        source = Path(__file__).resolve().parents[1] / 'mqtt-bridge.py'
        spec = importlib.util.spec_from_file_location('daty_access_api_test', source)
        cls.b = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {
            'DATY_DB_PATH': str(Path(cls.temp.name) / 'isolated.sqlite3'),
            'DATY_ACCESS_FILE': str(Path(cls.temp.name) / 'never-production-access.json'),
        }):
            spec.loader.exec_module(cls.b)
        cls.b._log = lambda *args, **kwargs: None
        cls.http = cls.b.ThreadingHTTPServer(('127.0.0.1', 0), cls.b.DatyAPIHandler)
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()
        cls.base = f'http://127.0.0.1:{cls.http.server_port}'

    @classmethod
    def tearDownClass(cls):
        for event_queue in list(cls.b._state['sse_queues']):
            event_queue.put_nowait(None)
        cls.http.shutdown()
        cls.http.server_close()
        cls.worker.join(timeout=3)
        cls.b._close_database()
        cls.temp.cleanup()

    def setUp(self):
        self.http.access_policy = make_test_policy(self.b, self.temp.name)
        for name in ('devices', 'clients', 'receivers', 'receiver_aliases',
                     'source_epochs', 'receiver_epoch_fences', 'commands'):
            self.b._state[name].clear()
        self.b._state['sse_queues'].clear()
        self.b._broker_clients.clear()
        self.did = 'isolated-access-receiver_ch1'
        self.b._state['devices'][self.did] = {
            'id': self.did, 'brand': 'DATYaudio', 'channel_number': 1,
            '_receiver_id': 'isolated-access-receiver', 'receiver_ip': '127.0.0.2',
            '_source': 'isolated-access-receiver:mqtt:session',
            'control_protocol': 'fashe-realtime-v1', 'freq': 641000, 'muted': False,
        }

    def request(self, endpoint='/api/command', *, method='POST', body=None,
                token=None, origin=None, headers=None):
        if body is None and method == 'POST':
            body = {'command': 'mute', 'device_id': self.did, 'channel_number': 1}
        request_headers = {'Content-Type': 'application/json', **(headers or {})}
        if token is not None:
            request_headers['Authorization'] = 'Bearer ' + token
        if origin is not None:
            request_headers['Origin'] = origin
        encoded = body if isinstance(body, bytes) else (
            json.dumps(body).encode() if body is not None else None)
        request = Request(self.base + endpoint, data=encoded,
                          headers=request_headers, method=method)
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as failure:
            response = failure
        with response:
            content = response.read()
            return response.status, dict(response.headers), json.loads(content) if content else {}

    def database_counts(self):
        with self.b._db_session() as db:
            return {table: db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
                    for table in ('projects', 'project_devices', 'coordination_runs',
                                  'commands', 'timeline_events')}

    def test_missing_token_is_rejected_before_command_record_or_publication(self):
        before = self.database_counts()
        with patch.object(self.b, '_broker_publish_command') as publish:
            status, headers, body = self.request()
            self.assertEqual(status, 401, body)
            self.assertFalse(body['success'])
            self.assertIn('Bearer', headers.get('WWW-Authenticate', ''))
            publish.assert_not_called()
        self.assertEqual(self.b._state['commands'], {})
        self.assertEqual(self.database_counts(), before)

    def test_invalid_token_and_non_bearer_headers_cannot_control(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            for token in ('wrong', '', TEST_TOKEN[:-1] + 'B'):
                with self.subTest(token_case=len(token)):
                    self.assertEqual(self.request(token=token)[0], 401)
            for value in ('Basic Zm9vOmJhcg==', TEST_TOKEN, 'Bearer'):
                self.assertEqual(self.request(headers={'Authorization': value})[0], 401)
            publish.assert_not_called()

    def test_viewer_can_read_but_cannot_write_any_route(self):
        self.http.access_policy = make_test_policy(self.b, self.temp.name, role='viewer')
        self.assertEqual(self.request('/api/devices', method='GET', token=TEST_TOKEN)[0], 200)
        before = self.database_counts()
        with patch.object(self.b, '_publish_tracked_command') as publish:
            for endpoint in ('/api/command', '/api/projects',
                             '/api/coordination-runs', '/api/timeline/events'):
                with self.subTest(endpoint=endpoint):
                    self.assertEqual(self.request(endpoint, token=TEST_TOKEN)[0], 403)
            publish.assert_not_called()
        self.assertEqual(self.database_counts(), before)

    def test_expired_and_revoked_credentials_fail_closed(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            for options in ({'expired': True}, {'revoked': True}):
                self.http.access_policy = make_test_policy(self.b, self.temp.name, **options)
                status, _, body = self.request(token=TEST_TOKEN)
                self.assertEqual(status, 401, body)
            publish.assert_not_called()

    def test_missing_and_corrupt_policy_fail_closed(self):
        absent = Path(self.temp.name) / 'intentionally-absent-policy.json'
        corrupt = Path(self.temp.name) / 'intentionally-corrupt-policy.json'
        corrupt.write_text('{not valid json', encoding='utf-8')
        with patch.object(self.b, '_publish_tracked_command') as publish:
            for path in (absent, corrupt):
                self.http.access_policy = type(self.b._access_policy)(path)
                status, _, body = self.request(token=TEST_TOKEN)
                self.assertEqual(status, 503, body)
            publish.assert_not_called()

    def test_all_write_routes_reject_anonymous_before_database_mutation(self):
        before = self.database_counts()
        bodies = {
            '/api/projects': {'id': 'unauthorized-project', 'name': 'MUST NOT EXIST'},
            '/api/coordination-runs': {'project_id': 'default', 'input': {}, 'result': {}},
            '/api/timeline/events': {'event_type': 'unauthorized.event', 'summary': 'MUST NOT EXIST'},
        }
        for endpoint, body in bodies.items():
            with self.subTest(endpoint=endpoint):
                self.assertEqual(self.request(endpoint, body=body)[0], 401)
        self.assertEqual(self.database_counts(), before)

    def test_authorization_precedes_json_parsing(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            self.assertEqual(self.request(body=b'{malformed json')[0], 401)
            publish.assert_not_called()

    def test_token_in_query_or_json_body_is_not_accepted(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            self.assertEqual(self.request('/api/command?token=' + TEST_TOKEN)[0], 401)
            self.assertEqual(self.request(body={
                'command': 'mute', 'device_id': self.did, 'token': TEST_TOKEN,
                'authorization': 'Bearer ' + TEST_TOKEN,
            })[0], 401)
            publish.assert_not_called()

    def test_native_authorized_request_targets_one_channel_and_waits_for_matching_ack(self):
        with patch.object(self.b, '_broker_publish_command', return_value=1) as publish:
            status, _, body = self.request(token=TEST_TOKEN)
        self.assertEqual(status, 200, body)
        self.assertEqual(publish.call_count, 1)
        self.assertEqual(publish.call_args.args[1], [self.did])
        self.assertEqual(publish.call_args.args[0]['channel_number'], 1)
        command_id = body['command_id']
        record = self.b._state['commands'][command_id]
        self.assertEqual(record['status'], 'published')
        self.assertEqual(self.b._reconcile_commands_for_device(
            self.did, {'muted': False}, command_id), [])
        self.assertEqual(self.b._reconcile_commands_for_device(
            self.did, {'muted': True}, 'wrong-command-id'), [])
        ack = self.b._reconcile_commands_for_device(self.did, {'muted': True}, command_id)
        self.assertEqual(len(ack), 1)
        self.assertEqual(ack[0]['status'], 'acknowledged')
        status, _, polled = self.request('/api/commands/' + command_id, method='GET')
        self.assertEqual(status, 200, polled)
        self.assertEqual(polled['command']['status'], 'acknowledged')

    def test_authenticated_request_still_enforces_brand_binding(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            status, _, body = self.request(token=TEST_TOKEN, body={
                'command': 'set_freq', 'device_id': self.did,
                'channel_number': 1, 'expected_brand': 'Shure', 'value': 642.25,
            })
            self.assertEqual(status, 409, body)
            publish.assert_not_called()

    def test_allowed_browser_origin_gets_explicit_cors_and_can_control(self):
        for origin in ('https://localhost:8080', 'https://127.0.0.1:8080'):
            with self.subTest(origin=origin), \
                 patch.object(self.b, '_broker_publish_command', return_value=1):
                status, headers, body = self.request(token=TEST_TOKEN, origin=origin)
                self.assertEqual(status, 200, body)
                self.assertEqual(headers.get('Access-Control-Allow-Origin'), origin)
                self.assertNotEqual(headers.get('Access-Control-Allow-Origin'), '*')

    def test_hostile_null_and_prefix_origins_cannot_control_even_with_valid_token(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            for origin in ('http://evil.example', 'null', 'https://localhost:8080.evil.example',
                           'http://localhost:9999', 'http://127.0.0.1:8080@evil.example'):
                with self.subTest(origin=origin):
                    status, headers, body = self.request(token=TEST_TOKEN, origin=origin)
                    self.assertEqual(status, 403, body)
                    self.assertNotIn('Access-Control-Allow-Origin', headers)
            publish.assert_not_called()

    def test_configured_origin_is_exact_and_not_derived_from_host_header(self):
        self.http.access_policy = make_test_policy(
            self.b, self.temp.name, origins=['https://control.example:8080'])
        with patch.object(self.b, '_broker_publish_command', return_value=1):
            self.assertEqual(self.request(token=TEST_TOKEN, origin='https://control.example:8080')[0], 200)
            self.assertEqual(self.request(token=TEST_TOKEN, origin='https://control.example:8081')[0], 403)
            self.assertEqual(self.request(token=TEST_TOKEN, origin='https://spoofed.example:8080',
                                         headers={'Host': 'spoofed.example:8802'})[0], 403)

    def test_preflight_allows_authorization_without_wildcard_or_control_side_effect(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            status, headers, _ = self.request(method='OPTIONS', origin='https://localhost:8080',
                headers={'Access-Control-Request-Method': 'POST',
                         'Access-Control-Request-Headers': 'authorization,content-type'})
            self.assertEqual(status, 204)
            self.assertEqual(headers.get('Access-Control-Allow-Origin'), 'https://localhost:8080')
            self.assertIn('authorization', headers.get('Access-Control-Allow-Headers', '').lower())
            self.assertEqual(self.request(method='OPTIONS', origin='http://evil.example')[0], 403)
            publish.assert_not_called()

    def test_read_health_auth_status_and_sse_stay_public_but_origin_gated(self):
        for path in ('/health', '/api/devices', '/api/auth/status'):
            with self.subTest(path=path):
                status, _, body = self.request(path, method='GET')
                self.assertEqual(status, 200, body)
                self.assertNotIn(TEST_TOKEN, json.dumps(body))
        self.assertEqual(self.request('/api/updates', method='GET', origin='http://evil.example')[0], 403)
        request = Request(self.base + '/api/updates', headers={'Origin': 'https://localhost:8080'})
        with urlopen(request, timeout=3) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get('Access-Control-Allow-Origin'), 'https://localhost:8080')
            self.assertEqual(response.readline().strip(), b'event: device_list')
            self.assertTrue(response.readline().startswith(b'data: '))
        for event_queue in list(self.b._state['sse_queues']):
            event_queue.put_nowait(None)

    def test_bearer_never_reaches_receiver_payload_response_or_log(self):
        with patch.object(self.b, '_log') as log, \
             patch.object(self.b, '_broker_publish_command', return_value=1) as publish:
            status, headers, body = self.request(token=TEST_TOKEN)
            self.assertEqual(status, 200, body)
            serialized = json.dumps({'headers': headers, 'response': body,
                                     'payload': publish.call_args.args[0]}, default=str)
            self.assertNotIn(TEST_TOKEN, serialized)
            self.assertNotIn(TEST_TOKEN, str(log.call_args_list))

    def test_rejected_query_credential_is_not_written_to_http_log(self):
        with patch.object(self.b, '_log') as log:
            self.assertEqual(self.request('/api/command?token=' + TEST_TOKEN)[0], 401)
            self.assertNotIn(TEST_TOKEN, str(log.call_args_list))

    def test_duplicate_authorization_and_origin_headers_are_rejected(self):
        for duplicate, expected_status in (('Authorization', 401), ('Origin', 403)):
            with self.subTest(header=duplicate), \
                 patch.object(self.b, '_publish_tracked_command') as publish:
                connection = http.client.HTTPConnection('127.0.0.1', self.http.server_port, timeout=3)
                try:
                    connection.putrequest('POST', '/api/command')
                    connection.putheader('Content-Type', 'application/json')
                    connection.putheader('Content-Length', '2')
                    connection.putheader('Authorization', 'Bearer ' + TEST_TOKEN)
                    connection.putheader('Origin', 'https://localhost:8080')
                    connection.putheader(duplicate, 'Bearer ' + TEST_TOKEN if duplicate == 'Authorization'
                                         else 'https://localhost:8080')
                    connection.endheaders(b'{}')
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected_status, response.read())
                    publish.assert_not_called()
                finally:
                    connection.close()

    def test_authorized_body_must_be_bounded_json_object(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            for body in (b'[]', b'null', b'false', b'{broken'):
                self.assertEqual(self.request(token=TEST_TOKEN, body=body)[0], 400)
            self.assertEqual(self.request(token=TEST_TOKEN, body=b'{}',
                                         headers={'Content-Type': 'text/plain'})[0], 415)
            self.assertEqual(self.request(token=TEST_TOKEN, body=b'{}',
                                         headers={'Content-Length': str(4 * 1024 * 1024 + 1)})[0], 413)
            publish.assert_not_called()

    def test_policy_cache_observes_revocation_without_service_restart(self):
        policy = self.http.access_policy
        with patch.object(self.b, '_broker_publish_command', return_value=1) as publish:
            self.assertEqual(self.request(token=TEST_TOKEN)[0], 200)
            path = Path(self.temp.name) / 'isolated-access.json'
            config = json.loads(path.read_text(encoding='utf-8'))
            config['keys'][0]['revoked'] = True
            path.write_text(json.dumps(config), encoding='utf-8')
            self.assertIs(self.http.access_policy, policy)
            self.assertEqual(self.request(token=TEST_TOKEN)[0], 401)
            self.assertEqual(publish.call_count, 1)

    def test_malformed_registry_never_grants_control(self):
        path = Path(self.temp.name) / 'isolated-access.json'
        original = json.loads(path.read_text(encoding='utf-8'))
        variants = []
        for expiry in (float('nan'), float('inf'), -1, True, '9999999999'):
            invalid = json.loads(json.dumps(original))
            invalid['keys'][0]['expires_at'] = expiry
            variants.append(invalid)
        invalid = json.loads(json.dumps(original))
        invalid['keys'].append(dict(invalid['keys'][0]))
        variants.append(invalid)
        invalid = json.loads(json.dumps(original))
        invalid['keys'][0]['role'] = 'unrecognized-superuser'
        variants.append(invalid)
        with patch.object(self.b, '_publish_tracked_command') as publish:
            for index, config in enumerate(variants):
                with self.subTest(case=index):
                    path.write_text(json.dumps(config), encoding='utf-8')
                    self.assertEqual(self.request(token=TEST_TOKEN)[0], 503)
                    status, _, public = self.request('/api/auth/status', method='GET')
                    self.assertEqual(status, 200, public)
                    self.assertFalse(public['auth']['configured'])
                    self.assertFalse(public['auth']['authenticated'])
            publish.assert_not_called()

    def test_auth_status_contract_exposes_identity_permissions_but_not_credentials(self):
        status, _, public = self.request('/api/auth/status', method='GET')
        self.assertEqual(status, 200)
        self.assertEqual(public['auth']['protocol'], 'daty-access-v1')
        self.assertTrue(public['auth']['configured'])
        self.assertFalse(public['auth']['authenticated'])
        self.assertEqual(public['auth']['permissions'], [])
        status, _, authorized = self.request('/api/auth/status', method='GET', token=TEST_TOKEN)
        self.assertEqual(status, 200)
        auth = authorized['auth']
        self.assertTrue(auth['authenticated'])
        self.assertEqual(auth['principal']['role'], 'operator')
        self.assertEqual(auth['principal']['id'], '0123456789abcdef')
        self.assertEqual(set(auth['permissions']), {
            'device.control', 'project.write', 'timeline.write', 'discovery.scan'})
        self.assertNotIn('token_sha256', json.dumps(authorized))
        self.assertNotIn(TEST_TOKEN, json.dumps(authorized))

    def test_harness_database_and_access_registry_are_both_temporary(self):
        temporary_root = Path(self.temp.name).resolve()
        self.assertTrue(Path(self.b._db_path).resolve().is_relative_to(temporary_root))
        self.assertTrue(self.http.access_policy.path.resolve().is_relative_to(temporary_root))


class AccessDiscoveryApiTests(unittest.TestCase):
    """Authentication also gates the discovery service's legacy GET mutations."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-access-discovery-')
        source = Path(__file__).resolve().parents[1] / 'ip-service.py'
        spec = importlib.util.spec_from_file_location('daty_access_discovery_test', source)
        cls.service = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.service)
        cls.http = cls.service.ThreadingHTTPServer(('127.0.0.1', 0), cls.service.DatyServiceHandler)
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.worker.join(timeout=3)
        cls.temp.cleanup()

    def setUp(self):
        self.http.access_policy = make_test_policy(self.service, self.temp.name)

    def get(self, path, *, token=None, origin=None):
        headers = {}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if origin:
            headers['Origin'] = origin
        request = Request(f'http://127.0.0.1:{self.http.server_port}' + path, headers=headers)
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as failure:
            response = failure
        with response:
            return response.status, json.load(response)

    def test_anonymous_scan_and_forced_ip_refresh_do_not_start_network_work(self):
        with patch.object(self.service, 'get_local_ips') as ips, \
             patch.object(self.service, '_background_scan') as scan:
            self.assertEqual(self.get('/api/discover?force=1')[0], 401)
            self.assertEqual(self.get('/api/ip/refresh')[0], 401)
            ips.assert_not_called()
            scan.assert_not_called()

    def test_viewer_and_hostile_origin_cannot_start_discovery(self):
        self.http.access_policy = make_test_policy(self.service, self.temp.name, role='viewer')
        with patch.object(self.service, 'get_local_ips') as ips:
            self.assertEqual(self.get('/api/discover?force=1', token=TEST_TOKEN)[0], 403)
            self.assertEqual(self.get('/api/ip/refresh', token=TEST_TOKEN)[0], 403)
            self.assertEqual(self.get('/api/discover/status', origin='http://evil.example')[0], 403)
            ips.assert_not_called()

    def test_authorized_native_refresh_and_public_cached_status_remain_available(self):
        with patch.object(self.service, 'get_local_ips', return_value=['127.0.0.2']) as ips:
            self.assertEqual(self.get('/api/ip/refresh', token=TEST_TOKEN)[0], 200)
            ips.assert_called_once_with(force_refresh=True)
        self.assertEqual(self.get('/api/discover/status')[0], 200)
        self.assertEqual(self.get('/health')[0], 200)

    def test_discovery_auth_status_shares_bridge_contract_without_network_scan(self):
        with patch.object(self.service, 'get_local_ips') as ips, \
             patch.object(self.service, '_background_scan') as scan:
            status, public = self.get('/api/auth/status')
            self.assertEqual(status, 200)
            self.assertEqual(public['auth']['protocol'], 'daty-access-v1')
            self.assertTrue(public['auth']['configured'])
            self.assertFalse(public['auth']['authenticated'])
            self.assertEqual(public['auth']['permissions'], [])
            status, authorized = self.get('/api/auth/status', token=TEST_TOKEN,
                                          origin='https://localhost:8080')
            self.assertEqual(status, 200)
            self.assertTrue(authorized['auth']['authenticated'])
            self.assertIn('discovery.scan', authorized['auth']['permissions'])
            self.assertNotIn(TEST_TOKEN, json.dumps(authorized))
            self.assertNotIn('token_sha256', json.dumps(authorized))
            self.assertEqual(self.get('/api/auth/status', origin='https://evil.example')[0], 403)
            ips.assert_not_called()
            scan.assert_not_called()

    def test_discovery_auth_status_reports_unconfigured_policy_without_granting_access(self):
        absent = Path(self.temp.name) / 'missing-policy.json'
        self.http.access_policy = type(self.service._access_policy)(absent)
        status, public = self.get('/api/auth/status')
        self.assertEqual(status, 200)
        self.assertFalse(public['auth']['configured'])
        self.assertFalse(public['auth']['authenticated'])
        self.assertEqual(public['auth']['permissions'], [])


if __name__ == '__main__':
    unittest.main()
