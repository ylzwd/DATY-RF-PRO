from pathlib import Path
from types import SimpleNamespace
import sys,unittest
root=Path(__file__).resolve().parents[1];server=root/'app/server'
sys.path[:0]=[str(root/'app/tools/pylib'),str(server),str(server/'tests'),*[str(server/f'prototypes/mqtt-stage{n}') for n in range(6,0,-1)]]
import test_stage6
test_stage6.OPTIONS=SimpleNamespace(broker=str(root/'app/tools/broker/mosquitto.exe'))
names=['test_shure_direct','test_shure_health','test_shure_reconnect','test_project_plugin_upgrade','test_shure_metadata_recovery.Materialization',
       'test_shure_package_v2.CurrentRecovery.test_evicted_channel_recovers_unchanged_metadata_on_next_real_report']
result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromNames(names))
raise SystemExit(not result.wasSuccessful())
