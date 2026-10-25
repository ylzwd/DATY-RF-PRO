"""Isolated MQTT5/WSS read-only gateway. Not loaded by production services."""
import asyncio
import json
import hashlib
from pathlib import Path
import queue
import time
import uuid

import websockets
from websockets.exceptions import ConnectionClosed
from http_transport import origin_allowed
from m6_readonly_encoding import encode_event, batch_payload, wire_envelope, MAX_EVENTS, MAX_BATCH_BYTES
from mqtt_wire import (WSReader, connect, connack, packet, read_packet,
                       subscribe, publish_topic, string)

LOGICAL = 'daty/v2/daty-rf-pro/devices/read'
PREFIX = 'daty/private/v2/daty-rf-pro/view'


class ReadonlyGateway:
    def __init__(self, feed, publisher, *, broker_port, broker_tls, username, password, fixture_root=None, runtime_scope=None):
        if runtime_scope is not None:
            from m6_scope import checked_scope
            checked_scope(runtime_scope)
        else:
            root = Path(fixture_root).resolve()
            if not (root / '.daty-mqtt-stage6-fixture').is_file():
                raise ValueError('Explicit isolated fixture required')
        if broker_port in (1883, 8883, 8083, 8080, 8802, 8765):
            raise ValueError('Production ports forbidden')
        self.feed, self.publisher = feed, publisher
        self.port, self.tls = broker_port, broker_tls
        self.username, self.password = username, password
        self.server, self.sessions = None, set()
        self.fixture_origins=set()
        # Additional exact origin from a validated bound runtime, never from requests.
        self.runtime_origins={f'https://{runtime_scope.bind_host}:{runtime_scope.web_port}'} if runtime_scope is not None and runtime_scope.bind_host!='0.0.0.0' else set()
        self.metrics={'connections':0,'publications':0,'events':0,'queue_peak':0,'failures':[],'client_acks':0,
            'broker_publish_ms':0,'client_ack_wait_ms':0,'max_broker_publish_ms':0,'max_client_ack_wait_ms':0,
            'encode_cpu_ms':0,'encode_wall_ms':0,'max_encode_wall_ms':0,'wire_bytes':0,
            'events_per_batch_max':0,'queue_wait_ms':0}
        self.verification=[]

    def check_request(self, connection, request):
        headers = request.headers
        origins = headers.get_all('Origin')
        invalid = (request.path != '/mqtt-readonly' or len(origins) > 1
            or not (origin_allowed(origins[0] if origins else None, connection.local_address[0]) or bool(origins and origins[0] in (self.fixture_origins | self.runtime_origins)))
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
        self.metrics['connections']+=1
        writer, tasks, subscription = None, [], None
        ready = asyncio.Event()
        delivered = asyncio.Event()
        delivery_mid = None
        wire_hash=hashlib.sha256()
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
                nonlocal pending,delivery_mid
                while True:
                    header, body = await frontend.read()
                    if header == 0x82 and pending is None:
                        if body[-1:]!=b'\x01':raise PermissionError('QoS1 delivery acknowledgement required')
                        body, pending = subscribe(body, LOGICAL, physical)
                    elif header == 0xc0 and not body:
                        pass
                    elif header == 0x40 and len(body) in (2, 3, 4) and body[:2] != b'\0\0':
                        if body[:2]!=delivery_mid or (len(body)>2 and body[2]>=128):
                            raise PermissionError('Unexpected or rejected delivery acknowledgement')
                        delivery_mid=None
                        self.metrics['client_acks']+=1
                        delivered.set()
                    elif header == 0xe0 and body in (b'', b'\0', b'\0\0'):
                        return
                    else:
                        raise PermissionError('Client may only subscribe, acknowledge and ping')
                    writer.write(packet(header, body))
                    await asyncio.wait_for(writer.drain(), 5)

            async def downstream():
                nonlocal delivery_mid
                while True:
                    header, body = await read_packet(reader)
                    if header >> 4 == 3:
                        if (header>>1)&3!=1:raise ValueError('QoS1 publication required')
                        _,offset=string(body)
                        mid=body[offset:offset+2]
                        if len(mid)!=2 or mid==b'\0\0' or (delivery_mid is not None and delivery_mid!=mid):
                            raise ValueError('Only one publication may await client delivery')
                        delivery_mid=mid
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
                async def publish(kind,payload):
                    delivered.clear()
                    raw=wire_envelope(self.feed.boot_id,stream,seq,kind,payload)
                    self.metrics['wire_bytes']+=len(raw)
                    wire_hash.update(raw)
                    self.verification.append({'stream':stream,'seq':seq,'sha256':wire_hash.hexdigest()})
                    del self.verification[:-128]
                    sent=time.monotonic()
                    await self.publisher.publish(physical,raw)
                    accepted=time.monotonic()
                    publish_ms=(accepted-sent)*1000
                    self.metrics['broker_publish_ms']+=publish_ms
                    self.metrics['max_broker_publish_ms']=max(self.metrics['max_broker_publish_ms'],publish_ms)
                    # Publisher PUBACK only means Broker acceptance. Bound this
                    # stream by the browser's own QoS1 ACK, after its handlers
                    # consumed this envelope. A slow page cannot overflow the
                    # Broker's queue silently or block receiver persistence.
                    await asyncio.wait_for(delivered.wait(),5)
                    ack_ms=(time.monotonic()-accepted)*1000
                    self.metrics['client_ack_wait_ms']+=ack_ms
                    self.metrics['max_client_ack_wait_ms']=max(self.metrics['max_client_ack_wait_ms'],ack_ms)
                await publish('device_list',json.dumps(subscription.snapshot,ensure_ascii=False,allow_nan=False).encode())
                last_sent = time.monotonic()
                pending_event=None
                while True:
                    self.metrics['queue_peak']=max(self.metrics['queue_peak'],subscription.queue.qsize())
                    waited=time.monotonic()
                    try:
                        if pending_event:
                            raw=pending_event;pending_event=None
                        else:
                            # Consume ready work directly. Only an empty queue
                            # needs a blocking worker; a busy stream must not
                            # schedule one executor hop per envelope.
                            try:raw=subscription.next_raw(timeout=0)
                            except queue.Empty:
                                raw=await asyncio.to_thread(subscription.next_raw,max(.01,1-(time.monotonic()-last_sent)))
                    except queue.Empty:
                        raw=None
                    self.metrics['queue_wait_ms']+=(time.monotonic()-waited)*1000
                    began,cpu=time.monotonic(),time.thread_time()
                    event=encode_event(raw) if raw is not None else None
                    if event is None and raw is not None and time.monotonic()-last_sent<1:continue
                    events=[] if event is None else [event]
                    size=len(batch_payload(events))
                    if events:
                        while len(events)<MAX_EVENTS:
                            try:next_raw=subscription.next_raw(timeout=0)
                            except queue.Empty:break
                            next_event=encode_event(next_raw)
                            if next_event is None:continue
                            extra=len(next_event)+2
                            if size+extra>MAX_BATCH_BYTES:
                                pending_event=next_raw;break
                            events.append(next_event);size+=extra
                    kind,payload=('event_batch',batch_payload(events)) if events else ('heartbeat',b'null')
                    elapsed=(time.monotonic()-began)*1000
                    self.metrics['encode_cpu_ms']+=(time.thread_time()-cpu)*1000
                    self.metrics['encode_wall_ms']+=elapsed
                    self.metrics['max_encode_wall_ms']=max(self.metrics['max_encode_wall_ms'],elapsed)
                    self.metrics['events_per_batch_max']=max(self.metrics['events_per_batch_max'],len(events))
                    seq += 1
                    await publish(kind,payload)
                    self.metrics['publications']+=1
                    self.metrics['events']+=len(events) if events else 1
                    last_sent = time.monotonic()

            tasks = [asyncio.create_task(fn()) for fn in (upstream, downstream, produce)]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (ValueError, PermissionError, EOFError) as error:
            self.record_failure(error)
            await ws.close(1008, 'Read-only MQTT policy rejected')
        except (ConnectionClosed, ConnectionError, OSError, asyncio.TimeoutError) as error:
            self.record_failure(error)
            await ws.close(1013, 'Read-only stream unavailable; fresh snapshot required')
        except Exception as error:
            self.record_failure(error)
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

    def record_failure(self,error):
        self.metrics['failures'].append({'type':type(error).__name__,'reason':str(error)[:200]})
        del self.metrics['failures'][:-32]
