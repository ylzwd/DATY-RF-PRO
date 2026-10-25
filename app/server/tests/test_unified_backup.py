"""Strict closed-backup verification and epoch rehearsal, temporary data only."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from unittest import mock

import unified_database as database
from unified_schema import LEGACY_DDL, LEGACY_TABLES, SchemaError, validate_schema
from unified_consistency import ConsistencyError, verify_consistency
from test_unified_domains import profile as profile_fixture

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('unified_backup_fixture', ROOT / 'scripts' / 'verify-unified-business-backup.py')
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


class UnifiedBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='daty-unified-backup-tests-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.serial = 0

    def fixture(self, unified=True, mutation=None, revision=False):
        self.serial += 1
        path = self.root / ('fixture-' + str(self.serial) + '.backup.sqlite3')
        connection = sqlite3.connect(str(path))
        try:
            connection.execute('PRAGMA foreign_keys=ON')
            for sql in LEGACY_DDL:
                connection.execute(mutation(sql) if mutation else sql)
            connection.execute('INSERT INTO projects VALUES(?,?,?,?,?)', ('p1', 'fixture', '{}', 1, 1))
            connection.commit()
            if unified:
                with connection:
                    state = database.migrate(connection, 100)
                    database.put_resource(connection, {'kind': 'settings', 'id': 'alert_sound', 'value': {'enabled': True},
                        'expected_revision': 0, 'epoch': state['epoch'], 'operation_id': 'fixture_operation_123456'},
                        {'id': 'fixture-operator', 'role': 'operator'}, 101)
            elif revision:
                connection.execute('ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
                connection.commit()
        finally:
            connection.close()
        return path

    def change(self, path, sql):
        connection = sqlite3.connect(str(path))
        try:
            connection.executescript(sql)
        finally:
            connection.close()

    def put(self, path, kind, identifier, value, *, deleted=False):
        connection = sqlite3.connect(path)
        try:
            connection.execute('PRAGMA foreign_keys=ON')
            with connection:
                prior = database.get_resource(connection,kind,identifier)
                return database.put_resource(connection, {'operation_id':uuid.uuid4().hex,
                    'epoch':database.status(connection)['epoch'],'kind':kind,'id':identifier,
                    'expected_revision':prior['revision'] if prior else 0,'value':value,'deleted':deleted},
                    {'id':'fixture-operator','role':'operator'}, 300)
        finally:
            connection.close()

    def core_bundle(self):
        path = self.fixture()
        scan = {'projectId':'p1','name':'fixture measured scan','sourceKind':'imported_csv',
                'frequencyUnit':'kHz','levelUnit':'dBm',
                'points':[{'frequencyKHz':641000,'levelDbm':-85},{'frequencyKHz':641250,'levelDbm':-80}],
                'original':{'name':'fixture.csv','text':'frequency_MHz,level_dBm\n641.000,-85\n641.250,-80\n'}}
        simulation = {'projectId':'p1','sourceKind':'simulation','options':{'peakWidthKHz':100,
            'floorDbm':-100,'rippleDb':2.5,'textureStepKHz':5,'thresholdDbm':-85,'imdSuppressionDb':45,
            'includeImd':True,'includeFifth':False,'includeThreeTone':True}}
        run = {'projectId':'p1','input':{'source':'fixture'},'result':{'assignments':[]},
               'engineVersion':'fixture','scanId':'scan-1','profileRefs':[{'id':'test-daty','revision':1}]}
        values = {'project_metadata':('p1',{'id':'p1','name':'current metadata','data':{'keep':True}}),
            'manual_devices':('manual-1',{'id':'manual-1','source':'manual','brand':'DATYaudio','model':'fixture',
                'name':'manual fixture','configuredFrequencyKHz':641000,'configuredChannelNumber':1,'configuredIp':'192.0.2.2'}),
            'legacy_snapshots':('legacy-1',{'sourceOrigin':'fixture-local','sourceKey':'fixture-key','payload':{'untouched':[1,False,None]}}),
            'simulation_settings':('p1',simulation), 'profiles':('test-daty',profile_fixture()),
            'scans':('scan-1',scan),'scan_current':('p1',{'projectId':'p1','scanId':'scan-1'}),
            'planning_runs':('run-1',run)}
        for kind,(identifier,value) in values.items():
            self.put(path,kind,identifier,value)
        return path, values

    def tamper_document(self,path,kind,identifier,value,projection_sql,params):
        # Test-only coordinated corruption: update digest too, so this exercises
        # semantic/reference checks rather than stopping at the byte digest.
        raw = json.dumps(value,ensure_ascii=False,allow_nan=False,sort_keys=True,separators=(',',':'))
        connection = sqlite3.connect(path)
        try:
            with connection:
                connection.execute('UPDATE db_resource_versions SET value_json=?,digest=? WHERE kind=? AND id=?',
                    (raw,hashlib.sha256(raw.encode()).hexdigest(),kind,identifier))
                connection.execute(projection_sql,params)
        finally:
            connection.close()

    def test_original_bridge_legacy_schema_is_supported_without_importing_service(self):
        source = ast.parse((ROOT / 'mqtt-bridge.py').read_text(encoding='utf-8-sig'))
        init = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == '_init_database')
        schema = next(ast.literal_eval(node.value) for node in init.body if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == 'schema' for target in node.targets))
        connection = sqlite3.connect(':memory:')
        try:
            connection.executescript(schema)
            result = validate_schema(connection)
            self.assertEqual(result['schema_kind'], 'legacy')
            self.assertEqual(set(result['tables']), set(LEGACY_TABLES))
        finally:
            connection.close()

    def test_old_seven_tables_and_legacy_revision_supported(self):
        for revision, kind in [(False, 'legacy'), (True, 'legacy-revision')]:
            path = self.fixture(False, revision=revision)
            before = path.read_bytes()
            result = backup.preview(path)
            self.assertTrue(result['success'])
            self.assertEqual(result['schema_kind'], kind)
            self.assertEqual(result['table_counts']['projects'], 1)
            self.assertIn('sqlite_sequence', result['table_sha256'])
            self.assertEqual(path.read_bytes(), before)

    def test_unified_all_tables_digests_identity_and_version(self):
        path = self.fixture()
        before = path.read_bytes()
        result = backup.preview(path)
        self.assertEqual(result['schema_version'], database.SCHEMA_VERSION)
        self.assertEqual(set(result['tables']), database.supported_tables())
        self.assertEqual(set(result['table_counts']), database.supported_tables() | {'sqlite_sequence'})
        self.assertEqual(result['table_counts']['db_operations'], 1)
        self.assertTrue(result['instance_id'])
        self.assertTrue(result['epoch'])
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(Path(str(path) + '-wal').exists())
        self.assertNotIn('fixture-operator', json.dumps(result))

    def test_unknown_extra_table_column_trigger_view_and_index_refused(self):
        mutations = ['CREATE TABLE extra_business(id INTEGER PRIMARY KEY)',
                     'ALTER TABLE biz_settings ADD COLUMN unauthorized TEXT',
                     "CREATE TRIGGER injected AFTER INSERT ON projects BEGIN SELECT 1; END",
                     'CREATE VIEW unknown_view AS SELECT * FROM projects',
                     'CREATE INDEX extra_index ON biz_settings(enabled)']
        for sql in mutations:
            with self.subTest(sql=sql):
                path = self.fixture()
                self.change(path, sql)
                with self.assertRaises(SchemaError):
                    backup.preview(path)

    def test_missing_or_changed_index_not_accepted(self):
        for sql in ['DROP INDEX idx_timeline_ts',
                    'DROP INDEX idx_timeline_ts; CREATE INDEX idx_timeline_ts ON timeline_events(ts ASC)',
                    'DROP INDEX idx_live_active_boot; CREATE INDEX idx_live_active_boot ON live_boots((1))']:
            path = self.fixture()
            self.change(path, sql)
            with self.assertRaises(SchemaError):
                backup.preview(path)

    def test_wrong_legacy_primary_key_foreign_key_type_and_default_refused(self):
        changes = [lambda sql: sql.replace('id TEXT PRIMARY KEY, name', 'id TEXT UNIQUE, name'),
                   lambda sql: sql.replace('ON DELETE CASCADE', 'ON DELETE RESTRICT'),
                   lambda sql: sql.replace('battery_percent REAL', 'battery_percent TEXT'),
                   lambda sql: sql.replace("DEFAULT '{}'", "DEFAULT '[]'")]
        for change in changes:
            with self.subTest(change=change):
                path = self.fixture(False, change)
                with self.assertRaises(SchemaError):
                    backup.preview(path)

    def test_changed_check_unique_strict_or_fk_in_current_candidate_refused(self):
        originals = database.schema_statements()
        changes = [lambda sql: sql.replace('CHECK(singleton=1)', 'CHECK(singleton>=1)'),
                   lambda sql: sql.replace('UNIQUE(scan_id,frequency_khz)', ''),
                   lambda sql: sql.replace(') STRICT', ')'),
                   lambda sql: sql.replace('ON DELETE CASCADE', 'ON DELETE RESTRICT')]
        for change in changes:
            path = self.fixture()
            # writable_schema is ONLY used on this synthetic closed fixture to
            # remove a constraint without also changing its row data/indexes.
            connection = sqlite3.connect(str(path))
            try:
                rows = connection.execute("SELECT name,sql FROM sqlite_master WHERE type='table'").fetchall()
                target = next(((name, sql, change(sql)) for name, sql in rows if change(sql) != sql), None)
                if target is None:
                    continue
                connection.execute('PRAGMA writable_schema=ON')
                changed = target[2].replace(', ,', ',').replace(', )', ')')
                connection.execute('UPDATE sqlite_master SET sql=? WHERE name=?', (changed, target[0]))
                connection.commit()
            finally:
                connection.close()
            with self.assertRaises((SchemaError, sqlite3.DatabaseError)):
                backup.preview(path)
        self.assertEqual(database.schema_statements(), originals)

    def test_metadata_checksum_version_and_epoch_tampering_refused(self):
        for sql in ["UPDATE db_schema_migrations SET checksum='wrong'", 'PRAGMA user_version=999',
                    "UPDATE db_identity SET epoch=''", 'DELETE FROM db_identity', 'PRAGMA application_id=99']:
            path = self.fixture()
            self.change(path, sql)
            with self.assertRaises(SchemaError):
                backup.preview(path)

    def test_foreign_key_corruption_refused_despite_correct_schema(self):
        path = self.fixture()
        self.change(path, "PRAGMA foreign_keys=OFF; INSERT INTO project_devices VALUES('missing','d','{}')")
        with self.assertRaisesRegex(ValueError, 'foreign keys'):
            backup.preview(path)

    def test_manifest_requires_every_table_digest_and_never_follows_embedded_paths(self):
        path = self.fixture()
        manifest = self.root / 'manifest.json'
        report = backup.preview(path)
        report['source'] = 'E:\\never-follow-this'
        manifest.write_text(json.dumps(report), encoding='utf-8')
        self.assertTrue(backup.preview(path, manifest)['manifest_verified'])
        report['table_sha256'].pop('biz_settings')
        manifest.write_text(json.dumps(report), encoding='utf-8')
        with self.assertRaises(ValueError):
            backup.preview(path, manifest)

    def test_rehearsal_copies_all_tables_without_touching_source(self):
        path = self.fixture()
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        target = self.root / 'daty-unified-restore-copy'
        result = backup.rehearse(path, target)
        self.assertEqual(result['rehearsal'], 'verified')
        self.assertIsNone(result['recovery_rotation'])
        self.assertFalse(result['activation_performed'])
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        self.assertTrue(Path(result['restored']).is_file())

    def test_epoch_rotation_only_changes_isolated_copy_identity(self):
        path = self.fixture()
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        result = backup.rehearse(path, self.root / 'daty-unified-restore-rotated', rotate_epoch=True)
        rotation = result['recovery_rotation']
        self.assertNotEqual(rotation['previous_epoch'], rotation['epoch'])
        self.assertTrue(rotation['only_identity_changed'])
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        connection = sqlite3.connect(result['restored'])
        try:
            self.assertEqual(database.status(connection)['epoch'], rotation['epoch'])
            with self.assertRaises(database.DatabaseError) as error:
                database.get_operation(connection, 'fixture_operation_123456', 'fixture-operator')
            self.assertEqual(error.exception.code, 'DATABASE_EPOCH_CHANGED')
        finally:
            connection.close()

    def test_legacy_epoch_rotation_rejected_before_creating_target(self):
        target = self.root / 'daty-unified-restore-old'
        with self.assertRaises(ValueError):
            backup.rehearse(self.fixture(False), target, rotate_epoch=True)
        self.assertFalse(target.exists())

    def test_source_sidecars_nonbackup_running_name_and_existing_target_refused(self):
        path = self.fixture()
        for suffix in ('-wal', '-shm', '-journal'):
            sidecar = Path(str(path) + suffix)
            sidecar.write_bytes(b'fixture')
            with self.assertRaises(ValueError):
                backup.preview(path)
            sidecar.unlink()
        running = self.root / 'daty-rf.sqlite3'
        running.write_bytes(b'fixture')
        with self.assertRaises(ValueError):
            backup.preview(running)
        target = self.root / 'daty-unified-restore-existing'
        target.mkdir()
        with self.assertRaises(ValueError):
            backup.rehearse(path, target)
        self.assertEqual(list(target.iterdir()), [])

    def test_rehearsal_target_must_be_scoped_and_new(self):
        path = self.fixture()
        with self.assertRaises(ValueError):
            backup.rehearse(path, self.root / 'wrong-prefix')
        with self.assertRaises(ValueError):
            backup.rehearse(path, ROOT / 'daty-unified-restore-forbidden')
        self.assertFalse((ROOT / 'daty-unified-restore-forbidden').exists())

    def test_bounded_streaming_digest_does_not_read_entire_file(self):
        path = self.fixture(False)
        connection = sqlite3.connect(str(path))
        try:
            connection.executemany('INSERT INTO telemetry_samples(device_id,ts,frequency_khz) VALUES(?,?,?)',
                (('fixture', index, 641000) for index in range(5000)))
            connection.commit()
        finally:
            connection.close()
        with mock.patch.object(Path, 'read_bytes', side_effect=AssertionError('whole-file read forbidden')):
            result = backup.preview(path)
        self.assertEqual(result['table_counts']['telemetry_samples'], 5000)

    def test_invalid_budget_and_timeout_never_report_success(self):
        path = self.fixture()
        for bad in (0, 3601, True, float('nan')):
            with self.assertRaises(ValueError):
                backup.preview(path, budget_seconds=bad)
        with mock.patch.object(backup.time, 'monotonic', side_effect=[0, 2]):
            with self.assertRaises(TimeoutError):
                backup.preview(path, budget_seconds=1)

    def test_semantic_latest_digest_audit_operation_and_projection_tampering_detected(self):
        cases = [
            ('UPDATE db_resources SET revision=9', 'LATEST_REVISION_MISMATCH'),
            ("UPDATE db_resource_versions SET digest='wrong'", 'VERSION_DIGEST_MISMATCH'),
            ("UPDATE db_audit SET resource_id='different'", 'VERSION_AUDIT_MISMATCH'),
            ("UPDATE db_operations SET actor_id='different'", 'OPERATION_AUDIT_MISMATCH'),
            ('UPDATE biz_settings SET enabled=0', 'DOMAIN_PROJECTION_MISMATCH'),
        ]
        for sql, code in cases:
            with self.subTest(code=code):
                path = self.fixture()
                self.change(path, sql)
                with self.assertRaises(ConsistencyError) as failure:
                    backup.preview(path)
                self.assertEqual(failure.exception.code, code)

    def test_semantic_deleted_projection_uses_last_active_version(self):
        path = self.fixture()
        connection = sqlite3.connect(str(path))
        try:
            connection.execute('PRAGMA foreign_keys=ON')
            with connection:
                database.put_resource(connection, {'operation_id': 'fixture_delete_123456789',
                    'epoch': database.status(connection)['epoch'], 'kind': 'settings', 'id': 'alert_sound',
                    'expected_revision': 1, 'value': None, 'deleted': True}, {'id': 'fixture-operator'}, 200)
        finally:
            connection.close()
        result = backup.preview(path)
        self.assertEqual(result['business_consistency']['versions_checked'], 2)
        self.assertEqual(result['business_consistency']['projections_checked'], 1)

    def test_failed_transaction_leaves_semantic_baseline_unchanged(self):
        path = self.fixture()
        connection = sqlite3.connect(str(path))
        try:
            connection.execute('PRAGMA foreign_keys=ON')
            before = verify_consistency(connection)
            with self.assertRaises(RuntimeError):
                with connection:
                    database.put_resource(connection, {'operation_id': 'fixture_rollback_123456789',
                        'epoch': database.status(connection)['epoch'], 'kind': 'settings', 'id': 'alert_sound',
                        'expected_revision': 1, 'value': {'enabled': False}}, {'id': 'fixture-operator'}, 200)
                    raise RuntimeError('fixture commit prevented')
            self.assertEqual(verify_consistency(connection), before)
        finally:
            connection.close()

    def test_planning_tombstone_projection_and_versions_stay_consistent(self):
        path = self.fixture()
        connection = sqlite3.connect(str(path))
        try:
            connection.execute('PRAGMA foreign_keys=ON')
            epoch = database.status(connection)['epoch']
            value = {'id': 'r1', 'projectId': 'p1', 'type': 'daty_rf_planning',
                     'timestamp': 1, 'channels': 0, 'devices': []}
            with connection:
                database.put_resource(connection, {'operation_id': 'fixture_record_123456789', 'epoch': epoch,
                    'kind': 'planning_records', 'id': 'r1', 'expected_revision': 0, 'value': value}, {'id': 'fixture'}, 201)
                database.put_resource(connection, {'operation_id': 'fixture_current_123456789', 'epoch': epoch,
                    'kind': 'planning_current', 'id': 'p1', 'expected_revision': 0,
                    'value': {'projectId': 'p1', 'currentRecordId': None, 'deletedRecordIds': ['r1']}}, {'id': 'fixture'}, 202)
            result = verify_consistency(connection)
            self.assertEqual(result['projections_checked'], 3)
            self.assertEqual(result['versions_checked'], 4)
        finally:
            connection.close()
        self.assertEqual(backup.preview(path)['business_consistency']['status'], 'verified')

    def test_remaining_core_projections_and_references_are_verified_with_live_boundary_explicit(self):
        path,values = self.core_bundle()
        result = backup.preview(path)['business_consistency']
        self.assertEqual(result['status'],'verified')
        self.assertEqual(result['unchecked_projection_kinds'],[])
        self.assertTrue(set(values).issubset(result['checked_kinds']))
        self.assertEqual(result['live_stream_semantics'],'not-verified')
        self.assertEqual(result['legacy_business_semantics'],'not-reinterpreted')
        self.assertEqual(result['reference_scope'],'current-scan-pointers-and-immutable-run-inputs')
        connection = sqlite3.connect(path)
        try:
            # Source legacy name remains retained rather than rewritten to the
            # normalized current project_metadata name during verification.
            self.assertEqual(connection.execute("SELECT name FROM projects WHERE id='p1'").fetchone()[0],'fixture')
        finally:
            connection.close()

    def test_core_projection_field_tampering_is_detected_for_every_new_kind(self):
        for sql,code in [
            ("UPDATE db_project_metadata SET name='wrong'",'CORE_PROJECTION_MISMATCH'),
            ('UPDATE db_manual_devices SET configured_frequency_khz=641001','CORE_PROJECTION_MISMATCH'),
            ("UPDATE db_legacy_snapshots SET payload_sha256='wrong'",'CORE_PROJECTION_MISMATCH'),
            ('UPDATE db_simulation_settings SET ripple_db=3','CORE_PROJECTION_MISMATCH'),
            ('UPDATE db_scan_current SET revision=9','CORE_PROJECTION_MISMATCH')]:
            with self.subTest(sql=sql):
                path,_ = self.core_bundle()
                self.change(path,sql)
                with self.assertRaises(ConsistencyError) as failure:
                    backup.preview(path)
                self.assertEqual(failure.exception.code,code)

    def test_deleted_manual_and_simulation_keep_last_active_metadata_at_new_tombstone_revision(self):
        path,_ = self.core_bundle()
        for kind,identifier in [('manual_devices','manual-1'),('simulation_settings','p1'),('scan_current','p1')]:
            self.put(path,kind,identifier,None,deleted=True)
        result = backup.preview(path)['business_consistency']
        self.assertEqual(result['status'],'verified')
        connection = sqlite3.connect(path)
        try:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM db_scan_current').fetchone()[0],0)
            self.assertEqual(connection.execute('SELECT revision,deleted FROM db_manual_devices').fetchone(),(2,1))
            self.assertEqual(connection.execute('SELECT revision,deleted FROM db_simulation_settings').fetchone(),(2,1))
        finally:
            connection.close()
        self.change(path,'UPDATE db_simulation_settings SET floor_dbm=-99')
        with self.assertRaises(ConsistencyError) as failure:
            backup.preview(path)
        self.assertEqual(failure.exception.code,'CORE_PROJECTION_MISMATCH')

    def test_orphan_projection_for_each_new_core_kind_is_rejected(self):
        for kind in ('project_metadata','manual_devices','legacy_snapshots','simulation_settings','scan_current'):
            with self.subTest(kind=kind):
                path,_ = self.core_bundle()
                connection = sqlite3.connect(path)
                try:
                    table = 'db_'+kind
                    values = list(connection.execute('SELECT * FROM '+table).fetchone())
                    values[0] = 'orphan'
                    with connection:
                        connection.execute('INSERT INTO projects VALUES(?,?,?,?,?,?)',('orphan','fixture','{}',1,1,1))
                        connection.execute('INSERT INTO '+table+' VALUES('+','.join('?' for _ in values)+')',values)
                finally:
                    connection.close()
                with self.assertRaises(ConsistencyError) as failure:
                    backup.preview(path)
                self.assertEqual(failure.exception.code,'ORPHAN_CORE_PROJECTION')

    def test_scan_pointer_cross_project_or_simulation_reference_is_rejected_even_with_matching_projection(self):
        for other_project,kind,code in [('p2','imported_csv','SCAN_REFERENCE_CONFLICT'),('p1','simulation','SIMULATION_NOT_MEASUREMENT')]:
            path,values = self.core_bundle()
            if other_project == 'p2':
                self.change(path,"INSERT INTO projects VALUES('p2','fixture','{}',1,1,1)")
            scan = {**values['scans'][1],'projectId':other_project,'sourceKind':kind}
            self.put(path,'scans','scan-2',scan)
            self.tamper_document(path,'scan_current','p1',{'projectId':'p1','scanId':'scan-2'},
                "UPDATE db_scan_current SET scan_id=? WHERE id='p1'",('scan-2',))
            with self.assertRaises(ConsistencyError) as failure:
                backup.preview(path)
            self.assertEqual(failure.exception.code,code)

    def test_immutable_run_scan_reference_stays_in_project_and_distinguishes_simulation_study(self):
        for project,kind,code in [('p2','imported_csv','SCAN_REFERENCE_CONFLICT'),('p1','simulation','SIMULATION_NOT_MEASUREMENT')]:
            path,values = self.core_bundle()
            if project == 'p2':
                self.change(path,"INSERT INTO projects VALUES('p2','fixture','{}',1,1,1)")
            self.put(path,'scans','scan-2',{**values['scans'][1],'projectId':project,'sourceKind':kind})
            self.tamper_document(path,'planning_runs','run-1',{**values['planning_runs'][1],'scanId':'scan-2'},
                "UPDATE db_planning_runs SET scan_id=? WHERE id='run-1'",('scan-2',))
            with self.assertRaises(ConsistencyError) as failure:
                backup.preview(path)
            self.assertEqual(failure.exception.code,code)
        path,values = self.core_bundle()
        self.put(path,'scans','sim-1',{**values['scans'][1],'sourceKind':'simulation'})
        self.put(path,'planning_runs','study-1',{**values['planning_runs'][1],'scanId':'sim-1','purpose':'simulation-study'})
        self.assertEqual(backup.preview(path)['business_consistency']['status'],'verified')

    def test_run_keeps_exact_old_profile_version_after_current_profile_is_deleted(self):
        path,_ = self.core_bundle()
        self.put(path,'profiles','test-daty',None,deleted=True)
        result = backup.preview(path)['business_consistency']
        self.assertEqual(result['status'],'verified')
        self.assertIn('planning_runs',result['checked_kinds'])

    def test_run_missing_or_deleted_profile_revision_is_rejected(self):
        for revision in (999,2):
            path,values = self.core_bundle()
            if revision == 2:
                self.put(path,'profiles','test-daty',None,deleted=True)
            refs = [{'id':'test-daty','revision':revision}]
            self.tamper_document(path,'planning_runs','run-1',{**values['planning_runs'][1],'profileRefs':refs},
                "UPDATE db_planning_runs SET profile_refs_json=? WHERE id='run-1'",
                (json.dumps(refs,sort_keys=True,separators=(',',':')),))
            with self.assertRaises(ConsistencyError) as failure:
                backup.preview(path)
            self.assertEqual(failure.exception.code,'PROFILE_REFERENCE_CONFLICT')

    def test_core_document_invalid_types_rejected_even_when_metadata_digest_is_recomputed(self):
        path,values = self.core_bundle()
        invalid = {**values['simulation_settings'][1], 'options':{**values['simulation_settings'][1]['options'],'includeImd':1}}
        self.tamper_document(path,'simulation_settings','p1',invalid,
            "UPDATE db_simulation_settings SET metadata_json=? WHERE id='p1'",
            (json.dumps(invalid,sort_keys=True,separators=(',',':')),))
        with self.assertRaises(ConsistencyError) as failure:
            backup.preview(path)
        self.assertEqual(failure.exception.code,'CORE_DOCUMENT_INVALID')


if __name__ == '__main__':
    unittest.main()
