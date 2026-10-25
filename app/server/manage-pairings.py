#!/usr/bin/env python3
"""Local receiver provisioning / explicit development enrollment configuration."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import secrets
import sys
import time
from urllib.parse import urlsplit

from receiver_pairing import (PROTOCOL, ReceiverPairingPolicy, default_pairing_path,
                              normalize_mac, normalize_brand, receiver_id, ipv4)
from security_storage import validate_path, secure_directory, registry_lock, save_registry, exclusive_write
from tls_support import default_config_path, transport_metadata


def read_registry(path):
    if not path.exists():
        return {'version': 1, 'receivers': []}
    data = ReceiverPairingPolicy(path)._load()
    if data is None:
        raise ValueError('已有接收机注册表无效，未覆盖；请核实或恢复备份')
    return data


def validate_broker(value, metadata):
    try:
        parsed = urlsplit(value)
        if (value != value.strip() or any(ord(c) < 33 for c in value) or '\\' in value
                or parsed.scheme != 'wss' or parsed.port != 8083 or parsed.path != '/mqtt'
                or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment
                or not parsed.hostname or parsed.hostname.lower() not in [h.lower() for h in metadata['hosts']]):
            raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise ValueError('Broker 必须为证书 SAN 明确包含的 wss://主机:8083/mqtt，不支持通配符/凭据/查询串') from None
    return value


def main():
    parser = argparse.ArgumentParser(description='DATY 本机离线接收机配对（不向网络发放密钥）')
    parser.add_argument('--registry', type=Path, default=default_pairing_path())
    parser.add_argument('--tls-config', type=Path, default=default_config_path())
    commands = parser.add_subparsers(dest='command', required=True)
    issue = commands.add_parser('issue', help='签发单机配对 JSON；只输出受保护文件路径')
    issue.add_argument('--name', required=True)
    issue.add_argument('--mac', required=True, help='FAshe 配对窗口显示的固定模拟 MAC，不是 Group/CH')
    issue.add_argument('--brand', required=True)
    issue.add_argument('--max-channels', type=int, required=True)
    issue.add_argument('--receiver-ip', help='可选：额外限制真实连接来源 IPv4')
    issue.add_argument('--broker', required=True)
    issue.add_argument('--days', type=int, default=30)
    commands.add_parser('list', help='只列公开身份与期限，不输出密钥/摘要')
    revoke = commands.add_parser('revoke', help='撤销后拒绝新报文并关闭现有会话，无需重启')
    revoke.add_argument('--id', required=True)
    auto = commands.add_parser('enable-auto', help='允许明确的开发电脑自动接入，无需逐机配对文件')
    auto.add_argument('--allow-ip', action='append', required=True)
    auto.add_argument('--broker', required=True)
    auto.add_argument('--max-channels', type=int, default=128)
    auto.add_argument('--max-receivers', type=int, default=64)
    commands.add_parser('disable-auto', help='关闭新机自动接入；已有身份仍可签名登录，撤销需 revoke')
    args = parser.parse_args()
    path = validate_path(args.registry)
    if args.command == 'list':
        data = read_registry(path)
        fields = ('credential_id', 'name', 'receiver_mac', 'receiver_id', 'receiver_ip', 'brand',
                  'max_channels', 'expires_at', 'revoked')
        print(json.dumps({'registry': str(path), 'development_enrollment': data.get('development_enrollment'),
            'receivers': [{**{key: record.get(key) for key in fields},
                'group_number': data.get('receiver_groups', {}).get(record['receiver_mac'])}
                for record in data['receivers']]}, ensure_ascii=False, indent=2))
        return
    if args.command == 'enable-auto':
        metadata = transport_metadata(args.tls_config)
        broker = validate_broker(args.broker, metadata)
        allowed = list(dict.fromkeys(ipv4(value) for value in args.allow_ip))
        if not 1 <= len(allowed) <= 256 or not 1 <= args.max_channels <= 128 or not 1 <= args.max_receivers <= 512:
            raise ValueError('自动接入：1～256个明确IP，CH上限1～128，接收机上限1～512')
        if len(metadata['ca_sha256']) != 1:
            raise ValueError('自动接入需要单一明确 CA')
    if args.command == 'issue':
        if (not 1 <= len(args.name.strip()) <= 80 or any(ord(c) < 32 for c in args.name)
                or not 1 <= args.days <= 365 or not 1 <= args.max_channels <= 128):
            raise ValueError('名称须为 1～80 个可见字符，有效期 1～365 天，通道数 1～128')
        mac, brand = normalize_mac(args.mac), normalize_brand(args.brand)
        peer = ipv4(args.receiver_ip) if args.receiver_ip else None
        metadata = transport_metadata(args.tls_config)
        broker = validate_broker(args.broker, metadata)
        if len(metadata['ca_sha256']) != 1:
            raise ValueError('离线配对需要明确的单一 CA 指纹，请使用专用 CA 信任文件')
    secure_directory(path.parent)
    with registry_lock(path):
        data = read_registry(path)
        if args.command in ('enable-auto', 'disable-auto'):
            if args.command == 'enable-auto':
                data['development_enrollment'] = dict(enabled=True, allowed_ips=allowed, broker_url=broker,
                    max_channels=args.max_channels, max_receivers=args.max_receivers)
            elif data.get('development_enrollment'):
                data['development_enrollment']['enabled'] = False
            save_registry(path, data)
            print('开发自动接入配置已保存；不改变网络IP、不安装证书信任、不下发控制。')
            return
        if args.command == 'revoke':
            records = [r for r in data['receivers'] if r['credential_id'] == args.id]
            if not records:
                raise ValueError('未找到该接收机凭据 ID')
            records[0]['revoked'] = True
            save_registry(path, data)
            print('接收机配对已撤销；后续报文拒绝，闲置会话在约 1 秒内关闭。配对文件保留，请按保密要求处理。')
            return
        now = time.time()
        if len(data['receivers']) >= 512:
            raise ValueError('配对记录已达 512 条，请先归档历史撤销记录')
        if any(r['receiver_mac'] == mac and not r.get('revoked') and r['expires_at'] > now for r in data['receivers']):
            raise ValueError('该 MAC 已有有效配对；需要轮换时先明确撤销旧 ID，未覆盖任何配对')
        identity = secrets.token_hex(8)
        credential_id = 'rx_' + identity
        secret = f'daty_rx_{identity}_{secrets.token_urlsafe(32)}'
        expiry = now + args.days * 86400
        record = {'credential_id': credential_id, 'name': args.name.strip(), 'receiver_mac': mac,
                  'receiver_id': receiver_id(mac), 'receiver_ip': peer, 'brand': brand,
                  'max_channels': args.max_channels, 'secret_sha256': hashlib.sha256(secret.encode('ascii')).hexdigest(),
                  'created_at': now, 'expires_at': expiry, 'revoked': False}
        document = {key: record[key] for key in ('credential_id', 'receiver_mac', 'receiver_id', 'brand', 'max_channels', 'expires_at')}
        document.update(protocol=PROTOCOL, secret=secret, broker_url=broker, ca_sha256=metadata['ca_sha256'][0])
        output = path.parent / f'pairing-{credential_id}.json'
        # Publish registry last. An interrupted export is not an authorized key.
        exclusive_write(output, json.dumps(document, ensure_ascii=False, indent=2))
        data['receivers'].append(record)
        save_registry(path, data)
        print(f'已签发 {record["name"]}；{brand}；最多 {args.max_channels} CH；ID：{credential_id}')
        print(f'配对文件（含秘密，仅私下交付指定接收机并导入）：{output}')
        print('未连接设备、未下发控制、未安装 CA 信任；接收机仍需信任服务器 CA。')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(f'接收机配对管理失败：{error}', file=sys.stderr)
        raise SystemExit(1)
