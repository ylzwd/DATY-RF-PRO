"""Imported original Shure ZIP, loopback TCP, actual MQTT/TLS and SQLite."""
import asyncio,copy,json,socket,threading,time,unittest
from types import SimpleNamespace
from plugin_runtime import materialize_shure_report
from test_plugin_mqtt import ImportedShure
from m6_test_support import eventually
from shure_protocol import extract_framed_messages

MAC='00:0E:DD:00:00:01'
def receiver():
    return {'receiver_id':'Shure-ULXD4-fixture','ip':'127.0.0.1','receiver_ip':'127.0.0.1',
        'model':'ULXD4','brand':'Shure','protocol_verified':True,'version':'2.10.0.0',
        'settings':{'receiver_mac':MAC},'ts':time.time(),'channels':{'1':{'channel_number':1,
        'frequency_khz':690000,'name':'Vocal','muted':False,'rf_dbm':-32,'audio_dbfs':-24,
        'field_times':{'frequency_khz':1000,'name':1000,'muted':1000,'rf_dbm':1000}}}}

class Materialization(unittest.TestCase):
    def setUp(self):
        self.cached=receiver();self.discovery=SimpleNamespace(lock=threading.RLock(),receivers={'127.0.0.1':self.cached})
        self.patch=copy.deepcopy(self.cached);self.patch['channels']={'1':{'channel_number':1,'field_times':{'frequency_khz':2000,'muted':2000},'stale_fields':[]}}
    def test_fresh_unchanged_report_restores_values_without_mutating_source(self):
        source=copy.deepcopy(self.patch);old=copy.deepcopy(self.cached)
        result=materialize_shure_report(self.patch,self.discovery)['channels']['1']
        self.assertEqual((result['frequency_khz'],result['muted']),(690000,False))
        self.assertEqual(result['field_times'],source['channels']['1']['field_times'])
        self.assertEqual(self.patch,source);self.assertEqual(self.cached,old)
    def test_samples_and_disconnects_do_not_restore_metadata_or_old_meters(self):
        sample=copy.deepcopy(self.patch);sample['channels']={'1':{'channel_number':1,'rf_dbm':-36,'meter_seq':3}}
        self.assertEqual(materialize_shure_report(sample,self.discovery),sample)
        self.patch['observation_received']=False
        self.assertEqual(materialize_shure_report(self.patch,self.discovery),self.patch)
        self.patch.pop('observation_received');self.patch['channels']['1']['field_times']['rf_dbm']=2000
        self.assertNotIn('rf_dbm',materialize_shure_report(self.patch,self.discovery)['channels']['1'])
    def test_explicit_unknown_changed_and_stale_values_win(self):
        p=self.patch['channels']['1'];p.update(frequency_khz=None,muted=True)
        self.assertEqual(materialize_shure_report(self.patch,self.discovery)['channels']['1'],p)
        del p['frequency_khz'];p['stale_fields']=['frequency_khz']
        self.assertNotIn('frequency_khz',materialize_shure_report(self.patch,self.discovery)['channels']['1'])
    def test_wrong_chassis_channel_or_unobserved_timestamp_cannot_restore(self):
        for key,value in [('receiver_id','different'),('model','ULXD4D'),('receiver_ip','127.0.0.2')]:
            p=copy.deepcopy(self.patch);p[key]=value
            self.assertEqual(materialize_shure_report(p,self.discovery),p)
        for value in (None,'00:0E:DD:00:00:02'):
            p=copy.deepcopy(self.patch);p['settings']['receiver_mac']=value
            self.assertEqual(materialize_shure_report(p,self.discovery),p)
        for value in (999,None,True):
            p=copy.deepcopy(self.patch);p['channels']['1']['field_times']['frequency_khz']=value
            self.assertNotIn('frequency_khz',materialize_shure_report(p,self.discovery)['channels']['1'])
        self.patch['channels']['1']['channel_number']=2
        self.assertEqual(materialize_shure_report(self.patch,self.discovery),self.patch)

    def test_direct_scp_restores_only_matching_live_receiver_metadata_without_systemapi(self):
        cached=self.discovery.receivers[self.patch['receiver_ip']]
        for value in (cached,self.patch):
            value['settings'].update(legacy_scp=True,identity_source='direct-scp')
            value['version']='2.3.34.0'
        restored=materialize_shure_report(self.patch,self.discovery)
        self.assertEqual(restored['channels']['1']['frequency_khz'],cached['channels']['1']['frequency_khz'])
        self.patch['version']='another'
        self.assertEqual(materialize_shure_report(self.patch,self.discovery),self.patch)

class MetadataPeer:
    def __init__(self):
        self.socket=socket.socket();self.socket.bind(('127.0.0.1',0));self.socket.listen();self.socket.settimeout(.1)
        self.port=self.socket.getsockname()[1];self.stop=threading.Event();self.commands=[];self.samples=0
        self.frequency=690000;self.muted=False;self.metadata=True
        self.thread=threading.Thread(target=self.run,daemon=True);self.thread.start()
    def close(self):self.stop.set();self.thread.join(3);self.socket.close()
    def run(self):
        while not self.stop.is_set():
            try:conn,_=self.socket.accept()
            except socket.timeout:continue
            except OSError:break
            with conn:
                conn.settimeout(.02);pending='';enabled=False
                try:
                    while not self.stop.is_set():
                        try:
                            chunk=conn.recv(8192)
                            if not chunk:break
                            frames,pending=extract_framed_messages(pending+chunk.decode())
                            for frame in frames:
                                self.commands.append(frame)
                                if frame=='GET MODEL':conn.sendall(b'< REP MODEL {ULXD4} >')
                                elif frame=='GET 0 ALL' and self.metadata:
                                    conn.sendall(f'< REP NET_SETTINGS SC AUTO 127.000.000.001 255.0.0.0 127.0.0.1 {MAC} >< REP 1 CHAN_NAME {{Vocal}} >< REP 1 FREQUENCY {self.frequency:06d} >< REP 1 AUDIO_MUTE {"ON" if self.muted else "OFF"} >< REP 1 BATT_BARS 004 >'.encode())
                                elif frame=='GET 1 METER_RATE':conn.sendall(b'< REP 1 METER_RATE 00100 >');enabled=True
                        except socket.timeout:pass
                        if enabled:
                            conn.sendall(b'< SAMPLE 1 ALL AX 096 026 >');self.samples+=1
                except OSError:pass

class Recovery(ImportedShure):
    async def test_evicted_channel_recovers_unchanged_metadata_on_next_real_report(self):
        await self.install_shure();item=self.runtime.plugins.active['shure-scp'];discovery=item['discovery']
        module=item['namespace'].load('shure_active_discovery.py');session_class=item['namespace'].load('shure_metering.py').ShureMeterSession
        peer=MetadataPeer();captured=[];original=discovery.on_update
        def accept(raw):captured.append(copy.deepcopy(raw));original(raw)
        discovery.on_update=accept
        module.ShureMeterSession=lambda raw,callback:session_class(raw,callback,port=peer.port,metadata_interval=.15)
        discovery.probe=lambda host,**kw:receiver();discovery.metering=True
        did='Shure-ULXD4-fixture_ch1'
        try:
            await asyncio.to_thread(discovery._visit,'127.0.0.1')
            did=discovery.receivers['127.0.0.1']['receiver_id']+'_ch1'
            await eventually(lambda:any('frequency_khz' in r['channels'].get('1',{}).get('field_times',{}) and 'frequency_khz' not in r['channels'].get('1',{}) for r in captured))
            self.assertEqual(discovery.receivers['127.0.0.1']['settings']['receiver_mac'],MAC)
            first=next(d for d in (await self.rpc('devices.snapshot'))['devices'] if d['id']==did)
            group=first['group_number'];peer.metadata=False
            await asyncio.sleep(.25)
            with self.b._state_lock:
                self.b._state['devices'][did]['_last_seen']=time.time()-self.b.DEVICE_RETENTION_SECONDS-1
                _,removed=self.b._cleanup_stale_state_locked();self.assertIn(did,removed)
            await eventually(lambda:did in self.b._state['devices'] and self.b._state['devices'][did].get('rf')==-32)
            self.assertIsNone(self.b._state['devices'][did]['freq'],'A SAMPLE must not fill a missing frequency')
            peer.metadata=True
            await eventually(lambda:self.b._state['devices'][did].get('freq')==690000,timeout=3)
            recovered=next(d for d in (await self.rpc('devices.snapshot'))['devices'] if d['id']==did)
            self.assertEqual((recovered['freq'],recovered['muted'],recovered['name'],recovered['rf']),(690000,False,'Vocal',-32))
            self.assertEqual(recovered['group_number'],group);self.assertEqual(recovered['shure']['audio_dbfs'],-24)
            self.assertGreater(recovered['shure']['field_times']['frequency_khz'],1000)
            peer.frequency=691000;peer.muted=True
            await eventually(lambda:self.b._state['devices'][did].get('freq')==691000 and self.b._state['devices'][did].get('muted') is True)
            await asyncio.to_thread(self.b._unified_runtime.wait_idle)
            with self.runtime.repo.connection() as c:
                from rf_sample_storage import load_snapshot
                saved=[json.loads(load_snapshot(c,row[0])) for row in c.execute('SELECT id FROM live_samples WHERE device_id=? ORDER BY id',(did,))]
            self.assertTrue(any(d['freq']==690000 and d['muted'] is False for d in saved))
            self.assertTrue(any(d['freq']==691000 and d['muted'] is True for d in saved))
            self.assertFalse(any(command.startswith('SET ') for command in peer.commands))
            self.assertEqual([len(r.executions) for r in self.receivers],[0,0])
        finally:
            discovery.stop();await asyncio.to_thread(peer.close)

def load_tests(loader,tests,pattern):
    return unittest.TestSuite([loader.loadTestsFromTestCase(Materialization),Recovery('test_evicted_channel_recovers_unchanged_metadata_on_next_real_report')])
