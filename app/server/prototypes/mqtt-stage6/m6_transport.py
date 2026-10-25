"""Recover private transport with fresh clean sessions, never reconnect a publisher.

Paho clients deliberately remain non-reconnecting: reconnecting the same client
could replay its in-flight QoS1 control publications. Recovery replaces clients
only after invalidating public sessions and draining old workers. Database,
pairing, plugins, GROUP allocation and the sole command journal stay alive.
"""
import asyncio
import time

from m6_contract import prefix
from m6_process_runtime import persistence_ready


class TransportSupervisor:
    def __init__(self, runtime):
        self.r = runtime
        self.ready = True
        self.stop = asyncio.Event()
        self.task = None
        self.state = 'ready'
        self.generation = 1
        self.recoveries = self.attempts = 0
        self.reason = self.last_error = None
        self.changed_at_ms = int(time.time()*1000)
        self.history = []

    def storage_issue(self):
        r = self.r
        if r.repo.poisoned or r.journal.poisoned or not r.commands.accepting:
            return 'DURABLE_SERVICE_UNAVAILABLE'
        if r.commands.timer.done():
            return 'COMMAND_EXPIRY_STOPPED'
        p = r.b.get_unified_runtime_status()
        if not persistence_ready(p):
            return 'PERSISTENCE_UNAVAILABLE'

    def issue(self):
        r = self.r
        if r.process.poll() is not None:return 'PRIVATE_BROKER_EXITED'
        if any(not c.client.is_connected() for c in r.clients):return 'PRIVATE_CLIENT_DISCONNECTED'
        for path in ('/mqtt-app','/mqtt-enrollment'):
            g = r.gateways[path]
            if g.consumer.done() or not g.service.accepting:return 'RPC_CONSUMER_STOPPED:'+g.mode
        if r.bus.stop_worker.is_set() or any(t.done() for t in r.bus.tasks):return 'RECEIVER_BUS_STOPPED'
        task = r.b._mqtt_dispatch_task
        if task is not None and task.done():return 'RECEIVER_DISPATCH_STOPPED'
        return self.storage_issue()

    def snapshot(self):
        issue = self.issue() if self.ready else self.reason
        return {'state':self.state if not self.ready else ('degraded' if issue else 'ready'),
            'ready':self.ready and issue is None,'generation':self.generation,
            'recoveries':self.recoveries,'attempts':self.attempts,'reason':issue,
            'last_error':self.last_error,'changed_at_ms':self.changed_at_ms,
            'clients_connected':sum(c.client.is_connected() for c in self.r.clients),
            'history':list(self.history)}

    async def quarantine(self, reason):
        r = self.r
        self.ready = False;self.state = 'recovering';self.reason = reason
        self.generation += 1;self.changed_at_ms = int(time.time()*1000)
        self.history.append({'at_ms':self.changed_at_ms,'reason':reason,'generation':self.generation})
        self.history[-1]['clients'] = [{'role':getattr(c,'role','private'),
            'connected':c.client.is_connected(),'disconnect':c.disconnect_reason,
            'queue_overflows':c.queue_overflows,'queued':c.messages.qsize()} for c in r.clients]
        del self.history[:-16]
        # Invalidate authority before any await; old jobs cannot become current
        # again when fresh clients are assigned or a new socket uses the same IP.
        for path in ('/mqtt-app','/mqtt-enrollment'):
            g = r.gateways[path];g.service.accepting = False
        r.bus.stop_worker.set()
        with r.bus.flow:r.bus.flow.notify_all()
        await asyncio.gather(*(ws.close(1013,'Transport recovery; fresh session required; never replay')
            for ws in tuple(r.server.connections)),return_exceptions=True)
        await asyncio.gather(*tuple(r.connection_tasks),return_exceptions=True)
        for path in ('/mqtt-app','/mqtt-enrollment'):
            g = r.gateways[path]
            g.sessions.clear()
            g.consumer.cancel()
            await asyncio.gather(g.consumer,return_exceptions=True)
        await r.bus.pause_transport()
        # Do not cancel a to_thread consumer then clear its stop flag while the
        # underlying worker can still write. Let its current bounded batch exit.
        task,queue = r.b._mqtt_dispatch_task,r.b._mqtt_dispatch_queue
        if task is not None:
            if not task.done():
                drained = asyncio.create_task(queue.join())
                await asyncio.wait((task,drained),return_when=asyncio.FIRST_COMPLETED)
                drained.cancel();await asyncio.gather(drained,return_exceptions=True)
                task.cancel()
            await asyncio.gather(task,return_exceptions=True)
        r.b._mqtt_dispatch_task = None;r.b._mqtt_dispatch_queue = None
        # Accepted transactions finish known/unknown in the existing journal.
        # Loss of a reply never retries the underlying operation.
        for path in ('/mqtt-app','/mqtt-enrollment'):
            await asyncio.gather(*tuple(r.gateways[path].jobs),return_exceptions=True)
        await self.close_clients()

    async def close_clients(self):
        clients,self.r.clients = self.r.clients,[]
        await asyncio.gather(*(asyncio.to_thread(c.close) for c in clients))

    async def rebuild(self):
        r = self.r
        if self.storage_issue():raise RuntimeError(self.storage_issue())
        if r.process.poll() is not None:await r.start_private_broker()
        users=('rx-ingress','rx-business','app-business','enrollment-business','view-publisher')
        results = await asyncio.gather(*(r.client(u) for u in users),return_exceptions=True)
        error = next((v for v in results if isinstance(v,BaseException)),None)
        if error is not None:raise error
        clients = dict(zip(users,results))
        r.bus.ingress,r.bus.business = clients['rx-ingress'],clients['rx-business']
        r.view.publisher = clients['view-publisher']
        for mode in ('app','enrollment'):
            g = r.gateways['/mqtt-'+mode];g.business = clients[mode+'-business']
            if await asyncio.to_thread(g.business.subscribe,prefix(mode)+'/+/request') != [1]:
                raise ConnectionError('RPC_RESUBSCRIBE_FAILED')
        await r.bus.resume_transport()
        # Only fresh receiver sessions can populate this newly empty FIFO.
        r.b._get_mqtt_dispatch_queue()
        for mode in ('app','enrollment'):
            g = r.gateways['/mqtt-'+mode]
            g.service.accepting = True;g.consumer = asyncio.create_task(g.consume())
        if any(not c.client.is_connected() for c in r.clients):raise ConnectionError('RECOVERY_CONNECTION_LOST')

    async def run(self):
        try:
            while not self.stop.is_set():
                reason = self.issue()
                if reason:
                    await self.quarantine(reason)
                    delay = .25
                    while not self.stop.is_set():
                        self.attempts += 1
                        try:
                            await self.rebuild()
                            if self.stop.is_set():break
                            self.ready = True;self.state = 'ready';self.reason = None
                            self.recoveries += 1;self.changed_at_ms = int(time.time()*1000)
                            break
                        except Exception as error:
                            self.last_error = type(error).__name__
                            self.state = 'blocked' if self.storage_issue() else 'recovering'
                            # Failed attempts have no public sessions or commands.
                            await self.r.bus.pause_transport()
                            for mode in ('app','enrollment'):
                                g=self.r.gateways['/mqtt-'+mode];g.service.accepting=False
                                g.consumer.cancel();await asyncio.gather(g.consumer,return_exceptions=True)
                            await self.close_clients()
                            try:await asyncio.wait_for(self.stop.wait(),delay)
                            except asyncio.TimeoutError:pass
                            delay = min(delay*2,5)
                try:await asyncio.wait_for(self.stop.wait(),.2)
                except asyncio.TimeoutError:pass
        finally:self.ready = False

    async def close(self):
        self.ready = False;self.stop.set()
        # Do not abandon a thread creating a client or committing a transaction.
        if self.task:
            try:await self.task
            except Exception as error:self.last_error=type(error).__name__
