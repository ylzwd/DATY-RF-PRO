"""项目规划历史接口回归：临时 SQLite + 回环随机端口，不访问现场设备。"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from http_test_support import json_headers


class PlanningProjectApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='daty-planning-test-')
        source = Path(__file__).resolve().parents[1] / 'mqtt-bridge.py'
        spec = importlib.util.spec_from_file_location('daty_planning_api_test', source)
        cls.bridge = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'DATY_DB_PATH': str(Path(cls.temp.name) / 'planning.sqlite3')}):
            spec.loader.exec_module(cls.bridge)
        cls.bridge._log = lambda *args, **kwargs: None
        cls.http = cls.bridge.ThreadingHTTPServer(('127.0.0.1', 0), cls.bridge.DatyAPIHandler)
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()
        cls.base = f'http://127.0.0.1:{cls.http.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.worker.join(timeout=5)
        cls.bridge._close_database()
        cls.temp.cleanup()

    def request_json(self, endpoint, body=None):
        request = Request(self.base + endpoint, data=None if body is None else json.dumps(body).encode('utf-8'),
                          headers=json_headers())
        with urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
            result = json.load(response)
            self.assertTrue(result['success'])
            return result

    def test_constraints_history_result_and_timeline_are_persisted(self):
        project_id = 'history-roundtrip'
        device = {'id': 1, '_fasheId': 'FAshe-192.0.2.102_ch1', 'channel_number': 1, 'planned': 620000}
        constraints = {'excludedRanges': [{'startKHz': 615000, 'endKHz': 616000}],
                       'lockedAssignments': [{'deviceId': 1, 'frequencyKHz': 620000}],
                       'knownCarriers': [{'frequencyKHz': 630500, 'guardKHz': 250}], 'backupCount': 0}
        fields = {'plannerBackupCount': '0', 'plannerExcludedRanges': '615.000-616.000 电视'}
        record = {'id': 'snapshot-1', 'type': 'daty_rf_planning', 'projectId': project_id,
                  'devices': [device], 'constraints': constraints, 'constraintFields': fields}
        data = {'venue': '剧场A', 'constraints': constraints, 'constraintFields': fields,
                'planningHistory': [record], 'currentPlanningRecordId': record['id']}
        self.request_json('/api/projects', {'id': project_id, 'name': '规划接口测试', 'data': data, 'devices': [device]})
        restored = self.request_json('/api/projects/' + project_id)['project']
        self.assertEqual(restored['data'], data)
        self.assertEqual(restored['devices'], [device])
        run = {'project_id': project_id, 'input': {'devices': [device], 'options': constraints},
               'result': {'assignments': [{'deviceId': 1, 'frequencyKHz': 620000}], 'analysis': {'conflicts': []}}}
        run_id = self.request_json('/api/coordination-runs', run)['run_id']
        with self.bridge._db_session() as connection:
            stored = connection.execute('SELECT * FROM coordination_runs WHERE id=?', (run_id,)).fetchone()
        self.assertEqual(stored['project_id'], project_id)
        self.assertEqual(json.loads(stored['input_json']), run['input'])
        self.assertEqual(json.loads(stored['result_json']), run['result'])
        events = self.request_json('/api/timeline?project_id=' + project_id)['events']
        self.assertEqual({event['event_type'] for event in events}, {'project.saved', 'coordination.completed'})

    def test_project_history_isolation_and_empty_history_roundtrip(self):
        for project_id, backup in [('isolation-a', 0), ('isolation-b', 2)]:
            self.request_json('/api/projects', {'id': project_id, 'name': project_id,
                              'data': {'constraints': {'backupCount': backup}, 'planningHistory': [], 'currentPlanningRecordId': None}})
        for project_id, backup in [('isolation-a', 0), ('isolation-b', 2)]:
            data = self.request_json('/api/projects/' + project_id)['project']['data']
            self.assertEqual(data['constraints']['backupCount'], backup)
            self.assertEqual(data['planningHistory'], [])
            self.assertIsNone(data['currentPlanningRecordId'])


if __name__ == '__main__':
    unittest.main()
