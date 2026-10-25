"""daty-pairing-v1: transport-authenticated receiver identity and MQTT limits.

MAC is a bound simulator identity, not proof of a physical NIC. Possession of an
individually issued credential over verified TLS is the authentication factor.
Development enrollment is a separate explicit IP-allowlisted key-proof boundary;
this MQTT boundary never grants anonymous identity or password fallback.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import struct
import threading
import time
from security_storage import validate_path, secure_directory, registry_lock, save_registry

PAIRING_WRITE_LOCK = threading.RLock()


def assign_group_in_registry(data, mac):
    """First successful registration wins; never recycle an offline receiver's GROUP."""
    groups = data.setdefault('receiver_groups', {})
    if mac not in groups:
        groups[mac] = max(groups.values(), default=0) + 1
    return groups[mac]

PROTOCOL = 'daty-pairing-v1'
MAX_PACKET = 1024 * 1024
PUBLISH_TOPICS = frozenset(('daty/rf/devices/register', 'daty/rf/devices/up',
                            'daty/rf/devices/down', 'daty/rf/clock/ack'))
SUBSCRIBE_TOPICS = frozenset(('daty/rf/devices/down', 'daty/rf/clock/sync'))
BRANDS = {'datyaudio': 'DATYaudio', 'daty': 'DATYaudio', 'amsaudio': 'AMSaudio',
          'ams': 'AMSaudio', 'shure': 'Shure', 'senn': 'Sennheiser', 'sennheiser': 'Sennheiser'}


class PairingError(ValueError):
    pass


def default_pairing_path():
    return Path(os.environ.get('DATY_PAIRING_FILE') or
                (Path(os.environ.get('ProgramData', '/var/lib')) / 'DATY RF PRO' / 'security' / 'receiver-pairings.json'))


def normalize_mac(value):
    if not isinstance(value, str) or not re.fullmatch(r'(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}|[0-9A-Fa-f]{12}', value):
        raise PairingError('Invalid receiver MAC')
    compact = value.replace(':', '').replace('-', '').upper()
    if compact == '000000000000' or int(compact[:2], 16) & 1:
        raise PairingError('Receiver MAC must be nonzero unicast')
    return ':'.join(compact[i:i+2] for i in range(0, 12, 2))


def normalize_brand(value):
    if not isinstance(value, str):
        raise PairingError('Missing receiver brand')
    brand = BRANDS.get(re.sub(r'[\s_-]', '', value).lower())
    if not brand:
        raise PairingError('Unsupported receiver brand')
    return brand


def receiver_id(mac):
    return 'FAshe-MAC-' + normalize_mac(mac).replace(':', '')


def ipv4(value):
    try:
        address = ipaddress.ip_address(str(value))
        if address.version == 6 and address.ipv4_mapped:
            address = address.ipv4_mapped
        if address.version != 4 or address.is_unspecified or address.is_multicast:
            raise ValueError()
        return str(address)
    except ValueError:
        raise PairingError('Invalid receiver IPv4') from None


class ReceiverPairingPolicy:
    def __init__(self, path=None):
        self.path = Path(path) if path else default_pairing_path()
        self._lock = threading.RLock()
        self._signature = self._registry = None

    def _load(self):
        with self._lock:
            try:
                stat = self.path.stat()
                signature = (stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
                if signature == self._signature and self._registry is not None:
                    return self._registry
                if stat.st_size > 1024 * 1024:
                    raise ValueError()
                data = json.loads(self.path.read_text(encoding='utf-8'))
                if not isinstance(data, dict) or type(data.get('version')) is not int or data['version'] != 1 or not isinstance(data.get('receivers'), list) or len(data['receivers']) > 512:
                    raise ValueError()
                ids, active_macs = set(), set()
                groups = data.get('receiver_groups', {})
                if (not isinstance(groups, dict) or len(groups) > 16384
                        or any(normalize_mac(mac) != mac or type(n) is not int or not 1 <= n <= 1000000 for mac, n in groups.items())
                        or len(set(groups.values())) != len(groups)):
                    raise ValueError()
                for record in data['receivers']:
                    if (not isinstance(record, dict) or not isinstance(record.get('credential_id'), str)
                            or not re.fullmatch(r'rx_[0-9a-f]{16}', record['credential_id'])
                            or record['credential_id'] in ids or not isinstance(record.get('name'), str)
                            or not 1 <= len(record['name']) <= 80
                            or record.get('receiver_mac') != normalize_mac(record.get('receiver_mac'))
                            or record.get('receiver_id') != receiver_id(record['receiver_mac'])
                            or record.get('brand') != normalize_brand(record.get('brand'))
                            or type(record.get('max_channels')) is not int or not 1 <= record['max_channels'] <= 128
                            or not isinstance(record.get('secret_sha256'), str)
                            or not re.fullmatch(r'[0-9a-f]{64}', record['secret_sha256'])
                            or type(record.get('expires_at')) not in (int, float) or not 0 < record['expires_at'] < 10**12
                            or type(record.get('revoked', False)) is not bool):
                        raise ValueError()
                    if record.get('receiver_ip') is not None and record['receiver_ip'] != ipv4(record['receiver_ip']):
                        raise ValueError()
                    ids.add(record['credential_id'])
                    if not record.get('revoked') and record['expires_at'] > time.time():
                        if record['receiver_mac'] in active_macs:
                            raise ValueError()
                        active_macs.add(record['receiver_mac'])
                self._signature, self._registry = signature, data
                return data
            except (OSError, ValueError, TypeError, UnicodeError):
                self._signature = self._registry = None
                return None

    def configured(self):
        data = self._load()
        return bool(data and any(not item.get('revoked') and item['expires_at'] > time.time() for item in data['receivers']))

    def ensure_group(self, principal):
        """Only authenticated callers may allocate; registration is durable before reply."""
        with PAIRING_WRITE_LOCK:
            if not self.is_active(principal):
                raise PairingError('Inactive pairing cannot allocate GROUP')
            mac = principal['receiver_mac']
            data = self._load()
            existing = data.get('receiver_groups', {}).get(mac)
            if existing:
                return existing
            path = validate_path(self.path)
            secure_directory(path.parent)
            with registry_lock(path):
                data = self._load()
                if not self.is_active(principal):
                    raise PairingError('Inactive pairing cannot allocate GROUP')
                # Do not mutate a cached registry if saving fails.
                data = json.loads(json.dumps(data))
                number = assign_group_in_registry(data, mac)
                save_registry(path, data)
                return number

    @staticmethod
    def _principal(record):
        principal = {k: record.get(k) for k in ('credential_id', 'name', 'receiver_id', 'receiver_mac', 'receiver_ip', 'brand', 'max_channels', 'expires_at')}
        principal['_revision'] = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
        return principal

    def authenticate(self, username, password, client_id, peer_ip):
        data = self._load()
        if (not data or not isinstance(username, str) or not re.fullmatch(r'rx_[0-9a-f]{16}', username)
                or not isinstance(client_id, str) or not re.fullmatch(re.escape(username) + r'_[A-Za-z0-9_-]{4,80}', client_id)
                or not isinstance(password, str) or not re.fullmatch(r'daty_rx_' + username[3:] + r'_[A-Za-z0-9_-]{43}', password)):
            raise PairingError('Receiver pairing authentication failed')
        digest = hashlib.sha256(password.encode('ascii')).hexdigest()
        for record in data['receivers']:
            if (record['credential_id'] == username and hmac.compare_digest(record['secret_sha256'], digest)
                    and not record.get('revoked') and record['expires_at'] > time.time()
                    and (not record.get('receiver_ip') or record['receiver_ip'] == ipv4(peer_ip))):
                principal = self._principal(record)
                principal['_peer_ip'] = ipv4(peer_ip)
                principal['group_number'] = data.get('receiver_groups', {}).get(record['receiver_mac'])
                return principal
        raise PairingError('Receiver pairing authentication failed')

    def _active_registry(self, principal):
        """One fresh registry version per validation, also used for GROUP stamps."""
        if not isinstance(principal, dict):
            return None
        data = self._load()
        if not data:
            return None
        active = any(record['credential_id'] == principal.get('credential_id')
                   and not record.get('revoked') and record['expires_at'] > time.time()
                   and hmac.compare_digest(self._principal(record)['_revision'], str(principal.get('_revision', '')))
                   for record in data['receivers'])
        return data if active else None

    def is_active(self, principal):
        return self._active_registry(principal) is not None

    def validate_payload(self, principal, topic, payload):
        """Reject foreign identity before queue/state mutation, then stamp owner.

        Sparse telemetry remains sparse; absent measurement fields are untouched.
        Peer address is authoritative for aliases. Every supplied alias must agree.
        """
        registry = self._active_registry(principal)
        if registry is None:
            raise PairingError('Receiver pairing expired or revoked')
        if topic not in PUBLISH_TOPICS or not isinstance(payload, dict):
            raise PairingError('Receiver topic or payload denied')
        bound_mac, bound_id = principal['receiver_mac'], principal['receiver_id']
        peer = principal['_peer_ip']
        own_aliases = {bound_id.lower(), ('FAshe-' + peer).lower()}
        mac_fields = ('receiver_mac', 'receiver_mac_address', 'mac_address', 'mac', 'hardware_mac')
        ip_fields = ('receiver_ip', 'ip', 'ip_address', 'ipAddress')
        id_fields = ('receiver_id', 'receiverId', 'client_id')

        def check(item, require_channel=False):
            if not isinstance(item, dict):
                raise PairingError('Invalid receiver channel')
            if require_channel and ('devices' in item or 'updates' in item):
                raise PairingError('Nested receiver batches denied')
            result = dict(item)
            for field in mac_fields:
                if field in item and normalize_mac(item[field]) != bound_mac:
                    raise PairingError('Foreign receiver MAC rejected')
            for field in ip_fields:
                if field in item and ipv4(item[field]) != peer:
                    raise PairingError('Foreign receiver IP rejected')
            for field in id_fields:
                if field in item and str(item[field]).lower() not in own_aliases:
                    raise PairingError('Foreign receiver alias rejected')
            if 'brand' in item and normalize_brand(item['brand']) != principal['brand']:
                raise PairingError('Foreign receiver brand rejected')
            channels = []
            for field in ('channel_number', 'channel_no', 'channel', 'channel_key', 'ch'):
                if field in item:
                    value = item[field]
                    match = re.fullmatch(r'(?:CH)?([1-9][0-9]*)', str(value), flags=re.I)
                    if type(value) not in (int, str) or not match or int(match[1]) > principal['max_channels']:
                        raise PairingError('Channel outside paired capability')
                    channels.append(int(match[1]))
            if (require_channel and not channels) or len(set(channels)) > 1:
                raise PairingError('Missing or inconsistent receiver CH')
            channel = channels[0] if channels else None
            for field in ('device_id', 'id', 'muted_command'):
                if field in item:
                    allowed = {f'{alias}_ch{channel}' for alias in own_aliases} if channel else set()
                    if str(item[field]).lower() not in allowed:
                        raise PairingError('Foreign target channel rejected')
            for field in id_fields:
                if field in result:
                    result[field] = bound_id
            result.update(receiver_id=bound_id, receiver_mac=bound_mac, receiver_ip=peer)
            number = registry.get('receiver_groups', {}).get(bound_mac)
            if number:
                result.update(group=number, group_number=number, group_source='server-fifo-v1')
            # MAC+canonical ID are not inferred from Group or device names.
            if require_channel:
                result.update(channel_number=channel, brand=principal['brand'])
            return result

        if topic == 'daty/rf/clock/ack':
            if payload.get('type') != 'clock_sync_ack':
                raise PairingError('Invalid clock ACK type')
            return check(payload)
        # Current Bridge wire batches use `devices` and a type to distinguish
        # full register snapshots from sparse device_status_update. Never ACK
        # an unsupported updates batch then silently discard its measurements.
        if 'updates' in payload or ('devices' in payload and not isinstance(payload['devices'], list)):
            raise PairingError('Unsupported receiver batch; use typed devices array')
        nested = 'devices' if isinstance(payload.get('devices'), list) else None
        result = check(payload, require_channel=nested is None)
        if nested:
            if len(payload[nested]) > principal['max_channels']:
                raise PairingError('Too many paired channels')
            items = [check(item, require_channel=True) for item in payload[nested]]
            if len({item['channel_number'] for item in items}) != len(items):
                raise PairingError('Duplicate paired CH')
            result[nested] = items
        if topic == 'daty/rf/devices/down' and (payload.get('type') != 'device_command' or payload.get('command') not in ('mute', 'unmute', 'set_freq')):
            raise PairingError('Invalid local receiver command report')
        return result


class MqttPacketBuffer:
    """Bounded MQTT framing across WebSocket messages, including CONNECT."""
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, raw):
        if not isinstance(raw, (bytes, bytearray)):
            raise PairingError('MQTT requires binary WebSocket messages')
        self.buffer.extend(raw)
        if len(self.buffer) > MAX_PACKET:
            raise PairingError('MQTT packet exceeds limit')
        packets = []
        while len(self.buffer) >= 2:
            remaining, multiplier, offset, complete = 0, 1, 1, False
            for index in range(4):
                if offset >= len(self.buffer):
                    break
                byte = self.buffer[offset]; offset += 1
                remaining += (byte & 127) * multiplier
                if not byte & 128:
                    if index and byte == 0:
                        raise PairingError('Noncanonical MQTT length')
                    complete = True
                    break
                multiplier *= 128
                if index == 3:
                    raise PairingError('Invalid MQTT length')
            if not complete:
                break
            size = offset + remaining
            if size > MAX_PACKET:
                raise PairingError('MQTT packet exceeds limit')
            if len(self.buffer) < size:
                break
            packets.append(bytes(self.buffer[:size]))
            del self.buffer[:size]
        return packets


def mqtt_body(packet):
    offset = 1
    while packet[offset] & 128:
        offset += 1
    return packet[offset+1:]


def mqtt_utf(data, offset):
    if offset + 2 > len(data):
        raise PairingError('Truncated MQTT string')
    size = struct.unpack_from('>H', data, offset)[0]
    end = offset + 2 + size
    if end > len(data):
        raise PairingError('Truncated MQTT string')
    try:
        value = data[offset+2:end].decode('utf-8')
    except UnicodeError:
        raise PairingError('Invalid MQTT UTF8') from None
    if '\x00' in value:
        raise PairingError('Invalid MQTT null')
    return value, end


def parse_connect(packet):
    if not packet or packet[0] != 0x10:
        raise PairingError('MQTT CONNECT required')
    data = mqtt_body(packet)
    protocol, offset = mqtt_utf(data, 0)
    if offset + 4 > len(data) or protocol != 'MQTT' or data[offset] != 4 or data[offset+1] != 0xC2:
        # Only clean-session MQTT3.1.1 with credentials; no retained Will, auth
        # flags ambiguity or unsupported MQTT5 can silently fall back anonymous.
        raise PairingError('Authenticated MQTT3.1.1 clean session required')
    keepalive = struct.unpack_from('>H', data, offset+2)[0]
    offset += 4
    client, offset = mqtt_utf(data, offset)
    username, offset = mqtt_utf(data, offset)
    password, offset = mqtt_utf(data, offset)
    if offset != len(data) or not 1 <= keepalive <= 120:
        raise PairingError('Invalid MQTT CONNECT length/keepalive')
    return client, username, password, keepalive
