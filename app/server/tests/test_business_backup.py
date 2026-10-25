"""Offline C1 fixtures only: no live DB, service, credentials or receiver I/O."""
import ast
from contextlib import closing
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load_script(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify = load_script('verify-business-backup')
backup_tool = load_script('backup-project-db')


def fixture(path):
    # Parse the production CREATE statements; never import/start the bridge or
    # use DATY_DB_PATH. This also exercises compatible added columns in C2.
    tree = ast.parse((ROOT / 'mqtt-bridge.py').read_text(encoding='utf-8-sig'))
    initialize = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_init_database')
    schema = next(node.value.value for node in initialize.body if isinstance(node, ast.Assign)
                  and any(isinstance(target, ast.Name) and target.id == 'schema' for target in node.targets))
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript(schema)
        db.execute("INSERT INTO projects(id,name,project_json,created_at,updated_at) VALUES(?,?,?,?,?)",
                   ('fixture-project', '恢复夹具', json.dumps({'planningHistory': [{'id': 'keep', 'type': 'daty_rf_planning', 'devices': [],
                        'constraints': {'lockedAssignments': [{'deviceId': 'rx_ch1', 'frequencyKHz': 641250}], 'backupCount': 0}}],
                        'currentPlanningRecordId': 'keep', 'unknownFutureField': {'preserved': True}}), 10, 20))
        db.execute('INSERT INTO project_devices VALUES(?,?,?)', ('fixture-project', 'rx_ch1', '{"freq":641250,"rf":null}'))
        db.execute('INSERT INTO scan_datasets VALUES(?,?,?,?,?,?)', ('scan', 'fixture-project', '真实固定扫描', '[[641250,-85]]', 'csv-fixture', 20))
        db.execute('INSERT INTO coordination_runs VALUES(?,?,?,?,?,?)', ('run', 'fixture-project', '{"unit":"kHz"}', '{}', None, 20))
        db.execute('INSERT INTO commands VALUES(?,?,?,?,?,?,?,?,?,?)', ('cmd', 'rx_ch1', 'set_freq', '641.25', '641.25', 'acknowledged', None, 10, 20, 20))
        db.execute('INSERT INTO telemetry_samples(device_id,ts,frequency_khz,rf_dbm,af_dbfs,battery_percent,muted,status) VALUES(?,?,?,?,?,?,?,?)',
                   ('rx_ch1', 20, 641250, None, -40, 0, 1, 'online'))
        db.execute('INSERT INTO timeline_events(project_id,ts,event_type,device_id,command_id,summary,details_json) VALUES(?,?,?,?,?,?,?)',
                   ('fixture-project', 20, 'command.acknowledged', 'rx_ch1', 'cmd', '固定夹具-不应出现在报告正文', '{"source":"fixture"}'))


class BusinessBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='daty-c1-fixtures-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'daty-rf.backup.sqlite3'
        fixture(self.source)
        self.before = self.source.read_bytes()

    def test_default_preview_is_read_only_redacted_and_has_all_tables(self):
        original_names = {path.name for path in self.root.iterdir()}
        result = verify.preview(self.source)
        self.assertTrue(result['success'])
        self.assertFalse(result['manifest_verified'])
        self.assertEqual(result['table_counts'], {name: 1 for name in verify.TABLES})
        self.assertEqual(result['integrity'], 'ok')
        self.assertEqual(result['foreign_keys'], 'ok')
        self.assertEqual(self.source.read_bytes(), self.before)
        self.assertEqual({path.name for path in self.root.iterdir()}, original_names)
        self.assertNotIn('固定夹具-不应出现在报告正文', json.dumps(result, ensure_ascii=False))

    def test_rehearsal_exclusively_creates_temp_database_with_exact_business_content(self):
        directory = self.root / 'daty-restore-case'
        result = verify.rehearse(self.source, directory)
        self.assertEqual(result['rehearsal'], 'verified')
        restored = Path(result['restored'])
        self.assertTrue(restored.is_file())
        self.assertEqual(self.source.read_bytes(), self.before)
        with closing(sqlite3.connect(restored)) as db:
            project = json.loads(db.execute('SELECT project_json FROM projects').fetchone()[0])
            self.assertEqual(project['planningHistory'][0]['constraints']['backupCount'], 0)
            self.assertEqual(project['planningHistory'][0]['constraints']['lockedAssignments'][0]['frequencyKHz'], 641250)
            self.assertTrue(project['unknownFutureField']['preserved'])
            self.assertEqual(db.execute('SELECT rf_dbm,af_dbfs,battery_percent FROM telemetry_samples').fetchone(), (None, -40, 0))
            self.assertEqual(db.execute('SELECT status,actual_json FROM commands').fetchone(), ('acknowledged', '641.25'))
        with self.assertRaises(ValueError):
            verify.rehearse(self.source, directory)

    def test_existing_directory_system_temp_root_and_non_temp_target_are_rejected(self):
        for directory in (self.root, Path(tempfile.gettempdir()), ROOT / 'daty-restore-forbidden'):
            with self.subTest(directory=directory), self.assertRaises(ValueError):
                verify.rehearse(self.source, directory)
        self.assertFalse((ROOT / 'daty-restore-forbidden').exists())
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_live_filename_missing_archive_and_sidecars_are_rejected(self):
        for path in (self.root / 'daty-rf.sqlite3', self.root / 'missing.backup.sqlite3'):
            with self.assertRaises(ValueError):
                verify.preview(path)
        for suffix in ('-wal', '-shm', '-journal'):
            sidecar = Path(str(self.source) + suffix)
            sidecar.touch()
            with self.assertRaises(ValueError):
                verify.preview(self.source)
            sidecar.unlink()  # Explicit file inside this test's TemporaryDirectory only.

    def test_future_columns_are_hashed_and_preserved_without_weakening_existing_schema_checks(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute('ALTER TABLE projects ADD COLUMN fixture_revision INTEGER NOT NULL DEFAULT 7')
        before = self.source.read_bytes()
        result = verify.rehearse(self.source, self.root / 'daty-restore-extended')
        with closing(sqlite3.connect(result['restored'])) as db:
            self.assertEqual(db.execute('SELECT fixture_revision FROM projects').fetchone(), (7,))
        self.assertEqual(self.source.read_bytes(), before)

    def test_linked_path_and_malformed_oversized_manifest_are_rejected(self):
        original = Path.is_symlink
        with patch.object(Path, 'is_symlink', lambda path: path == self.source or original(path)):
            with self.assertRaisesRegex(ValueError, 'symlinks'):
                verify.preview(self.source)
        manifest = self.root / 'invalid.json'
        for text in ('{broken', ' ' * 65537, '[]', '{}'):
            manifest.write_text(text, encoding='utf-8')
            with self.subTest(length=len(text)), self.assertRaises(ValueError):
                verify.preview(self.source, manifest)
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_corrupt_unknown_schema_and_foreign_key_damage_fail_closed(self):
        broken = self.root / 'broken.backup.sqlite3'
        broken.write_bytes(b'not sqlite')
        with self.assertRaises(sqlite3.DatabaseError):
            verify.preview(broken)
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE project_devices SET project_id='missing'")
        with self.assertRaisesRegex(ValueError, 'foreign-key'):
            verify.preview(self.source)
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE project_devices SET project_id='fixture-project'")
            db.execute('CREATE TABLE unexpected(value TEXT)')
        with self.assertRaisesRegex(ValueError, 'schema'):
            verify.preview(self.source)

    def test_manifest_verifies_hash_size_and_counts_but_never_uses_embedded_paths(self):
        result = verify.preview(self.source)
        manifest = self.root / 'manifest.json'
        body = {**result, 'source': 'DO-NOT-OPEN-THIS-SOURCE', 'backup': 'DO-NOT-OPEN-THIS-TARGET'}
        manifest.write_text(json.dumps(body), encoding='utf-8')
        self.assertTrue(verify.preview(self.source, manifest)['manifest_verified'])
        for field, value in (('sha256', '0' * 64), ('bytes', result['bytes'] + 1),
                             ('table_counts', {'timeline_events': 900}), ('success', False)):
            manifest.write_text(json.dumps({**body, field: value}), encoding='utf-8')
            with self.subTest(field=field), self.assertRaises(ValueError):
                verify.preview(self.source, manifest)
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_source_change_during_preview_and_digest_mismatch_during_rehearsal_do_not_report_success(self):
        with patch.object(verify, '_sha256', side_effect=['a' * 64, 'b' * 64]):
            with self.assertRaisesRegex(ValueError, 'changed'):
                verify.preview(self.source)
        inspect = verify._inspect
        calls = 0
        def altered(connection):
            nonlocal calls
            calls += 1
            result = inspect(connection)
            if calls == 2:
                result['table_sha256']['projects'] = '0' * 64
            return result
        with patch.object(verify, '_inspect', side_effect=altered):
            with self.assertRaisesRegex(ValueError, 'differs'):
                verify.rehearse(self.source, self.root / 'daty-restore-mismatch')
        self.assertEqual(self.source.read_bytes(), self.before)

    def test_online_backup_helper_uses_fixture_root_and_reports_real_timeline_table(self):
        project = self.root / 'project'
        project.mkdir()
        # Fixture data, not the real server. The legacy helper keeps its fixed
        # production CLI source and archive policy; only __file__ is injected.
        database = project / 'daty-rf.sqlite3'
        fixture(database)
        before = database.read_bytes()
        directory = self.root / '归档' / 'secure-deployment-fixture'
        directory.mkdir(parents=True)
        target = directory / 'daty-rf.backup.sqlite3'
        with patch.object(backup_tool, '__file__', str(project / 'scripts' / 'backup-project-db.py')):
            result = backup_tool.backup(target)
            self.assertEqual(result['table_counts'], {name: 1 for name in verify.TABLES})
            self.assertNotIn('timeline', result['table_counts'])
            self.assertTrue(verify.preview(target, target.with_suffix('.json'))['manifest_verified'])
            with self.assertRaises(FileExistsError):
                backup_tool.backup(target)
        self.assertEqual(hashlib.sha256(database.read_bytes()).digest(), hashlib.sha256(before).digest())


if __name__ == '__main__':
    unittest.main()
