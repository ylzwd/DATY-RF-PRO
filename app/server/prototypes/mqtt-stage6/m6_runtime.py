"""One integrated engine with isolated preparation or explicit leased resources.

One WSS listener multiplexes receiver/app/enrollment/device streams. All use one
Bridge instance, one current pairing registry, one private TLS Broker and one
business database. Old HTTP/SSE handlers are never bound by this candidate.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import uuid
from unittest.mock import patch
from types import SimpleNamespace

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
sys.path[:0]=[str(HERE),str(ROOT),str(ROOT/'tests'),*[str(HERE.parent/f'mqtt-stage{n}') for n in (5,4,3,2,1)]]

from pairing_test_support import create_tls_fixture,PairingFixture
from tls_support import client_context,server_context
from broker_client import BrokerClient
from security_storage import secure_directory
from receiver_enrollment import ReceiverEnrollment,ORIGINS as ENROLL_ORIGINS
from plugin_install import PackageCatalog, PluginStore
from plugin_runtime import PluginManager, PluginDiscoveryProxy, PluginRouter, BuiltinMQTTPolicy, BuiltinEnrollment
from m6_archive import ArchiveService
from m6_files import FileStore
from m5_service import LargeDataService,EnrollmentService
from m6_file_service import FileService
from m6_repository import Repository,Journal
from m6_service import Commands,Application
from m6_network import NetworkStatus
from m6_data import DataService
from m6_persistence import start as start_persistence
from m6_receiver_bus import ReceiverBus,UP,DOWN
from m6_gateway import RpcGateway
from m6_feed import CanonicalFeed
from m6_readonly import ReadonlyGateway,PREFIX as VIEW_PREFIX
from m6_contract import prefix
from m6_transport import TransportSupervisor
from m6_groups import RuntimeGroupPolicy,RuntimeEnrollment
import websockets

class Runtime:
    def __init__(self,base,broker,*,log_path=None,runtime_scope=None):
        self.scope=runtime_scope
        if runtime_scope is not None:
            from m6_scope import checked_scope
            checked_scope(runtime_scope)
            if Path(base).resolve()!=runtime_scope.runtime_directory:raise ValueError('Runtime directory mismatch')
        self.base=Path(base).resolve()
        forbidden=(ROOT.resolve(),Path('C:/ProgramData/DATY RF PRO').resolve())
        if runtime_scope is None and any(self.base.is_relative_to(p) for p in forbidden):
            raise ValueError('M6 runtime must be isolated from production')
        self.broker=Path(broker).resolve()
        self.base.mkdir(parents=True,exist_ok=True)
        self.boot_id=uuid.uuid4().hex
        self.clients=[];self.gateways={};self.closed=False;self.server=None
        self.transport=None;self.connection_tasks=set()
        self.lifecycle=[]
        self.fixture_receiver_origins=set()
        self.log_path=Path(log_path) if log_path else self.base/'broker.log'

    async def start(self):
        try:return await self._start()
        except BaseException:
            await self.close()
            raise

    async def _start(self):
        if self.scope:
            self.tls=self.scope.tls
            self.material={key:str(value) for key,value in self.scope.material.items()}
            self.fixture=SimpleNamespace(path=self.scope.pairing,policy=self.scope.policy)
            self.database_path=self.scope.database;self.archive_path=self.scope.archives;self.staging_path=self.scope.staging
            resource_args={'runtime_scope':self.scope}
        else:
            self.prepare_fixture()
            self.database_path=self.base/'business.sqlite3';self.archive_path=self.base/'archives';self.staging_path=self.base/'staging'
            resource_args={'fixture_root':self.base}
        self.fixture.policy=BuiltinMQTTPolicy(self.fixture.path,boot_id=self.boot_id)
        if self.scope:self.scope.policy=self.fixture.policy
        return await self.start_engine(resource_args)

    def prepare_fixture(self):
        if (self.base/'business.sqlite3').exists():
            raise ValueError('Fresh isolated runtime required; existing identities/database are never overwritten')
        for n in range(1,7):(self.base/f'.daty-mqtt-stage{n}-fixture').write_text('isolated-m6-only')
        self.tls=create_tls_fixture(self.base)
        self.material=json.loads(self.tls.read_text('utf-8'))
        self.fixture=PairingFixture(self.base,('02:00:00:00:00:98','02:00:00:00:00:99'))
        registry=json.loads(self.fixture.path.read_text())
        registry['receiver_groups']={'02:00:00:00:00:98':11,'02:00:00:00:00:99':4}
        registry['development_enrollment']={'enabled':True,'allowed_ips':['127.0.0.1','127.0.0.2','127.0.0.3'],
            'max_channels':128,'max_receivers':64,'broker_url':'wss://127.0.0.1:8083/mqtt'}
        self.fixture.path.write_text(json.dumps(registry))

    async def start_engine(self,resource_args):
        from m6_job import own_process_tree
        own_process_tree()
        security=self.base/'security';secure_directory(security)
        users=[f'{m}-{r}' for m in ('app','enrollment') for r in ('gateway','business')]+['view-publisher','view-gateway','rx-ingress','rx-business']
        self.secrets={u:secrets.token_urlsafe(32) for u in users}
        passwd=security/'broker-passwords';passwd.write_text(''.join(f'{u}:{p}\n' for u,p in self.secrets.items()),encoding='utf-8')
        subprocess.run([str(self.broker.with_name('mosquitto_passwd.exe')),'-U',self.broker_path(passwd)],check=True,
            cwd=self.base,capture_output=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        acl=''.join(f'user {m}-business\ntopic read {prefix(m)}/+/request\ntopic write {prefix(m)}/+/reply\n'
            f'user {m}-gateway\npattern write {prefix(m)}/%c/request\npattern read {prefix(m)}/%c/reply\n'
            for m in ('app','enrollment'))
        acl+=f'user view-publisher\ntopic write {VIEW_PREFIX}/+/events\nuser view-gateway\npattern read {VIEW_PREFIX}/%c/events\n'
        acl+=f'user rx-ingress\ntopic write {UP}\ntopic read {DOWN}\nuser rx-business\ntopic read {UP}\ntopic write {DOWN}\n'
        acl_path=security/'broker-acl';acl_path.write_text(acl,encoding='utf-8')
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));self.tcp=sock.getsockname()[1]
        conf=self.base/'broker.conf'
        conf.write_text('\n'.join(['allow_anonymous false',f'password_file {self.broker_path(passwd)}',f'acl_file {self.broker_path(acl_path)}',
            'persistence false','retain_available false','set_tcp_nodelay true','max_packet_size 1048576','max_queued_messages 128',
            'max_inflight_messages 8','log_type error','log_type warning',f'listener {self.tcp} 127.0.0.1','protocol mqtt',
            f'certfile {self.broker_path(self.material["certificate_file"])}',f'keyfile {self.broker_path(self.material["private_key_file"])}',
            'tls_version tlsv1.2'])+'\n',encoding='utf-8')
        self.log=open(self.log_path,'wb')
        await self.start_private_broker()
        spec=importlib.util.spec_from_file_location('mqtt6_bridge_'+self.boot_id,ROOT/'mqtt-bridge.py')
        self.b=importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'DATY_DB_PATH':str(self.database_path),
                                   'DATY_ARCHIVE_PATH':str(self.archive_path)}):
            spec.loader.exec_module(self.b)
        if not self.scope:self.b._log=lambda *args:None
        self.b._pairing_policy=self.fixture.policy
        self.b._broker_loop=asyncio.get_running_loop()
        known_path=self.base/'shure-known-receivers.json'
        self.discovery=PluginDiscoveryProxy()
        self.b._shure_discovery=self.discovery
        self.repo=Repository(self.b,**resource_args)
        self.data=DataService(self.repo,discovery=self.discovery)
        self.store=FileStore(self.staging_path,**resource_args)
        self.archive=ArchiveService(self.database_path,self.archive_path)
        self.files=FileService(self.store,self.archive,self.data)
        self.enrollment=EnrollmentService(BuiltinEnrollment(self.fixture.policy,self.tls))
        self.bus=ReceiverBus(self.b,await self.client('rx-ingress'),await self.client('rx-business'),boot_id=self.boot_id,**resource_args)
        self.journal=Journal(self.repo,**resource_args)
        plugin_root=self.archive_path.parent/'plugins'
        self.plugins=PluginManager(PluginStore(plugin_root,PackageCatalog(ROOT/'contracts/trusted-plugin-packages.json')),
            self.b,self.bus,self.discovery,known_path,live=bool(self.scope),data_service=self.data,
            discovery_allowed=lambda:self.transport is not None and self.transport.ready and not self.transport.storage_issue() and not self.closed)
        self.commands=Commands(self.journal,PluginRouter(self.plugins,self.bus))
        self.commands.subscribers.append(self.command_event)
        self.network_status=NetworkStatus()
        for mode in ('app','enrollment'):
            service=Application(self.commands,self.data,self.files,self.enrollment,self.b,self.boot_id,mode=mode,network_status=self.network_status,plugins=self.plugins)
            gateway=RpcGateway(service,await self.client(mode+'-business'),broker_port=self.tcp,
                broker_tls=client_context(self.tls),username=mode+'-gateway',password=self.secrets[mode+'-gateway'],
                mode=mode,**resource_args)
            self.gateways['/mqtt-'+mode]=gateway
            gateway.transport_ready=self.transport_available
            if await asyncio.to_thread(gateway.business.subscribe,prefix(mode)+'/+/request')!=[1]:
                raise ConnectionError('Application subscription rejected')
            gateway.consumer=asyncio.create_task(gateway.consume())
        self.feed=CanonicalFeed(self.b,capacity=2048);self.feed.boot_id=self.boot_id
        self.view=ReadonlyGateway(self.feed,await self.client('view-publisher'),broker_port=self.tcp,
            broker_tls=client_context(self.tls),username='view-gateway',password=self.secrets['view-gateway'],**resource_args)
        self.gateways['/mqtt-readonly']=self.view
        await self.bus.start();await self.commands.start();await self.data.start()
        start_persistence(self.b)
        self.b._get_mqtt_dispatch_queue()
        self.plugins.start()  # Only explicitly installed packages may start receivers.
        address={'sock':self.scope.mqtt_socket} if self.scope else {'host':'127.0.0.1','port':0}
        self.server=await websockets.serve(self.handle,**address,ssl=server_context(self.tls),
            subprotocols=['mqtt'],process_request=self.check_request,max_size=1048581,max_queue=8,
            compression=None,ping_interval=10,ping_timeout=10,close_timeout=1)
        self.port=self.server.sockets[0].getsockname()[1]
        if self.scope:
            self.scope.mqtt_socket=None  # Listener owns this reserved socket now.
            from m6_static import StaticServer
            self.static=StaticServer(self.scope)
        self.uri=f'wss://{self.scope.bind_host if self.scope and self.scope.bind_host!="0.0.0.0" else "127.0.0.1"}:{self.port}'
        # Original signed identity remains the canonical :8083 endpoint. Tests
        # explicitly inject this runtime's ephemeral socket at their host edge;
        # never loosen the production enrollment URL validator for a fixture.
        self.started_at_ms=int(time.time()*1000)
        self.lifecycle=[asyncio.create_task(self.clock_loop()),asyncio.create_task(self.cleanup_loop())]
        self.transport=TransportSupervisor(self)
        self.transport.task=asyncio.create_task(self.transport.run())
        return self

    async def start_private_broker(self):
        self.process=subprocess.Popen([str(self.broker),'-c','broker.conf'],cwd=self.base,stdout=self.log,stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        for _ in range(100):
            if self.process.poll() is not None:raise RuntimeError('Broker failed to start')
            try:
                with socket.create_connection(('127.0.0.1',self.tcp),timeout=.1):break
            except OSError:await asyncio.sleep(.05)

    def broker_path(self,value):
        # This Windows Mosquitto build accepts UTF-8 config syntax but its file
        # plugin cannot open a non-ASCII absolute filename. A Unicode cwd is
        # supported by CreateProcessW; use exact relative ASCII resource paths.
        path=Path(value).resolve()
        try:relative=Path(os.path.relpath(path,self.base)).as_posix()
        except ValueError:relative=None  # Different Windows drive.
        if relative and relative.isascii():return relative
        if path.as_posix().isascii():return path.as_posix()
        raise ValueError('Private Broker resource path is not supported by this Windows build')

    async def clock_loop(self):
        await asyncio.sleep(1)
        while True:
            payload=self.b._clock_sync_payload()
            await asyncio.to_thread(self.b._broker_publish_topic,self.b.MQTT_TOPIC_CLOCK_SYNC,json.dumps(payload,ensure_ascii=False))
            await asyncio.sleep(self.b.CLOCK_SYNC_INTERVAL_SECONDS)

    async def command_event(self,record):
        # Projection of the sole durable authority. Never enters the legacy
        # command cache/reconciler or starts a second timeout/dispatch decision.
        view={'command_id':record['command_id'],'client_request_id':record['operation_id'],
            'operation_id':record['operation_id'],**record['target'],'brand':record['target']['expected_brand'],'command':record['command'],
            'status':{'unknown':'timeout','not_sent':'failed','rejected':'failed'}.get(record['state'],record['state']),
            'outcome':record['state'],'error':record['error'],'actual_value':record['actual_value'],
            'expected_value':record['expected_value'],'execution_evidence':record['execution_evidence']}
        if record['command']=='set_freq':
            for key in ('actual_value','expected_value'):
                if view[key] is not None:view[key]/=1000
        self.b._push_sse_event('command_update',view)

    def cleanup_once(self):
        b=self.b
        with b._state_lock:
            now=time.time()
            _,removed=b._cleanup_stale_state_locked(now)
            timed_out=b._detect_device_timeout_transitions_locked(now)
        if removed or timed_out:b._push_sse_event('device_list',b._get_devices_snapshot())
        else:b._queue_unified_inventory()

    async def cleanup_loop(self):
        while True:
            await asyncio.sleep(self.b.CLEANUP_INTERVAL_SECONDS)
            await asyncio.to_thread(self.cleanup_once)

    async def client(self,user):
        client=await asyncio.to_thread(BrokerClient,port=self.tcp,ca=self.material['ca_file'],username=user,password=self.secrets[user])
        client.role=user
        # Small QoS acknowledgements must not wait behind Nagle's aggregation
        # on the private TLS hop. Both sides retain their existing queue/window
        # limits and the browser still ACKs only after consuming every event.
        try:client.client.socket().setsockopt(socket.IPPROTO_TCP,socket.TCP_NODELAY,1)
        except BaseException:
            await asyncio.to_thread(client.close)
            raise
        self.clients.append(client);return client

    def transport_available(self):
        return not self.closed and (self.transport is None or self.transport.ready)

    def check_request(self,connection,request):
        if not self.transport_available():return connection.respond(503,'MQTT transport recovering; fresh connection required\n')
        if request.path=='/mqtt':
            origins=request.headers.get_all('Origin')
            if len(origins)>1 or origins and origins[0] not in ENROLL_ORIGINS|self.fixture_receiver_origins:
                return connection.respond(403,'Receiver source rejected\n')
            return None
        gateway=self.gateways.get(request.path)
        if gateway:return gateway.check_request(connection,request)
        # No HTTP business handler/SSE is installed, including legacy commands.
        # The websockets HTTP parser accepts GET upgrades only; plain POST is
        # closed by that parser before this callback and never reaches business.
        return connection.respond(410,'Legacy business transport retired in isolated candidate\n')

    async def handle(self,ws):
        task=asyncio.current_task();self.connection_tasks.add(task)
        try:
            if not self.transport_available():
                await ws.close(1013,'MQTT transport recovering; no replay');return
            if ws.request.path=='/mqtt':return await self.b._handle_mqtt_websocket(ws)
            return await self.gateways[ws.request.path].handle(ws)
        finally:self.connection_tasks.discard(task)

    async def close(self):
        if self.closed:return
        self.closed=True
        if self.transport:await self.transport.close()
        for task in self.lifecycle:task.cancel()
        await asyncio.gather(*self.lifecycle,return_exceptions=True)
        if self.server:self.server.close();await self.server.wait_closed()
        if hasattr(self,'static'):await asyncio.to_thread(self.static.close)
        if hasattr(self,'plugins'):await asyncio.to_thread(self.plugins.stop)
        elif hasattr(self,'discovery'):await asyncio.to_thread(self.discovery.stop)
        for gateway in self.gateways.values():await gateway.close()
        if hasattr(self,'commands'):await self.commands.close()
        if hasattr(self,'files'):await self.files.close()
        if hasattr(self,'data'):await self.data.close()
        if hasattr(self,'b') and self.b._mqtt_dispatch_task:
            self.b._mqtt_dispatch_task.cancel();await asyncio.gather(self.b._mqtt_dispatch_task,return_exceptions=True)
        if hasattr(self,'bus'):await self.bus.close()
        for client in self.clients:await asyncio.to_thread(client.close)
        if hasattr(self,'archive'):
            while self.archive.active:await asyncio.sleep(.05)
        for attr in ('journal','store','repo'):
            if hasattr(self,attr):getattr(self,attr).close()
        if hasattr(self,'b'):
            if self.b._unified_runtime:self.b._unified_runtime.stop()
            self.b._close_database()
        if hasattr(self,'process') and self.process.poll() is None:
            self.process.terminate();await asyncio.to_thread(self.process.wait,5)
        if hasattr(self,'log'):self.log.close()
        if self.scope:self.scope.close()
