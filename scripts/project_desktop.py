"""Native-window ownership for the independent project's graceful lifecycle."""
import ctypes
from pathlib import Path


class ProcessLifetime:
    """Keep a Windows process handle so a reused PID cannot become the owner."""
    def __init__(self, pid, expected_images):
        self.api = ctypes.WinDLL('kernel32', use_last_error=True)
        self.api.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        self.api.OpenProcess.restype = ctypes.c_void_p
        self.api.CloseHandle.argtypes = [ctypes.c_void_p]
        self.api.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        self.api.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
        self.handle = self.api.OpenProcess(0x1000 | 0x100000, False, int(pid))
        if not self.handle:
            if ctypes.get_last_error() == 87: return  # Owner already exited.
            raise ctypes.WinError(ctypes.get_last_error())
        size = ctypes.c_ulong(32768); buffer = ctypes.create_unicode_buffer(size.value)
        if not self.api.QueryFullProcessImageNameW(self.handle, 0, buffer, ctypes.byref(size)):
            self.close(); raise RuntimeError('Cannot identify desktop owner')
        if Path(buffer.value).resolve() not in {Path(p).resolve() for p in expected_images}:
            self.close(); raise RuntimeError('Desktop owner belongs to another application')

    @property
    def exited(self):
        if not self.handle: return True
        result = self.api.WaitForSingleObject(self.handle, 0)
        if result not in (0, 258): raise ctypes.WinError(ctypes.get_last_error())
        return result == 0

    def close(self):
        if self.handle: self.api.CloseHandle(self.handle); self.handle = None


def process_image(pid):
    api = ctypes.WinDLL('kernel32', use_last_error=True)
    api.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    api.OpenProcess.restype = ctypes.c_void_p
    api.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
    api.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = api.OpenProcess(0x1000, False, int(pid))
    if not handle:
        return None
    try:
        size = ctypes.c_ulong(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        return Path(buffer.value) if api.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)) else None
    finally:
        api.CloseHandle(handle)


def native_processes(root):
    api = ctypes.WinDLL('kernel32', use_last_error=True)
    api.K32EnumProcesses.argtypes = [ctypes.POINTER(ctypes.c_ulong), ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)]
    capacity = 1024
    while capacity <= 32768:
        pids = (ctypes.c_ulong * capacity)()
        used = ctypes.c_ulong()
        if not api.K32EnumProcesses(pids, ctypes.sizeof(pids), ctypes.byref(used)):
            raise ctypes.WinError(ctypes.get_last_error())
        if used.value < ctypes.sizeof(pids):
            break
        capacity *= 2
    else:
        raise RuntimeError('Cannot confirm native-window ownership; server was not stopped')
    publication = (Path(root) / 'native/publish').resolve()
    result = []
    for pid in pids[:used.value // ctypes.sizeof(ctypes.c_ulong)]:
        path = process_image(pid)
        if path is None or path.name.lower() != 'daty.rf.native.exe':
            continue
        path = path.resolve()
        if path.is_relative_to(publication):
            result.append(pid)
    return result
