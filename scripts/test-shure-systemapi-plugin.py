from pathlib import Path
from types import SimpleNamespace
import argparse,sys,unittest
p=argparse.ArgumentParser();p.add_argument('--tools',required=True);p.add_argument('--server');a=p.parse_args()
server=Path(a.server) if a.server else Path(__file__).resolve().parents[1]/'app/server';tools=Path(a.tools)
sys.path[:0]=[str(tools/'pylib'),str(server),str(server/'tests'),*[str(server/f'prototypes/mqtt-stage{n}') for n in range(6,0,-1)]]
import test_stage6
test_stage6.OPTIONS=SimpleNamespace(broker=str(tools/'broker/mosquitto.exe'))
names=['test_shure_systemapi','test_plugin_install',
    'test_shure_package_v2.Maintenance.test_offline_update_lease_revision_receipt_and_next_process_activation']
methods=['test_package_health_through_existing_mqtt_interfaces','test_packaged_legacy_meter_factory_and_identity_fail_closed',
    'test_legacy_mute_unmute_frequency_real_journal_and_distinct_readback','test_identity_mismatch_band_grid_mode_and_session_never_send',
    'test_unknown_mismatch_is_retained_auto_review_does_not_replay','test_disconnect_and_swapped_identity_after_set_never_confirm_or_retry',
    'test_disconnected_readback_is_unknown','test_wrong_channel_readback_is_unknown',
    'test_imported_rf_af_real_tcp_mqtt_and_persistence','test_imported_battery_real_tcp_mqtt_and_persistence',
    'test_mute_skips_only_unused_old_value_and_keeps_independent_readback',
    'test_process_restart_rechecks_installation_and_rejects_tampering']
names += ['test_shure_package_v2.Current.'+n for n in methods]
names += ['test_shure_package_v2.CurrentRecovery.test_evicted_channel_recovers_unchanged_metadata_on_next_real_report',
    'test_shure_package_v2.CurrentAutomatic.test_automatic_start_and_later_receiver_without_manual_rpc']
result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromNames(names))
raise SystemExit(not result.wasSuccessful())
