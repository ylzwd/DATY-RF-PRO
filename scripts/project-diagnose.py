"""Bounded, read-only diagnosis on the computer running this project.

Only local status RPCs and one receiver's SCP GETs by default. Official API
GETs are an explicit reference comparison, never an onboarding requirement.
No installation, discovery sweep, SET, service changes or database writes.
"""
from pathlib import Path
import argparse, asyncio, datetime, ipaddress, json, socket, sys, time
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent if HERE.name == 'scripts' else HERE
sys.path[:0] = [str(ROOT/'scripts'), str(ROOT/'app/tools/pylib'), str(ROOT/'app/server'), str(ROOT/'app/server/tests'),
               *[str(ROOT/f'app/server/prototypes/mqtt-stage{n}') for n in (6, 5, 4, 3, 2, 1)]]


def read_json(path):
    if path.stat().st_size > 1024*1024:
        raise ValueError('diagnostic input too large')
    return json.loads(path.read_text('utf-8-sig'))


def body(reply):
    if reply.get('ok') is not True or not isinstance(reply.get('result'), dict):
        raise ValueError('status RPC rejected')
    result = reply['result']
    if isinstance(result.get('status'), int) and result['status'] >= 400:
        raise ValueError('status read failed')
    return result.get('body', result)


async def runtime_status(base):
    """Use the exact trusted local connection without preparing or starting it."""
    from m6_test_support import UI, packet, utf, topic, WSReader
    from tls_support import client_context
    import websockets
    cfg = read_json(base/'config/runtime-config.json')
    if not Path(cfg['tls']).resolve().is_relative_to(base.resolve()):
        raise ValueError('foreign TLS path')
    ports = [cfg[k] for k in ('web_port', 'mqtt_port')]
    if any(type(p) is not int or not 1024 <= p <= 65535 for p in ports):
        raise ValueError('invalid ports')

    class Reader(UI):
        async def start(self):
            self.ws = await websockets.connect(self.case.uris['app'], ssl=client_context(self.case.tls),
                subprotocols=['mqtt'], origin=self.case.origin, open_timeout=4, close_timeout=1)
            await self.ws.send(packet(0x10, utf('MQTT')+b'\x05\x02\0\x0a\0'+utf('')))
            self.reader = WSReader(self.ws)
            header, reply = await self.reader.read()
            if header != 0x20:
                raise ValueError('MQTT connect rejected')
            self.sid = reply[-36:].decode()
            await self.ws.send(packet(0x82, b'\0\x01\0'+utf(topic('app', 'reply'))+b'\x01'))
            if (await self.reader.read())[0] != 0x90:
                raise ValueError('MQTT subscribe rejected')
            self.boot = (await self.message())['boot_id']
            return self

    client = Reader(SimpleNamespace(tls=Path(cfg['tls']),
        uris={'app': f"wss://127.0.0.1:{cfg['mqtt_port']}/mqtt-app"},
        origin=f"https://127.0.0.1:{cfg['web_port']}"))
    try:
        await asyncio.wait_for(client.start(), 6)
        result = {}
        for method in ('plugins.status', 'discovery.status', 'network.status', 'devices.snapshot'):
            reply = body(await asyncio.wait_for(client.call(method), 6))
            result[method] = reply
        return result
    finally:
        if hasattr(client, 'ws'):
            await client.close()


def receiver_get(host):
    from shure_protocol import ShureReply, extract_framed_messages, MAX_REPLY
    value = {'tcp2202': False, 'scpReply': False, 'model': None, 'firmware': None, 'channels': 0}
    reply, pending, total = ShureReply(), '', 0
    try:
        with socket.create_connection((host, 2202), timeout=2) as connection:
            value['tcp2202'] = True
            # Strict framing also works with the old ULXD4 firmware. GET only.
            connection.sendall(b'< GET MODEL >< GET 0 ALL >')
            deadline = time.monotonic()+2
            while time.monotonic() < deadline:
                connection.settimeout(min(.2, max(.001, deadline-time.monotonic())))
                try:
                    data = connection.recv(8192)
                except TimeoutError:
                    continue
                if not data:
                    break
                total += len(data)
                if total > MAX_REPLY:
                    raise ValueError('reply too large')
                frames, pending = extract_framed_messages(pending+data.decode('ascii'))
                value['scpReply'] |= bool(frames)
                for frame in frames:
                    reply.feed(frame)
            value.update(model=reply.model, firmware=reply.firmware, channels=len(reply.channels))
    except (OSError, ValueError, UnicodeError) as error:
        value['error'] = type(error).__name__
    return value


def summarize(raw, target):
    """Emit an explicit allowlist; never serialize raw settings or credentials."""
    rpc = raw.get('rpc', {})
    plugins = rpc.get('plugins.status', {}).get('plugins', [])
    plugin = next((p for p in plugins if p.get('id') == 'shure-scp'), {})
    discovery = rpc.get('discovery.status', {})
    devices = rpc.get('devices.snapshot', {}).get('devices', [])
    api = raw.get('api', {})
    peer = raw.get('receiver', {})
    report = {
        'target': target,
        'connection_mode': discovery.get('connection_mode') or 'unknown',
        'runtime_readable': bool(rpc),
        'runtime_error': raw.get('runtime_error'),
        'plugin': {k: plugin.get(k) for k in ('id', 'version', 'state', 'active', 'activation', 'error')},
        'automatic_discovery': {k: plugin.get('automatic_discovery', {}).get(k)
                                for k in ('enabled', 'interval_seconds', 'error')},
        'discovery': {k: discovery.get(k) for k in ('enabled', 'scanning', 'targets', 'scanned', 'count', 'error')},
        'scan_networks': [s.get('scan_network') for s in discovery.get('scopes', [])],
        'local_addresses': [i.get('address') for i in raw.get('interfaces', [])],
        'interface_error': raw.get('interface_error'),
        'receiver': {k: peer.get(k) for k in ('tcp2202', 'scpReply', 'model', 'firmware', 'channels', 'error')},
        'health': {k: discovery.get('health', {}).get(k) for k in ('provider', 'state', 'receivers_online', 'last_error')},
        'monitoring': {k: discovery.get('health', {}).get('monitoring', {}).get(k) for k in ('total', 'active', 'recovering', 'stale')},
        'target_channels_in_server': sum(1 for d in devices if d.get('receiver_ip', d.get('ip')) == target),
    }
    findings = []
    if not rpc:
        findings.append('无法读取本项目后台：请保持 DATY 窗口打开，在同一项目文件夹再次运行诊断；此结果不能判定接收机或插件故障。')
    elif not plugin:
        findings.append('当前后台没有舒尔插件安装记录：请导入完整舒尔插件包。')
    elif not plugin.get('active'):
        findings.append('舒尔插件有安装记录但未启用：需根据插件错误修复，不能视为发现服务正常。')
    elif not plugin.get('automatic_discovery', {}).get('enabled'):
        findings.append('舒尔自动发现没有启用：插件已导入不等于自动发现已经启动。')
    if plugin.get('automatic_discovery', {}).get('error'):
        findings.append('舒尔自动发现调度报告错误：请核对下方 automatic_discovery.error。')
    if plugin.get('active') and discovery.get('enabled') is False:
        findings.append('舒尔插件已启用，但接收机发现已关闭。')
    if discovery.get('error') or raw.get('interface_error'):
        findings.append('网卡读取或局域网扫描报告错误：请核对下方网卡和扫描错误。')
    if not peer.get('tcp2202'):
        findings.append(f'本电脑无法连通 {target}:2202：先核对接收机开机、网线、地址和本机路由。')
    elif not peer.get('scpReply'):
        findings.append('接收机 TCP 端口可连接，但未收到有效 SCP 回报；不能据端口开放判定设备可用。')
    elif not peer.get('channels'):
        findings.append('已收到 SCP 回报，但没有完整的接收机通道信息；需核对插件解码与接收机实际回复。')
    if report['target_channels_in_server']:
        findings.append('服务器已返回目标设备通道；若界面不显示，应继续检查客户端连接和过滤条件。')
    elif rpc and plugin.get('active') and peer.get('tcp2202') and peer.get('scpReply'):
        findings.append('接收机能够回复，但服务器没有目标通道；需依据此报告继续检查插件解析/发现链路。')
    if raw.get('reference_systemapi') is True:
        report['systemapi'] = {k: api.get(k) for k in ('state', 'error', 'target_present', 'target_model', 'target_firmware')}
        report['systemapi']['reference_only'] = True
        findings.append('SystemAPI 数据仅作显式参考比较，不参与 DATY 设备上线、监测或下发判断。')
    report['findings'] = findings
    return report


def systemapi_reference(target):
    """Opt-in read-only reference; normal diagnosis does not import this client."""
    from shure_systemapi import SystemApiClient, SystemApiError, identity_from_response
    try:
        identity = identity_from_response(SystemApiClient().devices(), target)
        return {'state': 'ready', 'target_present': bool(identity),
                'target_model': identity.get('model') if identity else None,
                'target_firmware': identity.get('firmware') if identity else None}
    except SystemApiError as error:
        return {'state': 'unavailable', 'error': str(error)}


def collect(target, *, reference_systemapi=False):
    from project_identity import instance_root
    from shure_active_discovery import local_interfaces
    raw = {'reference_systemapi': reference_systemapi}
    try:
        raw['rpc'] = asyncio.run(asyncio.wait_for(runtime_status(instance_root(ROOT)), 28))
    except Exception as error:
        raw['runtime_error'] = type(error).__name__
    try:
        raw['interfaces'] = local_interfaces()
    except Exception as error:
        raw['interface_error'] = type(error).__name__
    if reference_systemapi:
        raw['api'] = systemapi_reference(target)
    raw['receiver'] = receiver_get(target)
    return summarize(raw, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True)
    parser.add_argument('--reference-systemapi', action='store_true',
                        help='显式只读比较本机官方接口；不作为 DATY 接入前提')
    args = parser.parse_args()
    target = ipaddress.IPv4Address(args.target)
    if target.is_loopback or target.is_multicast or target.is_unspecified or int(target) == 0xffffffff:
        raise ValueError('Use the receiver IPv4 address')
    print('正在读取本电脑的舒尔接入状态，通常约 10 秒，最长约 50 秒。\n不会发送调频、静音或扫描指令。', flush=True)
    report = collect(str(target), reference_systemapi=args.reference_systemapi)
    report['checked_at'] = datetime.datetime.now().astimezone().isoformat()
    lines = ['DATY RF PRO 舒尔接入诊断', '检查时间：'+report['checked_at'], '目标接收机：'+str(target), '']
    lines += [f'{n}. {item}' for n, item in enumerate(report['findings'], 1)]
    lines += ['', '以下为只读诊断数据（不包含密钥、证书内容或业务设置）：', json.dumps(report, ensure_ascii=False, indent=2)]
    output = ROOT/('舒尔接入诊断-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.txt')
    output.write_text('\n'.join(lines)+'\n', encoding='utf-8-sig')
    print('\n'.join(lines[:-1]))
    print('\n结果文件：'+str(output), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('诊断未完成：'+type(error).__name__+'。请将本诊断放到含 app、native、scripts 的 DATY RF PRO 根目录后重试。', flush=True)
        raise SystemExit(1)
