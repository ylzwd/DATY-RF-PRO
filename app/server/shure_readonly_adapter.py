#!/usr/bin/env python3
"""Shure SCP/ASCII 只读适配器。

只解析公开的 ``< REP ... >`` / ``< SAMPLE ... >`` 状态帧并生成 GET 查询。
本模块故意不实现 SET；在没有实机与型号协议表验证前，任何写操作都会被拒绝。
"""

from __future__ import annotations

import re
from dataclasses import dataclass


CAPABILITIES = {
    'discover': True,
    'read_frequency': True,
    'write_frequency': False,
    'read_rf': True,
    'read_af': True,
    'mute': False,
    'scan': False,
    'read_only': True,
    'adapter': 'shure-scp-readonly',
}

_FRAME_RE = re.compile(r'^<\s*(REP|SAMPLE)\s+(?:(\d+)\s+)?([A-Z0-9_]+)(?:\s+(.*?))?\s*>$')
_ALLOWED_GET_PROPERTIES = frozenset({'FREQUENCY', 'RF_LEVEL', 'AUDIO_LEVEL', 'BATT_BARS', 'DEVICE_ID', 'MODEL'})


@dataclass(frozen=True)
class ShureStatusFrame:
    frame_type: str
    channel: int | None
    property: str
    value: str


def parse_status_frame(frame: str) -> ShureStatusFrame:
    """解析单条状态帧；拒绝 SET、命令回显及无法识别的输入。"""
    match = _FRAME_RE.fullmatch(str(frame).strip())
    if not match:
        raise ValueError('不是受支持的 Shure 只读状态帧')
    frame_type, channel, property_name, value = match.groups()
    return ShureStatusFrame(frame_type, int(channel) if channel else None, property_name, (value or '').strip())


def build_get_query(property_name: str, channel: int | None = None) -> bytes:
    """构造白名单 GET 查询；不会接受任意协议文本。"""
    normalized = str(property_name).strip().upper()
    if normalized not in _ALLOWED_GET_PROPERTIES:
        raise ValueError(f'属性不在只读白名单中: {normalized}')
    if channel is None:
        return f'< GET {normalized} >\r\n'.encode('ascii')
    if not isinstance(channel, int) or channel < 1 or channel > 64:
        raise ValueError('通道必须是 1～64 的整数')
    return f'< GET {channel} {normalized} >\r\n'.encode('ascii')


def send_control_command(*_args, **_kwargs):
    raise PermissionError('Shure SCP 适配器为只读，禁止 SET/控制命令')

