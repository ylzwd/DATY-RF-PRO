#!/usr/bin/env python3
"""shure_discovery.py 单元测试（纯函数部分，无需真实设备）。"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shure_discovery import (
    extract_framed_messages, parse_shure_frame, ShureChannel,
    enumerate_subnet_hosts, local_ipv4_addresses,
    _parse_percent, _parse_audio, _parse_khz, _parse_antenna, _parse_int,
)


def test_extract_framed_messages():
    # 完整帧
    msgs, rem = extract_framed_messages('< REP 1 BATT_CHARGE 087 >')
    assert msgs == ['REP 1 BATT_CHARGE 087'] and rem == '', (msgs, rem)
    # 分包：半个帧
    msgs, rem = extract_framed_messages('< REP 1 BATT_CHARGE 0')
    assert msgs == [] and rem == '< REP 1 BATT_CHARGE 0'
    # 续上后半
    msgs, rem = extract_framed_messages(rem + '87 >')
    assert msgs == ['REP 1 BATT_CHARGE 087'] and rem == ''
    # 杂散 '>' 在 '<' 之前（RFutils 修复的 bug）
    msgs, rem = extract_framed_messages('>garbage< REP 1 RF_LVL 072 >')
    assert msgs == ['REP 1 RF_LVL 072']
    # 无 '<' 的杂散字节被丢弃，不无限增长
    msgs, rem = extract_framed_messages('stray bytes no frame')
    assert msgs == [] and rem == ''
    print("✓ test_extract_framed_messages 通过")


def test_parse_shure_frame():
    # 单字段
    kind, ch, fields = parse_shure_frame('REP 1 BATT_CHARGE 087')
    assert kind == 'REP' and ch == 1 and fields == {'BATT_CHARGE': '087'}
    # 多字段 SAMPLE
    kind, ch, fields = parse_shure_frame('SAMPLE 1 RF_LVL_A 072 AUDIO_LVL 054')
    assert kind == 'SAMPLE' and ch == 1
    assert fields['RF_LVL_A'] == '072' and fields['AUDIO_LVL'] == '054'
    # 带引号字符串值
    kind, ch, fields = parse_shure_frame('REP 1 CHAN_NAME "Head 1" FREQUENCY 606700')
    assert fields['CHAN_NAME'] == '"Head 1"' and fields['FREQUENCY'] == '606700'
    # 非法帧
    assert parse_shure_frame('not a frame') == (None, None, {})
    assert parse_shure_frame('< SET 1 FREQUENCY 606700 >') == (None, None, {})  # SET 不支持
    print("✓ test_parse_shure_frame 通过")


def test_channel_update_keeps_omitted():
    """SAMPLE 帧缺失字段 = 不变（不是 null）。"""
    ch = ShureChannel(channel_number=1)
    ch.update({'CHAN_NAME': '"Head 1"', 'FREQUENCY': '606700', 'BATT_CHARGE': '087'})
    assert ch.name == 'Head 1' and ch.frequency_khz == 606700 and ch.battery_percent == 87
    # SAMPLE 只带计量字段，缺 CHAN_NAME / BATT_CHARGE
    ch.update({'RF_LVL_A': '072', 'AUDIO_LVL': '054'})
    assert ch.rf_percent == 72 and ch.audio_dbfs == -46.0
    # 缺失字段保持不变
    assert ch.name == 'Head 1' and ch.frequency_khz == 606700 and ch.battery_percent == 87
    print("✓ test_channel_update_keeps_omitted 通过")


def test_field_parsers():
    assert _parse_khz('606700') == 606700
    assert _parse_khz('0') is None
    assert _parse_khz('99999999') is None  # 越界
    assert _parse_percent('072') == 72
    assert _parse_percent('100') == 100
    assert _parse_percent('101') is None  # 超出百分比范围
    assert _parse_percent('') is None
    assert _parse_audio('054') == -46.0  # 54 - 100
    assert _parse_audio('100') == 0.0
    assert _parse_antenna('A') == 'A'
    assert _parse_antenna('DIVERSITY') == 'diversity'
    assert _parse_antenna('X') is None
    assert _parse_int('087') == 87
    assert _parse_int('abc') is None
    print("✓ test_field_parsers 通过")


def test_enumerate_subnet_hosts():
    # 单个 /24
    hosts = enumerate_subnet_hosts(['192.168.1.10'])
    assert len(hosts) == 253  # 1-253，跳过 .0 和 .254
    assert '192.168.1.1' in hosts and '192.168.1.253' in hosts
    assert '192.168.1.254' not in hosts and '192.168.1.0' not in hosts
    # 多个网卡同前缀去重
    hosts = enumerate_subnet_hosts(['192.168.1.10', '192.168.1.20'])
    assert len(hosts) == 253
    # 多个不同子网
    hosts = enumerate_subnet_hosts(['192.168.1.10', '10.0.0.5'])
    assert len(hosts) == 506
    # 回环跳过
    hosts = enumerate_subnet_hosts(['127.0.0.1'])
    assert hosts == []
    print("✓ test_enumerate_subnet_hosts 通过")


if __name__ == '__main__':
    test_extract_framed_messages()
    test_parse_shure_frame()
    test_channel_update_keeps_omitted()
    test_field_parsers()
    test_enumerate_subnet_hosts()
    print("\n🎉 全部测试通过！舒尔发现模块核心逻辑正确。")
