"""Fixed, temporary test principals and TLS certificates; no production reads."""
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import struct
import time

from receiver_pairing import ReceiverPairingPolicy, receiver_id


class PairingFixture:
    def __init__(self, directory, macs=('02:00:00:00:00:98',), max_channels=128):
        self.path = Path(directory) / 'security' / 'isolated-receiver-pairings.json'
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.records, self.credentials = [], []
        for index, mac in enumerate(macs):
            suffix = f'{index + 1:016x}'
            username = 'rx_' + suffix
            secret = 'daty_rx_' + suffix + '_' + chr(65 + index) * 43
            self.records.append({'credential_id': username, 'name': f'Isolated receiver {index + 1}',
                'receiver_mac': mac, 'receiver_id': receiver_id(mac), 'receiver_ip': None,
                'brand': 'DATYaudio', 'max_channels': max_channels,
                'secret_sha256': hashlib.sha256(secret.encode()).hexdigest(),
                'expires_at': time.time() + 3600, 'revoked': False})
            self.credentials.append(SimpleNamespace(username=username, secret=secret,
                client_id=username + '_fixture', receiver_mac=mac, receiver_id=receiver_id(mac)))
        self.save()
        self.policy = ReceiverPairingPolicy(self.path)

    def save(self):
        prior = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {}
        self.path.write_text(json.dumps({'version': 1, 'receivers': self.records,
            'receiver_groups': prior.get('receiver_groups', {})}), encoding='utf-8')

    def principal(self, index=0, peer_ip='127.0.0.1'):
        item = self.credentials[index]
        return self.policy.authenticate(item.username, item.secret, item.client_id, peer_ip)


def mqtt_utf(value):
    encoded = value.encode('utf-8')
    return struct.pack('>H', len(encoded)) + encoded


def mqtt_packet(header, body):
    size, encoded = len(body), bytearray()
    while True:
        digit = size % 128
        size //= 128
        encoded.append(digit | (0x80 if size else 0))
        if not size:
            break
    return bytes([header]) + bytes(encoded) + body


def connect_packet(credential, *, password=None, client_id=None, flags=0xC2, keepalive=30):
    payload = (mqtt_utf('MQTT') + bytes([4, flags]) + struct.pack('>H', keepalive)
               + mqtt_utf(client_id or credential.client_id))
    if flags & 0x80:
        payload += mqtt_utf(credential.username)
    if flags & 0x40:
        payload += mqtt_utf(credential.secret if password is None else password)
    return mqtt_packet(0x10, payload)


def subscribe_packet(topics, packet_id=1):
    return mqtt_packet(0x82, struct.pack('>H', packet_id)
                       + b''.join(mqtt_utf(topic) + bytes([0]) for topic in topics))


def create_tls_fixture(directory):
    project = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location('pairing_tls_fixture_manager', project / 'manage-tls.py')
    manager = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(manager)
    config = Path(directory) / 'security' / 'tls-config.json'
    manager.install_material(config, manager.create_material(['localhost', '127.0.0.1'], days=2))
    return config
