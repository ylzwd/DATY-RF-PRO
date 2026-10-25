"""Repair local SystemAPI discovery for a reachable, installed Shure receiver.

Uses the official additive discovery API only. Never changes NICs, firewall,
receiver settings, firmware, credentials, DATY identity or existing address lists.
"""
from pathlib import Path
import argparse, asyncio, datetime, importlib.util, ipaddress, json, ssl, sys, time
import urllib.error, urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent if HERE.name == 'scripts' else HERE
if '_daty_diagnose' not in sys.modules:
    spec = importlib.util.spec_from_file_location('_daty_diagnose', ROOT/'scripts/project-diagnose.py')
    diagnose = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = diagnose
    spec.loader.exec_module(diagnose)
else:
    diagnose = sys.modules['_daty_diagnose']
from shure_systemapi import SystemApiClient, SystemApiError, NoRedirect, identity_from_response
from project_identity import instance_root


class DiscoveryApi(SystemApiClient):
    def request_discovery(self, method, target=None):
        if method not in ('GET', 'PATCH'):
            raise ValueError('Only discovery read/add is allowed')
        path = '/api/v1/config/discovery/ips'
        data = None
        if method == 'PATCH':
            target = str(ipaddress.IPv4Address(target))
            path += '/add'
            data = json.dumps({'ips': [target]}).encode('utf-8')
        cert = (self.security/'systemapicertificate.cer').read_bytes()
        context = ssl.create_default_context()
        context.load_verify_locations(cadata=cert.decode('ascii') if cert.startswith(b'-----BEGIN') else cert)
        key = (self.security/'SharedKey.txt').read_text('utf-8-sig').strip()
        if not key or len(key) > 4096 or '\r' in key or '\n' in key:
            raise SystemApiError('LOCAL_API_CREDENTIAL_INVALID')
        request = urllib.request.Request('https://127.0.0.1:10000'+path, data=data, method=method,
            headers={'x-api-key': key, 'Accept': 'application/json', 'Content-Type': 'application/json'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=context), NoRedirect())
        with opener.open(request, timeout=3) as response:
            if method == 'PATCH':
                if response.status != 202:
                    raise SystemApiError('DISCOVERY_ADD_NOT_ACCEPTED')
                return None  # An acceptance is not proof that the device was found.
            raw = response.read(1048577)
            if len(raw) > 1048576:
                raise SystemApiError('DISCOVERY_LIST_TOO_LARGE')
            result = json.loads(raw)
            if not isinstance(result, dict) or not isinstance(result.get('ips'), list) or len(result['ips']) > 10000:
                raise SystemApiError('DISCOVERY_LIST_INVALID')
            return [str(ipaddress.IPv4Address(host)) for host in result['ips']]

    def targets(self):
        return self.request_discovery('GET')

    def add(self, target):
        self.request_discovery('PATCH', target)


def matching_details(response, target):
    """Describe rejected identities without exporting serials, UUIDs or secrets."""
    values = []
    for edge in response.get('edges', []):
        node = edge.get('node', {})
        if node.get('communicationProtocol', {}).get('address') != target:
            continue
        sw, hw = node.get('softwareIdentity', {}), node.get('hardwareIdentity', {})
        values.append({'state': node.get('deviceState'), 'model': sw.get('model'),
            'firmware': sw.get('firmwareVersion'), 'firmware_valid': sw.get('firmwareValid'),
            'compatibility': node.get('compatibility'), 'has_serial': bool(hw.get('serialNumber')),
            'has_device_id': bool(hw.get('deviceId'))})
    return values


def repair(before, target, api, observe, *, timeout=90, pause=time.sleep, now=time.monotonic, log=print):
    result = {'target': target, 'state': 'refused', 'discovery_add_attempted': False,
              'discovery_add_accepted': False, 'target_in_discovery_list': False}
    if not (before.get('runtime_readable') and before.get('plugin', {}).get('active')
            and before.get('automatic_discovery', {}).get('enabled')):
        result['message'] = '当前 DATY 后台或已安装舒尔插件未就绪，请先启动软件。'
        return result
    if not any(ipaddress.IPv4Address(target) in ipaddress.IPv4Network(net)
               for net in before.get('scan_networks', []) if net):
        result['message'] = '目标不在当前后台扫描网段内，本次没有修改官方发现名单。'
        return result
    peer = before.get('receiver', {})
    if not (peer.get('tcp2202') and peer.get('scpReply') and peer.get('firmware') and peer.get('channels', 0) > 0):
        result['message'] = '未取得目标的有效 SCP 固件及通道回报，本次没有修改官方发现名单。'
        return result
    if before.get('systemapi', {}).get('state') != 'ready':
        result['message'] = '本机 SystemAPI 服务未就绪，本次没有修改官方发现名单。'
        return result

    current = api.devices()
    identity = identity_from_response(current, target)
    result['official_matches_before'] = matching_details(current, target)
    if not identity:
        existing = api.targets()
        result['previous_address_count'] = len(existing)
        if target not in existing:
            log('正在通过官方接口补充目标发现地址；保留已有地址。', flush=True)
            result['discovery_add_attempted'] = True
            try:
                api.add(target)
                result['discovery_add_accepted'] = True
            except Exception as error:
                # A lost reply is ambiguous. Query only; never repeat this PATCH.
                result['request_error'] = type(error).__name__
        else:
            log('目标已在官方发现名单中，继续核对身份及 DATY 通道。', flush=True)
        try:
            after = api.targets()
            result['target_in_discovery_list'] = target in after
            result['previous_addresses_still_present'] = set(existing).issubset(after)
        except Exception as error:
            result['list_read_error'] = type(error).__name__
    else:
        log('SystemAPI 已有有效身份，不改动官方发现配置。', flush=True)

    started = now()
    while True:
        try:
            current = api.devices()
            identity = identity_from_response(current, target)
            result['official_matches_after'] = matching_details(current, target)
            result['identity_ready'] = bool(identity)
        except Exception as error:
            result['identity_ready'] = False
            result['identity_error'] = type(error).__name__
        if result.get('identity_ready'):
            try:
                result['daty_channels'] = observe(target)
            except Exception as error:
                result['daty_read_error'] = type(error).__name__
                result['daty_channels'] = 0
            if result['daty_channels'] > 0:
                result.update(state='recovered', message='已取得官方机身身份，DATY 已返回目标设备的在线通道。')
                return result
        if now()-started >= timeout:
            break
        pause(min(3, max(0, timeout-(now()-started))))
    result.update(state='server_pending' if result.get('identity_ready') else 'identity_pending',
        message='官方身份已恢复，但 DATY 尚未返回在线通道。' if result.get('identity_ready') else
                '官方发现地址已检查，仍未取得有效机身身份；未将请求已提交当作设备已上线。')
    return result


def observe(target):
    rpc = asyncio.run(asyncio.wait_for(diagnose.runtime_status(instance_root(ROOT)), 12))
    return sum(1 for d in rpc.get('devices.snapshot', {}).get('devices', [])
               if d.get('receiver_ip', d.get('ip')) == target and d.get('_online') is True)


def main():
    parser = argparse.ArgumentParser(description='补充本机 Shure SystemAPI 发现地址，并核对官方身份与 DATY 在线通道。')
    parser.add_argument('--target', required=True)
    args = parser.parse_args()
    target = str(ipaddress.IPv4Address(args.target))
    print('正在核对目标电脑。仅补充本机 SystemAPI 发现地址，不调频、不静音、不升级固件。', flush=True)
    before = diagnose.collect(target, reference_systemapi=True)
    report = {'checked_at': datetime.datetime.now().astimezone().isoformat(), 'before': before}
    try:
        report['repair'] = repair(before, target, DiscoveryApi(), observe)
    except Exception as error:
        report['repair'] = {'state': 'failed', 'message': '官方接口核验未完成；没有删除或替换发现名单。', 'error': type(error).__name__}
    output = ROOT/('舒尔接入修复结果-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.txt')
    message = report['repair']['message']
    output.write_text('DATY RF PRO 舒尔接入修复结果\n'+message+'\n\n'+json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8-sig')
    print(message+'\n结果文件：'+str(output), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('修复入口未完成：'+type(error).__name__+'。请将文件放入 DATY RF PRO 根目录后运行。', flush=True)
        raise SystemExit(1)
