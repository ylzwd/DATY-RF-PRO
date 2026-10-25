"""Offline synthetic protocol boundaries and a small anonymized observed PDU."""
from pathlib import Path
import struct
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT/'app/server'))
from shure_scan_wire import (ACN_IDENTIFIER, SCAN_ADDRESS_BASE, DecodeLimits,
    ScanPointAssembler, ScanWireError, decode_datagram)

CID = '00112233445566778899aabbccddeeff'


def pdu(vector=None, header=None, data=None, *, flags=0x70, extended=False):
    body = ((vector or b'') if flags & 0x40 else b'')
    body += ((header or b'') if flags & 0x20 else b'')
    body += ((data or b'') if flags & 0x10 else b'')
    width = 3 if extended else 2
    length = len(body)+width
    return (((flags | (0x80 if extended else 0)) << ((width-1)*8)) | length).to_bytes(width, 'big')+body


def array(index, values, *, count=None, increment=1, address=None, flags=0x70, vector=4):
    body = struct.pack('>III', SCAN_ADDRESS_BASE+index if address is None else address,
                       increment, len(values) if count is None else count)
    body += struct.pack('>'+str(len(values))+'h', *values)
    return pdu(bytes([vector]), b'\x22', body, flags=flags)


def datagram(items, *, cid=CID, channel=17, sequence=1, client_protocol=2, extra_client=b''):
    client = pdu(struct.pack('>H', 65535), struct.pack('>IH', client_protocol, 0), items)
    wrapper = struct.pack('>HIIIHHH', channel, sequence, sequence, sequence, 1, 1, 0)
    sdt = pdu(b'\x01', b'', wrapper+client+extra_client)
    return ACN_IDENTIFIER+pdu(struct.pack('>I', 1), bytes.fromhex(cid), sdt)


def assembler(count=4, **changes):
    args = dict(session_id='scan-1', source_cid=CID, channel=17,
                start_khz=632125, step_khz=25, count=count)
    args.update(changes)
    return ScanPointAssembler(**args)


class DecodeTests(unittest.TestCase):
    def assert_code(self, code, callable_, *args, **kwargs):
        with self.assertRaises(ScanWireError) as caught:
            callable_(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)

    def test_observed_array_integer_dbm_and_transport_metadata(self):
        # One actual 17-value DMP body, with a wholly synthetic outer transport/CID.
        observed = bytes.fromhex('70320422100000050000000100000011'
            'ff9effa0ffa0ffa3ffa4ffa3ffabffbeffd9ffbdffd8ffd8ffd8ffdaffdbffd3ffdb')
        decoded = decode_datagram(datagram(observed, sequence=123))
        self.assertEqual(len(decoded.dmp_records), 1)
        record = decoded.dmp_records[0]
        self.assertEqual((record.cid, record.channel, record.reliable_sequence), (CID, 17, 123))
        self.assertEqual((record.kind, record.address, record.increment, record.count, record.element_size),
                         ('array', SCAN_ADDRESS_BASE, 1, 17, 2))
        self.assertEqual(struct.unpack('>17h', record.values),
                         (-98, -96, -96, -93, -92, -93, -85, -66, -39, -67, -40, -40, -40, -38, -37, -45, -37))
        self.assertEqual(decoded.pdu_count, 4)

    def test_sibling_vector_header_and_data_inheritance(self):
        first = array(0, [-100, -99])
        second = array(2, [-98, -97], flags=0x10)
        third = pdu(flags=0)  # All fields inherit from the second sibling.
        decoded = decode_datagram(datagram(first+second+third))
        self.assertEqual([r.address for r in decoded.dmp_records],
                         [SCAN_ADDRESS_BASE, SCAN_ADDRESS_BASE+2, SCAN_ADDRESS_BASE+2])
        target = assembler()
        self.assertEqual(target.apply(decoded, session_id='scan-1'), 4)
        self.assertEqual(target.apply(decoded, session_id='scan-1'), 0)

    def test_inheritance_never_crosses_datagrams_or_client_boundaries(self):
        decode_datagram(datagram(array(0, [-80])))
        inherited = array(0, [-80], flags=0x10)
        self.assert_code('SCAN_WIRE_INHERITANCE_MISSING', decode_datagram, datagram(inherited))
        other_client = pdu(b'\xff\xff', struct.pack('>IH', 2, 0), inherited)
        self.assert_code('SCAN_WIRE_INHERITANCE_MISSING', decode_datagram,
                         datagram(array(0, [-80]), extra_client=other_client))

    def test_short_terminal_array_is_unknown_not_a_fabricated_measurement(self):
        decoded = decode_datagram(datagram(bytes.fromhex('700a0422100009fbff99')))
        record = decoded.dmp_records[0]
        self.assertEqual((record.kind, record.unknown_reason), ('unknown', 'incomplete_array_header'))
        self.assertEqual(record.raw_data, bytes.fromhex('100009fbff99'))
        self.assertIsNone(record.address)
        self.assertEqual(record.values, b'')
        target = assembler(2551)
        self.assertEqual(target.apply(decoded, session_id='scan-1'), 0)
        self.assertEqual(target.snapshot()['points'][-1], [695875, None])

    def test_unsupported_address_forms_remain_explicit_unknowns(self):
        for header in (3, 6, 0x12, 0x32, 0x42, 0x82):
            with self.subTest(header=header):
                body = bytes.fromhex('100000050000000100000002ffa0ffa1')
                record = decode_datagram(datagram(pdu(b'\x04', bytes([header]), body))).dmp_records[0]
                self.assertEqual(record.kind, 'unknown')
                self.assertTrue(record.unknown_reason)
                self.assertIsNone(record.address)
                self.assertEqual(record.raw_data, body)

    def test_single_values_are_raw_and_address_widths_are_checked(self):
        for header, width in ((0, 1), (1, 2), (2, 4)):
            record = decode_datagram(datagram(pdu(b'\x04', bytes([header]), (5).to_bytes(width, 'big')+b'\x00\xff'))).dmp_records[0]
            self.assertEqual((record.kind, record.address, record.values), ('single', 5, b'\x00\xff'))
        record = decode_datagram(datagram(pdu(b'\x04', b'\x02', b'\x01'))).dmp_records[0]
        self.assertEqual(record.unknown_reason, 'incomplete_single_address')

    def test_count_zero_overflow_and_array_value_lengths(self):
        self.assert_code('SCAN_WIRE_ARRAY_COUNT', decode_datagram, datagram(array(0, [], count=0)))
        self.assert_code('SCAN_WIRE_ELEMENT_LIMIT', decode_datagram, datagram(array(0, [], count=0xffffffff)))
        self.assert_code('SCAN_WIRE_ADDRESS_OVERFLOW', decode_datagram,
                         datagram(array(0, [-90, -91], address=0xfffffff0, increment=16)))
        self.assert_code('SCAN_WIRE_ARRAY_VALUE_LENGTH', decode_datagram,
                         datagram(array(0, [-90], count=3)))
        self.assert_code('SCAN_WIRE_ELEMENT_LIMIT', decode_datagram,
                         datagram(array(0, [-90, -91])+array(2, [-92, -93])), limits=DecodeLimits(max_elements=3))

    def test_pdu_lengths_never_escape_their_parent(self):
        for malformed in (b'\x70', b'\xf0\x00', b'\x70\x00', b'\x70\x01', b'\x70\x05\x04\x22'):
            with self.subTest(malformed=malformed), self.assertRaises(ScanWireError):
                decode_datagram(datagram(malformed))
        # PDU advertises a vector/header larger than its own bounded body.
        self.assert_code('SCAN_WIRE_VECTOR_TRUNCATED', decode_datagram, ACN_IDENTIFIER+b'\x70\x03\x01')
        self.assert_code('SCAN_WIRE_HEADER_TRUNCATED', decode_datagram, ACN_IDENTIFIER+b'\x70\x06\x00\x00\x00\x01')
        self.assert_code('SCAN_WIRE_PDU_LENGTH', decode_datagram, ACN_IDENTIFIER+b'\x70\xff\x00')

    def test_inherited_data_cannot_hide_extra_bytes(self):
        items = array(0, [-90])+b'\x00\x03\xff'
        self.assert_code('SCAN_WIRE_INHERITED_DATA_TRAILING_BYTES', decode_datagram, datagram(items))
        self.assert_code('SCAN_WIRE_INHERITANCE_MISSING', decode_datagram,
                         datagram(pdu(b'\x04', b'\x02', flags=0x60)))

    def test_datagram_pdu_and_expansion_limits(self):
        valid = datagram(array(0, [-90]))
        for value in (b'', b'x'*65508, bytearray(valid)):
            self.assert_code('SCAN_WIRE_DATAGRAM_SIZE', decode_datagram, value)
        self.assert_code('SCAN_WIRE_IDENTIFIER', decode_datagram, b'x'*len(valid))
        self.assert_code('SCAN_WIRE_PDU_LIMIT', decode_datagram, valid, limits=DecodeLimits(max_pdus=3))
        self.assert_code('SCAN_WIRE_EXPANSION_LIMIT', decode_datagram, valid, limits=DecodeLimits(max_expanded_bytes=1))
        amplified = datagram(array(0, [-90]*17)+pdu(flags=0)*100)
        self.assert_code('SCAN_WIRE_EXPANSION_LIMIT', decode_datagram, amplified,
                         limits=DecodeLimits(max_expanded_bytes=2000))
        for kwargs in ({'max_pdus': True}, {'max_elements': 30001}, {'max_datagram_bytes': 65508}, {'max_expanded_bytes': 0}):
            self.assert_code('SCAN_WIRE_INVALID_LIMIT', DecodeLimits, **kwargs)

    def test_extended_length_and_unknown_layers_remain_bounded(self):
        large = pdu(struct.pack('>I', 99), bytes.fromhex(CID), b'x'*5000, extended=True)
        decoded = decode_datagram(ACN_IDENTIFIER+large)
        self.assertEqual((decoded.unhandled[0].layer, decoded.unhandled[0].vector), ('root', 99))
        self.assertEqual(len(decoded.unhandled[0].data), 5000)
        decoded = decode_datagram(datagram(b'unknown-protocol-data', client_protocol=123))
        self.assertEqual(decoded.unhandled[0].layer, 'client')
        ack = decode_datagram(datagram(pdu(b'\x0e', b'', b'\x00\x00\x00\x01'), client_protocol=1))
        self.assertEqual((ack.unhandled[0].layer, ack.unhandled[0].vector), ('wrapped_sdt', 14))
        self.assertEqual(ack.dmp_records, ())


class AssemblyTests(unittest.TestCase):
    def test_partial_grid_preserves_missing_slots_and_explicit_count(self):
        target = assembler()
        self.assertEqual(target.apply(decode_datagram(datagram(array(1, [-100, -99]))), session_id='scan-1'), 2)
        result = target.snapshot()
        self.assertEqual(result['points'], [[632125, None], [632150, -100], [632175, -99], [632200, None]])
        self.assertEqual((result['received_points'], result['missing_points'], result['coverage_complete']), (2, 2, False))
        self.assertEqual(result['device_scan_state'], 'unknown')

    def test_identical_retransmissions_are_idempotent(self):
        target = assembler()
        doc = decode_datagram(datagram(array(0, [-90, -91])+array(0, [-90, -91])))
        self.assertEqual(target.apply(doc, session_id='scan-1'), 2)
        before = target.snapshot()
        self.assertEqual(target.apply(doc, session_id='scan-1'), 0)
        self.assertEqual(target.snapshot(), before)

    def test_conflict_rejects_whole_datagram_without_partial_mutation(self):
        target = assembler()
        target.apply(decode_datagram(datagram(array(0, [-90]))), session_id='scan-1')
        before = target.snapshot()
        doc = decode_datagram(datagram(array(1, [-80])+array(0, [-91])))
        with self.assertRaises(ScanWireError) as caught:
            target.apply(doc, session_id='scan-1')
        self.assertEqual(caught.exception.code, 'SCAN_WIRE_POINT_CONFLICT')
        self.assertEqual(target.snapshot(), before)
        empty = assembler()
        with self.assertRaises(ScanWireError):
            empty.apply(decode_datagram(datagram(array(0, [-90])+array(0, [-89]))), session_id='scan-1')
        self.assertEqual(empty.snapshot()['received_points'], 0)

    def test_session_token_cid_and_channel_cannot_mix(self):
        for token, kwargs in (('scan-2', {}), ('scan-1', {'cid': 'ff'*16}), ('scan-1', {'channel': 18})):
            target = assembler()
            with self.subTest(token=token, kwargs=kwargs), self.assertRaises(ScanWireError) as caught:
                target.apply(decode_datagram(datagram(array(0, [-90]), **kwargs)), session_id=token)
            self.assertEqual(caught.exception.code, 'SCAN_WIRE_SESSION_MISMATCH')
            self.assertEqual(target.snapshot()['received_points'], 0)

    def test_grid_outside_and_unverified_array_shape_are_rejected(self):
        for item, code in ((array(3, [-90, -91]), 'SCAN_WIRE_GRID_RANGE'),
                           (array(0, [-90], address=SCAN_ADDRESS_BASE-1), 'SCAN_WIRE_GRID_RANGE'),
                           (array(0, [-90, -91], increment=2), 'SCAN_WIRE_UNSUPPORTED_SCAN_ARRAY'),
                           (array(0, [], count=1), 'SCAN_WIRE_UNSUPPORTED_SCAN_ARRAY')):
            target = assembler()
            with self.subTest(code=code), self.assertRaises(ScanWireError) as caught:
                target.apply(decode_datagram(datagram(item)), session_id='scan-1')
            self.assertEqual(caught.exception.code, code)
            self.assertEqual(target.snapshot()['received_points'], 0)

    def test_unrelated_properties_and_non_event_arrays_do_not_become_scan_points(self):
        target = assembler()
        doc = decode_datagram(datagram(array(0, [-90], address=0x20000000)+array(0, [-80], vector=2)))
        self.assertEqual(target.apply(doc, session_id='scan-1'), 0)

    def test_implausible_levels_remain_raw_but_cannot_pollute_points(self):
        for level in (-32768, -201, 51, 32767):
            target = assembler()
            doc = decode_datagram(datagram(array(0, [-90, level])))
            self.assertEqual(struct.unpack('>2h', doc.dmp_records[0].values), (-90, level))
            with self.subTest(level=level), self.assertRaises(ScanWireError) as caught:
                target.apply(doc, session_id='scan-1')
            self.assertEqual(caught.exception.code, 'SCAN_WIRE_LEVEL_OUT_OF_RANGE')
            self.assertEqual(target.snapshot()['received_points'], 0)

    def test_session_and_grid_cannot_be_relabelled_after_collection(self):
        target = assembler()
        target.apply(decode_datagram(datagram(array(0, [-90]))), session_id='scan-1')
        before = target.snapshot()
        for attribute, value in (('session_id', 'scan-2'), ('source_cid', 'ff'*16),
                                 ('channel', 2), ('start_khz', 600000), ('step_khz', 100), ('count', 1)):
            with self.subTest(attribute=attribute), self.assertRaises(AttributeError):
                setattr(target, attribute, value)
        self.assertEqual(target.snapshot(), before)

    def test_all_150_blocks_and_explicit_extra_tail_slot(self):
        target, file_grid = assembler(2550), assembler(2551)
        expected = [-107+i%72 for i in range(2550)]
        for start in range(0, 2550, 17):
            doc = decode_datagram(datagram(array(start, expected[start:start+17]), sequence=start//17+1))
            self.assertEqual(target.apply(doc, session_id='scan-1'), 17)
            file_grid.apply(doc, session_id='scan-1')
        result = target.snapshot()
        self.assertTrue(result['coverage_complete'])
        self.assertEqual(result['device_scan_state'], 'unknown')
        self.assertEqual(result['points'], [[632125+i*25, level] for i, level in enumerate(expected)])
        declared = file_grid.snapshot()
        self.assertEqual((declared['received_points'], declared['missing_points'], declared['coverage_complete']), (2550, 1, False))
        self.assertEqual(declared['points'][-1], [695875, None])
        result['points'][0][1] = 999
        self.assertEqual(target.snapshot()['points'][0][1], expected[0])

    def test_invalid_grids_are_rejected_before_allocation(self):
        for changes in ({'count': 30001}, {'count': 0}, {'count': True}, {'step_khz': 0},
                        {'start_khz': -1}, {'start_khz': 10000000}, {'session_id': ''},
                        {'source_cid': 'invalid'}, {'channel': 65536}):
            with self.subTest(changes=changes), self.assertRaises(ScanWireError):
                assembler(**changes)


if __name__ == '__main__':
    unittest.main()
