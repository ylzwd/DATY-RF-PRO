"""Strict, offline SLP discovery parsing for an ACN/DMP endpoint candidate.

No sockets, plugin activation, admission, scan commands or authorization.
The accepted profile is the SLPv2 AttributeReply shape observed from ULXD4,
with RFC 2608 framing. Unsupported extensions/authentication/escaped attributes
are rejected explicitly, not silently treated as verified discovery data.
"""
from dataclasses import dataclass
import ipaddress
import re
import uuid


PROFILE = 'slpv2-attrreply-acn-dmp-ipv4-v1'
PROFILE_SOURCES = (
    'https://www.rfc-editor.org/rfc/rfc2608.html#section-8',
    'https://www.rfc-editor.org/rfc/rfc2608.html#section-10.4',
    'observed:ULXD4-2.3.34.0-20261007-slp-attribute-reply',
)
_UUID = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z')
_KEY = re.compile(r'[A-Za-z0-9_.-]{1,64}\Z')
_LANGUAGE = re.compile(r'[A-Za-z]{1,8}(?:-[A-Za-z]{1,8})*\Z')
_CSL = re.compile(r'esta\.sdt/([^/:;,\s]+):([1-9][0-9]{0,4});esta\.dmp/cd:([^;,\s]+)\Z')


class ScanEndpointError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _fail(code):
    raise ScanEndpointError('SCAN_ENDPOINT_' + code)


@dataclass(frozen=True)
class EndpointLimits:
    max_packet_bytes: int = 4096
    max_attributes_bytes: int = 3072
    max_attributes: int = 32
    max_attribute_bytes: int = 1024

    def __post_init__(self):
        for value, minimum, maximum in (
            (self.max_packet_bytes, 20, 65507),
            (self.max_attributes_bytes, 1, 16384),
            (self.max_attributes, 1, 128),
            (self.max_attribute_bytes, 1, 4096),
        ):
            if type(value) is not int or not minimum <= value <= maximum:
                _fail('INVALID_LIMIT')


@dataclass(frozen=True)
class EndpointCandidate:
    """Discovery evidence only; this object does not mean connected or allowed."""
    cid: str  # Canonical 32 hex characters (16 bytes), same representation as SDT.
    ip: str
    port: int
    dmp_class_id: str
    packet_source: str
    function_label: str | None
    profile: str = PROFILE
    profile_sources: tuple[str, ...] = PROFILE_SOURCES
    evidence_kind: str = 'discovery_candidate'


def _ipv4(value):
    if not isinstance(value, str):
        _fail('INVALID_IPV4')
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        _fail('INVALID_IPV4')
    if address.is_multicast or address.is_unspecified or int(address) == 0xffffffff:
        _fail('INVALID_IPV4')
    return str(address)


def _cid(value):
    if not _UUID.fullmatch(value):
        _fail('INVALID_UUID')
    parsed = uuid.UUID(value)
    if not parsed.int:
        _fail('INVALID_UUID')
    return parsed.hex


def _attributes(raw, limits):
    if len(raw) > limits.max_attributes_bytes:
        _fail('ATTRIBUTES_LIMIT')
    try:
        text = raw.decode('utf-8', 'strict')
    except UnicodeDecodeError:
        _fail('INVALID_UTF8')
    if any(ord(char) < 32 or ord(char) == 127 for char in text):
        _fail('ATTRIBUTE_CONTROL_CHARACTER')
    # This observed profile has no escaped values or keyword-only attributes.
    # Explicit refusal avoids mis-parsing escaped delimiters as an endpoint.
    if '\\' in text:
        _fail('ESCAPED_ATTRIBUTES_UNSUPPORTED')
    result = {}
    cursor = 0
    while cursor < len(text):
        if len(result) >= limits.max_attributes:
            _fail('ATTRIBUTE_COUNT_LIMIT')
        if text[cursor] != '(':
            _fail('ATTRIBUTE_FORMAT')
        end = text.find(')', cursor+1)
        if end < 0:
            _fail('ATTRIBUTE_FORMAT')
        entry = text[cursor+1:end]
        if len(entry.encode('utf-8')) > limits.max_attribute_bytes:
            _fail('ATTRIBUTE_SIZE_LIMIT')
        if '(' in entry or '=' not in entry:
            _fail('ATTRIBUTE_FORMAT')
        key, value = entry.split('=', 1)
        if not _KEY.fullmatch(key) or '=' in value:
            _fail('ATTRIBUTE_FORMAT')
        key = key.lower()
        if key in result:
            _fail('DUPLICATE_ATTRIBUTE')
        values = tuple(part.strip() for part in value.split(','))
        if any(not part for part in values):
            _fail('ATTRIBUTE_FORMAT')
        result[key] = values
        cursor = end+1
        if cursor < len(text):
            if text[cursor] != ',' or cursor+1 == len(text):
                _fail('ATTRIBUTE_FORMAT')
            cursor += 1
    return result


def _one(attributes, key, *, optional=False):
    values = attributes.get(key)
    if values is None:
        if optional:
            return None
        _fail('REQUIRED_ATTRIBUTE_MISSING')
    if len(values) != 1:
        _fail('AMBIGUOUS_ATTRIBUTE')
    return values[0]


def parse_endpoint_candidate(payload, *, packet_source, target_ip=None, limits=None):
    """Return a bounded discovery candidate, None for non-target/service traffic.

    packet_source is the IP supplied by the caller's packet metadata, not a
    string trusted from this payload. target_ip optionally restricts that source.
    Malformed or unsupported SLP framing raises ScanEndpointError. Only this
    observed unauthenticated, extension-free attribute profile is supported.
    """
    limits = EndpointLimits() if limits is None else limits
    if not isinstance(limits, EndpointLimits):
        _fail('INVALID_LIMIT')
    if not isinstance(payload, bytes):
        _fail('INVALID_PAYLOAD_TYPE')
    if len(payload) > limits.max_packet_bytes:
        _fail('PACKET_LIMIT')
    source = _ipv4(packet_source)
    if target_ip is not None and source != _ipv4(target_ip):
        return None
    if len(payload) < 14:
        _fail('TRUNCATED_HEADER')
    if payload[0] != 2:
        _fail('VERSION_UNSUPPORTED')
    if payload[1] != 7:
        _fail('FUNCTION_UNSUPPORTED')
    if int.from_bytes(payload[2:5], 'big') != len(payload):
        _fail('LENGTH_MISMATCH')
    if payload[5:7] != b'\0\0':
        _fail('FLAGS_UNSUPPORTED')
    if payload[7:10] != b'\0\0\0':
        _fail('EXTENSIONS_UNSUPPORTED')
    language_length = int.from_bytes(payload[12:14], 'big')
    if not 1 <= language_length <= 63:
        _fail('INVALID_LANGUAGE')
    body = 14 + language_length
    if body + 5 > len(payload):
        _fail('TRUNCATED_BODY')
    try:
        language = payload[14:body].decode('ascii', 'strict')
    except UnicodeDecodeError:
        _fail('INVALID_LANGUAGE')
    if not _LANGUAGE.fullmatch(language):
        _fail('INVALID_LANGUAGE')
    if payload[body:body+2] != b'\0\0':
        _fail('REMOTE_ERROR')
    attributes_length = int.from_bytes(payload[body+2:body+4], 'big')
    if attributes_length > limits.max_attributes_bytes:
        _fail('ATTRIBUTES_LIMIT')
    attributes_end = body + 4 + attributes_length
    if attributes_end >= len(payload):
        _fail('TRUNCATED_ATTRIBUTES')
    if payload[attributes_end] != 0:
        _fail('AUTHENTICATION_UNSUPPORTED')
    if attributes_end + 1 != len(payload):
        _fail('TRAILING_BYTES')
    attributes = _attributes(payload[body+4:attributes_end], limits)
    if 'esta.dmp' not in attributes.get('acn-services', ()):
        return None
    cid = _cid(_one(attributes, 'cid'))
    csl = _one(attributes, 'csl-esta.dmp')
    match = _CSL.fullmatch(csl)
    if not match:
        _fail('CSL_FORMAT_UNSUPPORTED')
    advertised_ip = _ipv4(match.group(1))
    if advertised_ip != source:
        _fail('SOURCE_MISMATCH')
    port = int(match.group(2))
    if port > 65535:
        _fail('INVALID_PORT')
    class_id = _cid(match.group(3))
    return EndpointCandidate(cid=cid, ip=advertised_ip, port=port,
                             dmp_class_id=class_id, packet_source=source,
                             function_label=_one(attributes, 'acn-fctn', optional=True))
