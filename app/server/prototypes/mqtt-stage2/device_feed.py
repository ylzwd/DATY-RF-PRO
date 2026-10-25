"""Read-only subscriber to the canonical Bridge queue; never opens production DB.

The caller supplies a Bridge instance. Sequence numbers are per subscription,
not database revisions. Queue registration/snapshot use the existing SSE lock.
"""
import json
import queue
import uuid


class CanonicalFeed:
    def __init__(self, bridge, *, capacity=50):
        self.bridge = bridge
        self.capacity = capacity
        self.boot_id = uuid.uuid4().hex

    def subscribe(self):
        return Subscription(self.bridge, self.capacity)


class Subscription:
    def __init__(self, bridge, capacity):
        self.bridge, self.queue = bridge, queue.Queue(maxsize=capacity)
        self.closed = False
        with bridge._state_lock:
            bridge._state['sse_queues'].append(self.queue)
            try:
                devices = bridge._get_devices_snapshot()
            except BaseException:
                bridge._state['sse_queues'].remove(self.queue)
                raise
        self.snapshot = {'devices': devices, 'server_time_ms': int(bridge.time.time() * 1000),
                         'ts': bridge.time.time()}

    def next(self, timeout=1):
        if self.closed:
            raise ConnectionError('Canonical subscription closed')
        raw = self.queue.get(timeout=timeout)
        if raw is None:
            raise ConnectionError('Canonical queue overflow or source stopped')
        payload = json.loads(raw)
        return payload.get('type'), payload

    def close(self):
        self.closed = True
        with self.bridge._state_lock:
            if self.queue in self.bridge._state['sse_queues']:
                self.bridge._state['sse_queues'].remove(self.queue)


def envelope(boot_id, stream_id, seq, kind, payload):
    return {'schema': 'daty-device-read-v1', 'server_id': 'stage2-server',
            'boot_id': boot_id, 'stream_id': stream_id, 'seq': seq,
            'kind': kind, 'payload': payload}
