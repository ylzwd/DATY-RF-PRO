"""Encode canonical events once; retain every original JSON value and order.

The Bridge already freezes each event as JSON before it enters the bounded
queue. Keep that exact JSON in the wire envelope rather than parse/dump it for
size accounting and then dump the same payload again. Validation still parses
every event once, including non-finite values which aren't valid wire JSON.
"""
import json

KINDS = frozenset(('device_list', 'device_update', 'mute_command',
                   'command_update', 'client_disconnect'))
MAX_EVENTS = 128
MAX_BATCH_BYTES = 800 * 1024


def _reject_constant(value):
    raise ValueError('Non-finite canonical JSON: ' + value)


_DECODER = json.JSONDecoder(parse_constant=_reject_constant)


def encode_event(raw):
    payload = _DECODER.decode(raw)
    kind = payload.get('type')
    if kind not in KINDS:
        return None
    return (b'{"kind": ' + json.dumps(kind).encode('ascii') +
            b', "payload": ' + raw.encode('utf-8') + b'}')


def batch_payload(events):
    return b'{"events": [' + b', '.join(events) + b']}'


def wire_envelope(boot_id, stream_id, seq, kind, payload):
    header = json.dumps({'schema': 'daty-device-mqtt6-v1',
        'server_id': 'daty-rf-pro', 'boot_id': boot_id, 'stream_id': stream_id,
        'seq': seq, 'kind': kind}, ensure_ascii=False, allow_nan=False).encode('utf-8')
    return header[:-1] + b', "payload": ' + payload + b'}'
