"""Actual online backup creation; isolated schemas/data/writers only."""
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
import unified_database as db
from unified_schema import LEGACY_DDL, SchemaError

SPEC = importlib.util.spec_from_file_location('unified_backup_create_fixture', ROOT / 'scripts' / 'backup-unified-project-db.py')
create = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(create)


class UnifiedBackupCreateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='daty-unified-create-tests-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.serial = 0

    def fixture(self, unified=False, revision=False):
        self.serial += 1
        source = self.root / ('source-' + str(self.serial) + '.sqlite3')
        with closing(sqlite3.connect(source)) as connection:
            connection.execute('PRAGMA foreign_keys=ON')
            for sql in LEGACY_DDL:
                connection.execute(sql)
            connection.execute('INSERT INTO projects VALUES(?,?,?,?,?)', ('p1','fixture','{"keep":true}',1,1))
            connection.commit()
            if unified:
                with connection:
                    meta = db.migrate(connection, 1)
                    db.put_resource(connection, {'kind':'settings','id':'alert_sound','value':{'enabled':True},
                        'expected_revision':0,'epoch':meta['epoch'],'operation_id':'fixture_create_123456'},
                        {'id':'public-fixture','role':'operator'}, 2)
            elif revision:
                connection.execute('ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
                connection.commit()
        return source

    def output(self):
        return self.root / ('archive-' + str(self.serial) + '.backup.sqlite3')

    def test_all_supported_schemas_create_verifiable_archive_and_complete_manifest(self):
        for unified,revision,kind in [(False,False,'legacy'),(False,True,'legacy-revision'),(True,False,'unified')]:
            with self.subTest(kind=kind):
                source = self.fixture(unified, revision)
                before = source.read_bytes()
                result = create.create_backup(source, self.output())
                self.assertTrue(result['success'])
                self.assertTrue(result['source_connection_read_only'])
                self.assertEqual(result['schema_kind'], kind)
                self.assertEqual(result['table_counts']['projects'], 1)
                self.assertIn('sqlite_sequence', result['table_sha256'])
                self.assertFalse(result['activation_performed'])
                self.assertFalse(result['services_restarted'])
                self.assertEqual(source.read_bytes(), before)
                checked = create.verifier.preview(result['backup'], result['manifest'])
                self.assertTrue(checked['manifest_verified'])
                self.assertEqual(checked['table_sha256'], result['table_sha256'])
                self.assertEqual(Path(result['backup']).stat().st_nlink, 1)
                self.assertEqual(list(self.root.glob('*partial*')), [])

    def test_unified_manifest_verifies_metadata_projection_and_discloses_live_boundary(self):
        source = self.fixture(True)
        with closing(sqlite3.connect(source)) as connection:
            connection.execute('PRAGMA foreign_keys=ON')
            with connection:
                db.put_resource(connection, {'kind':'project_metadata','id':'p1',
                    'value':{'id':'p1','name':'fixture','data':{}},'expected_revision':0,
                    'epoch':db.status(connection)['epoch'],'operation_id':'fixture_metadata_123456'},
                    {'id':'public-fixture'}, 3)
        result = create.create_backup(source, self.output())
        scope = result['verification_scope']
        self.assertEqual(scope, result['business_consistency'])
        self.assertEqual(scope['status'], 'verified')
        self.assertIn('project_metadata', scope['checked_kinds'])
        self.assertEqual(scope['unchecked_projection_kinds'], [])
        self.assertEqual(scope['live_stream_semantics'], 'not-verified')
        self.assertEqual(result['table_counts']['db_project_metadata'], 1)
        with closing(sqlite3.connect(source)) as connection:
            connection.execute("UPDATE db_project_metadata SET name='wrong-projection'")
            connection.commit()
        with self.assertRaisesRegex(ValueError,'CORE_PROJECTION_MISMATCH'):
            create.create_backup(source,self.root/'metadata-corrupt.backup.sqlite3')
        self.assertFalse((self.root/'metadata-corrupt.backup.sqlite3').exists())

    def test_unknown_schema_refused_before_any_partial_is_created(self):
        source = self.fixture()
        with closing(sqlite3.connect(source)) as connection:
            connection.execute('CREATE TABLE unknown_business(id INTEGER PRIMARY KEY)')
            connection.commit()
        before = source.read_bytes()
        with self.assertRaises(SchemaError):
            create.create_backup(source, self.output())
        self.assertFalse(self.output().exists())
        self.assertEqual(list(self.root.glob('*partial*')), [])
        self.assertEqual(source.read_bytes(), before)

    def test_existing_output_manifest_or_partial_is_never_overwritten(self):
        for suffix in ('', '.manifest.json', '.manifest.json.partial', 'partial'):
            source = self.fixture()
            target = self.output()
            collision = (target.with_name(target.name.replace('.backup.sqlite3','.partial.backup.sqlite3'))
                         if suffix == 'partial' else Path(str(target) + suffix))
            collision.write_bytes(b'keep-existing')
            with self.assertRaises(FileExistsError):
                create.create_backup(source, target)
            self.assertEqual(collision.read_bytes(), b'keep-existing')

    def test_bad_names_missing_source_sidecar_source_and_invalid_budget_refused(self):
        source = self.fixture()
        for origin,target in [(source,source),(source,self.root/'bad.sqlite3'),(self.root/'missing',self.output()),
                              (source,self.root/'missing-directory'/'a.backup.sqlite3')]:
            with self.assertRaises(ValueError):
                create.create_backup(origin,target)
        sidecar = Path(str(source)+'-wal')
        sidecar.write_bytes(b'not-a-database')
        with self.assertRaises(ValueError):
            create.create_backup(sidecar,self.output())
        for budget in (0, True, 3601, float('nan')):
            with self.assertRaises(ValueError):
                create.create_backup(source,self.output(),budget_seconds=budget)

    def test_source_hardlink_and_destination_symlink_refused(self):
        source = self.fixture()
        alias = self.root / 'alias.sqlite3'
        try:
            os.link(source,alias)
        except OSError:
            self.skipTest('Filesystem does not support hard links')
        with self.assertRaises(ValueError):
            create.create_backup(source,self.output())
        alias.unlink()
        with mock.patch.object(Path,'is_symlink',lambda path: path == self.output()):
            with self.assertRaises(ValueError):
                create.create_backup(source,self.output())

    def test_source_connection_rejects_writes_and_uses_no_immutable_flag(self):
        source = self.fixture(True)
        original = create.verifier.validate_schema
        def inspect(connection):
            self.assertEqual(connection.execute('PRAGMA query_only').fetchone()[0],1)
            self.assertTrue(connection.in_transaction)
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("UPDATE projects SET name='forbidden'")
            return original(connection)
        connect = create.sqlite3.connect
        uris = []
        def capture(value,*args,**kwargs):
            if kwargs.get('uri'):
                uris.append(value)
            return connect(value,*args,**kwargs)
        with mock.patch.object(create.verifier,'validate_schema',side_effect=inspect), mock.patch.object(create.sqlite3,'connect',side_effect=capture):
            # _inspect uses the verifier too, but its closed reader is not an
            # explicit transaction. Only guard the source validation call.
            create.verifier.validate_schema.side_effect = lambda connection: inspect(connection) if connection.in_transaction else original(connection)
            create.create_backup(source,self.output())
        live_uris = [uri for uri in uris if str(source.name) in uri]
        self.assertEqual(len(live_uris),1)
        self.assertIn('?mode=ro',live_uris[0])
        self.assertNotIn('immutable',live_uris[0])

    def test_wal_writer_commits_while_pinned_legacy_snapshot_remains_coherent(self):
        source = self.fixture()
        keeper = sqlite3.connect(source)
        self.addCleanup(keeper.close)
        keeper.execute('PRAGMA journal_mode=WAL')
        keeper.execute("UPDATE projects SET name='before', project_json=?", ('{"generation":0}',))
        keeper.commit()
        errors = []
        written = threading.Event()
        def write():
            try:
                with closing(sqlite3.connect(source,timeout=2)) as connection:
                    with connection:
                        connection.execute("UPDATE projects SET name='after',project_json=?", ('{"generation":1}',))
                        connection.execute('INSERT INTO telemetry_samples(device_id,ts,frequency_khz) VALUES(?,?,?)', ('fixture',1,641000))
            except Exception as error:
                errors.append(error)
            finally:
                written.set()
        original = create.verifier.validate_schema
        fired = False
        def inspect(connection):
            nonlocal fired
            value = original(connection)
            if connection.in_transaction and not fired:
                fired = True
                worker = threading.Thread(target=write)
                worker.start()
                self.assertTrue(written.wait(3),'WAL writer was incorrectly blocked by read-only backup')
                worker.join(3)
                self.assertEqual(errors,[])
            return value
        with mock.patch.object(create.verifier,'validate_schema',side_effect=inspect):
            report = create.create_backup(source,self.output())
        with closing(sqlite3.connect(report['backup'])) as snapshot:
            self.assertEqual(snapshot.execute('SELECT name,project_json FROM projects').fetchone(), ('before','{"generation":0}'))
            self.assertEqual(snapshot.execute('SELECT COUNT(*) FROM telemetry_samples').fetchone()[0],0)
        self.assertEqual(keeper.execute('SELECT name,project_json FROM projects').fetchone(), ('after','{"generation":1}'))
        self.assertEqual(keeper.execute('SELECT COUNT(*) FROM telemetry_samples').fetchone()[0],1)

    def test_streams_large_fixture_without_whole_file_read(self):
        source = self.fixture()
        with closing(sqlite3.connect(source)) as connection:
            connection.executemany('INSERT INTO telemetry_samples(device_id,ts,frequency_khz) VALUES(?,?,?)',
                                  (('fixture',index,641000) for index in range(5000)))
            connection.commit()
        with mock.patch.object(Path,'read_bytes',side_effect=AssertionError('Whole-file read forbidden')):
            result = create.create_backup(source,self.output())
        self.assertEqual(result['table_counts']['telemetry_samples'],5000)

    def test_verification_failure_retains_closed_partial_and_never_publishes_success(self):
        source = self.fixture(True)
        with mock.patch.object(create,'_verified_closed',side_effect=ValueError('fixture verify failure')):
            with self.assertRaises(ValueError) as failure:
                create.create_backup(source,self.output())
        self.assertFalse(self.output().exists())
        self.assertEqual(failure.exception.backup_phase,'verify-closed-snapshot')
        partial = Path(failure.exception.partial_backup)
        self.assertTrue(partial.exists())
        self.assertIn('.partial.',partial.name)
        self.assertTrue(create.verifier.preview(partial)['success'])
        self.assertFalse(Path(str(self.output())+'.manifest.json').exists())

    def test_timeout_after_copy_retains_partial_and_never_publishes(self):
        source = self.fixture(True)
        def timeout(path,check):
            raise TimeoutError('fixture expired budget')
        with mock.patch.object(create,'_verified_closed',side_effect=timeout):
            with self.assertRaises(TimeoutError) as failure:
                create.create_backup(source,self.output(),budget_seconds=1)
        self.assertTrue(Path(failure.exception.partial_backup).exists())
        self.assertFalse(self.output().exists())

    def test_real_budget_checker_expires_before_copy_without_creating_artifacts(self):
        source = self.fixture()
        clock = [0.0]
        original = create.verifier.validate_schema
        def inspect(connection):
            result = original(connection)
            clock[0] = 2.0
            return result
        with mock.patch.object(create.time,'monotonic',side_effect=lambda:clock[0]), \
                mock.patch.object(create.verifier,'validate_schema',side_effect=inspect):
            with self.assertRaises(TimeoutError):
                create.create_backup(source,self.output(),budget_seconds=1)
        self.assertFalse(self.output().exists())
        self.assertEqual(list(self.root.glob('*partial*')),[])

    def test_sqlite_backup_progress_enforces_shared_deadline_and_retains_partial(self):
        source = self.fixture()
        clock = [0.0]
        original = create.sqlite3.connect
        class SourceProxy:
            def __init__(self,connection):
                self.connection = connection
            def __getattr__(self,name):
                return getattr(self.connection,name)
            def backup(self,*args,**kwargs):
                clock[0] = 2.0
                return self.connection.backup(*args,**kwargs)
        def connect(path,*args,**kwargs):
            connection = original(path,*args,**kwargs)
            return SourceProxy(connection) if kwargs.get('uri') and '?mode=ro' in str(path) else connection
        with mock.patch.object(create.time,'monotonic',side_effect=lambda:clock[0]), \
                mock.patch.object(create.sqlite3,'connect',side_effect=connect):
            with self.assertRaises(TimeoutError) as failure:
                create.create_backup(source,self.output(),budget_seconds=1)
        self.assertEqual(failure.exception.backup_phase,'copy-snapshot')
        self.assertTrue(Path(failure.exception.partial_backup).exists())
        self.assertFalse(self.output().exists())

    def test_corrupt_foreign_keys_keep_unverified_partial_and_leave_source_unchanged(self):
        source = self.fixture()
        with closing(sqlite3.connect(source)) as connection:
            connection.execute("INSERT INTO project_devices VALUES('missing','fixture','{}')")
            connection.commit()
        before = source.read_bytes()
        with self.assertRaisesRegex(ValueError,'foreign keys') as failure:
            create.create_backup(source,self.output())
        self.assertFalse(self.output().exists())
        self.assertTrue(Path(failure.exception.partial_backup).exists())
        self.assertEqual(source.read_bytes(),before)

    def test_publish_collision_preserves_external_file_and_marks_staged_manifest_failed(self):
        source = self.fixture(True)
        target = self.output()
        original = create._publish
        def collide(staged,destination):
            if destination == target:
                target.write_bytes(b'external-winner')
            return original(staged,destination)
        with mock.patch.object(create,'_publish',side_effect=collide):
            with self.assertRaises(FileExistsError) as failure:
                create.create_backup(source,target)
        self.assertEqual(target.read_bytes(),b'external-winner')
        self.assertTrue(Path(failure.exception.partial_backup).is_file())
        staged_manifest = json.loads(Path(failure.exception.partial_manifest).read_text(encoding='utf-8'))
        self.assertFalse(staged_manifest['success'])

    def test_manifest_publication_failure_returns_owned_snapshot_to_partial(self):
        source = self.fixture(True)
        target = self.output()
        original = create._publish
        def fail_manifest(staged,destination):
            if destination.name.endswith('.manifest.json'):
                raise OSError('fixture manifest publication failure')
            return original(staged,destination)
        with mock.patch.object(create,'_publish',side_effect=fail_manifest):
            with self.assertRaises(OSError) as failure:
                create.create_backup(source,target)
        self.assertFalse(target.exists())
        self.assertTrue(Path(failure.exception.partial_backup).is_file())
        self.assertFalse(json.loads(Path(failure.exception.partial_manifest).read_text(encoding='utf-8'))['success'])

    def test_cli_has_no_default_source_or_output_and_runs_only_explicit_fixture(self):
        script = ROOT / 'scripts' / 'backup-unified-project-db.py'
        missing = subprocess.run([sys.executable,'-B',str(script)],capture_output=True,text=True,timeout=15)
        self.assertNotEqual(missing.returncode,0)
        self.assertIn('--source',missing.stderr)
        source = self.fixture(True)
        result = subprocess.run([sys.executable,'-B',str(script),'--source',str(source),'--output',str(self.output())],
                                capture_output=True,text=True,encoding='utf-8',timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(json.loads(result.stdout)['success'])


if __name__ == '__main__':
    unittest.main()
