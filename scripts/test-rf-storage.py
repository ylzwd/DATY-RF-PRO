"""Isolated storage/migration/recovery checks; no live endpoint option."""
from pathlib import Path
from types import SimpleNamespace
import argparse,json,sys,unittest
R=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--tools',required=True);parser.add_argument('--output',required=True)
args=parser.parse_args();T=Path(args.tools);S=R/'app/server';W=Path(args.output);W.mkdir(parents=True,exist_ok=True)
sys.path[:0]=[str(S),str(S/'tests'),str(T/'pylib'),*[str(S/f'prototypes/mqtt-stage{n}') for n in range(1,7)]]
import test_stage6
test_stage6.OPTIONS=SimpleNamespace(broker=str(T/'broker/mosquitto.exe'),output=str(W))
names=[
 'test_unified_live.UnifiedLiveTests',
 'test_unified_runtime.UnifiedRuntimeTests',
 'test_process_persistence.WriterTests',
 'test_system_settings.SystemSettingsTests',
 'test_monitoring_rules.MonitoringRulesTests',
 'test_planning_settings.PlanningSettingsTests',
 'test_rf_sample_storage.SnapshotStorage','test_rf_sample_storage.Migration',
 'test_compact_sample_history.Compaction',
 'test_data_management_v2.DataManagementV2Tests.test_upgrade_keeps_identity_all_rows_and_prior_receipt',
 'test_data_management_v2.DataManagementV2Tests.test_failed_index_upgrade_rolls_back_to_exact_v1',
 'test_data_management_v2.DataManagementV2Tests.test_offline_index_rollback_keeps_new_writes_and_exact_old_schema',
 'test_data_management_v2.DataManagementV2Tests.test_extra_index_and_forged_migration_still_fail_closed',
 'test_data_management_v2.DataManagementV2Tests.test_delta_pagination_tombstones_unchanged_rows_and_epoch',
 'test_shure_metadata_recovery.Materialization',
 'test_shure_metadata_recovery.Recovery.test_evicted_channel_recovers_unchanged_metadata_on_next_real_report',
 'test_plugin_mqtt.ImportedShure.test_imported_rf_af_real_tcp_mqtt_and_persistence',
 'test_plugin_mqtt.ImportedShure.test_imported_battery_real_tcp_mqtt_and_persistence',
 'test_plugin_mqtt.ImportedShure.test_shure_success_journal_and_datyaudio_independent',
 'test_plugin_mqtt.ImportedShure.test_shure_disconnect_after_set_is_unknown',
 'test_writer_recovery.Recovery.test_idle_exit_recovers_original_database_without_restarting_runtime',
 'test_writer_recovery.Recovery.test_committed_reply_loss_stays_unknown_no_duplicate_after_recovery',
 'test_writer_recovery.Recovery.test_schema_damage_blocks_recovery_and_preserves_evidence',
 'test_writer_recovery.Chain.test_writer_exit_restores_rpc_stream_and_settings_without_server_restart',
 'test_writer_recovery.Chain.test_writer_failure_does_not_replay_inflight_device_command',
]
suite=unittest.defaultTestLoader.loadTestsFromNames(names)
result=unittest.TextTestRunner(verbosity=2).run(suite)
(W/'result.json').write_text(json.dumps({'passed':result.wasSuccessful(),'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors)},indent=2),'utf-8')
raise SystemExit(not result.wasSuccessful())
