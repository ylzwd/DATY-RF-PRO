"""Development auto-enrollment, with persistent browser public-key identity.

Explicit peer-IP allowlist permits FIRST registration only. Existing identities
must prove their non-extractable P-256 key on every login. Short-lived MQTT secrets
are sent only over verified HTTPS and are never persisted by the receiver UI.
This is application registration, NOT DHCP or hardware identity attestation.
"""
from __future__ import annotations
import base64
import hashlib
import json
import secrets
import threading
import time
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from receiver_pairing import (PROTOCOL, ReceiverPairingPolicy, PairingError, normalize_mac,
    normalize_brand, receiver_id, ipv4, assign_group_in_registry, PAIRING_WRITE_LOCK)
from security_storage import validate_path, registry_lock, save_registry
from tls_support import transport_metadata

AUTO_PROTOCOL = 'daty-auto-pair-v1'
ORIGINS = frozenset(('null', 'http://localhost:8081', 'http://127.0.0.1:8081',
                     'https://localhost:8081', 'https://127.0.0.1:8081'))


class EnrollmentError(ValueError):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def decode64(value, size):
    try:
        if not isinstance(value, str) or len(value) > size * 2:
            raise ValueError()
        result = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
        if len(result) != size:
            raise ValueError()
        return result
    except (ValueError, TypeError):
        raise EnrollmentError(400, 'INVALID_PROOF', '自动接入签名格式无效') from None


def public_key(value):
    if not isinstance(value, dict) or value.get('kty') != 'EC' or value.get('crv') != 'P-256' or 'd' in value:
        raise EnrollmentError(400, 'INVALID_KEY', '需要 P-256 公钥，禁止发送私钥')
    x, y = decode64(value.get('x'), 32), decode64(value.get('y'), 32)
    try:
        ec.EllipticCurvePublicNumbers(int.from_bytes(x, 'big'), int.from_bytes(y, 'big'), ec.SECP256R1()).public_key()
    except ValueError:
        raise EnrollmentError(400, 'INVALID_KEY', '公钥无效') from None
    encode = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip('=')
    return {'kty': 'EC', 'crv': 'P-256', 'x': encode(x), 'y': encode(y)}


def enrollment_config(data, tls_config=None):
    config = data.get('development_enrollment') if data else None
    if config is None:
        return None
    if (not isinstance(config, dict) or type(config.get('enabled')) is not bool
            or not isinstance(config.get('allowed_ips'), list) or not 1 <= len(config['allowed_ips']) <= 256
            or type(config.get('max_channels')) is not int or not 1 <= config['max_channels'] <= 128
            or type(config.get('max_receivers')) is not int or not 1 <= config['max_receivers'] <= 512):
        raise EnrollmentError(503, 'ENROLLMENT_CONFIG_INVALID', '自动接入配置无效')
    for peer in config['allowed_ips']:
        if peer != ipv4(peer):
            raise EnrollmentError(503, 'ENROLLMENT_CONFIG_INVALID', '允许的电脑地址无效')
    metadata = transport_metadata(tls_config)
    try:
        broker = urlsplit(config['broker_url'])
        if (broker.scheme != 'wss' or broker.port != 8083 or broker.path != '/mqtt'
                or broker.username or broker.password or broker.query or broker.fragment
                or broker.hostname not in metadata['hosts'] or len(metadata['ca_sha256']) != 1):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise EnrollmentError(503, 'ENROLLMENT_CONFIG_INVALID', '自动接入地址必须匹配服务器证书') from None
    return {**config, 'ca_sha256': metadata['ca_sha256'][0]}


class ReceiverEnrollment:
    def __init__(self, policy=None, tls_config=None):
        self.policy = policy or ReceiverPairingPolicy()
        self.tls_config = tls_config
        self.lock = threading.RLock()
        self.pending, self.rates = {}, {}

    def config(self):
        return enrollment_config(self.policy._load(), self.tls_config)

    def enrollment_group(self, data, mac):
        """Legacy durable assignment; runtime hosts may defer until commit."""
        return assign_group_in_registry(data, mac)

    def enabled(self):
        try:
            config = self.config()
            return bool(config and config['enabled'])
        except (ValueError, OSError):
            return False

    def rate_limit(self, peer):
        now = time.monotonic()
        with self.lock:
            self.rates = {k: v for k, v in self.rates.items() if now - v[0] < 10}
            started, count = self.rates.get(peer, (now, 0))
            if count >= 12 or (peer not in self.rates and len(self.rates) >= 256):
                raise EnrollmentError(429, 'ENROLLMENT_RATE_LIMIT', '接入请求过快，请稍后重试')
            self.rates[peer] = started, count + 1

    def challenge(self, body, peer):
        peer = ipv4(peer)
        self.rate_limit(peer)
        if body.get('protocol') != AUTO_PROTOCOL:
            raise EnrollmentError(400, 'INVALID_PROTOCOL', '自动接入协议不匹配')
        try:
            mac, brand = normalize_mac(body.get('receiver_mac')), normalize_brand(body.get('brand'))
        except PairingError:
            raise EnrollmentError(400, 'INVALID_IDENTITY', '接收机 MAC 或品牌格式无效') from None
        channels = body.get('channel_count')
        if type(channels) is not int or not 1 <= channels <= 128:
            raise EnrollmentError(400, 'INVALID_CHANNEL_COUNT', 'CH 数量应为 1～128')
        key = public_key(body.get('public_key'))
        config = self.config()
        if not config:
            raise EnrollmentError(403, 'AUTO_PAIR_DISABLED', '服务器尚未开启开发自动接入')
        data = self.policy._load()
        records = [r for r in data['receivers'] if r['receiver_mac'] == mac]
        record = records[-1] if records else None
        if record:
            if record.get('revoked') or record.get('public_key') != key:
                raise EnrollmentError(403, 'RECEIVER_IDENTITY_DENIED', '接收机身份已被占用或撤销；不能自动覆盖')
        elif not config['enabled'] or peer not in config['allowed_ips']:
            raise EnrollmentError(403, 'ENROLLMENT_PEER_DENIED', '该电脑尚未被允许自动接入')
        if channels > config['max_channels']:
            raise EnrollmentError(403, 'CHANNEL_LIMIT', '通道数超过服务器开发配置上限')
        challenge_id, nonce = secrets.token_hex(16), secrets.token_urlsafe(32)
        # The exact server-provided string is signed, eliminating JSON ordering
        # ambiguities for browser/Qt/.NET implementations of the same contract.
        message = '\n'.join((AUTO_PROTOCOL, config['broker_url'], challenge_id, nonce,
                             mac, brand, str(channels), peer))
        with self.lock:
            now = time.monotonic()
            self.pending = {k: v for k, v in self.pending.items() if v['deadline'] > now}
            if len(self.pending) >= 128:
                raise EnrollmentError(429, 'ENROLLMENT_BUSY', '接入请求队列已满')
            self.pending[challenge_id] = dict(message=message, mac=mac, brand=brand, channels=channels,
                peer=peer, key=key, deadline=now + 30, broker_url=config['broker_url'])
        return dict(success=True, protocol=AUTO_PROTOCOL, challenge_id=challenge_id, message=message, expires_in=30)

    def complete(self, body, peer):
        peer = ipv4(peer)
        self.rate_limit(peer)
        with self.lock:
            item = self.pending.pop(str(body.get('challenge_id')), None)
        if not item or item['deadline'] <= time.monotonic() or item['peer'] != peer:
            raise EnrollmentError(403, 'CHALLENGE_EXPIRED', '接入挑战已失效，请重新请求')
        signature = decode64(body.get('signature'), 64)
        key = item['key']
        verifier = ec.EllipticCurvePublicNumbers(int.from_bytes(decode64(key['x'], 32), 'big'),
            int.from_bytes(decode64(key['y'], 32), 'big'), ec.SECP256R1()).public_key()
        try:
            verifier.verify(encode_dss_signature(int.from_bytes(signature[:32], 'big'), int.from_bytes(signature[32:], 'big')),
                            item['message'].encode(), ec.ECDSA(hashes.SHA256()))
        except Exception:
            raise EnrollmentError(403, 'INVALID_PROOF', '接收机身份签名不正确') from None
        path = validate_path(self.policy.path)
        with PAIRING_WRITE_LOCK, registry_lock(path):
            data = self.policy._load()
            config = enrollment_config(data, self.tls_config)
            if not config or config['broker_url'] != item['broker_url']:
                raise EnrollmentError(403, 'CONFIG_CHANGED', '接入配置已变化')
            records = [r for r in data['receivers'] if r['receiver_mac'] == item['mac']]
            record = records[-1] if records else None
            if record and (record.get('revoked') or record.get('public_key') != key):
                raise EnrollmentError(403, 'RECEIVER_IDENTITY_DENIED', '该接收机不允许自动登录')
            allowed_new = config['enabled'] and peer in config['allowed_ips']
            if not record and (not allowed_new or len(data['receivers']) >= config['max_receivers']):
                raise EnrollmentError(403, 'ENROLLMENT_PEER_DENIED', '新接入已关闭、电脑未允许或接收机数量已满')
            if item['channels'] > config['max_channels']:
                raise EnrollmentError(403, 'CHANNEL_LIMIT', '通道数超过当前允许上限')
            if record and (not allowed_new and (record['brand'] != item['brand'] or item['channels'] > record['max_channels'])):
                raise EnrollmentError(403, 'CAPABILITY_DENIED', '更改品牌或通道上限需服务器开启开发接入')
            data = json.loads(json.dumps(data))
            record = next((r for r in reversed(data['receivers']) if r['receiver_mac'] == item['mac']), None)
            if record is None:
                record = dict(credential_id='rx_' + secrets.token_hex(8), name='FAshe ' + peer,
                    receiver_mac=item['mac'], receiver_id=receiver_id(item['mac']), created_at=time.time(),
                    public_key=key, enrollment='development-public-key-v1', revoked=False)
                data['receivers'].append(record)
            secret = 'daty_rx_' + record['credential_id'][3:] + '_' + secrets.token_urlsafe(32)
            record.update(secret_sha256=hashlib.sha256(secret.encode()).hexdigest(), expires_at=time.time() + 8 * 3600,
                receiver_ip=None, brand=item['brand'], max_channels=config['max_channels'] if allowed_new else record['max_channels'])
            group = self.enrollment_group(data, item['mac'])
            save_registry(path, data)
            bundle = {k: record[k] for k in ('credential_id', 'receiver_mac', 'receiver_id', 'brand', 'max_channels', 'expires_at')}
            bundle.update(protocol=PROTOCOL, secret=secret, broker_url=config['broker_url'], ca_sha256=config['ca_sha256'])
        return dict(success=True, protocol=AUTO_PROTOCOL, pairing=bundle, receiver_ip=peer,
                    ip_source='socket-peer', group_number=group, group_source='server-fifo-v1')
