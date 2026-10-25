"""M6-owned interpreter fairness; never a Windows/system priority change.

SQLite is isolated separately. The receiver worker and MQTT event loop still
share this interpreter, so bound Python CPU bursts to 1 ms while M6 is active.
Respect a host's shorter interval and restore only the setting we still own.
"""
import sys
import threading

_lock = threading.Lock()
_users = 0
_previous = _installed = None


class SchedulingLease:
    def __init__(self):
        global _users, _previous, _installed
        self.closed = False
        with _lock:
            if not _users:
                _previous = sys.getswitchinterval()
                _installed = min(_previous, .001)
                sys.setswitchinterval(_installed)
            _users += 1

    def close(self):
        global _users
        with _lock:
            if self.closed:
                return
            self.closed = True
            _users -= 1
            if not _users and sys.getswitchinterval() == _installed:
                sys.setswitchinterval(_previous)
