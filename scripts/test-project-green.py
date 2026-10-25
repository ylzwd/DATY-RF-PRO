"""Run only in a newly extracted verification copy, never a user's data directory."""
import contextlib, ctypes, json, os, socket, sqlite3, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT/'scripts'))
from project_desktop import native_processes, process_image


def read(path): return json.loads(path.read_text('utf-8'))


def wait_for(probe, seconds=50):
    deadline = time.monotonic()+seconds
    while time.monotonic() < deadline:
        result = probe()
        if result: return result
        time.sleep(.2)
    raise TimeoutError('Portable verification timed out')


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def windows():
    pids = set(native_processes(ROOT)); found = []
    api = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
    api.EnumWindows.argtypes = [callback_type, ctypes.c_void_p]
    api.IsWindowVisible.argtypes = [ctypes.c_void_p]
    api.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    api.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
    @callback_type
    def collect(hwnd, _):
        pid = ctypes.c_ulong(); api.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids and api.IsWindowVisible(hwnd):
            title = ctypes.create_unicode_buffer(1024); api.GetWindowTextW(hwnd, title, 1024)
            if 'DATY' in title.value: found.append((hwnd, pid.value, title.value))
        return 1
    api.EnumWindows(collect, None)
    return found


def close_windows():
    api = ctypes.WinDLL('user32', use_last_error=True)
    api.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
    for hwnd, _, _ in windows(): api.PostMessageW(hwnd, 0x0010, None, None)


def main():
    # This marker is placed by the archive verification operator after extracting
    # into a fresh directory. Never initialize or rewrite a working installation.
    if not (ROOT/'.portable-test-fixture').is_file() or any((ROOT/p).exists() for p in ('data', 'runtime', '.local-instances', 'config/project-instance.local.json')):
        raise ValueError('Requires a fresh extracted verification fixture')
    profile_path = ROOT/'config/project-development.json'
    original = profile_path.read_bytes(); profile = json.loads(original)
    profile['web_port'] = free_port(); profile['mqtt_port'] = free_port()
    while profile['web_port'] == profile['mqtt_port']: profile['mqtt_port'] = free_port()
    profile_path.write_text(json.dumps(profile), encoding='utf-8')
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('CODEX', 'PYTHON', 'DOTNET', 'DATY', 'NUGET', 'VIRTUAL_ENV'))}
    windows_root = os.environ['SystemRoot']
    env['PATH'] = str(Path(windows_root)/'System32')
    env['DOTNET_MULTILEVEL_LOOKUP'] = '0'
    status_file = ROOT/'runtime/runtime-status.json'; owned_boot = None; identity = None; results = []
    def status():
        try: return read(status_file)
        except (OSError, ValueError): return {}
    def ready():
        s = status()
        return s if s.get('state') == 'running' and s.get('transport', {}).get('ready') and s.get('persistence', {}).get('writable') else None
    try:
        for entry in ('exe', 'vbs'):
            command = [str(ROOT/'DATY RF PRO.exe')] if entry == 'exe' else [str(Path(windows_root)/'System32/wscript.exe'), str(ROOT/'启动DATY RF PRO.vbs')]
            started = time.monotonic()
            with subprocess.Popen(command, cwd=windows_root, env=env, creationflags=subprocess.CREATE_NO_WINDOW) as launcher:
                running = wait_for(ready); owned_boot = running['boot_id']; visible = wait_for(windows)
                launcher.wait(timeout=15)
            startup = round(time.monotonic()-started, 2)
            assert process_image(running['pid']).resolve() == (ROOT/'app/tools/python/python.exe').resolve()
            current_identity = read(ROOT/'config/project-instance.local.json')
            if identity is not None: assert current_identity == identity, 'Identity changed on restart'
            identity = current_identity
            close_windows()
            lifecycle_file = ROOT/'runtime/desktop-lifecycle.json'
            def stopped():
                if lifecycle_file.exists():
                    s = read(lifecycle_file)
                    if s.get('boot_id') == owned_boot and s.get('state') == 'stopped': return s
                return None
            lifecycle = wait_for(stopped)
            assert not native_processes(ROOT) and process_image(running['pid']) is None
            assert status()['state'] == 'stopped'
            for port in (profile['web_port'], profile['mqtt_port']):
                with socket.socket() as sock: sock.bind(('127.0.0.1', port))
            results.append({'entry': entry, 'startup_seconds': startup, 'window_title': visible[0][2],
                            'backend_ready': True, 'normal_shutdown': True, 'ports_released': True})
            owned_boot = None
        with contextlib.closing(sqlite3.connect(ROOT/'data/db/daty-rf.sqlite3', timeout=.2)) as db:
            assert db.execute('pragma integrity_check').fetchone()[0] == 'ok'
            assert db.execute('select count(*) from live_samples').fetchone()[0] == 0
            db.execute('begin exclusive'); db.rollback()
        report = {'ok': True, 'root': str(ROOT), 'external_tool_path_removed': True, 'codex_environment_removed': True,
                  'entries': results, 'new_identity_stable': True, 'database_integrity': 'ok', 'empty_samples': True}
        (ROOT/'verification').mkdir(exist_ok=True)
        (ROOT/'verification/green-runtime.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        close_windows()
        if owned_boot:
            s = status()
            if s.get('boot_id') == owned_boot and s.get('state') != 'stopped':
                (ROOT/'runtime/stop.request.json').write_text(json.dumps({'boot_id': owned_boot}))
                wait_for(lambda: process_image(s['pid']) is None)
        profile_path.write_bytes(original)


if __name__ == '__main__': main()
