"""Actual .NET full-bundle import/export over isolated TLS/MQTT and SQLite.
Never starts an official installer or contacts physical receivers.
"""
from pathlib import Path
from types import SimpleNamespace
import argparse,asyncio,json,subprocess,sys,unittest
parser=argparse.ArgumentParser();parser.add_argument('--dotnet',required=True);parser.add_argument('--tools',required=True);parser.add_argument('--remove',action='store_true');args=parser.parse_args()
R=Path(__file__).resolve().parents[1];S=R/'app/server';T=Path(args.tools)
sys.path[:0]=[str(T/'pylib'),str(S),str(S/'tests'),*[str(S/f'prototypes/mqtt-stage{n}') for n in range(1,7)]]
import test_stage6
from test_stage6 import Integration
from tls_support import load_config
test_stage6.OPTIONS=SimpleNamespace(broker=str(T/'broker/mosquitto.exe'))
class Offline(Integration):
 async def test_full_export_import(self):
  root=Path(self.temp.name);catalog=R/'native/assets/plugin-bundles.json';entry=json.loads(catalog.read_bytes())[0]
  config={'origin':'https://127.0.0.1:8080','ca':str(load_config(self.tls)[0]['ca_file']),'port':self.runtime.port,'mode':'export-remove' if args.remove else 'offline-plugin',
   'catalog':str(catalog),'bundle':str(R/'native/assets/plugin-bundles'/entry['fileName']),'root':str(root),'output':str(root/'result.json')}
  path=root/'native-test.json';path.write_text(json.dumps(config),'utf-8')
  assembly=R/'native/tests/Daty.Native.Mqtt.Tests/bin/Release/net10.0/Daty.Native.Mqtt.Tests.dll'
  result=await asyncio.to_thread(subprocess.run,[args.dotnet,str(assembly),str(path)],capture_output=True,text=True,encoding='utf-8',timeout=110,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
  self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  evidence=json.loads((root/'result.json').read_bytes());self.assertTrue(evidence['ok']);self.assertEqual(evidence['installs'],2 if args.remove else 1)
  state=await self.rpc('plugins.status');self.assertEqual(state['plugins'][0]['sha256'],entry['pluginSha256']);self.assertTrue(state['plugins'][0]['active'])
  self.assertTrue(all(not r.executions for r in self.receivers))
  self.assertEqual(len(self.b._state['devices']),4)
  (R/('verification/native-export-removal.json' if args.remove else 'verification/native-offline-bundle.json')).write_text(json.dumps(evidence,indent=2),'utf-8')
unittest.main(argv=[sys.argv[0]],defaultTest='Offline.test_full_export_import',verbosity=2)
