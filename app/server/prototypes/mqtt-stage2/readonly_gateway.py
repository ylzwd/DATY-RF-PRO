"""Isolated MQTT5/WSS read-only gateway. Not loaded by production services."""
import asyncio
from pathlib import Path
import queue
import time
import uuid

import websockets
from websockets.exceptions import ConnectionClosed
from http_transport import origin_allowed
from device_feed import envelope
from mqtt_wire import (WSReader, connect, connack, packet, read_packet,
                       subscribe, publish_topic)

LOGICAL = 'daty/v2/stage2-server/devices/read'
PREFIX = 'daty/prototype/v2/stage2-server/view'


class ReadonlyGateway:
    def __init__(self, feed, publisher, *, broker_port, broker_tls, username, password, fixture_root):
        root = Path(fixture_root).resolve()
        if not (root / '.daty-mqtt-stage2-fixture').is_file():
            raise ValueError('Explicit isolated fixture required')
        if broker_port in (1883, 8883, 8083, 8080, 8802, 8765):
            raise ValueError('Production ports forbidden')
        self.feed, self.publisher = feed, publisher
        self.port, self.tls = broker_port, broker_tls
        self.username, self.password = username, password
        self.server, self.sessions = None, set()

    def check_request(self, connection, request):
        headers = request.headers
        origins = headers.get_all('Origin')
        invalid = (request.path != '/mqtt-readonly' or len(origins) > 1
            or not origin_allowed(origins[0] if origins else None, connection.local_address[0])
            or headers.get('Sec-Fetch-Mode') in ('navigate', 'no-cors')
            or (not origins and headers.get('Sec-Fetch-Site') == 'cross-site'))
        if invalid:
            return connection.respond(403, 'Read-only MQTT origin/path rejected\n')
        if len(self.sessions) >= 32:
            return connection.respond(503, 'Read-only stream limit\n')

    async def start(self, tls_context):
        self.server = await websockets.serve(self.handle, '127.0.0.1', 0,
            ssl=tls_context, subprotocols=['mqtt'], process_request=self.check_request,
            max_size=1024 * 1024 + 5, max_queue=8, write_limit=65536,
            ping_interval=10, ping_timeout=10, close_timeout=1)
        return self.server.sockets[0].getsockname()[1]

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()

    async def handle(self, ws):
        if ws.subprotocol != 'mqtt' or len(self.sessions) >= 32:
            await ws.close(1008, 'MQTT subprotocol/session limit')
            return
        stream = 'view-' + uuid.uuid4().hex
        physical = PREFIX + '/' + stream + '/events'
        self.sessions.add(stream)
        writer, tasks, subscription = None, [], None
        ready = asyncio.Event()
        pending = None
        try:
            frontend = WSReader(ws)
            head, body = await asyncio.wait_for(frontend.read(), 5)
            if head != 0x10:
                raise ValueError('CONNECT first')
            rewritten = connect(body, stream, self.username, self.password)
            reader, writer = await asyncio.wait_for(asyncio.open_connection('127.0.0.1',
                self.port, ssl=self.tls, server_hostname='127.0.0.1'), 5)
            writer.write(packet(0x10, rewritten))
            await writer.drain()
            head, body = await asyncio.wait_for(read_packet(reader), 5)
            if head != 0x20:
                raise ConnectionError('CONNACK required')
            await ws.send(packet(head, connack(body, stream)))

            async def upstream():
                nonlocal pending
                while True:
                    header, body = await frontend.read()
                    if header == 0x82 and pending is None:
                        body, pending = subscribe(body, LOGICAL, physical)
                    elif header == 0xc0 and not body:
                        pass
                    elif header == 0x40 and len(body) in (2, 3, 4) and body[:2] != b'\0\0':
                        pass  # Broker owns QoS1 packet identifier validation.
                    elif header == 0xe0 and body in (b'', b'\0', b'\0\0'):
                        return
                    else:
                        raise PermissionError('Client may only subscribe, acknowledge and ping')
                    writer.write(packet(header, body))
                    await asyncio.wait_for(writer.drain(), 5)

            async def downstream():
                while True:
                    header, body = await read_packet(reader)
                    if header >> 4 == 3:
                        body = publish_topic(header, body, physical, LOGICAL)
                    elif header == 0x90:
                        if not pending or body[:2] != pending or body[2:] not in (b'\0\0', b'\0\x01'):
                            raise ConnectionError('Read-only SUBACK rejected')
                    elif header not in (0xd0, 0xe0):
                        raise ValueError('Unexpected Broker packet')
                    await asyncio.wait_for(ws.send(packet(header, body)), 5)
                    if header == 0x90:
                        ready.set()
                    if header == 0xe0:
                        return

            async def produce():
                nonlocal subscription
                await asyncio.wait_for(ready.wait(), 5)
                subscription = self.feed.subscribe()
                seq = 1
                await self.publisher.publish(physical,
                    envelope(self.feed.boot_id, stream, seq, 'device_list', subscription.snapshot))
                last_sent = time.monotonic()
                while True:
                    try:
                        kind, payload = await asyncio.to_thread(subscription.next, max(.01, 1 - (time.monotonic() - last_sent)))
                    except queue.Empty:
                        kind, payload = 'heartbeat', None
                    if kind not in ('device_list', 'device_update', 'heartbeat'):
                        # A busy command queue must not starve read-only liveness.
                        if time.monotonic() - last_sent < 1:
                            continue
                        kind, payload = 'heartbeat', None
                    seq += 1
                    await self.publisher.publish(physical,
                        envelope(self.feed.boot_id, stream, seq, kind, payload))
                    last_sent = time.monotonic()

            tasks = [asyncio.create_task(fn()) for fn in (upstream, downstream, produce)]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (ValueError, PermissionError, EOFError):
            await ws.close(1008, 'Read-only MQTT policy rejected')
        except (ConnectionClosed, ConnectionError, OSError, asyncio.TimeoutError):
            await ws.close(1013, 'Read-only stream unavailable; fresh snapshot required')
        except Exception:
            await ws.close(1013, 'Read-only source failed; fresh snapshot required')
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if subscription:
                subscription.close()
            if writer:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass
            self.sessions.discard(stream)
