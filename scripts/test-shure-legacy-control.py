from pathlib import Path
from types import SimpleNamespace
import argparse,sys,unittest
p=argparse.ArgumentParser();p.add_argument('--tools',required=True);p.add_argument('--server');a=p.parse_args()
server=Path(a.server) if a.server else Path(__file__).resolve().parents[1]/'app/server'
tools=Path(a.tools)
sys.path[:0]=[str(tools/'pylib'),str(server),str(server/'tests'),*[str(server/f'prototypes/mqtt-stage{n}') for n in range(6,0,-1)]]
import test_stage6
test_stage6.OPTIONS=SimpleNamespace(broker=str(tools/'broker/mosquitto.exe'))
names=['test_shure_legacy_control','test_plugin_auto_discovery','test_shure_metadata_recovery',
    'test_plugin_mqtt.ImportedShure.test_mute_skips_only_unused_old_value_and_keeps_independent_readback',
    'test_plugin_mqtt.ImportedShure.test_shure_wrong_channel_unknown_blocks_retries',
    'test_plugin_mqtt.ImportedShure.test_shure_mismatched_readback_is_not_success',
    'test_plugin_mqtt.ImportedShure.test_uninstalled_and_failed_import_do_not_enable_shure',
    'test_plugin_mqtt.ImportedShure.test_process_restart_rechecks_installation_and_rejects_tampering',
    'test_plugin_mqtt.ImportedShure.test_imported_rf_af_real_tcp_mqtt_and_persistence',
    'test_plugin_mqtt.ImportedShure.test_imported_battery_real_tcp_mqtt_and_persistence']
result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromNames(names))
raise SystemExit(not result.wasSuccessful())
