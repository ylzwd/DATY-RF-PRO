"""Bounded reconnect hints, never saved telemetry, GROUPs or control intents.

Only fresh SCP identity can turn a hint into an online receiver. Persistence
failure is reported without interrupting the live telemetry path.
"""
from pathlib import Path
import copy
import ipaddress
import json
import os
import re
import tempfile
import threading

from shure_protocol import MODELS

SCHEMA = 'daty-shure-known-receivers-v1'
MAX_KNOWN = 64
MAX_BYTES = 32768


def identity(value):
    if not isinstance(value, dict) or set(value) != {'ip', 'model', 'mac'}:
        raise ValueError('Invalid reconnect identity')
    ip = ipaddress.IPv4Address(value['ip'])
    if ip.is_loopback or ip.is_multicast or ip.is_unspecified or int(ip) == 0xffffffff:
        raise ValueError('Unicast receiver address required')
    if value['model'] not in MODELS or not isinstance(value['mac'], str) or not re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}', value['mac']):
        raise ValueError('Verified model and MAC required')
    if int(value['mac'][:2], 16) & 1 or value['mac'] == '00:00:00:00:00:00':
        raise ValueError('Unicast MAC required')
    return {'ip': str(ip), 'model': value['model'], 'mac': value['mac']}


def observed_identity(receiver):
    settings = receiver.get('settings') or {}
    ip = receiver.get('receiver_ip')
    if receiver.get('protocol_verified') is not True or settings.get('network_ip') != ip:
        raise ValueError('Fresh SCP network identity required')
    return identity({'ip': ip, 'model': receiver.get('model'), 'mac': settings.get('receiver_mac')})


def local_targets(interfaces, hosts):
    local, networks = set(), []
    for item in interfaces:
        try:
            interface = ipaddress.IPv4Interface(f"{item['address']}/{item['prefix']}")
        except (KeyError, TypeError, ValueError):
            continue
        if item.get('up') is False or interface.ip.is_loopback or interface.ip.is_multicast or interface.ip.is_unspecified:
            continue
        local.add(interface.ip)
        if interface.network.prefixlen < 31:
            networks.append(interface.network)
    return [host for host in sorted(hosts, key=ipaddress.IPv4Address)
            if ipaddress.IPv4Address(host) not in local and any(
                ipaddress.IPv4Address(host) in net and ipaddress.IPv4Address(host) not in (net.network_address, net.broadcast_address)
                for net in networks)]


class KnownReceivers:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        self.entries = {}
        self.dirty = self.load_failed = False
        self.error = None
        try:
            with self.path.open('rb') as stream:
                raw = stream.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError('Reconnect registry too large')
            data = json.loads(raw)
            if not isinstance(data, dict) or set(data) != {'schema', 'receivers'} or data['schema'] != SCHEMA or not isinstance(data['receivers'], list) or len(data['receivers']) > MAX_KNOWN:
                raise ValueError('Invalid reconnect registry')
            entries = [identity(value) for value in data['receivers']]
            if len({e['ip'] for e in entries}) != len(entries):
                raise ValueError('Duplicate receiver address')
            self.entries = {e['ip']: e for e in entries}
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError, KeyError):
            self.load_failed = True
            self.error = '舒尔重连记录读取失败；原文件保留，可通过手动发现接入'

    def targets(self):
        with self.lock:
            return copy.deepcopy(self.entries)

    def matches(self, receiver):
        with self.lock:
            expected = self.entries.get(receiver.get('receiver_ip'))
            if expected is None:
                return True
            try:
                return observed_identity(receiver) == expected
            except (ValueError, TypeError):
                return False

    def remember(self, receiver):
        try:
            entry = observed_identity(receiver)
        except (ValueError, TypeError):
            return False  # Partial/unsupported observations never become hints.
        with self.lock:
            if entry['ip'] not in self.entries and len(self.entries) >= MAX_KNOWN:
                self.error = '已达到64台舒尔重连记录上限'
                return False
            if self.entries.get(entry['ip']) != entry:
                self.entries[entry['ip']] = entry
                self.dirty = True
            return self.flush()

    def flush(self):
        with self.lock:
            if self.load_failed:
                return False  # Never overwrite an unreadable existing registry.
            if not self.dirty:
                return True
            temporary = None
            try:
                raw = (json.dumps({'schema': SCHEMA, 'receivers': [self.entries[k] for k in sorted(self.entries)]}, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=self.path.parent, prefix=self.path.name + '.', suffix='.tmp', delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
                self.dirty = False
                self.error = None
                return True
            except OSError:
                self.error = '舒尔重连记录保存失败；当前采集继续，重启恢复尚未保存'
                return False
            finally:
                if temporary is not None:
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError:
                        pass
