"""Independent metadata observation times; SAMPLE never renews battery validity."""
import time


class MetadataFreshness:
    def __init__(self, count, ttl=15):
        self.ttl=ttl
        self.seen={ch:{} for ch in range(1,count+1)}
        self.stale={ch:set() for ch in self.seen}

    def observe(self, channel, values, now=None, wall_ms=None):
        now=time.monotonic() if now is None else now
        wall_ms=int(time.time()*1000) if wall_ms is None else wall_ms
        for key in values:
            self.seen[channel][key]=now
            self.stale[channel].discard(key)
        return {'field_times':{key:wall_ms for key in values},
                'stale_fields':sorted(self.stale[channel])}

    def expire(self, now=None, disconnected=False):
        now=time.monotonic() if now is None else now
        patches={}
        for channel, seen in self.seen.items():
            expired={key for key,at in seen.items() if disconnected or now-at>self.ttl}
            if not expired.issubset(self.stale[channel]):
                self.stale[channel].update(expired)
                patches[str(channel)]={'channel_number':channel,'stale_fields':sorted(self.stale[channel])}
        return patches
