"""Read the observed WWB 7.8 ULXD4 SDB3 profile, never send device commands.

Binary byte order, CRC and footer checks are empirical, not a published Shure
wire specification. File integrity does not establish a receiver scan outcome.
Keep this module in the verified, imported brand package.
"""
import hashlib
import json
import struct

MAX_BYTES = 128 * 1024
MAX_POINTS = 30000
PROFILE = 'wwb7-ulxd4-single-curve-two-record-v1'


class ScanFileError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def fail(code):
    raise ScanFileError(code)


def crc16_arc(data):
    value = 0
    for byte in data:
        value ^= byte
        for _ in range(8):
            value = (value >> 1) ^ 0xa001 if value & 1 else value >> 1
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail('SCAN_DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def json_object(raw, offset):
    # Locate a bounded UTF-8 object without decoding the following binary data.
    while offset < len(raw) and raw[offset] in b' \t\r\n':
        offset += 1
    if offset == len(raw):
        fail('SCAN_FILE_TRUNCATED')
    if raw[offset] != 123:
        fail('SCAN_INVALID_JSON')
    start = offset
    quoted = escaped = False
    depth = 0
    for i in range(offset, min(len(raw), offset + 16384)):
        byte = raw[i]
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (123, 91):
            depth += 1
            if depth > 16:
                fail('SCAN_JSON_LIMIT')
        elif byte in (125, 93):
            depth -= 1
            if depth == 0:
                try:
                    value = json.loads(raw[start:i+1], object_pairs_hook=unique_object,
                                       parse_constant=lambda _: fail('SCAN_INVALID_JSON'))
                except (UnicodeError, json.JSONDecodeError, RecursionError):
                    fail('SCAN_INVALID_JSON')
                if not isinstance(value, dict):
                    fail('SCAN_INVALID_JSON')
                return value, i + 1
    fail('SCAN_FILE_TRUNCATED' if len(raw) < start + 16384 else 'SCAN_JSON_LIMIT')


def marker(raw, offset, expected):
    while offset < len(raw) and raw[offset] in b' \t\r\n':
        offset += 1
    if len(raw) - offset < len(expected):
        fail('SCAN_FILE_TRUNCATED')
    if raw[offset:offset+len(expected)] != expected:
        fail('SCAN_UNSUPPORTED_LAYOUT')
    return offset + len(expected)


def parse_scan(raw, cancelled=lambda: False):
    """Return all measured slots, including explicit None for NoDataValue.

    No interpolation, deduplication, live identity binding or database write.
    Unsupported layouts are rejected, not guessed from names or extensions.
    """
    if not isinstance(raw, bytes) or not 1 <= len(raw) <= MAX_BYTES:
        fail('SCAN_FILE_SIZE')
    if cancelled():
        fail('SCAN_READ_CANCELLED')
    if not raw.startswith(b'//@ShureScan\n'):
        fail('SCAN_FILE_SIGNATURE')
    header, offset = json_object(raw, len(b'//@ShureScan\n'))
    if (header.get('Version') != '1.0.0.0' or header.get('ScannerModel') != 'ULXD4'
            or header.get('FreqUnits') != 'KHz' or header.get('AmplUnits') != 'dBm'
            or type(header.get('BitWidth')) is not int or header['BitWidth'] != 16
            or type(header.get('Scale Factor')) is not int or header['Scale Factor'] != 10
            or type(header.get('NoDataValue')) is not int or header['NoDataValue'] != -1400):
        fail('SCAN_UNSUPPORTED_PROFILE')
    schema = header.get('BinarySchema')
    prefix = [{'Bytes': 4, 'DataValue': v} for v in ('start-of-sweep', 'id', 'timestamp')]
    if (not isinstance(schema, list) or len(schema) != 5 or schema[:3] != prefix
            or schema[-1] != {'Bytes': 2, 'DataValue': 'crc16'}
            or not isinstance(schema[3], dict) or set(schema[3]) != {'Curve'}):
        fail('SCAN_UNSUPPORTED_LAYOUT')
    curve = schema[3]['Curve']
    if not isinstance(curve, dict):
        fail('SCAN_UNSUPPORTED_LAYOUT')
    ranges = curve.get('FreqRanges')
    if not isinstance(ranges, list) or len(ranges) != 1 or not isinstance(ranges[0], dict):
        fail('SCAN_UNSUPPORTED_LAYOUT')
    freq = ranges[0]
    if set(freq) != {'StartFreq', 'EndFreq', 'StepFreq'} or any(type(v) is not int for v in freq.values()):
        fail('SCAN_INVALID_GRID')
    start, end, step = (freq[k] for k in ('StartFreq', 'EndFreq', 'StepFreq'))
    if not (1 <= start < end <= 10000000 and 1 <= step <= end-start) or (end-start) % step:
        fail('SCAN_INVALID_GRID')
    count = (end-start) // step + 1
    if count > MAX_POINTS:
        fail('SCAN_POINT_LIMIT')
    offset = marker(raw, offset, b'@Binary:')
    records = []
    for expected_id in (1, 0):
        if cancelled():
            fail('SCAN_READ_CANCELLED')
        # No whitespace skipping inside binary records.
        size = 12 + count * 2 + 2
        if len(raw) - offset < size:
            fail('SCAN_FILE_TRUNCATED')
        if raw[offset:offset+4] != b'@Swp':
            fail('SCAN_UNSUPPORTED_LAYOUT')
        record = raw[offset:offset+size]
        identity, timestamp = struct.unpack_from('>II', record, 4)
        if identity != expected_id:
            fail('SCAN_UNSUPPORTED_RECORDS')
        stored = struct.unpack_from('>H', record, size-2)[0]
        if crc16_arc(record[:-2]) != stored:
            fail('SCAN_CRC_MISMATCH')
        values = struct.unpack_from('>' + str(count) + 'h', record, 12)
        points = []
        for i, value in enumerate(values):
            level = None if value == -1400 else value / 10
            if level is not None and not -200 <= level <= 50:
                fail('SCAN_LEVEL_OUT_OF_RANGE')
            points.append([start+i*step, level])
        records.append({'id_raw': identity, 'timestamp_raw': timestamp,
                        'crc16': format(stored, '04x'), 'points': points,
                        'valid_points': sum(p[1] is not None for p in points),
                        'missing_points': sum(p[1] is None for p in points)})
        offset += size
    offset = marker(raw, offset, b'@Extended:')
    extended, offset = json_object(raw, offset)
    if extended.get('AppendedSpecialSweeps') != ['Appended peakhold']:
        fail('SCAN_UNSUPPORTED_RECORDS')
    offset = marker(raw, offset, b'@End')
    if len(raw)-offset < 8:
        fail('SCAN_FILE_TRUNCATED')
    if len(raw)-offset != 8 or raw[offset:] != struct.pack('>II', 1, 2):
        fail('SCAN_UNSUPPORTED_FOOTER')
    if cancelled():
        fail('SCAN_READ_CANCELLED')
    return {'schema': 'daty-shure-scan-file-v1', 'profile': PROFILE,
            'source_kind': 'wwb-file', 'file_sha256': hashlib.sha256(raw).hexdigest(),
            'file_state': 'validated', 'device_scan_state': 'unknown',
            'receiver_identity': None, 'frequency_unit': 'kHz', 'level_unit': 'dBm',
            'file_time_zone': None, 'header': header, 'extended': extended,
            'point_count_per_record': count, 'records': records,
            'footer_words_raw': [1, 2]}


class ShureScanFiles:
    """Optional plugin host entry. Does not open sockets or take a scan lease."""
    def read(self, raw, *, cancelled):
        from plugin_install import PluginError
        try:
            return parse_scan(raw, cancelled)
        except ScanFileError as error:
            raise PluginError(error.code, 422) from error
