#!/usr/bin/env python3
"""Local TLS provisioning. Never trusts a CA automatically or overwrites files."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import ipaddress
import json
from pathlib import Path
import re
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from security_storage import validate_path, secure_directory, registry_lock, exclusive_write
from tls_support import (default_config_path, transport_metadata, validate_material,
                         load_config, MAX_PEM_BYTES)


def host_name(value):
    if not isinstance(value, str) or value != value.strip():
        raise ValueError('主机名不能包含空白')
    try:
        return x509.IPAddress(ipaddress.ip_address(value))
    except ValueError:
        pass
    if len(value) > 253 or not all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?',
                                              part) for part in value.split('.')):
        raise ValueError('需要明确 DNS 名或 IP，禁止 URL、端口、通配符')
    return x509.DNSName(value.lower())


def create_material(hosts, days=365, *, now=None):
    if not 1 <= days <= 397:
        raise ValueError('服务器证书有效期应为 1～397 天')
    if not hosts or len(hosts) > 64:
        raise ValueError('请提供 1～64 个实际访问主机名/IP（--host）')
    names = list(dict.fromkeys(host_name(host) for host in hosts))
    moment = now or datetime.now(timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'DATY RF PRO Local CA')])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
          .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(moment - timedelta(minutes=5)).not_valid_after(moment + timedelta(days=3650))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .add_extension(x509.KeyUsage(digital_signature=False, content_commitment=False,
              key_encipherment=False, data_encipherment=False, key_agreement=False,
              key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .sign(ca_key, hashes.SHA256()))
    leaf = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'DATY RF PRO Server')]))
            .issuer_name(ca_name).public_key(server_key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(moment - timedelta(minutes=5)).not_valid_after(moment + timedelta(days=days))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.SubjectAlternativeName(names), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                key_encipherment=True, data_encipherment=False, key_agreement=False,
                key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(server_key.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    pem = serialization.Encoding.PEM
    def private(key):
        return key.private_bytes(pem, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return {'server-cert.pem': leaf.public_bytes(pem), 'server-key.pem': private(server_key),
            'root-ca.pem': ca.public_bytes(pem), 'root-ca-key.pem': private(ca_key)}


def install_material(path, materials):
    path = validate_path(Path(path))
    names = {'server-cert.pem', 'server-key.pem', 'root-ca.pem'}
    if set(materials) not in (names, names | {'root-ca-key.pem'}):
        raise ValueError('TLS 材料集合无效')
    metadata = validate_material(materials['server-cert.pem'], materials['server-key.pem'], materials['root-ca.pem'])
    secure_directory(path.parent)
    with registry_lock(path):
        targets = [path, *(path.parent / name for name in materials)]
        if any(item.exists() or item.is_symlink() for item in targets):
            raise ValueError('目标 TLS 配置/材料已存在，未覆盖；换用新的专用 security 目录完成轮换')
        # Configuration is written LAST, so interrupted installation cannot be
        # mistaken for a complete release. Never delete previously existing data.
        for name, content in materials.items():
            exclusive_write(path.parent / name, content)
        config = {'version': 1,
                  'certificate_file': str(path.parent / 'server-cert.pem'),
                  'private_key_file': str(path.parent / 'server-key.pem'),
                  'ca_file': str(path.parent / 'root-ca.pem')}
        exclusive_write(path, json.dumps(config, indent=2, ensure_ascii=False))
    return metadata


def input_pem(path):
    with path.open('rb') as source:
        data = source.read(MAX_PEM_BYTES + 1)
    if not data or len(data) > MAX_PEM_BYTES:
        raise ValueError('输入 PEM 为空或过大')
    return data


def main():
    parser = argparse.ArgumentParser(description='DATY 本机 TLS 管理（不自动修改系统信任）')
    parser.add_argument('--config', type=Path, default=default_config_path())
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init', help='创建独立本地 CA 与 SAN 服务器证书，不覆盖现有材料')
    init.add_argument('--host', action='append', required=True)
    init.add_argument('--days', type=int, default=365)
    configure = commands.add_parser('configure', help='验证并导入已有服务器证书链、私钥与 CA')
    configure.add_argument('--certificate', type=Path, required=True)
    configure.add_argument('--private-key', type=Path, required=True)
    configure.add_argument('--ca', type=Path, required=True)
    commands.add_parser('status', help='显示 SHA256 指纹/主机名/有效期，不显示私钥')
    export = commands.add_parser('export-ca', help='仅导出公开根证书（不会安装到系统信任库）')
    export.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    path = validate_path(args.config)
    if args.command == 'init':
        metadata = install_material(path, create_material(args.host, args.days))
    elif args.command == 'configure':
        metadata = install_material(path, {'server-cert.pem': input_pem(args.certificate),
            'server-key.pem': input_pem(args.private_key), 'root-ca.pem': input_pem(args.ca)})
    elif args.command == 'export-ca':
        paths, metadata = load_config(path)
        exclusive_write(args.output.absolute(), paths['ca_file'].read_bytes())
        print('仅已导出公开 CA 证书；请经独立渠道核对下列指纹后按组织策略安装信任。')
    else:
        metadata = transport_metadata(path)
    print(json.dumps(metadata, indent=2, ensure_ascii=False))
    if args.command in ('init', 'configure'):
        print('TLS 已准备；系统信任未修改，服务尚未重启。私钥保留在受保护目录，禁止分发。')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(f'TLS 管理失败：{error}', file=sys.stderr)
        raise SystemExit(1)
