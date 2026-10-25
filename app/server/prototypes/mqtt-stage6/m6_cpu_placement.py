"""Scoped Windows hybrid-CPU placement for the M6 runtime, at normal priority.

Discover performance cores, intersect existing process restrictions, and restore
only the mask still owned by this lease. No fixed CPU numbers, power-plan edits,
thread priority elevation or production process lookup. Homogeneous/non-Windows
hosts retain their scheduler. Unsupported topology is observable, not guessed.
"""
import os
import threading


def performance_mask(rows, allowed, groups=1):
    if groups != 1:
        return None, 'multiple-processor-groups'
    rows = [row for row in rows if row['group'] == 0]
    classes = {row['efficiency'] for row in rows}
    if len(classes) < 2:
        return None, 'homogeneous'
    highest = max(classes)
    candidates = [r for r in rows if r['efficiency'] == highest
                  and allowed & (1 << r['logical'])
                  and not (r['flags'] & 2 and not r['flags'] & 4)]
    if len({r['core'] for r in candidates}) < 2:
        return None, 'insufficient-allowed-performance-cores'
    mask = sum(1 << r['logical'] for r in candidates)
    return mask, 'already-performance' if mask == allowed else 'performance-cores'


class WindowsPlacement:
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ctypes = ctypes
        self.api = ctypes.WinDLL('kernel32', use_last_error=True)
        api = self.api
        api.GetCurrentProcess.restype = wintypes.HANDLE
        api.GetProcessAffinityMask.argtypes = [wintypes.HANDLE, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t)]
        api.SetProcessAffinityMask.argtypes = [wintypes.HANDLE, ctypes.c_size_t]
        api.GetActiveProcessorGroupCount.restype = wintypes.WORD
        api.GetSystemCpuSetInformation.argtypes = [ctypes.c_void_p, wintypes.ULONG, ctypes.POINTER(wintypes.ULONG), wintypes.HANDLE, wintypes.ULONG]
        api.GetProcessDefaultCpuSets.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.ULONG), wintypes.ULONG, ctypes.POINTER(wintypes.ULONG)]
        self.handle = api.GetCurrentProcess()

    def mask(self):
        c = self.ctypes
        process, system = c.c_size_t(), c.c_size_t()
        if not self.api.GetProcessAffinityMask(self.handle, c.byref(process), c.byref(system)):
            raise OSError('CPU affinity query failed')
        return process.value & system.value

    def set_mask(self, mask):
        if not self.api.SetProcessAffinityMask(self.handle, mask):
            raise OSError('CPU affinity assignment failed')

    def selection(self, original):
        from ctypes import wintypes
        c, api = self.ctypes, self.api
        groups = api.GetActiveProcessorGroupCount()
        if groups != 1:
            return None, 'multiple-processor-groups'
        size = wintypes.ULONG()
        api.GetSystemCpuSetInformation(None, 0, c.byref(size), self.handle, 0)
        if not 0 < size.value <= 1024 * 1024:
            raise OSError('CPU topology size invalid')
        buffer = c.create_string_buffer(size.value)
        if not api.GetSystemCpuSetInformation(buffer, size.value, c.byref(size), self.handle, 0):
            raise OSError('CPU topology query failed')
        rows, offset = [], 0
        while offset < size.value:
            record = buffer.raw[offset:]
            length, kind = int.from_bytes(record[:4], 'little'), int.from_bytes(record[4:8], 'little')
            if length < 8 or offset + length > size.value:
                raise OSError('CPU topology record invalid')
            if kind == 0:
                if length < 32:raise OSError('CPU topology record incomplete')
                rows.append(dict(id=int.from_bytes(record[8:12], 'little'),
                    group=int.from_bytes(record[12:14], 'little'), logical=record[14],
                    core=record[15], efficiency=record[18], flags=record[19]))
            offset += length
        count = wintypes.ULONG()
        listed = api.GetProcessDefaultCpuSets(self.handle, None, 0, c.byref(count))
        if not listed and not count.value:
            raise OSError('CPU set query failed')
        if count.value:
            if count.value > 65536:raise OSError('CPU set count invalid')
            sets = (wintypes.ULONG * count.value)()
            if not api.GetProcessDefaultCpuSets(self.handle, sets, count.value, c.byref(count)):
                raise OSError('CPU set query failed')
            selected = set(sets)
            original &= sum(1 << r['logical'] for r in rows if r['group'] == 0 and r['id'] in selected)
        return performance_mask(rows, original, groups)


class PlacementManager:
    def __init__(self, factory=None):
        self.factory = factory
        self.lock = threading.Lock()
        self.users = 0
        self.adapter = None
        self.original = self.installed = None
        self.state = {'policy':'hybrid-performance-cores', 'applied':False, 'reason':'inactive'}

    def acquire(self):
        with self.lock:
            if not self.users:
                self.adapter = None
                self.original = self.installed = None
                self.state = {'policy':'hybrid-performance-cores','applied':False,'reason':'unsupported-host'}
                if self.factory:
                    try:
                        self.adapter = self.factory()
                        self.original = self.adapter.mask()
                        mask, reason = self.adapter.selection(self.original)
                        if mask is not None and (mask <= 0 or mask & ~self.original):
                            raise OSError('CPU selection exceeds original allowance')
                        if mask is not None and mask != self.original:
                            self.adapter.set_mask(mask)
                            self.installed = mask
                        self.state.update(reason=reason,applied=self.installed is not None,
                                          original_mask=self.original,active_mask=self.adapter.mask())
                    except (OSError, AttributeError):
                        self.state.update(reason='placement-unavailable')
            self.users += 1
            return dict(self.state)

    def release(self):
        with self.lock:
            self.users -= 1
            if self.users == 0 and self.installed is not None:
                try:
                    if self.adapter.mask() == self.installed:
                        self.adapter.set_mask(self.original)
                except OSError:
                    self.state.update(reason='restore-unconfirmed')


_manager = PlacementManager(WindowsPlacement if os.name == 'nt' else None)


class CpuPlacementLease:
    def __init__(self):
        self.closed = False
        self.state = _manager.acquire()

    def close(self):
        if not self.closed:
            self.closed = True
            _manager.release()
