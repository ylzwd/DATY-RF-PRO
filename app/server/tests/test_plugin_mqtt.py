"""Real TLS/MQTT/SQLite and loopback Shure TCP only. Never contacts LAN devices."""
import asyncio,base64,copy,hashlib,json,subprocess,sys,unittest,uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from test_stage6 import Integration
from test_shure_control_chain import ControlChain
from test_plugin_install import existing_package,synthetic_package
from plugin_install import PluginError
from command_journal import CommandError
from m6_test_support import eventually
from test_plugin_install import ROOT

class ImportedShure(ControlChain):
    async def install_shure(self):
        encoded=base64.b64encode(existing_package()).decode()
        before=await self.rpc('plugins.status');self.assertEqual(before['plugins'],[])
        self.assertEqual(set((await self.rpc('state.capabilities'))['body']['adapters']),{'fashe-mqtt'})
        self.assertFalse(self.runtime.discovery.snapshot()['enabled'])
        preview=await self.rpc('plugins.preview',{'package_base64':encoded})
        body={'package_base64':encoded,'operation_id':uuid.uuid4().hex,'expected_revision':preview['revision'],'sha256':preview['sha256']}
        result=await self.rpc('plugins.install',body)
        self.assertEqual(result['activation'],'active')
        self.assertEqual(await self.rpc('plugins.operation',{'operation_id':body['operation_id']}),result)
        self.assertEqual(await self.rpc('plugins.install',body),result)
        control=self.runtime.plugins.active['shure-scp']['control']
        self.assertTrue(type(control).__module__.startswith('_daty_plugin_shure_scp_'))
        self.assertIn('shure-scp',(await self.rpc('state.capabilities'))['body']['adapters'])
        self.install_body=body
        return result
    async def setup_shure(self):
        import shure_hardware
        label=patch.object(shure_hardware,'hardware_registry',lambda:{'00:0E:DD:AD:31:A3':{'model':'ULXD4','band':'L51'}})
        label.start();self.addCleanup(label.stop)  # Fixture identity only; no site registry access.
        await self.install_shure();await super().setup_shure()
        self.runtime.plugins.active['shure-scp']['control'].port=self.peer.sockets[0].getsockname()[1]
    async def test_imported_discovery_continues_telemetry_and_group_identity(self):
        await self.install_shure();proxy=self.runtime.discovery
        self.runtime.discovery=self.runtime.plugins.active['shure-scp']['discovery']
        try:await Integration.test_shure_manual_scan_continues_reading_over_mqtt(self)
        finally:self.runtime.discovery=proxy
    async def test_imported_rf_af_real_tcp_mqtt_and_persistence(self):
        await self.install_shure()
        session=self.runtime.plugins.active['shure-scp']['namespace'].load('shure_metering.py').ShureMeterSession
        with patch('shure_metering.ShureMeterSession',session):
            await Integration.test_shure_continuous_meter_tcp_mqtt_and_saved_samples(self)
    async def test_imported_battery_real_tcp_mqtt_and_persistence(self):
        await self.install_shure()
        session=self.runtime.plugins.active['shure-scp']['namespace'].load('shure_metering.py').ShureMeterSession
        with patch('shure_metering.ShureMeterSession',session):
            await Integration.test_shure_battery_startup_tcp_mqtt_and_saved_samples(self)
    async def test_uninstalled_and_failed_import_do_not_enable_shure(self):
        self.assertEqual((await self.rpc('plugins.status'))['plugins'],[])
        self.assertFalse(self.b._accept_shure_observation({}))
        with self.assertRaises(CommandError):self.runtime.commands.adapter.binding('Shure-unknown_ch1')
        r=await self.ui.call('discovery.scan',{});self.assertFalse(r['ok']);self.assertIn('BRAND_PLUGIN_NOT_INSTALLED',json.dumps(r))
        for raw in (b'bad zip',existing_package()+b'changed'):
            r=await self.ui.call('plugins.preview',{'package_base64':base64.b64encode(raw).decode()});self.assertFalse(r['ok'])
        self.assertFalse(self.runtime.plugins.active);self.assertIsNone(self.runtime.discovery.target)
        targets=await self.rpc('commands.targets');self.assertEqual(len(targets['targets']),4)
        body=self.intent();await self.rpc('commands.request',body)
        await eventually(lambda:self.runtime.journal.get(body['operation_id'])['state']=='acknowledged')
        self.assertEqual(self.runtime.journal.get(body['operation_id'])['actual_value'],True)
        from plugin_runtime import BuiltinEnrollment
        from receiver_enrollment import EnrollmentError
        with self.assertRaises(EnrollmentError):BuiltinEnrollment(self.fixture.policy,self.tls).challenge({'brand':'Shure'},'127.0.0.1')
    async def test_preview_stale_revision_server_and_expired_install(self):
        encoded=base64.b64encode(existing_package()).decode();preview=await self.rpc('plugins.preview',{'package_base64':encoded})
        self.assertEqual(self.runtime.plugins.active,{})
        body={'package_base64':encoded,'operation_id':uuid.uuid4().hex,'expected_revision':99,'sha256':preview['sha256']}
        r=await self.ui.call('plugins.install',body);self.assertFalse(r['ok'])
        body['expected_revision']=0
        for changed in ({'deadline_at_ms':1},{'boot_id':'0'*32}):
            request=self.ui.request('plugins.install',body);request.update(changed)
            await self.ui.send(request);self.assertFalse((await self.ui.message())['ok'])
        self.assertEqual(self.runtime.plugins.active,{})
    async def test_second_brand_uses_shared_installer_identity_feed_and_router(self):
        raw,release=synthetic_package();self.runtime.plugins.store.catalog.releases[release['sha256']]=release
        encoded=base64.b64encode(raw).decode();preview=await self.rpc('plugins.preview',{'package_base64':encoded})
        result=await self.rpc('plugins.install',{'package_base64':encoded,'operation_id':uuid.uuid4().hex,'expected_revision':preview['revision'],'sha256':preview['sha256']})
        self.assertEqual(result['activation'],'active')
        item=self.runtime.plugins.active[release['id']]
        receiver={'receiver_id':'fixture-mac-001','receiver_ip':'127.0.0.1','model':'TEST-2','channels':{'1':{'channel_number':1,'frequency_khz':630000,'rf_dbm':-65,'audio_dbfs':-18,'battery_percent':80,'muted':False}}}
        count=self.runtime.fixture.policy.status()['assigned_receivers']
        bad=copy.deepcopy(receiver);bad['channels']['1']['frequency_khz']=630000.5
        with self.assertRaises(PluginError):item['discovery'].on_update(bad)
        self.assertEqual(self.runtime.fixture.policy.status()['assigned_receivers'],count)
        item['discovery'].on_update(receiver)
        did='plugin:fixture-brand:fixture-mac-001_ch1'
        snapshot=await self.rpc('devices.snapshot');device=next(d for d in snapshot['devices'] if d['id']==did)
        self.assertEqual((device['group_number'],device['freq'],device['af_dbfs'],device['batt']),(3,630000,-18,80))
        self.assertIs(self.runtime.commands.adapter.owner(did),item['control'])
        caps=(await self.rpc('state.capabilities'))['body']['adapters'];self.assertEqual(caps['fixture-protocol']['brand'],'Fixture Brand')
        self.assertNotIn('shure-scp',caps)
        status=await self.rpc('plugins.status');installed=next(p for p in status['plugins'] if p['id']==release['id'])
        self.assertTrue(installed['active']);self.assertNotIn('health',installed)
    async def test_process_restart_rechecks_installation_and_rejects_tampering(self):
        from tls_support import load_config
        await self.install_shure()
        root=Path(self.temp.name);record=self.runtime.plugins.store.status()['plugins'][0]
        _,source=self.runtime.plugins.store.load_record(record)
        target=source/'shure_fields.py';original=target.read_bytes()
        identities={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in (self.fixture.path,self.tls)}
        settings={'schema':'daty-mqtt6-runtime-v1','database':str(root/'business.sqlite3'),'database_epoch':self.epoch,
            'archives':str(root/'archives'),'staging':str(root/'staging'),'runtime_directory':str(root/'runtime'),
            'pairing':str(self.fixture.path),'tls':str(self.tls),'ca_sha256':load_config(self.tls)[1]['ca_sha256'],
            'bind_host':'127.0.0.1','mqtt_port':0,'web_port':0,'public_directory':str(ROOT.parent/'public')}
        config=root/'runtime-config.json';config.write_text(json.dumps(settings),'utf-8')
        await self.close_peers();await self.runtime.close()
        for n in range(1,7):(root/f'.daty-mqtt-stage{n}-fixture').unlink()
        script='''import sys,asyncio,json
from pathlib import Path
root=Path(sys.argv[1]);sys.path[:0]=[str(root),str(root/'tests'),str(root/'prototypes/mqtt-stage6'),sys.argv[4]]
from m6_runtime import Runtime
from m6_scope import RuntimeScope
async def main():
    scope=RuntimeScope(sys.argv[2]);runtime=Runtime(scope.runtime_directory,sys.argv[3],runtime_scope=scope)
    try:
        from unittest.mock import patch
        # A leased temporary scope is live-shaped, but this remains an offline
        # installation/restart test; automatic LAN discovery is tested separately.
        from plugin_runtime import PluginManager
        original_start=PluginManager.start
        def offline_start(manager):
            manager.live=False
            return original_start(manager)
        with patch('plugin_discovery.AutoDiscovery.start'),patch.object(PluginManager,'start',offline_start):
            await runtime.start()
        print('PLUGIN_RESTART_RESULT='+json.dumps(runtime.plugins.status()))
    finally:await runtime.close()
asyncio.run(main())
'''
        async def restart():
            args=[sys.executable,'-c',script,str(ROOT),str(config),str(self.runtime.broker),str(Path(sys.executable).parents[1]/'pylib')]
            result=await asyncio.to_thread(subprocess.run,args,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=40,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr)
            return json.loads(next(line.split('=',1)[1] for line in result.stdout.splitlines() if line.startswith('PLUGIN_RESTART_RESULT=')))
        first=await restart();self.assertTrue(first['plugins'][0]['active'])
        target.write_bytes(original+b'\n#fixture tamper')
        failed=await restart();self.assertFalse(failed['plugins'][0]['active']);self.assertEqual(failed['plugins'][0]['activation'],'failed')
        target.write_bytes(original)
        restored=await restart();self.assertTrue(restored['plugins'][0]['active'])
        self.assertEqual({p:hashlib.sha256(p.read_bytes()).hexdigest() for p in identities},identities)

def load_tests(loader,tests,pattern):
    names=[name for name in ControlChain.__dict__ if name.startswith('test_')]
    names+=['test_uninstalled_and_failed_import_do_not_enable_shure','test_preview_stale_revision_server_and_expired_install','test_second_brand_uses_shared_installer_identity_feed_and_router','test_process_restart_rechecks_installation_and_rejects_tampering']
    names+=['test_imported_discovery_continues_telemetry_and_group_identity','test_imported_rf_af_real_tcp_mqtt_and_persistence','test_imported_battery_real_tcp_mqtt_and_persistence']
    return unittest.TestSuite(ImportedShure(name) for name in names)
