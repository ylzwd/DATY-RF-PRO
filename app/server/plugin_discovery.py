"""Bounded host scheduling of installed adapters' LAN discovery, not RF scans."""
import threading
import time


class AutoDiscovery:
    def __init__(self, manager, service, *, allowed=lambda: True, interval=60):
        self.manager, self.service, self.allowed = manager, service, allowed
        self.interval = interval
        self.stop_event = threading.Event()
        self.thread = None
        self.next_attempt = {}
        self.errors = {}

    def start(self):
        if self.thread is None and not self.stop_event.is_set():
            self.thread = threading.Thread(target=self.run, name='Plugin-discovery', daemon=True)
            self.thread.start()

    def ready(self):
        return (not self.stop_event.is_set() and not self.manager.closed
                and self.service.accepting and not self.service.repo.poisoned and self.allowed())

    def tick(self):
        if not self.ready():
            return
        for identity, item in list(self.manager.active.items()):
            adapter = item['discovery']
            if identity in self.manager.removal.draining or not item['release']['capabilities'].get('discover'):
                continue
            if not all(hasattr(adapter, name) for name in ('lock', 'snapshot', 'request_scan', 'stop_event')):
                self.errors[identity] = 'DISCOVERY_SCHEDULER_INTERFACE_UNAVAILABLE'
                continue
            key = (identity, item['sha256'])
            if time.monotonic() < self.next_attempt.get(key, 0):
                continue
            try:
                # Same lock/order as manual scan claim and receipt completion.
                # A completed scan may still have a pending durable receipt.
                with adapter.lock:
                    if not self.ready() or self.manager.active.get(identity) is not item:
                        continue
                    if self.service.active_scan or adapter.stop_event.is_set():
                        continue
                    state = adapter.snapshot()
                    if not state.get('enabled') or state.get('scanning'):
                        continue
                    self.next_attempt[key] = time.monotonic() + self.interval
                    adapter.request_scan()
                    self.errors.pop(identity, None)
            except Exception as error:
                # One failing plugin must not disable other brands or spin.
                self.next_attempt[key] = time.monotonic() + self.interval
                self.errors[identity] = type(error).__name__

    def run(self):
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception as error:
                self.errors['host'] = type(error).__name__
            self.stop_event.wait(1)

    def stop(self):
        self.stop_event.set()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(3)
