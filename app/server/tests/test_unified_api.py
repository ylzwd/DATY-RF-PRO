"""Authenticated adapter over genuine disposable TLS and SQLite; no live services."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager,closing
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
import uuid

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import unified_api
import unified_database as db
from access_control import HttpAccessMixin, AccessPolicy
from access_test_support import TEST_TOKEN,make_test_policy
from pairing_test_support import create_tls_fixture
from tls_support import bind_https,client_context,server_context
from test_unified_database import legacy_connection


class Handler(HttpAccessMixin,BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def _json(self,data,status=200):
        payload=json.dumps(data,ensure_ascii=False,allow_nan=False).encode('utf-8')
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(payload)));self.send_header('Cache-Control','no-store')
        self._access_headers();self.end_headers()
        if self.server.drop_reply and self.command=='POST' and status==200:
            self.server.drop_reply=False
            self.close_connection=True
            return
        self.wfile.write(payload)
    def do_GET(self):
        if self._check_origin():
            if not unified_api.handle(self,'GET',self.path,db_session=self.server.db_session):self._json({},404)
    def do_POST(self):
        if self._check_origin():
            if not unified_api.handle(self,'POST',self.path,db_session=self.server.db_session):self._json({},404)


class UnifiedApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='daty-unified-api-')
        cls.directory=Path(cls.temp.name)
        tls=create_tls_fixture(cls.directory);cls.context=client_context(tls)
        cls.http=bind_https(ThreadingHTTPServer,('127.0.0.1',0),Handler,server_context(tls))
        cls.worker=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.worker.start()
    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.worker.join(5);cls.temp.cleanup()
    def setUp(self):
        self.path=self.directory/(uuid.uuid4().hex+'.sqlite3')
        with closing(legacy_connection()) as source:
            with closing(sqlite3.connect(self.path)) as destination:source.backup(destination)
        self.lock=threading.RLock();self.db_accesses=0
        @contextmanager
        def session():
            with self.lock:
                self.db_accesses+=1
                conn=sqlite3.connect(self.path);conn.execute('PRAGMA foreign_keys=ON')
                try:
                    with conn:yield conn
                finally:conn.close()
        self.session=session
        with session() as conn:self.meta=db.migrate(conn,100)
        self.http.db_session=session;self.http.drop_reply=False
        self.http.access_policy=make_test_policy(SimpleNamespace(_access_policy=AccessPolicy(self.directory/'absent.json')),self.directory)
    def request(self,path='/api/database/status',method='GET',body=None,token=TEST_TOKEN,**headers):
        h={'Content-Type':'application/json',**headers}
        if token is not None:h['Authorization']='Bearer '+token
        raw=body if isinstance(body,bytes) else json.dumps(body,allow_nan=False).encode() if body is not None else None
        connection=http.client.HTTPSConnection('127.0.0.1',self.http.server_port,timeout=5,context=self.context)
        try:
            connection.request(method,path,body=raw,headers=h);response=connection.getresponse()
            payload=response.read();return response.status,dict(response.headers),json.loads(payload)
        finally:connection.close()
    def body(self,revision=0):
        return {'operation_id':uuid.uuid4().hex,'epoch':self.meta['epoch'],'kind':'settings','id':'alert_sound',
                'expected_revision':revision,'value':{'enabled':True}}
    def test_authorization_and_origin_rejected_before_database_access(self):
        before=self.db_accesses
        for method,token,headers in [('GET',None,{}),('POST',None,{}),('POST','wrong',{}),('GET',TEST_TOKEN,{'Origin':'https://evil.invalid'})]:
            code,_,_=self.request('/api/database/write' if method=='POST' else '/api/database/status',method,self.body() if method=='POST' else None,token,**headers)
            self.assertIn(code,(401,403))
        self.assertEqual(self.db_accesses,before)
    def test_valid_write_read_list_and_receipt(self):
        body=self.body();code,_,saved=self.request('/api/database/write','POST',body)
        self.assertEqual(code,200);self.assertEqual(saved['resource']['revision'],1)
        code,headers,loaded=self.request('/api/database/resources/settings/alert_sound')
        self.assertEqual(loaded['resource'],saved['resource']);self.assertEqual(headers['Cache-Control'],'no-store')
        listing=self.request('/api/database/resources?kind=settings&limit=20')[2]
        self.assertEqual(listing['resources'],[saved['resource']])
        receipt=self.request('/api/database/operations/'+body['operation_id'])[2]
        self.assertEqual(receipt['operation']['resource'],saved['resource'])
    def test_two_real_tls_clients_compete_one_commit_only(self):
        bodies=[self.body(),self.body()]
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses=list(pool.map(lambda body:self.request('/api/database/write','POST',body),bodies))
        self.assertEqual(sorted(item[0] for item in responses),[200,409])
        with self.session() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM db_operations').fetchone()[0],1)
    def test_lost_reply_is_unknown_until_reading_durable_receipt(self):
        body=self.body();self.http.drop_reply=True
        with self.assertRaises(http.client.IncompleteRead):self.request('/api/database/write','POST',body)
        receipt=self.request('/api/database/operations/'+body['operation_id'])[2]['operation']
        self.assertEqual(receipt['status'],'committed');self.assertEqual(receipt['resource']['revision'],1)
        with self.session() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM db_operations').fetchone()[0],1)
    def test_batch_failure_rolls_back_and_no_receipt_exists(self):
        write={k:v for k,v in self.body().items() if k not in ('operation_id','epoch')}
        body={'operation_id':uuid.uuid4().hex,'epoch':self.meta['epoch'],'writes':[write,
            {**write,'id':'auto_frequency','value':{'enabled':'false'}}]}
        self.assertEqual(self.request('/api/database/batch','POST',body)[0],400)
        self.assertEqual(self.request('/api/database/operations/'+body['operation_id'])[0],404)
        self.assertEqual(self.request('/api/database/resources/settings/alert_sound')[0],404)
    def test_bad_json_duplicates_nan_and_missing_revision_refused(self):
        body=self.body();body.pop('expected_revision')
        self.assertEqual(self.request('/api/database/write','POST',body)[0],428)
        for raw in [b'{"kind":"settings","kind":"scans"}',b'{"value":NaN}',b'[]',b'{}junk']:
            self.assertEqual(self.request('/api/database/write','POST',raw)[0],400)
        with self.session() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM db_operations').fetchone()[0],0)
    def test_commit_failure_is_not_reported_as_saved(self):
        with self.session() as c:
            c.execute("CREATE TRIGGER fixture_audit_fail BEFORE INSERT ON db_audit BEGIN SELECT RAISE(ABORT,'fixture'); END")
        body=self.body();self.assertEqual(self.request('/api/database/write','POST',body)[0],503)
        self.assertEqual(self.request('/api/database/operations/'+body['operation_id'])[0],404)
        self.assertEqual(self.request('/api/database/resources/settings/alert_sound')[0],404)
    def test_restore_epoch_invalidates_old_client_and_old_receipt(self):
        body=self.body();self.request('/api/database/write','POST',body)
        with self.session() as c:db.rotate_recovery_epoch(c,self.meta['epoch'],uuid.uuid4().hex)
        self.assertEqual(self.request('/api/database/write','POST',self.body(1))[0],409)
        self.assertEqual(self.request('/api/database/operations/'+body['operation_id'])[0],409)
    def test_strict_paths_and_cursor_and_read_write_methods(self):
        for path in ['/api/database/resources?kind=settings&limit=1&limit=2',
            '/api/database/resources/settings/%FF','/api/database/resources/settings/%G0']:
            self.assertEqual(self.request(path)[0],400)
        self.assertEqual(self.request('/api/database/resources?kind=settings&cursor=bad')[0],409)
        self.assertEqual(self.request('/api/database/write')[0],404)

    def test_missing_profile_reference_is_definitive_conflict_not_unknown_503(self):
        body=self.body();body.update(kind='planning_runs',id='missing-profile-run',
            value={'projectId':'default','input':{},'result':{},'profileRefs':[{'id':'missing-profile','revision':1}]})
        code,_,reply=self.request('/api/database/write','POST',body)
        self.assertEqual(code,409);self.assertEqual(reply['code'],'PROFILE_REFERENCE_CONFLICT')
        self.assertFalse(reply['accepted'])
        self.assertEqual(self.request('/api/database/operations/'+body['operation_id'])[0],404)
        with self.session() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM db_operations').fetchone()[0],0)
            self.assertEqual(c.execute('SELECT COUNT(*) FROM db_planning_runs').fetchone()[0],0)


if __name__=='__main__':unittest.main()
