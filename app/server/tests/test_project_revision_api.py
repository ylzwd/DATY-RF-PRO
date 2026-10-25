"""C2 candidate Bridge over real temporary TLS, never the running services.

Reads source/patch only, copies the exact candidate to TemporaryDirectory, sets
temporary DB/pairing/access paths BEFORE import, and uses a random loopback
HTTPS port with its own CA. No MQTT listener or receiver request is started.
"""
import atexit
from contextlib import closing, contextmanager
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.parse import quote

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
from access_test_support import TEST_TOKEN, make_test_policy
from pairing_test_support import create_tls_fixture
from tls_support import bind_https, client_context, server_context
import project_api
from project_store import PROJECT_REVISION_PROTOCOL


def candidate_bytes(source, specification):
    if (specification.get('schemaVersion') != 1 or specification.get('stage') != 'c2-integration'
            or specification.get('source') != 'mqtt-bridge.py' or specification.get('normalization') != 'lf'):
        raise ValueError('Unrecognized candidate patch format')
    if hashlib.sha256(source).hexdigest() != specification['sourceSha256']:
        raise ValueError('Candidate source digest mismatch; do not refresh the digest automatically')
    text = source.decode('utf-8').replace('\r\n', '\n')
    ids = set()
    for change in specification['changes']:
        if not change.get('id') or change['id'] in ids:
            raise ValueError('Candidate change IDs must be unique')
        ids.add(change['id'])
        before, after = change['before'].replace('\r\n', '\n'), change['after'].replace('\r\n', '\n')
        if not before or before == after or text.count(before) != 1:
            raise ValueError('Candidate patch must match exactly once')
        text = text.replace(before, after, 1)
    return text.encode('utf-8')


class ProjectRevisionApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-c2-candidate-api-')
        cls.directory = Path(cls.temp.name)
        cls.db_path = cls.directory / 'fixture.sqlite3'
        cls.original = (PROJECT / 'mqtt-bridge.py').read_bytes()
        cls.specification = json.loads((PROJECT / 'patches' / 'c2-bridge.json').read_text(encoding='utf-8'))
        cls.candidate = candidate_bytes(cls.original, cls.specification)
        cls.candidate_path = cls.directory / 'mqtt-bridge.py'
        with cls.candidate_path.open('xb') as output:
            output.write(cls.candidate)
        # A genuine old schema exists before the candidate module initializes.
        # No production backup/database is read or copied into this fixture.
        with closing(sqlite3.connect(cls.db_path)) as old_database:
            with old_database:
                old_database.execute("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,"
                    "project_json TEXT NOT NULL DEFAULT '{}',created_at REAL NOT NULL,updated_at REAL NOT NULL)")
                old_database.execute('INSERT INTO projects VALUES(?,?,?,?,?)',
                    ('legacy-existing', '旧版项目', '{"unknown":{"retained":true}}', 10, 20))
        spec = importlib.util.spec_from_file_location('daty_project_revision_candidate', cls.candidate_path)
        cls.bridge = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {
            'DATY_DB_PATH': str(cls.db_path),
            'DATY_ACCESS_FILE': str(cls.directory / 'unused-access.json'),
            'DATY_PAIRING_FILE': str(cls.directory / 'unused-pairing.json'),
        }):
            spec.loader.exec_module(cls.bridge)
        with cls.bridge._db_session() as connection:
            cls.startup_rows = [tuple(row) for row in connection.execute(
                'SELECT id,name,project_json,created_at,updated_at,revision FROM projects ORDER BY id')]
        cls.bridge._log = lambda *args, **kwargs: None
        cls.tls_config = create_tls_fixture(cls.directory)
        cls.context = client_context(cls.tls_config)
        cls.http = bind_https(cls.bridge.ThreadingHTTPServer, ('127.0.0.1', 0),
                             cls.bridge.DatyAPIHandler, server_context(cls.tls_config))
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.worker.join(timeout=5)
        cls.bridge._close_database()
        atexit.unregister(cls.bridge._close_database)
        if str(cls.directory) in sys.path:
            sys.path.remove(str(cls.directory))
        cls.temp.cleanup()
        if (PROJECT / 'mqtt-bridge.py').read_bytes() != cls.original:
            raise AssertionError('The running Bridge source must remain unchanged')

    def setUp(self):
        self.assertEqual(Path(self.bridge._db_path).resolve(), self.db_path.resolve())
        self.http.access_policy = make_test_policy(self.bridge, self.directory)
        with self.bridge._db_session() as connection:
            for trigger in ('fixture_fail_audit', 'fixture_fail_device', 'fixture_deferred_failure'):
                connection.execute('DROP TRIGGER IF EXISTS ' + trigger)
            connection.execute('DROP TABLE IF EXISTS fixture_deferred_audit')
            connection.execute('DROP TABLE IF EXISTS fixture_deferred_parent')
            for table in ('project_devices', 'scan_datasets', 'coordination_runs', 'commands',
                          'telemetry_samples', 'timeline_events', 'projects'):
                connection.execute('DELETE FROM ' + table)
            connection.execute('INSERT INTO projects(id,name,project_json,created_at,updated_at) VALUES(?,?,?,?,?)',
                               ('default', '默认项目', '{"marker":"old"}', 100, 100))
            connection.execute('INSERT INTO project_devices VALUES(?,?,?)',
                               ('default', 'old-ch1', '{"id":"old-ch1","freq":641000}'))
        self.publish = patch.object(self.bridge, '_publish_tracked_command',
                                    side_effect=AssertionError('No receiver command is permitted'))
        self.publish_mock = self.publish.start()
        self.addCleanup(self.publish.stop)
        self.legacy_timeline = patch.object(self.bridge, '_record_timeline',
            side_effect=AssertionError('Project audit must not use a separate legacy transaction'))
        self.timeline_mock = self.legacy_timeline.start()
        self.addCleanup(self.legacy_timeline.stop)

    def tearDown(self):
        self.publish_mock.assert_not_called()
        self.timeline_mock.assert_not_called()
        self.assertEqual(self.bridge._state['commands'], {})

    def request(self, path='/api/projects/default', *, method='GET', body=None,
                token=TEST_TOKEN, origin=None, headers=None):
        request_headers = {'Content-Type': 'application/json', **(headers or {})}
        if token is not None:
            request_headers['Authorization'] = 'Bearer ' + token
        if origin is not None:
            request_headers['Origin'] = origin
        encoded = body if isinstance(body, bytes) else json.dumps(body).encode('utf-8') if body is not None else None
        connection = http.client.HTTPSConnection('127.0.0.1', self.http.server_port,
                                                timeout=5, context=self.context)
        try:
            connection.request(method, path, body=encoded, headers=request_headers)
            response = connection.getresponse()
            payload = response.read()
            return response.status, dict(response.headers), json.loads(payload) if payload else None
        finally:
            connection.close()

    def save(self, *, expected=1, project_id='default', **extra):
        return self.request('/api/projects', method='POST', body={
            'id': project_id, 'name': '已保存项目', 'expected_revision': expected, 'data': {'marker': 'new'}, **extra})

    def snapshot(self):
        with self.bridge._db_session() as connection:
            return {table: [tuple(row) for row in connection.execute('SELECT * FROM ' + table + ' ORDER BY 1,2')]
                    for table in ('projects', 'project_devices', 'timeline_events', 'commands', 'coordination_runs')}

    def test_candidate_is_exact_reviewed_patch_and_cannot_be_applied_twice(self):
        self.assertEqual(self.specification['sourceSha256'], hashlib.sha256(self.original).hexdigest())
        self.assertEqual(len(self.specification['changes']), 4)
        self.assertNotIn(b'\r\n', self.candidate)
        self.assertEqual(self.candidate.startswith(b'\xef\xbb\xbf'), self.original.startswith(b'\xef\xbb\xbf'))
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            candidate_bytes(self.candidate, self.specification)
        invalid = json.loads(json.dumps(self.specification))
        invalid['changes'][0]['before'] = 'no matching candidate anchor'
        with self.assertRaisesRegex(ValueError, 'exactly once'):
            candidate_bytes(self.original, invalid)
        old, new = self.original.decode('utf-8').replace('\r\n', '\n'), self.candidate.decode('utf-8')
        start = '    def do_POST(self):'
        end = "        if path == '/api/projects':"
        self.assertEqual(old[old.index(start):old.index(end)], new[new.index(start):new.index(end)])

    def test_candidate_init_migrates_and_default_insert_uses_revision_one(self):
        with self.bridge._db_session() as connection:
            columns = {row[1]: tuple(row) for row in connection.execute('PRAGMA table_info(projects)')}
            self.assertEqual(columns['revision'][2:5], ('INTEGER', 1, '1'))
            self.assertEqual(connection.execute('SELECT revision FROM projects WHERE id="default"').fetchone()[0], 1)
        self.bridge._init_database()
        self.assertEqual(self.request()[2]['project']['revision'], 1)

    def test_candidate_startup_preserves_old_project_before_creating_default(self):
        rows = {row[0]: row for row in self.startup_rows}
        self.assertEqual(rows['legacy-existing'],
            ('legacy-existing', '旧版项目', '{"unknown":{"retained":true}}', 10, 20, 1))
        self.assertEqual(rows['default'][1], '默认项目')
        self.assertEqual(rows['default'][-1], 1)

    def test_get_list_detail_and_missing_have_explicit_protocol(self):
        for path, status in (('/api/projects', 200), ('/api/projects/default', 200), ('/api/projects/missing', 404)):
            response_status, headers, data = self.request(path, token=None)
            self.assertEqual(response_status, status)
            self.assertEqual(data['revision_protocol'], PROJECT_REVISION_PROTOCOL)
            self.assertIn('no-store', headers['Cache-Control'])
            if 'project' in data:
                self.assertEqual(data['project']['revision'], 1)
                self.assertEqual(data['project']['revision_protocol'], PROJECT_REVISION_PROTOCOL)
                self.assertEqual(data['project']['devices'], [{'id': 'old-ch1', 'freq': 641000}])
            if 'projects' in data:
                self.assertEqual(data['projects'][0]['revision'], 1)
                self.assertEqual(data['projects'][0]['revision_protocol'], PROJECT_REVISION_PROTOCOL)

    def test_authorization_precedes_body_reader_and_project_adapter(self):
        before = self.snapshot()
        for token, status in ((None, 401), ('invalid-token', 401)):
            with patch.object(self.bridge.DatyAPIHandler, '_read_access_json') as reader:
                with patch.object(self.bridge, 'project_api_save') as adapter:
                    actual, _, payload = self.request('/api/projects', method='POST', token=token, body=b'not-json')
                    self.assertEqual(actual, status)
                    self.assertFalse(payload['success'])
                    reader.assert_not_called()
                    adapter.assert_not_called()
        self.http.access_policy = make_test_policy(self.bridge, self.directory, role='viewer')
        with patch.object(self.bridge, 'project_api_save') as adapter:
            self.assertEqual(self.save()[0], 403)
            adapter.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_origin_and_strict_body_validation_remain_before_adapter(self):
        before = self.snapshot()
        with patch.object(self.bridge, 'project_api_save') as adapter:
            self.assertEqual(self.request('/api/projects', method='POST', body=b'bad',
                             origin='https://untrusted.invalid')[0], 403)
            self.assertEqual(self.request('/api/projects', method='POST', body=b'{"invalid":')[0], 400)
            self.assertEqual(self.request('/api/projects', method='POST', body=[])[0], 400)
            self.assertEqual(self.request('/api/projects', method='POST', body=b'{}',
                             headers={'Content-Type': 'text/plain'})[0], 415)
            adapter.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_legacy_request_428_has_no_partial_write(self):
        before = self.snapshot()
        status, _, data = self.request('/api/projects', method='POST',
            body={'id': 'default', 'name': '旧页面', 'data': {'overwrite': True}, 'devices': []})
        self.assertEqual(status, 428)
        self.assertEqual(data['code'], 'PROJECT_PRECONDITION_REQUIRED')
        self.assertEqual(data['revision_protocol'], PROJECT_REVISION_PROTOCOL)
        self.assertFalse(data['accepted'])
        self.assertEqual(self.snapshot(), before)

    def test_success_is_committed_project_devices_revision_and_actor_audit(self):
        status, _, data = self.save(devices=[{'id': 'new-ch1', 'freq': 641250}], actor={'role': 'forged'})
        self.assertEqual(status, 200)
        self.assertEqual(data['revision'], 2)
        self.assertEqual(data['revision_protocol'], PROJECT_REVISION_PROTOCOL)
        detail = self.request()[2]['project']
        self.assertEqual(detail['revision'], 2)
        self.assertEqual(detail['data'], {'marker': 'new'})
        self.assertEqual(detail['devices'], [{'id': 'new-ch1', 'freq': 641250}])
        with closing(sqlite3.connect(self.db_path)) as observer:
            self.assertEqual(observer.execute('SELECT revision FROM projects').fetchone()[0], 2)
            audit = json.loads(observer.execute('SELECT details_json FROM timeline_events').fetchone()[0])
        self.assertEqual(audit['actor']['role'], 'operator')
        self.assertEqual(audit['revision'], 2)
        self.assertNotIn(TEST_TOKEN, json.dumps(audit))

    def test_stale_revision_409_does_not_replace_data_devices_or_audit(self):
        self.assertEqual(self.save()[0], 200)
        before = self.snapshot()
        status, _, data = self.save(expected=1, data={'private': 'losing-copy'}, devices=[])
        self.assertEqual(status, 409)
        self.assertEqual(data['code'], 'PROJECT_REVISION_CONFLICT')
        self.assertEqual((data['expected_revision'], data['current_revision']), (1, 2))
        self.assertNotIn('losing-copy', json.dumps(data))
        self.assertNotIn('project', data)
        self.assertEqual(self.snapshot(), before)

    def test_two_https_writers_with_same_revision_have_one_atomic_winner(self):
        barrier = threading.Barrier(2)
        original = self.bridge.project_api_save
        results, lock = [], threading.Lock()

        def aligned(*args, **kwargs):
            barrier.wait(timeout=5)
            return original(*args, **kwargs)

        def request(label):
            try:
                value = self.save(name=label, data={'writer': label}, devices=[{'id': label}])
            except Exception as error:
                value = ('unexpected', repr(error))
            with lock:
                results.append((label, value))

        with patch.object(self.bridge, 'project_api_save', side_effect=aligned):
            workers = [threading.Thread(target=request, args=(label,)) for label in ('writer-a', 'writer-b')]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=10)
                self.assertFalse(worker.is_alive())
        self.assertEqual(sorted(value[0] for _, value in results), [200, 409])
        winner = next(label for label, value in results if value[0] == 200)
        detail = self.request()[2]['project']
        self.assertEqual((detail['name'], detail['revision']), (winner, 2))
        self.assertEqual(detail['devices'], [{'id': winner}])
        self.assertEqual(len(self.snapshot()['timeline_events']), 1)

    def test_device_failure_rolls_back_before_reply(self):
        with self.bridge._db_session() as connection:
            connection.execute("CREATE TRIGGER fixture_fail_device BEFORE INSERT ON project_devices BEGIN SELECT RAISE(ABORT,'sensitive fixture device'); END")
        before = self.snapshot()
        status, _, data = self.save(devices=[{'id': 'new'}])
        self.assertEqual(status, 503)
        self.assertEqual(data['code'], 'PROJECT_STORE_FAILED')
        self.assertNotIn('sensitive fixture', json.dumps(data))
        self.assertEqual(self.snapshot(), before)

    def test_timeline_failure_rolls_back_project_device_set_and_revision(self):
        with self.bridge._db_session() as connection:
            connection.execute("CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON timeline_events BEGIN SELECT RAISE(ABORT,'sensitive fixture audit'); END")
        before = self.snapshot()
        status, _, data = self.save(devices=[])
        self.assertEqual(status, 503)
        self.assertFalse(data['success'])
        self.assertNotIn('sensitive fixture', json.dumps(data))
        self.assertEqual(self.snapshot(), before)

    def test_actual_deferred_commit_failure_never_returns_success(self):
        with self.bridge._db_session() as connection:
            connection.execute('CREATE TABLE fixture_deferred_parent(id TEXT PRIMARY KEY)')
            connection.execute('CREATE TABLE fixture_deferred_audit(parent_id TEXT REFERENCES fixture_deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)')
            connection.execute("CREATE TRIGGER fixture_deferred_failure AFTER INSERT ON timeline_events BEGIN INSERT INTO fixture_deferred_audit VALUES('absent-parent'); END")
        before = self.snapshot()
        status, _, data = self.save(devices=[])
        self.assertEqual(status, 503)
        self.assertEqual(data['code'], 'PROJECT_STORE_FAILED')
        self.assertFalse(data['success'])
        self.assertEqual(self.snapshot(), before)

    def test_get_project_and_devices_share_snapshot_across_an_external_writer(self):
        original_session, did_update = self.bridge._db_session, []

        class Cursor:
            def __init__(self, cursor):
                self.cursor = cursor

            def fetchone(inner):
                row = inner.cursor.fetchone()
                if not did_update:
                    with closing(sqlite3.connect(self.db_path, timeout=5)) as writer:
                        with writer:
                            writer.execute('UPDATE projects SET project_json=?,revision=revision+1 WHERE id=?',
                                           ('{"marker":"new-external"}', 'default'))
                            writer.execute('DELETE FROM project_devices WHERE project_id="default"')
                            writer.execute('INSERT INTO project_devices VALUES(?,?,?)',
                                           ('default', 'new-external', '{"id":"new-external"}'))
                    did_update.append(True)
                return row

        class Connection:
            def __init__(inner, connection):
                inner.connection = connection

            @property
            def in_transaction(inner):
                return inner.connection.in_transaction

            def execute(inner, sql, *args):
                cursor = inner.connection.execute(sql, *args)
                return Cursor(cursor) if sql.startswith('SELECT id,name,project_json') else cursor

        @contextmanager
        def wrapped():
            with original_session() as connection:
                yield Connection(connection)

        with patch.object(self.bridge, '_db_session', wrapped):
            status, _, data = self.request()
        self.assertEqual(status, 200)
        self.assertTrue(did_update)
        self.assertEqual(data['project']['revision'], 1)
        self.assertEqual(data['project']['data'], {'marker': 'old'})
        self.assertEqual(data['project']['devices'], [{'id': 'old-ch1', 'freq': 641000}])
        latest = self.request()[2]['project']
        self.assertEqual(latest['revision'], 2)
        self.assertEqual(latest['devices'], [{'id': 'new-external'}])

    def test_percent_unicode_slash_plus_and_double_encoding_ids_roundtrip_exactly(self):
        ids = ['项目 / 编组+%2F? # 🎤', 'literal%2Fvalue', 'literal/value', 'a+b', 'a b']
        for project_id in ids:
            with self.subTest(project_id=project_id):
                self.assertEqual(self.save(expected=0, project_id=project_id)[0], 200)
                status, _, data = self.request('/api/projects/' + quote(project_id, safe=''))
                self.assertEqual(status, 200)
                self.assertEqual(data['project']['id'], project_id)
        projects = self.request('/api/projects')[2]['projects']
        self.assertEqual({project['id'] for project in projects}, {'default', *ids})

    def test_invalid_encoding_and_ambiguous_raw_paths_are_rejected_without_aliasing(self):
        before = self.snapshot()
        for suffix, status in (('%', 400), ('%GG', 400), ('%FF', 400), ('%ED%A0%80', 400),
                               ('%00', 400), ('%20', 400), ('', 404), ('anything/default', 404)):
            actual, _, payload = self.request('/api/projects/' + suffix)
            self.assertEqual(actual, status, suffix)
            self.assertEqual(payload['revision_protocol'], PROJECT_REVISION_PROTOCOL)
            self.assertNotIn('project', payload)
        self.assertEqual(self.snapshot(), before)

    def test_invalid_revisions_duplicate_devices_and_unicode_do_not_partially_save(self):
        before = self.snapshot()
        for value in (True, False, None, '1', 1.0, -1, 9007199254740992):
            self.assertEqual(self.save(expected=value)[0], 400)
        self.assertEqual(self.save(devices=[{'id': 1}, {'id': '1'}])[0], 400)
        for extra in ({'name': '\ud800'}, {'data': {'private': '\ud800'}}, {'devices': [{'id': '\ud800'}]}):
            status, _, data = self.save(**extra)
            self.assertEqual(status, 400)
            self.assertFalse(data['success'])
        self.assertEqual(self.snapshot(), before)

    def test_corrupt_stored_json_or_unicode_returns_sanitized_failure(self):
        for value in ('{"private":"do-not-leak"} trailing', '{"private":"\\ud800"}', '{"private":NaN}'):
            with self.bridge._db_session() as connection:
                connection.execute('UPDATE projects SET project_json=? WHERE id=?', (value, 'default'))
            status, _, payload = self.request()
            self.assertEqual(status, 503)
            self.assertEqual(payload['code'], 'PROJECT_READ_FAILED')
            self.assertNotIn('private', json.dumps(payload))
            self.assertNotIn('do-not-leak', json.dumps(payload))
            self.assertNotIn('project', payload)

    def test_create_without_id_is_create_only_and_duplicate_create_is_conflict(self):
        with patch.object(self.bridge.uuid, 'uuid4', return_value=type('Uuid', (), {'hex': 'fixed-new-id'})()):
            status, _, data = self.request('/api/projects', method='POST',
                                          body={'expected_revision': 0, 'name': '创建', 'data': {}})
        self.assertEqual(status, 200)
        self.assertEqual((data['project_id'], data['revision']), ('fixed-new-id', 1))
        self.assertEqual(self.save(expected=0, project_id='fixed-new-id')[0], 409)
        self.assertEqual(self.request('/api/projects', method='POST', body={'expected_revision': 1})[0], 400)

    def test_unrelated_get_route_does_not_gain_project_capability(self):
        status, _, data = self.request('/api/projects-not-a-route')
        self.assertEqual(status, 404)
        self.assertNotIn('revision_protocol', data)

    def test_network_response_failure_does_not_attempt_a_second_reply(self):
        calls = []

        class BrokenReply:
            def _json(inner, payload, status=200):
                calls.append((payload, status))
                raise BrokenPipeError('isolated reply channel closed')

        with self.assertRaises(BrokenPipeError):
            project_api.handle_save(BrokenReply(), {'id': 'default', 'expected_revision': 1,
                'data': {'committed': True}}, {'id': 'test', 'name': 'Test', 'role': 'operator'},
                db_session=self.bridge._db_session, now=lambda: 300, new_id=lambda: 'unused')
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], 200)
        self.assertEqual(self.request()[2]['project']['data'], {'committed': True})
        self.assertEqual(len(self.snapshot()['timeline_events']), 1)


if __name__ == '__main__':
    unittest.main()
