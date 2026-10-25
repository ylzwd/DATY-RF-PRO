"""Actual offline CLI JSON -> FAshe validator -> MQTT.js CONNECT -> broker policy.

Only temporary CA/credentials; browser WebSocket is fake; no device connection,
production registry, machine trust or running services are touched.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from receiver_pairing import MqttPacketBuffer, ReceiverPairingPolicy, parse_connect


class FasheCLIPairingContract(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'Node/browser test runtime required')
    def test_real_cli_bundle_and_actual_mqttjs_connect_authenticate(self):
        with tempfile.TemporaryDirectory(prefix='daty-cli-fashe-contract-') as directory:
            secure = Path(directory) / 'security'
            config, registry = secure / 'tls-config.json', secure / 'receiver-pairings.json'
            environment = dict(os.environ, PYTHONUTF8='1')
            commands = [
                [sys.executable, '-B', str(ROOT/'manage-tls.py'), '--config', str(config),
                    'init', '--host', 'localhost', '--host', '127.0.0.1'],
                [sys.executable, '-B', str(ROOT/'manage-pairings.py'), '--registry', str(registry),
                    '--tls-config', str(config), 'issue', '--name', 'isolated contract', '--mac', '02:00:00:00:00:51',
                    '--brand', 'DATYaudio', '--max-channels', '8', '--broker', 'wss://127.0.0.1:8083/mqtt', '--days', '1'],
            ]
            for command in commands:
                result = subprocess.run(command, capture_output=True, text=True, encoding='utf8', env=environment,
                    timeout=20, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                self.assertEqual(result.returncode, 0, 'Offline fixture CLI failed: ' + result.stderr)
            files = list(secure.glob('pairing-rx_*.json'))
            self.assertEqual(len(files), 1)
            document = json.loads(files[0].read_text(encoding='utf8'))
            self.assertIn('ca_sha256', document)
            self.assertNotIn('ca_fingerprint_sha256', document)
            self.assertIsInstance(document['expires_at'], (int, float))
            node = shutil.which('node')
            environment['NODE_PATH'] = str(Path(node).resolve().parent.parent/'node_modules')
            result = subprocess.run([node, str(ROOT.parent/'FAshe/tests/pairing-cli-client.cjs'), str(files[0])],
                capture_output=True, env=environment, timeout=25,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.assertEqual(result.returncode, 0, 'Actual browser MQTT.js encoding failed (details hidden)')
            wire = base64.b64decode(result.stdout, validate=True)
            packets = MqttPacketBuffer().feed(wire)
            self.assertEqual(len(packets), 1)
            client_id, username, password, keepalive = parse_connect(packets[0])
            principal = ReceiverPairingPolicy(registry).authenticate(username, password, client_id, '127.0.0.1')
            self.assertEqual(principal['receiver_mac'], '02:00:00:00:00:51')
            self.assertEqual(principal['brand'], 'DATYaudio')
            self.assertEqual(principal['max_channels'], 8)
            self.assertEqual(keepalive, 30)
            self.assertEqual(username, document['credential_id'])


if __name__ == '__main__':
    unittest.main()
