"""Reproducible isolated recovery, plugin, DATY ACK and Shure readback tests."""
from pathlib import Path
from types import SimpleNamespace
import asyncio,json,subprocess,sys,unittest
# This entry point only constructs Integration fixtures on loopback.
import argparse,hashlib
R=Path(__file__).resolve().parents[1]
local_path=R/'config/development.local.json'
local=json.loads(local_path.read_bytes()) if local_path.exists() else {}
parser=argparse.ArgumentParser(description='Isolated native MQTT/TLS/SQLite and Shure simulation tests; no production endpoint option')
parser.add_argument('--dotnet',default=local.get('dotnetSdk'))
parser.add_argument('--tools',default=local.get('runtimeTools',str(R/'app/tools')))
parser.add_argument('--output',default=str(R/'verification/native-integration'))
parser.add_argument('--case',action='append',help='Run selected NativeIntegration test method(s) only')
args=parser.parse_args()
if not args.dotnet:parser.error('Configure dotnetSdk in config/development.local.json or pass --dotnet')
DOTNET=str(Path(args.dotnet).resolve());T=Path(args.tools).resolve()
S=R/'app/server';N=R/'native';W=Path(args.output).resolve();W.mkdir(parents=True,exist_ok=True)
for required in (Path(DOTNET),T/'broker/mosquitto.exe',T/'pylib'):
    if not required.exists():parser.error('Missing local dependency: '+str(required))
sys.path[:0]=[str(S),str(S/'tests'),str(S/'prototypes/mqtt-stage6'),str(T/'pylib')]
import test_stage6
from test_stage6 import Integration
from tls_support import load_config
test_stage6.OPTIONS=SimpleNamespace(broker=str(T/'broker/mosquitto.exe'),output=str(W))
EXE=N/'tests/Daty.Native.Mqtt.Tests/bin/Release/net10.0/Daty.Native.Mqtt.Tests.dll'
ZIP=R/'plugins/packages/DATY-shure-scp-source-3aee959ed650.zip'
if not EXE.exists():parser.error('Build native/DATY.RF.Native.slnx in Release first')
assert hashlib.sha256(ZIP.read_bytes()).hexdigest()=='b6e7055ab3b3dbe45a094b01f9c483219269742d28afb5757e8ea9dfecfb5b12','Shure fixture package changed'
async def probe(config,name):
    path=W/(name+'-config.json');path.write_text(json.dumps(config),'utf-8')
    result=await asyncio.to_thread(subprocess.run,[DOTNET,str(EXE),str(path)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=160,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    (W/(name+'.log')).write_text(result.stdout+'\n'+result.stderr,'utf-8')
    assert result.returncode==0,result.stdout+'\n'+result.stderr
    evidence=json.loads(result.stdout.strip().splitlines()[-1]);assert evidence['ok']
    (W/(name+'.json')).write_text(json.dumps(evidence,ensure_ascii=False,indent=2),'utf-8')
    return evidence
class NativeIntegration(Integration):
    async def test_spectrum_settings_and_process_restart(self):
        app=N/'src/Daty.Native.App/bin/Release/net10.0-windows/DATY.RF.Native.dll'
        previous=None
        for mode in ('spectrum-write','spectrum-read','spectrum-recovery'):
            output=W/(mode+'.json');config=W/(mode+'-config.json')
            config.write_text(json.dumps({'origin':'https://127.0.0.1:8080','port':self.runtime.port,'ca':str(load_config(self.tls)[0]['ca_file']),
                'root':self.temp.name,'output':str(output),'mode':mode}),'utf-8')
            result=await asyncio.to_thread(subprocess.run,[DOTNET,str(app),'--verify-r19-fixture',str(config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=80,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            failure=Path(str(config)+'.failure.txt')
            self.assertEqual(result.returncode,0,(failure.read_text('utf-8') if failure.exists() else '')+result.stdout+result.stderr)
            evidence=json.loads(output.read_bytes());self.assertTrue(evidence['ok'])
            if mode=='spectrum-read':self.assertEqual(previous,evidence['records'],'fresh process reads committed thresholds without reseeding')
            previous=evidence['records']
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))
    async def test_integrated_runtime_status(self):
        app=N/'src/Daty.Native.App/bin/Release/net10.0-windows/DATY.RF.Native.dll'
        output=W/'runtime-status.json';config=W/'runtime-status-config.json'
        config.write_text(json.dumps({'origin':'https://127.0.0.1:8080','port':self.runtime.port,'ca':str(load_config(self.tls)[0]['ca_file']),
            'root':self.temp.name,'output':str(output),'mode':'runtime-status'}),'utf-8')
        result=await asyncio.to_thread(subprocess.run,[DOTNET,str(app),'--verify-r19-fixture',str(config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=45,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        failure=Path(str(config)+'.failure.txt')
        self.assertEqual(result.returncode,0,(failure.read_text('utf-8') if failure.exists() else '')+result.stdout+result.stderr)
        self.assertTrue(json.loads(output.read_bytes())['ok'])
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))
    async def test_initial_settings_recovery(self):
        app=N/'src/Daty.Native.App/bin/Release/net10.0-windows/DATY.RF.Native.dll'
        output=W/'settings-initial-recovery.json';config=W/'settings-initial-recovery-config.json'
        config.write_text(json.dumps({'origin':'https://127.0.0.1:8080','port':self.runtime.port,'ca':str(load_config(self.tls)[0]['ca_file']),
            'root':self.temp.name,'output':str(output),'mode':'settings-initial-recovery'}),'utf-8')
        result=await asyncio.to_thread(subprocess.run,[DOTNET,str(app),'--verify-r19-fixture',str(config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=80,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        failure=Path(str(config)+'.failure.txt')
        self.assertEqual(result.returncode,0,(failure.read_text('utf-8') if failure.exists() else '')+result.stdout+result.stderr)
        self.assertTrue(json.loads(output.read_bytes())['ok'])
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))
    async def test_native_transport_recovery(self):
        await self.native_recovery(writer=False)
    async def test_native_writer_recovery(self):
        await self.native_recovery(writer=True)
    async def native_recovery(self, *, writer):
        from m6_test_support import eventually
        name='native-writer' if writer else 'native-transport'
        output=W/(name+'-recovery.json');ready=W/(name+'-ready.txt');config=W/(name+'-config.json')
        assert not ready.exists(),'Use a new output directory for this fault injection'
        config.write_text(json.dumps({'origin':'https://127.0.0.1:8080','port':self.runtime.port,'ca':str(load_config(self.tls)[0]['ca_file']),
            'output':str(output),'ready':str(ready),'mode':'transport-recovery'}),'utf-8')
        task=asyncio.create_task(asyncio.to_thread(subprocess.run,[DOTNET,str(EXE),str(config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=100,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0)))
        try:
            await eventually(ready.exists,timeout=20)
            process=self.b._unified_runtime._worker.process if writer else self.runtime.process
            process.terminate();await asyncio.to_thread(process.wait,5)
            await eventually(lambda:self.runtime.transport.recoveries==1 and self.runtime.transport.ready,timeout=15)
            for receiver in self.receivers:
                await receiver.close();await receiver.start()
            result=await task
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertTrue(json.loads(output.read_bytes())['ok'])
            if writer:
                state=self.b._unified_runtime.status()
                self.assertTrue(state['writable']);self.assertEqual(state['recovery']['recoveries'],1)
            self.assertTrue(all(not r.executions for r in self.receivers))
        finally:
            if not task.done():await task
    async def test_settings_save_all_and_restart(self):
        import sqlite3
        from contextlib import closing
        app=N/'src/Daty.Native.App/bin/Release/net10.0-windows/DATY.RF.Native.dll'
        previous=None
        for mode in ('settings-save-all','settings-save-all-read'):
            output=W/(mode+'.json');config=W/(mode+'-config.json')
            config.write_text(json.dumps({'origin':'https://127.0.0.1:8080','port':self.runtime.port,'ca':str(load_config(self.tls)[0]['ca_file']),
                'root':self.temp.name,'output':str(output),'mode':mode}),'utf-8')
            result=await asyncio.to_thread(subprocess.run,[DOTNET,str(app),'--verify-r19-fixture',str(config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=100,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            failure=Path(str(config)+'.failure.txt');self.assertEqual(result.returncode,0,(failure.read_text('utf-8') if failure.exists() else '')+result.stdout+result.stderr)
            evidence=json.loads(output.read_bytes());self.assertTrue(evidence['ok'])
            with closing(sqlite3.connect(Path(self.temp.name)/'business.sqlite3')) as c:
                for id,record in evidence['records'].items():
                    row=c.execute('SELECT revision,metadata_json FROM biz_settings WHERE id=? AND deleted=0',(id,)).fetchone()
                    self.assertIsNotNone(row);self.assertEqual(row[0],record['revision']);self.assertEqual(json.loads(row[1]),record['value'])
            if previous:self.assertEqual(previous,evidence['records'],'new native process restores exact committed settings without a write')
            previous=evidence['records']
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))
    async def test_manual_shure_frequency(self):
        import base64,uuid,time
        from unittest.mock import patch
        import shure_hardware
        label=patch.object(shure_hardware,'hardware_registry',lambda:{'00:0E:DD:AD:31:A3':{'model':'ULXD4','band':'L51'}})
        label.start();self.addCleanup(label.stop)  # Explicit fixture-only hardware identity, no production files.
        encoded=base64.b64encode(ZIP.read_bytes()).decode()
        preview=await self.rpc('plugins.preview',{'package_base64':encoded})
        await self.rpc('plugins.install',{'package_base64':encoded,'sha256':preview['sha256'],'expected_revision':preview['revision'],'operation_id':uuid.uuid4().hex})
        for index,receiver in enumerate(self.receivers):
            for ch in receiver.values:receiver.values[ch]['freq_mhz']=[640,645,663,670][index*2+ch-1]
            await receiver.publish('daty/rf/devices/up',{'type':'device_status_update','control_protocol':'fashe-realtime-v1','devices':[
                {'channel':ch,'channel_number':ch,'brand':'DATYaudio',**value} for ch,value in receiver.values.items()]})
        from test_shure_control_chain import ControlChain,MAC
        await ControlChain.setup_shure(self)
        self.runtime.plugins.active['shure-scp']['control'].port=self.peer.sockets[0].getsockname()[1]
        self.emitter.cancel();await asyncio.gather(self.emitter,return_exceptions=True)
        async def actual_telemetry():
            while True:
                self.b._accept_shure_observation({'receiver_id':self.rid,'receiver_ip':'127.0.0.1','model':'ULXD4','protocol_verified':True,
                    'settings':{'receiver_mac':MAC,'network_ip':'127.0.0.1','high_density':False,'frequency_diversity_mode':'OFF'},
                    'channels':{'1':{'channel_number':1,'frequency_khz':self.value,'muted':self.muted,'meter_state':'live','meter_stream_id':self.stream,'meter_received_at_ms':int(time.time()*1000)}}})
                await asyncio.sleep(.05)
        self.emitter=asyncio.create_task(actual_telemetry());await asyncio.sleep(.15)
        app=N/'src/Daty.Native.App/bin/Release/net10.0-windows/DATY.RF.Native.dll'
        output=W/'shure-manual.json';config=W/'shure-manual-config.json'
        config.write_text(json.dumps({'origin':'https://127.0.0.1:8080','port':self.runtime.port,'ca':str(load_config(self.tls)[0]['ca_file']),
            'root':self.temp.name,'output':str(output),'mode':'shure-manual'}),'utf-8')
        result=await asyncio.to_thread(subprocess.run,[DOTNET,str(app),'--verify-r19-fixture',str(config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=80,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        failure=Path(str(config)+'.failure.txt');self.assertEqual(result.returncode,0,(failure.read_text('utf-8') if failure.exists() else '')+result.stdout+result.stderr)
        self.assertTrue(json.loads(output.read_bytes())['ok'])
        self.assertEqual([wire for wire in self.wires if wire.startswith('< SET')],['< SET 1 FREQUENCY 678000 >'])
        self.assertTrue(all(not r.executions for r in self.receivers))
    async def test_table_edit_manual_frequency(self):
        for index,receiver in enumerate(self.receivers):
            for ch in receiver.values:receiver.values[ch]['freq_mhz']=[640,645,670,690][index*2+ch-1]
            await receiver.publish('daty/rf/devices/up',{'type':'device_status_update','control_protocol':'fashe-realtime-v1','devices':[
                {'channel':ch,'channel_number':ch,'brand':'DATYaudio',**value} for ch,value in receiver.values.items()]})
        await asyncio.sleep(.15)
        app=N/'src/Daty.Native.App/bin/Release/net10.0-windows/DATY.RF.Native.dll'
        output=W/'table-edit-deploy.json';config=W/'table-edit-deploy-config.json'
        config.write_text(json.dumps({'origin':'https://127.0.0.1:8080','port':self.runtime.port,'ca':str(load_config(self.tls)[0]['ca_file']),
            'root':self.temp.name,'output':str(output),'mode':'table-edit-deploy'}),'utf-8')
        result=await asyncio.to_thread(subprocess.run,[DOTNET,str(app),'--verify-r19-fixture',str(config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=100,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        failure=Path(str(config)+'.failure.txt');self.assertEqual(result.returncode,0,(failure.read_text('utf-8') if failure.exists() else '')+result.stdout+result.stderr)
        evidence=json.loads(output.read_bytes());self.assertTrue(evidence['ok'])
        executions=[command for receiver in self.receivers for command in receiver.executions]
        self.assertEqual(len(executions),1,'invalid/cancelled/unchanged frequency must never send')
        self.assertEqual(executions[0]['command'],'set_freq');self.assertEqual(executions[0]['value'],641.0)
        record=await self.rpc('database.resources.get',{'kind':'settings','id':'frequency_planning'})
        self.assertEqual(record.get('body',record)['resource']['value']['locks'],[])
    async def test_planning_configuration_and_process_restart(self):
        app=N/'src/Daty.Native.App/bin/Release/net10.0-windows/DATY.RF.Native.dll'
        previous=None
        for mode in ('planning-write','planning-read','planning-draft-write','planning-draft-read','planning-conflict'):
            output=W/(mode+'.json');config=W/(mode+'-config.json')
            config.write_text(json.dumps({'origin':'https://127.0.0.1:8080','port':self.runtime.port,'ca':str(load_config(self.tls)[0]['ca_file']),
                'root':self.temp.name,'output':str(output),'mode':mode}),'utf-8')
            result=await asyncio.to_thread(subprocess.run,[DOTNET,str(app),'--verify-r19-fixture',str(config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=80,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            failure=Path(str(config)+'.failure.txt');self.assertEqual(result.returncode,0,(failure.read_text('utf-8') if failure.exists() else '')+result.stdout+result.stderr)
            evidence=json.loads(output.read_bytes());self.assertTrue(evidence['ok'])
            for id,record in evidence['records'].items():
                reply=await self.rpc('database.resources.get',{'kind':'settings','id':id})
                actual=reply.get('body',reply)['resource']
                self.assertEqual(actual['value'],record['value']);self.assertEqual(actual['revision'],record['revision'])
            if mode.endswith('-read'):self.assertEqual(previous,evidence['records'],'fresh process must restore drafts without rewriting defaults')
            previous=evidence['records']
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))
    async def test_native_window_shutdown(self):
        app=N/'src/Daty.Native.App/bin/Release/net10.0-windows/DATY.RF.Native.dll'
        for mode in ('close-connected','close-inflight','close-settings','close-planning'):
            output=W/(mode+'.json');config=W/(mode+'-config.json')
            config.write_text(json.dumps({'origin':'https://127.0.0.1:8080','port':self.runtime.port,'ca':str(load_config(self.tls)[0]['ca_file']),
                'root':self.temp.name,'output':str(output),'mode':mode}),'utf-8')
            result=await asyncio.to_thread(subprocess.run,[DOTNET,str(app),'--verify-r19-fixture',str(config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=45,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            failure=Path(str(config)+'.failure.txt');self.assertEqual(result.returncode,0,(failure.read_text('utf-8') if failure.exists() else '')+result.stdout+result.stderr)
            self.assertTrue(json.loads(output.read_bytes())['ok'])
        reply=await self.rpc('database.resources.get',{'kind':'settings','id':'alert_sound'})
        self.assertTrue(reply.get('body',reply)['resource']['value']['enabled'])
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))
    async def test_immediate_settings_and_process_restart(self):
        app=N/'src/Daty.Native.App/bin/Release/net10.0-windows/DATY.RF.Native.dll'
        previous=None
        for mode in ('settings-write','settings-read'):
            output=W/(mode+'.json');config=W/(mode+'-config.json')
            config.write_text(json.dumps({'origin':'https://127.0.0.1:8080','port':self.runtime.port,'ca':str(load_config(self.tls)[0]['ca_file']),
                'root':self.temp.name,'output':str(output),'mode':mode}),'utf-8')
            result=await asyncio.to_thread(subprocess.run,[DOTNET,str(app),'--verify-r19-fixture',str(config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=80,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            failure=Path(str(config)+'.failure.txt');self.assertEqual(result.returncode,0,(failure.read_text('utf-8') if failure.exists() else '')+result.stdout+result.stderr)
            evidence=json.loads(output.read_bytes());self.assertTrue(evidence['ok'])
            for id,record in evidence['records'].items():
                reply=await self.rpc('database.resources.get',{'kind':'settings','id':id})
                actual=reply.get('body',reply)['resource']
                self.assertEqual(actual['value'],record['value']);self.assertEqual(actual['revision'],record['revision'])
            if previous:self.assertEqual(previous,evidence['records'],'fresh process must read existing settings without rewriting defaults')
            previous=evidence['records']
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))
    async def test_native_pending_recovery(self):
        self.receivers[0].acknowledge=False
        intent=self.intent();reply=await self.rpc('commands.request',intent)
        for _ in range(160):
            receipt=await self.rpc('commands.get',{'operation_id':intent['operation_id']})
            if receipt['state']=='timeout':break
            await asyncio.sleep(.1)
        self.assertEqual(receipt['state'],'timeout')
        self.assertEqual(len(self.receivers[0].executions),1)
        self.receivers[0].acknowledge=True
        async def fresh_state():
            while True:
                await self.receivers[0].publish('daty/rf/devices/up',{'type':'device_status_update','channel':1,'muted':True})
                await asyncio.sleep(.25)
        telemetry=asyncio.create_task(fresh_state())
        async def stop_telemetry():
            telemetry.cancel();await asyncio.gather(telemetry,return_exceptions=True)
        self.addAsyncCleanup(stop_telemetry)
        origin='https://127.0.0.1:8080';pending={'server':origin,'mqtt_port':self.runtime.port,**intent}
        output=W/'isolated-recovery.json';config=W/'isolated-recovery-config.json'
        config.write_text(json.dumps({'origin':origin,'port':self.runtime.port,'ca':str(load_config(self.tls)[0]['ca_file']),
            'root':self.temp.name,'output':str(output),'mode':'recovery','pending':pending}),'utf-8')
        app=N/'src/Daty.Native.App/bin/Release/net10.0-windows/DATY.RF.Native.dll'
        result=await asyncio.to_thread(subprocess.run,[DOTNET,str(app),'--verify-r19-fixture',str(config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=70,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        failure=Path(str(config)+'.failure.txt');self.assertEqual(result.returncode,0,(failure.read_text('utf-8') if failure.exists() else '')+result.stdout+result.stderr)
        self.assertTrue(json.loads(output.read_bytes())['ok'])
        self.assertEqual(sum(len(r.executions) for r in self.receivers),4)
        self.assertEqual(sum(c['command_id']==receipt['command_id'] for r in self.receivers for c in r.executions),1)
        reviewed=await self.rpc('commands.get',{'operation_id':intent['operation_id']})
        self.assertEqual(reviewed['state'],'timeout');self.assertIsNone(reviewed['execution_evidence']);self.assertTrue(reviewed['review']['confirmed'])
    async def test_native_real_protocol_and_import(self):
        config={'origin':'https://127.0.0.1:8080','port':self.runtime.port,'ca':str(load_config(self.tls)[0]['ca_file']),
            'zip':str(ZIP),'pending':str(Path(self.temp.name)/'pending.json'),'mode':'fixture'}
        result=await probe(config,'isolated-native')
        self.assertEqual(result['revision'],1)
        with self.runtime.plugins.store.connection() as c:self.assertEqual(c.execute('SELECT count(*) FROM operations').fetchone()[0],1)
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))
        action_config=W/'isolated-actions-config.json'
        action_output=W/'isolated-actions.json'
        action_config.write_text(json.dumps({'origin':config['origin'],'port':config['port'],'ca':config['ca'],'root':self.temp.name,'output':str(action_output)}),'utf-8')
        app=N/'src/Daty.Native.App/bin/Release/net10.0-windows/DATY.RF.Native.dll'
        process=await asyncio.to_thread(subprocess.run,[DOTNET,str(app),'--verify-r19-fixture',str(action_config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=150,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        failure=Path(str(action_config)+'.failure.txt')
        self.assertEqual(process.returncode,0,(failure.read_text('utf-8') if failure.exists() else '')+process.stdout+process.stderr)
        self.assertTrue(json.loads(action_output.read_text('utf-8'))['ok'])
        self.assertEqual(sum(len(receiver.executions) for receiver in self.receivers),2)
        from test_shure_control_chain import ControlChain
        await ControlChain.setup_shure(self)
        self.runtime.plugins.active['shure-scp']['control'].port=self.peer.sockets[0].getsockname()[1]
        await asyncio.sleep(.2)
        shure_config=W/'isolated-shure-config.json';shure_output=W/'isolated-shure.json'
        shure_config.write_text(json.dumps({'origin':config['origin'],'port':config['port'],'ca':config['ca'],'root':self.temp.name,'output':str(shure_output),'mode':'shure'}),'utf-8')
        process=await asyncio.to_thread(subprocess.run,[DOTNET,str(app),'--verify-r19-fixture',str(shure_config)],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=50,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        failure=Path(str(shure_config)+'.failure.txt')
        self.assertEqual(process.returncode,0,(failure.read_text('utf-8') if failure.exists() else '')+process.stdout+process.stderr)
        self.assertTrue(json.loads(shure_output.read_text('utf-8'))['ok'])
        self.assertEqual([w for w in self.wires if w.startswith('< SET')],['< SET 1 AUDIO_MUTE ON >','< SET 1 AUDIO_MUTE OFF >'])
        self.assertEqual(sum(len(receiver.executions) for receiver in self.receivers),2)
        config.update(mode='tls_failure',ca=str(N/'assets/DATY-root-ca.cer'))
        await probe(config,'wrong-ca')
if __name__=='__main__':
    defaults=['test_manual_shure_frequency','test_table_edit_manual_frequency','test_native_pending_recovery','test_native_real_protocol_and_import','test_immediate_settings_and_process_restart','test_settings_save_all_and_restart','test_planning_configuration_and_process_restart','test_native_window_shutdown']
    defaults.append('test_native_transport_recovery')
    defaults.append('test_native_writer_recovery')
    defaults.append('test_initial_settings_recovery')
    defaults.append('test_integrated_runtime_status')
    defaults.append('test_spectrum_settings_and_process_restart')
    selected=args.case or defaults
    if any(name not in defaults for name in selected):parser.error('Unknown test case; choose from '+', '.join(defaults))
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(NativeIntegration(name) for name in selected))
    raise SystemExit(not result.wasSuccessful())
