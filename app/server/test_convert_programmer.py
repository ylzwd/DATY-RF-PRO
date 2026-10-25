#!/usr/bin/env python3
"""convert.py + shure_programmer.py 单元测试。"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from convert import (
    parse_frequency_to_mhz, format_mhz, format_khz,
    read_wsm_csv, write_wsm_csv, write_wwb_frequency_list,
    detect_format, parse_file, convert, Channel, CoordinationList,
)
from shure_programmer import (
    shure_freq_value, build_shure_set_command,
    build_set_commands, dry_run,
)


def test_parse_frequency():
    # 纯 MHz 小数
    assert parse_frequency_to_mhz('470.100') == 470.1
    # 森海 MHz.kHz 风格
    assert parse_frequency_to_mhz('600.768') == 600.768
    # 逗号小数
    assert parse_frequency_to_mhz('600,768') == 600.768
    # 原始 kHz 整数（>= 3000 视为 kHz）
    assert parse_frequency_to_mhz('600768') == 600.768
    assert parse_frequency_to_mhz('470125') == 470.125
    # 千分位逗号
    assert parse_frequency_to_mhz('1,000.500') == 1000.5
    # 非法
    try:
        parse_frequency_to_mhz('abc')
        assert False
    except ValueError:
        pass
    print("✓ test_parse_frequency 通过 (MHz/MHz.kHz/逗号/kHz/千分位)")


def test_format():
    assert format_mhz(470.125) == '470.125'
    assert format_mhz(606.7) == '606.700'
    assert format_khz(470.125) == '470125'
    assert format_khz(606.7) == '606700'
    print("✓ test_format 通过")


def test_wsm_roundtrip():
    wsm = ('name;type;frequency;tolerance;minfrequency;maxfrequency;priority;squelchlevel\n'
           'Lead Vocal;0;470125;0;470125;470125;;\n'
           'Guitar;0;606700;0;606700;606700;;\n')
    channels = read_wsm_csv(wsm)
    assert len(channels) == 2
    assert channels[0].name == 'Lead Vocal' and channels[0].frequency_mhz == 470.125
    assert channels[0].device_type == '0'
    # 写回 WSM
    out = write_wsm_csv(channels)
    assert 'name;type;frequency' in out.split('\n')[0]
    assert 'Lead Vocal;0;470125' in out
    assert 'Guitar;0;606700' in out
    # 往返：再读回来
    channels2 = read_wsm_csv(out)
    assert len(channels2) == 2 and channels2[1].frequency_mhz == 606.7
    print("✓ test_wsm_roundtrip 通过 (读→写→读往返一致)")


def test_wwb_frequency_list():
    channels = [Channel(name='CH 1', frequency_mhz=470.125),
                Channel(name='CH 2', frequency_mhz=606.7)]
    out = write_wwb_frequency_list(channels)
    assert out == '470.125\n606.700\n'
    print("✓ test_wwb_frequency_list 通过")


def test_detect_and_convert():
    # WSM 检测
    wsm = 'name;type;frequency;tolerance;minfrequency;maxfrequency;priority;squelchlevel\nA;0;470125;0;470125;470125;;\n'
    assert detect_format(wsm) == 'wsm'
    # 裸频率列表检测
    freq_list = '470.125\n606.700\n'
    assert detect_format(freq_list) == 'wwb-frequency-list'
    # WSM → WWB 转换
    result = convert(wsm, 'wwb-frequency-list')
    assert '470.125' in result and '606' not in result.replace('470.125', '')
    # WWB 频率列表 → WSM
    wsm_out = convert(freq_list, 'wsm-csv')
    assert 'name;type;frequency' in wsm_out.split('\n')[0]
    assert '470125' in wsm_out and '606700' in wsm_out
    print("✓ test_detect_and_convert 通过 (自动检测 + WWB↔WSM 互转)")


def test_shure_command():
    assert shure_freq_value(470.125) == '470125'
    assert shure_freq_value(606.7) == '606700'
    assert shure_freq_value(52.0) == '052000'  # 6 位补零
    assert build_shure_set_command(1, 470.125) == '< SET 1 FREQUENCY 470125 >'
    assert build_shure_set_command(2, 606.7) == '< SET 2 FREQUENCY 606700 >'
    print("✓ test_shure_command 通过 (6位kHz + SET 命令构造)")


def test_dry_run():
    assignments = [
        {'host': '192.168.1.10', 'channel': 1, 'frequency_mhz': 470.125},
        {'host': '192.168.1.10', 'channel': 2, 'frequency_mhz': 606.7},
        {'host': '192.168.1.11', 'channel': 1, 'frequency_mhz': 520.0},
    ]
    cmds = build_set_commands(assignments)
    assert cmds == ['< SET 1 FREQUENCY 470125 >',
                    '< SET 2 FREQUENCY 606700 >',
                    '< SET 1 FREQUENCY 520000 >']
    # dry_run 不连接，只生成命令
    results = dry_run(assignments)
    assert all(r['command'] is not None for r in results)
    assert results[0]['command'] == '< SET 1 FREQUENCY 470125 >'
    # 缺失字段的分配
    bad = dry_run([{'host': 'x', 'channel': None, 'frequency_mhz': 470.0}])
    assert bad[0]['command'] is None and bad[0]['error']
    print("✓ test_dry_run 通过 (dry-run 生成命令，缺失字段报错)")


if __name__ == '__main__':
    test_parse_frequency()
    test_format()
    test_wsm_roundtrip()
    test_wwb_frequency_list()
    test_detect_and_convert()
    test_shure_command()
    test_dry_run()
    print("\n🎉 全部测试通过！Convert 文件互转 + Deploy 下发模块实现正确。")
