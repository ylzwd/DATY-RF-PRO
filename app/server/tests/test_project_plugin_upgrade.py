import json,sys,unittest
from pathlib import Path
from test_plugin_mqtt import ImportedShure
from test_plugin_install import ROOT
from tls_support import load_config
from m6_scope import RuntimeScope

sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'scripts'))
from project_plugin_upgrade import upgrade_installed

class Upgrade(ImportedShure):
    async def scope(self):
        root=Path(self.temp.name)
        settings={'schema':'daty-mqtt6-runtime-v1','database':str(root/'business.sqlite3'),'database_epoch':self.epoch,
            'archives':str(root/'archives'),'staging':str(root/'staging'),'runtime_directory':str(root/'runtime'),
            'pairing':str(self.fixture.path),'tls':str(self.tls),'ca_sha256':load_config(self.tls)[1]['ca_sha256'],
            'bind_host':'127.0.0.1','mqtt_port':0,'web_port':0,'public_directory':str(ROOT.parent/'public')}
        config=root/'runtime-config.json';config.write_text(json.dumps(settings),'utf-8')
        await self.close_peers();await self.runtime.close()
        return RuntimeScope(config)

    async def test_installed_plugin_upgrades_once_without_systemapi_or_device_io(self):
        await self.install_shure();old=self.runtime.plugins.store.status()
        with_scope=await self.scope()
        try:
            result=upgrade_installed(ROOT.parents[1],with_scope)
            self.assertEqual(len(result),1)
            self.assertEqual(result[0]['previous_sha256'],old['plugins'][0]['sha256'])
            self.assertEqual(result[0]['activation'],'pending')
            self.assertEqual(upgrade_installed(ROOT.parents[1],with_scope),[])
        finally:with_scope.close()

    async def test_uninstalled_brand_is_not_silently_installed(self):
        with_scope=await self.scope()
        try:self.assertEqual(upgrade_installed(ROOT.parents[1],with_scope),[])
        finally:with_scope.close()

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(Upgrade(name) for name in Upgrade.__dict__ if name.startswith('test_'))
