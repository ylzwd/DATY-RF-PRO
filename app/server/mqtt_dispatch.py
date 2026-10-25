"""Bounded FIFO ingress; no telemetry coalescing or receiver identity decisions."""
import asyncio


class MqttDispatchQueue(asyncio.Queue):
    def __init__(self, maxsize=2048, max_bytes=16 * 1024 * 1024):
        super().__init__(maxsize=maxsize)
        self.max_bytes = max_bytes
        self.queued_bytes = self.peak_bytes = self.peak_count = self.refused = 0

    @staticmethod
    def _size(item):
        if item is None:
            return 0  # Clock refresh marker, no queued receiver payload.
        if len(item) > 4:
            return item[4]
        return len(item[1].encode('utf-8'))  # Legacy internal string fixture.

    def put_nowait(self, item):
        size = self._size(item)
        if type(size) is not int or size < 0:
            raise ValueError('Invalid ingress byte accounting')
        if self.full() or self.queued_bytes + size > self.max_bytes:
            self.refused += 1
            raise asyncio.QueueFull
        super().put_nowait(item)
        self.queued_bytes += size
        self.peak_count = max(self.peak_count, self.qsize())
        self.peak_bytes = max(self.peak_bytes, self.queued_bytes)

    def get_nowait(self):
        item = super().get_nowait()
        self.queued_bytes -= self._size(item)
        return item

    def status(self):
        return dict(queue_count=self.qsize(), queue_capacity=self.maxsize,
                    queue_bytes=self.queued_bytes, max_queue_bytes=self.max_bytes,
                    peak_count=self.peak_count, peak_bytes=self.peak_bytes, refused=self.refused)
