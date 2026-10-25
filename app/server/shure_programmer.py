#!/usr/bin/env python3
"""舒尔命令字符串下发模块（Deploy）—— 参考 RFutils shureProgrammer.ts。

通过 Command Strings 协议（明文 ASCII，TCP 2202）向舒尔接收机下发频率。

工程底线（与项目一致）：
- **dry-run 默认**：默认只生成精确命令字符串，不连接设备（RFutils 同款安全设计）
- 实际发送需显式传 ``dry_run=False``，且发送不等于设备执行成功（无 ACK 时无法确认）
- 频率值 6 位 kHz（470.125 MHz → 470125），SET 关键字为 FREQUENCY
- 与 shure_readonly_adapter 的只读底线区分：本模块是**显式可写**路径

⚠️ 未对真实硬件验证：SET 命令的关键字（FREQUENCY）在不同产品线（ULX-D/QLX-D/Axient Digital）
可能不同，下发前务必对照接收机的 Command Strings PDF。
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

SHURE_COMMAND_PORT = 2202
SEND_TIMEOUT_S = 3.0


def shure_freq_value(freq_mhz: float) -> str:
    """舒尔频率值：6 位 kHz。470.125 MHz → '470125'。"""
    return str(round(freq_mhz * 1000)).zfill(6)


def build_shure_set_command(channel: int | str, freq_mhz: float) -> str:
    """构造 SET 命令：< SET 1 FREQUENCY 470125 >。"""
    return f'< SET {channel} FREQUENCY {shure_freq_value(freq_mhz)} >'


def build_set_commands(assignments: List[Dict[str, Any]]) -> List[str]:
    """从频率分配结果生成命令字符串列表（dry-run 输出）。

    assignments: [{'host': '192.168.1.10', 'channel': 1, 'frequency_mhz': 470.125}, ...]
    返回精确的命令字符串（不连接设备）。
    """
    commands = []
    for a in assignments:
        channel = a.get('channel')
        freq_mhz = a.get('frequency_mhz')
        if channel is None or freq_mhz is None:
            continue
        commands.append(build_shure_set_command(channel, freq_mhz))
    return commands


def dry_run(assignments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """dry-run：返回每个分配的精确命令字符串，不连接设备。"""
    result = []
    for a in assignments:
        channel = a.get('channel')
        freq_mhz = a.get('frequency_mhz')
        if channel is None or freq_mhz is None:
            result.append({**a, 'command': None, 'error': '缺少 channel 或 frequency_mhz'})
            continue
        result.append({
            'host': a.get('host'),
            'channel': channel,
            'frequency_mhz': freq_mhz,
            'command': build_shure_set_command(channel, freq_mhz),
        })
    return result


async def send_shure_commands(host: str, commands: List[str],
                              timeout: float = SEND_TIMEOUT_S) -> Dict[str, Any]:
    """短连接发送命令到舒尔接收机，收集回复。

    返回 {'ok': bool, 'reply': str, 'error': Optional[str]}。
    注意：HTTP/命令发送「成功」不等于设备执行成功；无 ACK 协议时无法确认实际频率。
    """
    reply_parts: List[str] = []
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, SHURE_COMMAND_PORT), timeout=timeout
        )
    except (asyncio.TimeoutError, OSError, ConnectionError) as e:
        return {'ok': False, 'reply': '', 'error': f'连接失败: {e}'}

    for cmd in commands:
        writer.write((cmd + '\r\n').encode('ascii'))
    await writer.drain()

    # 给接收机一点时间回 ACK，然后关闭
    try:
        while True:
            chunk = await asyncio.wait_for(reader.read(4096), timeout=0.5)
            if not chunk:
                break
            reply_parts.append(chunk.decode('ascii', errors='ignore'))
    except (asyncio.TimeoutError, asyncio.IncompleteReadError):
        pass  # 超时 = 接收机未在窗口内回复，属正常（很多型号不回 ACK）
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass

    return {'ok': True, 'reply': ''.join(reply_parts).strip(), 'error': None}


async def deploy_frequencies(assignments: List[Dict[str, Any]],
                             dry_run_only: bool = True) -> List[Dict[str, Any]]:
    """一键下发：按主机分组，逐台发送命令。默认 dry-run（不连接）。

    - dry_run_only=True（默认）：只生成命令字符串，返回 dry-run 结果
    - dry_run_only=False：实际连接发送（实验性，未对硬件验证）
    """
    # 按 host 分组
    by_host: Dict[str, List[Dict[str, Any]]] = {}
    for a in assignments:
        by_host.setdefault(a.get('host') or '', []).append(a)

    results = []
    for host, items in by_host.items():
        commands = build_set_commands(items)
        if dry_run_only:
            for a in items:
                ch, fm = a.get('channel'), a.get('frequency_mhz')
                results.append({
                    'host': host, 'channel': ch, 'frequency_mhz': fm,
                    'command': build_shure_set_command(ch, fm) if ch is not None and fm is not None else None,
                    'sent': False, 'ok': None, 'dry_run': True,
                })
            continue
        # 实际发送
        outcome = await send_shure_commands(host, commands)
        for a in items:
            ch, fm = a.get('channel'), a.get('frequency_mhz')
            results.append({
                'host': host, 'channel': ch, 'frequency_mhz': fm,
                'command': build_shure_set_command(ch, fm) if ch is not None and fm is not None else None,
                'sent': True, 'ok': outcome['ok'], 'reply': outcome['reply'],
                'error': outcome['error'], 'dry_run': False,
            })
    return results


if __name__ == '__main__':
    demo = [
        {'host': '192.168.1.10', 'channel': 1, 'frequency_mhz': 470.125},
        {'host': '192.168.1.10', 'channel': 2, 'frequency_mhz': 606.700},
        {'host': '192.168.1.11', 'channel': 1, 'frequency_mhz': 520.000},
    ]
    print('=== dry-run（不连接设备）===')
    for r in dry_run(demo):
        print(f"  {r['host']} CH{r['channel']}: {r['command']}")
