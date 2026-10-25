"""Placement policy, restoration and real child inheritance; no site services."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parent))
from m6_cpu_placement import CpuPlacementLease, PlacementManager, WindowsPlacement, performance_mask


ROWS=[dict(id=i,group=0,logical=i,core=i//2 if i<4 else i,efficiency=1 if i<4 else 0,flags=0) for i in range(6)]


class Fake:
    def __init__(self):self.current=63;self.calls=[]
    def mask(self):return self.current
    def set_mask(self,value):self.calls.append(value);self.current=value
    def selection(self,original):return performance_mask(ROWS,original)


class PlacementTests(unittest.TestCase):
    def test_discovery_selects_available_fast_cores_not_fixed_cpu_numbers(self):
        self.assertEqual(performance_mask(ROWS,63),(15,'performance-cores'))
        rotated=[{**r,'logical':r['logical']+4,'core':r['core']+4} for r in ROWS]
        self.assertEqual(performance_mask(rotated,63<<4),(15<<4,'performance-cores'))
        self.assertEqual(performance_mask(ROWS,15),(15,'already-performance'))

    def test_restrictions_reservations_and_unsupported_topology(self):
        self.assertIsNone(performance_mask(ROWS,3)[0])
        self.assertIsNone(performance_mask(ROWS,48)[0])
        self.assertIsNone(performance_mask(ROWS,63,2)[0])
        self.assertIsNone(performance_mask([{**r,'efficiency':0} for r in ROWS],63)[0])
        reserved=[{**r,'flags':2} if r['core']==1 else r for r in ROWS]
        self.assertIsNone(performance_mask(reserved,63)[0])
        self.assertEqual(performance_mask([{**r,'flags':6} for r in ROWS],63)[0],15)

    def test_nested_lifetime_restores_only_at_last_release(self):
        adapter=Fake();manager=PlacementManager(lambda:adapter)
        self.assertTrue(manager.acquire()['applied']);manager.acquire()
        manager.release();self.assertEqual(adapter.current,15)
        manager.release();self.assertEqual(adapter.current,63)
        self.assertEqual(adapter.calls,[15,63])

    def test_external_affinity_change_is_never_overwritten(self):
        adapter=Fake();manager=PlacementManager(lambda:adapter)
        manager.acquire();adapter.current=7;manager.release()
        self.assertEqual(adapter.current,7)

    def test_api_failure_or_overbroad_selection_does_not_expand_allowance(self):
        for factory in (None,lambda: (_ for _ in ()).throw(OSError('unavailable'))):
            manager=PlacementManager(factory)
            self.assertFalse(manager.acquire()['applied']);manager.release()
        adapter=Fake();adapter.selection=lambda original:(255,'invalid')
        manager=PlacementManager(lambda:adapter)
        self.assertEqual(manager.acquire()['reason'],'placement-unavailable')
        manager.release();self.assertEqual(adapter.calls,[])

    @unittest.skipUnless(os.name=='nt','Windows only')
    def test_real_lease_and_spawned_child_restore_original_mask(self):
        api=WindowsPlacement();before=api.mask()
        lease=CpuPlacementLease()
        try:
            inside=api.mask()
            self.assertEqual(inside & ~before,0)
            program="import ctypes;from ctypes import wintypes;k=ctypes.WinDLL('kernel32');k.GetCurrentProcess.restype=wintypes.HANDLE;k.GetProcessAffinityMask.argtypes=[wintypes.HANDLE,ctypes.POINTER(ctypes.c_size_t),ctypes.POINTER(ctypes.c_size_t)];a=ctypes.c_size_t();b=ctypes.c_size_t();assert k.GetProcessAffinityMask(k.GetCurrentProcess(),ctypes.byref(a),ctypes.byref(b));print(a.value)"
            result=subprocess.run([sys.executable,'-c',program],capture_output=True,text=True,check=True,
                                  creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(int(result.stdout.strip()),inside)
        finally:lease.close();lease.close()
        self.assertEqual(api.mask(),before)


if __name__=='__main__':unittest.main()
