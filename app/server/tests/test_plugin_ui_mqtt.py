"""Shipped JS import interface, actual TLS MQTT and SQLite; no LAN receiver writes."""
import asyncio,json,os,subprocess,unittest
from pathlib import Path
from test_stage6 import Integration
from test_plugin_install import existing_package
from tls_support import load_config

ROOT=Path(__file__).resolve().parents[1]

class PluginUIChain(Integration):
    async def run_interface(self,surface,drop_receipt):
        root=Path(self.temp.name);package=root/'existing-shure.zip';package.write_bytes(existing_package())
        config={'zip':str(package),'surface':surface,'dropReceipt':drop_receipt,'wss':self.runtime.uri,
            'ca':str(load_config(self.tls)[0]['ca_file']),
            'mqttBundle':str(ROOT.parent/'FAshe/vendor/mqtt-5.10.4/mqtt.upstream.min.js'),
            'wsBundle':str(ROOT.parent/'tools/playwright/lib/utilsBundle.js')}
        path=root/'node-test.json';path.write_text(json.dumps(config),'utf-8')
        command=[os.environ['DATY_TEST_NODE'],str(ROOT/'tests/plugin-import-mqtt-live.cjs'),str(path)]
        result=await asyncio.to_thread(subprocess.run,command,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=45,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr)
        evidence=json.loads(result.stdout.strip().splitlines()[-1]);self.assertTrue(evidence['ok'])
        with self.runtime.plugins.store.connection() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM operations').fetchone()[0],1)
        state=await self.rpc('plugins.status');self.assertEqual(state['revision'],1);self.assertTrue(state['plugins'][0]['active'])
        self.assertEqual(set((await self.rpc('state.capabilities'))['body']['adapters']),{'fashe-mqtt','shure-scp'})
        self.assertTrue(all(not receiver.executions for receiver in self.receivers))
        output=Path(os.environ['DATY_TEST_EVIDENCE']);output.mkdir(parents=True,exist_ok=True)
        (output/f'interface-{surface}.json').write_text(json.dumps(evidence,indent=2),'utf-8')
    async def test_public_import_confirm_and_duplicate(self):await self.run_interface('public',False)
    async def test_source_lost_install_receipt_queries_without_retry(self):await self.run_interface('source',True)

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(PluginUIChain(name) for name in PluginUIChain.__dict__ if name.startswith('test_'))
