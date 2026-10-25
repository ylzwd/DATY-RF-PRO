from pathlib import Path
from types import SimpleNamespace
import argparse,sys,unittest
p=argparse.ArgumentParser();p.add_argument('--tools',required=True);p.add_argument('--server');a=p.parse_args()
s=Path(a.server) if a.server else Path(__file__).resolve().parents[1]/'app/server';t=Path(a.tools)
sys.path[:0]=[str(t/'pylib'),str(s),str(s/'tests'),*[str(s/f'prototypes/mqtt-stage{n}') for n in range(6,0,-1)]]
import test_stage6,test_plugin_export_removal
test_stage6.OPTIONS=SimpleNamespace(broker=str(t/'broker/mosquitto.exe'))
names=['test_plugin_export_removal.Removal.'+n for n in test_plugin_export_removal.Removal.__dict__ if n.startswith('test_')]
names+=['test_plugin_auto_discovery.Scheduler','test_shure_package_v2.CurrentAutomatic.test_automatic_start_and_later_receiver_without_manual_rpc','test_shure_metadata_recovery.Materialization','test_shure_package_v2.CurrentRecovery.test_evicted_channel_recovers_unchanged_metadata_on_next_real_report',
    'test_shure_package_v2.Current.test_legacy_mute_unmute_frequency_real_journal_and_distinct_readback']
names+=['test_plugin_removal_scheduling.Scheduling']
result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromNames(names))
raise SystemExit(not result.wasSuccessful())
