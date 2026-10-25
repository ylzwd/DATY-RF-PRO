"""Isolated compatibility ingress, NOT imported by production services.

Existing receiver wire protocol -> validated, attributed private Broker events.
No device command delivery, UI RPC, enrollment endpoint, DB or deployment code.
"""
import asyncio
import ipaddress
import json
from pathlib import Path
import re
import struct
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from receiver_pairing import (ReceiverPairingPolicy, PairingError, MqttPacketBuffer,
                             parse_connect, mqtt_body, mqtt_utf, SUBSCRIBE_TOPICS)
import websockets
from websockets.exceptions import ConnectionClosed

KINDS = {'daty/rf/devices/register': 'register', 'daty/rf/devices/up': 'telemetry',
         'daty/rf/devices/down': 'local-event', 'daty/rf/clock/ack': 'clock-ack'}
RESERVED = {'source', 'actor', 'authenticated', 'server_id', 'boot_id', 'session_id',
            'event_id', 'received_at_ms', 'sequence', 'schema'}
SENSITIVE = {'password', 'secret', 'secret_sha256', 'authorization', 'private_key', 'credential_id'}
ALLOWED_ORIGINS = {None, 'null', 'http://localhost:8081', 'http://127.0.0.1:8081',
                   'https://localhost:8081', 'https://127.0.0.1:8081'}


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise PairingError('Duplicate JSON key')
            result[key] = value
        return result
    def invalid(_):
        raise PairingError('Nonfinite JSON')
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid)
        if not isinstance(value, dict):
            raise PairingError('Object required')
        return value
    except (ValueError, UnicodeError, RecursionError) as error:
        raise PairingError('Invalid JSON') from error


def check_sensitive(value, depth=0):
    if depth > 16:
        raise PairingError('Payload nesting exceeded')
    if isinstance(value, dict):
        if SENSITIVE & value.keys():
            raise PairingError('Credentials are not telemetry')
        for item in value.values():
            check_sensitive(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            check_sensitive(item, depth + 1)


class ReceiverGateway:
    def __init__(self, policy, sink, *, server_id, fixture_root):
        base = Path(fixture_root).resolve()
        path = policy.path.resolve()
        forbidden = (ROOT, ROOT.parent / 'FAshe', Path('C:/ProgramData/DATY RF PRO'))
        if (not (base / '.daty-mqtt-stage1-fixture').is_file()
                or not path.is_relative_to(base) or any(base.is_relative_to(p.resolve()) for p in forbidden)):
            raise ValueError('Explicit isolated fixture required; production registry forbidden')
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', server_id):
            raise ValueError('Invalid server id')
        self.policy, self.sink, self.server_id = policy, sink, server_id
        self.boot_id = uuid.uuid4().hex
        self.sessions = {}
        self.server = None
        self.accepted, self.denied = 0, 0

    async def start(self, tls, *, host='127.0.0.1', port=0):
        if not ipaddress.ip_address(host).is_loopback or not tls or port in (8080, 8083, 8765, 8801, 8802):
            raise ValueError('Prototype requires TLS and a non-production loopback listener')
        self.server = await websockets.serve(self.handle, host, port, ssl=tls,
            subprotocols=['mqtt'], origins=ALLOWED_ORIGINS, max_size=1024 * 1024,
            max_queue=16, compression=None, ping_interval=None)
        return self.server.sockets[0].getsockname()[1]

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()

    def envelope(self, principal, session, sequence, topic, payload):
        check_sensitive(payload)
        if RESERVED & payload.keys() or any(RESERVED & item.keys() for item in payload.get('devices', []) if isinstance(item, dict)):
            raise PairingError('Client supplied reserved transport metadata')
        checked = self.policy.validate_payload(principal, topic, payload)
        if not self.policy.is_active(principal):
            raise PairingError('Pairing changed')
        source = {'receiver_id': principal['receiver_id'], 'receiver_mac': principal['receiver_mac'],
            'peer_ip': principal['_peer_ip'], 'group_number': checked['group_number'],
            'brand': principal['brand'], 'session_id': session, 'authenticated': True,
            'ip_source': 'socket-peer', 'identity_source': 'daty-pairing-v1', 'group_source': 'server-fifo-v1'}
        return {'schema': 'daty-mqtt-ingress-v2-stage1', 'server_id': self.server_id,
            'boot_id': self.boot_id, 'event_id': uuid.uuid4().hex, 'sequence': sequence,
            'received_at_ms': int(time.time() * 1000), 'kind': KINDS[topic],
            'source': source, 'payload': checked}

    def current_event(self, topic, event):
        """In-process prototype check after Broker delivery; not remote attestation.

        Later business consumer needs an equally trusted session registry. A stale
        event may remain in a transport queue but must never authorize control.
        """
        try:
            source = event['source']
            current = self.sessions.get(source['receiver_id'])
            if (not current or current[0] != source['session_id']
                    or event['server_id'] != self.server_id or event['boot_id'] != self.boot_id
                    or event['schema'] != 'daty-mqtt-ingress-v2-stage1'):
                return False
            principal = current[2]
            if not self.policy.is_active(principal):
                return False
            expected = f"daty/prototype/v2/{self.server_id}/ingress/{principal['receiver_id']}/{current[0]}/{event['kind']}"
            if topic != expected or event['kind'] not in KINDS.values():
                return False
            return (source['peer_ip'] == principal['_peer_ip']
                    and source['receiver_mac'] == principal['receiver_mac']
                    and source['brand'] == principal['brand']
                    and source['group_number'] == self.policy._load()['receiver_groups'][principal['receiver_mac']]
                    and source['authenticated'] is True and source['ip_source'] == 'socket-peer'
                    and source['identity_source'] == 'daty-pairing-v1' and source['group_source'] == 'server-fifo-v1')
        except (KeyError, TypeError, AttributeError):
            return False

    async def handle(self, ws):
        principal, watcher, session = None, None, uuid.uuid4().hex
        decoder, pending, sequence = MqttPacketBuffer(), [], 0
        async def next_packet(timeout):
            deadline = asyncio.get_running_loop().time() + timeout
            while not pending:
                raw = await asyncio.wait_for(ws.recv(), max(0, deadline - asyncio.get_running_loop().time()))
                pending.extend(decoder.feed(raw))
            return pending.pop(0)
        try:
            if ws.request.path != '/mqtt' or ws.subprotocol != 'mqtt':
                raise PairingError('Wrong endpoint')
            # Only the socket address is trusted. Forwarded headers are never used.
            peer = ws.remote_address[0]
            if not ipaddress.ip_address(peer).is_loopback:
                raise PairingError('Non-fixture peer')
            try:
                client, username, password, keepalive = parse_connect(await next_packet(5))
                principal = self.policy.authenticate(username, password, client, peer)
                password = None
                if not principal.get('group_number'):
                    raise PairingError('Pre-existing GROUP required in phase 1')
            except PairingError:
                await ws.send(b'\x20\x02\x00\x05')
                raise
            rid = principal['receiver_id']
            prior = self.sessions.get(rid)
            self.sessions[rid] = (session, ws, principal)
            if prior:
                await prior[1].close(4001, 'receiver session replaced')
            await ws.send(b'\x20\x02\x00\x00')
            async def monitor():
                while True:
                    await asyncio.sleep(.1)
                    if not self.policy.is_active(principal):
                        await ws.close(4003, 'pairing revoked or expired')
                        return
            watcher = asyncio.create_task(monitor())
            while True:
                packet = await next_packet(keepalive * 1.5)
                if self.sessions.get(rid, (None,))[0] != session or not self.policy.is_active(principal):
                    raise PairingError('Stale session')
                kind, flags, body = packet[0] >> 4, packet[0] & 15, mqtt_body(packet)
                if kind == 3:
                    qos = (flags >> 1) & 3
                    if flags & 1 or qos > 1 or (qos == 0 and flags & 8):
                        raise PairingError('Retain or QoS denied')
                    topic, offset = mqtt_utf(body, 0)
                    if topic not in KINDS:
                        raise PairingError('Topic denied')
                    packet_id = None
                    if qos:
                        if offset + 2 > len(body):
                            raise PairingError('Missing packet id')
                        packet_id = struct.unpack_from('>H', body, offset)[0]
                        offset += 2
                        if not packet_id:
                            raise PairingError('Zero packet id')
                    sequence += 1
                    event = self.envelope(principal, session, sequence, topic, strict_json(body[offset:]))
                    destination = f'daty/prototype/v2/{self.server_id}/ingress/{rid}/{session}/{KINDS[topic]}'
                    # Await bounded Broker receipt; never call this a DB/execution ACK.
                    # No automatic reconnect or replay by the sink in this prototype.
                    await self.sink.publish(destination, event)
                    self.accepted += 1
                    if packet_id is not None:
                        await ws.send(b'\x40\x02' + struct.pack('>H', packet_id))
                elif kind == 8:
                    if flags != 2 or len(body) < 5:
                        raise PairingError('Bad subscribe')
                    pid = struct.unpack_from('>H', body)[0]
                    if not pid:
                        raise PairingError('Bad subscribe id')
                    offset, codes = 2, []
                    while offset < len(body):
                        topic, offset = mqtt_utf(body, offset)
                        if offset >= len(body):
                            raise PairingError('Bad subscription')
                        qos = body[offset]
                        offset += 1
                        codes.append(0 if topic in SUBSCRIBE_TOPICS and qos in (0, 1) else 128)
                    # Compatibility acceptance only: this prototype has NO control egress.
                    response = struct.pack('>H', pid) + bytes(codes)
                    if len(response) >= 128:
                        raise PairingError('Too many subscriptions')
                    await ws.send(bytes([0x90, len(response)]) + response)
                elif kind == 12 and flags == 0 and not body:
                    await ws.send(b'\xd0\x00')
                elif kind == 14 and flags == 0 and not body:
                    return
                else:
                    raise PairingError('Unsupported packet')
        except PairingError:
            self.denied += 1
            await ws.close(1008, 'receiver policy denied')
        except asyncio.TimeoutError:
            await ws.close(4008, 'prototype timeout')
        except ConnectionClosed:
            pass
        except Exception:
            # Fail closed on broker/storage/codec errors; no raw errors or secrets logged.
            await ws.close(1013, 'prototype broker unavailable')
        finally:
            if watcher:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)
            if principal and self.sessions.get(principal['receiver_id'], (None,))[0] == session:
                self.sessions.pop(principal['receiver_id'], None)
