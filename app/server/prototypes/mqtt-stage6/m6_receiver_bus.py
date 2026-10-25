"""Private MQTT bus attached to the SAME original authenticated receiver registry.

The existing socket parser, pairing, dispatch queue, telemetry normalization and
precise clock receive timestamp remain authoritative. Revalidation occurs again
after private Broker delivery. There is one bounded, nonreplayed control outlet.
"""
import asyncio
from collections import deque
import copy
import json
from pathlib import Path
import queue
import threading
import time

from bridge_adapter import BridgeAdapter
from command_journal import CommandError
from receiver_gateway import strict_json, check_sensitive
from m6_pairing_scope import PacketRegistry

UP = 'daty/private/v2/daty-rf-pro/receivers/up'
DOWN = 'daty/private/v2/daty-rf-pro/receivers/down'

class ReceiverBus(BridgeAdapter):
    def __init__(self,bridge,ingress,business,*,fixture_root=None,runtime_scope=None,boot_id):
        if runtime_scope is None:
            root=Path(fixture_root).resolve()
            if not (root/'.daty-mqtt-stage6-fixture').is_file():
                raise ValueError('Explicit isolated M6 receiver bus required')
        super().__init__(bridge,fixture_root=fixture_root,runtime_scope=runtime_scope)
        self.registry_view=PacketRegistry(bridge._pairing_policy)
        self.ingress,self.business,self.boot_id=ingress,business,boot_id
        self.attempts=deque(maxlen=256)
        self.pending_sends={}
        self.sequence_lock=threading.Lock()
        self.sequences,self.received={},{}
        self.original_queued=bridge._process_queued_mqtt_message
        self.original_batch=bridge._process_mqtt_batch
        bridge._process_mqtt_batch=self.enqueue_batch
        self.tasks=[]
        self.stop_worker=threading.Event()
        self.flow=threading.Condition()
        self.inflight_batches=set();self.batch_sequence=0
        self.metrics={'published':0,'publications':0,'consumed':0,'consumed_channel_observations':0,'stale':0,'duplicates':0,'failures':0,'outlet_sends':0,
            'processing_cpu_ms':0,'processing_wall_ms':0,'persistence_wait_ms':0}

    async def start(self):
        if await asyncio.to_thread(self.business.subscribe,UP)!=[1]:
            raise ConnectionError('Receiver telemetry subscription rejected')
        if await asyncio.to_thread(self.ingress.subscribe,DOWN)!=[1]:
            raise ConnectionError('Receiver outlet subscription rejected')
        self.tasks=[asyncio.create_task(self.consume_up()),asyncio.create_task(self.consume_down())]

    def envelope(self,topic,payload,client_id,connection_token):
        with self.b._broker_lock:
            session=self.b._broker_clients.get(client_id)
            if not session or session.get('connection_token')!=connection_token:
                self.metrics['stale']+=1;return
            principal=session.get('pairing')
        # Original socket parser already validated and stamped this private
        # object. Final consumption still invokes original_queued, which checks
        # fresh credentials and every payload field again after Broker delivery.
        check_sensitive(payload)
        with self.sequence_lock:
            sequence=self.sequences.get(connection_token,0)+1
            self.sequences[connection_token]=sequence
        return {'boot_id':self.boot_id,'client_id':client_id,'session':connection_token,
            'sequence':sequence,'topic':topic,'peer_ip':principal['_peer_ip'],
            'receiver_id':principal['receiver_id'],'receiver_mac':principal['receiver_mac'],'payload':payload}

    def enqueue_batch(self,items):
        # Preserve the original FIFO microbatch; no delay to accumulate samples,
        # coalescing, downsampling or waiting for one PUBACK per individual CH.
        batch=[];size=0
        for item in items:
            if item is None:
                if batch:self.publish_batch(batch);batch=[];size=0
                # Clock refresh must not overtake previously queued telemetry.
                with self.flow:
                    while self.inflight_batches and not self.stop_worker.is_set():self.flow.wait(.05)
                self.original_batch([None]);continue
            event=self.envelope(*item[:4])
            if event is None:continue
            length=len(json.dumps(event,ensure_ascii=False,allow_nan=False).encode())
            if batch and size+length>800*1024:self.publish_batch(batch);batch=[];size=0
            batch.append(event);size+=length
        if batch:self.publish_batch(batch)

    def publish_batch(self,batch):
        try:
            with self.flow:
                while len(self.inflight_batches)>=4 and not self.stop_worker.is_set():self.flow.wait(.05)
                if self.stop_worker.is_set():raise ConnectionError('Receiver bus stopped')
                self.batch_sequence+=1;bid=self.batch_sequence;self.inflight_batches.add(bid)
            code=self.ingress.publish_sync(UP,{'boot_id':self.boot_id,'batch_id':bid,'batch':batch})
            if code>=128:raise ConnectionError('Receiver publication denied')
            self.metrics['published']+=len(batch);self.metrics['publications']+=1
        except Exception:
            self.metrics['failures']+=1
            asyncio.run_coroutine_threadsafe(self.fail_closed(),self.loop)
            raise

    def deliver_batch(self,wrapped):
        if wrapped.get('boot_id')!=self.boot_id:return
        batch=wrapped.get('batch')
        if not isinstance(batch,list) or not 1<=len(batch)<=64:raise CommandError('INVALID_RECEIVER_BATCH')
        for event in batch:self.deliver(event)
        # Prune at batch boundaries instead of rebuilding both maps per CH.
        with self.b._broker_lock:
            current={s['connection_token'] for s in self.b._broker_clients.values()}
        with self.sequence_lock:
            self.sequences={k:v for k,v in self.sequences.items() if k in current}
        self.received={k:v for k,v in self.received.items() if k in current}

    def deliver(self,event):
        if event.get('boot_id')!=self.boot_id:return
        client_id,token=event.get('client_id'),event.get('session')
        with self.b._broker_lock:
            session=self.b._broker_clients.get(client_id)
            if not session or session.get('connection_token')!=token:
                self.metrics['stale']+=1;return
            principal=session.get('pairing')
            if any(event.get(k)!=principal[p] for k,p in
                    (('peer_ip','_peer_ip'),('receiver_id','receiver_id'),('receiver_mac','receiver_mac'))):
                raise CommandError('BROKER_ENVELOPE_IDENTITY_MISMATCH')
        seq=event.get('sequence')
        if type(seq) is not int or seq<1:raise CommandError('INVALID_RECEIVER_SEQUENCE')
        previous=self.received.get(token,0)
        if seq<=previous:
            self.metrics['duplicates']+=1;return
        if seq!=previous+1:
            raise CommandError('RECEIVER_STREAM_GAP')
        with self.registry_view.packet():
            self.original_queued(event['topic'],event['payload'],client_id,token)
        self.received[token]=seq
        self.metrics['consumed']+=1
        body=event['payload']
        if event['topic'] in (self.b.MQTT_TOPIC_UP,self.b.MQTT_TOPIC_REGISTER):
            self.metrics['consumed_channel_observations']+=len(body['devices']) if isinstance(body.get('devices'),list) else 1

    def wait_persistence(self):
        began=time.monotonic()
        waited=False
        while not self.stop_worker.is_set():
            state=self.b.get_unified_runtime_status()
            from m6_process_runtime import persistence_ready
            if not persistence_ready(state):
                raise ConnectionError('Persistence unavailable')
            if state.get('queue_count',0)<state.get('queue_capacity',256)//2 and state.get('queue_bytes',0)<state.get('max_queue_bytes',16777216)//2:
                if waited:self.registry_view.refresh()
                self.metrics['persistence_wait_ms']+=(time.monotonic()-began)*1000;return
            waited=True
            self.stop_worker.wait(.002)
        raise ConnectionError('Receiver bus stopped')

    def process(self,topic,payload,client_id=None,connection_token=None):
        # Original typed-delta batches recurse through this same per-channel
        # path. Backpressure each observation, not merely each network packet.
        self.wait_persistence()
        # A long typed batch can wait for disk between children. Re-check the
        # exact live connection and credential after that wait as well.
        with self.b._broker_lock:
            session=self.b._broker_clients.get(client_id)
            if not session or session.get('connection_token')!=connection_token:return
            if not self.b._pairing_policy.is_active(session.get('pairing')):return
            # The built-in MQTT path belongs to DATYaudio; other brands require their imported driver.
            if self.b._normalize_device_brand(session['pairing'].get('brand'))!='DATYaudio':return
        return super().process(topic,payload,client_id,connection_token)
    async def consume_up(self):
        # A dedicated worker drains bounded Broker delivery. Scheduling each
        # microbatch through the busy socket event loop delays consumption even
        # when a worker and the database are ready to process it.
        await asyncio.to_thread(self.consume_up_sync)

    def consume_up_sync(self):
        self.consumer_thread=threading.get_ident()
        while not self.stop_worker.is_set():
            try:
                topic,raw=self.business.receive(.2)
            except queue.Empty:
                if not self.business.client.is_connected():
                    asyncio.run_coroutine_threadsafe(self.fail_closed(),self.loop);return
                continue
            try:
                if topic!=UP:raise CommandError('INVALID_RECEIVER_TOPIC')
                # Backpressure belongs immediately before actual consumption;
                # ingress may already have forwarded a few bounded batches.
                self.wait_persistence()
                wrapped=strict_json(raw)
                cpu,wall=time.thread_time(),time.monotonic()
                self.deliver_batch(wrapped)
                self.metrics['processing_cpu_ms']+=(time.thread_time()-cpu)*1000
                self.metrics['processing_wall_ms']+=(time.monotonic()-wall)*1000
                with self.flow:
                    self.inflight_batches.discard(wrapped.get('batch_id'));self.flow.notify_all()
            except Exception:
                self.metrics['failures']+=1
                asyncio.run_coroutine_threadsafe(self.fail_closed(),self.loop);return

    async def send(self,record,*,allowed):
        if self.stop_worker.is_set():raise CommandError('TRANSPORT_UNAVAILABLE')
        if len(self.pending_sends)>=32:raise CommandError('CONTROL_OUTLET_BUSY')
        if not allowed():raise CommandError('DISPATCH_CANCELLED_OR_EXPIRED')
        self.validate(record['target'],record['command'])
        command_id=record['command_id']
        if command_id in self.pending_sends:raise CommandError('DUPLICATE_OUTLET')
        done=asyncio.get_running_loop().create_future()
        intent=copy.deepcopy(record)
        self.pending_sends[command_id]=(intent,allowed,done)
        try:
            await self.business.publish(DOWN,{'boot_id':self.boot_id,'command_id':command_id,'record':intent})
            await asyncio.wait_for(asyncio.shield(done),2)
        finally:
            self.pending_sends.pop(command_id,None)
            if not done.done():done.cancel()
            elif not done.cancelled():done.exception()

    async def consume_down(self):
        while not self.stop_worker.is_set():
            try:
                topic,raw=await asyncio.to_thread(self.ingress.receive,.2)
            except queue.Empty:
                if not self.ingress.client.is_connected():
                    await self.fail_closed();return
                continue
            event=strict_json(raw)
            if topic!=DOWN or event.get('boot_id')!=self.boot_id:continue
            # Pop BEFORE awaiting. Duplicate delivery cannot enter the socket.
            pending=self.pending_sends.pop(event.get('command_id'),None)
            if not pending:continue
            record,allowed,done=pending
            try:
                if event.get('record')!=record:raise CommandError('OUTLET_INTENT_CHANGED')
                if done.done() or not allowed():raise CommandError('DISPATCH_CANCELLED_OR_EXPIRED')
                await super().send(record,allowed=lambda:not done.done() and allowed())
                self.metrics['outlet_sends']+=1
                if not done.done():done.set_result(True)
            except Exception as error:
                if not done.done():done.set_exception(error)

    async def fail_closed(self):
        self.stop_worker.set()
        with self.flow:self.flow.notify_all()
        with self.b._broker_lock:
            sockets=[s['ws'] for s in self.b._broker_clients.values()]
        await asyncio.gather(*(ws.close(1013,'MQTT bus unavailable; reconnect required') for ws in sockets),return_exceptions=True)

    async def pause_transport(self):
        self.stop_worker.set()
        with self.flow:self.flow.notify_all()
        for _,_,done in tuple(self.pending_sends.values()):
            if not done.done():done.set_exception(ConnectionError('TRANSPORT_LOST_QUERY_ONLY'))
        await asyncio.gather(*self.tasks,return_exceptions=True)
        self.tasks=[]
        self.pending_sends.clear()

    async def resume_transport(self):
        if self.tasks:raise RuntimeError('OLD_TRANSPORT_WORKERS_STILL_RUNNING')
        self.sequences.clear();self.received.clear();self.inflight_batches.clear()
        self.stop_worker.clear()
        await self.start()

    async def close(self):
        self.b._process_mqtt_batch=self.original_batch
        self.stop_worker.set()
        with self.flow:self.flow.notify_all()
        if self.tasks:
            await self.tasks[0]
        for task in self.tasks:task.cancel()
        await asyncio.gather(*self.tasks,return_exceptions=True)
        for _,_,done in self.pending_sends.values():
            if not done.done():done.cancel()
        self.pending_sends.clear()
        await super().close()
        self.registry_view.close()
