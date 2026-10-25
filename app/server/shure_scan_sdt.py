"""DATY unicast SDT subset for the independently observed ULXD DMP endpoint.

This is not a general ACN implementation. It uses a fresh CID and one member,
bounded reliable queues and an explicit failure on unsupported session forms.
Wire fields: ANSI E1.17 / Wireshark ACN field definitions. Device acceptance is
separate from transport acknowledgement and must be established by the caller.
"""
from collections import OrderedDict
from dataclasses import dataclass
import secrets
import struct
import uuid

from shure_scan_wire import (ACN_IDENTIFIER, DecodeLimits, ScanWireError,
    _Budget, _pdus, decode_datagram)

MASK = 0xffffffff


class SdtError(ValueError):
    pass


def distance(sequence, previous):
    """Signed RFC1982-style serial distance; callers bound windows below 2**31."""
    value = (sequence-previous) & MASK
    return value if value < 0x80000000 else value-0x100000000


def pdu(vector, header=b'', data=b'', vector_width=1):
    body = vector.to_bytes(vector_width, 'big')+header+data
    if len(body)+2 > 4095:
        raise SdtError('SDT_PDU_LIMIT')
    return (0x7000 | (len(body)+2)).to_bytes(2, 'big')+body


def root(cid, vector, data):
    return ACN_IDENTIFIER+pdu(1, bytes.fromhex(cid), pdu(vector, data=data), 4)


def wrapped(cid, channel, total, reliable, oldest, member, association,
            protocol, items, *, is_reliable=True, request_ack=True):
    client = pdu(member, struct.pack('>IH', protocol, association), items, 2)
    header = struct.pack('>HIIIHHH', channel, total, reliable, oldest,
                         member if request_ack else 0, member if request_ack else 0, 0)
    return root(cid, 1 if is_reliable else 2, header+client)


@dataclass(frozen=True)
class Control:
    vector: int
    data: bytes
    member: int | None = None
    association: int | None = None


@dataclass(frozen=True)
class Frame:
    cid: str
    vector: int
    data: bytes
    wrapper: object = None
    controls: tuple = ()
    wire: object = None


def decode(raw):
    """Decode datagrams atomically, including wrapped SDT member association."""
    wire = decode_datagram(raw)
    frames = []
    budget = _Budget(DecodeLimits())
    for r in _pdus(raw, 16, len(raw), 4, 16, budget):
        if r.vector != 1:
            continue
        cid = r.header.hex()
        for s in _pdus(raw, r.data_start, r.data_end, 1, 0, budget):
            body = raw[s.data_start:s.data_end]
            if s.vector not in (1, 2):
                frames.append(Frame(cid, s.vector, body))
                continue
            wrapper = next(w for w in wire.wrappers if w.pdu_offset == s.offset)
            controls, records = [], []
            for c in _pdus(raw, s.data_start+20, s.data_end, 2, 6, budget):
                protocol, association = struct.unpack('>IH', c.header)
                if protocol == 1:
                    for item in _pdus(raw, c.data_start, c.data_end, 1, 0, budget):
                        controls.append(Control(item.vector, raw[item.data_start:item.data_end], c.vector, association))
                elif protocol == 2:
                    records.extend(record for record in wire.dmp_records
                        if c.data_start <= record.pdu_offset < c.data_end)
            from shure_scan_wire import WireDatagram
            subset = WireDatagram((wrapper,), tuple(records), (), wire.pdu_count, wire.expanded_bytes)
            frames.append(Frame(cid, s.vector, body, wrapper, tuple(controls), subset))
    return tuple(frames)


class SdtSession:
    """Socket-independent single unicast member session. Output is byte actions.

    on_datagram returns only reliable, ordered DMP data. Errors close this
    generation; a caller creates a new object for reconnect and never replays
    a scan start. No action knows a Shure private property address.
    """
    def __init__(self, endpoint, *, clock, cid=None, channel=None, sequence=None,
                 queue_limit=256, expiry=5):
        self.endpoint = endpoint
        self.peer = (endpoint.ip, endpoint.port)
        self.clock = clock
        self.cid = uuid.UUID(cid).hex if cid else uuid.uuid4().hex
        if self.cid == endpoint.cid:
            raise SdtError('SDT_IDENTITY_COLLISION')
        self.channel = channel or secrets.randbelow(65534)+1
        self.total = self.reliable = secrets.randbits(32) if sequence is None else sequence & MASK
        self.initial = self.reliable
        self.member = 1
        self.remote_channel = None
        self.remote_member = None
        self.remote_cursor = None
        self.remote_expiry = expiry
        self.expiry = expiry
        self.limit = queue_limit
        self.state = 'new'
        self.error = None
        self.actions = []
        self.pending = OrderedDict()
        self.reorder = {}
        self.join_accepted = self.connect_accepted = self.peer_connected = False
        self.membership_acked = False
        self.connect_sent = False
        self.last_receive = self.last_send = clock()
        self.last_mak = clock()
        self.started = clock()
        self.last_ack = None
        self.last_unreliable = None
        self.gap = None
        self.nak_holdoff, self.nak_modulus, self.nak_max_wait = 2, 50, 20
        self.duplicates = self.retransmissions = self.rejected = 0
        self._join_body = None

    def drain(self):
        result, self.actions = self.actions, []
        return result

    def fail(self, reason):
        self.state, self.error = 'interrupted', reason
        self.pending.clear()
        self.reorder.clear()
        raise SdtError(reason)

    def _emit(self, raw):
        self.actions.append(raw)
        self.last_send = self.clock()

    def open(self):
        if self.state != 'new':
            raise SdtError('SDT_ALREADY_OPENED')
        self.started = self.last_receive = self.clock()
        self.state = 'joining'
        # Null destination address means return unicast to our source port.
        body = bytes.fromhex(self.endpoint.cid)+struct.pack('>HHHII', self.member,
            self.channel, 0, self.total, self.reliable)+b'\0'
        body += struct.pack('>BBHHHB', self.expiry, 0, 2, 50, 20, 255)
        self._join_body = root(self.cid, 4, body)
        self._emit(self._join_body)

    def send(self, protocol, items, *, reliable=True, association=None, request_ack=True):
        if self.remote_channel is None:
            raise SdtError('SDT_NOT_JOINED')
        if reliable and len(self.pending) >= self.limit:
            self.fail('SDT_SEND_WINDOW_FULL')
        self.total = (self.total+1) & MASK
        if reliable:
            self.reliable = (self.reliable+1) & MASK
        oldest = next(iter(self.pending), self.reliable if reliable else (self.reliable+1) & MASK)
        raw = wrapped(self.cid, self.channel, self.total, self.reliable, oldest,
            self.member, 0 if association is None else association,
            protocol, items, is_reliable=reliable, request_ack=request_ack)
        if reliable:
            self.pending[self.reliable] = [raw, self.clock(), 0]
        self._emit(raw)
        if request_ack:
            self.last_mak = self.clock()
        return self.reliable

    def _ack(self):
        self.send(1, pdu(14, data=struct.pack('>I', self.remote_cursor)),
                  reliable=False, request_ack=False, association=self.remote_channel)

    def _try_connect(self):
        if self.join_accepted and self.membership_acked and self.remote_channel is not None and not self.connect_sent:
            self.state = 'connecting'
            self.connect_sent = True
            self.send(1, pdu(9, data=struct.pack('>I', 2)), association=0)

    def _direct(self, frame):
        data = frame.data
        if frame.vector == 4:
            if len(data) != 40 or data[:16].hex() != self.cid:
                self.rejected += 1
                return
            member, channel, reciprocal, total, reliable = struct.unpack_from('>HHHII', data, 16)
            if (not member or not channel or reciprocal != self.channel or data[30] != 0
                    or not 1 <= data[31] <= 60 or data[32] != 0):
                self.fail('SDT_UNSUPPORTED_JOIN')
            identity = (channel, member, reliable)
            if self.remote_channel is not None and identity != (self.remote_channel, self.remote_member, self.remote_initial):
                self.fail('SDT_JOIN_CHANGED')
            self.remote_channel, self.remote_member = channel, member
            self.remote_initial = reliable
            if self.remote_cursor is None:
                self.remote_cursor = reliable
            self.remote_expiry = data[31]
            self.nak_holdoff, self.nak_modulus, self.nak_max_wait = struct.unpack_from('>HHH', data, 33)
            if not self.nak_modulus:
                self.fail('SDT_INVALID_NAK_MODULUS')
            accept = bytes.fromhex(self.endpoint.cid)+struct.pack('>HHIH', channel, member, reliable, self.channel)
            self._emit(root(self.cid, 6, accept))
            self._ack()
            self._try_connect()
        elif frame.vector == 6:
            if len(data) != 26 or data[:16].hex() != self.cid:
                self.rejected += 1
                return
            channel, member, reliable, reciprocal = struct.unpack_from('>HHIH', data, 16)
            if (channel, member, reliable) != (self.channel, self.member, self.initial):
                self.rejected += 1
                return
            if self.remote_channel is not None and reciprocal != self.remote_channel:
                self.fail('SDT_RECIPROCAL_MISMATCH')
            self.join_accepted = True
            self._try_connect()
        elif frame.vector in (5, 8):
            if len(data) != 25 or data[:16].hex() != self.cid:
                self.rejected += 1
                return
            channel, member = struct.unpack_from('>HH', data, 16)
            if (channel, member) != (self.channel, self.member):
                self.rejected += 1
                return
            self.fail('SDT_JOIN_REFUSED' if frame.vector == 5 else 'SDT_PEER_LEFT')
        elif frame.vector == 15:
            # A supported NAK form is implemented separately after field checks.
            self._nak(data)

    def _nak(self, data):
        # Cold NAK (leader CID, channel, member, acknowledged seq, first, last).
        if len(data) != 32 or data[:16].hex() != self.cid:
            self.rejected += 1
            return
        channel, member, acknowledged, first, last = struct.unpack_from('>HHIII', data, 16)
        if channel != self.channel or member != self.member:
            self.rejected += 1
            return
        count = distance(last, first)+1
        if not 1 <= count <= self.limit:
            self.fail('SDT_NAK_RANGE')
        for n in range(count):
            sequence = (first+n) & MASK
            cached = self.pending.get(sequence)
            if cached is None:
                self.fail('SDT_RETRANSMISSION_UNAVAILABLE')
            if cached[2] >= 3:
                self.fail('SDT_RETRANSMISSION_LIMIT')
            # Preserve original reliable/total sequence and content. Only the
            # oldest available cursor advances after other frames were ACKed.
            original = cached[0]
            offset = decode(original)[0].wrapper.pdu_offset+3+10
            oldest = next(iter(self.pending))
            refreshed = original[:offset]+struct.pack('>I', oldest)+original[offset+4:]
            self._emit(refreshed)
            cached[1] = self.clock()
            cached[2] += 1
            self.retransmissions += 1

    def _ordered(self, frame):
        for item in frame.controls:
            if item.member not in (self.remote_member, 65535):
                continue
            if item.vector == 7 and item.association == 0 and not item.data:
                self.fail('SDT_PEER_LEFT')
            if item.vector in (9, 10, 11, 12, 13):
                if len(item.data) < 4 or int.from_bytes(item.data[:4], 'big') != 2:
                    continue
                if item.vector == 9 and item.association == 0:
                    self.peer_connected = True
                    self.send(1, pdu(10, data=struct.pack('>I', 2)), association=self.remote_channel)
                elif item.association == self.channel and item.vector == 10:
                    self.connect_accepted = True
                elif ((item.association == self.channel and item.vector in (11, 13))
                        or (item.association == 0 and item.vector == 12)):
                    self.fail('SDT_DMP_REJECTED_OR_DISCONNECTED')
        if self.connect_accepted and self.peer_connected and self.join_accepted:
            self.state = 'ready'
        elif self.connect_accepted and self.join_accepted:
            self.state = 'outbound_ready'
        records = tuple(record for record in frame.wire.dmp_records
            if record.member_id in (self.remote_member, 65535)
            and (record.association == self.channel or (record.association == 0 and self.peer_connected)))
        if records and self.state in ('ready', 'outbound_ready'):
            from shure_scan_wire import WireDatagram
            return WireDatagram(frame.wire.wrappers, records, (), frame.wire.pdu_count, frame.wire.expanded_bytes)
        return None

    def receive(self, raw, peer):
        if self.state in ('closed', 'interrupted') or peer != self.peer:
            self.rejected += 1
            return []
        frames = decode(raw)
        events = []
        for frame in frames:
            if frame.cid != self.endpoint.cid:
                self.rejected += 1
                continue
            if frame.wrapper is None:
                self._direct(frame)
                self.last_receive = self.clock()
                continue
            w = frame.wrapper
            if self.remote_channel is None or w.channel != self.remote_channel:
                self.rejected += 1
                continue
            self.last_receive = self.clock()
            # Transport ACK is accepted independently of reliable delivery.
            for item in frame.controls:
                if (item.vector == 14 and item.member == self.remote_member
                        and item.association == self.channel and len(item.data) == 4):
                    ack = int.from_bytes(item.data, 'big')
                    if distance(ack, self.reliable) > 0:
                        self.fail('SDT_ACK_FUTURE')
                    self.last_ack = ack
                    if distance(ack, self.initial) >= 0:
                        self.membership_acked = True
                    self._try_connect()
                    for sequence in list(self.pending):
                        if distance(sequence, ack) <= 0:
                            del self.pending[sequence]
            if frame.vector == 2:
                if distance(w.reliable_sequence, self.remote_cursor) > 0:
                    self._request_missing(w)
                elif (w.reliable_sequence == self.remote_cursor and
                        (self.last_unreliable is None or distance(w.total_sequence, self.last_unreliable) > 0)):
                    self.last_unreliable = w.total_sequence
                    event = self._ordered(frame)
                    if event is not None:
                        events.append(event)
                if w.first_member <= self.remote_member <= w.last_member:
                    self._ack()
                continue
            ahead = distance(w.reliable_sequence, self.remote_cursor)
            if ahead <= 0:
                self.duplicates += 1
                self._ack()
                continue
            if ahead > self.limit:
                self.fail('SDT_RECEIVE_WINDOW_FULL')
            if ahead > 1:
                existing = self.reorder.get(w.reliable_sequence)
                if existing is not None and existing.data != frame.data:
                    self.fail('SDT_SEQUENCE_CONFLICT')
                self.reorder[w.reliable_sequence] = frame
                self._request_missing(w)
                continue
            current = frame
            while current is not None:
                self.remote_cursor = current.wrapper.reliable_sequence
                event = self._ordered(current)
                if event is not None:
                    events.append(event)
                current = self.reorder.pop((self.remote_cursor+1) & MASK, None)
            self._ack()
            if self.gap is not None:
                if distance(self.gap[1], self.remote_cursor) <= 0:
                    self.gap = None
                else:
                    last = self.gap[1]
                    self.gap = None
                    self._set_gap((self.remote_cursor+1) & MASK, last)
        return events

    def _request_missing(self, wrapper):
        first = (self.remote_cursor+1) & MASK
        if distance(wrapper.oldest_available, first) > 0:
            self.fail('SDT_RELIABLE_GAP_EXPIRED')
        last = (wrapper.reliable_sequence-1) & MASK if wrapper.vector == 1 else wrapper.reliable_sequence
        if distance(last, first) >= self.limit:
            self.fail('SDT_RECEIVE_WINDOW_FULL')
        self._set_gap(first, last)

    def _set_gap(self, first, last):
        if self.gap is None or self.gap[0] != first:
            holdoff = min(self.nak_max_wait,
                ((self.remote_cursor+self.remote_member) % self.nak_modulus)*self.nak_holdoff)/1000
            self.gap = [first, last, self.clock()+holdoff, 0]
        elif distance(last, self.gap[1]) > 0:
            self.gap[1] = last

    def tick(self):
        now = self.clock()
        if self.state in ('closed', 'interrupted', 'new'):
            return
        if now-self.last_receive >= self.remote_expiry:
            self.fail('SDT_SESSION_EXPIRED')
        if self.state == 'joining' and now-self.last_send >= 0.5:
            self._emit(self._join_body)
        if self.remote_channel is not None and now-self.last_mak >= min(self.expiry, self.remote_expiry)/3:
            self.send(1, pdu(14, data=struct.pack('>I', self.remote_cursor)), reliable=False, association=self.remote_channel)
        if self.gap is not None and now >= self.gap[2]:
            first, last, _, attempts = self.gap
            if attempts >= 3:
                self.fail('SDT_NAK_TIMEOUT')
            data = bytes.fromhex(self.endpoint.cid)+struct.pack('>HHIII',
                self.remote_channel, self.remote_member, self.remote_cursor, first, last)
            self._emit(root(self.cid, 15, data))
            self.gap[2:] = [now+self.remote_expiry/10, attempts+1]
        for raw, sent, retries in list(self.pending.values()):
            if now-sent >= self.expiry:
                self.fail('SDT_ACK_TIMEOUT')

    def close(self):
        if self.state not in ('new', 'closed', 'interrupted') and self.remote_channel is not None:
            if self.state == 'ready':
                self.send(1, pdu(12, data=struct.pack('>I', 2)))
            data = bytes.fromhex(self.endpoint.cid)+struct.pack('>HHIB', self.remote_channel, self.remote_member, self.remote_cursor, 0)
            self._emit(root(self.cid, 8, data))
        self.pending.clear()
        self.reorder.clear()
        self.state = 'closed'
