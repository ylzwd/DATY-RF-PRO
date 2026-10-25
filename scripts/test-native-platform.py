"""Real native RPC + realtime stream reconnect against an isolated mother platform."""
from pathlib import Path
from types import SimpleNamespace
import argparse,asyncio,json,subprocess,sys,unittest
p=argparse.ArgumentParser();p.add_argument('--tools',required=True);p.add_argument('--dotnet',required=True);a=p.parse_args()
R=Path(__file__).resolve().parents[1];S=R/'app/server';T=Path(a.tools)
sys.path[:0]=[str(T/'pylib'),str(S),str(S/'tests'),*[str(S/f'prototypes/mqtt-stage{n}') for n in range(1,7)]]
import test_stage6
from test_transport_recovery import TransportRecovery
from m6_test_support import eventually
from tls_support import load_config
test_stage6.OPTIONS=SimpleNamespace(broker=str(T/'broker/mosquitto.exe'))
class NativePlatform(TransportRecovery):
 async def test_native_stream_and_rpc_reconnect_without_replaying_commands(self):
  root=Path(self.temp.name);ready=root/'ready';out=root/'native-result.json'
  cfg={'origin':'https://127.0.0.1:8080','ca':str(load_config(self.tls)[0]['ca_file']),
   'port':self.runtime.port,'mode':'transport-recovery','ready':str(ready),'output':str(out)}
  config=root/'native.json';config.write_text(json.dumps(cfg),'utf-8')
  assembly=R/'native/tests/Daty.Native.Mqtt.Tests/bin/Release/net10.0/Daty.Native.Mqtt.Tests.dll'
  with (root/'native.log').open('w',encoding='utf-8') as log:
   proc=subprocess.Popen([a.dotnet,str(assembly),str(config)],stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
   try:
    await eventually(ready.exists,timeout=15)
    await asyncio.to_thread(self.runtime.view.publisher.client.disconnect)
    snapshot=await self.recovered(0);self.assertEqual(len(snapshot['devices']),4)
    code=await asyncio.to_thread(proc.wait,30)
    self.assertEqual(code,0,(root/'native.log').read_text('utf-8'))
    result=json.loads(out.read_bytes());self.assertTrue(result['ok']);self.assertGreaterEqual(result['recoveryOffline'],1)
    self.assertTrue(all(not rx.executions for rx in self.receivers))
    (R/'verification/native-platform.json').write_text(json.dumps(result,indent=2),'utf-8')
   finally:
    if proc.poll() is None:proc.terminate();await asyncio.to_thread(proc.wait,5)
unittest.main(argv=[sys.argv[0]],defaultTest='NativePlatform.test_native_stream_and_rpc_reconnect_without_replaying_commands',verbosity=2)
