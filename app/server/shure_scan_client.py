"""Owned ULXD scan session; sockets and lifecycle are isolated from SCP.

Private DMP properties below are restricted to the observed ULXD4 profile.
There is no SystemAPI dependency and no WWB identity, unlock or opaque writes.
Calling open() is read-only; start() is the only entry that requests a scan.
The public snapshot separates hardware terminal state from point completeness.
"""
import ipaddress
import re
import socket
import struct
import time
import uuid

from shure_scan_endpoint import parse_endpoint_candidate, ScanEndpointError
from shure_scan_sdt import SdtSession, SdtError, distance, pdu, decode
from shure_scan_wire import ScanPointAssembler, ScanWireError, WireDatagram
from shure_scan_session import (SessionKeyExchange, READ_PROPERTIES as SESSION_READ,
    WRITE_PROPERTIES as SESSION_WRITE, EXCHANGE_A, GENERATE_KEY,
    decode_public_value, VERIFIED_MODULUS)

STATUS = (0x02000931, 0x02000910, 0x02000920)
GRID_PROPERTIES = (0x02000900, 0x02000901, 0x02000902)
ARRAY = 0x1fffffff
SCAN_ID = 0x0200090f
CONFIG = {0x02000900: 4, 0x02000901: 4, 0x02000902: 4, 0x02000909: 1,
          0x02000903: 1, 0x0200090e: 1}
OBSERVED_GRID = (632125, 695875, 25)


class ScanClientError(ValueError):
    pass


def dmp(vector, address, value=b''):
    if vector == 2 and address in SESSION_WRITE:
        if address == EXCHANGE_A and not 1 < decode_public_value(value) < VERIFIED_MODULUS-1:
            raise ScanClientError('SCAN_SESSION_PUBLIC_VALUE_INVALID')
        if address == GENERATE_KEY and value != b'\1':
            raise ScanClientError('SCAN_WRITE_VALUE_NOT_ALLOWED')
    elif vector == 2:
        if address not in CONFIG or len(value) != CONFIG[address]:
            raise ScanClientError('SCAN_WRITE_NOT_ALLOWED')
        if address in (0x02000903, 0x0200090e) and value[0] > 15:
            raise ScanClientError('SCAN_WRITE_VALUE_NOT_ALLOWED')
        if address == 0x02000909 and value != b'\1':
            raise ScanClientError('SCAN_WRITE_VALUE_NOT_ALLOWED')
    elif vector not in (1, 7, 8) or (address not in (*STATUS, ARRAY)
            and not (vector == 1 and address in (*GRID_PROPERTIES, *SESSION_READ, SCAN_ID))):
        raise ScanClientError('SCAN_PROPERTY_NOT_ALLOWED')
    elif value:
        raise ScanClientError('SCAN_UNEXPECTED_PROPERTY_VALUE')
    return pdu(vector, b'\2', struct.pack('>I', address)+value)


def _address(value):
    result = ipaddress.IPv4Address(value)
    if result.is_multicast or result.is_unspecified or int(result) == 0xffffffff:
        raise ScanClientError('SCAN_INVALID_TARGET')
    return str(result)


def route_address(target, socket_factory=socket.socket):
    probe = socket_factory(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect((target, 8427))  # UDP connect selects a route, sends no data.
        return probe.getsockname()[0]
    finally:
        probe.close()


def discover_endpoint(target, local_address, *, timeout=12, socket_factory=socket.socket,
                      clock=time.monotonic):
    """Listen to actual Shure SLP announcements; never invent an SDT port/CID."""
    target, local_address = _address(target), _address(local_address)
    sock = socket_factory(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(('', 8427))
        membership = socket.inet_aton('239.255.254.253')+socket.inet_aton(local_address)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, membership)
        deadline = clock()+timeout
        while clock() < deadline:
            sock.settimeout(min(0.25, max(0.001, deadline-clock())))
            try:
                data, peer = sock.recvfrom(4097)
            except socket.timeout:
                continue
            if peer[0] != target:
                continue
            try:
                endpoint = parse_endpoint_candidate(data, packet_source=peer[0], target_ip=target)
            except ScanEndpointError:
                continue
            if endpoint is not None:
                return endpoint
        raise ScanClientError('SCAN_ENDPOINT_ANNOUNCEMENT_TIMEOUT')
    finally:
        sock.close()


class UlxdScanClient:
    """One fresh DATY transport generation and at most one scan attempt.

    A new client is required after a completed/cancelled/interrupted attempt.
    This deliberately prevents delayed previous-attempt data being relabelled.
    Poll is owned by one caller thread; cancellation should run on that thread.
    """
    def __init__(self, target_ip, *, local_address=None, endpoint=None,
                 socket_factory=socket.socket, clock=time.monotonic, range_evidence=None):
        self.target = _address(target_ip)
        self.local_address = local_address
        self.endpoint = endpoint
        self.socket_factory, self.clock = socket_factory, clock
        self.socket = self.session = None
        self.state, self.error = 'new', None
        self.attempt_id = uuid.uuid4().hex
        self.started_at = self.deadline = None
        self.start_confirmation_deadline = None
        self.properties = {}
        self.accepted = set()
        self.assembler = None
        self.progress = None
        self.max_progress = 0
        self.start_sent = self.cancel_sent = False
        self.device_started = self.device_ended = False
        self.subscribed = False
        self.bootstrap_read_sent = False
        self.terminal = []
        self.unknown_tail_count = 0
        self.barrier = None
        self.start_pending = False
        self.actual_grid = {}
        self.grid_read_errors = {}
        self.range_evidence = dict(range_evidence or {})
        self.negotiation = None
        self.scan_configured = False
        self.scan_id = None
        self.reservation_state = 'not_requested'
        self.reservation_barrier = self.reservation_deadline = None
        self.release_sent = False
        self.release_sequence = None
        self.cleanup_error = None
        self.array_unsubscribed = False
        self.last_sent_reliable = None

    def _profile_confirmed(self):
        evidence = self.range_evidence
        return (evidence.get('source') in ('user_confirmed_hardware_label', 'receiver_reported')
            and evidence.get('band') == 'L51' and evidence.get('model') == 'ULXD4'
            and evidence.get('receiver_ip') == self.target
            and bool(evidence.get('receiver_id'))
            and bool(re.fullmatch('[0-9a-fA-F]{12}', str(evidence.get('receiver_mac', '')).replace(':', '').replace('-', ''))))

    def _flush(self):
        if self.session is not None and self.socket is not None:
            for payload in self.session.drain():
                self.socket.sendto(payload, self.session.peer)
                for frame in decode(payload):
                    if frame.vector == 1 and frame.wrapper is not None:
                        sequence = frame.wrapper.reliable_sequence
                        if self.last_sent_reliable is None or distance(sequence, self.last_sent_reliable) > 0:
                            self.last_sent_reliable = sequence

    def _error(self, error):
        self.error = str(error)
        if self.state not in ('completed', 'cancelled'):
            self.state = 'interrupted' if self.start_sent else 'failed'

    def open(self, timeout=12):
        if self.state != 'new':
            raise ScanClientError('SCAN_CLIENT_ALREADY_OPENED')
        self.state = 'connecting'
        try:
            self.local_address = _address(self.local_address or route_address(self.target, self.socket_factory))
            if self.endpoint is None:
                self.endpoint = discover_endpoint(self.target, self.local_address,
                    timeout=timeout, socket_factory=self.socket_factory, clock=self.clock)
            if self.endpoint.ip != self.target:
                raise ScanClientError('SCAN_ENDPOINT_TARGET_MISMATCH')
            if self.endpoint.dmp_class_id.lower().replace('-', '') != '046ce22efd5a11e389af0015c5f3f612':
                raise ScanClientError('SCAN_DMP_CLASS_UNSUPPORTED')
            self.socket = self.socket_factory(socket.AF_INET, socket.SOCK_DGRAM)
            self.socket.bind((self.local_address, 0))
            self.session = SdtSession(self.endpoint, clock=self.clock)
            self.last_sent_reliable = self.session.reliable
            self.session.open()
            self._flush()
            deadline = self.clock()+timeout
            while self.clock() < deadline and self.state == 'connecting':
                self.poll(min(0.1, max(0.001, deadline-self.clock())))
            if self.state != 'ready':
                raise ScanClientError(self.error or 'SCAN_READINESS_TIMEOUT')
            return self.snapshot()
        except (OSError, ValueError) as error:
            self._error(error)
            self._release()
            raise

    def start(self, start_khz=632125, end_khz=695875, step_khz=25):
        if self.state != 'ready' or self.start_sent or self.assembler is not None:
            raise ScanClientError('SCAN_NOT_READY')
        if (start_khz, end_khz, step_khz) != OBSERVED_GRID:
            raise ScanClientError('SCAN_GRID_NOT_VALIDATED')
        if (tuple(self.actual_grid.get(address) for address in GRID_PROPERTIES) != OBSERVED_GRID
                and not self._profile_confirmed()):
            raise ScanClientError('SCAN_DEVICE_GRID_NOT_VERIFIED')
        if self.properties.get(STATUS[0]) != 0 or self.session.reorder:
            raise ScanClientError('SCAN_RECEIVER_BUSY_OR_GAP')
        self.assembler = ScanPointAssembler(self.attempt_id, self.endpoint.cid,
            self.session.remote_channel, start_khz, step_khz, (end_khz-start_khz)//step_khz+1)
        self.state = 'starting'
        self.started_at = self.clock()
        self.deadline = self.started_at+180
        self.negotiation = SessionKeyExchange(clock=self.clock)
        actions = self.negotiation.begin(self.session.remote_cursor)
        self.session.send(2, b''.join(dmp(action.vector, action.address, action.value) for action in actions))
        self._flush()
        return self.snapshot()

    def _configure_scan(self):
        if self.scan_id is None or self.release_sent:
            raise ScanClientError('SCAN_ID_NOT_RESERVED')
        start_khz, end_khz, step_khz = OBSERVED_GRID
        self.start_confirmation_deadline = self.clock()+10
        config = b''.join(dmp(2, address, struct.pack('>I', value)) for address, value
            in zip((0x02000900, 0x02000901, 0x02000902), (start_khz, end_khz, step_khz)))
        config += dmp(2, 0x02000909, b'\1')
        self.session.send(2, config)
        self.session.send(2, dmp(7, ARRAY))
        self.scan_configured = True

    def _reserve_scan_id(self):
        # This GET allocates a receiver resource. It belongs to the explicit
        # start intention, never open/readiness or an automatic retry.
        self.reservation_state = 'requesting'
        self.reservation_barrier = self.session.remote_cursor
        self.reservation_deadline = self.clock()+3
        self.session.send(2, dmp(1, SCAN_ID))

    def _release_scan_id(self):
        if self.scan_id is None or self.release_sent:
            return
        # Release only the resource acquired by this exact session. This is
        # also the observed cancellation command; it is not a global reset.
        self.release_sequence = self.session.send(2, dmp(2, 0x0200090e, bytes([self.scan_id])))
        self.release_sent = True  # request emitted; not a device completion ACK
        self.reservation_state = 'release_sent'

    def _release_acknowledged(self):
        return bool(self.release_sequence is not None and self.session is not None
            and self.session.last_ack is not None
            and distance(self.session.last_ack, self.release_sequence) >= 0)

    def _await_release_delivery(self):
        # This is transport delivery only, not a fabricated release/state
        # completion event. Standard reliable retransmission keeps its exact
        # sequence; no new application release or scan is issued here.
        deadline = self.clock()+3
        acknowledged_at = self.clock() if self._release_acknowledged() else None
        while self.clock() < deadline:
            self.socket.settimeout(min(.1, max(.001, deadline-self.clock())))
            try:
                data, peer = self.socket.recvfrom(65508)
            except socket.timeout:
                data = None
            if data is not None:
                for event in self.session.receive(data, peer):
                    for record in event.dmp_records:
                        if record.address == 0x0200090e and record.vector == 10:
                            self.cleanup_error = 'SCAN_RELEASE_REJECTED'
                            raise ScanClientError(self.cleanup_error)
            self.session.tick()
            self._flush()
            if self._release_acknowledged():
                if acknowledged_at is None:
                    acknowledged_at = self.clock()
                # Inspect the whole inbound batch and a short bounded response
                # window for an explicit SET_FAIL even when the ACK came first.
                if self.clock()-acknowledged_at >= .1:
                    return

    def _observe_scan_id(self, record, *, cleanup=False):
        if record.address != SCAN_ID:
            return False
        if self.reservation_state != 'requesting':
            return True
        if distance(record.reliable_sequence, self.reservation_barrier) <= 0:
            return True
        if record.vector == 9:
            self.reservation_state = 'failed'
            if not cleanup:
                raise ScanClientError('SCAN_PROPERTY_REJECTED_0200090f')
        elif record.vector == 3:
            if record.kind != 'single' or len(record.values) != 1 or record.values[0] > 15:
                self.reservation_state = 'failed'
                raise ScanClientError('SCAN_ID_INVALID')
            # Save a valid late reply for cleanup before checking the deadline.
            # It grants ownership even though it no longer permits starting.
            self.scan_id = record.values[0]
            self.reservation_state = 'reserved'
            if not cleanup and self.state == 'starting':
                if self.clock() >= self.reservation_deadline:
                    raise ScanClientError('SCAN_ID_TIMEOUT')
                if self.scan_id != 0:
                    raise ScanClientError('SCAN_ID_UNSUPPORTED')
        return True

    def _await_pending_reservation(self):
        # A cancelled, already-sent allocation can still return an owned id.
        # Await its bounded reply solely to release it, never to resume start.
        first = True
        while self.reservation_state == 'requesting' and (first or self.clock() < self.reservation_deadline):
            first = False
            self.socket.settimeout(min(.1, max(.001, self.reservation_deadline-self.clock())))
            try:
                data, peer = self.socket.recvfrom(65508)
            except socket.timeout:
                data = None
            if data is not None:
                for event in self.session.receive(data, peer):
                    for record in event.dmp_records:
                        self._observe_scan_id(record, cleanup=True)
            self.session.tick()
            self._flush()
        if self.reservation_state == 'requesting':
            self.cleanup_error = 'SCAN_RESERVATION_CLEANUP_UNCONFIRMED'

    def cancel(self):
        if self.cancel_sent or self.state in ('completed', 'cancelled', 'failed', 'interrupted', 'unknown', 'closed'):
            return self.snapshot()
        if self.state not in ('starting', 'scanning'):
            raise ScanClientError('SCAN_NOT_RUNNING')
        self.cancel_sent = True
        if not self.start_sent:
            self.state = 'cancelled'
            if self.negotiation is not None:
                self.negotiation.cancel()
            self._release_scan_id()
            if self.scan_id is None and self.reservation_state != 'requesting':
                self.reservation_state = 'cancelled'
            self._flush()
        else:
            self.state = 'cancelling'
            self._release_scan_id()
            self.deadline = self.clock()+8
            self._flush()
        return self.snapshot()

    def _records(self, event):
        # This observed scan profile uses reliable properties. Do not upgrade
        # unsequenced measurements into the ordered scan-result evidence.
        if any(wrapper.vector != 1 for wrapper in event.wrappers):
            if event.dmp_records:
                raise ScanClientError('SCAN_UNRELIABLE_DMP_UNSUPPORTED')
            return
        for record in event.dmp_records:
            if self.negotiation is not None and self.negotiation.observe(record):
                continue
            if self._observe_scan_id(record):
                continue
            if self.start_sent and self.barrier is not None and distance(record.reliable_sequence, self.barrier) <= 0:
                # Records already delivered before the outgoing start must not
                # acquire this attempt merely because the caller processes a
                # decoded batch after its transport cursor has advanced.
                continue
            if record.kind == 'single':
                address, value = record.address, record.values
                if record.vector == 9 and address in GRID_PROPERTIES:
                    self.grid_read_errors[address] = value.hex()
                    continue
                if record.vector in (9, 10, 13) and address in (*STATUS, ARRAY, *CONFIG):
                    if address == 0x0200090e and self.release_sent:
                        self.cleanup_error = 'SCAN_RELEASE_REJECTED'
                    raise ScanClientError('SCAN_PROPERTY_REJECTED_'+format(address, '08x'))
                if record.vector == 12 and address in (*STATUS, ARRAY):
                    self.accepted.add(address)
                if record.vector == 3 and address in GRID_PROPERTIES and len(value) == 4:
                    self.actual_grid[address] = int.from_bytes(value, 'big')
                if record.vector in (3, 4) and address in STATUS and len(value) == 1:
                    number = value[0]
                    if address == STATUS[1] and number > 100:
                        raise ScanClientError('SCAN_PROGRESS_INVALID')
                    if address != STATUS[1] and number not in (0, 1):
                        raise ScanClientError('SCAN_STATUS_INVALID')
                    self.properties[address] = number
                    if self.start_sent:
                        if address == STATUS[0] and number == 1:
                            self.device_started = True
                            if not self.cancel_sent:
                                self.state = 'scanning'
                        if address == STATUS[1] and self.device_started:
                            self.progress = number
                            self.max_progress = max(self.max_progress, number)
                        if self.device_started and (address, number) == (STATUS[0], 0):
                            self.terminal = [(address, number)]
                        elif self.terminal and (address, number) == (STATUS[1], 0):
                            self.terminal.append((address, number))
                        elif self.terminal and (address, number) == (STATUS[2], 1):
                            self.terminal.append((address, number))
                            if self.terminal[-3:] == [(STATUS[0], 0), (STATUS[1], 0), (STATUS[2], 1)]:
                                self.device_ended = True
            elif record.kind == 'unknown' and self.device_started:
                self.unknown_tail_count += 1
            elif self.assembler is not None and self.device_started and not self.device_ended:
                one = WireDatagram(event.wrappers, (record,), (), event.pdu_count, event.expanded_bytes)
                self.assembler.apply(one, session_id=self.attempt_id)
        if self.device_ended and self.state in ('starting', 'scanning', 'cancelling'):
            if self.cancel_sent:
                self.state = 'unknown' if self.max_progress == 100 else 'cancelled'
                if self.state == 'unknown':
                    self.error = 'SCAN_CANCEL_COMPLETION_RACE'
            elif self.max_progress == 100 and self.assembler.snapshot()['coverage_complete']:
                self.state = 'completed'
            else:
                self.state = 'unknown'
                self.error = 'SCAN_TERMINAL_WITH_MISSING_POINTS' if self.max_progress == 100 else 'SCAN_TERMINAL_WITHOUT_COMPLETION'
        if self.state == 'connecting' and self.session.state == 'ready':
            if (all(address in self.accepted and address in self.properties for address in STATUS)
                    and all(address in self.actual_grid or address in self.grid_read_errors for address in GRID_PROPERTIES)):
                if self.properties[STATUS[0]] != 0:
                    raise ScanClientError('SCAN_RECEIVER_BUSY')
                self.state = 'ready'
        if (self.state == 'starting' and self.scan_configured
                and ARRAY in self.accepted and not self.start_sent):
            self.start_pending = True

    def poll(self, timeout=0.1):
        if self.socket is None or self.session is None:
            return self.snapshot()
        try:
            self.socket.settimeout(max(0.001, min(timeout, 1)))
            try:
                data, peer = self.socket.recvfrom(65508)
            except socket.timeout:
                data = None
            if data is not None:
                for event in self.session.receive(data, peer):
                    self._records(event)
            if self.session.state == 'outbound_ready' and not self.bootstrap_read_sent:
                # The real ULXD opens the reverse DMP association on demand.
                # A known status subscription establishes that direction. The
                # complete subscriptions/GET follow after reverse CONNECT.
                self.bootstrap_read_sent = True
                self.session.send(2, dmp(7, STATUS[0]))
            if self.session.state == 'ready' and not self.subscribed:
                self.subscribed = True
                self.session.send(2, b''.join(dmp(7, address) for address in STATUS))
                self.session.send(2, b''.join(dmp(1, address) for address in STATUS))
                self.session.send(2, b''.join(dmp(1, address) for address in GRID_PROPERTIES))
            self.session.tick()
            if self.state == 'starting' and self.negotiation is not None and not self.scan_configured:
                if self.properties.get(STATUS[0]) != 0 or self.session.reorder or self.session.gap:
                    raise ScanClientError('SCAN_RECEIVER_BUSY_OR_GAP')
                actions = self.negotiation.advance(self.session.remote_cursor, self.session.last_ack)
                if actions:
                    reliable = self.session.send(2, b''.join(dmp(action.vector, action.address, action.value) for action in actions))
                    self.negotiation.sent(reliable, self.session.remote_cursor)
                if self.negotiation.verified:
                    if self.reservation_state == 'not_requested':
                        self._reserve_scan_id()
                    elif self.reservation_state == 'requesting' and self.clock() >= self.reservation_deadline:
                        raise ScanClientError('SCAN_ID_TIMEOUT')
                    elif self.reservation_state == 'reserved':
                        self._configure_scan()
            if (self.state == 'starting' and not self.device_started
                    and self.start_confirmation_deadline is not None
                    and self.clock() >= self.start_confirmation_deadline):
                raise ScanClientError('SCAN_START_NOT_CONFIRMED' if self.start_sent else 'SCAN_ARRAY_SUBSCRIBE_TIMEOUT')
            if self.deadline is not None and self.state in ('starting', 'scanning', 'cancelling') and self.clock() >= self.deadline:
                raise ScanClientError('SCAN_OUTCOME_TIMEOUT')
            if self.start_pending and self.state == 'starting' and not self.start_sent:
                # Finish the whole inbound datagram, including later wrappers
                # and a previously buffered ordered suffix, before starting.
                # A same-batch busy event / SET failure must prevent this SET.
                if self.properties.get(STATUS[0]) != 0 or self.session.reorder or self.session.gap:
                    raise ScanClientError('SCAN_RECEIVER_BUSY_OR_GAP')
                self.barrier = self.session.remote_cursor
                if self.scan_id is None or self.release_sent:
                    raise ScanClientError('SCAN_ID_NOT_RESERVED')
                self.session.send(2, dmp(2, 0x02000903, bytes([self.scan_id])))
                self.start_sent = True
                self.start_pending = False
                self.start_confirmation_deadline = self.clock()+10
            if self.device_ended and not self.array_unsubscribed:
                self._release_scan_id()
                self.session.send(2, dmp(8, ARRAY))
                self.array_unsubscribed = True
            if self.state == 'cancelled' and self.scan_id is not None:
                self._release_scan_id()
            self._flush()
        except (OSError, ValueError) as error:
            self._error(error)
            self._release()
        return self.snapshot()

    def snapshot(self):
        points = self.assembler.snapshot() if self.assembler is not None else {}
        session_states = {'new': 'not_started', 'parameters': 'reading_parameters',
            'write_pending': 'exchanging', 'status': 'confirming', 'read_pending': 'confirming',
            'verified': 'ready', 'failed': 'failed', 'cancelled': 'cancelled'}
        return dict(state=self.state, error=self.error, attempt_id=self.attempt_id,
            target_ip=self.target, transport_state=self.session.state if self.session else 'disconnected',
            local_cid=self.session.cid if self.session else None,
            local_port=self.socket.getsockname()[1] if self.socket else None,
            remote_port=self.endpoint.port if self.endpoint else None,
            progress=self.progress, max_progress=self.max_progress,
            points=points.get('points', []), received_points=points.get('received_points', 0),
            missing_points=points.get('missing_points', 0), coverage_complete=points.get('coverage_complete', False),
            device_started=self.device_started, device_ended=self.device_ended,
            start_sent=self.start_sent, cancel_sent=self.cancel_sent,
            session_state=session_states.get(self.negotiation.stage, 'failed') if self.negotiation else 'not_started',
            session_established=self.negotiation.verified if self.negotiation else False,
            scan_id=self.scan_id, reservation_state=self.reservation_state, release_sent=self.release_sent,
            release_acknowledged=self._release_acknowledged(), cleanup_error=self.cleanup_error,
            range_evidence=self.range_evidence, range_profile_confirmed=self._profile_confirmed(),
            actual_range=dict(start_khz=self.actual_grid.get(GRID_PROPERTIES[0]),
                end_khz=self.actual_grid.get(GRID_PROPERTIES[1]), step_khz=self.actual_grid.get(GRID_PROPERTIES[2]),
                verified=tuple(self.actual_grid.get(address) for address in GRID_PROPERTIES) == OBSERVED_GRID,
                read_errors={format(k, '08x'): v for k, v in self.grid_read_errors.items()},
                evidence='current_scan_configuration_not_hardware_band'),
            unknown_tail_count=self.unknown_tail_count, status_values={format(k, '08x'): v for k, v in self.properties.items()})

    def _release(self):
        if self.negotiation is not None:
            if self.error:
                self.negotiation.abort()
            else:
                self.negotiation.cancel()
        if self.session is not None:
            try:
                # Cleanup may follow a decode, property, or transport error.
                # Never flush a queued business action as part of cleanup.
                self.session.drain()
                # Queued reliable commands have not left this socket. Remove
                # their unsent tail so a cleanup NAK cannot replay a discarded
                # START, and the following owned release stays contiguous.
                if self.last_sent_reliable is not None:
                    for sequence in list(self.session.pending):
                        if distance(sequence, self.last_sent_reliable) > 0:
                            del self.session.pending[sequence]
                    self.session.reliable = self.last_sent_reliable
                # If a resource was acquired, release that owned identifier
                # before closing this session, even when no START was sent.
                # A dead transport cannot send; never reconnect/replay it.
                if self.session.state == 'ready':
                    self._await_pending_reservation()
                    self._release_scan_id()
                    self._flush()
                    if self.release_sent:
                        self._await_release_delivery()
            except (OSError, ValueError):
                pass
            try:
                self.session.close()
                self._flush()
            except (OSError, ValueError):
                pass
        if self.scan_id is not None and not self._release_acknowledged() and not self.cleanup_error:
            self.cleanup_error = 'SCAN_RELEASE_NOT_CONFIRMED'
        if self.socket is not None:
            self.socket.close()
            self.socket = None

    def close(self):
        # Release only this session's confirmed resource. Never reconnect,
        # repeat START, or guess an identifier during generic cleanup.
        if self.state in ('starting', 'scanning', 'cancelling'):
            self.state, self.error = 'interrupted', 'SCAN_CLIENT_CLOSED'
        self._release()
        if self.cleanup_error:
            raise ScanClientError(self.cleanup_error)
        if self.state in ('new', 'connecting', 'ready'):
            self.state = 'closed'
        return self.snapshot()
