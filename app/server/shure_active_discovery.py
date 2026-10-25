"""Server-owned Shure discovery. Bounded discovery GET and continuous ULXD meter sessions; no MQTT impersonation.

RFutils architecture reference (MIT): see docs/shure-active-discovery-analysis.md.
Protocol decoding and units follow Shure's model-specific public documentation.
"""
from __future__ import annotations

import concurrent.futures
import copy
import ipaddress
import json
import os
import platform
import socket
import subprocess
import threading
import time

from shure_hardware import band_identity
from shure_protocol import MAX_REPLY, ShureReply, extract_framed_messages
from shure_metering import ShureMeterSession
from shure_known_receivers import KnownReceivers, local_targets

PROTOCOL = 'daty-shure-discovery-v1'
SHURE_COMMAND_PORT = 2202
MAX_TARGETS = 1024
MAX_RECEIVERS = 64  # 4 bounded batches + 5s wait remain within the 15s online TTL.
ONLINE_SECONDS = 15


def local_interfaces():
    """Read actual addresses/masks. Windows child is hidden; no system changes."""
    if platform.system() == 'Windows':
        command = ("Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | "
                   "Where-Object {$_.AddressState -eq 'Preferred' -and $_.InterfaceAlias -notlike '*Loopback*'} | "
                   "Select-Object IPAddress,PrefixLength,InterfaceAlias | ConvertTo-Json -Compress")
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                                capture_output=True, timeout=8, creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            raise RuntimeError('无法读取可用网卡')
        data = json.loads(result.stdout.decode('utf-8-sig', errors='replace') or '[]')
        return [{'address': d['IPAddress'], 'prefix': d['PrefixLength'], 'name': d.get('InterfaceAlias', '')}
                for d in (data if isinstance(data, list) else [data])]
    # An optional system provider outside Windows; fail explicitly without masks.
    try:
        import psutil
        stats = psutil.net_if_stats()
        return [{'address': a.address, 'prefix': a.netmask, 'name': name}
                for name, addrs in psutil.net_if_addrs().items() if stats.get(name) and stats[name].isup
                for a in addrs if a.family == socket.AF_INET and a.netmask]
    except ImportError as exc:
        raise RuntimeError('此系统需要可提供网卡掩码的接口适配器') from exc


def scan_targets(interfaces, extra_hosts=()):
    targets, scopes, networks, local = set(), [], [], set()
    for item in interfaces:
        try:
            address = ipaddress.IPv4Address(item['address'])
            interface = ipaddress.IPv4Interface(f"{address}/{item['prefix']}")
        except (KeyError, TypeError, ValueError):
            continue
        if address.is_loopback or address.is_multicast or address.is_unspecified or item.get('up') is False:
            continue
        local.add(address)
        network = interface.network
        if network.prefixlen >= 31:
            continue  # No sweep of point-to-point interfaces.
        networks.append(network)
        sweep = network if network.prefixlen >= 24 else ipaddress.IPv4Network(f'{address}/24', strict=False)
        scopes.append({'address': str(address), 'network': str(network), 'scan_network': str(sweep),
                       'limited_to_24': network.prefixlen < 24})
        targets.update(ip for ip in sweep.hosts() if ip in network and ip not in (network.network_address, network.broadcast_address))
    for text in extra_hosts:
        try:
            ip = ipaddress.IPv4Address(text)
        except ValueError:
            raise ValueError('DATY_SHURE_HOSTS必须是IPv4地址列表') from None
        if not any(ip in n and ip not in (n.network_address, n.broadcast_address) for n in networks):
            raise ValueError('额外舒尔目标必须位于服务器的直连子网内')
        targets.add(ip)
    targets.difference_update(local)
    if len(targets) > MAX_TARGETS:
        raise ValueError('有效扫描目标超过1024，请精简可用网卡')
    return [str(ip) for ip in sorted(targets)], scopes


def probe_shure_sync(host, timeout=1.5, *, port=SHURE_COMMAND_PORT, stop=None, connect_timeout=.35):
    """Return protocol-confirmed receiver data, never infer Shure from an open port.

    Total read deadline and byte/frame limits apply even to continuous garbage.
    Every exit closes the socket, including connect errors and cancellation.
    """
    ipaddress.IPv4Address(host)
    if stop is not None and stop.is_set():
        return None
    start = time.monotonic()
    reply, pending, total, qlxd_query = ShureReply(), '', 0, False
    try:
        with socket.create_connection((host, port), timeout=min(timeout, connect_timeout)) as sock:
            sock.sendall(b'< GET MODEL >\r\n< GET 0 ALL >\r\n< GET NET_SETTINGS SC >\r\n< GET RF_BAND >\r\n')
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if stop is not None and stop.is_set():
                    return None
                sock.settimeout(min(.2, max(.001, deadline - time.monotonic())))
                try:
                    chunk = sock.recv(8192)
                except socket.timeout:
                    if reply.complete():
                        break
                    continue
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_REPLY:
                    return None
                frames, pending = extract_framed_messages(pending + chunk.decode('ascii'))
                for frame in frames:
                    reply.feed(frame)
                if reply.model == 'QLXD4' and not qlxd_query:
                    # The QLXD detailed command table is not publicly established here.
                    # Safe single-channel GET fallback; no telemetry-unit assumptions.
                    sock.sendall(b'< GET 1 ALL >\r\n')
                    qlxd_query = True
    except (OSError, UnicodeError, ValueError):
        return None
    if not reply.model or (stop is not None and stop.is_set()):
        return None
    channels = reply.channel_values()
    receiver_id = f'Shure-{reply.model}-{host}'
    return {'ip': host, 'receiver_ip': host, 'receiver_id': receiver_id, 'identity_basis': 'model-ip-endpoint',
            'type': 'receiver', 'brand': 'Shure', 'model': reply.model, 'model_display': reply.model_display,
            'device_name': reply.device_name, 'device_id': reply.device_name, 'hostname': '', 'version': reply.firmware or '',
            'label': f'Shure {reply.model}', 'ports': [port],
            'protocols': [{'port': port, 'desc': 'Shure Command Strings · 只读', 'proto': 'Shure'}],
            'channels': {str(ch): {'channel_number': ch, **values} for ch, values in sorted(channels.items())},
            'channel_count': len(channels), 'complete': reply.complete(), 'verified': True,
            'settings': reply.settings,
            'protocol_verified': reply.model != 'QLXD4', 'hardware_verified': False,
            'latency_ms': round((time.monotonic() - start) * 1000), 'discovered_via': 'shure-scp',
            'ts': time.time()}


class ShureDiscovery:
    """One scan at a time; independent polling keeps receivers fresh during scans."""
    def __init__(self, on_update, *, interfaces=local_interfaces, probe=probe_shure_sync,
                 interval=60, poll_interval=5, extra_hosts=(), enabled=True, auto_scan=True, known_path=None):
        self.on_update, self.interfaces, self.probe = on_update, interfaces, probe
        self.interval, self.poll_interval, self.extra_hosts = interval, poll_interval, tuple(extra_hosts)
        self.enabled = enabled
        self.auto_scan = auto_scan  # MQTT runtime polls known peers without replaying scans.
        self.known = KnownReceivers(known_path) if known_path is not None else None
        self.reconnect_hosts = []
        self.reconnect_scope_error = None
        self.identity_conflicts = set()
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.scan_cancel = threading.Event()
        self.receivers, self.busy = {}, set()
        self.meters = {}
        self.metering = probe is probe_shure_sync
        self.generation = 0
        self.thread = None
        self.state = {'protocol': PROTOCOL, 'enabled': enabled, 'scanning': False, 'progress': 0,
                      'generation': 0, 'targets': 0, 'scanned': 0, 'scopes': [], 'error': None,
                      'started_at': None, 'completed_at': None, 'cancelled': False}

    def snapshot(self):
        with self.lock:
            result = copy.deepcopy(self.state)
            now = time.time()
            result['receivers'] = [copy.deepcopy(r) for _, r in sorted(self.receivers.items()) if now-r['ts'] < ONLINE_SECONDS]
            for receiver in result['receivers']:
                receiver['hardware_band']=band_identity(receiver.get('model'),receiver.get('settings',{}))
            result['count'] = len(result['receivers'])
            result['health'] = self.health()
            if self.known is not None:
                result['reconnect'] = {'known_count': len(self.known.targets()),
                    'eligible_count': len(self.reconnect_hosts), 'identity_conflicts': sorted(self.identity_conflicts),
                    'error': self.known.error or self.reconnect_scope_error}
            return result

    def health(self):
        """DATY SCP session health, without extra requests or retained-online claims.

        Active means verified TCP plus fresh SAMPLE; stale means verified TCP
        with expired/missing SAMPLE; recovering means disconnected/unverified.
        Receiver online also requires recent real metadata/SAMPLE and excludes
        a closed meter socket immediately. Stopped totals remain diagnostic.
        """
        with self.lock:
            stopped = self.stop_event.is_set()
            running = self.enabled and not stopped
            sessions = {'total': len(self.meters), 'active': 0, 'recovering': 0, 'stale': 0}
            states = {host: meter.health() for host, meter in self.meters.items()}
            online = 0
            if running:
                for item in states.values():
                    key = ('recovering' if not item['connected'] or not item['verified'] else
                           'active' if item['sample_fresh'] else 'stale')
                    sessions[key] += 1
                now = time.time()
                for host, receiver in self.receivers.items():
                    item = states.get(host)
                    if item is None:
                        online += 0 <= now - receiver['ts'] < ONLINE_SECONDS
                    elif item['connected'] and item['verified'] and item['received_age'] is not None:
                        online += item['received_age'] < ONLINE_SECONDS
            errors = [item for item in states.values() if item['last_error']]
            latest = max(errors, key=lambda item: item['last_error_at'] or 0) if errors else None
            last_error = ((latest['last_error'] if latest else None) or self.state.get('error') or
                          (self.known.error if self.known else None) or self.reconnect_scope_error)
            state = ('disabled' if not self.enabled else 'stopped' if stopped else
                     'recovering' if sessions['recovering'] or sessions['stale'] else 'ready' if online else 'idle')
            return {'provider': 'daty-scp', 'enabled': self.enabled, 'stopped': stopped,
                    'state': state, 'receivers_online': online, 'monitoring': sessions, 'last_error': last_error}

    def start(self):
        if self.enabled and self.thread is None:
            self.thread = threading.Thread(target=self._loop, name='Shure-readonly', daemon=True)
            self.thread.start()

    def stop(self):
        with self.lock:
            self.stop_event.set()
            self.scan_cancel.set()
            self.generation += 1
            self.state.update(scanning=False, cancelled=True)
            meters = list(self.meters.values())
            for meter in meters: meter.stop()
        deadline = time.monotonic() + 2
        for meter in meters:
            meter.thread.join(max(0, deadline - time.monotonic()))

    def cancel_scan(self):
        with self.lock:
            self.scan_cancel.set()
        return self.snapshot()

    def request_scan(self):
        with self.lock:
            if not self.enabled or self.stop_event.is_set() or self.state['scanning']:
                return self.snapshot()
            self.generation += 1
            generation = self.generation
            self.scan_cancel = threading.Event()
            self.state.update(scanning=True, progress=0, scanned=0, targets=0, scopes=[], error=None,
                              started_at=time.time(), completed_at=None, cancelled=False, generation=generation)
            thread = threading.Thread(target=self._scan, args=(generation, self.scan_cancel), name='Shure-scan', daemon=True)
            thread.start()
            return self.snapshot()

    def _visit(self, host, cancel=None, generation=None):
        with self.lock:
            if host in self.busy or host in self.meters or self.stop_event.is_set() or (cancel and cancel.is_set()):
                return
            self.busy.add(host)
        try:
            result = self.probe(host, stop=cancel or self.stop_event)
            if not result:
                return
            with self.lock:
                if self.stop_event.is_set() or (cancel and cancel.is_set()) or (generation is not None and generation != self.generation):
                    return
                settings=result.get('settings',{})
                if settings.get('network_ip') and settings['network_ip']!=host:
                    self.identity_conflicts.add(host)
                    return
                # Hints do not veto freshly observed receivers. Use the actual
                # MAC when available, so a replacement never inherits the old ID.
                mac=settings.get('receiver_mac')
                if mac and result.get('identity_basis')!='systemapi-hardware-identity':
                    result=copy.deepcopy(result)
                    result['receiver_id']='Shure-'+result['model']+'-'+mac.replace(':','')
                self.identity_conflicts.discard(host)
                if host not in self.receivers and len(self.receivers) >= MAX_RECEIVERS:
                    self.state['error'] = '已达到64台舒尔读取上限；其余目标尚未接入'
                    return
                # Fresh response only; persistent channel merging belongs to Bridge.
                self.on_update(copy.deepcopy(result))
                self.receivers[host] = copy.deepcopy(result)
                if self.known is not None:
                    self.known.remember(result)
                if self.metering and result['model'] in ('ULXD4', 'ULXD4D', 'ULXD4Q', 'AD4D', 'AD4Q'):
                    meter = ShureMeterSession(result, lambda update: self._meter_update(host, update))
                    self.meters[host] = meter
                    meter.start()
        except Exception:
            with self.lock:
                self.state['error'] = '舒尔读取或存储失败；已有设备将按真实最后回复时间过期'
        finally:
            with self.lock:
                self.busy.discard(host)

    def _meter_update(self, host, update):
        with self.lock:
            if self.stop_event.is_set() or host not in self.meters:
                return
            self.on_update(copy.deepcopy(update))
            previous = self.receivers[host]
            received = update.get('observation_received', True)
            channels = copy.deepcopy(previous['channels'])
            for channel, values in update['channels'].items():
                current = channels.setdefault(channel, {})
                times = {**current.get('field_times', {}), **values.get('field_times', {})}
                current.update(values)
                if times:
                    current['field_times'] = times
            self.receivers[host] = {**previous, **update, 'channels': channels,
                                   'ts': update['ts'] if received else previous['ts']}

    def _scan(self, generation, cancel):
        try:
            targets, scopes = scan_targets(self.interfaces(), self.extra_hosts)
            with self.lock:
                if generation != self.generation or self.stop_event.is_set():
                    return
                self.state.update(targets=len(targets), scopes=scopes)
            # Batches bound queued work as well as concurrent sockets.
            with concurrent.futures.ThreadPoolExecutor(max_workers=16, thread_name_prefix='Shure-probe') as pool:
                for start in range(0, len(targets), 16):
                    if cancel.is_set() or self.stop_event.is_set():
                        break
                    futures = [pool.submit(self._visit, host, cancel, generation) for host in targets[start:start+16]]
                    for future in concurrent.futures.as_completed(futures):
                        future.result()
                        with self.lock:
                            if generation == self.generation:
                                self.state['scanned'] += 1
                                self.state['progress'] = round(self.state['scanned'] * 100 / max(1,len(targets)))
        except Exception as exc:
            with self.lock:
                if generation == self.generation:
                    self.state['error'] = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else '无法建立舒尔扫描任务'
        finally:
            with self.lock:
                if generation == self.generation:
                    self.state.update(scanning=False, completed_at=time.time(), cancelled=cancel.is_set())

    def _loop(self):
        last_scan = float('-inf')
        next_scope_refresh, known_keys = 0, ()
        while not self.stop_event.is_set():
            now = time.monotonic()
            if self.auto_scan and now-last_scan >= self.interval:
                self.request_scan()
                last_scan = now
            if self.known is not None:
                self.known.flush()
                keys = tuple(self.known.targets())
                if keys != known_keys or now >= next_scope_refresh:
                    try:
                        # Only stored endpoints, never a startup subnet sweep.
                        eligible = local_targets(self.interfaces(), keys) if keys else []
                        with self.lock:
                            self.reconnect_hosts = eligible
                            self.reconnect_scope_error = ('部分舒尔重连地址不在当前直连子网，已跳过' if len(eligible) != len(keys) else None)
                    except Exception:
                        with self.lock:
                            self.reconnect_hosts = []
                            self.reconnect_scope_error = '无法读取当前网卡，舒尔启动重连等待重试'
                    known_keys, next_scope_refresh = keys, now + min(self.interval, 30)
            with self.lock:
                # Retain bounded candidates for reconnect, prune long-absent entries.
                expired = [ip for ip,r in self.receivers.items() if time.time()-r['ts'] >= 3600]
                for ip in expired:
                    meter = self.meters.pop(ip, None)
                    if meter: meter.stop()
                    self.receivers.pop(ip, None)
                hosts = list(dict.fromkeys([*self.receivers, *self.reconnect_hosts]))
            with concurrent.futures.ThreadPoolExecutor(max_workers=16, thread_name_prefix='Shure-read') as pool:
                for _ in pool.map(self._visit, hosts):
                    pass
            self.stop_event.wait(self.poll_interval)


def configured_discovery(on_update):
    extra = [v.strip() for v in os.environ.get('DATY_SHURE_HOSTS', '').split(',') if v.strip()]
    return ShureDiscovery(on_update, extra_hosts=extra, enabled=os.environ.get('DATY_SHURE_DISCOVERY', '1') != '0')
