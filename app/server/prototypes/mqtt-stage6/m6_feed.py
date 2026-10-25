"""MQTT-only subscriber to the existing in-process canonical event bus.

The historical queue field name is not a network SSE connection. The runtime
does not expose an SSE handler; final source withdrawal will rename this field.
"""
import json
import queue
import threading
import time
import uuid
from collections import deque

class ByteQueue(queue.Queue):
    """Bound both event count and UTF-8 payload bytes; no silent sample loss."""
    def __init__(self,capacity,max_bytes=16*1024*1024):
        super().__init__(maxsize=capacity)
        self.bytes=0;self.max_bytes=max_bytes;self.peak_count=0;self.peak_bytes=0
        self.overflow=None
    def put(self,item,block=True,timeout=None):
        try:return super().put(item,block,timeout)
        except queue.Full:
            with self.mutex:
                if self.overflow is None:
                    self.overflow={'reason':'event_count' if self._qsize()>=self.maxsize else 'event_bytes',
                        'count':self._qsize(),'bytes':self.bytes,'capacity':self.maxsize,
                        'max_bytes':self.max_bytes,'at_ms':int(time.time()*1000)}
            raise
    def _put(self,item):
        size=len(item.encode('utf-8')) if item is not None else 0
        if self.bytes+size>self.max_bytes:raise queue.Full
        super()._put((item,size));self.bytes+=size
        self.peak_count=max(self.peak_count,self._qsize());self.peak_bytes=max(self.peak_bytes,self.bytes)
    def _get(self):
        item,size=super()._get();self.bytes-=size;return item

class CanonicalFeed:
    def __init__(self,bridge,*,capacity=2048):
        self.bridge=bridge;self.capacity=capacity;self.boot_id=uuid.uuid4().hex
        self._lock=threading.Lock();self._subscriptions=set();self._closed=deque(maxlen=32)
        self.closed_streams=0;self.overflowed_streams=0
    def subscribe(self):
        subscription=Subscription(self.bridge,self.capacity,on_close=self._record_closed)
        with self._lock:self._subscriptions.add(subscription)
        return subscription
    def _record_closed(self,subscription):
        with self._lock:
            if subscription not in self._subscriptions:return
            self._subscriptions.remove(subscription);self.closed_streams+=1
            self.overflowed_streams+=int(subscription.queue.overflow is not None)
            self._closed.append(subscription.statistics())
    def status(self):
        with self._lock:
            samples=[s.statistics() for s in self._subscriptions]
            closed=list(self._closed);closed_streams=self.closed_streams;overflows=self.overflowed_streams
        return {'streams':len(samples),'queued_events':sum(x['count'] for x in samples),
                'queued_bytes':sum(x['bytes'] for x in samples),'max_stream_events':max((x['count'] for x in samples),default=0),
                'peak_events':max((x['peak_count'] for x in samples+closed),default=0),
                'closed_streams':closed_streams,'overflowed_streams':overflows+sum(x['overflow'] is not None for x in samples),
                'closed_stream_details':closed}

class Subscription:
    def __init__(self,bridge,capacity,on_close=None):
        self.bridge=bridge;self.queue=ByteQueue(capacity);self.closed=False
        self.on_close=on_close
        with bridge._state_lock:
            bridge._state['sse_queues'].append(self.queue)
            try:devices=bridge._get_devices_snapshot()
            except BaseException:
                bridge._state['sse_queues'].remove(self.queue);raise
        self.snapshot={'devices':devices,'server_time_ms':int(bridge.time.time()*1000),'ts':bridge.time.time()}
    def next(self,timeout=1):
        raw=self.next_raw(timeout)
        payload=json.loads(raw);return payload.get('type'),payload
    def next_raw(self,timeout=1):
        if self.closed:raise ConnectionError('Canonical subscription closed')
        raw=self.queue.get(timeout=timeout)
        if raw is None:
            detail=self.queue.overflow
            if detail:raise ConnectionError('Canonical queue overflow: '+detail['reason'])
            raise ConnectionError('Canonical source stopped')
        return raw
    def statistics(self):
        q=self.queue
        with q.mutex:return {'count':q._qsize(),'bytes':q.bytes,'peak_count':q.peak_count,
            'peak_bytes':q.peak_bytes,'overflow':dict(q.overflow) if q.overflow else None}
    def close(self):
        if self.closed:return
        self.closed=True
        with self.bridge._state_lock:
            if self.queue in self.bridge._state['sse_queues']:self.bridge._state['sse_queues'].remove(self.queue)
        if self.on_close:self.on_close(self)

def envelope(boot_id,stream_id,seq,kind,payload):
    return {'schema':'daty-device-mqtt6-v1','server_id':'daty-rf-pro',
            'boot_id':boot_id,'stream_id':stream_id,'seq':seq,'kind':kind,'payload':payload}
