"""Read-only deployment gate tests: temporary registries/CA and loopback only."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


verify = load('daty_secure_verify_test', 'verify-secure-services.py')
manager = load('daty_secure_tls_manager_test', 'manage-tls.py')
import tls_support


class DeploymentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-secure-deployment-tests-')
        cls.directory = Path(cls.temp.name) / 'security'
        cls.paths = {name: cls.directory / file for name, file in
            [('tls', 'tls-config.json'), ('access', 'access-control.json'), ('pairing', 'receiver-pairings.json')]}
        manager.install_material(cls.paths['tls'], manager.create_material(['localhost', '127.0.0.1'], 5))

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.operator = {'id': 'testoperator', 'name': 'fixture operator', 'role': 'operator',
            'token_sha256': '0' * 64, 'expires_at': time.time() + 3600, 'revoked': False}
        self.receiver = {'credential_id': 'rx_0123456789abcdef', 'name': 'fixture receiver',
            'receiver_mac': '02:00:00:00:00:01', 'receiver_id': 'FAshe-MAC-020000000001',
            'brand': 'DATYaudio', 'max_channels': 8, 'secret_sha256': '1' * 64,
            'expires_at': time.time() + 3600, 'revoked': False}
        self.write()

    def write(self):
        self.paths['access'].write_text(json.dumps({'version': 1, 'keys': [self.operator], 'allowed_origins': []}), encoding='utf8')
        self.paths['pairing'].write_text(json.dumps({'version': 1, 'receivers': [self.receiver]}), encoding='utf8')

    def test_complete_preflight_reads_only_and_never_exposes_registry_hashes(self):
        before = {name: path.read_bytes() for name, path in self.paths.items()}
        result = verify.preflight(self.paths)
        self.assertTrue(result['ready'])
        self.assertEqual(result['control_access'], 'daty-direct-control-v1')
        self.assertEqual(result['active_receiver_count'], 1)
        self.assertNotIn('token_sha256', json.dumps(result))
        self.assertNotIn('secret_sha256', json.dumps(result))
        self.assertEqual(before, {name: path.read_bytes() for name, path in self.paths.items()})

    def test_missing_or_invalid_old_access_registry_is_unused(self):
        for raw in (None, '{broken', '{"version":1,"keys":[]}'):
            if raw is None: self.paths['access'].unlink(missing_ok=True)
            else: self.paths['access'].write_text(raw, encoding='utf8')
            result=verify.preflight(self.paths)
            self.assertTrue(result['ready'])
            self.assertNotIn('access',result['paths'])
            self.assertNotIn('active_operator_count',result)

    def test_first_start_with_enabled_auto_needs_no_preissued_receiver_or_operator(self):
        data = dict(version=1,receivers=[],development_enrollment=dict(enabled=True,
            allowed_ips=['192.0.2.102'],max_channels=128,max_receivers=64,broker_url='wss://127.0.0.1:8083/mqtt'))
        self.paths['pairing'].write_text(json.dumps(data),encoding='utf8')
        result = verify.preflight(self.paths)
        self.assertEqual(result['active_receiver_count'],0)
        self.assertTrue(result['auto_pairing_enabled'])
        self.assertTrue(verify.verify_running(self.paths,request_json=self.fixture_json([],{
            'pairing_configured':False,'auto_pairing_enabled':True,'auto_pairing':'daty-auto-pair-v1'}),
            handshake=lambda *args:True)['running_verified'])
        self.paths['access'].write_text(json.dumps(dict(version=1,keys=[],allowed_origins=[])))
        self.assertTrue(verify.preflight(self.paths)['ready'])

    def test_expired_revoked_or_invalid_pairing_blocks(self):
        for change in ({'expires_at': 1}, {'revoked': True}, {'receiver_mac': '00:00:00:00:00:00'}):
            with self.subTest(change=change):
                old = dict(self.receiver)
                self.receiver.update(change); self.write()
                with self.assertRaisesRegex(verify.VerificationError, '接收机配对'):
                    verify.preflight(self.paths)
                self.receiver = old

    def test_missing_tls_and_loopback_name_block_before_service_actions(self):
        with self.assertRaises(tls_support.TLSConfigurationError):
            verify.preflight({**self.paths, 'tls': self.directory / 'missing.json'})
        with mock.patch.object(verify, 'load_config', return_value=({}, {'hosts': ['192.0.2.16']})):
            with self.assertRaisesRegex(verify.VerificationError, '127.0.0.1'):
                verify.preflight(self.paths)

    def fixture_json(self, calls, override=None):
        def request(host, port, route, context):
            self.assertEqual(host, '127.0.0.1')
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            calls.append((port, route))
            result = {'transport_security': 'tls-v1', 'static_access_policy': 'public-assets-v1',
                'control_access': 'daty-direct-control-v1', 'control_auth_required': False, 'mqtt_pairing': 'daty-pairing-v1', 'pairing_configured': True}
            result.update(override or {})
            return result
        return request

    def test_all_secure_markers_and_three_https_services_plus_wss_required(self):
        calls, upgrades = [], []
        result = verify.verify_running(self.paths, request_json=self.fixture_json(calls),
            handshake=lambda *args: upgrades.append(args) or True)
        self.assertTrue(result['running_verified'])
        self.assertEqual(len(calls), 3)
        self.assertEqual(upgrades[0][0:2], ('127.0.0.1', 8083))
        self.assertFalse(result['device_control_sent'])
        self.assertFalse(result['mqtt_connect_sent'])
        for wrong in ({'transport_security': 'plain'}, {'pairing_configured': False}, {'control_auth_required': True}):
            with self.assertRaises(verify.VerificationError):
                verify.verify_running(self.paths, request_json=self.fixture_json([], wrong), handshake=lambda *args: True)

    def test_bridge_only_does_not_require_or_probe_web_ip(self):
        calls = []
        result = verify.verify_running(self.paths, bridge_only=True, request_json=self.fixture_json(calls), handshake=lambda *args: True)
        self.assertEqual(calls, [(8802, '/health')])
        self.assertEqual(result['https_ports'], [8802])

    def test_json_diagnostics_identify_failed_route_status_and_never_echo_secrets(self):
        for status, payload, expected in (
            (404, b'{"secret":"body-secret"}', 'HTTP 404'),
            (200, b'x' * 65537, '64 KiB'),
            (200, b'[]', 'JSON 对象'),
            (200, b'body-secret', '有效 JSON'),
        ):
            with self.subTest(status=status, expected=expected), \
                 mock.patch.object(verify.http.client, 'HTTPSConnection') as constructor:
                connection = constructor.return_value
                response = connection.getresponse.return_value
                response.status = status
                response.read.return_value = payload
                with self.assertRaises(verify.VerificationError) as caught:
                    verify.get_json('127.0.0.1', 8765, '/api/auth/status?token=query-secret', object())
                message = str(caught.exception)
                self.assertIn('HTTPS 8765 /api/auth/status', message)
                self.assertIn(expected, message)
                self.assertNotIn('secret', message)
                response.read.assert_called_once_with(65537)
                connection.close.assert_called_once()

    def test_real_wss_upgrade_uses_verified_ca_and_sends_only_close(self):
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0)); listener.listen(1); listener.settimeout(3)
        received = []
        errors = []
        def server():
            try:
                with listener:
                    raw, _ = listener.accept()
                    with raw, tls_support.server_context(self.paths['tls']).wrap_socket(raw, server_side=True) as secure:
                        data = b''
                        while b'\r\n\r\n' not in data:
                            data += secure.recv(2048)
                        received.append(data)
                        key = next(line.split(b':', 1)[1].strip() for line in data.split(b'\r\n') if line.startswith(b'Sec-WebSocket-Key:'))
                        accept = base64.b64encode(hashlib.sha1(key + b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
                        secure.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: mqtt\r\nSec-WebSocket-Accept: ' + accept + b'\r\n\r\n')
                        received.append(secure.recv(32))
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=server, daemon=True)
        port = listener.getsockname()[1]; thread.start()
        self.assertTrue(verify.wss_handshake('127.0.0.1', port, tls_support.client_context(self.paths['tls'])))
        thread.join(4)
        self.assertFalse(thread.is_alive()); self.assertEqual(errors, [])
        self.assertNotIn(b'Authorization', received[0])
        self.assertNotIn(b'daty_rx_', b''.join(received))
        self.assertEqual(received[1][:2], b'\x88\x80')

    def test_maintenance_source_keeps_preflight_before_stop_and_no_auto_issuance(self):
        script = (ROOT / 'restart-access-services.ps1').read_text(encoding='utf-8-sig')
        self.assertLess(script.index('$preflightText ='), script.index('Stop-ScheduledTask'))
        self.assertLess(script.index('if ($CheckOnly)'), script.index('Stop-ScheduledTask'))
        self.assertIn('CreationDate -eq $current.CreationDate', script)
        self.assertNotIn('Invoke-RestMethod', script)
        self.assertNotIn('$accessManager issue', script)
        self.assertIn('@(\'Process\',\'User\',\'Machine\')', script)
        self.assertIn('--verify-running', script)
        self.assertIn('[switch]$IpOnly', script)
        self.assertIn('if ($BridgeOnly -and $IpOnly)', script)
        self.assertIn("if ($IpOnly) { $accessServices = @($accessServices | Where-Object {$_.File -eq 'ip-service.py'}) }", script)
        self.assertIn('$accessPython = $accessServices[0].Python', script)

    def test_registration_and_launchers_use_same_gate_and_never_plain_http_firewall_or_pip(self):
        registration = (ROOT / 'register-daty-tasks.ps1').read_text(encoding='utf-8-sig')
        self.assertLess(registration.index('$preflightText ='), registration.index('Stop-ScheduledTask'))
        self.assertLess(registration.index('$preflightText ='), registration.index('Register-ScheduledTask -TaskName'))
        self.assertIn('$current.CreationDate -ne $entry.Process.CreationDate', registration)
        self.assertNotIn('Invoke-RestMethod', registration)
        self.assertNotIn('Register-ScheduledTask -TaskName $service.Name -InputObject $task -Force', registration)
        bridge = (ROOT / 'restart-bridge.ps1').read_text(encoding='utf-8-sig')
        self.assertIn('& $restartScript -BridgeOnly', bridge)
        launcher = (ROOT / '启动应用.bat').read_text(encoding='utf8')
        self.assertIn('-StartOnly', launcher)
        self.assertIn('https://localhost:8080/unirf-app.html', launcher)
        self.assertNotIn('netsh', launcher)
        self.assertNotIn('pip install', launcher)
        self.assertNotIn('http://', launcher)
        self.assertNotIn('Bypass', launcher)

    @unittest.skipUnless(shutil.which('powershell'), 'Windows PowerShell required')
    def test_powershell_exact_target_matchers_reject_other_project_or_extra_flags(self):
        # Extract only pure match functions. Never evaluate script main bodies or call task APIs.
        command = r'''
$sourceFile = '__ROOT__\register-daty-tasks.ps1'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($sourceFile,[ref]$tokens,[ref]$errors)
if ($errors.Count) {throw 'parse failed'}
$functions=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)
foreach ($function in $functions) {Invoke-Expression $function.Extent.Text}
$expected='-u "E:\fixture project\mqtt-bridge.py"'
$service=@{Arguments=$expected}
$valid=[pscustomobject]@{ExecutablePath='C:\Python\python.exe';CommandLine='"C:\Python\python.exe" '+$expected}
$foreign=[pscustomobject]@{ExecutablePath='C:\Python\python.exe';CommandLine='"C:\Python\python.exe" -u "D:\other\mqtt-bridge.py"'}
$extra=[pscustomobject]@{ExecutablePath='C:\Python\python.exe';CommandLine='"C:\Python\python.exe" '+$expected+' --extra'}
$nonpython=[pscustomobject]@{ExecutablePath='C:\Python\evil.exe';CommandLine='"C:\Python\evil.exe" '+$expected}
$results=@((Match-RegistrationProcess $valid $service),(Match-RegistrationProcess $foreign $service),(Match-RegistrationProcess $extra $service),(Match-RegistrationProcess $nonpython $service))
$results | ConvertTo-Json -Compress
'''.replace('__ROOT__', str(ROOT).replace("'", "''"))
        encoded = base64.b64encode(command.encode('utf-16le')).decode('ascii')
        completed = subprocess.run([shutil.which('powershell'), '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout), [True, False, False, False])


if __name__ == '__main__':
    unittest.main()
