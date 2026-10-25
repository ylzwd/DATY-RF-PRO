#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DATY RF PRO - 本地服务 v3.0
功能：
  1. 本机 IP 地址查询 API
  2. 局域网 DATY RF PRO 服务器自动发现
  3. UDP 广播心跳（让客户端在局域网中可被发现）

接口列表:
  GET  /api/ip              - 获取最佳本机 IP
  GET  /api/ip/all          - 所有网卡 IP 列表
  GET  /api/ip/refresh      - 强制刷新本机 IP
  GET  /api/discover        - 扫描局域网中的 DATY RF PRO 服务器
  GET  /api/discover/status - 获取最近一次扫描结果（缓存）
  GET  /health              - 服务健康检查
"""

import socket
import json
import platform
import time
import threading
import concurrent.futures
import os
import sys
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

_service_dir = os.path.dirname(os.path.abspath(__file__))
if _service_dir not in sys.path:
    sys.path.insert(0, _service_dir)
from http_transport import HttpTransportMixin, HttpRequestError, PROTOCOL as HTTP_PROTOCOL
from tls_support import server_context, client_context, bind_https, TLSConfigurationError
from shure_active_discovery import probe_shure_sync

# ── 全局配置 ──────────────────────────────────────────────────────────
DATY_APP_VERSION = '1.0.3'  # DATY RF PRO 服务器产品版本
LOCAL_SERVICE_VERSION = '3.0'
SERVICE_PORT = 8765          # 本服务监听端口

# DATY RF PRO 服务端识别端口列表（按优先级）
DATY_SERVER_PORTS = [
    8800,   # AMSaudio 私有协议
    8801,   # DATY RF PRO HTTP API（如有）
    8080,   # 备用 HTTP
    9000,   # 备用
]
DATY_DISCOVERY_PORT = 8899   # UDP 广播发现端口（DATY RF PRO 服务端广播心跳）

SCAN_TIMEOUT  = 0.4          # 单个 IP TCP 探测超时（秒）
SCAN_WORKERS  = 80           # 并发扫描线程数
SCAN_CACHE_TTL = 30          # 扫描结果缓存时间（秒）

# ── IP 缓存 ───────────────────────────────────────────────────────────
_ip_cache     = {'ips': [], 'ts': 0}
_IP_CACHE_TTL = 10

# ── 扫描结果缓存 ──────────────────────────────────────────────────────
_scan_cache   = {'servers': [], 'ts': 0, 'scanning': False}


class ExclusiveThreadingHTTPServer(ThreadingHTTPServer):
    """HTTP server which owns its port exclusively on Windows.

    ``HTTPServer.allow_reuse_address`` defaults to ``True`` on CPython.  On
    Windows that maps to ``SO_REUSEADDR`` and, unlike POSIX, can allow two
    independent processes to listen on the same port.  Requests then land in
    either process (often an old copy of the service), which is exactly the
    failure mode that made the device/channel view appear to change at random.
    Use ``SO_EXCLUSIVEADDRUSE`` before binding so a second task fails fast
    instead of creating a second service instance.
    """

    allow_reuse_address = False

    def server_bind(self):
        if platform.system() == 'Windows':
            option = getattr(socket, 'SO_EXCLUSIVEADDRUSE', None)
            if option is not None:
                self.socket.setsockopt(socket.SOL_SOCKET, option, 1)
        super().server_bind()


# ════════════════════════════════════════════════════════════════════
#  IP 工具函数
# ════════════════════════════════════════════════════════════════════

def is_private_ip(ip: str) -> bool:
    try:
        parts = list(map(int, ip.split('.')))
        if len(parts) != 4: return False
        a, b = parts[0], parts[1]
        if a == 10: return True
        if a == 172 and 16 <= b <= 31: return True
        if a == 192 and 168 <= b <= 175: return True
        return False
    except Exception:
        return False


def get_local_ips(force_refresh: bool = False) -> list:
    global _ip_cache
    now = time.time()
    if not force_refresh and _ip_cache['ips'] and (now - _ip_cache['ts']) < _IP_CACHE_TTL:
        return _ip_cache['ips']

    all_ips, seen = [], set()

    def add(ip):
        if ip and ip != '127.0.0.1' and not ip.startswith('169.254.') and ip not in seen:
            seen.add(ip); all_ips.append(ip)

    try:
        for _, _, _, _, sa in socket.getaddrinfo(socket.gethostname(), None):
            if len(sa) >= 1: add(sa[0])
    except Exception: pass

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80)); add(s.getsockname()[0]); s.close()
    except Exception: pass

    try:
        import netifaces
        for iface in netifaces.interfaces():
            for addr in netifaces.ifaddresses(iface).get(netifaces.AF_INET, []):
                add(addr.get('addr', ''))
    except ImportError: pass

    def pri(ip):
        if ip.startswith('192.168.'): return 0
        if ip.startswith('192.169.'): return 1
        if ip.startswith('10.'):      return 2
        p = ip.split('.')
        try:
            if len(p) == 4 and int(p[0]) == 172 and 16 <= int(p[1]) <= 31: return 3
        except Exception: pass
        return 4

    private = sorted([ip for ip in all_ips if is_private_ip(ip)], key=pri)
    public  = [ip for ip in all_ips if not is_private_ip(ip)]
    result  = private + public if private else public

    _ip_cache = {'ips': result, 'ts': now}
    return result


def best_ip(ips: list):
    return ips[0] if ips else None


def get_network_prefix(ip: str) -> str:
    """从本机 IP 获取 /24 网段前缀，如 192.168.1"""
    parts = ip.rsplit('.', 1)
    return parts[0] if len(parts) == 2 else ip


# ════════════════════════════════════════════════════════════════════
#  局域网服务器扫描
# ════════════════════════════════════════════════════════════════════

def _tcp_probe(ip: str, port: int, timeout: float = SCAN_TIMEOUT) -> bool:
    """TCP 端口探测"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        result = s.connect_ex((ip, port))
        s.close()
        return result == 0
    except Exception:
        return False


def _identify_daty_server(ip: str) -> dict | None:
    """
    尝试连接某 IP 并判断是否是 DATY RF PRO 服务端 或 FAshe 接收机。
    返回设备信息 dict，或 None（未发现任何服务）。
    """
    found_ports = []
    info = {
        'ip': ip,
        'hostname': '',
        'ports': [],
        'version': '',
        'type': '',        # 'server' | 'receiver' | ''
        'label': '',       # 展示用名称
        'protocols': [],
        'latency_ms': 0,
        'ts': int(time.time()),
    }

    t0 = time.time()

    # 探测各协议端口
    port_desc = {
        8800: ('AMSaudio TCP私有协议', 'AMSaudio'),
        8801: ('WS 中转服务',         'WS'),
        8802: ('MQTT Bridge HTTPS',  'HTTPS'),
        8080: ('HTTPS 静态文件',      'HTTPS'),
        8083: ('DATY MQTT WSS',      'MQTTS'),
        1883: ('EMQX MQTT TCP',      'MQTT'),
        9000: ('备用端口',            'TCP'),
        2202: ('Shure SCP',           'Shure'),
        45000: ('Sennheiser SSC',     'Sennheiser'),
    }

    for port, (desc, proto) in port_desc.items():
        if _tcp_probe(ip, port, timeout=0.35):
            found_ports.append(port)
            info['protocols'].append({'port': port, 'desc': desc, 'proto': proto})

    if not found_ports:
        return None

    info['ports'] = found_ports
    info['latency_ms'] = round((time.time() - t0) * 1000)

    # 尝试解析主机名
    try:
        info['hostname'] = socket.gethostbyaddr(ip)[0]
    except Exception:
        info['hostname'] = ''

    # ── 验证阶段：判断是 DATY RF PRO 服务器还是 FAshe 接收机 ──

    # 1) 检查 ws-server 的 /health（8802 端口）—— 确认是 DATY RF PRO 服务器
    if 8802 in found_ports:
        try:
            import urllib.request
            url = f'https://{ip}:8802/health'
            with urllib.request.urlopen(url, timeout=1.0, context=client_context()) as resp:
                data = json.loads(resp.read())
                if data.get('service', '').find('DATY') >= 0 or data.get('status') == 'ok':
                    info['type']    = 'server'
                    info['label']   = 'DATY RF PRO 统一射频管理平台'
                    info['version'] = data.get('app_version', data.get('version', DATY_APP_VERSION))
                    info['verified'] = True
        except Exception:
            pass

    # 2) 备用 HTTPS 验证；旧 8801 也不得回退明文
    if not info.get('verified'):
        for http_port in [8801, 8080]:
            if http_port in found_ports:
                try:
                    import urllib.request
                    url = (f'https://{ip}:8080/health' if http_port == 8080
                           else f'https://{ip}:{http_port}/api/info')
                    with urllib.request.urlopen(url, timeout=1.0,
                            context=client_context()) as resp:
                        data = json.loads(resp.read())
                        if data.get('app') == 'DATY-RF-PRO' or data.get('service', '').startswith('DATY'):
                            info['type']    = 'server'
                            info['label']   = data.get('name', 'DATY RF PRO 统一射频管理平台')
                            info['version'] = data.get('version', DATY_APP_VERSION)
                            info['verified'] = True
                            break
                except Exception:
                    pass

    # 3) 检查 /api/stats（8802 端口）—— 如果有已连接的 FAshe clients，说明此 IP 是接收机的来源
    if not info.get('verified') and 8802 in found_ports:
        try:
            import urllib.request
            url = f'https://{ip}:8802/api/stats'
            with urllib.request.urlopen(url, timeout=1.0, context=client_context()) as resp:
                data = json.loads(resp.read())
                if data.get('success') and data.get('device_count', 0) > 0:
                    info['type']  = 'server'
                    info['label'] = 'DATY RF PRO 统一射频管理平台'
                    info['verified'] = True
        except Exception:
            pass

    # 4) 如果只有 8080 开放（静态文件服务器），检查是否是 FAshe 页面
    if not info.get('verified') and 8080 in found_ports and 8801 not in found_ports and 8802 not in found_ports:
        try:
            import urllib.request
            url = f'https://{ip}:8080/FAshe/'
            req = urllib.request.Request(url, headers={'User-Agent': 'DATY-RF-PRO-Scanner/1.0'})
            with urllib.request.urlopen(req, timeout=1.5, context=client_context()) as resp:
                body = resp.read().decode('utf-8', errors='ignore')
                if 'FAshe' in body and '模拟麦克接收机' in body:
                    info['type']  = 'receiver'
                    info['label'] = 'FAshe 模拟麦克接收机'
                    info['version'] = ''
                    info['verified'] = True
        except Exception:
            pass

    # Anonymous MQTT / legacy plaintext HTTP cannot establish paired receiver
    # identity. Receiver discovery comes from authenticated Bridge sessions;
    # open ports alone never become a verified receiver or control target.

    # 5) 舒尔接收机识别：2202 端口开放时，用 Command Strings 握手确认并提取型号/通道
    if not info.get('verified') and 2202 in found_ports:
        shure_info = probe_shure_sync(ip, timeout=1.0)
        if shure_info:
            info.update(shure_info)
            info['verified'] = True

    # 未识别的设备直接丢弃（路由器、打印机、NAS 等不算 DATY RF PRO 设备）
    if not info.get('type'):
        return None

    return info


def scan_lan_for_daty_servers(local_ip: str = None, progress_cb=None) -> list:
    """
    扫描局域网 /24 段，发现 DATY RF PRO 服务器。
    返回发现的服务器列表。
    """
    if not local_ip:
        ips = get_local_ips()
        if not ips: return []
        local_ip = best_ip(ips)

    prefix = get_network_prefix(local_ip)
    scan_targets = [f'{prefix}.{i}' for i in range(1, 255) if f'{prefix}.{i}' != local_ip]

    results = []
    scanned = 0
    total   = len(scan_targets)

    # 第一步：快速 ping-like 扫描（探测常用端口）
    def check_host(ip):
        nonlocal scanned
        result = _identify_daty_server(ip)
        scanned += 1
        if progress_cb:
            progress_cb(scanned, total, ip, result is not None)
        return result

    with concurrent.futures.ThreadPoolExecutor(max_workers=SCAN_WORKERS) as executor:
        futures = {executor.submit(check_host, ip): ip for ip in scan_targets}
        for fut in concurrent.futures.as_completed(futures):
            res = fut.result()
            if res:
                results.append(res)

    # 按延迟排序（延迟低的排前面）
    results.sort(key=lambda x: x.get('latency_ms', 9999))
    return results


def _fetch_fashe_clients_from_bridge():
    """从 mqtt-bridge 获取已连接的 FAshe 客户端列表"""
    try:
        import urllib.request
        url = 'https://127.0.0.1:8802/api/stats'
        req = urllib.request.Request(url, headers={'User-Agent': 'DATY-RF-PRO/1.0'})
        with urllib.request.urlopen(req, timeout=2.0, context=client_context()) as resp:
            data = json.loads(resp.read())
            clients = data.get('clients', [])
            results = []
            for c in clients:
                ip = c.get('receiver_ip', '')
                if not ip or ip == 'unknown':
                    continue
                # 如果 TCP 扫描已经发现了这个 IP，跳过（避免重复）
                results.append({
                    'ip':       ip,
                    'hostname': '',
                    'ports':   [],
                    'version': '',
                    'type':    'receiver',
                    'label':   'FAshe 模拟麦克接收机',
                    'protocols': [{'port': 0, 'desc': 'MQTT 在线', 'proto': 'MQTT'}],
                    'latency_ms': 0,
                    'discovered_via': 'mqtt_bridge',
                    'ts': int(time.time()),
                })
            return results
    except Exception:
        return []


def _background_scan(local_ip: str = None):
    """后台扫描线程"""
    global _scan_cache
    _scan_cache['scanning'] = True
    _scan_cache['progress'] = 0

    print(f"[发现服务] 开始扫描局域网...")
    t0 = time.time()

    def on_progress(done, total, ip, found):
        _scan_cache['progress'] = round(done / total * 100)
        if found:
            print(f"[发现服务] ✓ 发现服务器: {ip}")

    try:
        servers = scan_lan_for_daty_servers(local_ip, progress_cb=on_progress)
        # 合并已有的 IP 集合，用于去重
        existing_ips = {s['ip'] for s in servers}

        # 从 mqtt-bridge 获取已连接的 FAshe 客户端
        fashe_clients = _fetch_fashe_clients_from_bridge()
        for fc in fashe_clients:
            if fc['ip'] not in existing_ips:
                servers.append(fc)
                existing_ips.add(fc['ip'])

        elapsed = round(time.time() - t0, 1)
        _scan_cache.update({
            'servers':  servers,
            'ts':       time.time(),
            'scanning': False,
            'progress': 100,
            'elapsed':  elapsed,
            'scanned_ip': local_ip,
        })
        print(f"[发现服务] 扫描完成，发现 {len(servers)} 台设备（含 {len(fashe_clients)} 台 MQTT 客户端），耗时 {elapsed}s")
    except Exception as e:
        print(f"[发现服务] 扫描出错: {e}")
        _scan_cache['scanning'] = False


# ════════════════════════════════════════════════════════════════════
#  UDP 广播监听（被动发现 DATY RF PRO 服务器广播）
# ════════════════════════════════════════════════════════════════════

def _udp_broadcast_listener():
    """
    监听 DATY RF PRO 服务端的 UDP 广播心跳（端口 8899）。
    DATY RF PRO 服务端每 5 秒广播一次自己的存在：
      {"app":"DATY-RF-PRO","version":"1.0.3","ip":"xxx","port":8800}
    """
    global _scan_cache
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(1.0)
        sock.bind(('', DATY_DISCOVERY_PORT))
        print(f"[广播监听] 监听 UDP:{DATY_DISCOVERY_PORT} (等待 DATY RF PRO 服务端广播)")

        while True:
            try:
                data, addr = sock.recvfrom(1024)
                payload = json.loads(data.decode('utf-8'))
                if payload.get('app') in ('DATY-RF-PRO', 'DATY RF PRO', 'daty-rf-pro'):
                    server_ip = payload.get('ip', addr[0])
                    # 检查是否已经在列表中
                    existing = [s for s in _scan_cache['servers'] if s['ip'] == server_ip]
                    if not existing:
                        new_entry = {
                            'ip':        server_ip,
                            'hostname':  payload.get('hostname', ''),
                            'ports':     [payload.get('port', 8800)],
                            'version':   payload.get('version', DATY_APP_VERSION),
                            'type':      'DATY RF PRO 统一射频管理平台',
                            'protocols': [{'port': payload.get('port', 8800), 'desc': 'UDP广播发现', 'proto': 'UDP'}],
                            'latency_ms': 0,
                            'discovered_via': 'udp_broadcast',
                            'ts': int(time.time()),
                        }
                        _scan_cache['servers'].insert(0, new_entry)
                        print(f"[广播监听] ✓ 通过 UDP 广播发现服务器: {server_ip}")
            except socket.timeout:
                continue
            except json.JSONDecodeError:
                continue
            except Exception as e:
                if 'WinError' not in str(e):
                    print(f"[广播监听] 异常: {e}")
                time.sleep(1)
    except Exception as e:
        print(f"[广播监听] 无法绑定端口 {DATY_DISCOVERY_PORT}: {e}")


# ════════════════════════════════════════════════════════════════════
#  HTTP 请求处理器
# ════════════════════════════════════════════════════════════════════

class DatyServiceHandler(HttpTransportMixin, BaseHTTPRequestHandler):


    def log_message(self, fmt, *args):
        path = urlparse(self.path).path
        if path != '/api/discover/status':
            print(f"[HTTP] {self.address_string()} → {self.command} {path}")

    def _cors(self):
        self._http_headers()

    def _json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._http_options()

    def do_GET(self):
        if not self._check_origin():
            return
        parsed = urlparse(self.path)
        path   = parsed.path
        params = parse_qs(parsed.query)
        # ── 本机 IP 接口 ────────────────────────────────────────────
        if path == '/api/ip':
            ips = get_local_ips()
            ip  = best_ip(ips)
            self._json({'success': True, 'ip': ip, 'all_ips': ips,
                        'hostname': socket.gethostname(), 'platform': platform.system(),
                        'ts': int(time.time())})

        elif path == '/api/ip/all':
            ips = get_local_ips()
            self._json({'success': True,
                        'ips': [{'ip': ip, 'private': is_private_ip(ip)} for ip in ips],
                        'count': len(ips), 'ts': int(time.time())})

        elif path == '/api/ip/refresh':
            ips = get_local_ips(force_refresh=True)
            ip  = best_ip(ips)
            self._json({'success': True, 'ip': ip, 'all_ips': ips,
                        'refreshed': True, 'ts': int(time.time())})

        # ── 服务器发现接口 ───────────────────────────────────────────
        elif path == '/api/discover':
            # 触发后台扫描（非阻塞）
            now = time.time()
            force = params.get('force', ['0'])[0] == '1'

            if _scan_cache['scanning']:
                # 扫描中，返回当前进度
                self._json({
                    'success': True,
                    'scanning': True,
                    'progress': _scan_cache.get('progress', 0),
                    'servers':  _scan_cache['servers'],
                    'message':  '扫描进行中...',
                })
            elif force or (now - _scan_cache['ts']) > SCAN_CACHE_TTL:
                # 缓存过期或强制刷新，启动新扫描
                ips = get_local_ips()
                local_ip = best_ip(ips)
                t = threading.Thread(target=_background_scan, args=(local_ip,), daemon=True)
                t.start()
                self._json({
                    'success':  True,
                    'scanning': True,
                    'progress': 0,
                    'servers':  _scan_cache['servers'],
                    'message':  f'已启动扫描，网段: {get_network_prefix(local_ip)}.0/24',
                })
            else:
                # 返回缓存结果
                self._json({
                    'success':  True,
                    'scanning': False,
                    'progress': 100,
                    'servers':  _scan_cache['servers'],
                    'count':    len(_scan_cache['servers']),
                    'elapsed':  _scan_cache.get('elapsed', 0),
                    'cached':   True,
                    'cache_age': round(now - _scan_cache['ts']),
                    'ts':       int(_scan_cache['ts']),
                })

        elif path == '/api/discover/status':
            # 轮询扫描进度
            self._json({
                'success':  True,
                'scanning': _scan_cache['scanning'],
                'progress': _scan_cache.get('progress', 0),
                'servers':  _scan_cache['servers'],
                'count':    len(_scan_cache['servers']),
                'elapsed':  _scan_cache.get('elapsed', 0),
                'ts':       int(time.time()),
            })

        # ── 健康检查 ─────────────────────────────────────────────────
        elif path == '/health':
            self._json({
                'status':   'ok',
                'service':  'DATY RF PRO Local Service',
                'version':  DATY_APP_VERSION,
                'app_version': DATY_APP_VERSION,
                'local_service_version': LOCAL_SERVICE_VERSION,
                'features': ['ip_detection', 'lan_discovery', 'udp_broadcast_listen'],
                'control_access': HTTP_PROTOCOL,
                'control_auth_required': False,
                'transport_security': getattr(self.server, 'transport_security', None),
                'ts':       int(time.time()),
            })

        else:
            self._json({'success': False, 'error': 'Not Found'}, status=404)


# ════════════════════════════════════════════════════════════════════
#  启动入口
# ════════════════════════════════════════════════════════════════════

def run_server(port: int = SERVICE_PORT):
    try:
        context = server_context()
    except TLSConfigurationError as error:
        print(f'[服务] {error}', flush=True)
        return 2
    # 检查端口占用
    try:
        test = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        test.settimeout(1)
        if test.connect_ex(('127.0.0.1', port)) == 0:
            print(f"[服务] ⚠️  端口 {port} 已被占用，服务退出")
            test.close(); return
        test.close()
    except Exception: pass

    ips = get_local_ips()
    try:
        server = bind_https(ExclusiveThreadingHTTPServer, ('', port), DatyServiceHandler, context)
    except OSError as error:
        # A duplicate scheduled task must terminate immediately.  Keeping a
        # half-started process alive would only make the next restart harder
        # to diagnose and could still advertise a stale service instance.
        print(f"[服务] 端口 {port} 无法独占（可能已有实例运行）: {error}", flush=True)
        return

    print("=" * 60)
    print("  DATY RF PRO — 本地服务 v3.0")
    print("=" * 60)
    print(f"  服务地址:   https://127.0.0.1:{port}")
    print(f"  IP 接口:    https://127.0.0.1:{port}/api/ip")
    print(f"  发现接口:   https://127.0.0.1:{port}/api/discover")
    print(f"  状态轮询:   https://127.0.0.1:{port}/api/discover/status")
    print(f"  主机名:     {socket.gethostname()}")
    print()
    if ips:
        print("  本机 IP:")
        for ip in ips:
            tag = "[私网]" if is_private_ip(ip) else "[公网]"
            print(f"    {tag} {ip}")
    print()
    print(f"  监听 UDP:{DATY_DISCOVERY_PORT} 等待 DATY RF PRO 服务端广播")
    print("  按 Ctrl+C 停止")
    print("=" * 60)

    # 后台启动 UDP 广播监听
    t_udp = threading.Thread(target=_udp_broadcast_listener, daemon=True)
    t_udp.start()

    # 启动时自动触发一次局域网扫描（后台，不阻塞）
    if ips:
        local_ip = best_ip(ips)
        t_scan = threading.Thread(target=_background_scan, args=(local_ip,), daemon=True)
        t_scan.start()
        print(f"[服务] 自动扫描已启动 → {get_network_prefix(local_ip)}.0/24")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[服务] 已停止")
        server.server_close()


if __name__ == '__main__':
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else SERVICE_PORT
    raise SystemExit(run_server(port))
