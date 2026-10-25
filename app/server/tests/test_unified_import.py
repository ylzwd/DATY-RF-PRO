"""Legacy SQL migration tests, only in-memory SQLite fixtures."""
import copy
import hashlib
import json
import sqlite3
import unittest

import unified_database as database
from unified_import import ImportError, apply_import, preview_import
from unified_schema import LEGACY_DDL
from unified_consistency import verify_consistency


def planning_record(identifier='r1', include_project=True):
    value = {'id': identifier, 'type': 'daty_rf_planning', 'version': '1.0.3',
             'timestamp': 1000, 'channels': 1, 'devices': [{'id': 1, 'brand': 'DATYaudio',
                 'freq': 641000, 'planned': 641000, '_source': 'fixture-receiver'}],
             'constraints': {'backupCount': 0}, 'options': {'backupCount': 0},
             'futureRecord': {'preserve': True}}
    if include_project:
        value['projectId'] = 'p1'
    return value


class UnifiedImportTests(unittest.TestCase):
    def setUp(self):
        self.c = sqlite3.connect(':memory:')
        self.addCleanup(self.c.close)
        self.c.execute('PRAGMA foreign_keys=ON')
        for statement in LEGACY_DDL:
            self.c.execute(statement)
        self.raw_data = '{ "planningHistory": ' + json.dumps([planning_record()], ensure_ascii=False) + ', "currentPlanningRecordId": "r1", "futureProject": {"keep": 7} }'
        self.c.execute('INSERT INTO projects VALUES(?,?,?,?,?)', ('p1', 'Fixture project', self.raw_data, 1, 2))
        self.device = {'id': 1, 'brand': 'DATYaudio', 'freq': 641000, '_source': 'real-fixture'}
        self.c.execute('INSERT INTO project_devices VALUES(?,?,?)', ('p1', '1', json.dumps(self.device)))
        self.c.execute('INSERT INTO coordination_runs VALUES(?,?,?,?,?,?)',
            ('run1', 'p1', '{"devices":[]}', '{"assignments":[]}', '{"origin":"legacy"}', 2))
        self.c.commit()
        with self.c:
            self.state = database.migrate(self.c, 100)
        self.actor = {'id': 'fixture-operator', 'role': 'operator'}

    def preview(self, projects=None):
        self.c.execute('BEGIN')
        try:
            return preview_import(self.c, projects)
        finally:
            self.c.rollback()

    def apply(self, plan, operation='fixture_import_123456789', **extra):
        with self.c:
            self.c.execute('BEGIN')
            return apply_import(self.c, project_ids=plan['selectedProjectIds'], confirmed=True,
                expected_preview_digest=plan['previewDigest'], operation_id=operation,
                epoch=plan['epoch'], actor=self.actor, now_ms=200, **extra)

    def source(self, data):
        self.c.execute('UPDATE projects SET project_json=? WHERE id=?', (json.dumps(data), 'p1'))
        self.c.commit()

    def resource(self, kind, identifier):
        return database.get_resource(self.c, kind, identifier)

    def test_preview_requires_stable_transaction_and_writes_nothing(self):
        with self.assertRaises(ImportError):
            preview_import(self.c)
        before = self.c.total_changes
        plan = self.preview()
        self.assertTrue(plan['ready'])
        self.assertEqual(self.c.total_changes, before)
        self.assertEqual(self.c.execute('SELECT count(*) FROM db_resources').fetchone()[0], 0)
        self.assertEqual(plan['sourceTables'], ['projects', 'project_devices', 'coordination_runs'])
        self.assertIn('telemetry_samples', plan['untouchedLegacyTables'])

    def test_atomic_import_preserves_unknowns_original_json_and_no_receiver_inference(self):
        plan = self.preview()
        before = self.c.execute('SELECT * FROM projects').fetchall()
        result = self.apply(plan)
        self.assertEqual(result['written'], 7)
        self.assertEqual(self.c.execute('SELECT * FROM projects').fetchall(), before)
        metadata = self.resource('project_metadata', 'p1')['value']
        self.assertEqual(metadata, {'id': 'p1', 'name': 'Fixture project', 'data': {'futureProject': {'keep': 7}}})
        current = self.resource('planning_current', 'p1')['value']
        self.assertEqual(current['currentRecordId'], 'r1')
        self.assertEqual(current['devices'], [self.device])
        self.assertEqual(self.resource('planning_records', 'r1')['value'], planning_record())
        stored = self.c.execute("SELECT payload_json FROM db_legacy_snapshots WHERE source_origin='legacy-sqlite:projects'").fetchone()[0]
        self.assertEqual(json.loads(stored)['row']['project_json'], self.raw_data)
        self.assertEqual(self.c.execute('SELECT count(*) FROM live_receivers').fetchone()[0], 0)
        self.assertIsNone(self.c.execute('SELECT receiver_id FROM biz_planning_channels').fetchone()[0])
        run = self.resource('planning_runs', 'run1')['value']
        self.assertFalse(run['deploymentEligible'])
        self.assertEqual(run['inputVerification'], 'legacy-unverified')
        self.assertEqual(run['baseline'], {'origin': 'legacy'})
        self.assertEqual(self.c.execute('SELECT state FROM db_import_batches').fetchone()[0], 'committed')
        self.assertEqual(verify_consistency(self.c)['unchecked_projection_kinds'], [])

    def test_missing_record_project_id_only_is_attributed_and_original_remains_exact(self):
        original = planning_record(include_project=False)
        self.source({'planningHistory': [original], 'currentPlanningRecordId': 'r1'})
        self.apply(self.preview())
        migrated = self.resource('planning_records', 'r1')['value']
        self.assertEqual(migrated, {**original, 'projectId': 'p1'})
        archived = json.loads(self.c.execute("SELECT payload_json FROM db_legacy_snapshots WHERE source_origin='legacy-sqlite:projects'").fetchone()[0])
        self.assertNotIn('projectId', json.loads(archived['row']['project_json'])['planningHistory'][0])
        self.assertEqual(archived['attribution'][0]['path'], '/planningHistory/0/projectId')

    def test_deleted_source_history_archived_without_active_resurrection(self):
        self.source({'planningHistory': [planning_record()], 'deletedRecordIds': ['r1'], 'currentPlanningRecordId': None})
        plan = self.preview()
        self.assertEqual(plan['archivedDeletedRecords'], [{'projectId': 'p1', 'id': 'r1'}])
        self.assertFalse(any(write['kind'] == 'planning_records' for write in plan['draftWrites']))
        self.apply(plan)
        self.assertIsNone(self.resource('planning_records', 'r1'))
        self.assertEqual(self.c.execute('SELECT record_id FROM biz_planning_tombstones').fetchone()[0], 'r1')
        self.assertEqual(verify_consistency(self.c)['versions_checked'], 6)

    def test_existing_identical_targets_skip_and_new_operation_can_commit_noop_manifest(self):
        self.apply(self.preview())
        plan = self.preview()
        self.assertTrue(plan['ready'])
        self.assertEqual(plan['draftWrites'], [])
        self.assertEqual(len(plan['skipped']), 7)
        result = self.apply(plan, 'fixture_noop_import_123456789')
        self.assertEqual(result['written'], 0)
        self.assertIsNone(result['batchOperationId'])
        self.assertEqual(self.c.execute('SELECT count(*) FROM db_import_batches').fetchone()[0], 2)

    def test_existing_different_target_conflicts_never_overwrites(self):
        with self.c:
            database.put_resource(self.c, {'operation_id': 'fixture_preexisting_123456789', 'epoch': self.state['epoch'],
                'kind': 'project_metadata', 'id': 'p1', 'expected_revision': 0,
                'value': {'id': 'p1', 'name': 'new user data', 'data': {}}}, self.actor, 150)
        plan = self.preview()
        self.assertFalse(plan['ready'])
        self.assertIn('EXISTING_TARGET_DIFFERS', [item['code'] for item in plan['conflicts']])
        with self.assertRaises(ImportError):
            self.apply(plan)
        self.assertEqual(self.resource('project_metadata', 'p1')['value']['name'], 'new user data')
        self.assertEqual(self.c.execute('SELECT count(*) FROM db_import_batches').fetchone()[0], 0)

    def test_changed_source_or_target_after_preview_invalidates_confirmation(self):
        plan = self.preview()
        self.c.execute('UPDATE projects SET name=? WHERE id=?', ('source changed', 'p1'))
        self.c.commit()
        with self.assertRaises(ImportError) as result:
            self.apply(plan)
        self.assertEqual(result.exception.code, 'IMPORT_PREVIEW_CHANGED')
        self.assertEqual(self.c.execute('SELECT count(*) FROM db_resources').fetchone()[0], 0)

    def test_changed_target_after_preview_cannot_be_overwritten(self):
        plan = self.preview()
        with self.c:
            database.put_resource(self.c, {'operation_id': 'fixture_concurrent_123456789', 'epoch': plan['epoch'],
                'kind': 'project_metadata', 'id': 'p1', 'expected_revision': 0,
                'value': {'id': 'p1', 'name': 'concurrent data', 'data': {}}}, self.actor, 180)
        with self.assertRaises(ImportError) as failure:
            self.apply(plan)
        self.assertEqual(failure.exception.code, 'IMPORT_PREVIEW_CHANGED')
        self.assertEqual(self.resource('project_metadata', 'p1')['value']['name'], 'concurrent data')

    def test_source_budget_refuses_before_materializing_all_rows(self):
        from unittest.mock import patch
        with patch.object(database, 'MAX_DOCUMENT_BYTES', 10):
            with self.assertRaises(ImportError) as failure:
                self.preview()
        self.assertEqual(failure.exception.code, 'IMPORT_SOURCE_TOO_LARGE')

    def test_boolean_and_number_are_not_equal_for_import_conflict(self):
        self.source({'futureProject':{'keep':True}})
        with self.c:
            database.put_resource(self.c, {'operation_id':'fixture_strict_json_123456789','epoch':self.state['epoch'],
                'kind':'project_metadata','id':'p1','expected_revision':0,
                'value':{'id':'p1','name':'Fixture project','data':{'futureProject':{'keep':1}}}},self.actor,180)
        plan=self.preview()
        self.assertFalse(plan['ready'])
        self.assertTrue(any(item['code']=='EXISTING_TARGET_DIFFERS' for item in plan['conflicts']))
        self.assertEqual(type(self.resource('project_metadata','p1')['value']['data']['futureProject']['keep']),int)

    def test_existing_tombstone_cannot_be_erased_by_old_active_source(self):
        with self.c:
            database.put_resource(self.c, {'operation_id': 'fixture_tombstone_123456789', 'epoch': self.state['epoch'],
                'kind': 'planning_current', 'id': 'p1', 'expected_revision': 0,
                'value': {'projectId': 'p1', 'currentRecordId': None, 'deletedRecordIds': ['r1'], 'devices': [self.device]}}, self.actor, 180)
        plan = self.preview()
        self.assertTrue(plan['ready'])
        self.apply(plan)
        self.assertIsNone(self.resource('planning_records', 'r1'))
        self.assertEqual(self.resource('planning_current', 'p1')['value']['deletedRecordIds'], ['r1'])

    def test_same_operation_returns_committed_receipt_after_source_changed(self):
        plan = self.preview()
        first = self.apply(plan)
        self.c.execute('UPDATE projects SET name=?', ('later source change',))
        self.c.commit()
        second = self.apply(plan)
        self.assertTrue(second['replayedReceipt'])
        self.assertEqual(first['resources'], second['resources'])
        self.assertEqual(self.c.execute('SELECT count(*) FROM db_import_batches').fetchone()[0], 1)

    def test_confirmation_epoch_and_actor_binding(self):
        plan = self.preview()
        self.c.execute('BEGIN')
        with self.assertRaises(ImportError) as result:
            apply_import(self.c, expected_preview_digest=plan['previewDigest'], operation_id='fixture_import_123456789',
                         epoch=plan['epoch'], actor=self.actor, now_ms=200)
        self.assertEqual(result.exception.code, 'IMPORT_CONFIRMATION_REQUIRED')
        self.c.rollback()
        self.apply(plan)
        old_actor = self.actor
        self.actor = {'id': 'another-operator'}
        with self.assertRaises(ImportError):
            self.apply(plan)
        self.actor = old_actor
        with self.c:
            database.rotate_recovery_epoch(self.c, plan['epoch'], 'new-fixture-recovery-epoch')
        with self.assertRaises(ImportError) as result:
            self.apply(plan)
        self.assertEqual(result.exception.code, 'DATABASE_EPOCH_CHANGED')

    def test_invalid_record_wrong_units_cross_project_duplicates_or_missing_fields_block(self):
        bad_values = []
        wrong = planning_record();wrong['devices'][0]['freq'] = 641.25;bad_values.append([wrong])
        wrong = planning_record();wrong['projectId'] = 'other';bad_values.append([wrong])
        wrong = planning_record();wrong.pop('timestamp');bad_values.append([wrong])
        bad_values.append([planning_record(), planning_record()])
        for values in bad_values:
            self.source({'planningHistory': values, 'currentPlanningRecordId': 'r1'})
            plan = self.preview()
            self.assertFalse(plan['ready'])
            with self.assertRaises(ImportError):
                self.apply(plan)
        self.assertEqual(self.c.execute('SELECT count(*) FROM db_resources').fetchone()[0], 0)

    def test_parsed_secret_and_duplicate_json_fields_block_even_when_raw_json_is_archived(self):
        for raw in ('{"password":"forbidden-secret"}', '{"planningHistory":[],"planningHistory":[]}'):
            self.c.execute('UPDATE projects SET project_json=?', (raw,))
            self.c.commit()
            plan = self.preview()
            self.assertFalse(plan['ready'])
            self.assertNotIn('forbidden-secret', json.dumps(plan))
            with self.assertRaises(ImportError):
                self.apply(plan)

    def test_legacy_constraints_only_remain_draft_without_invented_history(self):
        data = {'constraints': {'backupCount': 0, 'excludedRanges': []},
                'constraintFields': {'plannerBackupCount': '0'}, 'unknown': {'preserve': 'draft'}}
        self.source(data)
        self.apply(self.preview())
        self.assertIsNone(self.resource('planning_records', 'r1'))
        current = self.resource('planning_current', 'p1')['value']
        self.assertIsNone(current['currentRecordId'])
        self.assertEqual(current['constraints'], data['constraints'])
        self.assertEqual(current['constraintFields'], data['constraintFields'])

    def test_failure_after_batch_before_manifest_rolls_back_everything(self):
        plan = self.preview()
        # The trace callback's external interruption is not SQLite schema, so
        # exact schema validation remains enabled during this failure fixture.
        import unified_import
        original = unified_import.database.put_batch
        def fail_after_batch(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError('fixture failure before manifest')
        from unittest.mock import patch
        with patch.object(unified_import.database, 'put_batch', fail_after_batch):
            with self.assertRaises(RuntimeError):
                self.apply(plan)
        for table in ('db_import_batches', 'db_batches', 'db_resources', 'db_operations', 'biz_planning_records', 'db_legacy_snapshots'):
            self.assertEqual(self.c.execute('SELECT count(*) FROM ' + table).fetchone()[0], 0, table)
        self.assertEqual(self.c.execute('SELECT project_json FROM projects').fetchone()[0], self.raw_data)

    def test_invalid_run_blocks_entire_project(self):
        self.c.execute("UPDATE coordination_runs SET result_json='[]'")
        self.c.commit()
        plan = self.preview()
        self.assertFalse(plan['ready'])
        with self.assertRaises(ImportError):
            self.apply(plan)
        self.assertEqual(self.c.execute('SELECT count(*) FROM db_resources').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
