"""All fixtures use in-memory SQLite. No production imports, files or sockets."""
import copy
import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unified_live as live


def device(channel=1, receiver='rx-a', **extra):
    return {'id': f'{receiver}_ch{channel}', 'receiver_id': receiver, 'channel_number': channel,
            'receiver_mac': '02:00:00:00:00:01' if receiver == 'rx-a' else '02:00:00:00:00:02',
            'receiver_ip': '192.0.2.102', 'brand': 'DATYaudio', 'model': 'RX-8', 'name': f'CH{channel}',
            'group_number': 1, '_source': receiver + ':mqtt:session-a', '_online': True, '_age_s': 0,
            'freq': 641000 + (channel - 1) * 250, 'rf': -60.0, 'af_dbfs': -20, 'batt': 75,
            'muted': False, 'status': 'online', **extra}


def command(status='prepared', **extra):
    return {'command_id': 'command-a', 'device_id': 'rx-a_ch1', 'target_device_ids': ['rx-a_ch1'],
            'receiver_id': 'rx-a', 'receiver_ip': '192.0.2.102', 'receiver_mac': '02:00:00:00:00:01',
            'channel_number': 1, 'channel': 1, 'brand': 'DATYaudio', 'expected_brand': 'DATYaudio',
            'command': 'set_freq', 'expected_value': 641.25, 'actual_value': None, 'status': status,
            'created_at': 1, 'updated_at': 1, 'acknowledged_at': None, 'published_subscribers': None,
            'client_request_id': 'client-request-a', 'actor': {'id': 'operator-1', 'name': '操作员', 'role': 'operator'},
            **extra}


class UnifiedLiveTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.addCleanup(self.db.close)
        self.db.execute('BEGIN')
        for statement in live.schema_statements():
            self.db.execute(statement)
        self.db.commit()

    def count(self, table):
        self.assertIn(table, live.TABLES)
        return self.db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]

    def test_schema_single_statements_idempotent_and_caller_can_rollback(self):
        self.db.execute('BEGIN')
        for statement in live.schema_statements():
            self.db.execute(statement)
        live.record_snapshot(self.db, 'boot-a', [device()], 1000)
        self.assertTrue(self.db.in_transaction)
        self.db.rollback()
        self.assertEqual(self.count('live_receivers'), 0)
        self.assertEqual(set(live.TABLES), {row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")})

    def test_counts_receivers_not_channels_and_preserves_brand_slots(self):
        live.record_snapshot(self.db, 'boot-a', [device(i) for i in range(1, 9)], 1000, full=True)
        overview = live.get_overview(self.db, 'boot-a', 1000)
        self.assertEqual((overview['online_devices'], overview['active_channels']), (1, 8))
        self.assertEqual(overview['brand_counts'], {'DATYaudio': 1, 'AMSaudio': 0, 'Shure': 0, 'Sennheiser': 0})
        self.assertEqual(self.count('live_samples'), 8)

    def test_multibrand_receiver_counts_are_distinct(self):
        live.record_snapshot(self.db, 'boot-a', [device(), device(2), device(receiver='rx-b', brand='Shure')], 1000)
        result = live.get_overview(self.db, 'boot-a', 1000)
        self.assertEqual((result['online_receivers'], result['active_channels']), (2, 3))
        self.assertEqual(result['brand_counts']['Shure'], 1)

    def test_duplicate_frame_is_deduplicated_but_new_observation_is_not_sampled_out(self):
        live.record_snapshot(self.db, 'boot-a', [device()], 1000)
        again = live.record_snapshot(self.db, 'boot-a', [device()], 1000)
        self.assertEqual(again['samples'], 0)
        live.record_snapshot(self.db, 'boot-a', [device(rf=-45)], 1001)
        self.assertEqual(self.count('live_samples'), 2)
        self.assertEqual(self.count('live_channels'), 1)

    def test_sparse_updates_retain_siblings_and_full_missing_tombstones_history(self):
        live.record_snapshot(self.db, 'boot-a', [device(), device(2)], 1000, full=True)
        live.record_snapshot(self.db, 'boot-a', [device(muted=True)], 1001)
        self.assertEqual(live.get_overview(self.db, 'boot-a', 1001)['active_channels'], 2)
        removed = live.record_snapshot(self.db, 'boot-a', [device()], 1002, full=True)
        self.assertEqual(removed['removed'], 1)
        self.assertEqual(self.count('live_channels'), 2)
        second = live.query_channels(self.db, 'boot-a', 1002)['channels'][1]
        self.assertTrue(second['removed']); self.assertFalse(second['_online'])
        self.assertEqual(live.record_snapshot(self.db, 'boot-a', [device()], 1003, full=True)['removed'], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM live_events WHERE event_type='channel.removed'").fetchone()[0], 1)

    def test_reappearing_channel_is_not_a_second_asset(self):
        live.record_snapshot(self.db, 'boot-a', [device()], 1000)
        live.record_snapshot(self.db, 'boot-a', [], 2000, full=True)
        live.record_snapshot(self.db, 'boot-a', [device()], 3000)
        self.assertEqual(self.count('live_channels'), 1)
        self.assertEqual(live.get_overview(self.db, 'boot-a', 3000)['active_channels'], 1)

    def test_new_boot_retains_history_offline_until_real_new_observation(self):
        live.record_snapshot(self.db, 'boot-a', [device(), device(2)], 1000)
        live.record_snapshot(self.db, 'boot-b', [], 2000)
        self.assertEqual(live.get_overview(self.db, 'boot-b', 2000)['active_channels'], 0)
        self.assertEqual(live.get_overview(self.db, 'boot-a', 2000)['active_channels'], 0)
        self.assertEqual(self.count('live_samples'), 2)
        live.record_snapshot(self.db, 'boot-b', [device()], 3000)
        result = live.get_overview(self.db, 'boot-b', 3000)
        self.assertEqual((result['known_channels'], result['active_channels']), (2, 1))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM live_sessions WHERE end_reason='server-restarted'").fetchone()[0], 1)

    def test_retired_boot_and_source_cannot_regain_online_identity(self):
        live.record_snapshot(self.db, 'boot-a', [device()], 1000)
        live.record_snapshot(self.db, 'boot-a', [device(_source='rx-a:mqtt:session-b')], 2000)
        self.db.commit()
        with self.assertRaises(live.LiveStoreError):
            live.record_snapshot(self.db, 'boot-a', [device()], 3000)
        self.db.rollback()
        live.record_snapshot(self.db, 'boot-b', [], 4000)
        self.db.commit()
        with self.assertRaises(live.LiveStoreError):
            live.record_snapshot(self.db, 'boot-a', [device()], 5000)
        self.db.rollback()

    def test_ttl_strict_boundary_and_foreign_boot_are_never_online(self):
        live.record_snapshot(self.db, 'boot-a', [device()], 1000)
        self.assertEqual(live.get_overview(self.db, 'boot-a', 15999)['active_channels'], 1)
        self.assertEqual(live.get_overview(self.db, 'boot-a', 16000)['active_channels'], 0)
        self.assertEqual(live.get_overview(self.db, 'boot-other', 1000)['active_channels'], 0)
        self.assertEqual(live.get_overview(self.db, 'boot-a', 999)['active_channels'], 0)

    def test_explicit_offline_cannot_be_revived_by_reported_online_text(self):
        live.record_snapshot(self.db, 'boot-a', [device(_online=False, status='online')], 1000)
        self.assertEqual(live.get_overview(self.db, 'boot-a', 1000)['active_channels'], 0)
        live.record_snapshot(self.db, 'boot-a', [device(_online='true')], 2000)
        self.assertEqual(live.get_overview(self.db, 'boot-a', 2000)['active_channels'], 0)

    def test_nullable_metrics_and_strict_units_do_not_invent_values(self):
        value = device(freq=641.25, rf='-60', af_dbfs=1, batt=101, muted='false')
        live.record_snapshot(self.db, 'boot-a', [value], 1000)
        row = live.query_channels(self.db, 'boot-a', 1000)['channels'][0]
        for field in ('freq', 'rf', 'af_dbfs', 'af', 'batt', 'muted'):
            self.assertIsNone(row[field])
        live.record_snapshot(self.db, 'boot-a', [device(af_dbfs=0, batt=0, rf=-90, muted=False)], 2000)
        row = live.query_channels(self.db, 'boot-a', 2000)['channels'][0]
        self.assertEqual((row['af_dbfs'], row['batt'], row['rf']), (0, 0, -90))
        self.assertIs(row['muted'], False)

    def test_source_and_extensions_retained_without_secret_material(self):
        value = device(extra={'future': 2, 'access_token': 'DO-NOT-STORE', 'private_key': 'DO-NOT-STORE',
                              'nested': [{'password': 'DO-NOT-STORE', 'safe': True}]},
                       actor={'id': 'a', 'role': 'operator', 'secret_sha256': 'DO-NOT-STORE', 'other': 'not-public'})
        before = copy.deepcopy(value)
        live.record_snapshot(self.db, 'boot-a', [value], 1000)
        import rf_sample_storage
        encoded = rf_sample_storage.load_snapshot(self.db, self.db.execute('SELECT id FROM live_samples').fetchone()[0])
        self.assertNotIn('DO-NOT-STORE', encoded); self.assertNotIn('not-public', encoded)
        stored = json.loads(encoded)
        self.assertEqual(stored['_source'], value['_source']); self.assertEqual(stored['extra']['future'], 2)
        self.assertEqual(value, before)

    def test_duplicate_or_conflicting_receiver_identity_rejected_before_writes(self):
        for values in ([device(), device()], [device(), device(2, brand='Shure')]):
            with self.assertRaises(live.LiveStoreError):
                live.record_snapshot(self.db, 'boot-a', values, 1000)
        self.assertEqual(self.count('live_channels'), 0)
        self.assertEqual(self.count('live_boots'), 0)

    def test_stable_device_identity_cannot_be_rebound(self):
        live.record_snapshot(self.db, 'boot-a', [device()], 1000)
        self.db.commit()
        with self.assertRaises(live.LiveStoreError):
            live.record_snapshot(self.db, 'boot-a', [device(channel_number=2)], 2000)
        self.db.rollback()
        self.assertEqual(live.query_channels(self.db, 'boot-a', 2000)['channels'][0]['channel_number'], 1)

    def test_same_mac_cannot_inflate_receiver_count_using_another_id(self):
        live.record_snapshot(self.db, 'boot-a', [device()], 1000)
        self.db.commit()
        with self.assertRaises(live.LiveStoreError):
            live.record_snapshot(self.db, 'boot-a', [device(receiver='different-alias', receiver_mac='02:00:00:00:00:01')], 2000)
        self.db.rollback()
        self.assertEqual(live.get_overview(self.db, 'boot-a', 2000)['online_receivers'], 1)

    def test_autocommit_connection_still_allows_full_caller_rollback(self):
        other = sqlite3.connect(':memory:', isolation_level=None)
        self.addCleanup(other.close)
        for statement in live.schema_statements():
            other.execute(statement)
        live.record_snapshot(other, 'boot-a', [device()], 1000)
        self.assertTrue(other.in_transaction)
        other.rollback()
        self.assertEqual(other.execute('SELECT COUNT(*) FROM live_channels').fetchone()[0], 0)

    def test_old_frame_does_not_overwrite_or_remove_a_newer_channel(self):
        live.record_snapshot(self.db, 'boot-a', [device(freq=642000), device(2)], 3000)
        result = live.record_snapshot(self.db, 'boot-a', [device(freq=641000)], 2000, full=True)
        self.assertEqual((result['ignored'], result['removed']), (1, 0))
        rows = live.query_channels(self.db, 'boot-a', 3000)['channels']
        self.assertEqual(rows[0]['freq'], 642000); self.assertFalse(rows[1]['removed'])

    def test_tombstone_watermark_blocks_old_delta_from_resurrecting_removed_channel(self):
        live.record_snapshot(self.db, 'boot-a', [device()], 1000)
        live.record_snapshot(self.db, 'boot-a', [], 3000, full=True)
        result = live.record_snapshot(self.db, 'boot-a', [device()], 2000)
        self.assertEqual(result['ignored'], 1)
        self.assertTrue(live.query_channels(self.db, 'boot-a', 3000)['channels'][0]['removed'])
        self.assertEqual(live.get_overview(self.db, 'boot-a', 3000)['active_channels'], 0)

    def test_stable_cursor_includes_removed_historical_channels_and_no_control_targets(self):
        live.record_snapshot(self.db, 'boot-a', [device(i) for i in range(1, 5)], 1000)
        live.record_snapshot(self.db, 'boot-a', [], 2000, full=True)
        first = live.query_channels(self.db, 'boot-a', 2000, limit=2)
        second = live.query_channels(self.db, 'boot-a', 2000, limit=2, cursor=first['next_cursor'])
        self.assertEqual(len(first['channels'] + second['channels']), 4)
        self.assertIsNone(second['next_cursor'])
        self.assertTrue(all(not row['control_target'] and not row['_online'] for row in first['channels'] + second['channels']))

    def test_exact_ack_evidence_actor_target_and_rtt_are_retained_without_secrets(self):
        value = command('acknowledged', updated_at=2, acknowledged_at=2, actual_value=641.25,
                        ack_round_trip_ms=3.125, _require_ack_id=True, published_subscribers=1,
                        ack_evidence={'command_id': 'command-a', '_source': 'rx-a:mqtt:session-a'}, token='DO-NOT-STORE')
        value['actor']['password'] = 'DO-NOT-STORE'
        live.record_command(self.db, value, 2001)
        row = self.db.execute('SELECT target_json,actor_json,record_json,ack_round_trip_ms FROM live_commands').fetchone()
        self.assertEqual(json.loads(row[0])['expected_brand'], 'DATYaudio')
        self.assertEqual(json.loads(row[0])['target_device_ids'], ['rx-a_ch1'])
        self.assertEqual(json.loads(row[1]), {'id': 'operator-1', 'name': '操作员', 'role': 'operator'})
        self.assertEqual(row[3], 3.125); self.assertNotIn('DO-NOT-STORE', row[2])
        self.assertTrue(json.loads(row[2])['_require_ack_id'])
        self.assertEqual(json.loads(row[2])['ack_evidence']['_source'], 'rx-a:mqtt:session-a')

    def test_command_lifecycle_distinct_events_no_status_regression_or_repeat_event(self):
        for value in (command(), command('published', updated_at=2, published_subscribers=1),
                      command('acknowledged', updated_at=3, acknowledged_at=3, actual_value=641.25, published_subscribers=1)):
            live.record_command(self.db, value, 3000)
        self.assertEqual(self.count('live_command_events'), 3)
        duplicate = live.record_command(self.db, value, 4000)
        self.assertFalse(duplicate['event_inserted'])
        late = live.record_command(self.db, command('published', updated_at=4, published_subscribers=1), 5000)
        self.assertFalse(late['latest_updated'])
        self.assertEqual(self.db.execute('SELECT status FROM live_commands').fetchone()[0], 'acknowledged')
        self.assertEqual(self.count('live_command_events'), 4)

    def test_store_does_not_infer_ack_from_matching_actual_or_restore_sending(self):
        live.record_command(self.db, command('published', actual_value=641.25), 1000)
        self.assertEqual(self.db.execute('SELECT status FROM live_commands').fetchone()[0], 'published')
        live.record_snapshot(self.db, 'boot-a', [], 1000)
        live.record_snapshot(self.db, 'boot-b', [], 2000)
        self.assertEqual(self.db.execute('SELECT status FROM live_commands').fetchone()[0], 'published')
        self.assertEqual(self.count('live_command_events'), 1)

    def test_late_prepared_event_cannot_regress_published_latest(self):
        live.record_command(self.db, command('published', updated_at=2), 2000)
        result = live.record_command(self.db, command('prepared', updated_at=3), 3000)
        self.assertFalse(result['latest_updated'])
        self.assertEqual(self.count('live_command_events'), 2)
        self.assertEqual(self.db.execute('SELECT status FROM live_commands').fetchone()[0], 'published')

    def test_command_id_cannot_change_target_brand_or_expected_frequency(self):
        live.record_command(self.db, command(), 1000)
        self.db.commit()
        for change in ({'device_id': 'rx-a_ch2'}, {'expected_brand': 'Shure'}, {'expected_value': 642.0}):
            with self.assertRaises(live.LiveStoreError):
                live.record_command(self.db, command('published', **change), 2000)
            self.db.rollback()
        self.assertEqual(self.count('live_command_events'), 1)

    def test_failure_rollback_includes_samples_and_boot_change(self):
        live.record_snapshot(self.db, 'boot-a', [device()], 1000)
        self.db.commit()
        self.db.execute("CREATE TRIGGER fail_live_sample BEFORE INSERT ON live_samples BEGIN SELECT RAISE(ABORT,'fixture'); END")
        self.db.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            live.record_snapshot(self.db, 'boot-b', [device()], 2000)
        self.db.rollback()
        self.assertEqual(self.count('live_boots'), 1)
        self.assertEqual(live.get_overview(self.db, 'boot-a', 2000)['active_channels'], 1)

    def test_age_uses_observation_time_and_offline_heartbeat_is_not_reused(self):
        live.record_snapshot(self.db, 'boot-a', [device(_age_s=10, heartbeat={'status': 'measured', 'rtt_ms': 3})], 20000)
        self.assertEqual(live.get_overview(self.db, 'boot-a', 24999)['active_channels'], 1)
        row = live.query_channels(self.db, 'boot-a', 25000)['channels'][0]
        self.assertFalse(row['_online']); self.assertEqual(row['_age_s'], 15)
        self.assertEqual(row['heartbeat']['status'], 'offline'); self.assertIsNone(row['heartbeat']['rtt_ms'])

    def test_internal_receiver_id_fallback_and_unknown_metrics_are_supported(self):
        value = device(); value['_receiver_id'] = value.pop('receiver_id')
        for field in ('freq', 'rf', 'af_dbfs', 'batt', 'muted', '_online', '_age_s'):
            value.pop(field)
        live.record_snapshot(self.db, 'boot-a', [value], 1000)
        row = live.query_channels(self.db, 'boot-a', 1000)['channels'][0]
        self.assertEqual(row['receiver_id'], 'rx-a'); self.assertFalse(row['_online'])
        self.assertIsNone(row['last_seen_at_ms']); self.assertIsNone(row['muted'])

    def test_explicit_invalid_age_never_becomes_a_fresh_observation(self):
        for index, age in enumerate(('0', -1, float('nan'), None)):
            live.record_snapshot(self.db, 'boot-a', [device(_age_s=age)], 1000 + index)
            row = live.query_channels(self.db, 'boot-a', 1000 + index)['channels'][0]
            self.assertFalse(row['_online']); self.assertIsNone(row['last_seen_at_ms'])


if __name__ == '__main__':
    unittest.main()
