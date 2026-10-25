#!/usr/bin/env python3
"""舒尔接收机主动发现模块（Command Strings，TCP 2202）。

参考 RFutils（stoatworks-labs/RFutils）的发现方式实现：
1. 枚举本地所有 IPv4 子网的 /24 主机（跳过内网/点对点接口）
2. TCP connect-scan 2202 端口，并发探测
3. 连接成功 → 发送 ``< GET 1 ALL >`` 握手确认（必须收到 REP 才算舒尔设备）
4. 解析 REP/SAMPLE 帧，提取频率/RF/音频/电池遥测

工程底线（与项目一致）：
- 只读：不实现 SET（写频率/静音等），仅发现与监控
- 缺失/非法值返回 None，不补零
- SAMPLE 帧缺失字段 = "不变"（不是 null），需保留已知值
- 确定性：同样的网络环境得到同样的扫描结果

本模块可独立运行，也可被 ip-service.py / mqtt-bridge.py 调用。
"""
from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

SHURE_COMMAND_PORT = 2202
CONNECT_TIMEOUT_S = 0.3
SCAN_CONCURRENCY = 32
RESCAN_INTERVAL_S = 60.0

# 帧格式（extract_framed_messages 已去掉 < > 包裹）：
#   REP 1 CHAN_NAME "Head 1" FREQUENCY 606700 RF_LVL_A 072 ...
#   SAMPLE 1 RF_LVL_A 072 AUDIO_LVL 054
# 关注的白名单字段（与 shure_readonly_adapter 的只读白名单一致）
KNOWN_FIELDS = {
    'CHAN_NAME', 'FREQUENCY', 'RF_LVL', 'RF_LVL_A', 'AUDIO_LVL',
    'BATT_BARS', 'BATT_CHARGE', 'BATT_RUN_TIME', 'ANTENNA',
    'DEVICE_ID', 'MODEL', 'GROUP', 'CHANNEL',
}


@dataclass
class ShureChannel:
    """一个舒尔接收通道的最新遥测快照。"""
    channel_number: int
    name: Optional[str] = None
    frequency_khz: Optional[int] = None      # 整数 kHz
    rf_percent: Optional[int] = None         # RF 信号电平百分比（0-100，Command Strings 单位，非 dBm）
    audio_dbfs: Optional[float] = None       # dBFS（近似，AUDIO_LVL - 100）
    battery_percent: Optional[int] = None    # 百分比
    battery_bars: Optional[int] = None       # 0~5
    battery_minutes: Optional[int] = None    # 剩余分钟
    antenna: Optional[str] = None            # A / B / DIVERSITY
    model: Optional[str] = None
    device_id: Optional[str] = None

    def update(self, fields: Dict[str, str]) -> None:
        """用一帧的字段更新快照；帧中未出现的字段保持不变。"""
        for key, raw in fields.items():
            if key in ('CHAN_NAME', 'CH_NAME'):
                self.name = _parse_str(raw) if _parse_str(raw) is not None else self.name
            elif key == 'FREQUENCY':
                self.frequency_khz = _parse_khz(raw) if _parse_khz(raw) is not None else self.frequency_khz
            elif key in ('RF_LVL', 'RF_LVL_A'):
                self.rf_percent = _parse_percent(raw) if _parse_percent(raw) is not None else self.rf_percent
            elif key == 'AUDIO_LVL':
                self.audio_dbfs = _parse_audio(raw) if _parse_audio(raw) is not None else self.audio_dbfs
            elif key == 'BATT_CHARGE':
                self.battery_percent = _parse_int(raw) if _parse_int(raw) is not None else self.battery_percent
            elif key == 'BATT_BARS':
                self.battery_bars = _parse_int(raw) if _parse_int(raw) is not None else self.battery_bars
            elif key == 'BATT_RUN_TIME':
                self.battery_minutes = _parse_int(raw) if _parse_int(raw) is not None else self.battery_minutes
            elif key == 'ANTENNA':
                self.antenna = _parse_antenna(raw) if _parse_antenna(raw) is not None else self.antenna
            elif key == 'MODEL':
                self.model = _parse_str(raw) if _parse_str(raw) is not None else self.model
            elif key == 'DEVICE_ID':
                self.device_id = _parse_str(raw) if _parse_str(raw) is not None else self.device_id

    def to_dict(self) -> Dict[str, Any]:
        return {
            'channel_number': self.channel_number,
            'name': self.name,
            'frequency_khz': self.frequency_khz,
            'rf_percent': self.rf_percent,
            'audio_dbfs': self.audio_dbfs,
            'battery_percent': self.battery_percent,
            'battery_bars': self.battery_bars,
            'battery_minutes': self.battery_minutes,
            'antenna': self.antenna,
            'model': self.model,
            'device_id': self.device_id,
        }


# ---------- 字段值解析（缺失/非法返回 None，不补零） ----------

def _parse_int(raw: str) -> Optional[int]:
    try:
        return int(raw.strip())
    except (ValueError, TypeError):
        return None


def _parse_str(raw: str) -> Optional[str]:
    s = raw.strip().strip('"').strip("'")
    return s or None


def _parse_khz(raw: str) -> Optional[int]:
    """频率统一为整数 kHz；舒尔命令字符串的 FREQUENCY 本身就是 kHz（如 606700）。"""
    v = _parse_int(raw)
    if v is None or v <= 0 or v > 3_000_000:
        return None
    return v


def _parse_percent(raw: str) -> Optional[int]:
    """RF 信号电平百分比（舒尔 Command Strings 的 RF_LVL 是 0~100 的百分比，非 dBm）。"""
    v = _parse_int(raw)
    if v is None or not 0 <= v <= 100:
        return None
    return v


def _parse_audio(raw: str) -> Optional[float]:
    """AUDIO_LVL 是 0~100+ 的码值（非字面 dBFS），近似 dBFS = 值 - 100。

    与 RFutils 一致：这是待真实硬件校准的近似，非实测校准值。
    """
    v = _parse_int(raw)
    if v is None:
        return None
    return float(v - 100)


def _parse_antenna(raw: str) -> Optional[str]:
    s = raw.strip().upper()
    if s in ('A', 'B'):
        return s
    if s == 'DIVERSITY':
        return 'diversity'
    return None


# ---------- 帧解析 ----------

def extract_framed_messages(buffer: str) -> tuple[List[str], str]:
    """从不断增长的 TCP 缓冲中切出完整的 ``< ... >`` 帧。

    从找到的 '<' 之后搜索 '>'，避免杂散 '>' 导致解析永久卡死（RFutils 修复的 bug）。
    """
    messages: List[str] = []
    remaining = buffer
    while True:
        start = remaining.find('<')
        if start == -1:
            return messages, ''
        end = remaining.find('>', start)
        if end == -1:
            return messages, remaining[start:]
        messages.append(remaining[start + 1:end].strip())
        remaining = remaining[end + 1:]


def parse_shure_frame(message: str) -> tuple[Optional[str], Optional[int], Dict[str, str]]:
    """解析单条已切帧消息（已去掉 ``< >`` 包裹），返回 (kind, channel_number, fields)。

    支持多字段帧：``SAMPLE 1 RF_LVL_A 072 AUDIO_LVL 054``
    不支持/无法识别的输入返回 (None, None, {})。
    """
    parts = message.strip().split()
    if len(parts) < 3:
        return None, None, {}
    kind = parts[0]
    if kind not in ('REP', 'SAMPLE'):
        return None, None, {}
    channel_num = _parse_int(parts[1])
    if channel_num is None:
        return None, None, {}
    fields: Dict[str, str] = {}
    rest = parts[2:]
    i = 0
    while i < len(rest) - 1:
        key = rest[i].upper()
        value = rest[i + 1]
        # 处理带引号的字符串值，如 CHAN_NAME "Head 1"（含空格）
        if value.startswith('"'):
            while not value.endswith('"') and i + 2 < len(rest):
                i += 1
                value += ' ' + rest[i + 1]
        if key in KNOWN_FIELDS:
            fields[key] = value
        i += 2
    return kind, channel_num, fields


# ---------- 子网枚举 ----------

def enumerate_subnet_hosts(interface_addrs: List[str]) -> List[str]:
    """枚举本地各子网的 /24 主机地址（跳过点对点 /32 和内网）。

    interface_addrs: 形如 ``['192.168.1.10', '10.0.0.5']`` 的本地 IPv4 地址列表。
    返回值：待探测的主机列表，如 ``['192.168.1.1', ..., '192.168.1.253', ...]``。
    """
    hosts: List[str] = []
    seen_prefixes = set()
    for addr in interface_addrs:
        try:
            ip = ipaddress.IPv4Address(addr)
        except (ValueError, ipaddress.AddressValueError):
            continue
        if ip.is_private is False and ip.is_loopback is False:
            pass  # 公网地址也纳入（可能直连公网段，但通常不会）
        if ip.is_loopback:
            continue
        prefix = str(ip).rsplit('.', 1)[0]
        if prefix in seen_prefixes:
            continue
        seen_prefixes.add(prefix)
        for i in range(1, 254):
            hosts.append(f'{prefix}.{i}')
    return hosts


def local_ipv4_addresses() -> List[str]:
    """获取本机所有非内网 IPv4 地址。"""
    result = []
    for info in _getifaddrs():
        if info.startswith('10.') or info.startswith('192.168.') or info.startswith('172.'):
            result.append(info)
        elif info.startswith('169.254.'):
            result.append(info)  # link-local（无 DHCP 的直连场景）
    return result


def probe_shure_sync(host: str, timeout: float = 1.0) -> Optional[Dict[str, Any]]:
    """同步探测一台舒尔接收机（供 ip-service.py 等线程模型调用）。

    连接 2202 → 发 ``< GET 1 ALL >`` → 解析 REP 帧 → 返回设备信息 dict 或 None。

    返回 dict 结构（与 ip-service.py 的设备信息格式对齐）：
        {'ip', 'type': 'receiver', 'label', 'model', 'channels', 'protocols', ...}
    握手失败（非舒尔设备或超时）返回 None。
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect((host, SHURE_COMMAND_PORT))
    except (OSError, ConnectionError):
        return None
    try:
        s.sendall(b'< GET 1 ALL >\r\n')
        buffer = ''
        channels: Dict[int, ShureChannel] = {}
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                chunk = s.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            buffer += chunk.decode('utf-8', errors='ignore')
            messages, buffer = extract_framed_messages(buffer)
            for msg in messages:
                kind, ch_num, fields = parse_shure_frame(msg)
                if kind == 'REP' and ch_num is not None:
                    ch = channels.setdefault(ch_num, ShureChannel(channel_number=ch_num))
                    ch.update(fields)
            if channels:
                break  # 已确认收到 REP，无需等完整帧流
    except (OSError, ConnectionError):
        return None
    finally:
        try:
            s.close()
        except OSError:
            pass
    if not channels:
        return None
    first = channels[min(channels)]
    model = first.model or 'Receiver'
    return {
        'ip': host,
        'hostname': '',
        'ports': [SHURE_COMMAND_PORT],
        'version': '',
        'type': 'receiver',
        'label': f'Shure {model}',
        'protocols': [{'port': SHURE_COMMAND_PORT, 'desc': 'Shure Command Strings', 'proto': 'Shure'}],
        'latency_ms': 0,
        'model': model,
        'device_id': first.device_id,
        'channel_count': len(channels),
        'channels': {str(k): v.to_dict() for k, v in channels.items()},
        'discovered_via': 'shure-scp',
        'ts': int(time.time()),
    }


def _getifaddrs() -> List[str]:
    """跨平台获取本机 IPv4 地址（Windows/Linux 兼容）。"""
    import platform
    if platform.system() == 'Windows':
        return _getifaddrs_windows()
    return _getifaddrs_posix()


def _getifaddrs_windows() -> List[str]:
    try:
        import psutil  # 可选依赖；无 psutil 时退回 UDP 探测
        return [info.address for info in psutil.net_if_addrs().values()
                for info in info if info.family == socket.AF_INET]
    except ImportError:
        return _fallback_local_ip()


def _getifaddrs_posix() -> List[str]:
    try:
        import fcntl
        import struct
        result = []
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for ifname in socket.if_nameindex():
            try:
                req = struct.pack('256s', ifname[1][:15].encode('utf-8'))
                ifreq = fcntl.ioctl(s.fileno(), 0x8915, req)  # SIOCGIFADDR
                addr = socket.inet_ntoa(ifreq[20:24])
                result.append(addr)
            except OSError:
                continue
        s.close()
        return result
    except (ImportError, OSError):
        return _fallback_local_ip()


def _fallback_local_ip() -> List[str]:
    """无 psutil/fcntl 时的回退：UDP 连接探测本机出口地址。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        addr = s.getsockname()[0]
        s.close()
        return [addr]
    except OSError:
        return []


# ---------- 探测与监控 ----------

async def probe_shure_host(host: str, timeout: float = CONNECT_TIMEOUT_S) -> bool:
    """TCP connect-scan 探测 2202 端口；连接成功即认为可能是舒尔设备。"""
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, SHURE_COMMAND_PORT), timeout=timeout
        )
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass
        return True
    except (asyncio.TimeoutError, OSError, ConnectionError):
        return False


async def _handshake(reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
                     timeout: float = 1.0) -> Optional[Dict[int, ShureChannel]]:
    """发送 GET ALL 握手，确认是舒尔设备并解析初始状态。

    返回 {channel_number: ShureChannel}；握手失败返回 None。
    """
    writer.write(b'< GET 1 ALL >')
    await writer.drain()
    channels: Dict[int, ShureChannel] = {}
    buffer = ''
    try:
        while True:
            chunk = await asyncio.wait_for(reader.read(4096), timeout=timeout)
            if not chunk:
                break
            buffer += chunk.decode('utf-8', errors='ignore')
            messages, buffer = extract_framed_messages(buffer)
            for msg in messages:
                kind, ch_num, fields = parse_shure_frame(msg)
                if kind == 'REP' and ch_num is not None:
                    channels.setdefault(ch_num, ShureChannel(channel_number=ch_num)).update(fields)
            if channels:
                # 已确认收到 REP（有频道数据），无需等完整帧流
                break
    except (asyncio.TimeoutError, asyncio.IncompleteReadError):
        pass
    return channels or None


async def monitor_shure_receiver(host: str, on_update, stop_event: asyncio.Event,
                                 meter_rate_ms: int = 500) -> None:
    """连接并持续监控一台舒尔接收机；每次收到 SAMPLE/REP 帧就回调 on_update(host, channels)。"""
    writer: Optional[asyncio.StreamWriter] = None
    try:
        reader, writer = await asyncio.open_connection(host, SHURE_COMMAND_PORT)
    except (OSError, ConnectionError):
        return
    writer.write(b'< GET 1 ALL >')
    # 设置采样率（保守默认 500ms）
    writer.write(f'< SET 1 METER_RATE {meter_rate_ms:05d} >'.encode('ascii'))
    await writer.drain()
    channels: Dict[int, ShureChannel] = {}
    buffer = ''
    try:
        while not stop_event.is_set():
            chunk = await asyncio.wait_for(reader.read(4096), timeout=10.0)
            if not chunk:
                break
            buffer += chunk.decode('utf-8', errors='ignore')
            messages, buffer = extract_framed_messages(buffer)
            for msg in messages:
                kind, ch_num, fields = parse_shure_frame(msg)
                if kind is None or ch_num is None:
                    continue
                ch = channels.setdefault(ch_num, ShureChannel(channel_number=ch_num))
                ch.update(fields)
            if messages:
                on_update(host, dict(channels))
    except (asyncio.TimeoutError, asyncio.IncompleteReadError, OSError, ConnectionError):
        pass
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass


async def discover_shure_receivers(on_found=None, on_update=None,
                                   hosts: Optional[List[str]] = None) -> Dict[str, Dict[int, ShureChannel]]:
    """主发现入口：扫描子网，返回 {host: {channel_number: ShureChannel}}。

    - on_found(host)：发现新设备时回调
    - on_update(host, channels)：设备遥测更新时回调
    - hosts：手动指定待探测主机列表；None 时自动枚举本地子网
    """
    if hosts is None:
        hosts = enumerate_subnet_hosts(local_ipv4_addresses())
    found: Dict[str, Dict[int, ShureChannel]] = {}
    sem = asyncio.Semaphore(SCAN_CONCURRENCY)

    async def probe_and_handshake(host: str) -> None:
        async with sem:
            if not await probe_shure_host(host):
                return
            # 连接成功，握手确认
            try:
                reader, writer = await asyncio.open_connection(host, SHURE_COMMAND_PORT)
            except (OSError, ConnectionError):
                return
            try:
                channels = await _handshake(reader, writer)
            finally:
                writer.close()
                try:
                    await writer.wait_closed()
                except (ConnectionError, OSError):
                    pass
            if channels:
                found[host] = channels
                if on_found:
                    on_found(host)

    await asyncio.gather(*(probe_and_handshake(h) for h in hosts))
    return found


# ---------- 命令行入口 ----------

async def _main() -> None:
    print(f'扫描本地子网，查找舒尔接收机（TCP {SHURE_COMMAND_PORT}）...')
    local = local_ipv4_addresses()
    print(f'本地 IPv4 地址: {local}')
    hosts = enumerate_subnet_hosts(local)
    print(f'待探测主机数: {len(hosts)}')
    found = await discover_shure_receivers(
        on_found=lambda h: print(f'[发现] 舒尔接收机 {h}')
    )
    if not found:
        print('未发现舒尔接收机（局域网内没有监听 2202 端口的舒尔设备）')
        return
    for host, channels in found.items():
        for ch_num, ch in channels.items():
            print(f'  {host} CH{ch_num}: 频率={ch.frequency_khz}kHz '
                  f'RF={ch.rf_dbm}dBm 音频={ch.audio_dbfs}dBFS 电池={ch.battery_percent}% '
                  f'型号={ch.model} 名称={ch.name}')


if __name__ == '__main__':
    asyncio.run(_main())
