"""Isolated TLS/Broker/paired receiver execution and durable command gate tests."""
import argparse
import asyncio
import copy
import http.client
from http.server import ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import queue
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path[:0] = [str(HERE), str(ROOT), str(ROOT / 'tests'), str(HERE.parent / 'mqtt-stage1'), str(HERE.parent / 'mqtt-stage2')]
if '--paho-root' in sys.argv:
    sys.path.insert(0, sys.argv[sys.argv.index('--paho-root') + 1])
from pairing_test_support import PairingFixture, create_tls_fixture, connect_packet, subscribe_packet
from tls_support import server_context, client_context
from security_storage import secure_directory
from broker_client import BrokerClient
from mqtt_wire import packet, utf, string, number, split, WSReader
from command_journal import Journal, CommandError
from command_service import CommandService, SERVER, SCHEMA
from bridge_adapter import BridgeAdapter
from rpc_gateway import RpcGateway, PREFIX, REQUEST, REPLY
from http_entry import handler_for
import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

OPTIONS = None


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


async def eventually(predicate, timeout=4):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        await asyncio.sleep(.01)
    raise AssertionError('Expected isolated state not reached')


class Receiver:
    def __init__(self, case, index):
        self.case, self.index = case, index
        self.cred = case.fixture.credentials[index]
        self.ip = '127.0.0.' + str(index + 2)
        self.commands, self.executions = asyncio.Queue(), []
        self.values = {ch: {'muted': False, 'freq_mhz': 640 + ch / 4} for ch in (1,2)}
        self.acknowledge = True
        self.task, self.ws = None, None

    async def start(self):
        self.ws = await websockets.connect(self.case.rx_uri, ssl=client_context(self.case.tls),
            subprotocols=['mqtt'], local_addr=(self.ip, 0))
        await self.ws.send(connect_packet(self.cred))
        assert await self.ws.recv() == b'\x20\x02\0\0'
        await self.ws.send(subscribe_packet(['daty/rf/devices/down']))
        assert await self.ws.recv() == b'\x90\x03\0\x01\0'
        await self.publish('daty/rf/devices/register', {'type':'device_list',
            'control_protocol':'fashe-realtime-v1', 'devices':[
                {'channel':ch,'channel_number':ch,'brand':'DATYaudio','model':'RF PRO',**value} for ch,value in self.values.items()]})
        self.task = asyncio.create_task(self.run())
        await eventually(lambda: any(d.get('_receiver_id') == self.cred.receiver_id
            and d.get('_source','').endswith(self.case.b._broker_clients[self.cred.client_id]['connection_token'])
            for d in self.case.b._state['devices'].values()))
        return self

    async def publish(self, topic, body):
        payload = {'receiver_id':self.cred.receiver_id, 'receiver_mac':self.cred.receiver_mac,
                   'receiver_ip':self.ip, 'brand':'DATYaudio', **body}
        await self.ws.send(self.case.b._build_mqtt_publish_packet(topic, json.dumps(payload)))

    async def ack(self, command, **changes):
        ch = command['channel_number']
        await self.publish('daty/rf/devices/up', {'type':'device_status_update','control_protocol':'fashe-realtime-v1',
            'command_id':command['command_id'], 'channel':ch, 'channel_number':ch, **self.values[ch], **changes})

    async def run(self):
        try:
            async for raw in self.ws:
                header, body = split(bytearray(raw))
                if header >> 4 != 3:
                    continue
                topic, at = string(body)
                if topic != 'daty/rf/devices/down':
                    continue
                command = json.loads(body[at:])
                # Isolated peer executes the unchanged legacy command DTO only
                # for its exact paired receiver, CH and registered brand.
                assert command['receiver_id'] == self.cred.receiver_id
                assert command['receiver_ip'] == self.ip
                assert command['receiver_mac'] == self.cred.receiver_mac
                assert command['expected_brand'] == 'DATYaudio'
                ch = command['channel_number']
                assert ch in self.values
                assert command['device_id'] == self.cred.receiver_id + '_ch' + str(ch)
                if command['command'] == 'set_freq':
                    self.values[ch]['freq_mhz'] = command['value']
                else:
                    self.values[ch]['muted'] = command['command'] == 'mute'
                self.executions.append(command)
                await self.commands.put(command)
                if self.acknowledge:
                    await self.ack(command)
        except ConnectionClosed:
            pass

    async def close(self):
        if self.ws:
            await self.ws.close()
        if self.task:
            await self.task


class UI:
    def __init__(self, case):
        self.case, self.ws, self.task = case, None, None
        self.waiters, self.updates, self.receipts = {}, [], 0
        self.pid = 0

    async def start(self):
        self.ws = await websockets.connect(self.case.uri, ssl=client_context(self.case.tls),
            subprotocols=['mqtt'], origin='https://127.0.0.1:8080')
        await self.ws.send(packet(0x10, utf('MQTT') + b'\x05\x02\0\x0a\0' + utf('')))
        self.reader = WSReader(self.ws)
        header, body = await self.reader.read()
        assert header == 0x20
        self.sid = body[-36:].decode()
        assert self.sid.startswith('ctl-')
        await self.ws.send(packet(0x82, b'\0\x01\0' + utf(REPLY) + b'\x01'))
        assert (await self.reader.read())[0] == 0x90
        hello = await self.message()
        assert hello['kind'] == 'hello'
        self.boot = hello['boot_id']
        self.task = asyncio.create_task(self.run())
        return self

    async def message(self):
        while True:
            header, body = await self.reader.read()
            if header == 0x40:
                self.receipts += 1
                continue
            assert header >> 4 == 3
            topic, pos = string(body)
            assert topic == REPLY
            if header & 6:
                pid, pos = body[pos:pos+2], pos+2
                await self.ws.send(packet(0x40, pid))
            size, pos = number(body, pos)
            result = json.loads(body[pos+size:])
            assert result['client_session_id'] == self.sid
            return result

    async def run(self):
        try:
            while True:
                message = await self.message()
                if message['kind'] == 'reply':
                    future = self.waiters.pop(message['request_id'], None)
                    if future and not future.done():
                        future.set_result(message)
                else:
                    self.updates.append(message)
        except ConnectionClosed:
            for future in self.waiters.values():
                if not future.done():
                    future.set_exception(ConnectionError('UI disconnected'))

    def request(self, body, method='commands.request', deadline=4000):
        return {'schema':SCHEMA,'server_id':SERVER,'boot_id':self.boot,'client_session_id':self.sid,
                'request_id':uuid.uuid4().hex,'method':method,'deadline_at_ms':int(time.time()*1000)+deadline,'body':body}

    async def send(self, request, *, dup=False):
        self.pid = self.pid % 65535 + 1
        await self.ws.send(packet(0x3a if dup else 0x32,
            utf(REQUEST) + self.pid.to_bytes(2,'big') + b'\0' + json.dumps(request).encode()))

    async def call(self, request):
        future = asyncio.get_running_loop().create_future()
        self.waiters[request['request_id']] = future
        await self.send(request)
        return await asyncio.wait_for(future, 6)

    async def get(self, oid):
        return await self.call(self.request({'operation_id':oid}, method='commands.get'))

    async def close(self):
        if self.ws:
            await self.ws.close()
        if self.task:
            await self.task


class Integration(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-mqtt-stage3-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.base = Path(cls.temp.name)
        (cls.base / '.daty-mqtt-stage3-fixture').write_text('isolated-only')
        cls.tls = create_tls_fixture(cls.base)
        cls.material = json.loads(cls.tls.read_text(encoding='utf-8'))
        security = cls.base / 'security'
        secure_directory(security)
        cls.secrets = {u:secrets.token_urlsafe(32) for u in ('business','gateway')}
        passwd, acl, conf = security/'passwords', security/'acl', cls.base/'broker.conf'
        passwd.write_text(''.join(f'{u}:{p}\n' for u,p in cls.secrets.items()))
        exe = Path(OPTIONS.broker).resolve()
        subprocess.run([str(exe.with_name('mosquitto_passwd.exe')),'-U',str(passwd)],check=True,capture_output=True,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        acl.write_text(f'user business\ntopic read {PREFIX}/+/request\ntopic write {PREFIX}/+/reply\n'
            f'user gateway\npattern write {PREFIX}/%c/request\npattern read {PREFIX}/%c/reply\n')
        cls.tcp = free_port()
        conf.write_text('\n'.join(['allow_anonymous false',f'password_file {passwd.as_posix()}',f'acl_file {acl.as_posix()}',
            'persistence false','retain_available false','max_packet_size 1048576','max_queued_messages 64',
            'max_inflight_messages 8','log_type error','log_type warning',f'listener {cls.tcp} 127.0.0.1','protocol mqtt',
            f'certfile {Path(cls.material["certificate_file"]).as_posix()}',
            f'keyfile {Path(cls.material["private_key_file"]).as_posix()}','tls_version tlsv1.2'])+'\n')
        cls.log = open(Path(OPTIONS.output)/'broker.log','wb')
        cls.addClassCleanup(cls.log.close)
        cls.process = subprocess.Popen([str(exe),'-c',str(conf)],stdout=cls.log,stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        cls.addClassCleanup(cls.stop_broker)
        for _ in range(100):
            if cls.process.poll() is not None:
                raise RuntimeError('Broker startup failed')
            try:
                with socket.create_connection(('127.0.0.1',cls.tcp),timeout=.1):
                    break
            except OSError:
                time.sleep(.05)
        cls.evidence = []

    @classmethod
    def stop_broker(cls):
        if cls.process.poll() is None:
            cls.process.terminate()
            cls.process.wait(timeout=5)

    async def asyncSetUp(self):
        self.case = self.base/self._testMethodName
        self.case.mkdir()
        self.fixture = PairingFixture(self.case, ('02:00:00:00:00:98','02:00:00:00:00:99'), max_channels=8)
        registry = json.loads(self.fixture.path.read_text())
        registry['receiver_groups'] = {'02:00:00:00:00:98':11,'02:00:00:00:00:99':4}
        self.fixture.path.write_text(json.dumps(registry))
        spec = importlib.util.spec_from_file_location('m3_'+self._testMethodName,ROOT/'mqtt-bridge.py')
        self.b = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ,{'DATY_DB_PATH':str(self.case/'bridge.sqlite3'),'DATY_ARCHIVE_PATH':str(self.case/'archives')}):
            spec.loader.exec_module(self.b)
        self.b._log = lambda *args:None
        self.b._pairing_policy = self.fixture.policy
        self.b._broker_loop = asyncio.get_running_loop()
        self.rx_server = await websockets.serve(self.b._handle_mqtt_websocket,'127.0.0.1',0,
            ssl=server_context(self.tls),subprotocols=['mqtt'],compression=None)
        self.rx_uri = f'wss://127.0.0.1:{self.rx_server.sockets[0].getsockname()[1]}/mqtt'
        self.adapter = BridgeAdapter(self.b,fixture_root=self.base)
        self.journal_path = self.case/'commands.sqlite3'
        self.journal = Journal(self.journal_path,fixture_root=self.base)
        self.service = CommandService(self.journal,self.adapter)
        await self.service.start()
        self.business = await asyncio.to_thread(BrokerClient,port=self.tcp,ca=self.material['ca_file'],
            username='business',password=self.secrets['business'])
        self.gateway = RpcGateway(self.service,self.business,broker_port=self.tcp,broker_tls=client_context(self.tls),
            username='gateway',password=self.secrets['gateway'],fixture_root=self.base)
        self.port = await self.gateway.start(server_context(self.tls))
        self.uri = f'wss://127.0.0.1:{self.port}/mqtt-control'
        self.http = ThreadingHTTPServer(('127.0.0.1',0),handler_for(self.b,self.service,asyncio.get_running_loop()))
        self.http.socket = server_context(self.tls).wrap_socket(self.http.socket,server_side=True)
        threading.Thread(target=self.http.serve_forever,daemon=True).start()
        self.receivers = [await Receiver(self,i).start() for i in (0,1)]
        self.uis = [await UI(self).start()]

    async def asyncTearDown(self):
        self.evidence.append({'test':self._testMethodName,'physical_send_attempts':len(self.adapter.attempts),
                              'receiver_executions':[len(rx.executions) for rx in self.receivers]})
        for ui in self.uis:
            await ui.close()
        await self.gateway.close()
        await self.service.close()
        for receiver in self.receivers:
            await receiver.close()
        self.rx_server.close()
        await self.rx_server.wait_closed()
        if self.b._mqtt_dispatch_task:
            self.b._mqtt_dispatch_task.cancel()
            await asyncio.gather(self.b._mqtt_dispatch_task,return_exceptions=True)
        await self.adapter.close()
        await asyncio.to_thread(self.business.close)
        await asyncio.to_thread(self.http.shutdown)
        self.http.server_close()
        self.journal.close()
        self.b._close_database()

    def intent(self, index=0, ch=1, command='mute', value=True):
        did = self.fixture.credentials[index].receiver_id+'_ch'+str(ch)
        return {'operation_id':uuid.uuid4().hex,'target':self.adapter.binding(did)[0],
                'command':command,'expected_value':value}

    async def state(self, oid, expected):
        await eventually(lambda:self.journal.get(oid)['state'] in expected)
        return self.journal.get(oid)

    def http_request(self, path, body):
        conn = http.client.HTTPSConnection('127.0.0.1',self.http.server_port,context=client_context(self.tls),timeout=6)
        try:
            conn.request('POST',path,json.dumps(body).encode(),{'Content-Type':'application/json','Origin':'https://127.0.0.1:8080'})
            response = conn.getresponse()
            return response.status,json.loads(response.read())
        finally:
            conn.close()

    async def test_a_real_mute_unmute_frequency_and_execution_receipts(self):
        ui, rx = self.uis[0], self.receivers[0]
        for command,value in (('mute',True),('unmute',False),('set_freq',650125)):
            intent = self.intent(command=command,value=value)
            result = await ui.call(ui.request(intent))
            self.assertTrue(result['ok'],result)
            state = await self.state(intent['operation_id'],{'acknowledged'})
            self.assertEqual(state['actual_value'],value)
            self.assertEqual(state['attempts'],1)
            self.assertEqual(state['execution_evidence']['receiver_session_id'],intent['target']['receiver_session_id'])
            queried = await ui.get(intent['operation_id'])
            self.assertEqual(queried['result']['state'],'acknowledged')
        self.assertEqual(len(rx.executions),3)
        self.assertEqual(self.receivers[1].executions,[])
        self.assertEqual(self.b._state['commands'],{})
        with sqlite3.connect(self.journal_path) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM operations WHERE state="acknowledged"').fetchone()[0],3)
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
        db.close()

    async def test_b_duplicate_publish_and_two_clients_share_one_durable_attempt(self):
        ui = self.uis[0]
        other = await UI(self).start();self.uis.append(other)
        original = ui.request(self.intent())
        duplicate = {**original,'client_session_id':other.sid,'request_id':uuid.uuid4().hex}
        results = await asyncio.gather(ui.call(original),other.call(duplicate))
        self.assertTrue(all(r['ok'] for r in results),results)
        await ui.send(original,dup=True)
        await self.state(original['body']['operation_id'],{'acknowledged'})
        await asyncio.sleep(.1)
        self.assertEqual(len(self.adapter.attempts),1)
        self.assertEqual(len(self.receivers[0].executions),1)
        changed = copy.deepcopy(original);changed['body']['expected_value']=False;changed['body']['command']='unmute'
        self.assertEqual((await ui.call(changed))['error'],'REQUEST_ID_CONFLICT')

    async def test_c_https_and_mqtt_cannot_both_control_same_request(self):
        ui = self.uis[0];request = ui.request(self.intent())
        http,mqtt = await asyncio.gather(asyncio.to_thread(self.http_request,'/api/mqtt-stage3/request',request),ui.call(request))
        self.assertEqual(http,(409,{'success':False,'accepted':False,'error':'CONTROL_ENTRY_DISABLED'}))
        self.assertTrue(mqtt['ok'])
        await self.state(request['body']['operation_id'],{'acknowledged'})
        status,body = await asyncio.to_thread(self.http_request,'/api/command',{'command':'mute','value':True,
            'device_id':request['body']['target']['device_id']})
        self.assertEqual(status,409);self.assertEqual(body['error'],'LEGACY_CONTROL_ENTRY_DISABLED')
        with self.assertRaises(CommandError):
            self.b._broker_publish_command({},[])
        self.assertEqual(len(self.adapter.attempts),1)

    async def test_d_wrong_targets_sessions_brands_and_types_never_send(self):
        ui = self.uis[0]
        mutations = [('receiver_id',self.fixture.credentials[1].receiver_id),('receiver_mac',self.fixture.credentials[1].receiver_mac),
            ('receiver_ip','127.0.0.3'),('channel_number',2),('receiver_session_id','old-session'),('expected_brand','Shure')]
        for field,value in mutations:
            body = self.intent();body['target'][field]=value
            result = await ui.call(ui.request(body))
            self.assertEqual(result['result']['state'],'rejected',result)
        self.assertEqual(self.adapter.attempts,[])
        for command,value in (('set_freq',650.125),('set_freq',True),('set_freq',950000),('mute','true')):
            with self.assertRaises(CommandError):
                await self.service.request(ui.request(self.intent(command=command,value=value)),entry='mqtt')

    async def test_e_request_expiry_before_receive_and_before_socket_write(self):
        ui = self.uis[0]
        expired = ui.request(self.intent(),deadline=-1)
        self.assertEqual((await ui.call(expired))['error'],'REQUEST_EXPIRED_OR_TOO_LONG')
        async def slow(record):
            await asyncio.sleep(1.2)
        self.adapter.before_send = slow
        request = ui.request(self.intent(),deadline=1000)
        reply = await ui.call(request)
        self.assertIn(reply['result']['state'],('not_sent','timeout'))
        self.assertEqual(self.adapter.attempts,[])

    async def test_f_timeout_after_delivery_never_replays_or_claims_success(self):
        ui,rx = self.uis[0],self.receivers[0];rx.acknowledge=False
        request = ui.request(self.intent(),deadline=4000)
        initial = await ui.call(request)
        self.assertEqual(initial['result']['state'],'published')
        self.assertIsNone(initial['result']['execution_evidence'])
        command = await asyncio.wait_for(rx.commands.get(),2)
        self.service.wall_ms = lambda: request['deadline_at_ms'] + 1
        await self.state(request['body']['operation_id'],{'timeout'})
        await rx.ack(command)
        await asyncio.sleep(.1)
        self.assertEqual((await ui.get(request['body']['operation_id']))['result']['state'],'timeout')
        new = await ui.call(ui.request(self.intent()))
        self.assertEqual(new['error'],'TARGET_PENDING_OR_UNCERTAIN')
        self.assertEqual(len(rx.executions),1)

    async def test_g_wrong_ack_id_value_receiver_channel_and_missing_value(self):
        ui,rx = self.uis[0],self.receivers[0];rx.acknowledge=False
        request = ui.request(self.intent())
        await ui.call(request);command = await rx.commands.get()
        await rx.ack(command,command_id=uuid.uuid4().hex)
        await rx.ack(command,muted=False)
        await rx.ack(command,channel=2,channel_number=2)
        await rx.publish('daty/rf/devices/up',{'channel':1,'command_id':command['command_id'],'rf_level':-40})
        await self.receivers[1].ack(command)
        await asyncio.sleep(.2)
        self.assertEqual(self.journal.get(request['body']['operation_id'])['state'],'published')
        await rx.ack(command)
        await self.state(request['body']['operation_id'],{'acknowledged'})

    async def test_h_disconnect_before_dispatch_and_query_after_ui_reconnect(self):
        ui = self.uis[0]
        entered,release = asyncio.Event(),asyncio.Event()
        async def pause(record):
            entered.set();await release.wait()
        self.adapter.before_send=pause
        request=ui.request(self.intent());await ui.send(request);await entered.wait()
        await ui.close();release.set()
        await self.state(request['body']['operation_id'],{'not_sent'})
        self.assertEqual(self.adapter.attempts,[])
        other=await UI(self).start();self.uis.append(other)
        self.assertEqual((await other.get(request['body']['operation_id']))['result']['state'],'not_sent')

    async def test_i_receiver_reconnect_or_revoke_before_send_does_not_retarget(self):
        ui=self.uis[0];entered,release=asyncio.Event(),asyncio.Event()
        async def pause(record):
            entered.set();await release.wait()
        self.adapter.before_send=pause
        request=ui.request(self.intent());task=asyncio.create_task(ui.call(request));await entered.wait()
        await self.receivers[0].close();self.receivers[0]=await Receiver(self,0).start();release.set()
        reply=await task
        self.assertIn(reply['result']['state'],('unknown','not_sent'))
        self.assertEqual(self.adapter.attempts,[])
        self.adapter.before_send=None
        body=self.intent(ch=2);self.fixture.records[0]['revoked']=True;self.fixture.save()
        result=await ui.call(ui.request(body))
        self.assertEqual(result['result']['state'],'rejected')

    async def test_j_send_exception_after_actual_delivery_is_unknown_not_retry(self):
        ui,rx=self.uis[0],self.receivers[0];rx.acknowledge=False
        actual_send=self.adapter.send
        async def ambiguous(record,*,allowed):
            await actual_send(record,allowed=allowed)
            raise OSError('simulated disconnect after socket send')
        self.adapter.send=ambiguous
        request=ui.request(self.intent());result=await ui.call(request)
        self.assertEqual(result['result']['state'],'unknown')
        await ui.call(request)
        await eventually(lambda:len(rx.executions)==1)
        self.assertEqual(len(self.adapter.attempts),1)

    async def test_k_journal_write_failure_blocks_dispatch_and_single_process_lease(self):
        with self.assertRaises(CommandError):
            Journal(self.journal_path,fixture_root=self.base)
        with patch.object(self.journal,'reserve',side_effect=sqlite3.OperationalError('disk full')):
            result=await self.uis[0].call(self.uis[0].request(self.intent()))
        self.assertEqual(result['error'],'JOURNAL_OR_SERVICE_OUTCOME_UNKNOWN')
        self.assertFalse(self.service.accepting)
        self.assertEqual(self.adapter.attempts,[])

    async def test_l_restart_recovery_never_replays_interrupted_rows(self):
        request=self.uis[0].request(self.intent())
        record,_=self.journal.reserve(request,'mqtt')
        self.journal.transition(record['operation_id'],{'reserved'},'dispatching',attempt=True)
        self.journal.close()
        self.journal=Journal(self.journal_path,fixture_root=self.base)
        self.service.journal=self.journal
        recovered=self.journal.get(record['operation_id'])
        self.assertEqual(recovered['state'],'unknown')
        self.assertEqual(recovered['attempts'],1)
        self.assertEqual((await self.uis[0].call(request))['result']['state'],'unknown')
        self.assertEqual(self.adapter.attempts,[])

    async def test_m_origin_receiver_topic_retained_and_foreign_reply_rejected(self):
        for origin in ('null','https://evil.invalid:8080','http://127.0.0.1:8080'):
            with self.assertRaises(InvalidStatus):
                await websockets.connect(self.uri,ssl=client_context(self.tls),subprotocols=['mqtt'],origin=origin)
        for topic,header in (('daty/rf/devices/down',0x32),(REQUEST,0x33),(PREFIX+'/foreign/reply',0x32)):
            ui=await UI(self).start();self.uis.append(ui)
            request=ui.request(self.intent())
            await ui.ws.send(packet(header,utf(topic)+b'\0\x03\0'+json.dumps(request).encode()))
            await eventually(lambda:ui.ws.close_code is not None)
            self.assertEqual(ui.ws.close_code,1008)
        self.assertEqual(self.adapter.attempts,[])

    async def test_n_broker_puback_is_not_receiver_ack_and_privacy_between_clients(self):
        ui=self.uis[0];other=await UI(self).start();self.uis.append(other)
        self.receivers[0].acknowledge=False
        request=ui.request(self.intent());reply=await ui.call(request)
        self.assertGreater(ui.receipts,0)
        self.assertEqual(reply['result']['state'],'published')
        self.assertIsNone(reply['result']['actual_value'])
        await asyncio.sleep(.1)
        self.assertEqual(other.updates,[])

    async def test_o_targets_preserve_real_group_ch_order(self):
        result=await self.uis[0].call(self.uis[0].request({},method='commands.targets'))
        self.assertEqual([(x['group_number'],x['target']['channel_number']) for x in result['result']['targets']],[(4,1),(4,2),(11,1),(11,2)])

    async def test_p_real_process_crash_after_claim_is_durable_unknown(self):
        request=self.uis[0].request(self.intent())
        request_file=self.case/'crash-request.json';request_file.write_text(json.dumps(request))
        path=self.case/'crashed.sqlite3'
        result=await asyncio.to_thread(subprocess.run,[sys.executable,str(HERE/'crash_writer.py'),str(self.base),str(path),str(request_file)],
            capture_output=True,timeout=10,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.assertEqual(result.returncode,23,result.stderr)
        journal=Journal(path,fixture_root=self.base)
        try:
            restored,created=journal.reserve(request,'mqtt')
            self.assertFalse(created);self.assertEqual(restored['state'],'unknown')
            self.assertEqual(restored['attempts'],1)
            self.assertEqual(journal.db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
        finally:
            journal.close()
        self.assertEqual(self.adapter.attempts,[])

    async def test_q_committed_dispatch_with_lost_commit_result_never_sends(self):
        count=0;commit=self.journal.commit
        def lost_commit():
            nonlocal count
            count+=1;commit()
            if count==2:
                raise OSError('simulated lost FULL commit result')
        request=self.uis[0].request(self.intent())
        with patch.object(self.journal,'commit',side_effect=lost_commit):
            result=await self.uis[0].call(request)
        self.assertEqual(result['error'],'JOURNAL_OR_SERVICE_OUTCOME_UNKNOWN')
        self.assertEqual(self.adapter.attempts,[])
        self.journal.close();self.journal=Journal(self.journal_path,fixture_root=self.base);self.service.journal=self.journal
        self.assertEqual(self.journal.get(request['body']['operation_id'])['state'],'unknown')

    async def test_r_browser_mqttjs_control_adapter_and_real_receipt(self):
        if not OPTIONS.ws_bundle:
            self.skipTest('Explicit MQTT.js WebSocket adapter path required')
        child=await asyncio.create_subprocess_exec(OPTIONS.node,str(HERE/'mqttjs-control-live.cjs'),self.uri,
            self.material['ca_file'],str(ROOT.parent/'FAshe/vendor/mqtt-5.10.4/mqtt.upstream.min.js'),OPTIONS.ws_bundle,
            stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        try:
            stdout,stderr=await asyncio.wait_for(child.communicate(),15)
            self.assertEqual(child.returncode,0,stderr.decode('utf-8',errors='replace'))
            result=json.loads(stdout);self.assertTrue(result['ok'])
            self.assertEqual(len(self.adapter.attempts),1)
            self.assertEqual([len(rx.executions) for rx in self.receivers],[1,0])
            Path(OPTIONS.output,'mqttjs-control-live.json').write_text(json.dumps(result,indent=2))
        finally:
            if child.returncode is None:
                child.kill();await child.wait()

    async def test_s_expired_decision_stays_fenced_after_wall_clock_moves_back(self):
        entered,release=asyncio.Event(),asyncio.Event()
        async def pause(record):
            entered.set();await release.wait()
        self.adapter.before_send=pause
        moment=int(time.time()*1000);clock=[moment];self.service.wall_ms=lambda:clock[0]
        ui=self.uis[0];request=ui.request(self.intent())
        task=asyncio.create_task(ui.call(request));await entered.wait()
        clock[0]=request['deadline_at_ms']+1
        await self.state(request['body']['operation_id'],{'timeout'})
        clock[0]=moment;release.set()
        self.assertEqual((await task)['result']['state'],'timeout')
        self.assertEqual(self.adapter.attempts,[])

    async def test_t_reconnected_receiver_cannot_ack_an_old_session_command(self):
        ui,rx=self.uis[0],self.receivers[0];rx.acknowledge=False
        request=ui.request(self.intent());await ui.call(request);command=await rx.commands.get()
        await rx.close();self.receivers[0]=await Receiver(self,0).start()
        await self.receivers[0].ack(command,muted=True)
        await self.state(request['body']['operation_id'],{'unknown'})
        self.assertEqual((await ui.get(request['body']['operation_id']))['result']['state'],'unknown')
        self.assertEqual(len(self.adapter.attempts),1)

    async def test_z_broker_loss_does_not_replay_command(self):
        ui=self.uis[0];self.receivers[0].acknowledge=False
        request=ui.request(self.intent());await ui.call(request)
        await asyncio.to_thread(self.stop_broker)
        await eventually(lambda:ui.ws.close_code is not None)
        await eventually(lambda:not self.service.accepting)
        self.assertFalse(self.service.accepting)
        self.assertEqual(len(self.adapter.attempts),1)


if __name__ == '__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('--broker',required=True)
    ap.add_argument('--paho-root',required=True)
    ap.add_argument('--output',required=True)
    ap.add_argument('--case')
    ap.add_argument('--node',default='node')
    ap.add_argument('--ws-bundle')
    OPTIONS=ap.parse_args()
    Path(OPTIONS.output).mkdir(parents=True,exist_ok=True)
    suite=unittest.TestSuite([Integration(OPTIONS.case)]) if OPTIONS.case else unittest.defaultTestLoader.loadTestsFromTestCase(Integration)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    Path(OPTIONS.output,'result.json').write_text(json.dumps({'tests':result.testsRun,'failures':len(result.failures),
        'errors':len(result.errors),'skipped':len(result.skipped),'success':result.wasSuccessful(),
        'broker_stopped':Integration.process.poll() is not None,'temporary_material_removed':not Integration.base.exists(),
        'execution_evidence':Integration.evidence},indent=2))
    sys.exit(0 if result.wasSuccessful() else 1)
