"""Direct control: real temporary HTTPS, SQLite, mocked device publication.
All config, CA and pairings are isolated; no production service or control.
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

from pairing_test_support import PairingFixture, create_tls_fixture
from tls_support import bind_https, server_context, client_context
TEST_TOKEN = 'public-ignored-test-value'



class DirectApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-access-api-')
        cls.pairing = PairingFixture(cls.temp.name)
        cls.tls = create_tls_fixture(cls.temp.name)
        source = Path(__file__).resolve().parents[1] / 'mqtt-bridge.py'
        spec = importlib.util.spec_from_file_location('daty_access_api_test', source)
        cls.b = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {
            'DATY_DB_PATH': str(Path(cls.temp.name) / 'isolated.sqlite3'),
            'DATY_PAIRING_FILE': str(cls.pairing.path),
            'DATY_TLS_FILE': str(cls.tls),
        }):
            spec.loader.exec_module(cls.b)
        cls.b._log = lambda *args, **kwargs: None
        cls.http = bind_https(cls.b.ThreadingHTTPServer, ('127.0.0.1', 0), cls.b.DatyAPIHandler, server_context(cls.tls))
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()
        cls.base = f'https://127.0.0.1:{cls.http.server_port}'

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
            response = urlopen(request, timeout=3, context=client_context(self.tls))
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

    def test_native_direct_request_targets_one_channel_and_waits_for_matching_ack(self):
        with patch.object(self.b, '_broker_publish_command', return_value=1) as publish:
            status, _, body = self.request()
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


    def test_direct_request_still_enforces_brand_binding(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            status, _, body = self.request(body={
                'command': 'set_freq', 'device_id': self.did,
                'channel_number': 1, 'expected_brand': 'Shure', 'value': 642.25,
            })
            self.assertEqual(status, 409, body)
            publish.assert_not_called()


    def test_allowed_browser_origin_gets_explicit_cors_and_can_control(self):
        for origin in ('https://localhost:8080', 'https://127.0.0.1:8080'):
            with self.subTest(origin=origin), \
                 patch.object(self.b, '_broker_publish_command', return_value=1):
                status, headers, body = self.request(origin=origin)
                self.assertEqual(status, 200, body)
                self.assertEqual(headers.get('Access-Control-Allow-Origin'), origin)
                self.assertNotEqual(headers.get('Access-Control-Allow-Origin'), '*')


    def test_hostile_null_and_prefix_origins_cannot_control_without_credentials(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            for origin in ('http://evil.example', 'null', 'https://localhost:8080.evil.example',
                           'http://localhost:9999', 'http://127.0.0.1:8080@evil.example'):
                with self.subTest(origin=origin):
                    status, headers, body = self.request(origin=origin)
                    self.assertEqual(status, 403, body)
                    self.assertNotIn('Access-Control-Allow-Origin', headers)
            publish.assert_not_called()


    def test_request_body_must_be_bounded_json_object(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            for body in (b'[]', b'null', b'false', b'{broken'):
                self.assertEqual(self.request(body=body)[0], 400)
            self.assertEqual(self.request(body=b'{}',
                                         headers={'Content-Type': 'text/plain'})[0], 415)
            self.assertEqual(self.request(body=b'{}',
                                         headers={'Content-Length': str(4 * 1024 * 1024 + 1)})[0], 413)
            publish.assert_not_called()


    def test_removed_auth_endpoint_and_honest_health(self):
        self.assertEqual(self.request('/api/auth/status',method='GET')[0],404)
        status,_,health=self.request('/health',method='GET')
        self.assertEqual(status,200)
        self.assertEqual(health['control_access'],'daty-direct-control-v1')
        self.assertFalse(health['control_auth_required'])
        self.assertEqual(health['mqtt_pairing'],'daty-pairing-v1')
        self.assertNotIn('auth',health)
        self.assertTrue(Path(self.b._db_path).resolve().is_relative_to(Path(self.temp.name).resolve()))

    def test_preflight_has_no_auth_header_or_command_side_effect(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            status,headers,_=self.request(method='OPTIONS',origin='https://localhost:8080',headers={
                'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'})
            self.assertEqual(status,204)
            self.assertEqual(headers['Access-Control-Allow-Headers'],'Content-Type')
            self.assertEqual(self.request(method='OPTIONS',origin='https://localhost:8080',headers={
                'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization'})[0],403)
            publish.assert_not_called()

    def test_origin_cannot_be_whitelisted_by_host_or_forwarding_headers(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            self.assertEqual(self.request(origin='https://evil.example:8080',headers={
                'Host':'evil.example:8802','X-Forwarded-For':'127.0.0.1'})[0],403)
            publish.assert_not_called()

    def test_fetch_metadata_rejects_browser_navigation_and_cross_site_no_origin(self):
        with patch.object(self.b, '_publish_tracked_command') as publish:
            for headers in ({'Sec-Fetch-Mode':'navigate'},{'Sec-Fetch-Mode':'no-cors'},{'Sec-Fetch-Site':'cross-site'}):
                self.assertEqual(self.request(headers=headers)[0],403)
            publish.assert_not_called()

    def test_duplicate_origin_content_type_and_length_rejected_before_publish(self):
        for duplicate,value,expected in [('Origin','https://localhost:8080',403),('Content-Type','application/json',415),('Content-Length','2',400)]:
            connection=http.client.HTTPSConnection('127.0.0.1',self.http.server_port,context=client_context(self.tls),timeout=3)
            try:
                with patch.object(self.b, '_publish_tracked_command') as publish:
                    connection.putrequest('POST','/api/command')
                    for key,header in [('Origin','https://localhost:8080'),('Content-Type','application/json'),('Content-Length','2'),(duplicate,value)]:
                        connection.putheader(key,header)
                    connection.endheaders(b'{}');response=connection.getresponse()
                    self.assertEqual(response.status,expected,response.read());publish.assert_not_called()
            finally: connection.close()

    def test_network_actor_cannot_be_spoofed_or_forwarded_to_receiver(self):
        with patch.object(self.b,'_broker_publish_command',return_value=1) as publish:
            status,_,body=self.request(body={'command':'mute','device_id':self.did,'channel_number':1,
                'actor':{'id':'fake'},'_authorized_actor':{'id':'fake'},'_request_actor':{'id':'fake'},
                'authorization':'old-secret','token':'old-secret'},headers={'Authorization':'Bearer old-secret','X-Forwarded-For':'fake'})
            self.assertEqual(status,200,body)
            actor=self.b._state['commands'][body['command_id']]['actor']
            self.assertEqual(actor,{'kind':'network-peer','authenticated':False,'ip':'127.0.0.1'})
            payload=publish.call_args.args[0]
            for key in ('actor','_request_actor','_authorized_actor','authorization','token'):
                self.assertNotIn(key,payload)
            self.assertNotIn('old-secret',json.dumps(body))

class DirectDiscoveryApiTests(unittest.TestCase):
    """Direct discovery still enforces the browser request boundary."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-access-discovery-')
        cls.tls=create_tls_fixture(cls.temp.name)
        source = Path(__file__).resolve().parents[1] / 'ip-service.py'
        spec = importlib.util.spec_from_file_location('daty_access_discovery_test', source)
        cls.service = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.service)
        cls.http = bind_https(cls.service.ThreadingHTTPServer, ('127.0.0.1', 0), cls.service.DatyServiceHandler, server_context(cls.tls))
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.worker.join(timeout=3)
        cls.temp.cleanup()

    def get(self, path, *, token=None, origin=None, headers=None):
        headers = dict(headers or {})
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if origin:
            headers['Origin'] = origin
        request = Request(f'https://127.0.0.1:{self.http.server_port}' + path, headers=headers)
        try:
            response = urlopen(request, timeout=3, context=client_context(self.tls))
        except HTTPError as failure:
            response = failure
        with response:
            return response.status, json.load(response)

    def test_no_key_refresh_and_removed_status(self):
        with patch.object(self.service,'get_local_ips',return_value=['127.0.0.2']) as ips:
            self.assertEqual(self.get('/api/ip/refresh')[0],200)
            ips.assert_called_once_with(force_refresh=True)
        self.assertEqual(self.get('/api/auth/status')[0],404)
        self.assertFalse(self.get('/health')[1]['control_auth_required'])

    def test_direct_discovery_starts_only_stub_scan(self):
        called=threading.Event()
        with patch.object(self.service,'get_local_ips',return_value=['127.0.0.2']),patch.object(self.service,'_background_scan',side_effect=lambda *args:called.set()):
            self.assertEqual(self.get('/api/discover?force=1',origin='https://localhost:8080')[0],200)
            self.assertTrue(called.wait(1))

    def test_hostile_or_navigated_scan_cannot_start_network_work(self):
        with patch.object(self.service,'get_local_ips') as ips,patch.object(self.service,'_background_scan') as scan:
            for route in ('/api/discover?force=1','/api/ip/refresh'):
                self.assertEqual(self.get(route,origin='https://evil.example')[0],403)
                self.assertEqual(self.get(route,headers={'Sec-Fetch-Mode':'navigate'})[0],403)
                self.assertEqual(self.get(route,headers={'Sec-Fetch-Site':'cross-site'})[0],403)
            ips.assert_not_called();scan.assert_not_called()

if __name__=='__main__':unittest.main()
