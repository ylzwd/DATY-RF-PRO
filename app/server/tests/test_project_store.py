"""Project CAS tests: generated temporary SQLite only; no Bridge or network."""
import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    'daty_isolated_project_store', Path(__file__).resolve().parents[1] / 'project_store.py')
STORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STORE)

SCHEMA = '''
CREATE TABLE projects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, project_json TEXT NOT NULL DEFAULT '{}',
 created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE project_devices (
 project_id TEXT NOT NULL, device_id TEXT NOT NULL, device_json TEXT NOT NULL,
 PRIMARY KEY(project_id,device_id), FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE timeline_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, ts REAL NOT NULL,
 event_type TEXT NOT NULL, device_id TEXT, command_id TEXT, summary TEXT NOT NULL,
 details_json TEXT NOT NULL DEFAULT '{}'
);
'''
ACTOR = {'id': 'fixture-operator', 'name': '隔离测试', 'role': 'operator'}
DEVICE = {'id': 'receiver-1_ch1', 'receiver_ip': '192.0.2.10', 'channel_number': 1,
          'brand': 'DATYaudio', 'freq': 641000}


class ProjectStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='daty-project-cas-')
        self.path = Path(self.temp.name) / 'isolated.sqlite3'
        self.db = self.connect()
        self.db.executescript(SCHEMA)
        with self.db:
            self.db.execute('INSERT INTO projects VALUES(?,?,?,?,?)',
                            ('default', '默认项目', '{"unknown":{"retained":true}}', 100, 100))
            self.db.execute('INSERT INTO project_devices VALUES(?,?,?)',
                            ('default', DEVICE['id'], json.dumps(DEVICE)))

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def connect(self, **kwargs):
        connection = sqlite3.connect(self.path, timeout=5, **kwargs)
        connection.execute('PRAGMA foreign_keys=ON')
        return connection

    def migrate(self):
        with self.db:
            return STORE.migrate_projects(self.db)

    def write(self, body=None, project_id='default', actor=ACTOR, now=200):
        with self.db:
            return STORE.save_project(self.db, body if body is not None else
                                      {'name': '保存', 'data': {}, 'expected_revision': 1},
                                      actor, now, project_id)

    def snapshot(self):
        return {name: self.db.execute('SELECT * FROM ' + name + ' ORDER BY 1,2').fetchall()
                for name in ('projects', 'project_devices', 'timeline_events')}

    def test_migration_is_additive_idempotent_and_does_not_commit(self):
        before = self.snapshot()
        self.assertTrue(STORE.migrate_projects(self.db))
        self.assertTrue(self.db.in_transaction)
        self.assertFalse(STORE.migrate_projects(self.db))
        with closing(self.connect()) as observer:
            self.assertNotIn('revision', [row[1] for row in observer.execute('PRAGMA table_info(projects)')])
        self.db.commit()
        after = self.snapshot()
        self.assertEqual([row[:-1] for row in after['projects']], before['projects'])
        self.assertEqual(after['project_devices'], before['project_devices'])
        self.assertEqual(after['timeline_events'], before['timeline_events'])
        self.assertEqual(after['projects'][0][-1], 1)

    def test_migration_can_roll_back_without_rewriting_old_schema(self):
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, 'fixture interruption'):
            with self.db:
                STORE.migrate_projects(self.db)
                raise RuntimeError('fixture interruption')
        self.assertEqual(self.snapshot(), before)
        self.assertNotIn('revision', [row[1] for row in self.db.execute('PRAGMA table_info(projects)')])

    def test_migration_empty_projects_and_new_default_insert(self):
        with self.db:
            self.db.execute('DELETE FROM project_devices')
            self.db.execute('DELETE FROM projects')
        self.assertTrue(self.migrate())
        with self.db:
            self.db.execute('INSERT INTO projects(id,name,created_at,updated_at) VALUES(?,?,?,?)',
                            ('new-default', '默认', 1, 1))
        self.assertEqual(self.db.execute('SELECT revision FROM projects').fetchone()[0], 1)

    def test_migration_rejects_unfamiliar_revision_schema_and_invalid_values(self):
        with self.db:
            self.db.execute('ALTER TABLE projects ADD COLUMN revision TEXT NOT NULL DEFAULT "bad"')
        before = self.snapshot()
        with self.assertRaises(STORE.ProjectStoreError) as caught:
            self.migrate()
        self.assertEqual(caught.exception.code, 'PROJECT_SCHEMA_UNSUPPORTED')
        self.assertEqual(self.snapshot(), before)

    def test_migration_rejects_corrupted_revision_without_repair(self):
        self.migrate()
        for value in (0, -1, 'broken', STORE.MAX_PROJECT_REVISION + 1):
            with self.subTest(value=value):
                with self.db:
                    self.db.execute('UPDATE projects SET revision=?', (value,))
                before = self.snapshot()
                with self.assertRaises(STORE.ProjectStoreError):
                    self.migrate()
                self.assertEqual(self.snapshot(), before)

    def test_migration_rejects_missing_table_without_creating_business_tables(self):
        isolated = sqlite3.connect(':memory:')
        try:
            with self.assertRaises(STORE.ProjectStoreError) as caught:
                with isolated:
                    STORE.migrate_projects(isolated)
            self.assertEqual(caught.exception.code, 'PROJECT_SCHEMA_UNSUPPORTED')
            self.assertEqual(isolated.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(), [])
        finally:
            isolated.close()

    def test_migration_rejects_unsafe_defaults_even_with_no_rows_or_valid_existing_rows(self):
        for default in ('', 'DEFAULT 0', 'DEFAULT NULL', 'DEFAULT 2', "DEFAULT '1'", 'DEFAULT 1.0', 'DEFAULT (1+0)'):
            for populated in (False, True):
                with self.subTest(default=default, populated=populated):
                    with closing(sqlite3.connect(':memory:')) as isolated:
                        isolated.execute('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,'
                            'project_json TEXT NOT NULL,created_at REAL NOT NULL,updated_at REAL NOT NULL,'
                            'revision INTEGER NOT NULL ' + default + ')')
                        if populated:
                            isolated.execute('INSERT INTO projects VALUES(?,?,?,?,?,?)', ('p', 'P', '{}', 1, 1, 1))
                        isolated.commit()
                        before = list(isolated.execute('PRAGMA table_info(projects)'))
                        rows = list(isolated.execute('SELECT * FROM projects'))
                        with self.assertRaises(STORE.ProjectStoreError) as caught:
                            with isolated:
                                STORE.migrate_projects(isolated)
                        self.assertEqual(caught.exception.code, 'PROJECT_SCHEMA_UNSUPPORTED')
                        self.assertEqual(list(isolated.execute('PRAGMA table_info(projects)')), before)
                        self.assertEqual(list(isolated.execute('SELECT * FROM projects')), rows)

    def test_migration_accepts_only_literal_one_with_simple_parentheses(self):
        for default in ('1', '(1)', '((1))', '( ( 1 ) )'):
            with self.subTest(default=default):
                with closing(sqlite3.connect(':memory:')) as isolated:
                    isolated.execute('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,'
                        'project_json TEXT NOT NULL,created_at REAL NOT NULL,updated_at REAL NOT NULL,'
                        'revision INTEGER NOT NULL DEFAULT ' + default + ')')
                    with isolated:
                        self.assertFalse(STORE.migrate_projects(isolated))
                        isolated.execute('INSERT INTO projects(id,name,project_json,created_at,updated_at) VALUES(?,?,?,?,?)',
                                         ('p', 'P', '{}', 1, 1))
                    self.assertEqual(isolated.execute('SELECT revision FROM projects').fetchone()[0], 1)

    def test_create_and_update_return_versions_and_preserve_created_time(self):
        self.migrate()
        created = self.write({'expected_revision': 0, 'name': '新项目', 'data': {'x': 1},
                              'devices': [DEVICE]}, project_id='new')
        self.assertEqual(created, {'project_id': 'new', 'revision': 1, 'updated_at': 200})
        updated = self.write({'expected_revision': 1, 'name': '改名', 'data': {'x': 2}},
                             project_id='new', now=300)
        self.assertEqual(updated['revision'], 2)
        row = self.db.execute('SELECT name,project_json,created_at,updated_at,revision FROM projects WHERE id="new"').fetchone()
        self.assertEqual(row, ('改名', '{"x":2}', 200, 300, 2))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM project_devices WHERE project_id="new"').fetchone()[0], 1)

    def test_create_existing_and_update_missing_are_conflicts_with_no_changes(self):
        self.migrate()
        for project_id, expected in (('default', 0), ('missing', 1), ('default', 3)):
            with self.subTest(project_id=project_id, expected=expected):
                before = self.snapshot()
                with self.assertRaises(STORE.ProjectStoreError) as caught:
                    self.write({'expected_revision': expected, 'data': {'bad': True}, 'devices': []}, project_id)
                self.assertEqual(caught.exception.status, 409)
                self.assertEqual(caught.exception.code, 'PROJECT_REVISION_CONFLICT')
                self.assertEqual(caught.exception.details['current_revision'], 1 if project_id == 'default' else None)
                self.assertEqual(self.snapshot(), before)

    def test_missing_precondition_rejects_legacy_write_without_data_loss(self):
        self.migrate()
        before = self.snapshot()
        with self.assertRaises(STORE.ProjectStoreError) as caught:
            self.write({'name': '旧页面', 'data': {}, 'devices': []})
        self.assertEqual(caught.exception.status, 428)
        self.assertEqual(caught.exception.to_response()['code'], 'PROJECT_PRECONDITION_REQUIRED')
        self.assertFalse(caught.exception.to_response()['success'])
        self.assertFalse(caught.exception.to_response()['accepted'])
        self.assertEqual(self.snapshot(), before)

    def test_invalid_revisions_cannot_be_coerced_or_mutate_data(self):
        self.migrate()
        for value in (True, False, None, '1', '', 1.0, -1, [], {}, STORE.MAX_PROJECT_REVISION + 1):
            with self.subTest(value=value):
                before = self.snapshot()
                with self.assertRaises(STORE.ProjectStoreError) as caught:
                    self.write({'expected_revision': value, 'devices': []})
                self.assertEqual(caught.exception.code, 'INVALID_PROJECT_REVISION')
                self.assertEqual(self.snapshot(), before)

    def test_revision_exhaustion_does_not_overflow_js_integer(self):
        self.migrate()
        with self.db:
            self.db.execute('UPDATE projects SET revision=?', (STORE.MAX_PROJECT_REVISION,))
        before = self.snapshot()
        with self.assertRaises(STORE.ProjectStoreError) as caught:
            self.write({'expected_revision': STORE.MAX_PROJECT_REVISION})
        self.assertEqual(caught.exception.code, 'PROJECT_REVISION_EXHAUSTED')
        self.assertEqual(self.snapshot(), before)

    def test_invalid_devices_rejected_before_project_write(self):
        self.migrate()
        cases = (None, {}, [None], [{}], [{'id': None}], [{'id': True}], [{'id': 1.1}],
                 [{'id': ' '}], [{'id': 'same'}, {'id': 'same'}], [{'id': 1}, {'id': '1'}])
        for devices in cases:
            with self.subTest(devices=devices):
                before = self.snapshot()
                with self.assertRaises(STORE.ProjectStoreError):
                    self.write({'expected_revision': 1, 'data': {'bad': True}, 'devices': devices})
                self.assertEqual(self.snapshot(), before)

    def test_invalid_data_and_nonfinite_json_rejected_without_changes(self):
        self.migrate()
        for data in (None, False, [], '', {'x': float('nan')}, {'x': float('inf')}, {'x': object()}):
            with self.subTest(data=data):
                before = self.snapshot()
                with self.assertRaises(STORE.ProjectStoreError):
                    self.write({'expected_revision': 1, 'data': data})
                self.assertEqual(self.snapshot(), before)

    def test_lone_unicode_surrogates_are_rejected_before_the_transaction(self):
        self.migrate()
        invalid = '\ud800'
        cases = [({'expected_revision': 1}, 'default' + invalid, ACTOR),
                 ({'expected_revision': 1, 'name': invalid}, 'default', ACTOR),
                 ({'expected_revision': 1, 'data': {'value': invalid}}, 'default', ACTOR),
                 ({'expected_revision': 1, 'data': {invalid: 'value'}}, 'default', ACTOR),
                 ({'expected_revision': 1, 'devices': [{'id': invalid}]}, 'default', ACTOR),
                 ({'expected_revision': 1, 'devices': [{'id': 'valid', 'name': invalid}]}, 'default', ACTOR)]
        cases.extend(({'expected_revision': 1}, 'default', {**ACTOR, key: invalid}) for key in ('id', 'name', 'role'))
        for index, (body, project_id, actor) in enumerate(cases):
            with self.subTest(index=index):
                before = self.snapshot()
                with self.assertRaises(STORE.ProjectStoreError) as caught:
                    STORE.save_project(self.db, body, actor, 200, project_id)
                self.assertEqual(caught.exception.code, 'INVALID_PROJECT')
                self.assertEqual(caught.exception.status, 400)
                self.assertFalse(self.db.in_transaction)
                self.assertEqual(self.snapshot(), before)

    def test_json_encoder_recursion_is_structured_error_before_any_write(self):
        self.migrate()
        before = self.snapshot()
        # Python builds have different JSON recursion budgets; inject the
        # encoder failure instead of risking native-stack exhaustion in tests.
        with patch.object(STORE.json, 'dumps', side_effect=RecursionError('fixture recursion')):
            with self.assertRaises(STORE.ProjectStoreError) as caught:
                STORE.save_project(self.db, {'expected_revision': 1, 'data': {}}, ACTOR, 200, 'default')
        self.assertEqual(caught.exception.code, 'INVALID_PROJECT')
        self.assertFalse(self.db.in_transaction)
        self.assertEqual(self.snapshot(), before)

    def test_empty_devices_clear_but_omitted_devices_preserve(self):
        self.migrate()
        self.write({'expected_revision': 1})
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM project_devices').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT project_json FROM projects').fetchone()[0], '{}')
        self.write({'expected_revision': 2, 'devices': []})
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM project_devices').fetchone()[0], 0)

    def test_business_json_unknown_fields_and_tombstones_are_unchanged(self):
        self.migrate()
        data = {'vendor_extra': {'中文': [None, False, 0]}, 'deletedRecordIds': ['old'],
                'planningHistory': [{'id': 'new', 'freq': 641000}], 'currentPlanningRecordId': None}
        self.write({'expected_revision': 1, 'data': data})
        self.assertEqual(json.loads(self.db.execute('SELECT project_json FROM projects').fetchone()[0]), data)

    def test_audit_written_in_same_transaction_and_only_public_actor_fields(self):
        self.migrate()
        body = {'expected_revision': 1, 'name': '含中文名称', 'devices': [DEVICE]}
        result = STORE.save_project(self.db, body, {**ACTOR, 'token': 'test-only-do-not-store'}, 200, 'default')
        self.assertEqual(result['revision'], 2)
        self.assertTrue(self.db.in_transaction)
        with closing(self.connect()) as observer:
            self.assertEqual(observer.execute('SELECT revision FROM projects').fetchone()[0], 1)
            self.assertEqual(observer.execute('SELECT COUNT(*) FROM timeline_events').fetchone()[0], 0)
        self.db.commit()
        event = self.db.execute('SELECT project_id,ts,event_type,summary,details_json FROM timeline_events').fetchone()
        self.assertEqual(event[:4], ('default', 200, 'project.saved', '项目已保存：含中文名称'))
        self.assertEqual(json.loads(event[4]), {'project_id': 'default', 'revision': 2, 'actor': ACTOR})
        self.assertNotIn('test-only-do-not-store', event[4])

    def test_audit_failure_rolls_back_project_device_and_revision(self):
        self.migrate()
        self.db.executescript("CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON timeline_events BEGIN SELECT RAISE(ABORT,'fixture failure'); END;")
        before = self.snapshot()
        with self.assertRaises(STORE.ProjectStoreError) as caught:
            self.write({'expected_revision': 1, 'name': '不可部分提交', 'data': {'new': 1}, 'devices': []})
        self.assertEqual(caught.exception.code, 'PROJECT_STORE_FAILED')
        self.assertEqual(caught.exception.status, 503)
        self.assertNotIn('fixture failure', str(caught.exception))
        self.assertEqual(self.snapshot(), before)

    def test_device_insert_failure_rolls_back_project_and_prior_device_set(self):
        self.migrate()
        self.db.executescript("CREATE TRIGGER fixture_fail_device BEFORE INSERT ON project_devices BEGIN SELECT RAISE(ABORT,'fixture device failure'); END;")
        before = self.snapshot()
        with self.assertRaises(STORE.ProjectStoreError):
            self.write({'expected_revision': 1, 'devices': [{**DEVICE, 'id': 'new-device'}]})
        self.assertEqual(self.snapshot(), before)

    def test_parallel_connections_same_revision_have_one_winner(self):
        self.migrate()
        barrier = threading.Barrier(2)
        results = []
        lock = threading.Lock()

        def run(label):
            connection = self.connect()
            try:
                barrier.wait(timeout=5)
                with connection:
                    value = STORE.save_project(connection, {'expected_revision': 1, 'name': label,
                        'data': {'writer': label}, 'devices': [{**DEVICE, 'id': label}]}, ACTOR, 200, 'default')
                outcome = ('ok', label, value)
            except STORE.ProjectStoreError as error:
                outcome = ('conflict', label, error.status, error.code)
            except Exception as error:
                outcome = ('unexpected', repr(error))
            finally:
                connection.close()
            with lock:
                results.append(outcome)

        threads = [threading.Thread(target=run, args=(label,)) for label in ('writer-a', 'writer-b')]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
            self.assertFalse(thread.is_alive(), 'isolated concurrent write must finish')
        self.assertEqual(sorted(item[0] for item in results), ['conflict', 'ok'])
        winner = next(item[1] for item in results if item[0] == 'ok')
        loser = next(item for item in results if item[0] == 'conflict')
        self.assertEqual(loser[2:], (409, 'PROJECT_REVISION_CONFLICT'))
        self.assertEqual(self.db.execute('SELECT name,revision FROM projects').fetchone(), (winner, 2))
        self.assertEqual(self.db.execute('SELECT device_id FROM project_devices').fetchall(), [(winner,)])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM timeline_events').fetchone()[0], 1)

    def test_autocommit_connection_still_leaves_explicit_transaction_for_caller(self):
        self.migrate()
        connection = self.connect(isolation_level=None)
        try:
            STORE.save_project(connection, {'expected_revision': 1, 'devices': []}, ACTOR, 200, 'default')
            self.assertTrue(connection.in_transaction)
            connection.rollback()
        finally:
            connection.close()
        self.assertEqual(self.db.execute('SELECT revision FROM projects').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM project_devices').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM timeline_events').fetchone()[0], 0)

    def test_outer_transaction_is_neither_committed_nor_replaced(self):
        self.migrate()
        before = self.snapshot()
        self.db.execute('BEGIN')
        self.db.execute('UPDATE projects SET name=? WHERE id=?', ('外层改名', 'default'))
        STORE.save_project(self.db, {'expected_revision': 1, 'name': '内层保存'}, ACTOR, 200, 'default')
        self.assertTrue(self.db.in_transaction)
        self.db.rollback()
        self.assertEqual(self.snapshot(), before)

    def test_stale_second_create_cannot_replace_first_create_or_its_devices(self):
        self.migrate()
        self.write({'expected_revision': 0, 'name': '首个客户端', 'devices': [DEVICE]}, 'new-project')
        before = self.snapshot()
        with self.assertRaises(STORE.ProjectStoreError) as caught:
            self.write({'expected_revision': 0, 'name': '后到客户端', 'devices': []}, 'new-project')
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.details['current_revision'], 1)
        self.assertEqual(self.snapshot(), before)

    def test_other_project_revision_is_not_changed(self):
        self.migrate()
        self.write({'expected_revision': 0, 'name': '项目 B'}, 'project-b')
        self.write({'expected_revision': 1, 'name': '项目 A'}, 'default')
        rows = self.db.execute('SELECT id,name,revision FROM projects ORDER BY id').fetchall()
        self.assertEqual(rows, [('default', '项目 A', 2), ('project-b', '项目 B', 1)])

    def test_old_read_queries_still_work_after_additive_migration(self):
        self.migrate()
        self.write({'expected_revision': 1, 'data': {'planningHistory': []}})
        old_read = self.db.execute('SELECT id,name,created_at,updated_at FROM projects').fetchone()
        self.assertEqual(old_read, ('default', '未命名项目', 100, 200))
        self.assertEqual(json.loads(self.db.execute('SELECT project_json FROM projects').fetchone()[0]), {'planningHistory': []})


if __name__ == '__main__':
    unittest.main()
