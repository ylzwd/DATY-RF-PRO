"""Bounded MQTT 5 framing for the isolated, transparent read-only gateway.

The mature Broker owns subscriptions, QoS and ACKs. This module only validates
the explicitly supported client subset and rewrites connection/topic names.
"""
import asyncio
import struct

MAX_PACKET = 1024 * 1024


def varint(n):
    if not 0 <= n <= 268435455:
        raise ValueError('Invalid MQTT length')
    out = bytearray()
    while True:
        digit, n = n % 128, n // 128
        out.append(digit | (128 if n else 0))
        if not n:
            return bytes(out)


def number(data, pos=0):
    value = 0
    for index in range(4):
        if pos + index >= len(data):
            raise EOFError('Incomplete MQTT length')
        digit = data[pos + index]
        value += (digit & 127) << (7 * index)
        if not digit & 128:
            if varint(value) != data[pos:pos + index + 1]:
                raise ValueError('Noncanonical MQTT length')
            return value, pos + index + 1
    raise ValueError('Invalid MQTT length')


def utf(text):
    raw = text.encode('utf-8')
    return struct.pack('>H', len(raw)) + raw


def string(data, pos=0):
    if pos + 2 > len(data):
        raise ValueError('Missing string')
    size = int.from_bytes(data[pos:pos + 2], 'big')
    end = pos + 2 + size
    if end > len(data):
        raise ValueError('Truncated string')
    text = data[pos + 2:end].decode('utf-8')
    if '\0' in text:
        raise ValueError('Invalid string')
    return text, end


def packet(header, body=b''):
    if len(body) > MAX_PACKET:
        raise ValueError('Packet too large')
    return bytes([header]) + varint(len(body)) + body


def split(buffer):
    if len(buffer) < 2:
        return None
    try:
        size, start = number(buffer, 1)
    except EOFError:
        return None
    if size > MAX_PACKET:
        raise ValueError('Packet too large')
    end = start + size
    if len(buffer) < end:
        return None
    result = (buffer[0], bytes(buffer[start:end]))
    del buffer[:end]
    return result


async def read_packet(reader):
    header = (await reader.readexactly(1))[0]
    length = bytearray()
    for _ in range(4):
        length += await reader.readexactly(1)
        if not length[-1] & 128:
            break
    size, _ = number(length)
    if size > MAX_PACKET:
        raise ValueError('Packet too large')
    return header, await reader.readexactly(size)


class WSReader:
    def __init__(self, ws):
        self.ws, self.buffer = ws, bytearray()

    async def read(self):
        while True:
            found = split(self.buffer)
            if found:
                return found
            data = await asyncio.wait_for(self.ws.recv(), 30)
            if not isinstance(data, bytes):
                raise ValueError('Binary MQTT required')
            self.buffer.extend(data)
            if len(self.buffer) > MAX_PACKET + 5:
                raise ValueError('Buffered packet limit exceeded')


def connect(body, client_id, username, password):
    protocol, pos = string(body)
    if protocol != 'MQTT' or body[pos:pos + 2] != b'\x05\x02':
        raise ValueError('Clean MQTT5, no client credentials or Will required')
    if len(body) < pos + 5:
        raise ValueError('Invalid CONNECT')
    keepalive = int.from_bytes(body[pos + 2:pos + 4], 'big')
    if not 1 <= keepalive <= 30:
        raise ValueError('Keepalive must be 1..30 seconds')
    size, start = number(body, pos + 4)
    end, at, seen = start + size, start, set()
    if end > len(body):
        raise ValueError('Invalid properties')
    while at < end:
        code = body[at]
        width = {0x11: 4, 0x21: 2, 0x27: 4}.get(code)
        if width is None or code in seen or at + 1 + width > end:
            raise ValueError('Unsupported CONNECT property')
        seen.add(code)
        value = int.from_bytes(body[at + 1:at + 1 + width], 'big')
        if ((code == 0x11 and value != 0) or (code == 0x21 and value == 0)
                or (code == 0x27 and value < MAX_PACKET)):
            raise ValueError('Unsupported CONNECT property value')
        at += 1 + width
    requested, finish = string(body, end)
    if requested or finish != len(body):
        raise ValueError('Server assigns stream identity; empty clientId required')
    return (utf('MQTT') + b'\x05\xc2' + keepalive.to_bytes(2, 'big')
            + body[pos + 4:end] + utf(client_id) + utf(username) + utf(password))


def connack(body, client_id):
    if len(body) < 3 or body[:2] != b'\0\0':
        raise ConnectionError('Broker refused clean connection')
    size, start = number(body, 2)
    if start + size != len(body):
        raise ValueError('Invalid CONNACK')
    properties = body[start:] + b'\x12' + utf(client_id)
    return b'\0\0' + varint(len(properties)) + properties


def subscribe(body, logical, physical):
    if len(body) < 4 or body[:2] == b'\0\0':
        raise ValueError('Invalid SUBSCRIBE')
    size, pos = number(body, 2)
    if size:
        raise ValueError('Subscription properties unsupported')
    topic, end = string(body, pos)
    if topic != logical or end + 1 != len(body) or body[end] not in (0, 1):
        raise PermissionError('Only one exact read-only topic is allowed')
    return body[:2] + b'\0' + utf(physical) + body[end:], body[:2]


def publish_topic(header, body, physical, logical):
    if header & 1 or (header >> 1) & 3 not in (0, 1):
        raise ValueError('Retained/QoS2 state is unsupported')
    topic, pos = string(body)
    if topic != physical:
        raise PermissionError('Unexpected stream')
    return utf(logical) + body[pos:]
