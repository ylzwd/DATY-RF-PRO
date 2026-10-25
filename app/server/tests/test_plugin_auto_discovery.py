"""Temporary MQTT/TLS/SQLite, loopback peers only; no LAN discovery in tests."""
import asyncio,copy,json,socketserver,threading,time,unittest,uuid
from types import SimpleNamespace
from unittest.mock import patch
from plugin_discovery import AutoDiscovery
from shure_legacy import identity_from_response,legacy_probe,validate_legacy_identity
from shure_metering import ShureMeterSession
from test_plugin_mqtt import ImportedShure
from test_shure_active_discovery import observation
from m6_test_support import eventually

ID={'device_id':'dd4b7e53-0000-11dd-a000-000eddcccccc','serial':'4192030916',
    'model':'ULXD4','firmware':'2.3.34.0','ip':'127.0.0.1'}

class Scheduler(unittest.TestCase):
    def setUp(self):
        self.calls=[];self.state={'enabled':True,'scanning':False}
        self.adapter=SimpleNamespace(lock=threading.RLock(),stop_event=threading.Event(),
            snapshot=lambda:dict(self.state),request_scan=lambda:self.calls.append('scan'))
        self.item={'sha256':'a','release':{'capabilities':{'discover':True}},'discovery':self.adapter}
        self.manager=SimpleNamespace(closed=False,active={'a':self.item},removal=SimpleNamespace(draining=set()))
        self.service=SimpleNamespace(accepting=True,repo=SimpleNamespace(poisoned=False),active_scan=None)
        self.auto=AutoDiscovery(self.manager,self.service,interval=.02)
    def test_startup_late_install_periodic_and_close(self):
        self.manager.active={};self.auto.tick();self.assertEqual(self.calls,[])
        self.manager.active={'a':self.item};self.auto.tick();self.auto.tick();self.assertEqual(len(self.calls),1)
        time.sleep(.03);self.auto.tick();self.assertEqual(len(self.calls),2)
        self.auto.stop();time.sleep(.03);self.auto.tick();self.assertEqual(len(self.calls),2)
    def test_pending_receipt_scanning_disabled_or_unhealthy_never_start(self):
        self.service.active_scan='accepted-or-unknown';self.auto.tick();self.assertEqual(self.calls,[])
        self.service.active_scan=None;self.state['scanning']=True;self.auto.tick();self.assertEqual(self.calls,[])
        self.state['scanning']=False;self.state['enabled']=False;self.auto.tick();self.assertEqual(self.calls,[])
        self.state['enabled']=True;self.service.repo.poisoned=True;self.auto.tick();self.assertEqual(self.calls,[])
        self.service.repo.poisoned=False;self.auto.allowed=lambda:False;self.auto.tick();self.assertEqual(self.calls,[])
    def test_second_brand_and_plugin_failure_are_independent(self):
        other=copy.copy(self.adapter);other.request_scan=lambda:self.calls.append('other')
        self.manager.active['b']={**self.item,'discovery':other}
        self.adapter.request_scan=lambda:(_ for _ in ()).throw(OSError('fixture'))
        self.auto.tick();self.assertEqual(self.calls,['other']);self.assertEqual(self.auto.errors,{'a':'OSError'})
        self.auto.tick();self.assertEqual(self.calls,['other'])

class LegacyIdentity(unittest.TestCase):
    def response(self):
        return {'edges':[{'node':{'deviceState':'ONLINE','communicationProtocol':{'address':'127.0.0.1'},
            'hardwareIdentity':{'deviceId':ID['device_id'],'serialNumber':ID['serial']},
            'softwareIdentity':{'firmwareValid':True,'firmwareVersion':ID['firmware'],'model':'ULXD4'}}}]}
    def test_model_is_hardware_identity_not_editable_label(self):
        self.assertEqual(identity_from_response(self.response(),'127.0.0.1'),ID)
        r=self.response();r['edges'][0]['node']['softwareIdentity']['model']='UNKNOWN'
        r['edges'][0]['node']['name']='ULXD4';self.assertIsNone(identity_from_response(r,'127.0.0.1'))
    def test_offline_duplicate_wrong_address_or_chassis_rejected(self):
        r=self.response();r['edges']*=2;self.assertIsNone(identity_from_response(r,'127.0.0.1'))
        r=self.response();r['edges'][0]['node']['deviceState']='OFFLINE';self.assertIsNone(identity_from_response(r,'127.0.0.1'))
        self.assertIsNone(identity_from_response(self.response(),'127.0.0.2'))
        raw={'ip':'127.0.0.1','model':'ULXD4','version':ID['firmware'],
             'settings':{'systemapi_device_id':ID['device_id'],'receiver_serial':'different'}}
        self.assertFalse(validate_legacy_identity(raw,lambda _:ID))

class LegacyPeer(socketserver.ThreadingTCPServer):
    allow_reuse_address=True;daemon_threads=True
    def __init__(self):
        peer=self;self.commands=[];self.stopping=threading.Event();self.antenna='AX';self.rf=96
        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                from shure_protocol import extract_framed_messages
                self.request.settimeout(.04);pending='';meter=False
                try:
                    while not peer.stopping.is_set():
                        try:
                            data=self.request.recv(8192)
                            if not data:break
                            # Reproduce the older receiver's strict framing.
                            if b'\r' in data or b'\n' in data:
                                self.request.sendall(b'< REP ERR >');continue
                            frames,pending=extract_framed_messages(pending+data.decode())
                            for cmd in frames:
                                peer.commands.append(cmd)
                                if cmd=='GET 0 ALL':self.request.sendall(b'< REP FW_VER {2.3.34.0} >< REP DEVICE_ID {Editable label} >< REP FREQUENCY_DIVERSITY_MODE OFF >< REP HIGH_DENSITY OFF >< REP 1 CHAN_NAME {Vocal} >< REP 1 FREQUENCY 632700 >< REP 1 AUDIO_MUTE OFF >< REP 1 BATT_BARS 004 >< REP 1 RF_ANTENNA AX >< REP 1 RX_RF_LVL 096 >< REP 1 AUDIO_LVL 026 >< REP 1 TX_TYPE ULXD2 >')
                                elif cmd=='GET 1 METER_RATE':self.request.sendall(b'< REP 1 METER_RATE 00000 >')
                                elif cmd.startswith('SET 1 METER_RATE '):
                                    meter=cmd.endswith('00100');self.request.sendall(('< REP 1 METER_RATE '+cmd.split()[-1]+' >').encode())
                                elif cmd=='GET 1 BATT_BARS':self.request.sendall(b'< REP 1 BATT_BARS 004 >')
                                else:self.request.sendall(b'< REP ERR >')
                        except TimeoutError:pass
                        if meter:self.request.sendall(f'< SAMPLE 1 ALL {peer.antenna} {peer.rf:03d} 026 >'.encode())
                except OSError:pass
        super().__init__(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.serve_forever,daemon=True);self.thread.start()
    def close(self):self.stopping.set();self.shutdown();self.server_close();self.thread.join(2)

class Automatic(ImportedShure):
    async def test_automatic_start_and_later_receiver_without_manual_rpc(self):
        await self.install_shure();d=self.runtime.discovery.target;auto=self.runtime.plugins.auto_discovery
        module=self.runtime.plugins.active['shure-scp']['namespace'].load('shure_active_discovery.py')
        available={'192.0.2.2'};d.interfaces=lambda:[]
        def probe(host,**kwargs):
            if host not in available:return None
            raw=observation(host);raw['ts']=time.time();return raw
        d.probe=probe;d.metering=False
        with patch.object(module,'scan_targets',lambda *args:(['192.0.2.2','192.0.2.3'],[])):
            auto.interval=.1;auto.start()
            await eventually(lambda:'192.0.2.2' in d.receivers)
            available.add('192.0.2.3')
            await eventually(lambda:'192.0.2.3' in d.receivers,timeout=5)
            auto.stop()
        devices=(await self.rpc('devices.snapshot'))['devices'];shure=[v for v in devices if v['brand']=='Shure']
        self.assertEqual(len(shure),4);self.assertEqual(len({v['group_number'] for v in shure}),2)
        self.assertFalse(self.runtime.data.active_scan)
        self.assertEqual([len(r.executions) for r in self.receivers],[0,0])

    async def test_manual_receipt_finishes_before_next_automatic_generation(self):
        await self.install_shure();d=self.runtime.discovery.target;auto=self.runtime.plugins.auto_discovery
        self.runtime.data.monitor.cancel();await asyncio.gather(self.runtime.data.monitor,return_exceptions=True)
        result=await self.rpc('discovery.scan',{'operation_id':uuid.uuid4().hex,'epoch':self.epoch,'expected_generation':0})
        self.assertEqual(result['status'],202)
        await eventually(lambda:not d.snapshot()['scanning'])
        generation=d.generation;await asyncio.to_thread(auto.tick);self.assertEqual(d.generation,generation)
        await asyncio.to_thread(self.runtime.data.finish_discovery);self.assertIsNone(self.runtime.data.active_scan)
        await asyncio.to_thread(auto.tick);self.assertEqual(d.generation,generation+1)

    async def test_legacy_real_tcp_to_mqtt_persistence_and_offline_then_recover(self):
        await self.install_shure();item=self.runtime.plugins.active['shure-scp'];d=item['discovery']
        module=item['namespace'].load('shure_active_discovery.py');peer=LegacyPeer();port=peer.server_address[1]
        self.addAsyncCleanup(asyncio.to_thread,peer.close)
        raw=await asyncio.to_thread(legacy_probe,module,'127.0.0.1',port=port,identity_provider=lambda _:ID)
        self.assertIsNotNone(raw);self.assertEqual(raw['model'],'ULXD4');self.assertEqual(raw['device_name'],'Editable label')
        self.assertIsNone(await asyncio.to_thread(legacy_probe,module,'127.0.0.1',port=port,identity_provider=lambda _:None))
        d.probe=lambda host,**kwargs:copy.deepcopy(raw);d.metering=True
        module.ShureMeterSession=lambda receiver,callback:ShureMeterSession(receiver,callback,port=port,metadata_interval=.15,
            identity_check=lambda receiver:validate_legacy_identity(receiver,lambda _:ID))
        await asyncio.to_thread(d._visit,'127.0.0.1');did=raw['receiver_id']+'_ch1'
        await eventually(lambda:self.b._state['devices'].get(did,{}).get('rf')==-32)
        device=next(v for v in (await self.rpc('devices.snapshot'))['devices'] if v['id']==did)
        self.assertEqual((device['freq'],device['af_dbfs']),(632700,-24));group=device['group_number']
        caps=self.b._device_capabilities(device,device);self.assertTrue(caps['read_only']);self.assertFalse(caps['mute'])
        await eventually(lambda:all(self.b._state['devices'][did]['shure'].get('field_times',{}).get('settings.'+k,0)>0
            and 'settings.'+k not in self.b._state['devices'][did]['shure'].get('stale_fields',[])
            for k in ('systemapi_device_id','receiver_serial','legacy_control_identity')))
        peer.antenna='XX';peer.rf=30
        await eventually(lambda:self.b._state['devices'][did]['shure'].get('rf_antenna')=='XX')
        # Clearing a host cache must recover metadata from real same-value REP.
        with self.b._state_lock:self.b._state['devices'].pop(did)
        await eventually(lambda:self.b._state['devices'].get(did,{}).get('freq')==632700)
        self.assertEqual(self.b._state['devices'][did]['group_number'],group)
        await asyncio.to_thread(self.b._unified_runtime.wait_idle)
        with self.runtime.repo.connection() as c:
            saved=[json.loads(r[0]) for r in c.execute('SELECT snapshot_json FROM live_samples WHERE device_id=?',(did,))]
        self.assertTrue(any(v['freq']==632700 and v['af_dbfs']==-24 for v in saved))
        self.assertFalse(any(c.startswith('SET ') and ' METER_RATE ' not in c for c in peer.commands))
        d.stop()

def load_tests(loader,tests,pattern):
    return unittest.TestSuite([loader.loadTestsFromTestCase(Scheduler),loader.loadTestsFromTestCase(LegacyIdentity),
        *(Automatic(name) for name in Automatic.__dict__ if name.startswith('test_'))])
