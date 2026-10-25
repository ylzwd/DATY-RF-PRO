"""Shared private-file storage for HTTP identities, receiver pairing and TLS.

All administration remains local-only. Protected directories must be outside
the web root. Files inherit owner/Administrators/SYSTEM DACL on Windows.
"""
from __future__ import annotations

import ctypes
from contextlib import contextmanager
import json
import os
from pathlib import Path
import secrets

def validate_path(path):
    path = path.absolute()
    project = Path(__file__).resolve().parent
    if any(path.resolve().is_relative_to(root) for root in (project, project.parent / 'FAshe')):
        raise ValueError('凭据必须放在服务器及 FAshe 公开目录之外')
    # Never apply an ACL to a user home, drive root, or generic shared folder.
    if path.parent.name != 'security' and not path.parent.name.startswith('daty-security-'):
        raise ValueError('请使用专用 security 或 daty-security-* 目录，禁止对通用目录设置 ACL')
    for part in (path, *path.parents):
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
            raise ValueError('凭据路径不得经过符号链接或 junction')
    return path


def secure_directory(directory):
    directory.mkdir(parents=True, exist_ok=True)
    if os.name == 'nt':
        _secure_windows_dacl(directory)
    else:
        directory.chmod(0o700)


def _secure_windows_dacl(directory):
    """Set only DACL, never SACL/owner or process privileges. No shell dependency.

    Set-Acl on some Windows PowerShell builds attempts SACL updates requiring
    SeSecurityPrivilege. This explicit Win32 DACL-only operation needs only
    WRITE_DAC on the operator-owned dedicated directory; OS denial fails closed.
    """
    from ctypes import wintypes as wt
    security = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    pointer = ctypes.c_void_p
    security.OpenProcessToken.argtypes = [wt.HANDLE, wt.DWORD, ctypes.POINTER(wt.HANDLE)]
    security.OpenProcessToken.restype = wt.BOOL
    security.GetTokenInformation.argtypes = [wt.HANDLE, ctypes.c_int, pointer, wt.DWORD, ctypes.POINTER(wt.DWORD)]
    security.GetTokenInformation.restype = wt.BOOL
    security.ConvertSidToStringSidW.argtypes = [pointer, ctypes.POINTER(wt.LPWSTR)]
    security.ConvertSidToStringSidW.restype = wt.BOOL
    security.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wt.LPCWSTR, wt.DWORD, ctypes.POINTER(pointer), ctypes.POINTER(wt.DWORD)]
    security.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wt.BOOL
    security.GetSecurityDescriptorDacl.argtypes = [pointer, ctypes.POINTER(wt.BOOL), ctypes.POINTER(pointer), ctypes.POINTER(wt.BOOL)]
    security.GetSecurityDescriptorDacl.restype = wt.BOOL
    security.SetNamedSecurityInfoW.argtypes = [wt.LPWSTR, ctypes.c_int, wt.DWORD, pointer, pointer, pointer, pointer]
    security.SetNamedSecurityInfoW.restype = wt.DWORD
    kernel.GetCurrentProcess.restype = wt.HANDLE
    kernel.CloseHandle.argtypes = [wt.HANDLE]
    kernel.LocalFree.argtypes = [pointer]
    kernel.LocalFree.restype = pointer
    handle, sid_text, descriptor = wt.HANDLE(), wt.LPWSTR(), pointer()
    try:
        if not security.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(handle)):
            raise ctypes.WinError(ctypes.get_last_error())
        size = wt.DWORD()
        security.GetTokenInformation(handle, 1, None, 0, ctypes.byref(size))  # TokenUser
        if not size.value:
            raise ctypes.WinError(ctypes.get_last_error())
        token_user = ctypes.create_string_buffer(size.value)
        if not security.GetTokenInformation(handle, 1, token_user, size.value, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        sid = ctypes.cast(token_user, ctypes.POINTER(pointer))[0]
        if not security.ConvertSidToStringSidW(sid, ctypes.byref(sid_text)):
            raise ctypes.WinError(ctypes.get_last_error())
        identities = sorted({'SY', 'BA', sid_text.value})
        sddl = 'D:P' + ''.join(f'(A;OICI;FA;;;{identity})' for identity in identities)
        if not security.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        present, defaulted, dacl = wt.BOOL(), wt.BOOL(), pointer()
        if not security.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)) or not present or not dacl:
            raise OSError('无法构造凭据目录访问规则')
        # SE_FILE_OBJECT=1; DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION.
        code = security.SetNamedSecurityInfoW(str(directory), 1, 0x80000004, None, None, dacl, None)
        if code:
            raise ctypes.WinError(code)
    finally:
        if descriptor:
            kernel.LocalFree(descriptor)
        if sid_text:
            kernel.LocalFree(ctypes.cast(sid_text, pointer))
        if handle:
            kernel.CloseHandle(handle)


@contextmanager
def registry_lock(path):
    lock = path.parent / '.access-admin.lock'
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise RuntimeError('已有密钥管理操作；如果上次意外退出，请先核实后移除 .access-admin.lock') from None
    os.close(descriptor)
    try:
        yield
    finally:
        lock.unlink()


def save_registry(path, registry):
    # New file inherits protected directory ACL. Never follow an existing temp
    # path; exclusive creation and atomic replacement keep readers fail-closed.
    temporary = path.parent / ('.access-' + secrets.token_hex(12) + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump(registry, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def exclusive_write(path, data):
    """Create one private file without overwriting/following an existing path."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(data.encode('utf-8') if isinstance(data, str) else data)
        output.flush()
        os.fsync(output.fileno())
