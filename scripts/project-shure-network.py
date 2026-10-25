"""Verify and repair the local Shure discovery NIC, without receiver SETs."""
from pathlib import Path
import argparse, ctypes, datetime, importlib.util, ipaddress, json, os, re, ssl
import subprocess, sys, tempfile, time, urllib.request, uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent if HERE.name == 'scripts' else HERE
if '_daty_shure_repair' not in sys.modules:
    spec = importlib.util.spec_from_file_location('_daty_shure_repair', ROOT/'scripts/project-shure-repair.py')
    repair_tool = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = repair_tool
    spec.loader.exec_module(repair_tool)
else:
    repair_tool = sys.modules['_daty_shure_repair']
diagnose = repair_tool.diagnose
ETHERNET = ('DeviceManager', 'DeviceDiscovery', 'CommunicationTransports', 'Ethernet')
GUID_KEY = ETHERNET + ('NetworkInterfaceId',)
SERVICE = 'Shure System API Service - Standalone'


def guid(value):
    return '{'+str(uuid.UUID(str(value).strip('{}'))).upper()+'}'


class ConfigDocument:
    """Lossless edit of the JSON/comment/trailing-comma subset shipped by Shure.

    Unsupported JSON5 syntax and duplicate keys fail closed, never round-trip a
    whole vendor configuration or silently drop unrelated fields/comments.
    """
    def __init__(self, raw):
        if len(raw) > 1024*1024:
            raise ValueError('CONFIG_TOO_LARGE')
        self.bom = raw.startswith(b'\xef\xbb\xbf')
        self.text = raw.decode('utf-8-sig')
        self.i, self.spans = 0, {}
        self.value = self.parse(())
        self.skip()
        if self.i != len(self.text) or not isinstance(self.value, dict):
            raise ValueError('UNSUPPORTED_CONFIG')

    def skip(self):
        while self.i < len(self.text):
            if self.text[self.i].isspace():
                self.i += 1
            elif self.text.startswith('//', self.i):
                pos = self.text.find('\n', self.i+2)
                self.i = len(self.text) if pos < 0 else pos+1
            elif self.text.startswith('/*', self.i):
                pos = self.text.find('*/', self.i+2)
                if pos < 0:
                    raise ValueError('UNTERMINATED_COMMENT')
                self.i = pos+2
            else:
                return

    def parse(self, path):
        if len(path) > 48:
            raise ValueError('CONFIG_TOO_DEEP')
        self.skip()
        start = self.i
        char = self.text[self.i:self.i+1]
        if char in ('{', '['):
            mapping = char == '{'
            value = {} if mapping else []
            end = '}' if mapping else ']'
            self.i += 1
            self.skip()
            while self.text[self.i:self.i+1] != end:
                if mapping:
                    key, length = json.JSONDecoder().raw_decode(self.text[self.i:])
                    if not isinstance(key, str) or key in value:
                        raise ValueError('CONFIG_DUPLICATE_OR_INVALID_KEY')
                    self.i += length
                    self.skip()
                    if self.text[self.i:self.i+1] != ':':
                        raise ValueError('CONFIG_COLON_EXPECTED')
                    self.i += 1
                    value[key] = self.parse(path+(key,))
                else:
                    value.append(self.parse(path+(len(value),)))
                self.skip()
                if self.text[self.i:self.i+1] == end:
                    break
                if self.text[self.i:self.i+1] != ',':
                    raise ValueError('CONFIG_COMMA_EXPECTED')
                self.i += 1
                self.skip()
            self.i += 1
        else:
            value, length = json.JSONDecoder().raw_decode(self.text[self.i:])
            if not isinstance(value, (str, int, float, bool, type(None))):
                raise ValueError('CONFIG_INVALID_SCALAR')
            self.i += length
        self.spans[path] = (start, self.i)
        return value

    def get(self, path, default=None):
        value = self.value
        for key in path:
            if not isinstance(value, dict) or key not in value:
                return default
            value = value[key]
        return value

    def with_nic(self, new_guid):
        encoded = json.dumps(guid(new_guid))
        if GUID_KEY in self.spans:
            begin, end = self.spans[GUID_KEY]
            text = self.text[:begin]+encoded+self.text[end:]
        else:
            parent = self.get(ETHERNET)
            if not isinstance(parent, dict):
                raise ValueError('CUSTOM_ETHERNET_SECTION_MISSING')
            begin = self.spans[ETHERNET][0]+1
            text = self.text[:begin]+'"NetworkInterfaceId": '+encoded+(',' if parent else '')+self.text[begin:]
        raw = (b'\xef\xbb\xbf' if self.bom else b'')+text.encode('utf-8')
        expected = json.loads(json.dumps(self.value))
        obj = expected
        for part in ETHERNET:
            obj = obj[part]
        obj['NetworkInterfaceId'] = guid(new_guid)
        if ConfigDocument(raw).value != expected:
            raise ValueError('UNRELATED_CONFIG_CHANGED')
        return raw


class NetworkApi(repair_tool.DiscoveryApi):
    def _graphql(self, query, variables=None):
        cert = (self.security/'systemapicertificate.cer').read_bytes()
        context = ssl.create_default_context()
        context.load_verify_locations(cadata=cert.decode('ascii') if cert.startswith(b'-----BEGIN') else cert)
        key = (self.security/'SharedKey.txt').read_text('utf-8-sig').strip()
        if not key or len(key) > 4096 or '\r' in key or '\n' in key:
            raise ValueError('LOCAL_API_CREDENTIAL_INVALID')
        request = urllib.request.Request('https://127.0.0.1:10000/graphql',
            data=json.dumps({'query': query, 'variables': variables or {}}).encode(),
            headers={'x-api-key': key, 'Content-Type': 'application/json', 'Accept': 'application/json'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=context), repair_tool.NoRedirect())
        with opener.open(request, timeout=5) as response:
            raw = response.read(1048577)
        if len(raw) > 1048576:
            raise ValueError('GRAPHQL_RESPONSE_TOO_LARGE')
        result = json.loads(raw)
        if result.get('errors') or not isinstance(result.get('data'), dict):
            raise ValueError('OFFICIAL_NETWORK_API_REJECTED')
        return result['data']

    def interfaces(self):
        result = self._graphql('query { networkInterfacesV2 { name hostId primaryInterface status '
            'addressConfiguration { ipAddress subnetMask } } }')['networkInterfacesV2']
        if not isinstance(result, list) or len(result) > 256:
            raise ValueError('OFFICIAL_INTERFACE_LIST_INVALID')
        return result

    def select(self, interface_id):
        result = self._graphql('mutation($input: SupportedProtocolsInput!) { updateDiscovery(input: $input) '
            '{ error { __typename } } }', {'input': {'ethernet': {'networkInterfaceId': guid(interface_id)}}})
        if result.get('updateDiscovery') != {'error': None}:
            raise ValueError('OFFICIAL_NETWORK_UPDATE_REJECTED')


def windows_network():
    # No IP or script text from user input is interpolated into PowerShell.
    command = r"""
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$adapters=@(Get-NetAdapter | Select-Object Name,InterfaceGuid,ifIndex,Status,HardwareInterface)
$ips=@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object AddressState -eq Preferred | Select-Object IPAddress,PrefixLength,InterfaceIndex)
$routes=@(Get-NetRoute -AddressFamily IPv4 | Select-Object DestinationPrefix,NextHop,InterfaceIndex,RouteMetric)
$profiles=@(Get-NetConnectionProfile | Select-Object InterfaceIndex,NetworkCategory)
@{adapters=$adapters;ips=$ips;routes=$routes;profiles=$profiles} | ConvertTo-Json -Depth 5 -Compress
"""
    result = subprocess.run(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        capture_output=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise ValueError('WINDOWS_NETWORK_READ_FAILED')
    return json.loads(result.stdout.decode('utf-8-sig'))


def select_candidate(network, official, target):
    target_ip = ipaddress.IPv4Address(target)
    routes = [r for r in network['routes'] if target_ip in ipaddress.IPv4Network(r['DestinationPrefix'])]
    if not routes:
        raise ValueError('NO_TARGET_ROUTE')
    longest = max(ipaddress.IPv4Network(r['DestinationPrefix']).prefixlen for r in routes)
    routes = [r for r in routes if ipaddress.IPv4Network(r['DestinationPrefix']).prefixlen == longest]
    if any(r['NextHop'] != '0.0.0.0' for r in routes):
        raise ValueError('TARGET_REQUIRES_ROUTER_OR_VPN')
    indices = {r['InterfaceIndex'] for r in routes}
    candidates = []
    for adapter in network['adapters']:
        if adapter['Status'] != 'Up' or adapter['HardwareInterface'] is not True or adapter['ifIndex'] not in indices:
            continue
        for entry in network['ips']:
            if entry['InterfaceIndex'] != adapter['ifIndex']:
                continue
            address = ipaddress.IPv4Interface(f"{entry['IPAddress']}/{entry['PrefixLength']}")
            if target_ip not in address.network or target_ip in (address.ip, address.network.network_address, address.network.broadcast_address):
                continue
            if any(guid(n['hostId']) == guid(adapter['InterfaceGuid'])
                   and n['addressConfiguration']['ipAddress'] == str(address.ip) for n in official):
                candidates.append({'id': guid(adapter['InterfaceGuid']), 'ip': str(address.ip),
                    'network': str(address.network), 'name': adapter['Name']})
    if len({c['id'] for c in candidates}) != 1 or len(indices) != 1:
        raise ValueError('NO_UNIQUE_DIRECT_PHYSICAL_INTERFACE')
    return candidates[0]


def installed_config():
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, rf'SYSTEM\CurrentControlSet\Services\{SERVICE}\Parameters') as key:
        application = Path(winreg.QueryValueEx(key, 'Application')[0])
        parameters = winreg.QueryValueEx(key, 'AppParameters')[0]
    if application.name.lower() != 'shure-system-api-server-win.exe':
        raise ValueError('UNRECOGNIZED_OFFICIAL_SERVICE')
    # Alternate CLI configuration paths or NIC arguments need explicit review.
    if str(parameters).strip().strip('"') != 'shure-system-api-server.mjs':
        raise ValueError('CUSTOM_SERVICE_ARGUMENTS_REQUIRE_REVIEW')
    base = ConfigDocument((application.parent/'appsettings/appsettings.json5').read_bytes())
    custom_path = Path(base.get(('Application', 'CustomConfigurationFilePath'), ''))
    if not custom_path.is_absolute() or custom_path.suffix.lower() not in ('.json5', '.json') or not custom_path.is_file():
        raise ValueError('CUSTOM_CONFIGURATION_PATH_UNAVAILABLE')
    raw = custom_path.read_bytes()
    custom = ConfigDocument(raw)
    enabled = custom.get(ETHERNET+('Enable',), base.get(ETHERNET+('Enable',)))
    if enabled is not True:
        raise ValueError('OFFICIAL_ETHERNET_DISCOVERY_DISABLED')
    return custom_path, raw, custom, custom.get(GUID_KEY, base.get(GUID_KEY))


def atomic_config(path, expected, replacement):
    """Replace only this official override, preserving Windows ACLs and a local backup."""
    if path.read_bytes() != expected:
        raise ValueError('CONFIG_CHANGED_DURING_REPAIR')
    backup = path.with_name(path.name+'.daty-'+uuid.uuid4().hex+'.bak')
    descriptor, temporary = tempfile.mkstemp(prefix='.daty-nic-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(replacement)
            output.flush()
            os.fsync(output.fileno())
        if path.read_bytes() != expected:
            raise ValueError('CONFIG_CHANGED_DURING_REPAIR')
        replace = ctypes.WinDLL('kernel32', use_last_error=True).ReplaceFileW
        replace.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p]
        replace.restype = ctypes.c_int
        if not replace(str(path), temporary, str(backup), 0, None, None):
            raise ctypes.WinError(ctypes.get_last_error())
        if path.read_bytes() != replacement or backup.read_bytes() != expected:
            raise ValueError('CONFIG_WRITE_VERIFICATION_FAILED')
        return str(backup)
    finally:
        if Path(temporary).exists():
            Path(temporary).unlink()  # Only our exact newly-created temporary file.


def primary_ids(interfaces):
    return sorted({guid(item['hostId']) for item in interfaces if item.get('primaryInterface') is True})


def recover(before, target, api, network, config_loader=installed_config, writer=atomic_config,
            observe=repair_tool.observe, *, readonly=False, timeout=100, pause=time.sleep, now=time.monotonic, log=print):
    result = {'target': target, 'state': 'refused', 'config_changed': False, 'config_write_attempted': False, 'runtime_change_attempted': False,
              'message': '尚未修改官方发现网卡。'}
    try:
        official = api.interfaces()
        previous_ids = primary_ids(official)
        result['official_interfaces'] = official
        result['primary_before'] = previous_ids
        candidate = select_candidate(network, official, target)
        result['expected_interface'] = candidate
        chosen = candidate['id']
        current = api.devices()
        identity = repair_tool.identity_from_response(current, target)
        result['official_matches'] = repair_tool.matching_details(current, target)
        result['identity_ready'] = bool(identity)
        if previous_ids == [chosen]:
            result.update(state='network_already_correct', message='官方发现网卡已指向接收机网段，本次没有改动。')
        else:
            result['binding_mismatch'] = True
            if readonly:
                result.update(state='mismatch_readonly', message='检测到官方发现网卡不匹配；只读模式未修改。')
                return result
            peer = before.get('receiver', {})
            if not (before.get('runtime_readable') and before.get('plugin', {}).get('active')
                    and before.get('automatic_discovery', {}).get('enabled')
                    and before.get('systemapi', {}).get('state') == 'ready'
                    and peer.get('tcp2202') and peer.get('scpReply') and peer.get('firmware')
                    and peer.get('channels', 0) > 0):
                raise ValueError('DATY_PLUGIN_OR_RECEIVER_NOT_READY')
            if len(previous_ids) > 1:
                raise ValueError('MULTIPLE_OFFICIAL_PRIMARY_INTERFACES')
            # A shared official service may manage other products on another NIC.
            for edge in current.get('edges', []):
                node = edge.get('node', {})
                if node.get('deviceState') == 'ONLINE':
                    address = node.get('communicationProtocol', {}).get('address')
                    if address and ipaddress.IPv4Address(address) not in ipaddress.IPv4Network(candidate['network']):
                        raise ValueError('OTHER_ONLINE_DEVICES_USE_DIFFERENT_NETWORK')
            path, original, document, configured_id = config_loader()
            replacement = document.with_nic(chosen)
            result['configured_primary_before'] = configured_id
            # Re-read runtime selection to avoid overwriting another user's change.
            if primary_ids(api.interfaces()) != previous_ids:
                raise ValueError('PRIMARY_INTERFACE_CHANGED_DURING_REPAIR')
            if replacement != original:
                result['config_write_attempted'] = True
                result['config_changed'] = None  # A failed write/verification can be ambiguous.
                result['backup_path'] = writer(path, original, replacement)
                result['config_changed'] = True
            result['config_primary_verified'] = chosen
            log('已保存正确的官方发现网卡，正在核对实时生效状态。', flush=True)
            # The official config watcher can apply the override first. Otherwise
            # use the shipped GraphQL discovery mutation once, never a receiver SET.
            pause(2)
            if primary_ids(api.interfaces()) != [chosen]:
                result['runtime_change_attempted'] = True
                try:
                    api.select(chosen)
                except Exception as error:
                    result['runtime_request_error'] = type(error).__name__
            result.update(state='binding_pending', message='网卡配置已保存，尚未确认官方服务实时切换。')
        if readonly:
            if identity:
                result['daty_channels'] = observe(target)
                if result['daty_channels'] > 0:
                    result.update(state='recovered', message='只读核验：官方机身身份及 DATY 在线通道均已存在。')
            return result
        start = now()
        while True:
            try:
                result['primary_after'] = primary_ids(api.interfaces())
                result['binding_verified'] = result['primary_after'] == [chosen]
                current = api.devices()
                result['official_matches'] = repair_tool.matching_details(current, target)
                result['identity_ready'] = bool(repair_tool.identity_from_response(current, target))
                if result['identity_ready']:
                    result['daty_channels'] = observe(target)
                    if result['daty_channels'] > 0 and result['binding_verified']:
                        result.update(state='recovered', message='已核实正确网卡、官方机身身份和 DATY 在线通道。')
                        return result
            except Exception as error:
                result['verification_error'] = type(error).__name__
            if now()-start >= timeout:
                break
            pause(min(3, max(0, timeout-(now()-start))))
        if result.get('binding_verified'):
            result.update(state='server_pending' if result.get('identity_ready') else 'identity_pending',
                message='网卡及官方机身身份正常，但 DATY 在线通道尚未出现。' if result.get('identity_ready') else
                    '官方网卡已核实正确，但仍无机身身份；不能判为修复成功，需依据本报告的官方日志继续排查。')
        return result
    except Exception as error:
        result.update(state='incomplete' if result['config_write_attempted'] else 'refused',
            error=str(error) if isinstance(error, ValueError) else type(error).__name__,
            message='网卡修复未完成，请查看本报告中的错误；未将配置写入或请求提交当成设备上线。')
        return result


def official_log_summary(target):
    """Only export classified events and counts, never raw vendor log messages."""
    path = Path(os.environ.get('ProgramData', 'C:/ProgramData'))/'Shure/SystemAPI/Standalone/logs/app/sysapi.log'
    counts, recent = {}, []
    patterns = [('interface_selected', 'NetworkInterfaceSelected'), ('bind_failed', 'Could not bind'),
        ('interface_updated', 'Network interface ID updated successfully'), ('interface_update_failed', 'Failed to update network interface ID'),
        ('config_invalid', 'configuration change was ignored'), ('device_ready', 'DS_READY'),
        ('device_initializing', 'DS_INITIALIZING'), ('socket_listening', 'socket listening')]
    try:
        with path.open('rb') as stream:
            stream.seek(0, 2)
            size = stream.tell()
            stream.seek(max(0, size-2*1024*1024))
            raw = stream.read()
        if size > len(raw):
            raw = raw.partition(b'\n')[2]
        for line in raw.splitlines():
            try:
                entry = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            # Skip request/response logs, which can contain credentials or headers.
            if 'reqId' in entry or 'req' in entry or 'res' in entry:
                continue
            msg = str(entry.get('msg', ''))
            for event, needle in patterns:
                if needle.lower() in msg.lower():
                    counts[event] = counts.get(event, 0)+1
                    recent.append({'time': entry.get('time'), 'event': event,
                        'target_mentioned': target in msg})
        return {'bytes_examined': len(raw), 'counts': counts, 'recent_events': recent[-20:]}
    except OSError as error:
        return {'read_error': type(error).__name__}


def main():
    parser = argparse.ArgumentParser(description='核实并修正本机 Shure 官方发现网卡，验证真实设备上线。')
    parser.add_argument('--target', required=True)
    parser.add_argument('--read-only', action='store_true')
    args = parser.parse_args()
    target = str(ipaddress.IPv4Address(args.target))
    print('正在检查本机官方发现网卡。保留 DATY 窗口打开，完整核验最长约 3 分钟。\n'
          '仅在网卡明确不匹配时修正官方发现配置；不改 Windows 网卡、防火墙或接收机参数。', flush=True)
    report = {'checked_at': datetime.datetime.now().astimezone().isoformat(), 'before': diagnose.collect(target, reference_systemapi=True)}
    try:
        network = windows_network()
        report['windows_network'] = network
        report['repair'] = recover(report['before'], target, NetworkApi(), network, readonly=args.read_only)
    except Exception as error:
        report['repair'] = {'state': 'failed', 'error': type(error).__name__, 'message': '未完成网卡检查，没有修改官方网卡配置。'}
    report['official_log_summary'] = official_log_summary(target)
    output = ROOT/('舒尔网卡修复结果-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.txt')
    message = report['repair']['message']
    output.write_text('DATY RF PRO 舒尔发现网卡核验与修复\n'+message+'\n\n'+
        json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8-sig')
    print(message+'\n结果文件：'+str(output), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('入口未完成：'+type(error).__name__+'。请把此文件放入目标电脑 DATY RF PRO 文件夹。', flush=True)
        raise SystemExit(1)
