"""Removal authorization, drain, real inventory and durable recovery; loopback only."""
import asyncio,base64,hashlib,json,subprocess,sys,uuid,threading
from pathlib import Path
from unittest.mock import patch
from test_shure_package_v2 import Current,current_package
from test_plugin_install import ROOT
from plugin_install import PluginError
from command_journal import CommandError
from m6_test_support import eventually

class Removal(Current):
    async def test_slow_file_cleanup_does_not_block_registry_reads_or_reinstall_gate(self):
        await self.install_shure();removal=self.runtime.plugins.removal
        entered=threading.Event();release=threading.Event();original=removal.purge
        def slow(identity):
            entered.set()
            if not release.wait(5):raise TimeoutError('fixture release')
            original(identity)
        with patch.object(removal,'purge',side_effect=slow):
            try:
                body=await self.removal_body();await self.rpc('plugins.remove_exported',body)
                self.assertTrue(await asyncio.to_thread(entered.wait,2))
                state=await asyncio.wait_for(self.rpc('plugins.status'),.8)
                self.assertEqual(state['plugins'][0]['state'],'removing')
                # Registry remains available; same package cannot reinstall under deletion.
                reply=await asyncio.wait_for(self.ui.call('plugins.install',{'package_base64':base64.b64encode(current_package()).decode(),
                    'operation_id':uuid.uuid4().hex,'expected_revision':state['revision'],'sha256':body['sha256']}),.8)
                self.assertFalse(reply['ok']);self.assertIn('PLUGIN_REMOVAL_PENDING',json.dumps(reply))
                self.assertEqual(len((await self.rpc('devices.snapshot'))['devices']),4)
            finally:release.set()
            await eventually(lambda:not self.runtime.plugins.store.status()['plugins'],timeout=5)

    async def removal_body(self):
        state=await self.rpc('plugins.status');p=state['plugins'][0]
        return {'plugin_id':p['id'],'sha256':p['sha256'],'operation_id':uuid.uuid4().hex,
            'expected_revision':state['revision'],'export_sha256':hashlib.sha256(current_package()).hexdigest(),'export_bytes':len(current_package())}

    async def test_export_remove_clears_live_and_reimport_does_not_accept_old_callback(self):
        await self.setup_shure();old=self.runtime.plugins.active['shure-scp'];source=old['source_token']
        self.assertEqual(len(self.b._state['devices']),5)
        folder=old['namespace'].root.parent;body=await self.removal_body()
        first=await self.rpc('plugins.remove_exported',body);self.assertEqual(first['state'],'removal_pending')
        await eventually(lambda:not self.runtime.plugins.store.status()['plugins'],timeout=10)
        result=await self.rpc('plugins.operation',{'operation_id':body['operation_id']})
        self.assertEqual(result['state'],'removed');self.assertFalse(folder.exists())
        self.assertEqual(await self.rpc('plugins.remove_exported',body),result)
        self.assertEqual(len((await self.rpc('devices.snapshot'))['devices']),4)
        self.assertEqual(set((await self.rpc('state.capabilities'))['body']['adapters']),{'fashe-mqtt'})
        self.assertFalse(self.runtime.plugins.accept('shure-scp',{},source))
        self.assertIsNone(self.runtime.discovery.target)
        reply=await self.ui.call('discovery.scan',{});self.assertFalse(reply['ok'])
        await self.install_shure()
        self.assertFalse(self.runtime.plugins.accept('shure-scp',{},source))
        # An old acknowledged removal cannot delete a new installation of the same bytes.
        self.assertEqual(await self.rpc('plugins.remove_exported',body),result)
        self.assertIn('shure-scp',self.runtime.plugins.active)
        self.assertFalse(self.sets())

    async def test_wrong_export_identity_revision_builtin_actor_and_expiry_preserve_plugin(self):
        await self.install_shure();body=await self.removal_body();removal=self.runtime.plugins.removal
        for change in ({'plugin_id':'fashe-mqtt'},{'sha256':'0'*64},{'expected_revision':999},{'export_bytes':0},{'export_sha256':'bad'}):
            reply=await self.ui.call('plugins.remove_exported',{**body,**change});self.assertFalse(reply['ok'])
        with self.assertRaises(PluginError):removal.request(body,'network:127.0.0.1',lambda:False)
        self.assertTrue(self.runtime.plugins.active)
        await asyncio.to_thread(removal.stop)
        first=removal.request(body,'one',lambda:True)
        self.assertEqual(removal.request(body,'one',lambda:True),first)
        for changed,actor in ((body,'two'),({**body,'export_bytes':body['export_bytes']+1},'one')):
            with self.assertRaises(PluginError):removal.request(changed,actor,lambda:True)
        encoded=base64.b64encode(current_package()).decode()
        reply=await self.ui.call('plugins.install',{'package_base64':encoded,'operation_id':uuid.uuid4().hex,'expected_revision':first['revision'],'sha256':body['sha256']})
        self.assertFalse(reply['ok']);self.assertIn('PLUGIN_REMOVAL_PENDING',json.dumps(reply))

    async def test_unknown_control_blocks_removal_until_automatic_review_no_replay(self):
        await self.setup_legacy();self.failure='mismatch'
        command=self.body();request=self.ui.request('commands.request',command);request['deadline_at_ms']=int(self.b.time.time()*1000)+2000
        await self.ui.send(request);reply=await self.ui.message();self.assertTrue(reply['ok'],reply);result=reply['result'];self.assertEqual(result['state'],'unknown')
        await self.rpc('plugins.remove_exported',await self.removal_body())
        await asyncio.sleep(.7)
        self.assertIn('shure-scp',self.runtime.plugins.active)
        with self.assertRaises(CommandError):await self.runtime.commands.adapter.send({'target':self.body()['target']},allowed=lambda:True)
        self.failure=None
        await eventually(lambda:not self.runtime.plugins.store.status()['plugins'],timeout=12)
        record=self.runtime.journal.get(command['operation_id'])
        self.assertEqual(record['state'],'unknown');self.assertTrue(record['review']);self.assertEqual(len(self.executions),1)

    async def test_file_failure_keeps_pending_and_retries_without_false_success(self):
        await self.install_shure();removal=self.runtime.plugins.removal;await asyncio.to_thread(removal.stop)
        body=await self.removal_body();await self.rpc('plugins.remove_exported',body)
        with patch.object(removal,'purge',side_effect=PermissionError('fixture locked file')):await asyncio.to_thread(removal.step)
        state=await self.rpc('plugins.status');self.assertEqual(state['plugins'][0]['state'],'removing');self.assertFalse(state['plugins'][0]['active'])
        self.assertEqual((await self.rpc('plugins.operation',{'operation_id':body['operation_id']}))['state'],'removal_pending')
        await asyncio.to_thread(removal.step)
        self.assertEqual((await self.rpc('plugins.operation',{'operation_id':body['operation_id']}))['state'],'removed')

    async def test_inflight_send_finishes_once_before_files_are_deleted(self):
        await self.setup_legacy();manager=self.runtime.plugins;item=manager.active['shure-scp']
        body=await self.removal_body();command=self.body();entered=asyncio.Event();release=asyncio.Event()
        original=item['control'].send
        async def paused(*args,**kwargs):
            entered.set();await release.wait();return await original(*args,**kwargs)
        item['control'].send=paused
        task=asyncio.create_task(self.rpc('commands.request',command));await entered.wait()
        await asyncio.to_thread(manager.removal.request,body,'network:127.0.0.1',lambda:True)
        await asyncio.sleep(.6)
        self.assertIn('shure-scp',manager.active);self.assertTrue(item['namespace'].root.exists())
        release.set();result=await task;self.assertEqual(result['state'],'readback_confirmed')
        await eventually(lambda:not manager.store.status()['plugins'],timeout=10)
        self.assertEqual(len(self.executions),1)
        # Other brand's actual acknowledgement still passes after external removal.
        daty=self.intent();await self.rpc('commands.request',daty)
        await eventually(lambda:self.runtime.journal.get(daty['operation_id'])['state']=='acknowledged')

    async def test_pending_removal_resumes_in_new_server_process(self):
        from tls_support import load_config
        await self.install_shure();await asyncio.to_thread(self.runtime.plugins.removal.stop)
        body=await self.removal_body();await self.rpc('plugins.remove_exported',body)
        root=Path(self.temp.name)
        config=root/'runtime-config.json'
        config.write_text(json.dumps({'schema':'daty-mqtt6-runtime-v1','database':str(root/'business.sqlite3'),'database_epoch':self.epoch,
            'archives':str(root/'archives'),'staging':str(root/'staging'),'runtime_directory':str(root/'runtime'),
            'pairing':str(self.fixture.path),'tls':str(self.tls),'ca_sha256':load_config(self.tls)[1]['ca_sha256'],
            'bind_host':'127.0.0.1','mqtt_port':0,'web_port':0,'public_directory':str(ROOT.parent/'public')}),'utf-8')
        await self.close_peers();await self.runtime.close()
        for n in range(1,7):(root/f'.daty-mqtt-stage{n}-fixture').unlink()
        script='''import sys,asyncio,json
from pathlib import Path
root=Path(sys.argv[1]);sys.path[:0]=[str(root),str(root/'tests'),str(root/'prototypes/mqtt-stage6'),sys.argv[4]]
from m6_runtime import Runtime
from m6_scope import RuntimeScope
from unittest.mock import patch
from plugin_runtime import PluginManager
async def main():
    scope=RuntimeScope(sys.argv[2]);runtime=Runtime(scope.runtime_directory,sys.argv[3],runtime_scope=scope)
    original=PluginManager.start
    def offline(manager):manager.live=False;return original(manager)
    try:
        with patch('plugin_discovery.AutoDiscovery.start'),patch.object(PluginManager,'start',offline):await runtime.start()
        for _ in range(60):
            if not runtime.plugins.store.status()['plugins']:break
            await asyncio.sleep(.1)
        assert not runtime.plugins.status()['plugins']
        assert not runtime.plugins.active
        assert runtime.plugins.store.operation(sys.argv[5],'network:127.0.0.1')['state']=='removed'
        print('REMOVAL_RESTART_OK')
    finally:await runtime.close()
asyncio.run(main())
'''
        args=[sys.executable,'-X','utf8','-B','-c',script,str(ROOT),str(config),str(self.runtime.broker),str(Path(sys.executable).parents[1]/'pylib'),body['operation_id']]
        run=await asyncio.to_thread(subprocess.run,args,capture_output=True,text=True,encoding='utf-8',timeout=40,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.assertEqual(run.returncode,0,run.stdout+run.stderr);self.assertIn('REMOVAL_RESTART_OK',run.stdout)
