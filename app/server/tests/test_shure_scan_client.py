"""Isolated UDP-peer tests. No LAN, receiver, SystemAPI, or business database."""
from pathlib import Path
import socket
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shure_scan_endpoint import EndpointCandidate
from shure_scan_sdt import SdtSession, SdtError, decode, pdu, root, wrapped
from shure_scan_client import (UlxdScanClient, ScanClientError, STATUS, ARRAY,
    GRID_PROPERTIES, OBSERVED_GRID, SCAN_ID, dmp)
from shure_scan_session import (BIT_SIZE, MODULUS, EXCHANGE_A, EXCHANGE_B,
    GENERATE_KEY, KEY_STATUS, VERIFIED_MODULUS, encode_public_value)

REMOTE = '7f56ac66bf7b4e188ee5b1c9c13d7eee'
LOCAL = 'bd4d0022d9a64f4491488a8e3a5b0777'
ENDPOINT = EndpointCandidate(REMOTE, '127.0.0.2', 43123,
    '046ce22efd5a11e389af0015c5f3f612', '127.0.0.2', 'ULXD: Rx')


class Clock:
    def __init__(self): self.value = 0.0
    def __call__(self): return self.value
    def advance(self, seconds): self.value += seconds


def prop(vector, address, value=b''):
    return pdu(vector, b'\2', struct.pack('>I', address)+value)


def array(index, values):
    body = struct.pack('>III', 0x10000005+index, 1, len(values))
    body += struct.pack('>'+str(len(values))+'h', *values)
    return pdu(4, b'\x22', body)


class Peer:
    """Independent peer wire fixtures, distinct channel/MIDs on both sides."""
    def __init__(self, clock):
        self.clock = clock
        self.out = []
        self.channel, self.member = 29871, 7
        self.total = self.reliable = 200
        self.local_cid = self.local_channel = self.local_initial = None
        self.sent = []
        self.values = dict(zip(GRID_PROPERTIES, OBSERVED_GRID))
        self.values.update({STATUS[0]: 0, STATUS[1]: 0, STATUS[2]: 1})
        self.auto_array_accept = True
        self.on_demand_connect = False
        self.reverse_connected = False
        self.reject_grid_get = False
        self.session_generated = False
        self.session_confirm = True
        self.values[SCAN_ID] = b'\0'
        self.values.update({BIT_SIZE: struct.pack('>I', 32),
            MODULUS: encode_public_value(VERIFIED_MODULUS),
            EXCHANGE_B: encode_public_value(0x962e1175), KEY_STATUS: b'\0'})

    def frame(self, items, protocol=2, reliable=True, *, sequence=None, oldest=None,
              member=None, association=0):
        self.total += 1
        if reliable:
            self.reliable = self.reliable+1 if sequence is None else sequence
        return wrapped(REMOTE, self.channel, self.total, self.reliable,
            self.reliable if oldest is None else oldest,
            self.member if member is None else member, association, protocol, items,
            is_reliable=reliable, request_ack=reliable)

    def feed(self, payload):
        self.sent.append(payload)
        for frame in decode(payload):
            if frame.vector == 4:
                self.local_cid = frame.cid
                local_member, self.local_channel, reciprocal, total, self.local_initial = struct.unpack_from('>HHHII', frame.data, 16)
                accept = bytes.fromhex(frame.cid)+struct.pack('>HHIH', self.local_channel, local_member, self.local_initial, self.channel)
                join = bytes.fromhex(frame.cid)+struct.pack('>HHHII', self.member, self.channel,
                    self.local_channel, self.total, self.reliable)+b'\0'+struct.pack('>BBHHHB', 5, 0, 2, 50, 20, 255)
                self.out.extend((root(REMOTE, 6, accept), root(REMOTE, 4, join)))
                self.out.append(self.frame(pdu(14, data=struct.pack('>I', self.local_initial)),
                    protocol=1, reliable=False, association=self.local_channel))
            if frame.wrapper is None:
                continue
            if frame.vector == 1:
                self.out.append(self.frame(pdu(14, data=struct.pack('>I', frame.wrapper.reliable_sequence)),
                    protocol=1, reliable=False, association=self.local_channel))
            for control in frame.controls:
                if control.vector == 9:
                    self.out.append(self.frame(pdu(10, data=struct.pack('>I', 2)), protocol=1, association=self.local_channel))
                    if not self.on_demand_connect:
                        self.reverse_connected = True
                        self.out.append(self.frame(pdu(9, data=struct.pack('>I', 2)), protocol=1))
            for record in frame.wire.dmp_records:
                if record.vector == 2 and record.address == GENERATE_KEY:
                    self.session_generated = True
                    if self.session_confirm: self.values[KEY_STATUS] = b'\1'
                if record.vector == 7 and (record.address != ARRAY or self.auto_array_accept):
                    if not self.reverse_connected:
                        self.reverse_connected = True
                        self.out.append(self.frame(pdu(9, data=struct.pack('>I', 2)), protocol=1))
                    self.out.append(self.frame(prop(12, record.address)))
                elif record.vector == 1:
                    if self.reject_grid_get and record.address in GRID_PROPERTIES:
                        self.out.append(self.frame(prop(9, record.address, b'\3')))
                        continue
                    value = self.values.get(record.address)
                    if value is not None:
                        width = 4 if record.address in GRID_PROPERTIES else 1
                        self.out.append(self.frame(prop(3, record.address,
                            value if isinstance(value, bytes) else value.to_bytes(width, 'big'))))


class FakeSocket:
    def __init__(self, peer): self.peer, self.closed, self.timeout = peer, False, .1
    def bind(self, address): self.address = (address[0], 51234)
    def settimeout(self, value): self.timeout = value
    def getsockname(self): return self.address
    def sendto(self, data, address):
        if self.closed: raise OSError('closed')
        assert address == (ENDPOINT.ip, ENDPOINT.port)
        self.peer.feed(data)
        return len(data)
    def recvfrom(self, size):
        if self.peer.out: return self.peer.out.pop(0), (ENDPOINT.ip, ENDPOINT.port)
        self.peer.clock.advance(self.timeout)
        raise socket.timeout()
    def close(self): self.closed = True


def ready_session():
    clock = Clock()
    peer = Peer(clock)
    session = SdtSession(ENDPOINT, clock=clock, cid=LOCAL, channel=12523, sequence=900)
    session.open()
    for _ in range(40):
        for payload in session.drain(): peer.feed(payload)
        if not peer.out: break
        session.receive(peer.out.pop(0), session.peer)
    assert session.state == 'ready', session.state
    session.drain()
    peer.out.clear()
    return clock, peer, session


class SdtTests(unittest.TestCase):
    def test_own_identity_dynamic_ports_and_distinct_members(self):
        clock, peer, session = ready_session()
        self.assertEqual(session.remote_member, 7)
        self.assertEqual(session.member, 1)
        self.assertEqual(session.channel, 12523)
        self.assertEqual(session.remote_channel, 29871)
        self.assertEqual(session.peer, ('127.0.0.2', 43123))
        self.assertTrue(session.membership_acked and session.peer_connected and session.connect_accepted)

    def test_join_accept_does_not_finish_without_reciprocal_join_and_first_ack(self):
        clock, peer = Clock(), Peer(Clock())
        session = SdtSession(ENDPOINT, clock=clock, cid=LOCAL, channel=12523, sequence=900)
        session.open()
        peer.feed(session.drain()[0])
        session.receive(peer.out.pop(0), session.peer)
        self.assertFalse(session.connect_sent)
        session.receive(peer.out.pop(0), session.peer)
        self.assertFalse(session.connect_sent)
        session.receive(peer.out.pop(0), session.peer)
        self.assertTrue(session.connect_sent)

    def test_reverse_join_before_accept_is_supported(self):
        clock, peer = Clock(), Peer(Clock())
        session = SdtSession(ENDPOINT, clock=clock, cid=LOCAL, channel=12523, sequence=900)
        session.open(); peer.feed(session.drain()[0])
        accept, join, ack = peer.out
        session.receive(join, session.peer)
        session.receive(ack, session.peer)
        self.assertFalse(session.connect_sent)
        session.receive(accept, session.peer)
        self.assertTrue(session.connect_sent)

    def test_wrong_cid_peer_and_member_do_not_deliver_data(self):
        _, peer, session = ready_session()
        payload = peer.frame(prop(4, STATUS[0], b'\1'))
        self.assertEqual(session.receive(payload, ('127.0.0.3', 43123)), [])
        badcid = payload[:22]+bytes.fromhex(LOCAL)+payload[38:]
        self.assertEqual(session.receive(badcid, session.peer), [])
        badmember = peer.frame(prop(4, STATUS[0], b'\1'), sequence=session.remote_cursor+1, member=19)
        self.assertEqual(session.receive(badmember, session.peer), [])

    def test_duplicate_and_out_of_order_are_delivered_once_in_order(self):
        clock, peer, session = ready_session()
        cursor = session.remote_cursor
        second = peer.frame(prop(4, STATUS[1], b'\2'), sequence=cursor+2, oldest=cursor+1)
        first = peer.frame(prop(4, STATUS[1], b'\1'), sequence=cursor+1, oldest=cursor+1)
        self.assertEqual(session.receive(second, session.peer), [])
        clock.advance(.03); session.tick()
        nak = [f for raw in session.drain() for f in decode(raw) if f.vector == 15]
        self.assertEqual(len(nak), 1)
        self.assertEqual(struct.unpack_from('>III', nak[0].data, 20), (cursor, cursor+1, cursor+1))
        events = session.receive(first, session.peer)
        self.assertEqual([e.dmp_records[0].values for e in events], [b'\1', b'\2'])
        self.assertEqual(session.receive(first, session.peer), [])
        self.assertIsNone(session.gap)

    def test_unreliable_in_sequence_payload_is_delivered_once(self):
        _, peer, session = ready_session()
        payload = peer.frame(prop(4, STATUS[1], b'\1'), reliable=False)
        self.assertEqual(len(session.receive(payload, session.peer)), 1)
        self.assertEqual(session.receive(payload, session.peer), [])

    def test_partial_gap_recovery_advances_nak_first(self):
        clock, peer, session = ready_session()
        cursor = session.remote_cursor
        third = peer.frame(prop(4, STATUS[1], b'\3'), sequence=cursor+3, oldest=cursor+1)
        first = peer.frame(prop(4, STATUS[1], b'\1'), sequence=cursor+1, oldest=cursor+1)
        session.receive(third, session.peer)
        session.receive(first, session.peer)
        self.assertEqual(session.gap[:2], [cursor+2, cursor+2])
        clock.advance(.03); session.tick()
        nak = [f for raw in session.drain() for f in decode(raw) if f.vector == 15][-1]
        self.assertEqual(struct.unpack_from('>III', nak.data, 20), (cursor+1, cursor+2, cursor+2))

    def test_expired_reliable_gap_fails_instead_of_skipping(self):
        _, peer, session = ready_session()
        cursor = session.remote_cursor
        payload = peer.frame(prop(4, STATUS[1], b'\2'), sequence=cursor+2, oldest=cursor+2)
        with self.assertRaisesRegex(SdtError, 'SDT_RELIABLE_GAP_EXPIRED'):
            session.receive(payload, session.peer)

    def test_future_ack_rejected(self):
        _, peer, session = ready_session()
        payload = peer.frame(pdu(14, data=struct.pack('>I', session.reliable+1)), protocol=1,
            reliable=False, association=session.channel)
        with self.assertRaisesRegex(SdtError, 'SDT_ACK_FUTURE'):
            session.receive(payload, session.peer)

    def test_nak_retransmits_same_business_reliable_sequence(self):
        _, peer, session = ready_session()
        sequence = session.send(2, dmp(2, 0x02000903, b'\0'))
        original = session.drain()[0]
        body = bytes.fromhex(session.cid)+struct.pack('>HHIII', session.channel, session.member,
            (sequence-1) & 0xffffffff, sequence, sequence)
        session.receive(root(REMOTE, 15, body), session.peer)
        resent = session.drain()[0]
        self.assertEqual(resent, original)
        self.assertEqual(session.reliable, sequence)

    def test_receive_sequence_rollover(self):
        _, peer, session = ready_session()
        session.remote_cursor = 0xffffffff
        payload = peer.frame(prop(4, STATUS[1], b'\2'), sequence=0, oldest=0)
        self.assertEqual(len(session.receive(payload, session.peer)), 1)
        self.assertEqual(session.remote_cursor, 0)

    def test_session_expiry_is_explicit(self):
        clock, _, session = ready_session()
        clock.advance(5)
        with self.assertRaisesRegex(SdtError, 'SDT_SESSION_EXPIRED'): session.tick()

    def test_peer_disconnect_and_leave_use_outbound_association(self):
        for vector, data in ((7, b''), (12, struct.pack('>I', 2))):
            with self.subTest(vector=vector):
                _, peer, session = ready_session()
                payload = peer.frame(pdu(vector, data=data), protocol=1, association=0)
                with self.assertRaises(SdtError): session.receive(payload, session.peer)

    def test_nak_retry_is_bounded(self):
        clock, peer, session = ready_session()
        cursor = session.remote_cursor
        session.receive(peer.frame(prop(4, STATUS[1], b'\3'), sequence=cursor+3, oldest=cursor+1), session.peer)
        for _ in range(3):
            clock.advance(.6); session.tick()
        clock.advance(.6)
        with self.assertRaisesRegex(SdtError, 'SDT_NAK_TIMEOUT'): session.tick()

    def test_reply_acks_do_not_starve_outgoing_mak_heartbeat(self):
        clock, peer, session = ready_session()
        for _ in range(4):
            clock.advance(.5)
            session.receive(peer.frame(b'', protocol=1, reliable=False), session.peer)
            session.tick()
        frames = [f for raw in session.drain() for f in decode(raw) if f.wrapper]
        self.assertTrue(any(f.wrapper.first_member == session.member for f in frames))


class ClientTests(unittest.TestCase):
    def create(self):
        clock = Clock(); peer = Peer(clock); sock = FakeSocket(peer)
        client = UlxdScanClient(ENDPOINT.ip, endpoint=ENDPOINT, local_address='127.0.0.1',
            socket_factory=lambda *args: sock, clock=clock)
        client.open()
        for _ in range(20):
            if not peer.out: break
            client.poll()
        return clock, peer, client

    def pump(self, peer, client):
        for _ in range(500):
            if not peer.out:
                if client.state == 'starting' and client.negotiation is not None and not client.scan_configured:
                    client.poll(.1)
                    continue
                break
            client.poll()

    def begin(self):
        clock, peer, client = self.create()
        client.start(); self.pump(peer, client)
        peer.out.append(peer.frame(prop(4, STATUS[1], b'\0')))
        peer.out.append(peer.frame(prop(4, STATUS[2], b'\0')))
        peer.out.append(peer.frame(prop(4, STATUS[0], b'\1')))
        self.pump(peer, client)
        self.assertEqual(client.state, 'scanning')
        return clock, peer, client

    def end(self, peer, client, progress):
        if progress is not None: peer.out.append(peer.frame(prop(4, STATUS[1], bytes([progress]))))
        for address, value in ((STATUS[0], 0), (STATUS[1], 0), (STATUS[2], 1)):
            peer.out.append(peer.frame(prop(4, address, bytes([value]))))
        self.pump(peer, client)

    def test_open_only_sends_read_and_subscribe(self):
        _, peer, client = self.create()
        records = [r for raw in peer.sent for f in decode(raw) if f.wire for r in f.wire.dmp_records]
        self.assertTrue(records)
        self.assertTrue(all(r.vector in (1, 7) for r in records))
        self.assertFalse(any(r.address == SCAN_ID for r in records))
        self.assertEqual(client.snapshot()['state'], 'ready')
        self.assertTrue(client.snapshot()['actual_range']['verified'])
        self.assertNotEqual(client.session.cid, REMOTE)

    def test_real_observed_on_demand_reverse_connect_and_unreadable_grid(self):
        clock = Clock(); peer = Peer(clock); sock = FakeSocket(peer)
        peer.on_demand_connect = peer.reject_grid_get = True
        client = UlxdScanClient(ENDPOINT.ip, endpoint=ENDPOINT, local_address='127.0.0.1',
            socket_factory=lambda *args: sock, clock=clock)
        result = client.open()
        self.assertEqual(result['state'], 'ready')
        self.assertEqual(result['actual_range']['read_errors'], {'02000900': '03', '02000901': '03', '02000902': '03'})
        self.assertFalse(result['actual_range']['verified'])
        with self.assertRaisesRegex(ScanClientError, 'SCAN_DEVICE_GRID_NOT_VERIFIED'): client.start()

    def test_confirmed_hardware_profile_does_not_forge_get_readback(self):
        _, peer, client = self.create()
        client.actual_grid.clear()
        client.range_evidence = dict(source='user_confirmed_hardware_label', band='L51',
            model='ULXD4', receiver_ip=ENDPOINT.ip, receiver_id='shure:fixture', receiver_mac='00:11:22:33:44:55')
        client.start()
        self.assertEqual(client.state, 'starting')
        self.assertTrue(client.snapshot()['range_profile_confirmed'])
        self.assertFalse(client.snapshot()['actual_range']['verified'])

    def test_wrong_identity_profile_cannot_enable_scan(self):
        _, _, client = self.create()
        client.actual_grid.clear()
        client.range_evidence = dict(source='user_confirmed_hardware_label', band='L51',
            model='ULXD4', receiver_ip='127.0.0.3', receiver_id='shure:fixture', receiver_mac='00:11:22:33:44:55')
        with self.assertRaisesRegex(ScanClientError, 'SCAN_DEVICE_GRID_NOT_VERIFIED'): client.start()

    def test_start_once_waits_array_subscription_and_does_not_count_ack_as_started(self):
        _, peer, client = self.create()
        peer.auto_array_accept = False
        client.start(); self.pump(peer, client)
        self.assertFalse(client.start_sent)
        peer.out.append(peer.frame(prop(12, ARRAY))); self.pump(peer, client)
        self.assertTrue(client.start_sent)
        self.assertFalse(client.device_started)
        self.assertEqual(client.state, 'starting')
        with self.assertRaisesRegex(ScanClientError, 'SCAN_NOT_READY'): client.start()

    def test_missing_start_event_times_out_without_resending_and_releases_owned_id(self):
        clock, peer, client = self.create()
        client.start(); self.pump(peer, client)
        for _ in range(11):
            if client.state != 'starting': break
            clock.advance(1)
            peer.out.append(peer.frame(b'', protocol=1, reliable=False))
            self.pump(peer, client)
        self.assertEqual(client.error, 'SCAN_START_NOT_CONFIRMED')
        self.assertEqual(client.state, 'interrupted')
        records = [r for raw in peer.sent for f in decode(raw) if f.wire for r in f.wire.dmp_records]
        self.assertEqual(sum(r.vector == 2 and r.address == 0x02000903 for r in records), 1)
        self.assertEqual(sum(r.vector == 2 and r.address == 0x0200090e for r in records), 1)
        self.assertTrue(client.snapshot()['release_acknowledged'])

    def test_busy_event_in_same_datagram_as_array_accept_prevents_start(self):
        _, peer, client = self.create()
        peer.auto_array_accept = False
        client.start(); self.pump(peer, client)
        accepted = peer.frame(prop(12, ARRAY))
        busy = peer.frame(prop(4, STATUS[0], b'\1'))
        peer.out.append(accepted+busy[16:]); client.poll()
        self.assertEqual(client.state, 'failed')
        self.assertEqual(client.error, 'SCAN_RECEIVER_BUSY_OR_GAP')
        self.assertFalse(client.start_sent)
        self.assertFalse(client.device_started)
        starts = [r for raw in peer.sent for f in decode(raw) if f.wire for r in f.wire.dmp_records
            if r.vector == 2 and r.address == 0x02000903]
        self.assertEqual(starts, [])

    def test_set_failure_after_array_accept_never_flushes_start_on_cleanup(self):
        _, peer, client = self.create()
        peer.auto_array_accept = False
        client.start(); self.pump(peer, client)
        accepted = peer.frame(prop(12, ARRAY))
        failed = peer.frame(prop(10, GRID_PROPERTIES[0], b'\3'))
        peer.out.append(accepted+failed[16:]); client.poll()
        self.assertEqual(client.state, 'failed')
        self.assertIn('SCAN_PROPERTY_REJECTED', client.error)
        starts = [r for raw in peer.sent for f in decode(raw) if f.wire for r in f.wire.dmp_records
            if r.vector == 2 and r.address == 0x02000903]
        self.assertEqual(starts, [])

    def test_prestart_sequence_cannot_mark_started_or_add_points(self):
        _, peer, client = self.create()
        client.start(); self.pump(peer, client)
        self.assertTrue(client.start_sent)
        stale = peer.frame(prop(4, STATUS[0], b'\1')+array(0, [-70]*17), sequence=client.barrier)
        client._records(decode(stale)[0].wire)
        self.assertFalse(client.device_started)
        self.assertEqual(client.snapshot()['received_points'], 0)

    def test_cleanup_discards_queued_business_actions(self):
        _, peer, client = self.create()
        client.session.send(2, dmp(2, 0x02000903, b'\0'))
        client.close()
        starts = [r for raw in peer.sent for f in decode(raw) if f.wire for r in f.wire.dmp_records
            if r.vector == 2 and r.address == 0x02000903]
        self.assertEqual(starts, [])

    def test_full_observed_points_keep_unknown_tail_and_do_not_claim_complete(self):
        _, peer, client = self.begin()
        for index in range(0, 2550, 17):
            peer.out.append(peer.frame(array(index, [-100]*17)))
        peer.out.append(peer.frame(bytes.fromhex('700a0422100009fbff99')))
        self.pump(peer, client); self.end(peer, client, 100)
        result = client.snapshot()
        self.assertEqual(result['state'], 'unknown')
        self.assertTrue(result['device_ended'])
        self.assertEqual(result['received_points'], 2550)
        self.assertEqual(result['points'][-1], [695875, None])
        self.assertFalse(result['coverage_complete'])

    def test_cancel_preserves_partial_points_and_stop_is_single_business_write(self):
        _, peer, client = self.begin()
        for index in range(0, 323, 17): peer.out.append(peer.frame(array(index, [-90]*17)))
        self.pump(peer, client)
        client.cancel(); client.cancel(); self.pump(peer, client)
        self.assertEqual(client.state, 'cancelling')
        self.end(peer, client, None)
        result = client.snapshot()
        self.assertEqual(result['state'], 'cancelled')
        self.assertEqual(result['received_points'], 323)
        stops = [r for raw in peer.sent for f in decode(raw) if f.wire for r in f.wire.dmp_records
            if r.vector == 2 and r.address == 0x0200090e]
        self.assertEqual(len(stops), 1)
        with self.assertRaisesRegex(ScanClientError, 'SCAN_NOT_READY'): client.start()

    def test_cancel_at_progress100_is_explicitly_unknown(self):
        _, peer, client = self.begin()
        client.cancel(); self.pump(peer, client)
        self.end(peer, client, 100)
        self.assertEqual(client.state, 'unknown')
        self.assertEqual(client.error, 'SCAN_CANCEL_COMPLETION_RACE')

    def test_last_points_before_terminal_in_same_wrapper_are_preserved(self):
        _, peer, client = self.begin()
        data = array(0, [-90]*17)+prop(4, STATUS[1], b'\x64')
        data += prop(4, STATUS[0], b'\0')+prop(4, STATUS[1], b'\0')+prop(4, STATUS[2], b'\1')
        peer.out.append(peer.frame(data)); self.pump(peer, client)
        self.assertEqual(client.snapshot()['received_points'], 17)
        self.assertTrue(client.snapshot()['device_ended'])

    def test_grid_and_write_whitelist_reject_unknown_values(self):
        _, _, client = self.create()
        with self.assertRaisesRegex(ScanClientError, 'SCAN_GRID_NOT_VALIDATED'): client.start(600000, 700000, 25)
        with self.assertRaisesRegex(ValueError, 'SCAN_SESSION_PARAMETER_ENCODING'): dmp(2, EXCHANGE_A, b'\0'*6)
        with self.assertRaisesRegex(ScanClientError, 'SCAN_WRITE_VALUE_NOT_ALLOWED'): dmp(2, GENERATE_KEY, b'\0')
        with self.assertRaisesRegex(ScanClientError, 'SCAN_WRITE_NOT_ALLOWED'): dmp(2, 0x01200026, b'\1')
        client.actual_grid.clear()
        with self.assertRaisesRegex(ScanClientError, 'SCAN_DEVICE_GRID_NOT_VERIFIED'): client.start()

    def test_disconnect_does_not_reissue_scan_start(self):
        clock, peer, client = self.begin()
        before = len(peer.sent)
        clock.advance(5); client.poll()
        self.assertEqual(client.state, 'interrupted')
        self.assertFalse(any(r.vector == 2 for raw in peer.sent[before:]
            for f in decode(raw) if f.wire for r in f.wire.dmp_records))

    def test_new_client_has_distinct_cid_and_old_session_data_is_rejected(self):
        _, oldpeer, oldclient = self.begin()
        stale = oldpeer.frame(array(0, [-80]*17))
        _, peer, client = self.create()
        self.assertNotEqual(oldclient.session.cid, client.session.cid)
        # Receiver's old channel/association cannot be relabelled as the new scan.
        peer.out.append(stale)
        client.poll()
        self.assertEqual(client.snapshot()['received_points'], 0)

    def test_session_negotiation_is_after_intent_and_before_scan_configuration(self):
        _, peer, client = self.create()
        before = len(peer.sent)
        client.start(); self.pump(peer, client)
        records = [r for raw in peer.sent[before:] for f in decode(raw) if f.wire for r in f.wire.dmp_records]
        self.assertEqual([r.address for r in records if r.vector == 2][:2], [EXCHANGE_A, GENERATE_KEY])
        self.assertEqual(sum(r.vector == 2 and r.address == EXCHANGE_A for r in records), 1)
        self.assertTrue(client.snapshot()['session_established'])
        self.assertEqual(client.snapshot()['session_state'], 'ready')
        self.assertFalse(any('private' in key or 'public' in key for key in client.snapshot()))
        allocation = next(i for i, r in enumerate(records) if r.vector == 1 and r.address == SCAN_ID)
        configuration = next(i for i, r in enumerate(records) if r.vector == 2 and r.address in GRID_PROPERTIES)
        self.assertLess(allocation, configuration)

    def test_session_status_zero_times_out_without_config_or_start(self):
        _, peer, client = self.create()
        peer.session_confirm = False
        client.start(); self.pump(peer, client)
        self.assertEqual(client.error, 'SCAN_SESSION_KEY_STATUS_TIMEOUT')
        self.assertFalse(client.start_sent)
        records = [r for raw in peer.sent for f in decode(raw) if f.wire for r in f.wire.dmp_records]
        self.assertFalse(any(r.vector == 2 and r.address in (*GRID_PROPERTIES, 0x02000903) for r in records))
        self.assertEqual(sum(r.vector == 2 and r.address == EXCHANGE_A for r in records), 1)

    def test_cancel_during_parameter_read_never_writes_session_or_scan(self):
        _, peer, client = self.create()
        before = len(peer.sent)
        client.start(); client.cancel(); self.pump(peer, client); client.close()
        self.assertEqual(client.state, 'cancelled')
        self.assertEqual(client.snapshot()['session_state'], 'cancelled')
        records = [r for raw in peer.sent[before:] for f in decode(raw) if f.wire for r in f.wire.dmp_records]
        self.assertFalse(any(r.vector == 2 for r in records))

    def request_without_id(self):
        clock, peer, client = self.create()
        peer.values.pop(SCAN_ID)
        client.start()
        for _ in range(100):
            client.poll(.01)
            if client.reservation_state == 'requesting':
                break
        self.assertEqual(client.reservation_state, 'requesting')
        self.assertFalse(client.scan_configured)
        return clock, peer, client

    def sent_properties(self, peer):
        return [r for raw in peer.sent for f in decode(raw) if f.wire for r in f.wire.dmp_records]

    def test_id_request_is_once_and_missing_response_prevents_config(self):
        _, peer, client = self.request_without_id()
        self.pump(peer, client)
        self.assertEqual(client.error, 'SCAN_ID_TIMEOUT')
        records = self.sent_properties(peer)
        self.assertEqual(sum(r.vector == 1 and r.address == SCAN_ID for r in records), 1)
        self.assertFalse(any(r.vector == 2 and r.address in (*GRID_PROPERTIES, 0x02000903, 0x0200090e) for r in records))
        with self.assertRaisesRegex(ScanClientError, 'SCAN_RESERVATION_CLEANUP_UNCONFIRMED'):
            client.close()

    def test_nonzero_id_is_returned_without_guessing_array_profile(self):
        _, peer, client = self.create()
        peer.values[SCAN_ID] = b'\x03'
        client.start(); self.pump(peer, client)
        self.assertEqual(client.error, 'SCAN_ID_UNSUPPORTED')
        self.assertEqual(client.scan_id, 3)
        records = self.sent_properties(peer)
        self.assertFalse(any(r.vector == 2 and r.address in (*GRID_PROPERTIES, 0x02000903) for r in records))
        self.assertEqual([r.values for r in records if r.vector == 2 and r.address == 0x0200090e], [b'\x03'])
        self.assertTrue(client.snapshot()['release_acknowledged'])

    def test_invalid_id_never_becomes_an_owned_release_target(self):
        for value in (b'', b'\x10', b'\xff', b'\0\0'):
            with self.subTest(value=value):
                _, peer, client = self.create()
                peer.values[SCAN_ID] = value
                client.start(); self.pump(peer, client)
                self.assertEqual(client.error, 'SCAN_ID_INVALID')
                self.assertIsNone(client.scan_id)
                self.assertFalse(any(r.vector == 2 and r.address in (*GRID_PROPERTIES, 0x02000903, 0x0200090e)
                    for r in self.sent_properties(peer)))

    def test_late_valid_id_is_released_but_cannot_start(self):
        clock, peer, client = self.request_without_id()
        peer.out.clear(); clock.advance(3.1)
        peer.out.append(peer.frame(prop(3, SCAN_ID, b'\0')))
        client.poll()
        self.assertEqual(client.error, 'SCAN_ID_TIMEOUT')
        self.assertEqual(client.scan_id, 0)
        self.assertTrue(client.release_sent)
        self.assertFalse(client.start_sent or client.scan_configured)

    def test_stale_reply_or_event_cannot_grant_scan_id(self):
        _, peer, client = self.request_without_id()
        stale = peer.frame(prop(3, SCAN_ID, b'\0'), sequence=client.reservation_barrier)
        client._records(decode(stale)[0].wire)
        event = peer.frame(prop(4, SCAN_ID, b'\0'))
        client._records(decode(event)[0].wire)
        self.assertEqual(client.reservation_state, 'requesting')
        self.assertIsNone(client.scan_id)
        self.assertFalse(client.scan_configured)

    def test_cancel_while_allocating_awaits_owned_id_only_to_release(self):
        _, peer, client = self.request_without_id()
        client.cancel()
        peer.out.append(peer.frame(prop(3, SCAN_ID, b'\0')))
        result = client.close()
        self.assertEqual(result['state'], 'cancelled')
        self.assertTrue(result['release_acknowledged'])
        self.assertFalse(result['start_sent'])
        self.assertFalse(any(r.vector == 2 and r.address in (*GRID_PROPERTIES, 0x02000903)
            for r in self.sent_properties(peer)))

    def test_terminal_releases_once_and_close_waits_delivery(self):
        _, peer, client = self.begin()
        peer.out.append(peer.frame(array(0, [-91]*17)))
        self.pump(peer, client); self.end(peer, client, 100)
        result = client.close(); client.close()
        self.assertEqual(result['received_points'], 17)
        self.assertTrue(result['device_ended'])
        self.assertTrue(result['release_acknowledged'])
        self.assertEqual([r.values for r in self.sent_properties(peer)
            if r.vector == 2 and r.address == 0x0200090e], [b'\0'])

    def test_owned_cleanup_discards_unsent_start_without_reliable_gap(self):
        _, peer, client = self.create()
        peer.auto_array_accept = False
        client.start(); self.pump(peer, client)
        unsent_sequence = client.session.send(2, dmp(2, 0x02000903, b'\0'))
        client.close()
        records = self.sent_properties(peer)
        self.assertFalse(any(r.vector == 2 and r.address == 0x02000903 for r in records))
        release = next(r for r in records if r.vector == 2 and r.address == 0x0200090e)
        self.assertEqual(release.reliable_sequence, unsent_sequence)

    def test_release_set_failure_is_not_hidden_by_ack(self):
        _, peer, client = self.begin()
        original = peer.feed
        def reject_release(payload):
            original(payload)
            if any(r.vector == 2 and r.address == 0x0200090e
                   for f in decode(payload) if f.wire for r in f.wire.dmp_records):
                peer.out.append(peer.frame(prop(10, 0x0200090e, b'\3')))
        peer.feed = reject_release
        with self.assertRaisesRegex(ScanClientError, 'SCAN_RELEASE_REJECTED'):
            client.close()
        self.assertEqual(client.cleanup_error, 'SCAN_RELEASE_REJECTED')
        self.assertTrue(client.snapshot()['release_acknowledged'])

    def test_missing_release_ack_is_bounded_and_preserves_points(self):
        clock, peer, client = self.begin()
        peer.out.append(peer.frame(array(0, [-92]*17))); self.pump(peer, client)
        original = peer.feed
        def drop_replies(payload):
            original(payload)
            peer.out.clear()
        peer.feed = drop_replies
        before = clock()
        with self.assertRaisesRegex(ScanClientError, 'SCAN_RELEASE_NOT_CONFIRMED'):
            client.close()
        self.assertLessEqual(clock()-before, 3.01)
        self.assertEqual(client.snapshot()['received_points'], 17)
        self.assertFalse(client.snapshot()['release_acknowledged'])


if __name__ == '__main__': unittest.main()
