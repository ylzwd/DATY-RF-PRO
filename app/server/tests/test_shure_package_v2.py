import asyncio,base64,copy,json,unittest,uuid
from pathlib import Path
from unittest.mock import patch
from test_shure_legacy_control import Legacy
from test_plugin_install import ROOT,existing_package
from test_plugin_mqtt import ImportedShure
from plugin_install import PackageCatalog,PluginStore,PluginError
from m6_scope import RuntimeScope
from tls_support import load_config
from command_journal import ProcessLease,CommandError
from plugin_maintenance import replace_plugin
from test_shure_systemapi import page
from test_shure_metadata_recovery import Recovery
from test_plugin_auto_discovery import Automatic
from test_plugin_auto_discovery import LegacyPeer,ID
from m6_test_support import eventually

def current_package():
    text=(ROOT/'src/modules/plugin-source-catalog.js').read_text('utf-8')
    return base64.b64decode(json.loads(text.split('Object.freeze(',1)[1].rsplit(');',1)[0])[0]['base64'])

class Current(Legacy):
    async def install_shure(self):
        with patch('test_plugin_mqtt.existing_package',current_package),patch('shure_legacy.attach_legacy_support',side_effect=AssertionError('Host shim executed')),patch('shure_legacy_control.attach_legacy_control',side_effect=AssertionError('Host shim executed')):
            result=await super().install_shure()
        item=self.runtime.plugins.active['shure-scp'];self.assertEqual(item['release']['observation_format'],'shure-v2')
        self.assertTrue(type(item['control'].legacy).__module__.startswith('_daty_plugin_'))
        self.assertFalse(hasattr(item['discovery'],'systemapi'))
        self.assertEqual(item['discovery'].snapshot()['health']['provider'],'daty-scp')
        return result
    async def test_package_health_through_existing_mqtt_interfaces(self):
        await self.install_shure();item=self.runtime.plugins.active['shure-scp'];d=item['discovery'];ns=item['namespace']
        api=ns.load('shure_systemapi.py')
        # The active entry must neither instantiate the official monitor nor
        # make any official-service request, including from status/stop hooks.
        with patch.object(api.SystemApiMonitor,'__init__',side_effect=AssertionError('Official monitor constructed')), \
             patch.object(api.SystemApiClient,'get',side_effect=AssertionError('Official service queried')):
            entry=ns.load('shure_plugin.py')
            isolated=entry.ShurePluginDiscovery(lambda _:None,auto_scan=False,interfaces=lambda:[],probe=lambda *a,**k:None)
            isolated.start();isolated.stop()
            s=await self.rpc('plugins.status');health=s['plugins'][0]['health']
            self.assertEqual(health['provider'],'daty-scp');self.assertEqual(health['receivers_online'],0)
            self.assertEqual(health['monitoring'],{'total':0,'active':0,'recovering':0,'stale':0})
            discovery=(await self.rpc('discovery.status'))['body'];self.assertEqual(discovery['health'],health)
        self.assertNotIn('systemapi',s['plugins'][0]);self.assertNotIn('systemapi',discovery)
        self.assertNotIn('fixture-private-key',json.dumps(s))
    async def test_packaged_legacy_meter_factory_and_identity_fail_closed(self):
        await self.install_shure();item=self.runtime.plugins.active['shure-scp'];ns=item['namespace'];d=item['discovery']
        peer=LegacyPeer();self.addAsyncCleanup(asyncio.to_thread,peer.close);port=peer.server_address[1]
        legacy=ns.load('shure_legacy.py');module=ns.load('shure_active_discovery.py');entry=ns.load('shure_plugin.py')
        raw=await asyncio.to_thread(legacy.legacy_probe,module,'127.0.0.1',port=port,identity_provider=lambda _:ID)
        self.assertIsNotNone(raw)
        client=ns.load('shure_systemapi.py').SystemApiClient
        api_page=page();api_page['edges'][0]['node']['communicationProtocol']['address']='127.0.0.1'
        query=patch.object(client,'devices',return_value=api_page);query.start();self.addCleanup(query.stop)
        session=entry.ShureMeterSession
        entry.ShureMeterSession=lambda receiver,callback,**kwargs:session(receiver,callback,port=port,metadata_interval=.15,**kwargs)
        d.probe=lambda *a,**k:copy.deepcopy(raw);d.metering=True
        await asyncio.to_thread(d._visit,'127.0.0.1');did=raw['receiver_id']+'_ch1'
        await eventually(lambda:self.b._state['devices'].get(did,{}).get('rf')==-32)
        self.assertTrue(type(d.meters['127.0.0.1']).__module__.startswith('_daty_plugin_'))
        await eventually(lambda:self.b._state['devices'][did].get('freq')==632700)
        api_page['edges'][0]['node']['hardwareIdentity']['serialNumber']='another'
        await eventually(lambda:d.meters['127.0.0.1'].stop_event.is_set() or self.b._state['devices'][did]['shure'].get('meter_state')!='live')
        self.assertFalse(any(c.startswith('SET ') and ' METER_RATE ' not in c for c in peer.commands))
        d.stop()

class CurrentRecovery(Current,Recovery):pass
class CurrentAutomatic(Current,Automatic):pass

class Maintenance(ImportedShure):
    async def test_offline_update_lease_revision_receipt_and_next_process_activation(self):
        await self.install_shure();old=self.runtime.plugins.store.status();record=old['plugins'][0]
        root=Path(self.temp.name)
        settings={'schema':'daty-mqtt6-runtime-v1','database':str(root/'business.sqlite3'),'database_epoch':self.epoch,
            'archives':str(root/'archives'),'staging':str(root/'staging'),'runtime_directory':str(root/'runtime'),
            'pairing':str(self.fixture.path),'tls':str(self.tls),'ca_sha256':load_config(self.tls)[1]['ca_sha256'],
            'bind_host':'127.0.0.1','mqtt_port':0,'web_port':0,'public_directory':str(ROOT.parent/'public')}
        config=root/'runtime-config.json';config.write_text(json.dumps(settings),'utf-8')
        encoded=base64.b64encode(current_package()).decode();preview=await self.rpc('plugins.preview',{'package_base64':encoded})
        reply=await self.ui.call('plugins.install',{'package_base64':encoded,'sha256':preview['sha256'],'operation_id':uuid.uuid4().hex,'expected_revision':old['revision']})
        self.assertFalse(reply['ok']);self.assertIn('PLUGIN_UPDATE_REQUIRES_MAINTENANCE',json.dumps(reply))
        lease=ProcessLease(str(root/'business.sqlite3')+'.mqtt6-runtime-owner.lock')
        try:
            with self.assertRaises(CommandError):RuntimeScope(config)
        finally:lease.close()
        await self.close_peers();await self.runtime.close()
        scope=RuntimeScope(config)
        store=PluginStore(root/'plugins',PackageCatalog(ROOT/'contracts/trusted-plugin-packages.json'))
        args=dict(operation_id=uuid.uuid4().hex,expected_revision=old['revision'],expected_sha256=record['sha256'],actor='maintenance-test')
        try:
            with self.assertRaises(PluginError):replace_plugin(store,scope,current_package(),**{**args,'expected_sha256':'0'*64})
            self.assertEqual(store.status()['revision'],old['revision'])
            result=replace_plugin(store,scope,current_package(),**args);self.assertEqual(result['activation'],'pending')
            self.assertEqual(replace_plugin(store,scope,current_package(),**args),result)
            with self.assertRaises(PluginError):replace_plugin(store,scope,current_package(),**{**args,'actor':'other'})
            self.assertEqual(store.load_record(store.status()['plugins'][0])[0]['sha256'],preview['sha256'])
            self.assertTrue((store.root/'packages/shure-scp'/record['sha256']/'package.zip').is_file())
        finally:scope.close()
        # Separate interpreter re-verifies installed code, activates without live network,
        # and finishes the same durable pending receipt.
        import subprocess,sys
        script='''import sys,json
from pathlib import Path
from types import SimpleNamespace
r=Path(sys.argv[1]);sys.path[:0]=[str(r),*[str(r/f'prototypes/mqtt-stage{n}') for n in range(6,0,-1)]]
from plugin_install import PluginStore,PackageCatalog,SourceNamespace
s=PluginStore(sys.argv[2],PackageCatalog(r/'contracts/trusted-plugin-packages.json'))
record=s.status()['plugins'][0];item,root=s.load_record(record);ns=SourceNamespace(root,item)
d=ns.entry(item['release']['entrypoints']['discovery'])(lambda x:None,live=False,auto_scan=False,interfaces=lambda:[],probe=lambda *a,**k:None)
d.start();assert not hasattr(d,'systemapi');assert d.snapshot()['health']['provider']=='daty-scp';d.stop();ns.close();s.reconcile(record['id'],record['sha256'])
print(json.dumps(s.operation(sys.argv[3],'maintenance-test')))
'''
        out=subprocess.check_output([sys.executable,'-X','utf8','-B','-c',script,str(ROOT),str(store.root),args['operation_id']])
        self.assertEqual(json.loads(out)['activation'],'active')
