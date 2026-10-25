"""Isolated repair decisions; no LAN, SystemAPI service or production writes."""
from pathlib import Path
import importlib.util, json, ssl, tempfile, unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('repair_tool', Path(__file__).with_name('project-shure-repair.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
TARGET = '192.0.2.104'


def device():
    return {'edges': [{'node': {'deviceState': 'ONLINE', 'communicationProtocol': {'address': TARGET},
        'softwareIdentity': {'model': 'ULXD4', 'firmwareVersion': '2.3.34.0', 'firmwareValid': True},
        'hardwareIdentity': {'deviceId': '12345678-1234-1234-1234-123456789012', 'serialNumber': '12345'}}}]}


class Api:
    def __init__(self, *, present=False, recover=True, lost_reply=False):
        self.present, self.recover, self.lost_reply = present, recover, lost_reply
        self.addresses = ['192.0.2.107']; self.adds = []
    def devices(self):
        return device() if self.present else {'edges': []}
    def targets(self):
        return list(self.addresses)
    def add(self, target):
        self.adds.append(target); self.addresses.append(target)
        self.present = self.recover
        if self.lost_reply:
            raise TimeoutError('accepted but reply lost')


class Repair(unittest.TestCase):
    def before(self):
        return {'runtime_readable': True, 'plugin': {'active': True},
                'automatic_discovery': {'enabled': True}, 'scan_networks': ['192.0.2.0/24'],
                'receiver': {'tcp2202': True, 'scpReply': True, 'firmware': '2.3.34.0', 'channels': 1},
                'systemapi': {'state': 'ready'}}
    def run_case(self, api, before=None, channels=1):
        clock = [0]
        return module.repair(before or self.before(), TARGET, api, lambda _: channels,
            timeout=6, now=lambda: clock[0], pause=lambda n: clock.__setitem__(0, clock[0]+n), log=lambda *a, **k: None)

    def test_additive_discovery_preserves_existing_and_requires_real_channel(self):
        api = Api(); result = self.run_case(api)
        self.assertEqual(result['state'], 'recovered')
        self.assertEqual(api.adds, [TARGET])
        self.assertEqual(api.addresses, ['192.0.2.107', TARGET])
        self.assertTrue(result['previous_addresses_still_present'])

    def test_acceptance_without_identity_is_never_success(self):
        result = self.run_case(Api(recover=False))
        self.assertTrue(result['discovery_add_accepted'])
        self.assertEqual(result['state'], 'identity_pending')

    def test_identity_without_daty_channel_stays_pending(self):
        result = self.run_case(Api(), channels=0)
        self.assertEqual(result['state'], 'server_pending')

    def test_lost_reply_queries_without_resending(self):
        api = Api(lost_reply=True); result = self.run_case(api)
        self.assertEqual(result['state'], 'recovered')
        self.assertEqual(len(api.adds), 1)
        self.assertFalse(result['discovery_add_accepted'])
        self.assertTrue(result['target_in_discovery_list'])

    def test_valid_identity_and_already_listed_target_do_not_write(self):
        ready = Api(present=True); self.assertEqual(self.run_case(ready)['state'], 'recovered')
        self.assertEqual(ready.adds, [])
        waiting = Api(); waiting.addresses.append(TARGET)
        self.assertEqual(self.run_case(waiting)['state'], 'identity_pending')
        self.assertEqual(waiting.adds, [])

    def test_missing_plugin_wrong_network_or_invalid_receiver_refuse_changes(self):
        for field, value in [('plugin', {'active': False}), ('scan_networks', ['10.222.222.0/24']),
                             ('receiver', {'tcp2202': True}), ('systemapi', {'state': 'unavailable'})]:
            before = self.before(); before[field] = value; api = Api()
            self.assertEqual(self.run_case(api, before)['state'], 'refused')
            self.assertEqual(api.adds, [])

    def test_rejection_details_do_not_export_hardware_identity(self):
        raw = device(); result = module.matching_details(raw, TARGET)
        self.assertEqual(result[0]['model'], 'ULXD4')
        self.assertNotIn('12345678', repr(result)); self.assertNotIn('12345', repr(result))


class OfficialTransport(unittest.TestCase):
    def test_exact_additive_endpoint_body_and_verified_local_tls(self):
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID
        from datetime import datetime, timezone, timedelta
        key = ec.generate_private_key(ec.SECP256R1()); name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'fixture')])
        now = datetime.now(timezone.utc)
        cert = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(1).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).sign(key, hashes.SHA256())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'systemapicertificate.cer').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
            (root/'SharedKey.txt').write_text('fixture-only-key')
            requests = []
            class Response:
                status = 202
                def __enter__(self): return self
                def __exit__(self, *args): pass
            class Opener:
                def open(self, request, timeout):
                    requests.append(request); return Response()
            def build(*handlers):
                https = next(h for h in handlers if isinstance(h, module.urllib.request.HTTPSHandler))
                self.assertTrue(https._context.check_hostname)
                self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
                self.assertTrue(any(isinstance(h, module.NoRedirect) for h in handlers))
                return Opener()
            with patch.object(module.urllib.request, 'build_opener', side_effect=build):
                module.DiscoveryApi(security=root).add(TARGET)
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0].method, 'PATCH')
            self.assertEqual(requests[0].full_url, 'https://127.0.0.1:10000/api/v1/config/discovery/ips/add')
            self.assertEqual(json.loads(requests[0].data), {'ips': [TARGET]})


if __name__ == '__main__':
    unittest.main(verbosity=2)
