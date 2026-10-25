"""Isolated official NIC repair tests. Never touch live devices or vendor config."""
from pathlib import Path
import importlib.util, json, ssl, tempfile, unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('network_tool', Path(__file__).with_name('project-shure-network.py'))
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
LAN = '{11111111-1111-1111-1111-111111111111}'
VPN = '{22222222-2222-2222-2222-222222222222}'
TARGET = '192.0.2.104'
CONFIG = b'''{ // preserve comment, formatting, Unicode escapes and unrelated fields
 "DeviceManager": {"DeviceDiscovery": {"CommunicationTransports": {
 "Ethernet": { /* NIC */ "Enable": true, }, "USB": {"Enable": false}}}},
 "Application": {"Other": "https://example.invalid/a//b", "Nested": [1, true, null,]},
}'''


def interfaces(primary=VPN):
    return [{'name': name, 'hostId': identity, 'primaryInterface': identity == primary,
             'status': 'Connected', 'addressConfiguration': {'ipAddress': ip, 'subnetMask': '255.255.255.0'}}
        for name, identity, ip in [('LAN', LAN, '192.0.2.17'), ('VPN', VPN, '10.222.222.1')]]


def windows():
    return {'adapters': [{'Name': 'LAN', 'InterfaceGuid': LAN, 'ifIndex': 6, 'Status': 'Up', 'HardwareInterface': True}],
        'ips': [{'IPAddress': '192.0.2.17', 'PrefixLength': 24, 'InterfaceIndex': 6}],
        'routes': [{'DestinationPrefix': '192.0.2.0/24', 'NextHop': '0.0.0.0', 'InterfaceIndex': 6}], 'profiles': []}


def before():
    return {'runtime_readable': True, 'plugin': {'active': True}, 'automatic_discovery': {'enabled': True},
        'systemapi': {'state': 'ready'}, 'receiver': {'tcp2202': True, 'scpReply': True, 'firmware': '2.3.34.0', 'channels': 1}}


class Api:
    def __init__(self, primary=VPN, identity=True, apply=True, lost_reply=False):
        self.primary, self.identity, self.apply, self.lost_reply = primary, identity, apply, lost_reply
        self.calls, self.other = [], False
    def interfaces(self):
        return interfaces(self.primary)
    def select(self, value):
        self.calls.append(value)
        if self.apply:
            self.primary = value
        if self.lost_reply:
            raise TimeoutError()
    def devices(self):
        if (self.primary != LAN or not self.identity) and not self.other:
            return {'edges': []}
        return {'edges': [{'node': {'deviceState': 'ONLINE',
            'communicationProtocol': {'address': '10.222.222.3' if self.other else TARGET},
            'softwareIdentity': {'model': 'ULXD4', 'firmwareVersion': '2.3.34.0', 'firmwareValid': True},
            'hardwareIdentity': {'deviceId': '12345678-1234-1234-1234-123456789012', 'serialNumber': '12345'}}}]}


class ConfigTests(unittest.TestCase):
    def test_lossless_insert_and_update_preserve_unrelated_settings(self):
        doc = tool.ConfigDocument(CONFIG)
        updated = doc.with_nic(LAN)
        self.assertEqual(updated.replace(b'"NetworkInterfaceId": "'+LAN.encode()+b'",', b''), CONFIG)
        replaced = tool.ConfigDocument(updated).with_nic(VPN)
        self.assertEqual(replaced, updated.replace(LAN.encode(), VPN.encode()))
        self.assertEqual(tool.ConfigDocument(replaced).get(tool.GUID_KEY), VPN)

    def test_empty_object_bom_and_strings_containing_comments(self):
        raw = b'\xef\xbb\xbf'+CONFIG.replace(b'{ /* NIC */ "Enable": true, }', b'{ /* NIC */ }')
        result = tool.ConfigDocument(raw).with_nic(LAN)
        self.assertTrue(result.startswith(b'\xef\xbb\xbf'))
        self.assertEqual(tool.ConfigDocument(result).get(tool.GUID_KEY), LAN)

    def test_duplicate_keys_unquoted_json5_and_wrong_scope_are_refused(self):
        for raw in [b'{"a":1,"a":2}', b'{unquoted:true}', b'{"DeviceManager":{}}']:
            with self.assertRaises(ValueError):
                tool.ConfigDocument(raw).with_nic(LAN)

    def test_atomic_windows_replace_preserves_original_backup_and_detects_concurrent_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'settings.json5'
            path.write_bytes(CONFIG)
            update = tool.ConfigDocument(CONFIG).with_nic(LAN)
            backup = tool.atomic_config(path, CONFIG, update)
            self.assertEqual(path.read_bytes(), update)
            self.assertEqual(Path(backup).read_bytes(), CONFIG)
            with self.assertRaisesRegex(ValueError, 'CONFIG_CHANGED'):
                tool.atomic_config(path, CONFIG, update)
            self.assertEqual(len(list(Path(temporary).iterdir())), 2)


class SelectionTests(unittest.TestCase):
    def test_unique_direct_physical_adapter_is_selected_by_actual_address(self):
        self.assertEqual(tool.select_candidate(windows(), interfaces(), TARGET)['id'], LAN)

    def test_routed_vpn_down_or_virtual_route_is_never_auto_selected(self):
        for modify in [lambda w: w['routes'][0].update(NextHop='192.0.2.1'),
                       lambda w: w['adapters'][0].update(HardwareInterface=False),
                       lambda w: w['adapters'][0].update(Status='Disconnected')]:
            data = windows(); modify(data)
            with self.assertRaises(ValueError):
                tool.select_candidate(data, interfaces(), TARGET)

    def test_ambiguous_or_more_specific_vpn_route_refuses_guess(self):
        data = windows()
        data['routes'].append({'DestinationPrefix': '192.0.2.104/32', 'NextHop': '10.222.222.2', 'InterfaceIndex': 9})
        with self.assertRaisesRegex(ValueError, 'ROUTER_OR_VPN'):
            tool.select_candidate(data, interfaces(), TARGET)
        data = windows(); data['routes'].append(dict(data['routes'][0], InterfaceIndex=7))
        with self.assertRaisesRegex(ValueError, 'UNIQUE'):
            tool.select_candidate(data, interfaces(), TARGET)


class RecoveryTests(unittest.TestCase):
    def run_case(self, api, channels=1, status=None, readonly=False, writer_error=None):
        clock, writes = [0], []
        def writer(path, original, replacement):
            if writer_error:
                raise writer_error
            writes.append((original, replacement))
            return 'local-official-backup.bak'
        result = tool.recover(status or before(), TARGET, api, windows(),
            config_loader=lambda: (Path('fixture.json5'), CONFIG, tool.ConfigDocument(CONFIG), VPN),
            writer=writer, observe=lambda _: channels, timeout=6, readonly=readonly,
            pause=lambda n: clock.__setitem__(0, clock[0]+n), now=lambda: clock[0], log=lambda *a, **k: None)
        return result, writes

    def test_mismatch_persisted_verified_and_actual_daty_channel_required(self):
        api = Api(); result, writes = self.run_case(api)
        self.assertEqual(result['state'], 'recovered')
        self.assertEqual(len(writes), 1)
        self.assertEqual(api.calls, [LAN])
        self.assertTrue(result['binding_verified'])
        self.assertEqual(tool.ConfigDocument(writes[0][1]).get(tool.GUID_KEY), LAN)

    def test_correct_binding_and_readonly_modes_never_change_official_config(self):
        api = Api(LAN); result, writes = self.run_case(api)
        self.assertEqual(result['state'], 'recovered'); self.assertFalse(writes); self.assertFalse(api.calls)
        api = Api(); result, writes = self.run_case(api, readonly=True)
        self.assertEqual(result['state'], 'mismatch_readonly'); self.assertFalse(writes); self.assertFalse(api.calls)

    def test_without_identity_or_channel_stays_pending(self):
        self.assertEqual(self.run_case(Api(identity=False))[0]['state'], 'identity_pending')
        self.assertEqual(self.run_case(Api(), channels=0)[0]['state'], 'server_pending')
        self.assertEqual(self.run_case(Api(apply=False))[0]['state'], 'binding_pending')

    def test_lost_mutation_reply_only_reads_never_resends(self):
        api = Api(lost_reply=True); result, _ = self.run_case(api)
        self.assertEqual(result['state'], 'recovered'); self.assertEqual(api.calls, [LAN])

    def test_missing_plugin_other_network_devices_or_write_failure_refuses_mutation(self):
        status = before(); status['plugin']['active'] = False
        api = Api(); result, writes = self.run_case(api, status=status)
        self.assertEqual(result['state'], 'refused'); self.assertFalse(writes); self.assertFalse(api.calls)
        api = Api(); api.other = True; result, writes = self.run_case(api)
        self.assertEqual(result['error'], 'OTHER_ONLINE_DEVICES_USE_DIFFERENT_NETWORK')
        self.assertFalse(writes); self.assertFalse(api.calls)
        api = Api(); result, writes = self.run_case(api, writer_error=PermissionError())
        self.assertEqual(result['error'], 'PermissionError'); self.assertFalse(writes); self.assertFalse(api.calls)

    def test_external_interface_change_before_save_is_preserved(self):
        api = Api()
        calls = [0]
        def changed():
            calls[0] += 1
            return interfaces(VPN if calls[0] == 1 else LAN)
        api.interfaces = changed
        result, writes = self.run_case(api)
        self.assertEqual(result['error'], 'PRIMARY_INTERFACE_CHANGED_DURING_REPAIR')
        self.assertFalse(writes); self.assertFalse(api.calls)


class TransportTests(unittest.TestCase):
    def test_local_verified_tls_and_official_nic_mutation_without_device_control(self):
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID
        from datetime import datetime, timezone, timedelta
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'fixture')])
        now = datetime.now(timezone.utc)
        cert = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(1).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).sign(key, hashes.SHA256())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'systemapicertificate.cer').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
            (root/'SharedKey.txt').write_text('fixture-only-key')
            requests = []
            class Response:
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self, size): return b'{"data":{"updateDiscovery":{"error":null}}}'
            class Opener:
                def open(self, request, timeout): requests.append(request); return Response()
            def build(*handlers):
                https = next(h for h in handlers if isinstance(h, tool.urllib.request.HTTPSHandler))
                self.assertTrue(https._context.check_hostname)
                self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
                self.assertTrue(any(isinstance(h, tool.repair_tool.NoRedirect) for h in handlers))
                return Opener()
            with patch.object(tool.urllib.request, 'build_opener', side_effect=build):
                tool.NetworkApi(security=root).select(LAN)
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0].full_url, 'https://127.0.0.1:10000/graphql')
            data = json.loads(requests[0].data)
            self.assertIn('updateDiscovery', data['query'])
            self.assertEqual(data['variables'], {'input': {'ethernet': {'networkInterfaceId': LAN}}})


if __name__ == '__main__':
    unittest.main()
