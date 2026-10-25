"""Real loopback TLS tests; temporary CA only, never OS trust or live ports."""
import functools
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
import tls_support as tls


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, PROJECT / filename)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


manager = module('daty_tls_manager_test', 'manage-tls.py')
web = module('daty_tls_web_test', 'web-service.py')
ip = module('daty_tls_ip_test', 'ip-service.py')


class QuietHandler(web.DatyWebHandler):
    def log_message(self, *args):
        pass


class QuietServer(web.ExclusiveThreadingHTTPServer):
    def handle_error(self, *args):
        pass  # Expected failed TLS handshakes are asserted by each client.


class TLSTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-tls-tests-')
        cls.directory = Path(cls.temp.name) / 'security'
        cls.config = cls.directory / 'tls-config.json'
        cls.materials = manager.create_material(['localhost', '127.0.0.1'], days=5)
        cls.metadata = manager.install_material(cls.config, cls.materials)
        cls.root = Path(cls.temp.name) / 'public'
        cls.root.mkdir()
        for name in ('unirf-app.html', 'DATYlogo.png'):
            (cls.root / name).write_bytes(b'PUBLIC_FIXTURE')
        for name in ('mqtt-bridge.py', 'daty-rf.sqlite3', 'tls-config.json', 'root-ca-key.pem'):
            (cls.root / name).write_bytes(b'PRIVATE_FIXTURE')
        cls.http = tls.bind_https(QuietServer, ('127.0.0.1', 0),
            functools.partial(QuietHandler, directory=str(cls.root)), tls.server_context(cls.config))
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(3)
        cls.temp.cleanup()

    def request(self, path, method='GET', context=None):
        conn = http.client.HTTPSConnection('127.0.0.1', self.http.server_port, timeout=3,
                                           context=context or tls.client_context(self.config))
        try:
            conn.request(method, path)
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def test_trusted_tls_public_page_logo_and_health(self):
        for path in ('/', '/unirf-app.html', '/DATYlogo.png'):
            self.assertEqual(self.request(path), (200, b'PUBLIC_FIXTURE'))
        status, body = self.request('/health')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['transport_security'], 'tls-v1')

    def test_tls_keeps_get_and_head_private_assets_denied(self):
        for path in ('/mqtt-bridge.py', '/daty-rf.sqlite3', '/tls-config.json', '/root-ca-key.pem',
                     '/src/', '/%2e%2e/security/root-ca-key.pem', '/../security/tls-config.json'):
            for method in ('GET', 'HEAD'):
                with self.subTest(path=path, method=method):
                    status, body = self.request(path, method)
                    self.assertEqual(status, 404)
                    self.assertNotIn(b'PRIVATE_FIXTURE', body)

    def test_unknown_ca_rejected(self):
        with self.assertRaises(ssl.SSLCertVerificationError):
            self.request('/health', context=ssl.create_default_context())

    def test_hostname_mismatch_rejected(self):
        with socket.create_connection(('127.0.0.1', self.http.server_port), timeout=3) as raw:
            with self.assertRaises(ssl.SSLCertVerificationError):
                tls.client_context(self.config).wrap_socket(raw, server_hostname='wrong-host.invalid')

    def test_plaintext_cannot_receive_http_response(self):
        with socket.create_connection(('127.0.0.1', self.http.server_port), timeout=3) as raw:
            raw.sendall(b'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
            try:
                body = raw.recv(2048)
            except (ConnectionError, OSError):
                body = b''
            self.assertNotIn(b'HTTP/', body)
            self.assertNotIn(b'"status"', body)

    def test_silent_handshake_does_not_block_other_clients(self):
        with socket.create_connection(('127.0.0.1', self.http.server_port), timeout=3):
            self.assertEqual(self.request('/health')[0], 200)

    def test_minimum_tls_and_client_verification_contract(self):
        server = tls.server_context(self.config)
        client = tls.client_context(self.config)
        self.assertEqual(server.minimum_version, ssl.TLSVersion.TLSv1_2)
        self.assertEqual(client.minimum_version, ssl.TLSVersion.TLSv1_2)
        self.assertEqual(client.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(client.check_hostname)

    def test_missing_configuration_fails_before_any_web_or_ip_bind(self):
        missing = self.directory / 'missing-tls.json'
        with self.assertRaises(tls.TLSConfigurationError):
            tls.server_context(missing)
        with mock.patch.dict(os.environ, {'DATY_TLS_FILE': str(missing)}), \
                mock.patch.object(web, 'bind_https') as web_bind, \
                mock.patch.object(ip, 'bind_https') as ip_bind:
            self.assertEqual(web.run_server(port=0, root=str(self.root)), 2)
            self.assertEqual(ip.run_server(port=0), 2)
            web_bind.assert_not_called()
            ip_bind.assert_not_called()

    def test_expired_and_not_yet_valid_certificates_rejected(self):
        for now in (datetime.now(timezone.utc) + timedelta(days=6),
                    datetime.now(timezone.utc) - timedelta(days=1)):
            with self.subTest(now=now):
                with self.assertRaises(tls.TLSConfigurationError):
                    tls.validate_material(self.materials['server-cert.pem'], self.materials['server-key.pem'],
                                          self.materials['root-ca.pem'], now=now)

    def test_key_mismatch_and_bad_pem_rejected(self):
        with self.assertRaises(tls.TLSConfigurationError):
            tls.validate_material(self.materials['server-cert.pem'], self.materials['root-ca-key.pem'],
                                  self.materials['root-ca.pem'])
        with self.assertRaises(tls.TLSConfigurationError):
            tls.validate_material(b'bad', b'SECRET_SENTINEL', b'bad')

    def test_malformed_and_unsafe_config_paths_rejected(self):
        path = self.directory / 'invalid-tls.json'
        original = json.loads(self.config.read_text(encoding='utf-8'))
        for replacement in ({}, dict(original, version=True), dict(original, private_key_file='relative.pem'),
                            dict(original, ca_file=str(self.root / 'root-ca-key.pem'))):
            path.write_text(json.dumps(replacement), encoding='utf-8')
            with self.subTest(config=replacement):
                with self.assertRaises(tls.TLSConfigurationError):
                    tls.server_context(path)
        path.unlink()

    def test_existing_tls_materials_never_overwritten(self):
        before = {p.name: p.read_bytes() for p in self.directory.iterdir()}
        with self.assertRaises(ValueError):
            manager.install_material(self.config, self.materials)
        after = {p.name: p.read_bytes() for p in self.directory.iterdir()}
        self.assertEqual(before, after)

    def test_metadata_exposes_only_public_fingerprints_and_dates(self):
        self.assertEqual(set(self.metadata), {'transport_security', 'minimum_tls', 'certificate_sha256',
                         'ca_sha256', 'not_after', 'hosts'})
        self.assertEqual(set(self.metadata['hosts']), {'localhost', '127.0.0.1'})
        self.assertEqual(len(self.metadata['certificate_sha256']), 64)
        self.assertNotIn('PRIVATE', json.dumps(self.metadata))

    def test_ca_export_contains_no_private_key_and_never_overwrites(self):
        target = Path(self.temp.name) / 'public-root-ca.pem'
        command = [sys.executable, str(PROJECT / 'manage-tls.py'), '--config', str(self.config),
                   'export-ca', '--output', str(target)]
        first = subprocess.run(command, capture_output=True, timeout=15)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(target.read_bytes(), self.materials['root-ca.pem'])
        self.assertNotIn(b'PRIVATE KEY', first.stdout + target.read_bytes())
        second = subprocess.run(command, capture_output=True, timeout=15)
        self.assertNotEqual(second.returncode, 0)

    def test_ip_bridge_fetch_uses_https_with_ca_and_hostname_verification(self):
        fake = mock.MagicMock()
        fake.__enter__.return_value.read.return_value = b'{"clients":[]}'
        with mock.patch.dict(os.environ, {'DATY_TLS_FILE': str(self.config)}), \
                mock.patch('urllib.request.urlopen', return_value=fake) as request:
            self.assertEqual(ip._fetch_fashe_clients_from_bridge(), [])
            args, kwargs = request.call_args
            self.assertEqual(args[0].full_url, 'https://127.0.0.1:8802/api/stats')
            self.assertTrue(kwargs['context'].check_hostname)
            self.assertEqual(kwargs['context'].verify_mode, ssl.CERT_REQUIRED)

    def test_host_input_rejects_wildcards_urls_ports_and_empty(self):
        for host in ('', 'https://localhost', 'localhost:8080', '*.example.com', 'bad host', ' good'):
            with self.subTest(host=host):
                with self.assertRaises(ValueError):
                    manager.host_name(host)


if __name__ == '__main__':
    unittest.main(verbosity=2)
