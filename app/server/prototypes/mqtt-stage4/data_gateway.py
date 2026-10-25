"""M4 bounded data gateway, adapted from the verified M3 transport.

Uses stage 2's bounded MQTT5 framing and exact Origin rules. No browser secret,
client-selected response topic, receiver topic publication or HTTP fallback.
"""
import asyncio
import json
from pathlib import Path
import queue
import uuid

import websockets
from websockets.exceptions import ConnectionClosed
from websockets.protocol import State
from http_transport import origin_allowed
from mqtt_wire import WSReader, packet, connect, connack, subscribe, publish_topic, read_packet, utf, string, number
from receiver_gateway import strict_json
from data_contract import SERVER, SCHEMA, validate_request, DataError, MAX_BYTES

PREFIX = 'daty/prototype/v2/stage4-server/rpc'
REQUEST = 'daty/v2/stage4-server/data/request'
REPLY = 'daty/v2/stage4-server/data/reply'


class RpcGateway:
    def __init__(self, service, business, *, broker_port, broker_tls, username, password, fixture_root):
        base = Path(fixture_root).resolve()
        if not (base / '.daty-mqtt-stage4-fixture').is_file() or broker_port in (1883,8883,8080,8083,8765,8802):
            raise ValueError('Isolated RPC gateway required')
        self.service, self.business = service, business
        self.port, self.tls, self.user, self.password = broker_port, broker_tls, username, password
        self.sessions, self.jobs = {}, set()
        self.server, self.consumer = None, None

    def check_request(self, connection, request):
        origins = request.headers.get_all('Origin')
        if (request.path != '/mqtt-data' or len(origins) > 1
                or not origin_allowed(origins[0] if origins else None, connection.local_address[0])
                or request.headers.get('Sec-Fetch-Mode') in ('navigate','no-cors')
                or (not origins and request.headers.get('Sec-Fetch-Site') == 'cross-site')):
            return connection.respond(403, 'Invalid data source\n')
        if len(self.sessions) >= 32:
            return connection.respond(503, 'Connection limit\n')

    async def start(self, tls):
        result = await asyncio.to_thread(self.business.subscribe, PREFIX + '/+/request')
        if result != [1]:
            raise ConnectionError('Business subscription rejected')
        self.consumer = asyncio.create_task(self.consume())
        self.server = await websockets.serve(self.handle, '127.0.0.1', 0, ssl=tls,
            subprotocols=['mqtt'], process_request=self.check_request, max_size=1048581,
            max_queue=8, close_timeout=1, ping_interval=10, ping_timeout=10)
        return self.server.sockets[0].getsockname()[1]

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        if self.consumer:
            self.consumer.cancel()
            await asyncio.gather(self.consumer, return_exceptions=True)
        # Let already accepted requests finish to a durable known/unknown state.
        await asyncio.gather(*self.jobs, return_exceptions=True)
    def response(self, sid, **body):
        return {'schema': SCHEMA, 'server_id': SERVER, 'boot_id': self.service.boot_id,
                'client_session_id': sid, **body}

    async def reply(self, sid, **body):
        if sid in self.sessions:
            await self.business.publish(PREFIX + '/' + sid + '/reply', self.response(sid, **body))

    async def consume(self):
        while True:
            try:
                topic, raw = await asyncio.to_thread(self.business.receive, .2)
            except queue.Empty:
                if not self.business.client.is_connected():
                    self.service.accepting = False
                    for ws in tuple(self.sessions.values()):
                        await ws.close(1013, 'Broker unavailable; query outcome after reconnect')
                    return
                continue
            if len(self.jobs) >= 32:
                # Do not authorize a request that could not enter the bounded worker.
                continue
            task = asyncio.create_task(self.consume_one(topic, raw))
            self.jobs.add(task)
            task.add_done_callback(self.job_done)

    def job_done(self, task):
        self.jobs.discard(task)
        if not task.cancelled() and task.exception() is not None:
            self.service.accepting = False

    async def consume_one(self, topic, raw):
        sid, request = None, None
        try:
            wrapped = strict_json(raw)
            sid, request = wrapped['client_session_id'], wrapped['request']
            ws = self.sessions.get(sid)
            if (not self.current(sid, ws) or topic != PREFIX + '/' + sid + '/request'
                    or wrapped['gateway_boot'] != self.service.boot_id
                    or wrapped['peer_ip'] != ws.remote_address[0]
                    or request['client_session_id'] != sid):
                return
            validate_request(request)
            result = await self.service.request(request, entry='mqtt', current=lambda: self.current(sid, ws), peer_ip=ws.remote_address[0])
            await self.reply(sid, kind='reply', request_id=request['request_id'], method=request['method'], ok=True, result=result)
        except DataError as error:
            if sid and request:
                await self.reply(sid, kind='reply', request_id=request.get('request_id'),
                    method=request.get('method'), ok=False, error=error.code, status=error.status)
        except Exception:
            if sid and request:
                await self.reply(sid, kind='reply', request_id=request.get('request_id'),
                    method=request.get('method'), ok=False, error='OUTCOME_UNKNOWN_QUERY_ONLY')

    def current(self, sid, ws):
        return bool(ws and self.sessions.get(sid) is ws and ws.state is State.OPEN
                    and self.business.client.is_connected())

    async def handle(self, ws):
        if ws.subprotocol != 'mqtt' or len(self.sessions) >= 32:
            await ws.close(1008, 'MQTT required')
            return
        sid = 'dat-' + uuid.uuid4().hex
        physical_reply, physical_request = PREFIX + '/' + sid + '/reply', PREFIX + '/' + sid + '/request'
        reader, writer, tasks = None, None, []
        subscribed, ready = None, asyncio.Event()
        try:
            front = WSReader(ws)
            header, body = await asyncio.wait_for(front.read(), 5)
            if header != 0x10:
                raise ValueError('CONNECT required')
            rewritten = connect(body, sid, self.user, self.password)
            reader, writer = await asyncio.wait_for(asyncio.open_connection('127.0.0.1', self.port,
                ssl=self.tls, server_hostname='127.0.0.1'), 5)
            writer.write(packet(0x10, rewritten))
            await writer.drain()
            header, body = await asyncio.wait_for(read_packet(reader), 5)
            if header != 0x20:
                raise ConnectionError('No CONNACK')
            self.sessions[sid] = ws
            await ws.send(packet(header, connack(body, sid)))

            async def upstream():
                nonlocal subscribed
                while True:
                    header, body = await front.read()
                    if header == 0x82 and subscribed is None:
                        body, subscribed = subscribe(body, REPLY, physical_reply)
                    elif header in (0x32, 0x3a) and ready.is_set():
                        topic, pos = string(body)
                        if topic != REQUEST or len(body) > MAX_BYTES + 256:
                            raise PermissionError('Only bounded data RPC requests allowed')
                        pid = body[pos:pos + 2]
                        if len(pid) != 2 or pid == b'\0\0':
                            raise ValueError('Invalid packet id')
                        size, pos = number(body, pos + 2)
                        if size:
                            raise PermissionError('Client publish properties forbidden')
                        request = strict_json(body[pos:])
                        validate_request(request)
                        if request['client_session_id'] != sid:
                            raise PermissionError('Forged connection identity')
                        wrapped = {'gateway_boot': self.service.boot_id, 'client_session_id': sid,
                                   'peer_ip': ws.remote_address[0], 'request': request}
                        # Private broker request expires; expiry is still checked
                        # against wall AND monotonic clocks immediately before send.
                        props = b'\x02\x00\x00\x00\x05'
                        body = utf(physical_request) + pid + bytes([len(props)]) + props + json.dumps(wrapped, ensure_ascii=False, allow_nan=False).encode()
                    elif header == 0x40 and len(body) in (2,3,4):
                        pass
                    elif header == 0xc0 and not body:
                        pass
                    elif header == 0xe0 and body in (b'', b'\0', b'\0\0'):
                        return
                    else:
                        raise PermissionError('Packet outside data RPC contract')
                    writer.write(packet(header, body))
                    await asyncio.wait_for(writer.drain(), 5)

            async def downstream():
                while True:
                    header, body = await read_packet(reader)
                    if header >> 4 == 3:
                        body = publish_topic(header, body, physical_reply, REPLY)
                    elif header == 0x90:
                        if not subscribed or body[:2] != subscribed or body[2:] not in (b'\0\0', b'\0\x01'):
                            raise ConnectionError('SUBACK refused')
                    elif header not in (0x40, 0xd0, 0xe0):
                        raise ValueError('Unexpected Broker packet')
                    await asyncio.wait_for(ws.send(packet(header, body)), 5)
                    if header == 0x90:
                        ready.set()
                        await self.reply(sid, kind='hello', active_entry='mqtt',
                                         server_time_ms=self.service.wall_ms())
                    if header == 0xe0:
                        return

            tasks = [asyncio.create_task(fn()) for fn in (upstream, downstream)]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (ValueError, PermissionError, DataError, EOFError):
            await ws.close(1008, 'Data RPC policy rejected')
        except (ConnectionClosed, ConnectionError, OSError, asyncio.TimeoutError):
            await ws.close(1013, 'Data transport interrupted; never replay')
        except Exception:
            await ws.close(1013, 'Data transport failed; query outcome')
        finally:
            self.sessions.pop(sid, None)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if writer:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass
