"""Bounded, offline ACN/SDT/DMP observations and ULXD scan-point coverage.

No sockets, device commands, plugin activation, storage, or scan completion
inference. The scan address/value mapping is an empirical ULXD4 observation.
Callers must assign a new session_id for each independent scan observation.
"""
from dataclasses import dataclass
import re
import struct


ACN_IDENTIFIER = b'\x00\x10\x00\x00ASC-E1.17\x00\x00\x00'
SCAN_ADDRESS_BASE = 0x10000005
MAX_POINTS = 30000


class ScanWireError(ValueError):
    def __init__(self, code, offset=None):
        self.code, self.offset = code, offset
        super().__init__(code if offset is None else f'{code} at {offset}')


def _fail(code, offset=None):
    raise ScanWireError(code, offset)


def _integer(value, low, high, code):
    if type(value) is not int or not low <= value <= high:
        _fail(code)


@dataclass(frozen=True)
class DecodeLimits:
    max_datagram_bytes: int = 65507
    max_pdus: int = 1024
    max_expanded_bytes: int = 262144
    max_elements: int = MAX_POINTS

    def __post_init__(self):
        for value, low, high in ((self.max_datagram_bytes, 16, 65507),
                                 (self.max_pdus, 1, 4096),
                                 (self.max_expanded_bytes, 1, 1048576),
                                 (self.max_elements, 1, MAX_POINTS)):
            _integer(value, low, high, 'SCAN_WIRE_INVALID_LIMIT')


@dataclass(frozen=True)
class Wrapper:
    cid: str
    channel: int
    vector: int
    total_sequence: int
    reliable_sequence: int
    oldest_available: int
    first_member: int
    last_member: int
    ack_threshold: int
    pdu_offset: int


@dataclass(frozen=True)
class UnhandledPdu:
    layer: str
    vector: int
    cid: str
    pdu_offset: int
    data: bytes


@dataclass(frozen=True)
class DmpRecord:
    cid: str
    channel: int
    total_sequence: int
    reliable_sequence: int
    member_id: int
    association: int
    vector: int
    address_header: int
    pdu_offset: int
    data_offset: int
    kind: str
    address: int | None = None
    increment: int | None = None
    count: int | None = None
    element_size: int | None = None
    values: bytes = b''
    unknown_reason: str | None = None
    raw_data: bytes = b''


@dataclass(frozen=True)
class WireDatagram:
    wrappers: tuple[Wrapper, ...]
    dmp_records: tuple[DmpRecord, ...]
    unhandled: tuple[UnhandledPdu, ...]
    pdu_count: int
    expanded_bytes: int


class _Budget:
    def __init__(self, limits):
        self.limits = limits
        self.pdus = self.bytes = self.elements = 0

    def pdu(self, size, offset):
        self.pdus += 1
        self.bytes += size
        if self.pdus > self.limits.max_pdus:
            _fail('SCAN_WIRE_PDU_LIMIT', offset)
        if self.bytes > self.limits.max_expanded_bytes:
            _fail('SCAN_WIRE_EXPANSION_LIMIT', offset)

    def array(self, count, offset):
        if count < 1:
            _fail('SCAN_WIRE_ARRAY_COUNT', offset)
        if count > self.limits.max_elements - self.elements:
            _fail('SCAN_WIRE_ELEMENT_LIMIT', offset)
        self.elements += count


@dataclass(frozen=True)
class _Pdu:
    offset: int
    vector: int
    header: bytes
    data_start: int
    data_end: int


def _pdus(raw, begin, end, vector_bytes, header_bytes, budget):
    """Inheritance is local to this sibling list, never a different layer/PDU."""
    previous_vector = None
    previous_header = b'' if header_bytes == 0 else None
    previous_data = None
    cursor = begin
    while cursor < end:
        offset = cursor
        if end - cursor < 2:
            _fail('SCAN_WIRE_PDU_TRUNCATED', offset)
        flags = raw[cursor] & 0xf0
        width = 3 if flags & 0x80 else 2
        if end - cursor < width:
            _fail('SCAN_WIRE_PDU_TRUNCATED', offset)
        size = int.from_bytes(raw[cursor:cursor+width], 'big') & ((1 << (width*8-4))-1)
        if size < width or size > end - offset:
            _fail('SCAN_WIRE_PDU_LENGTH', offset)
        stop = offset + size
        cursor += width
        if flags & 0x40:
            if vector_bytes > stop-cursor:
                _fail('SCAN_WIRE_VECTOR_TRUNCATED', offset)
            previous_vector = int.from_bytes(raw[cursor:cursor+vector_bytes], 'big')
            cursor += vector_bytes
        if flags & 0x20:
            if header_bytes > stop-cursor:
                _fail('SCAN_WIRE_HEADER_TRUNCATED', offset)
            previous_header = raw[cursor:cursor+header_bytes]
            cursor += header_bytes
        if previous_vector is None or previous_header is None:
            _fail('SCAN_WIRE_INHERITANCE_MISSING', offset)
        if flags & 0x10:
            previous_data = (cursor, stop)
        elif cursor != stop:
            _fail('SCAN_WIRE_INHERITED_DATA_TRAILING_BYTES', offset)
        if previous_data is None:
            _fail('SCAN_WIRE_INHERITANCE_MISSING', offset)
        budget.pdu(previous_data[1]-previous_data[0], offset)
        yield _Pdu(offset, previous_vector, previous_header, *previous_data)
        cursor = stop


def _dmp(raw, item, wrapper, member_id, association, budget):
    header = item.header[0]
    body = raw[item.data_start:item.data_end]
    common = dict(cid=wrapper.cid, channel=wrapper.channel,
        total_sequence=wrapper.total_sequence, reliable_sequence=wrapper.reliable_sequence,
        member_id=member_id, association=association, vector=item.vector,
        address_header=header, pdu_offset=item.offset, data_offset=item.data_start)

    def unknown(reason):
        return DmpRecord(**common, kind='unknown', unknown_reason=reason, raw_data=body)

    width = (1, 2, 4, None)[header & 3]
    if width is None:
        return unknown('unsupported_address_width')
    if header & 0x0c:
        return unknown('unsupported_address_header_bits')
    if header & 0xc0:
        return unknown('relative_or_virtual_address_not_resolved')
    form = header & 0x30
    if form == 0:
        if len(body) < width:
            return unknown('incomplete_single_address')
        return DmpRecord(**common, kind='single', address=int.from_bytes(body[:width], 'big'),
                         count=1, element_size=len(body)-width, values=body[width:])
    if form != 0x20:
        return unknown('unsupported_range_address_form')
    if len(body) < width*3:
        # Observed terminal 700a0422100009fbff99 has this shape. Its last two
        # bytes are NOT established as a measurement: increment/count are absent.
        return unknown('incomplete_array_header')
    address, increment, count = (int.from_bytes(body[n*width:(n+1)*width], 'big') for n in range(3))
    budget.array(count, item.offset)
    if address + increment*(count-1) >= 1 << (8*width):
        _fail('SCAN_WIRE_ADDRESS_OVERFLOW', item.offset)
    values = body[width*3:]
    if len(values) % count:
        _fail('SCAN_WIRE_ARRAY_VALUE_LENGTH', item.offset)
    return DmpRecord(**common, kind='array', address=address, increment=increment,
                     count=count, element_size=len(values)//count, values=values)


def decode_datagram(raw, *, limits=DecodeLimits()):
    """Decode one UDP payload atomically. Unsupported semantics stay explicit.

    All offsets refer to this UDP payload. No inheritance survives this call.
    Fixed root/SDT/client/DMP layers avoid unbounded recursive interpretation.
    """
    if not isinstance(limits, DecodeLimits):
        _fail('SCAN_WIRE_INVALID_LIMIT')
    if not isinstance(raw, bytes) or not 16 < len(raw) <= limits.max_datagram_bytes:
        _fail('SCAN_WIRE_DATAGRAM_SIZE')
    if raw[:16] != ACN_IDENTIFIER:
        _fail('SCAN_WIRE_IDENTIFIER')
    budget = _Budget(limits)
    wrappers, records, unhandled = [], [], []
    for root in _pdus(raw, 16, len(raw), 4, 16, budget):
        cid = root.header.hex()
        if root.vector != 1:
            unhandled.append(UnhandledPdu('root', root.vector, cid, root.offset, raw[root.data_start:root.data_end]))
            continue
        for sdt in _pdus(raw, root.data_start, root.data_end, 1, 0, budget):
            if sdt.vector not in (1, 2):
                unhandled.append(UnhandledPdu('sdt', sdt.vector, cid, sdt.offset, raw[sdt.data_start:sdt.data_end]))
                continue
            if sdt.data_end-sdt.data_start < 20:
                _fail('SCAN_WIRE_WRAPPER_TRUNCATED', sdt.offset)
            channel, total, reliable, oldest, first, last, threshold = struct.unpack_from('>HIIIHHH', raw, sdt.data_start)
            wrapper = Wrapper(cid, channel, sdt.vector, total, reliable, oldest, first, last, threshold, sdt.offset)
            wrappers.append(wrapper)
            for client in _pdus(raw, sdt.data_start+20, sdt.data_end, 2, 6, budget):
                protocol, association = struct.unpack('>IH', client.header)
                if protocol not in (1, 2):
                    unhandled.append(UnhandledPdu('client', protocol, cid, client.offset, raw[client.data_start:client.data_end]))
                    continue
                for item in _pdus(raw, client.data_start, client.data_end, 1, 1 if protocol == 2 else 0, budget):
                    if protocol == 1:
                        unhandled.append(UnhandledPdu('wrapped_sdt', item.vector, cid, item.offset, raw[item.data_start:item.data_end]))
                    else:
                        records.append(_dmp(raw, item, wrapper, client.vector, association, budget))
    return WireDatagram(tuple(wrappers), tuple(records), tuple(unhandled), budget.pdus, budget.bytes)


class ScanPointAssembler:
    """Explicit grid and observation session; coverage is never a device outcome.

    The caller supplies count: no inclusive/exclusive end-frequency assumption.
    Create a fresh object and session_id for every scan. There is no auto-reset
    or cross-session merging. apply() validates a whole datagram before mutation.
    """
    def __init__(self, session_id, source_cid, channel, start_khz, step_khz, count):
        if not isinstance(session_id, str) or not 1 <= len(session_id) <= 128:
            _fail('SCAN_WIRE_SESSION_ID')
        if not isinstance(source_cid, str) or not re.fullmatch('[0-9a-fA-F]{32}', source_cid):
            _fail('SCAN_WIRE_CID')
        _integer(channel, 0, 65535, 'SCAN_WIRE_CHANNEL')
        _integer(count, 1, MAX_POINTS, 'SCAN_WIRE_GRID')
        _integer(start_khz, 1, 10000000, 'SCAN_WIRE_GRID')
        _integer(step_khz, 1, 10000000, 'SCAN_WIRE_GRID')
        if start_khz+(count-1)*step_khz > 10000000:
            _fail('SCAN_WIRE_GRID')
        self._identity = (session_id, source_cid.lower(), channel)
        self._grid = (start_khz, step_khz, count)
        self._values = [None]*count
        self._received = 0

    session_id = property(lambda self: self._identity[0])
    source_cid = property(lambda self: self._identity[1])
    channel = property(lambda self: self._identity[2])
    start_khz = property(lambda self: self._grid[0])
    step_khz = property(lambda self: self._grid[1])
    count = property(lambda self: self._grid[2])

    def apply(self, datagram, *, session_id):
        if session_id != self.session_id:
            _fail('SCAN_WIRE_SESSION_MISMATCH')
        if not isinstance(datagram, WireDatagram):
            _fail('SCAN_WIRE_DATAGRAM_TYPE')
        pending = {}
        for record in datagram.dmp_records:
            # Only the observed absolute four-byte equal-size event array is a
            # scan candidate. Other DMP properties remain in the decoded record.
            if (record.vector != 4 or record.address_header != 0x22 or record.kind != 'array'
                    or record.address is None or not 0x10000000 <= record.address < 0x20000000):
                continue
            if record.cid != self.source_cid or record.channel != self.channel:
                _fail('SCAN_WIRE_SESSION_MISMATCH', record.pdu_offset)
            if (record.increment != 1 or record.element_size != 2
                    or type(record.count) is not int or not 1 <= record.count <= MAX_POINTS
                    or len(record.values) != record.count*2):
                _fail('SCAN_WIRE_UNSUPPORTED_SCAN_ARRAY', record.pdu_offset)
            start = record.address-SCAN_ADDRESS_BASE
            if start < 0 or record.count > self.count-start:
                _fail('SCAN_WIRE_GRID_RANGE', record.pdu_offset)
            for index, (level,) in enumerate(struct.iter_unpack('>h', record.values), start):
                # Same data-quality envelope as the offline WWB file reader.
                # The decoder still preserves the original bytes for inspection.
                if not -200 <= level <= 50:
                    _fail('SCAN_WIRE_LEVEL_OUT_OF_RANGE', record.pdu_offset)
                existing = pending.get(index, self._values[index])
                if existing is not None and existing != level:
                    _fail('SCAN_WIRE_POINT_CONFLICT', record.pdu_offset)
                pending[index] = level
        added = sum(self._values[index] is None for index in pending)
        for index, level in pending.items():
            self._values[index] = level
        self._received += added
        return added

    def snapshot(self):
        return {'schema': 'daty-shure-offline-scan-points-v1', 'session_id': self.session_id,
            'source_cid': self.source_cid, 'channel': self.channel,
            'start_khz': self.start_khz, 'step_khz': self.step_khz, 'count': self.count,
            'points': [[self.start_khz+i*self.step_khz, value] for i, value in enumerate(self._values)],
            'received_points': self._received, 'missing_points': self.count-self._received,
            'coverage_complete': self._received == self.count, 'device_scan_state': 'unknown'}
