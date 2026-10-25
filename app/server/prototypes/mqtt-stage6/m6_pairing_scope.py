"""Per-packet registry view for the receiver worker, never a control cache.

Queued input is freshly validated at entry. The same immutable registry object
supplies GROUP and credential checks while processing that packet. Any disk
backpressure refreshes it; even without a wait a view lasts at most 10 ms.
Other threads, enrollment and command validation always call the original load.
"""
from contextlib import contextmanager
import threading
import time

class PacketRegistry:
    def __init__(self,policy):
        self.policy=policy;self.original=policy._load;self.local=threading.local()
        policy._load=self.load
    def load(self):
        if not getattr(self.local,'active',False):return self.original()
        if time.monotonic()>=self.local.until:self.refresh()
        return self.local.registry
    def refresh(self):
        if getattr(self.local,'active',False):
            self.local.registry=self.original();self.local.until=time.monotonic()+.01
    @contextmanager
    def packet(self):
        if getattr(self.local,'active',False):raise RuntimeError('Nested packet registry view')
        self.local.active=True;self.local.until=0
        try:
            self.refresh()
            yield
        finally:
            self.local.active=False;self.local.registry=None
    def close(self):self.policy._load=self.original
