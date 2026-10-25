"""Shared TLS contract for the browser, Bridge and future native clients.

No development/plaintext bypass and no automatic operating-system trust edits.
All server listeners require a locally provisioned, validated certificate. The
same explicit CA validates internal HTTPS calls; hostname checks stay enabled.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import ssl

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.x509.oid import ExtendedKeyUsageOID
from cryptography.x509.verification import PolicyBuilder, Store

from security_storage import validate_path

PROTOCOL = 'tls-v1'
MAX_PEM_BYTES = 256 * 1024


class TLSConfigurationError(ValueError):
    """Configuration rejected before opening any listener."""


def default_config_path():
    override = os.environ.get('DATY_TLS_FILE')
    if override:
        return Path(override)
    base = os.environ.get('ProgramData', os.environ.get('PROGRAMDATA', r'C:\ProgramData'))
    return Path(base) / 'DATY RF PRO' / 'security' / 'tls-config.json'


def _read_bounded(path, limit=MAX_PEM_BYTES):
    with path.open('rb') as source:
        data = source.read(limit + 1)
    if not data or len(data) > limit:
        raise TLSConfigurationError('TLS 文件为空或超出允许大小')
    return data


def validate_material(certificate_pem, private_key_pem, ca_pem, *, now=None):
    """Validate key match, server EKU, SAN and full chain before serving TLS."""
    try:
        certificates = x509.load_pem_x509_certificates(certificate_pem)
        authorities = x509.load_pem_x509_certificates(ca_pem)
        if not certificates or not authorities:
            raise TLSConfigurationError('TLS 证书链或 CA 为空')
        certificate = certificates[0]
        key = serialization.load_pem_private_key(private_key_pem, password=None)
        public_format = (serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        if certificate.public_key().public_bytes(*public_format) != key.public_key().public_bytes(*public_format):
            raise TLSConfigurationError('TLS 证书与私钥不匹配')
        if certificate.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
            raise TLSConfigurationError('服务器证书不能作为 CA 使用')
        usage = certificate.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
        if ExtendedKeyUsageOID.SERVER_AUTH not in usage:
            raise TLSConfigurationError('证书缺少 TLS serverAuth 用途')
        alternatives = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        names = [name for name in alternatives if isinstance(name, (x509.DNSName, x509.IPAddress))]
        if not names:
            raise TLSConfigurationError('证书必须包含 DNS/IP Subject Alternative Name')
        moment = now or datetime.now(timezone.utc)
        for item in [*certificates, *authorities]:
            if not item.not_valid_before_utc <= moment < item.not_valid_after_utc:
                raise TLSConfigurationError('TLS 证书未生效或已过期')
        for authority in authorities:
            if not authority.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
                raise TLSConfigurationError('信任文件中包含非 CA 证书')
        # Rust-backed verifier checks signatures, constraints, usages, chain
        # validity and name semantics. Runtime clients also verify THEIR host.
        verifier = PolicyBuilder().store(Store(authorities)).time(moment).build_server_verifier(names[0])
        verifier.verify(certificate, certificates[1:])
        return {
            'transport_security': PROTOCOL,
            'minimum_tls': '1.2',
            'certificate_sha256': certificate.fingerprint(hashes.SHA256()).hex(),
            'ca_sha256': [item.fingerprint(hashes.SHA256()).hex() for item in authorities],
            'not_after': certificate.not_valid_after_utc.isoformat(),
            'hosts': [str(name.value) for name in names],
        }
    except TLSConfigurationError:
        raise
    except Exception as error:
        # Never echo certificate/private material from parser error messages.
        raise TLSConfigurationError('TLS 证书、私钥或信任链验证失败') from error


def load_config(config_path=None):
    try:
        path = validate_path(Path(config_path) if config_path else default_config_path())
        data = json.loads(_read_bounded(path, 16384).decode('utf-8'))
        fields = {'version', 'certificate_file', 'private_key_file', 'ca_file'}
        if not isinstance(data, dict) or set(data) != fields or type(data['version']) is not int or data['version'] != 1:
            raise TLSConfigurationError('TLS 配置格式无效（需要 version:1）')
        paths = {}
        for field in ('certificate_file', 'private_key_file', 'ca_file'):
            value = data[field]
            if not isinstance(value, str) or not Path(value).is_absolute():
                raise TLSConfigurationError('TLS 文件路径必须为绝对路径')
            item = validate_path(Path(value))
            if item.parent.resolve() != path.parent.resolve():
                raise TLSConfigurationError('TLS 材料必须位于配置所在的专用安全目录')
            paths[field] = item
        metadata = validate_material(*[_read_bounded(paths[field]) for field in
                                      ('certificate_file', 'private_key_file', 'ca_file')])
        return paths, metadata
    except TLSConfigurationError:
        raise
    except (OSError, ValueError, UnicodeError, TypeError) as error:
        raise TLSConfigurationError('TLS 未配置或不可读取；请先使用 manage-tls.py 配置，服务拒绝明文启动') from error


def server_context(config_path=None):
    paths, _ = load_config(config_path)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.options |= ssl.OP_NO_COMPRESSION
    context.set_ciphers('ECDHE+AESGCM:ECDHE+CHACHA20')
    context.load_cert_chain(str(paths['certificate_file']), str(paths['private_key_file']))
    return context


def client_context(config_path=None):
    paths, _ = load_config(config_path)
    context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=str(paths['ca_file']))
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


def transport_metadata(config_path=None):
    return load_config(config_path)[1]


def bind_https(server_class, address, handler, context):
    """Wrap BEFORE binding, keeping subclasses' exclusive-bind behaviour."""
    server = server_class(address, handler, bind_and_activate=False)
    try:
        # A silent/partial TLS client must not stall the accept loop. Handshake
        # happens in the request worker, with a bounded socket timeout.
        server.socket = context.wrap_socket(server.socket, server_side=True,
                                            do_handshake_on_connect=False)
        original_get_request = server.get_request
        def tls_get_request():
            connection, peer = original_get_request()
            connection.settimeout(10)
            return connection, peer
        server.get_request = tls_get_request
        server.server_bind()
        server.server_activate()
        server.transport_security = PROTOCOL
        return server
    except BaseException:
        server.server_close()
        raise
