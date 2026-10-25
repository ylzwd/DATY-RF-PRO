#!/usr/bin/env python3
"""probe_shure_sync 集成测试：mock 舒尔设备验证同步探测 + ip-service 识别。"""
import socket
import threading
import time
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shure_discovery import probe_shure_sync, SHURE_COMMAND_PORT


def start_mock_shure(host='127.0.0.1', port=SHURE_COMMAND_PORT):
    """线程版 mock 舒尔 QLXD4：响应 GET ALL。"""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    server.listen(5)

    def serve(conn):
        try:
            data = conn.recv(4096)
            if b'GET 1 ALL' in data:
                conn.sendall(
                    b'< REP 1 CHAN_NAME "Lead Vocal" FREQUENCY 606700 '
                    b'RF_LVL_A 072 AUDIO_LVL 054 BATT_CHARGE 087 '
                    b'BATT_BARS 4 MODEL QLXD4 >\r\n'
                    b'< REP 2 CHAN_NAME "Guitar" FREQUENCY 520000 '
                    b'RF_LVL_A 065 AUDIO_LVL 050 BATT_CHARGE 091 MODEL QLXD4 >\r\n'
                )
        except (ConnectionError, OSError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def accept_loop():
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                break
            threading.Thread(target=serve, args=(conn,), daemon=True).start()

    threading.Thread(target=accept_loop, daemon=True).start()
    return server


def test_probe_shure_sync():
    server = start_mock_shure()
    try:
        time.sleep(0.1)
        info = probe_shure_sync('127.0.0.1', timeout=1.5)
        assert info is not None, "未识别 mock 舒尔设备"
        assert info['type'] == 'receiver', info['type']
        assert info['model'] == 'QLXD4', info['model']
        assert info['label'] == 'Shure QLXD4', info['label']
        assert info['channel_count'] == 2, info['channel_count']
        assert info['discovered_via'] == 'shure-scp'
        # 通道遥测解析正确
        ch1 = info['channels']['1']
        assert ch1['name'] == 'Lead Vocal' and ch1['frequency_khz'] == 606700
        assert ch1['rf_percent'] == 72 and ch1['battery_percent'] == 87
        ch2 = info['channels']['2']
        assert ch2['frequency_khz'] == 520000
        print("✓ test_probe_shure_sync 通过：识别 mock QLXD4，2 通道，遥测解析正确")
        print(f"   label={info['label']}, channels={info['channel_count']}, "
              f"CH1 频率={ch1['frequency_khz']}kHz RF={ch1['rf_percent']}%")
    finally:
        server.close()


def test_probe_non_shure():
    """连接失败（非舒尔设备）返回 None。"""
    # 用未监听的端口（非 2202）
    import random
    free_port = 22999
    # 探测一个大概率没设备的地址 + 短超时
    info = probe_shure_sync('127.0.0.1', timeout=0.3) if False else None
    # 关闭 mock 后探测应该返回 None
    server = start_mock_shure()
    time.sleep(0.1)
    server.close()  # 立即关闭，探测会失败
    time.sleep(0.1)
    info = probe_shure_sync('127.0.0.1', timeout=0.5)
    assert info is None, "应返回 None（无设备响应）"
    print("✓ test_probe_non_shure 通过：无设备响应返回 None")


if __name__ == '__main__':
    test_probe_shure_sync()
    test_probe_non_shure()
    print("\n🎉 集成测试通过！probe_shure_sync 可被 ip-service.py 用于识别舒尔接收机。")
