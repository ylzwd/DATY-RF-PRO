"""Installed original ZIP + isolated TLS/MQTT/SQLite + strict legacy TCP peer."""
import asyncio,copy,time,unittest,uuid
from unittest.mock import patch
from m6_test_support import eventually
from shure_protocol import extract_framed_messages
from test_plugin_mqtt import ImportedShure
from test_plugin_auto_discovery import ID
from shure_legacy import legacy_probe,validate_legacy_identity
from shure_hardware import band_identity
from command_journal import CommandError

MAC='02:00:00:00:00:A4'

class Legacy(ImportedShure):
    async def setup_legacy(self,band=True,direct=False):
        import shure_hardware
        labels={MAC:{'model':'ULXD4','band':'L51','receiver_serial':ID['serial'],'systemapi_device_id':ID['device_id']}} if band else {}
        label=patch.object(shure_hardware,'hardware_registry',lambda:labels);label.start();self.addCleanup(label.stop)
        await self.install_shure()
        self.wires=[];self.executions=[];self.value=632700;self.muted=False;self.failure=None;self.connections=0
        self.mode='OFF';self.identity=dict(ID);self.mac=MAC;self.writers=set()
        async def peer(reader,writer):
            self.writers.add(writer);self.connections+=1;connection=self.connections;pending=''
            try:
                while data:=await reader.read(8192):
                    self.assertNotIn(b'\r',data);self.assertNotIn(b'\n',data)
                    frames,pending=extract_framed_messages(pending+data.decode())
                    for cmd in frames:
                        self.wires.append((connection,cmd))
                        if cmd=='GET 0 ALL':
                            if self.executions and self.failure=='disconnect':writer.close();break
                            ch=2 if self.executions and self.failure=='wrong-channel' else 1
                            fw='2.0.0.0' if self.failure=='firmware' else ID['firmware']
                            writer.write((f'< REP FW_VER {{{fw}}} >< REP DEVICE_ID {{Editable label}} >'
                                f'< REP FREQUENCY_DIVERSITY_MODE {self.mode} >< REP HIGH_DENSITY OFF >'
                                f'< REP {ch} FREQUENCY {self.value:06d} >< REP {ch} AUDIO_MUTE {"ON" if self.muted else "OFF"} >'
                                f'< REP {ch} RF_ANTENNA XX >< REP {ch} RX_RF_LVL 033 >< REP {ch} AUDIO_LVL 000 >< REP {ch} TX_TYPE UNKN >').encode())
                        elif cmd.startswith('SET '):
                            self.executions.append((connection,cmd))
                            if self.failure!='mismatch':
                                if 'AUDIO_MUTE' in cmd:self.muted=cmd.endswith('ON')
                                else:self.value=int(cmd.split()[-1])
                            if self.failure=='swap':self.identity={**ID,'serial':'another'}
                        else:writer.write(b'< REP ERR >')
                    await writer.drain()
            except (OSError,asyncio.CancelledError):pass
            finally:self.writers.discard(writer);writer.close()
        self.peer=await asyncio.start_server(peer,'127.0.0.1',0)
        item=self.runtime.plugins.active['shure-scp'];control=item['control'];control.port=self.peer.sockets[0].getsockname()[1]
        control.legacy.identity_provider=lambda _:self.identity
        control.legacy.mac_provider=lambda _:self.mac
        raw=await asyncio.to_thread(legacy_probe,item['namespace'].load('shure_active_discovery.py'),'127.0.0.1',
            port=control.port,identity_provider=None if direct else lambda _:ID,mac_provider=lambda _:MAC)
        self.assertTrue(raw['settings']['legacy_control_identity']);self.raw=raw;self.rid=raw['receiver_id'];self.stream='c'*32
        async def emit():
            while True:
                observation=copy.deepcopy(raw);now=int(time.time()*1000)
                observation['channels']['1'].update(frequency_khz=self.value,muted=self.muted,meter_state='live',
                    meter_stream_id=self.stream,meter_received_at_ms=now,field_times={'frequency_khz':now,'muted':now})
                self.b._accept_shure_observation(observation)
                await asyncio.sleep(.08)
        self.emitter=asyncio.create_task(emit());await asyncio.sleep(.1)
        async def close():
            self.emitter.cancel();await asyncio.gather(self.emitter,return_exceptions=True)
            for w in list(self.writers):w.close()
            self.peer.close();await self.peer.wait_closed()
        self.addAsyncCleanup(close)
        self.wires.clear()
        return control

    async def test_legacy_mute_unmute_frequency_real_journal_and_distinct_readback(self):
        await self.setup_legacy()
        targets=(await self.rpc('commands.targets'))['targets'];self.assertEqual(len(targets),5)
        for command,value in [('mute',True),('unmute',False),('set_freq',633000)]:
            body=self.body(command,value);request=self.ui.request('commands.request',body)
            await self.ui.send(request);result=(await self.ui.message())['result']
            self.assertEqual(result['state'],'readback_confirmed',result);self.assertEqual(result['actual_value'],value)
            proof=result['execution_evidence'];self.assertEqual(proof['receiver_serial'],ID['serial'])
            self.assertFalse(proof['execution_ack_supported']);self.assertEqual(proof['identity_basis'],'systemapi-serial-uuid-and-local-arp')
            self.assertEqual(self.runtime.journal.get(body['operation_id'])['state'],'readback_confirmed')
            n=len(self.executions);await self.ui.send(request);again=await self.ui.message()
            self.assertEqual(again['result']['state'],'readback_confirmed');self.assertEqual(len(self.executions),n)
        for connection,cmd in self.executions:
            i=self.wires.index((connection,cmd));self.assertNotEqual(self.wires[i+1][0],connection)
        self.assertEqual([v[1] for v in self.executions],['SET 1 AUDIO_MUTE ON','SET 1 AUDIO_MUTE OFF','SET 1 FREQUENCY 633000'])
        body=self.intent();await self.rpc('commands.request',body)
        await eventually(lambda:self.runtime.journal.get(body['operation_id'])['state']=='acknowledged')

    async def test_identity_mismatch_band_grid_mode_and_session_never_send(self):
        await self.setup_legacy()
        for changed in ({**ID,'serial':'other'},{**ID,'device_id':str(uuid.uuid4())},{**ID,'model':'ULXD4D'},None):
            self.identity=changed;r=await self.rpc('commands.request',self.body());self.assertEqual(r['state'],'not_sent')
        self.identity=ID;self.mac='02:00:00:00:00:B4'
        self.assertEqual((await self.rpc('commands.request',self.body()))['state'],'not_sent');self.mac=MAC
        self.failure='firmware';self.assertEqual((await self.rpc('commands.request',self.body()))['state'],'not_sent');self.failure=None
        for value in (631975,696025,632701):
            self.assertEqual((await self.rpc('commands.request',self.body('set_freq',value)))['state'],'not_sent')
        self.mode='1+2';self.assertEqual((await self.rpc('commands.request',self.body('set_freq',633000)))['state'],'not_sent')
        body=self.body();body['target']['receiver_session_id']='z'*32
        self.assertEqual((await self.rpc('commands.request',body))['state'],'rejected');self.assertEqual(self.executions,[])

    async def test_unknown_mismatch_is_retained_auto_review_does_not_replay(self):
        await self.setup_legacy();self.failure='mismatch';body=self.body()
        request=self.ui.request('commands.request',body);request['deadline_at_ms']=int(time.time()*1000)+2000
        await self.ui.send(request);reply=await self.ui.message();self.assertTrue(reply['ok'])
        result=reply['result'];self.assertEqual(result['state'],'unknown')
        await eventually(lambda:bool(self.runtime.journal.get(body['operation_id']).get('review')),timeout=6)
        result=self.runtime.journal.get(body['operation_id']);self.assertEqual(result['state'],'unknown');self.assertIsNone(result['execution_evidence'])
        self.assertEqual(len(self.executions),1)

    async def test_disconnect_and_swapped_identity_after_set_never_confirm_or_retry(self):
        await self.setup_legacy();self.failure='swap'
        body=self.body();result=await self.rpc('commands.request',body);self.assertEqual(result['state'],'unknown')
        self.assertEqual(len(self.executions),1);self.assertIsNone(result['execution_evidence'])

    async def test_disconnected_readback_is_unknown(self):
        await self.setup_legacy();self.failure='disconnect'
        result=await self.rpc('commands.request',self.body());self.assertEqual(result['state'],'unknown');self.assertEqual(len(self.executions),1)

    async def test_wrong_channel_readback_is_unknown(self):
        await self.setup_legacy();self.failure='wrong-channel'
        result=await self.rpc('commands.request',self.body());self.assertIn(result['state'],('unknown','timeout'));self.assertEqual(len(self.executions),1)

    async def test_missing_band_keeps_mute_but_frequency_disabled(self):
        await self.setup_legacy(False);d=self.b._state['devices'][self.rid+'_ch1'];caps=self.b._device_capabilities(d,d)
        self.assertTrue(caps['mute']);self.assertFalse(caps['write_frequency'])
        result=await self.rpc('commands.request',self.body('set_freq',633000));self.assertEqual(result['state'],'rejected')
        result=await self.rpc('commands.request',self.body());self.assertEqual(result['state'],'readback_confirmed')
        self.assertEqual(len(self.executions),1)

    async def test_cancelled_or_failed_commit_never_sends(self):
        control=await self.setup_legacy()
        record={**self.body(),'expected_value':True}
        with self.assertRaises(CommandError):await control.send(record,allowed=lambda:False)
        commit=self.runtime.journal.commit
        self.runtime.journal.commit=lambda c:(_ for _ in ()).throw(OSError('fixture failure'))
        try:self.assertFalse((await self.ui.call('commands.request',self.body()))['ok'])
        finally:self.runtime.journal.commit=commit
        self.assertEqual(self.executions,[])

    async def test_lost_mac_disables_control_without_reusing_previous_identity(self):
        control=await self.setup_legacy()
        self.emitter.cancel();await asyncio.gather(self.emitter,return_exceptions=True)
        item=self.runtime.plugins.active['shure-scp']
        raw=await asyncio.to_thread(legacy_probe,item['namespace'].load('shure_active_discovery.py'),'127.0.0.1',
            port=control.port,identity_provider=lambda _:ID,mac_provider=lambda _:None)
        raw['channels']['1'].update(meter_state='live',meter_stream_id=self.stream,meter_received_at_ms=int(time.time()*1000))
        self.b._accept_shure_observation(raw)
        d=self.b._state['devices'][self.rid+'_ch1'];self.assertIsNone(d['receiver_mac'])
        self.assertFalse(self.b._device_capabilities(d,d)['mute'])
        with self.assertRaises(CommandError):control.binding(d['id'])
        self.assertEqual(self.executions,[])

class Identity(unittest.TestCase):
    def test_local_mac_and_serial_must_match_label_binding(self):
        s={'receiver_mac':MAC,'receiver_serial':ID['serial'],'systemapi_device_id':ID['device_id']}
        registry={MAC:{'model':'ULXD4','band':'L51','receiver_serial':ID['serial'],'systemapi_device_id':ID['device_id']}}
        self.assertTrue(band_identity('ULXD4',s,registry)['verified'])
        self.assertFalse(band_identity('ULXD4',{**s,'receiver_serial':'other'},registry)['verified'])
        receiver={'ip':'127.0.0.1','model':'ULXD4','version':ID['firmware'],'settings':{**s,'legacy_control_identity':True}}
        self.assertTrue(validate_legacy_identity(receiver,lambda _:ID,lambda _:MAC))
        self.assertFalse(validate_legacy_identity(receiver,lambda _:ID,lambda _:None))

def load_tests(loader,tests,pattern):
    return unittest.TestSuite([loader.loadTestsFromTestCase(Identity),*(Legacy(n) for n in Legacy.__dict__ if n.startswith('test_'))])
