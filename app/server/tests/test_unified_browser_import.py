"""15-key explicit browser import, exclusively SQLite :memory: fixtures."""
import copy
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import unittest
from unittest.mock import patch

import unified_database as database
from unified_schema import LEGACY_DDL
from unified_consistency import verify_consistency
from unified_browser_import import FORMAT, TYPES, ImportError, preview_import, apply_import
from test_unified_domains import profile, record, alert


class BrowserImportTests(unittest.TestCase):
    def setUp(self):
        self.c = sqlite3.connect(':memory:')
        self.addCleanup(self.c.close)
        self.c.execute('PRAGMA foreign_keys=ON')
        for statement in LEGACY_DDL:
            self.c.execute(statement)
        self.c.execute('INSERT INTO projects VALUES(?,?,?,?,?)', ('p1', 'Old SQL name', '{"keep":"original"}', 1, 2))
        self.c.commit()
        with self.c:
            self.meta = database.migrate(self.c, 100)
        self.actor = {'id': 'fixture-operator', 'name': 'Explicit operator', 'role': 'operator'}
        self.source = {'format': FORMAT, 'version': 1, 'sourceOrigin': 'http://localhost:8080',
                       'createdAt': '2026-09-13T00:00:00.000Z', 'values': {}}

    def set_value(self, key, value):
        self.source['values'][key] = value if key.startswith('spec') else json.dumps(value, ensure_ascii=False)

    def planning(self, selected=True):
        self.set_value('daty_planning_history_v1', {'project': {'id': 'p1', 'name': 'Browser project'},
            'records': [record()], 'currentRecordId': 'r1' if selected else None, 'deletedRecordIds': []})

    def preview(self, **kwargs):
        self.c.execute('BEGIN')
        try:
            return preview_import(self.c, self.source, **kwargs)
        finally:
            self.c.rollback()

    def apply(self, plan, **kwargs):
        options = {'preference_id': plan['preferenceId'], 'confirmed': True, 'expected_preview_digest': plan['previewDigest'],
            'operation_id': 'browser_import_123456789', 'epoch': plan['epoch'], 'actor': self.actor, 'now_ms': 200}
        options.update(kwargs)
        with self.c:
            self.c.execute('BEGIN')
            return apply_import(self.c, self.source, **options)

    def get(self, kind, identifier):
        return database.get_resource(self.c, kind, identifier)

    def count(self, table='db_resources'):
        return self.c.execute('SELECT count(*) FROM ' + table).fetchone()[0]

    def test_whitelist_exactly_matches_existing_browser_backup_contract(self):
        source = (Path(__file__).resolve().parents[1] / 'src/platform/browser-data-migration.js').read_text(encoding='utf-8')
        block = source.split('const TYPES = Object.freeze({', 1)[1].split('});', 1)[0]
        self.assertEqual(set(TYPES), set(re.findall(r"(\w+):'(?:array|object|frequency)'", block)))
        self.assertEqual(len(TYPES), 15)

    def test_preview_requires_transaction_and_never_mutates_any_row(self):
        with self.assertRaises(ImportError):
            preview_import(self.c, self.source)
        self.set_value('daty_alert_sound_v1', {'enabled': True})
        before = self.c.total_changes
        plan = self.preview()
        self.assertTrue(plan['ready'])
        self.assertEqual(self.c.total_changes, before)
        self.assertEqual(self.count(), 0)

    def test_all_fifteen_keys_normalize_supported_domains_and_separate_archives(self):
        self.planning()
        for key, value in {
            'daty_devices': [{'id': 7, '_online': True, 'freq': 641000}],
            'daty_alerts': [{'message': 'cached display event'}],
            'daty_db_alerts': [alert()], 'daty_pending_alerts_v1': [alert()],
            'daty_alert_archive_meta_v1': {'savedAt': 1100},
            'daty_equipment_profiles_v1': [profile()], 'daty_equipment_profiles_v2': [profile()],
            'daty_planner_constraints_v1': {'plannerBackupCount': '2'},
            'daty_alert_thresholds_v1': {'rfWeakDbm': -85, 'batteryLowPercent': 20, 'afOverloadDbfs': -3},
            'daty_receiver_group_numbers_v1': {'receiver-mac': 3},
            'daty_alert_sound_v1': {'enabled': True}, 'daty_auto_frequency_v1': {'enabled': False},
            'specStartFreq': '640.000', 'specEndFreq': '690.000',
        }.items():
            self.set_value(key, value)
        old = self.c.execute('SELECT * FROM projects').fetchall()
        plan = self.preview(preference_id='view:fixture-operator')
        self.assertTrue(plan['ready'], plan['conflicts'])
        self.assertEqual(len(plan['normalizedKeys']), 10)
        self.assertEqual(len(plan['archivedOnlyKeys']), 5)
        self.assertEqual(plan['unsupportedKeys'], [])
        result = self.apply(plan)
        self.assertEqual(result['written'], 24)  # 15 sources + 9 normalized resources
        self.assertEqual(self.c.execute('SELECT * FROM projects').fetchall(), old)
        self.assertEqual(self.get('planning_records', 'r1')['value'], record())
        self.assertEqual(self.get('planning_current', 'p1')['value']['devices'], record()['devices'])
        self.assertEqual(self.get('settings', 'alert_sound')['value'], {'enabled': True})
        self.assertEqual(self.get('preferences', 'view:fixture-operator')['value'], {'specStartFreq': '640.000', 'specEndFreq': '690.000'})
        for table in ['live_receivers', 'live_channels', 'live_commands', 'commands', 'telemetry_samples']:
            self.assertEqual(self.count(table), 0, table)
        verify_consistency(self.c)

    def test_source_archives_preserve_exact_raw_spacing_origin_key_and_digest(self):
        raw = ' { "enabled" : true, "future" : "保留" } '
        self.source['values']['daty_alert_sound_v1'] = raw
        self.apply(self.preview())
        value = json.loads(self.c.execute('SELECT payload_json FROM db_legacy_snapshots').fetchone()[0])
        self.assertEqual(value['raw'], raw)
        self.assertEqual(value['sha256'], hashlib.sha256(raw.encode()).hexdigest())
        origin, key = self.c.execute('SELECT source_origin,source_key FROM db_legacy_snapshots').fetchone()
        self.assertEqual((origin, key), ('http://localhost:8080', 'daty_alert_sound_v1'))
        self.assertEqual(self.get('settings', 'alert_sound')['value']['future'], '保留')

    def test_v2_priority_never_silently_discards_different_v1_profile(self):
        v1, v2 = profile(), profile()
        v1['priority'] += 1
        self.set_value('daty_equipment_profiles_v1', [v1]); self.set_value('daty_equipment_profiles_v2', [v2])
        plan = self.preview()
        self.assertFalse(plan['ready'])
        self.assertIn('SOURCE_TARGET_CONTENT_CONFLICT', [item['code'] for item in plan['conflicts']])
        with self.assertRaises(ImportError):
            self.apply(plan)
        self.assertEqual(self.count(), 0)

    def test_invalid_profiles_settings_and_units_fail_preview_without_clamping(self):
        for key, value in [('daty_alert_thresholds_v1', {'rfWeakDbm': -95, 'batteryLowPercent': 20, 'afOverloadDbfs': -3}),
                           ('daty_alert_sound_v1', {'enabled': 1}), ('daty_equipment_profiles_v2', [{'id': 'incomplete'}])]:
            self.source['values'].clear(); self.set_value(key, value)
            plan = self.preview(); self.assertFalse(plan['ready']); self.assertIn(key, plan['unsupportedKeys'])
        self.assertEqual(self.count(), 0)

    def test_missing_record_project_is_explicitly_attributed_but_raw_is_not_rewritten(self):
        value = record(); del value['projectId']
        self.set_value('daty_planning_history_v1', {'project': {'id': 'p1', 'name': 'Browser'}, 'records': [value], 'currentRecordId': 'r1', 'deletedRecordIds': []})
        plan = self.preview(); self.assertTrue(plan['ready']); self.assertEqual(plan['attribution'][0]['path'], '/records/0/projectId')
        self.apply(plan)
        self.assertEqual(self.get('planning_records', 'r1')['value']['projectId'], 'p1')
        archived = json.loads(self.c.execute('SELECT payload_json FROM db_legacy_snapshots').fetchone()[0])
        self.assertNotIn('projectId', json.loads(archived['raw'])['records'][0])

    def test_mult_project_history_is_explicitly_unsupported_not_reassigned(self):
        self.set_value('daty_planning_history_v1', {'project': {'id': 'p1', 'name': 'Browser'}, 'records': [record(project='other')], 'currentRecordId': None, 'deletedRecordIds': []})
        plan = self.preview(); self.assertFalse(plan['ready'])
        self.assertEqual(plan['conflicts'][0]['code'], 'UNSUPPORTED_MULTI_PROJECT_HISTORY')
        self.assertEqual(self.count(), 0)

    def test_deleted_browser_history_is_archived_without_active_resurrection(self):
        self.set_value('daty_planning_history_v1', {'project': {'id': 'p1', 'name': 'Browser'}, 'records': [record()], 'currentRecordId': None, 'deletedRecordIds': ['r1']})
        plan = self.preview(); self.assertTrue(plan['ready']); self.apply(plan)
        self.assertIsNone(self.get('planning_records', 'r1'))
        self.assertEqual(self.get('planning_current', 'p1')['value']['deletedRecordIds'], ['r1'])
        verify_consistency(self.c)

    def test_unknown_or_deleted_selection_is_a_blocking_conflict(self):
        for selected, deleted in [('missing', []), ('r1', ['r1'])]:
            self.set_value('daty_planning_history_v1', {'project': {'id': 'p1', 'name': 'Browser'}, 'records': [record()], 'currentRecordId': selected, 'deletedRecordIds': deleted})
            plan = self.preview(); self.assertFalse(plan['ready'])
            self.assertIn('INVALID_BROWSER_CURRENT', [item['code'] for item in plan['conflicts']])

    def test_old_alert_without_stable_identity_is_not_given_fabricated_times_or_ids(self):
        self.set_value('daty_db_alerts', [{'id': 1, 'ts': 1000, 'metric': 'rf'}])
        plan = self.preview(); self.assertFalse(plan['ready'])
        self.assertEqual(plan['unsupportedKeys'], ['daty_db_alerts'])
        self.assertEqual(plan['conflicts'][0]['code'], 'ALERT_STABLE_IDENTITY_REQUIRED')
        self.assertNotIn('alerts', [item['kind'] for item in plan['draftWrites']])

    def test_conflicting_alert_archive_and_pending_never_choose_a_newer_value_silently(self):
        self.set_value('daty_db_alerts', [alert()]); self.set_value('daty_pending_alerts_v1', [alert(ended=True)])
        plan = self.preview(); self.assertFalse(plan['ready'])
        self.assertIn('SOURCE_TARGET_CONTENT_CONFLICT', [item['code'] for item in plan['conflicts']])

    def test_range_requires_explicit_view_scope_pair_and_increasing_valid_mhz(self):
        self.set_value('specStartFreq', '640.000')
        self.assertFalse(self.preview(preference_id='view:operator')['ready'])
        self.set_value('specEndFreq', '690.000'); self.assertFalse(self.preview()['ready'])
        self.assertTrue(self.preview(preference_id='view:operator')['ready'])
        self.set_value('specEndFreq', '639.000'); self.assertFalse(self.preview(preference_id='view:operator')['ready'])

    def test_wrong_origin_format_unknown_keys_duplicate_json_and_hidden_secrets_are_rejected(self):
        original = copy.deepcopy(self.source)
        for mutate in [lambda b: b.update(sourceOrigin='unknown'), lambda b: b.update(sourceOrigin='https://user:pass@server:8080'),
                       lambda b: b.update(sourceOrigin='https://server:8080/path'), lambda b: b.update(sourceOrigin='https://server:bad'),
                       lambda b: b.update(version=True), lambda b: b['values'].update(unknown='[]'),
                       lambda b: b['values'].update(daty_devices='[{"access_token":"forbidden"}]'),
                       lambda b: b['values'].update(daty_alert_sound_v1='{"enabled":true,"enabled":false}'),
                       lambda b: b['values'].update(daty_devices='[{"rf":NaN}]'),
                       lambda b: b['values'].update(daty_devices='[{"__proto__":{}}]')]:
            self.source = copy.deepcopy(original); mutate(self.source)
            with self.assertRaises(ImportError):
                self.preview()
        self.assertEqual(self.count(), 0)

    def test_existing_identical_targets_skip_different_targets_conflict_and_never_overwrite(self):
        self.set_value('daty_alert_sound_v1', {'enabled': True}); plan = self.preview(); self.apply(plan)
        again = self.preview(); self.assertTrue(again['ready']); self.assertEqual(again['draftWrites'], []); self.assertEqual(len(again['skipped']), 2)
        self.set_value('daty_alert_sound_v1', {'enabled': False}); conflict = self.preview(); self.assertFalse(conflict['ready'])
        self.assertIn('EXISTING_TARGET_DIFFERS', [item['code'] for item in conflict['conflicts']])
        self.assertEqual(self.get('settings', 'alert_sound')['value'], {'enabled': True})

    def test_changed_source_raw_or_target_after_preview_requires_new_confirmation(self):
        self.set_value('daty_alert_sound_v1', {'enabled': True}); plan = self.preview()
        self.source['values']['daty_alert_sound_v1'] = ' {"enabled":true}'
        with self.assertRaisesRegex(ImportError, 'changed'):
            self.apply(plan)
        self.assertEqual(self.count(), 0)
        plan = self.preview()
        with self.c:
            database.put_resource(self.c, {'operation_id': 'external_fixture_123456', 'epoch': self.meta['epoch'], 'kind': 'settings', 'id': 'alert_sound', 'expected_revision': 0, 'value': {'enabled': False}}, self.actor, 200)
        with self.assertRaisesRegex(ImportError, 'changed'):
            self.apply(plan)
        self.assertEqual(self.count('db_legacy_snapshots'), 0)

    def test_confirmation_epoch_actor_and_operation_intent_are_bound(self):
        self.set_value('daty_alert_sound_v1', {'enabled': True}); plan = self.preview()
        for changes in [{'confirmed': False}, {'epoch': 'restored'}, {'actor': None}]:
            with self.assertRaises(ImportError):
                self.apply(plan, **changes)
        first = self.apply(plan); again = self.apply(plan)
        self.assertFalse(first['replayedReceipt']); self.assertTrue(again['replayedReceipt']); self.assertEqual(self.count('db_import_batches'), 1)
        for changes in [{'actor': {'id': 'other'}}, {'preference_id': 'view:other'}, {'expected_preview_digest': '0' * 64}]:
            with self.assertRaises(ImportError):
                self.apply(plan, **changes)
        self.set_value('daty_alert_sound_v1', {'enabled': False})
        with self.assertRaises(ImportError):
            self.apply(plan)
        self.assertEqual(self.get('settings', 'alert_sound')['revision'], 1)

    def test_atomic_late_failure_rolls_back_normalized_source_and_manifest_together(self):
        self.set_value('daty_alert_sound_v1', {'enabled': True}); plan = self.preview()
        original = database.put_resource
        def fail_archive(connection, body, *args, **kwargs):
            if body['kind'] == 'legacy_snapshots':
                raise RuntimeError('injected final archive failure')
            return original(connection, body, *args, **kwargs)
        with patch.object(database, 'put_resource', fail_archive):
            with self.assertRaises(RuntimeError):
                self.apply(plan)
        for table in ('db_resources', 'db_import_batches', 'db_batches', 'db_audit', 'db_legacy_snapshots'):
            self.assertEqual(self.count(table), 0, table)

    def test_archive_only_backup_does_not_claim_normalized_receiver_or_control_state(self):
        self.set_value('daty_devices', [{'id': 'old', '_online': True, 'muted': True, 'freq': 641000}])
        self.set_value('daty_receiver_group_numbers_v1', {'old': 1})
        plan = self.preview(); self.assertTrue(plan['ready']); self.assertEqual(plan['normalizedKeys'], [])
        self.assertEqual(len(plan['archivedOnlyKeys']), 2); self.apply(plan)
        self.assertEqual(self.count(), 2); self.assertEqual(self.count('live_receivers'), 0)
        self.assertEqual(self.count('live_commands'), 0)

    def test_backup_outer_json_text_and_raw_unicode_are_supported(self):
        self.set_value('daty_alert_sound_v1', {'enabled': True, 'note': '中文'})
        body = self.source; self.source = json.dumps(body, ensure_ascii=False)
        plan = self.preview(); self.assertTrue(plan['ready']); self.apply(plan)
        self.assertEqual(self.get('settings', 'alert_sound')['value']['note'], '中文')

    def test_exact_content_comparison_does_not_equate_json_true_and_one(self):
        self.set_value('daty_alert_sound_v1', {'enabled': True, 'unknown': True})
        self.apply(self.preview())
        self.set_value('daty_alert_sound_v1', {'enabled': True, 'unknown': 1})
        plan = self.preview(); self.assertFalse(plan['ready'])
        self.assertEqual(plan['conflicts'][0]['code'], 'EXISTING_TARGET_DIFFERS')

    def test_duplicate_invalid_profile_cannot_bypass_validation_via_python_equality(self):
        valid, invalid = profile(), profile()
        valid['priority'] = 1; invalid['priority'] = True
        self.set_value('daty_equipment_profiles_v2', [valid]); self.set_value('daty_equipment_profiles_v1', [invalid])
        plan = self.preview(); self.assertFalse(plan['ready'])
        self.assertIn('daty_equipment_profiles_v1', plan['unsupportedKeys'])

    def test_over_batch_limit_refuses_whole_import_without_split(self):
        items = []
        for index in range(1000):
            item = alert(); item['archiveId'] = 'fixture-' + str(index); items.append(item)
        self.set_value('daty_db_alerts', items)
        plan = self.preview(); self.assertFalse(plan['ready'])
        self.assertIn('IMPORT_BATCH_TOO_LARGE', [item['code'] for item in plan['conflicts']])
        with self.assertRaises(ImportError):
            self.apply(plan)
        self.assertEqual(self.count(), 0)


if __name__ == '__main__':
    unittest.main()
