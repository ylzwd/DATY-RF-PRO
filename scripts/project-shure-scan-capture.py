"""Optional, receiver-scoped WWB evidence collection; no receiver commands.

By default, only print the plan. --check performs local read-only PktMon checks.
--interactive asks for a receiver IP and an Enter confirmation before capture.
Actual capture requires an administrator console and explicit confirmation.
Uses Windows raw IP reception or PktMon already present on the computer;
installs nothing. Operator markers describe WWB observations, never decoded
device completion events.
"""
from pathlib import Path
import argparse
import ctypes
import datetime
import hashlib
import ipaddress
import json
import math
import os
import re
import signal
import socket
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
# The bundled embedded Python does not add the invoked script directory.
sys.path.insert(0, str(ROOT/'scripts'))
MARKS = {
    's': ('wwb_scan_start_observed', '已标记：在 WWB 开始扫描'),
    'n': ('wwb_natural_completion_observed', '已标记：观察到 WWB 自然完成'),
    'c': ('wwb_cancel_clicked', '已标记：在 WWB 手动取消'),
    'd': ('receiver_disconnect_observed', '已标记：观察到接收机断线'),
    'r': ('receiver_reconnect_observed', '已标记：观察到接收机恢复连接'),
}
LIMITATIONS = [
    '只被动记录指定 IP 的收发包；脚本不启动扫描，不调频，不静音，不发送任何设备命令。',
    '人工标记只表示用户在 WWB 的观察，不是已解码的接收机完成、取消或断线事件。',
    '只匹配目标 IP；本机发往多播地址且不含目标 IP 的发现/控制包不会采集，不能据缺包断言协议不存在。',
    '循环 ETL 有体积上限，较早事件可能覆盖；系统丢包和覆盖需结合原始 PktMon 输出判断，不能保证完整扫描。',
    'pcapng 存在不证明获得完整频谱点；可能只有 SCP 单频测量、加密载荷或不完整会话。',
    'PktMon 是系统全局资源；拒绝已有会话/过滤器并检查变化，但外部工具不共享本脚本的锁，请勿并行操作 PktMon。',
]


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')


def target_address(value):
    try:
        target = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError as error:
        raise argparse.ArgumentTypeError('必须指定单台接收机的 IPv4 地址，不能用网段或主机名。') from error
    if (target.is_unspecified or target.is_multicast or target.is_loopback
            or target == ipaddress.IPv4Address('255.255.255.255') or target.is_reserved):
        raise argparse.ArgumentTypeError('不能使用回环、保留、多播或广播地址。')
    return str(target)


def bounded_int(low, high):
    def parse(value):
        try:
            result = int(value)
        except ValueError as error:
            raise argparse.ArgumentTypeError('需要整数。') from error
        if not low <= result <= high:
            raise argparse.ArgumentTypeError(f'范围必须是 {low}–{high}。')
        return result
    return parse


def normalized(text):
    return '\n'.join(line.strip() for line in text.replace('\r', '').splitlines() if line.strip())


def is_idle(text):
    # Fail closed on unsupported localizations/output, not substring guessing.
    return normalized(text).lower() in {
        'packet monitor is not running.', 'packet monitor is not running',
        '数据包监视器没有运行。', '数据包监视器没有运行.',
    }


def no_filters(text):
    return normalized(text).lower() in {'packet filters:\nnone', '数据包筛选器:\n无'}


def sole_owned_filter(text, name, target):
    """Recognize one IP-only filter row, refusing extra rows/unknown formats."""
    # Windows prints a dash-only column separator in both Chinese and English.
    # Ignore only that presentation row, never an additional filter/data row.
    lines = [line for line in normalized(text).splitlines() if not re.fullmatch(r'[-\s]+', line)]
    rows = [line.split() for line in lines if re.match(r'^\d+\s', line)]
    return (len(lines) == 3 and lines[0].lower() in {'packet filters:', '数据包筛选器:'}
            and len(rows) == 1 and rows[0][1:] == [name, target]
            and lines[-1].split() == rows[0] and text.count(name) == 1 and text.count(target) == 1)


def owned_session(text, etl):
    # The absolute unique ETL path is printed in status. Unknown output is not
    # permission to stop a global logger. Exact suffix prevents path-prefix matches.
    wanted = str(etl).replace('/', '\\').casefold()
    return any(line.strip().replace('/', '\\').casefold().endswith(': ' + wanted)
               or re.search(r':\s*' + re.escape(wanted) + r'\s*$',
                            line.replace('/', '\\').casefold())
               for line in text.splitlines())


def capture_command(etl, max_mb):
    # Observe all stack components for the same single receiver IP. NIC-only
    # capture had whole-datagram gaps in the first WWB trace; do not assume that
    # a NIC observation proves complete application delivery.
    return ['start', '--capture', '--comp', 'all', '--pkt-size', '0',
            '--file-name', str(etl), '--file-size', str(max_mb), '--log-mode', 'circular']


class PktMon:
    def __init__(self):
        if os.name != 'nt':
            raise RuntimeError('采集只支持 Windows；计划及模拟测试不依赖 PktMon。')
        self.path = Path(os.environ.get('SystemRoot', r'C:\Windows'))/'System32'/'pktmon.exe'
        if not self.path.is_file():
            raise RuntimeError('本机未找到 PktMon；脚本不会下载安装其他抓包工具。')

    def __call__(self, args):
        result = subprocess.run([str(self.path), *args], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=10 if args[0] in ('status', 'filter') else 45,
            creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            output = result.stdout.decode('utf-8')
        except UnicodeDecodeError:
            output = result.stdout.decode('cp'+str(ctypes.windll.kernel32.GetOEMCP()), errors='replace')
        if len(output) > 131072:
            raise RuntimeError('PktMon 输出超过限额，未继续操作。')
        return result.returncode, output


class CaptureSession:
    """Injectable PktMon lifecycle. Never resets someone else's filters/session."""
    def __init__(self, runner, target, folder, max_mb=128):
        self.runner, self.target, self.folder, self.max_mb = runner, target, folder, max_mb
        self.name = 'DatyScan_' + uuid.uuid4().hex[:12]
        self.etl, self.pcap = folder/'receiver.etl', folder/'receiver.pcapng'
        self.commands, self.events, self.warnings = [], [], []
        self.filter_added, self.filter_snapshot, self.start_attempted = False, None, False
        self.stopped, self.converted = False, False
        self.started_at, self.started_clock, self.trial = None, None, 0
        self.stop_reason = None

    def call(self, *args):
        entry = {'at_utc': utc_now(), 'args': list(args)}
        self.commands.append(entry)
        try:
            code, output = self.runner(list(args))
            entry.update(returncode=code, output=output)
        except Exception as error:
            entry['error'] = str(error)
            raise
        if code:
            raise RuntimeError(f'PktMon {args[0]} 失败（{code}）：{output.strip()}')
        return output

    def preflight(self):
        if not is_idle(self.call('status')):
            raise RuntimeError('已有 PktMon 会话或无法确认空闲；没有停止现有采集。')
        if not no_filters(self.call('filter', 'list')):
            raise RuntimeError('已有 PktMon 过滤器或无法识别输出；没有修改现有过滤器。')

    def start(self, may_start=lambda: True):
        self.preflight()
        if not may_start():
            raise RuntimeError('采集窗口已退出、已取消或已到截止时间；未开始采集。')
        # Any uncertain add response still needs conservative cleanup in finally.
        self.filter_added = True
        self.call('filter', 'add', self.name, '-i', self.target)
        snapshot = self.call('filter', 'list')
        if not sole_owned_filter(snapshot, self.name, self.target):
            raise RuntimeError('无法确认只有本次目标 IP 过滤器；未开始采集。')
        self.filter_snapshot = normalized(snapshot)
        if not is_idle(self.call('status')):
            raise RuntimeError('准备期间出现其他 PktMon 会话；未开始采集。')
        if not may_start():
            raise RuntimeError('采集窗口已退出、已取消或已到截止时间；未开始采集。')
        self.start_attempted = True
        self.call(*capture_command(self.etl, self.max_mb))
        self.started_at, self.started_clock = utc_now(), time.monotonic()
        if not owned_session(self.call('status'), self.etl):
            raise RuntimeError('无法确认采集归属，未报告启动成功。')
        self.assert_unchanged()

    def assert_unchanged(self):
        if normalized(self.call('filter', 'list')) != self.filter_snapshot:
            raise RuntimeError('采集期间过滤器被外部改变，证据范围可能变化，立即结束本次采集。')
        if not owned_session(self.call('status'), self.etl):
            raise RuntimeError('采集会话已经停止或被替换；不会停止其他会话。')

    def mark(self, key):
        if key not in MARKS:
            return False
        if key == 's':
            self.trial += 1
        self.events.append({'at_utc': utc_now(),
            'elapsed_seconds': round(time.monotonic() - self.started_clock, 3),
            'trial': self.trial or None, 'kind': MARKS[key][0],
            'source': 'operator_observation', 'device_event_verified': False})
        return True

    def close(self):
        # Older Windows supports only filter remove (all). Only issue it after
        # verifying idle + the exact single filter that this run added.
        try:
            status = self.call('status')
            if self.start_attempted and owned_session(status, self.etl):
                self.call('stop')
                status = self.call('status')
                self.stopped = is_idle(status)
            elif is_idle(status):
                self.stopped = True
            else:
                self.warnings.append('存在非本次或无法确认归属的会话，未停止、未删除过滤器。')
            if self.filter_added and is_idle(status):
                snapshot = self.call('filter', 'list')
                if no_filters(snapshot):
                    pass
                elif (sole_owned_filter(snapshot, self.name, self.target)
                      and (self.filter_snapshot is None or normalized(snapshot) == self.filter_snapshot)):
                    # Recheck the global session immediately before removal.
                    if is_idle(self.call('status')):
                        self.call('filter', 'remove')
                        if not no_filters(self.call('filter', 'list')):
                            self.warnings.append('清理后过滤器非空；可能存在外部并发更改，请检查。')
                    else:
                        self.warnings.append('清理前出现另一采集会话，保留过滤器。')
                else:
                    self.warnings.append('过滤器列表已改变或格式不明，保留现状；未删除他人过滤器。')
        except Exception as error:
            self.warnings.append('清理未确认：' + str(error))
        if self.stopped and self.start_attempted and self.etl.is_file():
            try:
                self.call('etl2pcap', str(self.etl), '--out', str(self.pcap))
                self.converted = self.pcap.is_file() and self.pcap.stat().st_size > 0
                if not self.converted:
                    self.warnings.append('转换未生成非空 pcapng；保留 ETL，不能宣称采集成功。')
            except Exception as error:
                self.warnings.append('pcapng 转换失败，保留 ETL：' + str(error))


def local_capture_interface(target, requested=None):
    """Ask Windows for the route, without sending a datagram to the receiver."""
    if requested:
        return target_address(requested)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
        route.connect((target, 9))  # UDP connect selects a route; no send/sendto.
        address = route.getsockname()[0]
    return target_address(address)


class RawIpSession(CaptureSession):
    """Target-only, socket-owned capture; no global PktMon resources."""
    def __init__(self, target, folder, max_mb=128, interface=None):
        super().__init__(None, target, folder, max_mb)
        self.interface = interface
        self.raw_capture, self.raw_metadata = None, {}

    def preflight(self):
        if os.name != 'nt' or not hasattr(socket, 'SIO_RCVALL'):
            raise RuntimeError('IP 层采集需要 Windows SIO_RCVALL。')
        self.interface = local_capture_interface(self.target, self.interface)

    def start(self, may_start=lambda: True):
        from shure_scan_raw_capture import RawIpCapture
        self.preflight()
        if not may_start():
            raise RuntimeError('采集窗口已退出、已取消或已到截止时间；未开始采集。')
        self.raw_capture = RawIpCapture(self.target, self.interface, self.pcap, self.max_mb*1024*1024)
        self.start_attempted = True
        self.raw_capture.start()
        self.started_at, self.started_clock = utc_now(), time.monotonic()
        self.raw_metadata = self.raw_capture.snapshot()

    def assert_unchanged(self):
        self.raw_metadata = self.raw_capture.snapshot()
        if self.raw_metadata.get('error'):
            raise RuntimeError('IP 层采集失败：'+str(self.raw_metadata['error']))
        if self.raw_metadata.get('size_limit_reached'):
            self.stop_reason = 'size_limit'
            raise RuntimeError('IP 层记录达到体积上限，已停止，保留已有数据。')
        if self.raw_metadata.get('stopped'):
            raise RuntimeError('IP 层采集提前停止。')

    def close(self):
        if self.raw_capture is not None:
            try:
                self.raw_capture.stop()
            except Exception as error:
                self.warnings.append('IP 层采集关闭失败：'+str(error))
            self.raw_metadata = self.raw_capture.snapshot()
            self.stopped = bool(self.raw_metadata.get('stopped'))
            if self.raw_metadata.get('error'):
                self.warnings.append('IP 层采集错误：'+str(self.raw_metadata['error']))
        else:
            self.stopped = True
        self.converted = (self.stopped and bool(self.raw_metadata.get('packets'))
                          and self.pcap.is_file() and self.pcap.stat().st_size > 0)


def make_session(args, folder):
    if args.engine == 'raw-ip':
        return RawIpSession(args.target, folder, args.max_mb, args.interface)
    return CaptureSession(PktMon(), args.target, folder, args.max_mb)


class CaptureMutex:
    def __enter__(self):
        self.api = ctypes.WinDLL('kernel32', use_last_error=True)
        self.api.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
        self.api.CreateMutexW.restype = ctypes.c_void_p
        self.api.ReleaseMutex.argtypes = [ctypes.c_void_p]
        self.api.CloseHandle.argtypes = [ctypes.c_void_p]
        self.handle = self.api.CreateMutexW(None, True, 'Global\\DATYRFPRO.ShureScanEvidence')
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if ctypes.get_last_error() == 183:
            self.api.CloseHandle(self.handle)
            raise RuntimeError('另一个 DATY 采集工具正在运行；未开始新的采集。')
        return self

    def __exit__(self, *args):
        self.api.ReleaseMutex(self.handle)
        self.api.CloseHandle(self.handle)


def file_receipt(path):
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            digest.update(block)
    return {'name': path.name, 'bytes': path.stat().st_size, 'sha256': digest.hexdigest()}


def save_report(session, args, error=None, final=False, filename='evidence.json'):
    raw_mode = isinstance(session, RawIpSession)
    report = {'schema': 'daty-shure-scan-evidence-v1', 'updated_at_utc': utc_now(),
        'target_ip': session.target, 'source': 'passive_windows_raw_ip' if raw_mode else 'passive_windows_pktmon',
        'operator_labels': {'model': args.model, 'firmware': args.firmware, 'wwb_version': args.wwb_version},
        'capture_started_at_utc': session.started_at, 'duration_limit_seconds': args.seconds,
        'capture_components': 'ip_level' if raw_mode else 'all',
        'requested_etl_limit_mb': None if raw_mode else args.max_mb,
        'requested_capture_limit_mb': args.max_mb, 'log_mode': 'stop_at_limit' if raw_mode else 'circular',
        'capture_stop_reason': session.stop_reason, 'capture_stopped_verified': session.stopped,
        'pcapng_created': session.converted, 'device_scan_protocol_verified': False,
        'device_scan_completion_verified': False, 'filter_name': session.name,
        'capture_started_clock': session.started_clock, 'watchdog_report': 'watchdog.json',
        'events': session.events, 'warnings': session.warnings, 'error': error,
        'limitations': raw_limitations() if raw_mode else LIMITATIONS, 'commands': session.commands,
        'files': [receipt for p in (session.etl, session.pcap)
                  if final and session.stopped and (receipt := file_receipt(p))]}
    if raw_mode:
        report['raw_ip'] = session.raw_metadata
        report['interface_ip'] = session.interface
    temporary = session.folder/(filename+'.tmp')
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    temporary.replace(session.folder/filename)


def watchdog_reason(parent_alive, stop_requested, now, deadline):
    if not parent_alive:
        return 'capture_window_exited'
    if stop_requested:
        return 'operator_stopped_capture'
    if now >= deadline:
        return 'duration_limit'
    return None


def run_guarded_capture(session, args, deadline, parent_alive, stop_requested,
                        ready, clock=time.monotonic, pause=time.sleep):
    """Sole PktMon owner; injectable signals/clock permit tests without capture."""
    error = None
    reason = lambda: watchdog_reason(parent_alive(), stop_requested(), clock(), deadline)
    try:
        session.stop_reason = reason()
        if session.stop_reason is None:
            session.start(may_start=lambda: reason() is None)
            save_report(session, args, filename='watchdog.json')
            ready()
            next_check = clock()+2
            while True:
                session.stop_reason = reason()
                if session.stop_reason is not None:
                    break
                if clock() >= next_check:
                    session.assert_unchanged()
                    next_check = clock()+2
                pause(.1)
    except Exception as exception:
        error = str(exception)
        try:
            session.stop_reason = reason() or session.stop_reason or 'capture_error'
        except Exception:
            session.stop_reason = 'capture_error'
    finally:
        session.close()
        save_report(session, args, error, final=True, filename='watchdog.json')
    return 0 if error is None and not session.warnings else 1


def windows_handles():
    api = ctypes.WinDLL('kernel32', use_last_error=True)
    api.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    api.OpenProcess.restype = ctypes.c_void_p
    api.CreateEventW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_wchar_p]
    api.CreateEventW.restype = ctypes.c_void_p
    api.SetEvent.argtypes = [ctypes.c_void_p]
    api.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    api.WaitForSingleObject.restype = ctypes.c_ulong
    api.CloseHandle.argtypes = [ctypes.c_void_p]
    return api


def is_signaled(api, handle):
    result = api.WaitForSingleObject(handle, 0)
    if result not in (0, 258):
        raise RuntimeError('无法读取采集进程的生命周期句柄。')
    return result == 0


def signal_event(api, handle):
    if not api.SetEvent(handle):
        raise ctypes.WinError(ctypes.get_last_error())


class CaptureWatchdog:
    """Hidden child exclusively owns PktMon and outlives a closed console.

    Inherited handles refer to the actual parent process, not a reusable PID.
    Only that child starts/stops/removes filters, so normal shutdown cannot race
    an emergency cleanup in another process. No process is forcibly terminated.
    """
    def __init__(self, session, args):
        self.session, self.args, self.process = session, args, None
        self.api, self.handles = windows_handles(), []
        self.deadline = time.monotonic()+args.seconds

    def start(self):
        parent = self.api.OpenProcess(0x00100000, True, os.getpid())  # SYNCHRONIZE
        self.handles.append(parent)
        self.handles.append(self.api.CreateEventW(None, True, False, None))  # normal stop
        self.handles.append(self.api.CreateEventW(None, True, False, None))  # ready
        if not all(self.handles):
            raise ctypes.WinError(ctypes.get_last_error())
        for handle in self.handles:
            os.set_handle_inheritable(handle, True)
        startup = subprocess.STARTUPINFO()
        startup.lpAttributeList = {'handle_list': self.handles}
        command = [str(ROOT/'app/tools/python/python.exe'), '-X', 'utf8', '-B', str(Path(__file__).resolve()),
                   '--watchdog', '--target', self.session.target, '--output', str(self.session.folder),
                   '--filter-name', self.session.name, '--deadline', str(self.deadline),
                   '--seconds', str(self.args.seconds), '--max-mb', str(self.args.max_mb),
                   '--engine', self.args.engine,
                   '--parent-handle', str(parent), '--stop-handle', str(self.handles[1]),
                   '--ready-handle', str(self.handles[2])]
        interface = self.session.interface if isinstance(self.session, RawIpSession) else self.args.interface
        if interface:
            command += ['--interface', interface]
        for key in ('model', 'firmware', 'wwb_version'):
            command += ['--'+key.replace('_', '-'), getattr(self.args, key)]
        try:
            self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, close_fds=True, startupinfo=startup,
                creationflags=subprocess.CREATE_NO_WINDOW)
        finally:
            for handle in self.handles:
                os.set_handle_inheritable(handle, False)
        ready_deadline = min(self.deadline, time.monotonic()+60)
        while not is_signaled(self.api, self.handles[2]):
            if self.process.poll() is not None:
                self.sync()
                raise RuntimeError('隐藏采集进程未就绪；详见本次 watchdog.json。')
            if time.monotonic() >= ready_deadline:
                raise RuntimeError('隐藏采集进程启动超时；已请求其正常清理。')
            time.sleep(.05)
        self.sync()

    def sync(self):
        path = self.session.folder/'watchdog.json'
        if not path.is_file():
            return
        if path.stat().st_size > 4*1024*1024:
            raise RuntimeError('采集进程报告超过限额。')
        report = json.loads(path.read_text('utf-8'))
        if report.get('target_ip') != self.session.target or report.get('filter_name') != self.session.name:
            raise RuntimeError('采集进程报告身份不匹配。')
        for field, key in [('stopped', 'capture_stopped_verified'), ('converted', 'pcapng_created'),
                           ('started_at', 'capture_started_at_utc'), ('started_clock', 'capture_started_clock'),
                           ('stop_reason', 'capture_stop_reason'), ('commands', 'commands')]:
            setattr(self.session, field, report.get(key))
        for warning in report.get('warnings', []):
            if warning not in self.session.warnings:
                self.session.warnings.append(warning)
        if isinstance(self.session, RawIpSession):
            self.session.raw_metadata = report.get('raw_ip', {})
            self.session.interface = report.get('interface_ip')
        if report.get('error') and report['error'] not in self.session.warnings:
            self.session.warnings.append(report['error'])

    def finish(self):
        try:
            if len(self.handles) > 1 and self.handles[1]:
                signal_event(self.api, self.handles[1])
            if self.process is not None:
                try:
                    self.process.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    self.session.warnings.append('隐藏进程仍在完成采集清理；最终结果请查看 watchdog.json。')
                self.sync()
        finally:
            for handle in self.handles:
                if handle:
                    self.api.CloseHandle(handle)
            self.handles = []


def watchdog_main(argv):
    internal = argparse.ArgumentParser(add_help=False)
    for key in ('target', 'output', 'filter-name', 'deadline', 'seconds', 'max-mb',
                'parent-handle', 'stop-handle', 'ready-handle'):
        internal.add_argument('--'+key, required=True)
    for key in ('model', 'firmware', 'wwb-version'):
        internal.add_argument('--'+key, default='')
    internal.add_argument('--engine', choices=('pktmon', 'raw-ip'), default='pktmon')
    internal.add_argument('--interface', type=target_address)
    args = internal.parse_args(argv)
    args.target = target_address(args.target)
    args.output = Path(args.output).resolve(strict=True)
    args.seconds = bounded_int(15, 900)(args.seconds)
    args.max_mb = bounded_int(32, 256)(args.max_mb)
    deadline = float(args.deadline)
    if not math.isfinite(deadline) or deadline > time.monotonic()+901:
        raise RuntimeError('无效的采集截止时间。')
    if not re.fullmatch(r'DatyScan_[0-9a-f]{12}', args.filter_name):
        raise RuntimeError('无效的本次过滤器身份。')
    parent, stop, ready = [int(v) for v in (args.parent_handle, args.stop_handle, args.ready_handle)]
    if min(parent, stop, ready) <= 0 or len({parent, stop, ready}) != 3:
        raise RuntimeError('无效的采集生命周期句柄。')
    api = windows_handles()
    session = make_session(args, args.output)
    session.name = args.filter_name
    try:
        return run_guarded_capture(session, args, deadline,
            parent_alive=lambda: not is_signaled(api, parent),
            stop_requested=lambda: is_signaled(api, stop), ready=lambda: signal_event(api, ready))
    finally:
        for handle in (parent, stop, ready):
            api.CloseHandle(handle)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--target', type=target_address, help='只采集这一台接收机的 IPv4；交互模式仍需亲自输入确认')
    mode = result.add_mutually_exclusive_group()
    mode.add_argument('--capture', action='store_true', help='明确开始限时被动采集；需要管理员终端')
    mode.add_argument('--check', action='store_true', help='只检查所选采集方式的本机准备条件，绝不启动采集')
    mode.add_argument('--interactive', action='store_true', help='输入目标 IP、阅读说明并按 Enter 后才开始采集')
    result.add_argument('--seconds', type=bounded_int(15, 900), default=180, help='默认 180 秒，最长 900 秒')
    result.add_argument('--max-mb', type=bounded_int(32, 256), default=128, help='记录体积限额，默认 128 MB')
    result.add_argument('--engine', choices=('pktmon', 'raw-ip'), default='pktmon', help='pktmon 或独立 IP 层采集 raw-ip')
    result.add_argument('--interface', type=target_address, help='raw-ip 的本机 IPv4；默认使用 Windows 到目标的路由网卡')
    result.add_argument('--output', type=Path, default=ROOT/'verification'/'shure-scan-evidence', help='输出父目录，每次创建独立子目录')
    for name in ('model', 'firmware', 'wwb-version'):
        result.add_argument('--'+name, default='', help='可选人工备注；不会作为已读取的设备字段')
    return result


def raw_limitations():
    return [LIMITATIONS[0], LIMITATIONS[1], LIMITATIONS[2],
        '只保存目标 IP 的 IPv4 数据包；其他网卡数据在内存中丢弃，不写入文件。',
        '采用 Windows IP 层接收，不开启网卡混杂模式；关闭专属套接字即停止，不启动 PktMon。',
        '本机试采未收到接收方向 TCP；此方式用于补齐 UDP 扫描证据，不能当作全部协议的完整抓包。',
        '记录达到体积上限即停止，不覆盖较早握手；内核接收仍可能缺包，完整性须与 WWB 文件逐点核对。',
        LIMITATIONS[4]]


def print_plan(args):
    mode = 'IP 层 / 达到体积限额停止' if args.engine == 'raw-ip' else 'PktMon / ETL 循环'
    print(f'目标接收机：{args.target}；最多 {args.seconds} 秒；{mode} {args.max_mb} MB。')
    for limitation in raw_limitations() if args.engine == 'raw-ip' else LIMITATIONS:
        print('- '+limitation)


def interactive_setup(args, read=None):
    """Only collect human intent; no PktMon access, filesystem or device I/O."""
    read = read or input
    print('DATY RF PRO · ULXD4 / WWB 扫描证据采集')
    print('当前尚未开始采集。WWB 必须在运行本工具的同一台电脑上操作接收机扫描。')
    print('首次推荐：采集启动后，在 WWB 完成一次自然结束的扫描，再保存对应的 .sdb3 文件。')
    print('取消、断线、恢复标记只用于实际观察；不要求拔网线、关机或中断现场音频。')
    print('脚本不会替你操作 WWB 或接收机，也不会自动停止 WWB 扫描。\n')
    example = args.target or '192.0.2.104'
    try:
        while True:
            entered = read(f'请输入单台接收机 IP（例如 {example}；必须输入；留空或 Q 取消）：').strip()
            if not entered or entered.lower() == 'q':
                print('已取消，没有开始采集。')
                return False
            try:
                args.target = target_address(entered)
                break
            except argparse.ArgumentTypeError as error:
                print('输入无效：'+str(error))
        print()
        print_plan(args)
        print('\n开始后按键标记（无需回车）：S 在 WWB 开始；N 自然完成；C 手动取消；D 断线；R 恢复。')
        print('首次只需 S→N；多轮试验可再次按 S。所有标记都是人工观察，并非设备协议确认。')
        print('按 Q 或 Ctrl+C 正常结束；独立隐藏进程会在窗口退出或到时后清理。不要并行使用其他 PktMon 工具。')
        print('输出父目录：'+str(args.output.resolve())+'；完成后将对应 .sdb3 放入本次独立目录。')
        if read(f'确认只采集 {args.target}：准备好后按 Enter 开始；输入其他内容则取消：').strip():
            print('已取消，没有开始采集。')
            return False
    except (EOFError, KeyboardInterrupt):
        print('\n已取消，没有开始采集。')
        return False
    args.capture = True
    return True


def main(argv=None):
    argument_parser = parser()
    args = argument_parser.parse_args(argv)
    if args.interactive:
        if not interactive_setup(args):
            return 0
    else:
        if not args.target:
            argument_parser.error('命令模式需要 --target；双击入口或 --interactive 可交互输入。')
        print_plan(args)
    if not args.capture and not args.check:
        print('当前只是计划，没有开启采集。先用 --check 检查；需采集时，在管理员 PowerShell 加 --capture。')
        return 0
    session = make_session(args, args.output.resolve())
    if args.check:
        session.preflight()
        print('只读准备检查通过；实际采集尚未开启，启动时会重新核对。')
        return 0
    if not ctypes.windll.shell32.IsUserAnAdmin():
        raise RuntimeError('请在管理员 PowerShell 运行 --capture；脚本不会自动提权。')
    if not sys.stdin.isatty():
        raise RuntimeError('需要可交互终端，以便标记 WWB 操作和正常结束。')
    import msvcrt
    stopped = [False]
    def interrupt(signum, frame):
        stopped[0] = True
    old_signals = {sig: signal.signal(sig, interrupt) for sig in (signal.SIGINT, signal.SIGBREAK)}
    try:
        with CaptureMutex():
            folder = args.output.resolve()/(datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8])
            session = make_session(args, folder)
            session.preflight()  # Abort busy sessions before creating an output directory.
            folder.mkdir(parents=True, exist_ok=False)
            error, guardian = None, None
            try:
                guardian = CaptureWatchdog(session, args)
                guardian.start()
                save_report(session, args)
                print('\n正在被动采集。请在同一台电脑的 WWB 选择此接收机并操作扫描。')
                print('回到本终端按键标记（无需回车）：S 开始；N 自然完成；C 手动取消；D 断线；R 恢复；Q 结束采集。')
                print('首次推荐一次 S→N 自然完成，再保存 .sdb3。后续可多轮标记；不要求拔网线或中断现场音频。')
                print('标记不向设备发命令；采集停止也不会停止 WWB 扫描。')
                print('用 Q / Ctrl+C 正常结束；窗口意外退出或到时，隐藏守护进程会清理本次采集。')
                print('完成后将 WWB 对应的 .sdb3 导出文件放入此目录用于逐点比对：\n'+str(folder))
                while time.monotonic() < guardian.deadline and not stopped[0]:
                    if guardian.process.poll() is not None:
                        guardian.sync()
                        break
                    if msvcrt.kbhit():
                        key = msvcrt.getwch().lower()
                        if key == 'q':
                            session.stop_reason = 'operator_stopped_capture'
                            break
                        if session.mark(key):
                            print(MARKS[key][1]+'（人工观察）')
                            save_report(session, args)
                    time.sleep(.05)
                session.stop_reason = session.stop_reason or ('console_interrupt' if stopped[0] else 'duration_limit')
            except Exception as exception:
                error, session.stop_reason = str(exception), 'capture_error'
            finally:
                if guardian is not None:
                    try:
                        guardian.finish()
                    except Exception as exception:
                        session.warnings.append('守护进程清理结果未确认：'+str(exception))
                save_report(session, args, error, final=True)
            print('\n证据目录：'+str(folder))
            if error:
                print('采集错误：'+error)
            for warning in session.warnings:
                print('注意：'+warning)
            print('元信息已保存。请以 ETL/pcapng 与 WWB 原始导出核实协议；当前没有声称扫描适配已完成。')
            return 0 if not error and not session.warnings and session.converted else 1
    finally:
        for sig, handler in old_signals.items():
            signal.signal(sig, handler)


if __name__ == '__main__':
    try:
        exit_code = watchdog_main(sys.argv[2:]) if sys.argv[1:2] == ['--watchdog'] else main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print('未完成：'+str(error), file=sys.stderr)
        exit_code = 1
    finally:
        if '--interactive' in sys.argv:
            try:
                input('\n按 Enter 关闭此窗口。')
            except (EOFError, KeyboardInterrupt):
                pass
    raise SystemExit(exit_code)
