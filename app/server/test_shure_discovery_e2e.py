#!/usr/bin/env python3
"""端到端测试：用 mock 舒尔接收机验证完整发现流程（TCP 2202 → GET ALL → 解析 + 监控）。"""
import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shure_discovery import discover_shure_receivers, monitor_shure_receiver, SHURE_COMMAND_PORT


async def mock_shure_receiver(host='127.0.0.1', port=SHURE_COMMAND_PORT):
    """模拟一台舒尔 QLXD4：监听 2202，响应 GET ALL，并持续发 SAMPLE 遥测。"""

    async def send_samples(writer):
        try:
            while True:
                await asyncio.sleep(0.05)
                writer.write('< SAMPLE 1 RF_LVL_A 071 AUDIO_LVL 055 >\r\n'.encode('ascii'))
                await writer.drain()
        except (ConnectionError, asyncio.CancelledError):
            pass

    async def handle(reader, writer):
        sampling = None
        try:
            while True:
                data = await reader.read(4096)
                if not data:
                    break
                cmd = data.decode('utf-8', errors='ignore')
                if 'GET 1 ALL' in cmd:
                    reply = ('< REP 1 CHAN_NAME "Lead Vocal" FREQUENCY 606700 '
                             'RF_LVL_A 072 AUDIO_LVL 054 BATT_CHARGE 087 '
                             'BATT_BARS 4 BATT_RUN_TIME 360 ANTENNA A MODEL QLXD4 >\r\n')
                    writer.write(reply.encode('ascii'))
                    await writer.drain()
                if 'METER_RATE' in cmd and sampling is None:
                    sampling = asyncio.create_task(send_samples(writer))
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            if sampling is not None:
                sampling.cancel()
            writer.close()

    server = await asyncio.start_server(handle, host, port)
    return server


async def run_e2e():
    server = await mock_shure_receiver()
    try:
        # ---- 1. 发现（connect-scan + GET ALL 握手） ----
        found = {}
        result = await discover_shure_receivers(
            on_found=lambda h: found.__setitem__('host', h),
            hosts=['127.0.0.1']
        )
        assert '127.0.0.1' in result, f"未发现 mock 接收机: {result}"
        ch = result['127.0.0.1'][1]
        assert ch.name == 'Lead Vocal' and ch.frequency_khz == 606700
        assert ch.rf_percent == 72 and ch.audio_dbfs == -46.0
        assert ch.battery_percent == 87 and ch.battery_bars == 4
        assert ch.battery_minutes == 360 and ch.antenna == 'A' and ch.model == 'QLXD4'
        assert found['host'] == '127.0.0.1'
        print("✓ 端到端发现通过：发现 mock 接收机并解析全部字段")
        print(f"   频率={ch.frequency_khz}kHz RF={ch.rf_percent}% "
              f"音频={ch.audio_dbfs}dBFS 电池={ch.battery_percent}% 型号={ch.model}")

        # ---- 2. 实时监控（持续收 SAMPLE 遥测） ----
        stop = asyncio.Event()
        updates = []
        task = asyncio.create_task(
            monitor_shure_receiver(
                '127.0.0.1',
                lambda h, chs: updates.append((h, dict(chs))),
                stop, meter_rate_ms=100
            )
        )
        await asyncio.sleep(0.5)  # 收集 0.5 秒遥测
        stop.set()
        await task
        assert updates, "监控未收到 SAMPLE 更新"
        last = updates[-1][1][1]
        assert last.rf_percent == 71 and last.audio_dbfs == -45.0  # SAMPLE 更新了 RF/AF
        assert last.name == 'Lead Vocal' and last.frequency_khz == 606700  # 缺失字段保持
        print(f"✓ 实时监控通过：0.5 秒收到 {len(updates)} 次遥测，SAMPLE 更新 RF/AF 且保留名称/频率")
    finally:
        server.close()
        await server.wait_closed()


if __name__ == '__main__':
    asyncio.run(run_e2e())
    print("\n🎉 端到端测试通过！舒尔接收机主动发现 + 实时监控功能完整可用。")
