"""Pure SLP endpoint parsing tests; no network, activation or device commands."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT/'app/server'))
from shure_scan_endpoint import (EndpointLimits, PROFILE, ScanEndpointError,
                                 parse_endpoint_candidate)


# Derived from the observed ULXD4 AttributeReply byte layout. CID/class UUIDs,
# IP and transaction ID are anonymized; protocol fields and attribute order are
# retained, with lengths recalculated. 192.0.2.10 is a documentation address.
OBSERVED_SANITIZED = bytes.fromhex(
    '0207000137000000000012340002656e00000122'
    '286369643d31313131313131312d323232322d343333332d383434342d35353535353535353535353529'
    '2c2861636e2d6663746e3d554c58443a20527829'
    '2c2861636e2d7561636e3d554c58443a20527829'
    '2c2861636e2d73657276696365733d657374612e646d7029'
    '2c2863736c2d657374612e646d703d657374612e7364742f3139322e302e322e31303a3537363234'
    '3b657374612e646d702f63643a36363636363636362d373737372d343838382d383939392d41414141414141414141414129'
    '2c286465766963652d6465736372697074696f6e3d243a746674703a2f2f3139322e302e322e31302f242e64646c29'
    '2c2863736c2d657374612e646d702e76616c7565733d76657273696f6e3a315f696e7465726661636549643a33322900')
CID = '11111111-2222-4333-8444-555555555555'
CLASS = '66666666-7777-4888-8999-AAAAAAAAAAAA'
SOURCE = '192.0.2.10'


def attrs(*, cid=CID, ip=SOURCE, port='41000', service='esta.dmp', suffix=''):
    return (f'(cid={cid}),(acn-services={service}),'
            f'(csl-esta.dmp=esta.sdt/{ip}:{port};esta.dmp/cd:{CLASS})'+suffix)


def packet(attributes=None, *, language=b'en', error=0, auth=0, trailing=b''):
    if attributes is None:
        attributes = attrs()
    raw = attributes.encode('utf-8') if isinstance(attributes, str) else attributes
    body = (language + error.to_bytes(2, 'big') + len(raw).to_bytes(2, 'big')
            + raw + bytes([auth]) + trailing)
    return b'\x02\x07'+(14+len(body)).to_bytes(3, 'big')+b'\0'*5+b'\x12\x34'+len(language).to_bytes(2, 'big')+body


def alter(wire, index, data):
    return wire[:index]+data+wire[index+len(data):]


class EndpointTests(unittest.TestCase):
    def parse(self, wire=OBSERVED_SANITIZED, **kwargs):
        return parse_endpoint_candidate(wire, packet_source=kwargs.pop('packet_source', SOURCE), **kwargs)

    def reject(self, suffix, wire, **kwargs):
        with self.assertRaises(ScanEndpointError) as error:
            self.parse(wire, **kwargs)
        self.assertEqual(error.exception.code, 'SCAN_ENDPOINT_'+suffix)

    def test_sanitized_observed_reply_is_only_a_candidate(self):
        self.assertEqual(len(OBSERVED_SANITIZED), 311)
        candidate = self.parse(target_ip=SOURCE)
        self.assertEqual((candidate.cid, candidate.ip, candidate.port),
                         (CID.replace('-', '').lower(), SOURCE, 57624))
        self.assertEqual(candidate.dmp_class_id, CLASS.replace('-', '').lower())
        self.assertEqual(candidate.function_label, 'ULXD: Rx')
        self.assertEqual(candidate.profile, PROFILE)
        self.assertEqual(candidate.evidence_kind, 'discovery_candidate')
        self.assertTrue(any('rfc2608' in source for source in candidate.profile_sources))
        self.assertFalse(hasattr(candidate, 'connected'))
        self.assertFalse(hasattr(candidate, 'scan_supported'))

    def test_dynamic_ports_are_taken_from_payload(self):
        for port in (1, 2202, 41000, 65535):
            with self.subTest(port=port):
                self.assertEqual(self.parse(packet(attrs(port=str(port)))).port, port)

    def test_different_cid_and_class_id_are_not_fixed(self):
        replacement = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'
        wire = packet(attrs(cid=replacement).replace(CLASS, CID))
        candidate = self.parse(wire)
        self.assertEqual(candidate.cid, replacement.replace('-', '').lower())
        self.assertEqual(candidate.dmp_class_id, CID.replace('-', '').lower())

    def test_unrelated_source_or_service_is_ignored(self):
        self.assertIsNone(self.parse(target_ip='192.0.2.11'))
        self.assertIsNone(self.parse(packet(attrs(service='other.service'))))
        self.assertIsNone(self.parse(packet('(unrelated=value)')))

    def test_advertised_ip_must_match_packet_source(self):
        self.reject('SOURCE_MISMATCH', packet(attrs(ip='192.0.2.11')))
        self.reject('SOURCE_MISMATCH', OBSERVED_SANITIZED, packet_source='192.0.2.12')

    def test_invalid_addresses_reject_without_dns_resolution(self):
        for address in ('host.example', '::1', '0.0.0.0', '239.255.254.253', '255.255.255.255', '192.000.2.10'):
            with self.subTest(address=address):
                self.reject('INVALID_IPV4', packet(), packet_source=address)
        self.reject('INVALID_IPV4', packet(attrs(ip='host.example')))

    def test_uuid_format_is_strict(self):
        for cid in ('not-a-uuid', CID.replace('-', ''), '{'+CID+'}', '00000000-0000-0000-0000-000000000000'):
            with self.subTest(cid=cid):
                self.reject('INVALID_UUID', packet(attrs(cid=cid)))
        self.reject('INVALID_UUID', packet(attrs().replace(CLASS, 'invalid-class')))

    def test_csl_has_exact_single_endpoint_shape(self):
        for port in ('0', '65536', '-1', '+1', '00080', '1.5', '999999'):
            with self.subTest(port=port):
                self.reject('INVALID_PORT' if port == '65536' else 'CSL_FORMAT_UNSUPPORTED', packet(attrs(port=port)))
        self.reject('CSL_FORMAT_UNSUPPORTED', packet(attrs().replace('esta.sdt/', 'http://')))
        self.reject('CSL_FORMAT_UNSUPPORTED', packet(attrs().replace(';esta.dmp/cd:', ';other/cd:')))

    def test_duplicate_attributes_are_not_silently_overwritten(self):
        self.reject('DUPLICATE_ATTRIBUTE', packet(attrs(suffix=f',(CID={CID})')))
        self.reject('ATTRIBUTE_FORMAT', packet(attrs(suffix=' ,(cid=other)')))

    def test_ambiguous_values_and_missing_fields_reject(self):
        self.reject('AMBIGUOUS_ATTRIBUTE', packet(attrs(cid=CID+','+CID)))
        self.reject('AMBIGUOUS_ATTRIBUTE', packet(attrs().replace(';esta.dmp/cd:'+CLASS,
                    ';esta.dmp/cd:'+CLASS+',esta.sdt/192.0.2.10:41001;esta.dmp/cd:'+CLASS)))
        self.reject('REQUIRED_ATTRIBUTE_MISSING', packet('(acn-services=esta.dmp)'))

    def test_invalid_attribute_shapes_are_explicit(self):
        for value in (attrs()+',', attrs()+'junk', '(cid=x', '(a=(nested))', '(a=)', '(a=b,,c)', 'keyword', '(a=b=c)'):
            with self.subTest(value=value):
                self.reject('ATTRIBUTE_FORMAT', packet(value))
        self.reject('ESCAPED_ATTRIBUTES_UNSUPPORTED', packet(attrs(suffix=r',(extra=escaped\28value)')))
        self.reject('ATTRIBUTE_CONTROL_CHARACTER', packet(attrs(suffix=',(extra=bad\x00value)')))
        self.reject('INVALID_UTF8', packet(b'(extra=\xff)'))

    def test_version_type_flags_extensions_error_auth_and_trailing(self):
        self.reject('VERSION_UNSUPPORTED', alter(packet(), 0, b'\x01'))
        self.reject('FUNCTION_UNSUPPORTED', alter(packet(), 1, b'\x02'))
        self.reject('FLAGS_UNSUPPORTED', alter(packet(), 5, b'\x80'))
        self.reject('EXTENSIONS_UNSUPPORTED', alter(packet(), 7, b'\0\0\x10'))
        self.reject('REMOTE_ERROR', packet(error=1))
        self.reject('AUTHENTICATION_UNSUPPORTED', packet(auth=1, trailing=b'auth-data'))
        self.reject('TRAILING_BYTES', packet(trailing=b'junk'))

    def test_every_truncation_of_fixture_is_rejected(self):
        for length in range(len(OBSERVED_SANITIZED)):
            with self.subTest(length=length), self.assertRaises(ScanEndpointError):
                self.parse(OBSERVED_SANITIZED[:length])

    def test_inner_length_overflow_and_missing_auth_byte(self):
        self.reject('TRUNCATED_BODY', alter(packet(''), 12, b'\0\x3f'))
        self.reject('ATTRIBUTES_LIMIT', alter(packet(), 18, b'\xff\xff'))
        wire = packet()
        size = int.from_bytes(wire[18:20], 'big')
        self.reject('TRUNCATED_ATTRIBUTES', alter(wire, 18, (size+1).to_bytes(2, 'big')))
        self.reject('LENGTH_MISMATCH', alter(wire, 2, (len(wire)+1).to_bytes(3, 'big')))

    def test_language_is_validated(self):
        self.assertIsNotNone(self.parse(packet(language=b'en-US')))
        for language in (b'', b'en_XX', b'\xff', b'englishlong', b'en--US'):
            with self.subTest(language=language):
                self.reject('INVALID_LANGUAGE', packet(language=language))

    def test_limits_bound_each_level(self):
        self.reject('PACKET_LIMIT', packet(), limits=EndpointLimits(max_packet_bytes=30))
        self.reject('ATTRIBUTES_LIMIT', packet(), limits=EndpointLimits(max_attributes_bytes=50))
        self.reject('ATTRIBUTE_COUNT_LIMIT', packet(), limits=EndpointLimits(max_attributes=2))
        self.reject('ATTRIBUTE_SIZE_LIMIT', packet(), limits=EndpointLimits(max_attribute_bytes=10))
        self.reject('INVALID_LIMIT', packet(), limits={})
        for kwargs in ({'max_attributes':0}, {'max_attributes':True}, {'max_packet_bytes':1000000}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ScanEndpointError):
                EndpointLimits(**kwargs)

    def test_payload_type_is_explicit(self):
        self.reject('INVALID_PAYLOAD_TYPE', bytearray(OBSERVED_SANITIZED))
        self.reject('INVALID_PAYLOAD_TYPE', None)


if __name__ == '__main__':
    unittest.main()
