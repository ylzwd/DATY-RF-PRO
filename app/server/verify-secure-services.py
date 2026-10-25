"""Read-only deployment gate shared by PowerShell and future native installer.

No key/certificate issuance, OS trust changes, MQTT CONNECT, or device commands.
Preflight uses the SAME default file paths as the SYSTEM scheduled services.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import time

_service_dir = str(Path(__file__).resolve().parent)
if _service_dir not in sys.path:
    sys.path.insert(0, _service_dir)

from receiver_pairing import ReceiverPairingPolicy, default_pairing_path
from receiver_enrollment import enrollment_config
from security_storage import validate_path
from tls_support import client_context, default_config_path, load_config


class VerificationError(ValueError):
    pass


def default_paths():
    return {'tls': default_config_path(), 'pairing': default_pairing_path()}


def preflight(paths=None, *, now=None):
    """Validate strict registries and trusted certificate material before any stop."""
    paths = paths or default_paths()
    checked = {name: validate_path(Path(paths[name])) for name in ('tls', 'pairing')}
    _, metadata = load_config(checked['tls'])
    if '127.0.0.1' not in metadata['hosts'] or 'localhost' not in metadata['hosts']:
        raise VerificationError('服务器证书必须包含 127.0.0.1 和 localhost SAN，才能保持本机网页与快速控制地址')
    pairing = ReceiverPairingPolicy(checked['pairing'])._load()
    moment = time.time() if now is None else now
    receivers = [] if not pairing else [record for record in pairing['receivers']
        if not record.get('revoked') and record['expires_at'] > moment]
    auto = enrollment_config(pairing, checked['tls'])
    auto_ready = bool(auto and auto['enabled'])
    if not receivers and not auto_ready:
        raise VerificationError('缺少有效接收机配对或已启用的开发自动接入配置；请先本机配置，未停止任何服务')
    return {'ready': True, 'protocol': 'daty-secure-deployment-v1',
        'paths': {name: str(path) for name, path in checked.items()},
        'active_receiver_count': len(receivers), 'control_access': 'daty-direct-control-v1',
        'auto_pairing_enabled': auto_ready,
        'tls': metadata}


def get_json(host, port, route, context, *, timeout=3):
    # Report the endpoint, never query values or response bodies (may be secrets).
    endpoint = f'HTTPS {port} {route.split("?", 1)[0]}'
    connection = http.client.HTTPSConnection(host, port, timeout=timeout, context=context)
    try:
        connection.request('GET', route, headers={'Accept': 'application/json', 'Connection': 'close'})
        response = connection.getresponse()
        body = response.read(65537)
        if response.status != 200:
            raise VerificationError(f'{endpoint} 返回 HTTP {response.status}，要求 HTTP 200')
        if len(body) > 65536:
            raise VerificationError(f'{endpoint} 响应超过 64 KiB 限制')
        data = json.loads(body)
        if not isinstance(data, dict):
            raise VerificationError(f'{endpoint} 响应必须是 JSON 对象')
        return data
    except (json.JSONDecodeError, UnicodeError) as error:
        raise VerificationError(f'{endpoint} 响应不是有效 JSON') from error
    finally:
        connection.close()


def wss_handshake(host, port, context, *, timeout=3):
    """An actual validated WSS upgrade without sending MQTT CONNECT/password."""
    nonce = base64.b64encode(secrets.token_bytes(16)).decode('ascii')
    request = (f'GET /mqtt HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n'
        'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
        f'Sec-WebSocket-Key: {nonce}\r\nSec-WebSocket-Protocol: mqtt\r\n\r\n')
    with socket.create_connection((host, port), timeout=timeout) as raw:
        with context.wrap_socket(raw, server_hostname=host) as secure:
            secure.sendall(request.encode('ascii'))
            result = bytearray()
            while b'\r\n\r\n' not in result:
                chunk = secure.recv(4096)
                if not chunk or len(result) + len(chunk) > 16384:
                    raise VerificationError('WSS 未返回完整且有界的握手响应')
                result.extend(chunk)
            lines = bytes(result).split(b'\r\n\r\n', 1)[0].decode('ascii').split('\r\n')
            if lines[0].split(' ', 2)[:2] != ['HTTP/1.1', '101']:
                raise VerificationError('WSS 升级被拒绝（没有发送接收机凭据）')
            headers = {}
            for line in lines[1:]:
                key, separator, value = line.partition(':')
                if not separator or key.lower() in headers:
                    raise VerificationError('WSS 握手响应头无效')
                headers[key.lower()] = value.strip()
            accept = base64.b64encode(hashlib.sha1((nonce + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode('ascii')).digest()).decode('ascii')
            if (headers.get('upgrade', '').lower() != 'websocket'
                    or 'upgrade' not in [part.strip().lower() for part in headers.get('connection', '').split(',')]
                    or headers.get('sec-websocket-accept') != accept
                    or headers.get('sec-websocket-protocol') != 'mqtt'):
                raise VerificationError('WSS 握手协议、随机挑战或 MQTT 子协议不匹配')
            # Empty, client-masked CLOSE; no MQTT bytes and no authenticated session.
            secure.sendall(b'\x88\x80' + secrets.token_bytes(4))
    return True


def verify_running(paths=None, *, ports=None, request_json=get_json, handshake=wss_handshake, bridge_only=False):
    paths = paths or default_paths()
    ready = preflight(paths)
    context = client_context(paths['tls'])  # CERT_REQUIRED + check_hostname, no bypass.
    ports = ports or {'web': 8080, 'ip': 8765, 'bridge': 8802, 'mqtt': 8083}
    expectations = {'web': {'static_access_policy': 'public-assets-v1'},
        'ip': {'control_access': 'daty-direct-control-v1', 'control_auth_required': False},
        'bridge': {'control_access': 'daty-direct-control-v1', 'control_auth_required': False,
            'mqtt_pairing': 'daty-pairing-v1'}}
    if bridge_only:
        expectations = {'bridge': expectations['bridge']}
    bridge_health = None
    for service, expected in expectations.items():
        health = request_json('127.0.0.1', ports[service], '/health', context)
        if service == 'bridge':
            bridge_health = health
        expected = {'transport_security': 'tls-v1', **expected}
        for key, value in expected.items():
            if type(health.get(key)) is not type(value) or health[key] != value:
                raise VerificationError(f'{service} 服务缺少新版安全标记：{key}')
        if service == 'bridge' and not (health.get('pairing_configured') is True or
                (ready['auto_pairing_enabled'] and health.get('auto_pairing_enabled') is True and health.get('auto_pairing') == 'daty-auto-pair-v1')):
            raise VerificationError('Bridge 配对/开发自动接入尚未就绪')
    if not handshake('127.0.0.1', ports['mqtt'], context):
        raise VerificationError('WSS 握手未通过')
    return {**ready, 'running_verified': True, 'https_ports': [ports[name] for name in expectations],
        'bridge_clock_server_id': bridge_health.get('clock_server_id'),
        'wss_port': ports['mqtt'], 'device_control_sent': False, 'mqtt_connect_sent': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Read-only TLS/direct HTTP/pairing deployment verification')
    parser.add_argument('--verify-running', action='store_true')
    parser.add_argument('--bridge-only', action='store_true')
    parser.add_argument('--wait-seconds', type=int, default=0)
    args = parser.parse_args(argv)
    if not 0 <= args.wait_seconds <= 45:
        parser.error('--wait-seconds must be 0..45')
    try:
        # This helper is used by SYSTEM-task deployment; never silently honor a
        # process-only credential/config override while the tasks use defaults.
        if any(os.environ.get(name) for name in ('DATY_TLS_FILE', 'DATY_PAIRING_FILE')):
            raise VerificationError('部署检查拒绝环境变量覆盖；请使用 SYSTEM 共用的默认 ProgramData 安全目录')
        preflight()
        deadline = time.monotonic() + args.wait_seconds
        while True:
            try:
                result = verify_running(bridge_only=args.bridge_only) if args.verify_running else preflight()
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0
            except (OSError, ValueError, http.client.HTTPException):
                if not args.verify_running or time.monotonic() >= deadline:
                    raise
                time.sleep(0.3)
    except (OSError, ValueError, http.client.HTTPException) as error:
        # Never echo raw endpoint bodies, registry hashes or token parser content.
        message = str(error) if isinstance(error, VerificationError) else 'TLS、注册表或安全服务核验失败；检查本机配置、证书、端口与任务日志'
        print(json.dumps({'ready': False, 'error': message}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
