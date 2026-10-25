"""Fail-closed candidate startup; every database is an isolated temporary file."""
import ast
from contextlib import closing, contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import unified_bootstrap as bootstrap
import unified_database as database
from project_store import migrate_projects
from unified_schema import LEGACY_DDL, validate_schema


class UnifiedBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='daty-unified-bootstrap-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.serial = 0

    def path(self):
        self.serial += 1
        return self.root / ('fixture-' + str(self.serial) + '.sqlite3')

    def legacy(self, *, unified=False, revision=False):
        file = self.path()
        with closing(sqlite3.connect(file)) as connection:
            connection.execute('PRAGMA foreign_keys=ON')
            for sql in LEGACY_DDL:
                connection.execute(sql)
            connection.execute('INSERT INTO projects VALUES(?,?,?,?,?)',('p1','retained','{"keep":true}',1,1))
            connection.commit()
            if unified:
                with connection:
                    database.migrate(connection, 100)
            elif revision:
                with connection:
                    migrate_projects(connection)
        return file

    def run_bootstrap(self, file):
        with closing(bootstrap.open_database(file)) as connection:
            with connection:
                result = bootstrap.initialize(connection, 1000)
            bootstrap.enable_wal(connection)
            return result

    def test_nonexistent_path_is_exclusively_created_and_initialized_once(self):
        file = self.path()
        first = self.run_bootstrap(file)
        before = file.read_bytes()
        second = self.run_bootstrap(file)
        self.assertEqual(first, second)
        self.assertEqual(file.read_bytes(),before)
        with closing(sqlite3.connect(file)) as connection:
            self.assertEqual(validate_schema(connection)['schema_kind'],'unified')
            self.assertEqual(connection.execute('SELECT id FROM projects').fetchall(),[('default',)])
            self.assertEqual(connection.execute('PRAGMA journal_mode').fetchone()[0],'wal')

    def test_existing_empty_or_non_sqlite_file_is_rejected_without_writing_header(self):
        for contents in (b'', b'not SQLite fixture'):
            file = self.path()
            file.write_bytes(contents)
            with self.assertRaises((database.DatabaseError, sqlite3.DatabaseError)):
                self.run_bootstrap(file)
            self.assertEqual(file.read_bytes(),contents)
            self.assertFalse(Path(str(file)+'-wal').exists())

    def test_legacy_and_revision_legacy_migrate_without_rewriting_or_inserting_source_rows(self):
        for revision in (False,True):
            file = self.legacy(revision=revision)
            self.run_bootstrap(file)
            with closing(sqlite3.connect(file)) as connection:
                self.assertEqual(connection.execute('SELECT id,name,project_json,created_at,updated_at FROM projects').fetchall(),
                                 [('p1','retained','{"keep":true}',1.0,1.0)])
                self.assertEqual(validate_schema(connection)['schema_kind'],'unified')

    def test_unknown_schema_refused_before_recreating_missing_index_or_altering_header(self):
        file = self.legacy()
        with closing(sqlite3.connect(file)) as connection:
            connection.execute('DROP INDEX idx_timeline_ts')
            connection.execute('CREATE TABLE unknown_fixture(id INTEGER PRIMARY KEY)')
            connection.commit()
        before = file.read_bytes()
        with self.assertRaises(database.DatabaseError) as failure:
            self.run_bootstrap(file)
        self.assertEqual(failure.exception.code,'SCHEMA_UNSUPPORTED')
        self.assertEqual(file.read_bytes(),before)
        with closing(sqlite3.connect(file)) as connection:
            self.assertIsNone(connection.execute("SELECT 1 FROM sqlite_master WHERE name='idx_timeline_ts'").fetchone())
            self.assertEqual(connection.execute('PRAGMA journal_mode').fetchone()[0],'delete')

    def test_unified_missing_legacy_table_is_not_recreated_as_an_empty_valid_table(self):
        file = self.legacy(unified=True)
        with closing(sqlite3.connect(file)) as connection:
            connection.execute('DROP TABLE telemetry_samples')
            connection.commit()
        before = file.read_bytes()
        with self.assertRaises(database.DatabaseError):
            self.run_bootstrap(file)
        self.assertEqual(file.read_bytes(),before)
        with closing(sqlite3.connect(file)) as connection:
            self.assertIsNone(connection.execute("SELECT 1 FROM sqlite_master WHERE name='telemetry_samples'").fetchone())

    def test_in_transaction_second_gate_detects_changes_after_readonly_preflight(self):
        file = self.legacy()
        with closing(bootstrap.open_database(file)) as connection:
            with closing(sqlite3.connect(file)) as other:
                other.execute('DROP INDEX idx_timeline_ts');other.commit()
            before = file.read_bytes()
            with self.assertRaises(database.DatabaseError):
                with connection:
                    bootstrap.initialize(connection, 1000)
            self.assertEqual(file.read_bytes(),before)

    def test_new_bootstrap_failure_rolls_back_all_ddl_default_row_and_version(self):
        file = self.path()
        with closing(bootstrap.open_database(file)) as connection:
            original = database.migrate
            def fail(*args,**kwargs):
                original(*args,**kwargs)
                raise RuntimeError('fixture fail before commit')
            with mock.patch.object(database,'migrate',side_effect=fail):
                with self.assertRaises(RuntimeError):
                    with connection:
                        bootstrap.initialize(connection,1000)
            self.assertEqual(connection.execute('SELECT name FROM sqlite_master').fetchall(),[])
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0],0)
            self.assertEqual(connection.execute('PRAGMA journal_mode').fetchone()[0],'delete')
        with self.assertRaises(database.DatabaseError):
            bootstrap.open_database(file)  # Retained failed empty file needs explicit owner decision.

    def test_untrusted_empty_memory_connection_cannot_claim_new_database_authority(self):
        with closing(sqlite3.connect(':memory:')) as connection:
            connection.execute('PRAGMA foreign_keys=ON')
            with self.assertRaises(database.DatabaseError):
                with connection:
                    bootstrap.initialize(connection,1000)
            self.assertEqual(connection.execute('SELECT name FROM sqlite_master').fetchall(),[])

    def test_wal_is_refused_before_commit_and_before_supported_schema(self):
        with closing(bootstrap.open_database(self.path())) as connection:
            with connection:
                bootstrap.initialize(connection,1000)
                with self.assertRaises(database.DatabaseError):
                    bootstrap.enable_wal(connection)
            connection.execute('DROP INDEX idx_timeline_ts')
            connection.commit()
            with self.assertRaises(database.DatabaseError):
                bootstrap.enable_wal(connection)
            self.assertEqual(connection.execute('PRAGMA journal_mode').fetchone()[0],'delete')

    def test_new_path_with_recovery_sidecar_is_never_claimed(self):
        file = self.path()
        Path(str(file)+'-wal').write_bytes(b'fixture evidence')
        with self.assertRaises(database.DatabaseError):
            bootstrap.open_database(file)
        self.assertFalse(file.exists())
        self.assertEqual(Path(str(file)+'-wal').read_bytes(),b'fixture evidence')

    def test_current_bridge_uses_original_session_lock_with_no_executescript(self):
        raw = (ROOT/'mqtt-bridge.py').read_bytes()
        source = raw.decode('utf-8').replace('\r\n','\n')
        tree = ast.parse(source)
        init = next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='_init_database')
        connect = next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='_db_connect')
        self.assertNotIn('executescript',ast.dump(init))
        self.assertNotIn('journal_mode',ast.get_source_segment(source,connect))
        # Replay only _db_connect/_db_session/_init_database, never import the
        # Bridge or invoke any socket/security/receiver/startup side effect.
        nodes = [node for node in tree.body if isinstance(node,ast.FunctionDef)
                 and node.name in ('_db_connect','_db_session','_init_database')]
        env = {'_db_lock':threading.RLock(),'_db_connection':None,'_db_path':str(self.path()),
               'business_bootstrap':bootstrap,'time':time,'contextmanager':contextmanager}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'<candidate-bootstrap-only>','exec'),env)
        try:
            env['_init_database']()
            first = database.status(env['_db_connection'])
            env['_init_database']()
            self.assertEqual(database.status(env['_db_connection']),first)
            self.assertEqual(env['_db_connection'].execute('SELECT COUNT(*) FROM projects').fetchone()[0],1)
        finally:
            if env['_db_connection'] is not None:
                env['_db_connection'].close()


if __name__ == '__main__':
    unittest.main()
