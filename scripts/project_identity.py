"""Select machine/user-local state without opening another computer's private files."""
from pathlib import Path
import ctypes,hashlib,json,os,re,winreg
from ctypes import wintypes as wt

def host_id():
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,r'SOFTWARE\Microsoft\Cryptography',0,winreg.KEY_READ|winreg.KEY_WOW64_64KEY) as key:
        guid=winreg.QueryValueEx(key,'MachineGuid')[0].strip().lower()
    security=ctypes.WinDLL('advapi32',use_last_error=True);kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    security.OpenProcessToken.argtypes=[wt.HANDLE,wt.DWORD,ctypes.POINTER(wt.HANDLE)]
    security.GetTokenInformation.argtypes=[wt.HANDLE,ctypes.c_int,ctypes.c_void_p,wt.DWORD,ctypes.POINTER(wt.DWORD)]
    security.ConvertSidToStringSidW.argtypes=[ctypes.c_void_p,ctypes.POINTER(wt.LPWSTR)]
    kernel.GetCurrentProcess.restype=wt.HANDLE;kernel.CloseHandle.argtypes=[wt.HANDLE];kernel.LocalFree.argtypes=[ctypes.c_void_p]
    handle=wt.HANDLE();text=wt.LPWSTR()
    try:
        if not security.OpenProcessToken(kernel.GetCurrentProcess(),8,ctypes.byref(handle)):raise ctypes.WinError()
        size=wt.DWORD();security.GetTokenInformation(handle,1,None,0,ctypes.byref(size))
        if not size.value:raise ctypes.WinError()
        buffer=ctypes.create_string_buffer(size.value)
        if not security.GetTokenInformation(handle,1,buffer,size,ctypes.byref(size)):raise ctypes.WinError()
        sid=ctypes.cast(buffer,ctypes.POINTER(ctypes.c_void_p))[0]
        if not security.ConvertSidToStringSidW(sid,ctypes.byref(text)):raise ctypes.WinError()
        return hashlib.sha256((guid+'|'+text.value.upper()).encode('utf-8')).hexdigest()[:32]
    finally:
        if text:kernel.LocalFree(text)
        if handle:kernel.CloseHandle(handle)

def instance_root(root,current_host=None):
    root=Path(root).resolve();current_host=current_host or host_id()
    if not re.fullmatch('[0-9a-f]{32}',current_host):raise ValueError('Invalid local host identity')
    identity=root/'config/project-instance.local.json'
    if identity.exists():
        if identity.stat().st_size>4096:raise ValueError('Invalid instance record')
        owner=json.loads(identity.read_text('utf-8-sig')).get('host_id','')
        if not re.fullmatch('[0-9a-f]{32}',owner):raise ValueError('Missing machine ownership: use a clean source export, do not adopt old credentials')
        if owner!=current_host:root=root/'.local-instances'/current_host
    for p in (root,*root.parents):
        if p.is_symlink() or p.is_junction():raise ValueError('Local instance directory links forbidden')
    return root
