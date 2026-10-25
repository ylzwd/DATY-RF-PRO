"""Offline pairing CLI tests; only temporary credentials, CA and file ACLs."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from receiver_pairing import ReceiverPairingPolicy, PairingError

spec = importlib.util.spec_from_file_location('pairing_admin_tls_fixture', ROOT / 'manage-tls.py')
tls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tls)


class PairingAdminTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.material = tls.create_material(['localhost', '127.0.0.1', '192.0.2.16'])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='daty-security-pairing-admin-')
        self.directory = Path(self.temp.name)
        self.registry = self.directory / 'receiver-pairings.json'
        self.config = self.directory / 'tls-config.json'
        tls.install_material(self.config, self.material)

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, *arguments):
        return subprocess.run([sys.executable, '-B', str(ROOT / 'manage-pairings.py'),
            '--registry', str(self.registry), '--tls-config', str(self.config), *arguments],
            capture_output=True, encoding='utf-8', errors='replace', timeout=30,
            env=dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1'),
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))

    def issue(self, **changes):
        options = {'name': 'isolated receiver', 'mac': '02:AA:BB:CC:DD:EE', 'brand': 'DATYaudio',
                   'max-channels': '8', 'broker': 'wss://192.0.2.16:8083/mqtt', 'days': '1'}
        options.update(changes)
        return self.cli('issue', *[part for key, value in options.items() for part in ('--' + key, value)])

    def document(self):
        paths = list(self.directory.glob('pairing-rx_*.json'))
        self.assertEqual(len(paths), 1)
        return json.loads(paths[0].read_text(encoding='utf-8'))

    def test_explicit_auto_allowlist_enable_disable_preserves_manual_pairing(self):
        self.assertEqual(self.issue().returncode, 0)
        original = self.document()
        args = ('enable-auto','--allow-ip','192.0.2.102','--allow-ip','192.0.2.103',
                '--broker','wss://192.0.2.16:8083/mqtt')
        result = self.cli(*args)
        self.assertEqual(result.returncode,0,result.stderr)
        listed = json.loads(self.cli('list').stdout)
        self.assertTrue(listed['development_enrollment']['enabled'])
        self.assertEqual(listed['development_enrollment']['allowed_ips'],['192.0.2.102','192.0.2.103'])
        self.assertNotIn(original['secret'],result.stdout)
        self.assertEqual(self.document(),original)
        self.assertEqual(self.cli('disable-auto').returncode,0)
        self.assertFalse(json.loads(self.cli('list').stdout)['development_enrollment']['enabled'])

    def test_auto_rejects_wildcard_network_and_wrong_certificate_host_without_writing(self):
        for peer,broker in [('192.0.2.0/24','wss://192.0.2.16:8083/mqtt'),
                            ('192.0.2.102','wss://wrong.invalid:8083/mqtt')]:
            result = self.cli('enable-auto','--allow-ip',peer,'--broker',broker)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse(self.registry.exists())

    def test_issue_protocol_matches_authentication_and_exports_no_secret_to_stdout(self):
        result = self.issue(**{'receiver-ip': '192.0.2.102'})
        self.assertEqual(result.returncode, 0, result.stderr)
        document = self.document()
        self.assertEqual(document['protocol'], 'daty-pairing-v1')
        self.assertEqual(document['receiver_id'], 'FAshe-MAC-02AABBCCDDEE')
        self.assertRegex(document['ca_sha256'], '^[0-9a-f]{64}$')
        self.assertRegex(document['secret'], '^daty_rx_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$')
        self.assertNotIn(document['secret'], result.stdout + result.stderr + self.registry.read_text())
        policy = ReceiverPairingPolicy(self.registry)
        principal = policy.authenticate(document['credential_id'], document['secret'],
            document['credential_id'] + '_session1', '192.0.2.102')
        self.assertEqual(principal['max_channels'], 8)
        with self.assertRaises(PairingError):
            policy.authenticate(document['credential_id'], document['secret'],
                document['credential_id'] + '_session1', '192.0.2.103')

    def test_list_redacts_secret_and_hash_revoke_invalidates_existing_principal(self):
        self.assertEqual(self.issue().returncode, 0)
        document = self.document()
        digest = json.loads(self.registry.read_text())['receivers'][0]['secret_sha256']
        policy = ReceiverPairingPolicy(self.registry)
        principal = policy.authenticate(document['credential_id'], document['secret'],
            document['credential_id'] + '_session1', '192.0.2.102')
        result = self.cli('list')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)['receivers']), 1)
        self.assertNotIn(document['secret'], result.stdout + result.stderr)
        self.assertNotIn(digest, result.stdout + result.stderr)
        result = self.cli('revoke', '--id', document['credential_id'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(policy.is_active(principal))
        self.assertFalse(policy.configured())
        self.assertEqual(self.document(), document)  # never silently delete delivery file

    def test_duplicate_mac_requires_explicit_revocation_then_new_unique_credential(self):
        self.assertEqual(self.issue().returncode, 0)
        first = self.document()
        original = self.registry.read_bytes()
        self.assertNotEqual(self.issue().returncode, 0)
        self.assertEqual(self.registry.read_bytes(), original)
        self.assertEqual(self.document(), first)
        self.assertEqual(self.cli('revoke', '--id', first['credential_id']).returncode, 0)
        self.assertEqual(self.issue().returncode, 0)
        records = json.loads(self.registry.read_text())['receivers']
        self.assertNotEqual(records[0]['credential_id'], records[1]['credential_id'])
        self.assertNotEqual(records[0]['secret_sha256'], records[1]['secret_sha256'])

    def test_invalid_identity_channel_and_expiry_never_issue(self):
        changes = [{'mac': '00:00:00:00:00:00'}, {'mac': 'FF:AA:BB:CC:DD:EE'},
                   {'brand': 'unknown'}, {'max-channels': '0'}, {'max-channels': '129'},
                   {'days': '0'}, {'days': '366'}, {'name': 'bad\nname'},
                   {'receiver-ip': '224.0.0.1'}]
        for change in changes:
            with self.subTest(change=change):
                self.assertNotEqual(self.issue(**change).returncode, 0)
                self.assertFalse(self.registry.exists())
                self.assertEqual(list(self.directory.glob('pairing-*.json')), [])

    def test_unknown_ca_host_and_unsafe_broker_never_issue(self):
        for broker in ('ws://192.0.2.16:8083/mqtt', 'wss://192.0.2.102:8083/mqtt',
                       'wss://192.0.2.16:8083/', 'wss://192.0.2.16:8084/mqtt',
                       'wss://192.0.2.16:8083/mqtt?token=x', 'wss://user@192.0.2.16:8083/mqtt'):
            with self.subTest(broker=broker):
                self.assertNotEqual(self.issue(broker=broker).returncode, 0)
                self.assertFalse(self.registry.exists())
        self.config.unlink()
        self.assertNotEqual(self.issue().returncode, 0)
        self.assertFalse(self.registry.exists())

    def test_corrupt_registry_and_unknown_revoke_are_not_overwritten(self):
        self.registry.write_bytes(b'{broken')
        self.assertNotEqual(self.issue().returncode, 0)
        self.assertEqual(self.registry.read_bytes(), b'{broken')
        self.assertEqual(list(self.directory.glob('pairing-*.json')), [])
        self.registry.unlink()
        self.assertNotEqual(self.cli('revoke', '--id', 'rx_0000000000000000').returncode, 0)
        self.assertFalse(self.registry.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
