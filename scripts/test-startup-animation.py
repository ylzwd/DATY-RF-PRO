"""Real splash/main-window handoff in a fresh, marked runtime fixture only."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from project_desktop import process_image


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,required=True);args=parser.parse_args()
    root=args.root.resolve()
    if root==ROOT or not (root/'.portable-test-fixture').is_file() or any((root/name).exists() for name in ('data','runtime','.git','.local-instances')):
        raise ValueError('Requires a fresh marked standalone runtime fixture')
    profile=json.loads((root/'config/project-development.json').read_bytes())
    for port in (profile['web_port'],profile['mqtt_port']):
        with socket.socket() as probe:probe.bind(('127.0.0.1',port))
    expected={root/'DATY RF PRO.exe',root/profile['native_output']/'DATY.RF.Native.exe'}
    api=ctypes.WinDLL('user32',use_last_error=True)
    callback_type=ctypes.WINFUNCTYPE(ctypes.c_int,ctypes.c_void_p,ctypes.c_void_p)
    api.EnumWindows.argtypes=[callback_type,ctypes.c_void_p];api.IsWindowVisible.argtypes=[ctypes.c_void_p]
    api.GetWindowThreadProcessId.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong)]
    api.GetWindowTextW.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p,ctypes.c_int]
    api.PostMessageW.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_void_p,ctypes.c_void_p]
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.K32EnumProcesses.argtypes=[ctypes.POINTER(ctypes.c_ulong),ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong)]
    def has_python():
        pids=(ctypes.c_ulong*8192)();used=ctypes.c_ulong()
        if not kernel.K32EnumProcesses(pids,ctypes.sizeof(pids),ctypes.byref(used)):raise ctypes.WinError(ctypes.get_last_error())
        return any(process_image(pid)==root/'app/tools/python/python.exe' for pid in pids[:used.value//ctypes.sizeof(ctypes.c_ulong)])
    def windows():
        found=[]
        @callback_type
        def collect(hwnd,_):
            if api.IsWindowVisible(hwnd):
                title=ctypes.create_unicode_buffer(512);api.GetWindowTextW(hwnd,title,512)
                if title.value.startswith('DATY RF PRO'):
                    pid=ctypes.c_ulong();api.GetWindowThreadProcessId(hwnd,ctypes.byref(pid))
                    if process_image(pid.value) in expected:found.append((hwnd,pid.value,title.value))
            return 1
        api.EnumWindows(collect,None);return found
    def wait(probe,seconds=45):
        until=time.monotonic()+seconds
        while time.monotonic()<until:
            result=probe()
            if result:return result
            time.sleep(.03)
        raise TimeoutError('Native startup acceptance timed out')
    def status():
        try:return json.loads((root/'runtime/runtime-status.json').read_bytes())
        except (OSError,ValueError):return {}
    def mains():return [w for w in windows() if w[2]=='DATY RF PRO']
    def close(rows):
        for hwnd,_,_ in rows:api.PostMessageW(hwnd,0x0010,None,None)
    def stopped():return not windows() and status().get('state') in (None,'stopped') and not has_python()
    results=[]
    def launch(entry='exe',count=1):
        command=([str(root/'DATY RF PRO.exe')] if entry=='exe' else [str(root/profile['native_output']/'DATY.RF.Native.exe')] if entry=='native' else [str(Path(os.environ['SystemRoot'])/'System32/wscript.exe'),str(root/'启动DATY RF PRO.vbs')])
        started=time.monotonic();child=subprocess.Popen(command,cwd=root,creationflags=subprocess.CREATE_NO_WINDOW)
        splash=wait(lambda:[w for w in windows() if '正在启动' in w[2]])
        splash_seconds=time.monotonic()-started
        wait(lambda:len(mains())==count and not any('正在启动' in w[2] for w in windows()))
        elapsed=time.monotonic()-started;child.wait(timeout=10)
        value=status();assert value['state']=='running' and value['transport']['ready'] and value['persistence']['writable']
        assert splash_seconds<elapsed
        results.append({'entry':entry,'splashSeconds':round(splash_seconds,3),'mainSeconds':round(elapsed,3),'splashBeforeMain':True,'handoffCompleted':True})
        return value
    build_path=root/'config/product-build.local.json';build_bytes=build_path.read_bytes()
    try:
        first=launch();first_handles={w[0] for w in mains()}
        extra=launch(count=2);assert first['boot_id']==extra['boot_id'] and first['pid']==extra['pid']
        close([w for w in mains() if w[0] not in first_handles]);wait(lambda:len(mains())==1)
        assert status()['state']=='running';close(mains());wait(stopped)
        launch('vbs');close(mains());wait(stopped)
        launch('native');close(mains());wait(stopped)
        child=subprocess.Popen([str(root/'DATY RF PRO.exe')],cwd=root,creationflags=subprocess.CREATE_NO_WINDOW)
        close(wait(lambda:[w for w in windows() if '正在启动' in w[2]]));child.wait(timeout=10);wait(stopped)
        # Exercise the actual error screen before any backend or business write.
        damaged=json.loads(build_bytes);damaged['buildId']='f'*64
        build_path.write_text(json.dumps(damaged),encoding='utf-8')
        child=subprocess.Popen([str(root/'DATY RF PRO.exe')],cwd=root,creationflags=subprocess.CREATE_NO_WINDOW)
        failure=wait(lambda:[w for w in windows() if '启动未完成' in w[2]])
        assert not mains() and status()['state']=='stopped';close(failure);child.wait(timeout=10)
        report={'ok':True,'entries':results,'multipleWindowsShareBackend':True,'cancellationLeavesNoWindow':True,'errorScreenShownWithoutBackendStart':True,'normalShutdown':True,'physicalCommands':0}
        out=root/'verification';out.mkdir(exist_ok=True);(out/'startup-acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf-8')
        print(json.dumps(report,ensure_ascii=False,indent=2))
    finally:
        build_path.write_bytes(build_bytes);close(windows());wait(stopped)


if __name__=='__main__':main()
