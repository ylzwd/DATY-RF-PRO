"""Temporary databases and archive files only; no services or receiver commands."""
from contextlib import contextmanager, closing
from pathlib import Path
import csv
import io
import json
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid
import zipfile

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
import unified_bootstrap as boot
import unified_database as db
import unified_domains
import server_storage_api as api
from server_archive import ArchiveService,digest


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='daty-storage-unit-');self.addCleanup(self.temp.cleanup);self.directory=Path(self.temp.name)
        self.path=self.directory/'data.sqlite3';connection=boot.open_database(self.path)
        self.meta=boot.initialize(connection,100);connection.commit();boot.enable_wal(connection);connection.close()
        self.archive=ArchiveService(self.path,self.directory/'archives');self.actor={'id':'network:127.0.0.1','kind':'network-peer','authenticated':False,'ip':'127.0.0.1'}
    @contextmanager
    def session(self):
        connection=sqlite3.connect(self.path);connection.execute('PRAGMA foreign_keys=ON')
        try:
            with connection:yield connection
        finally:connection.close()
    def request(self,path,body=None):
        class Handler:
            def _json(handler,value,status=200):handler.reply=(status,value)
        handler=Handler();handled=api.handle(handler,'GET' if body is None else 'POST',path,db_session=self.session,read_json=lambda _:body,actor=self.actor,archive=self.archive)
        self.assertTrue(handled);return handler.reply
    def test_export_is_durable_exact_and_idempotent(self):
        body={'operation_id':uuid.uuid4().hex,'text':'\ufeff编组,频率\r\nGROUP2,641.250','fileName':'频率.csv','mimeType':'text/csv'}
        record=self.archive.export(body,self.actor);self.assertEqual(record['status'],'saved')
        self.assertEqual((self.directory/'archives/exports'/record['id']/'content').read_bytes(),body['text'].encode())
        self.assertEqual(self.archive.export(body,self.actor),record);self.assertEqual(len(self.archive.list('exports')),1)
        with self.assertRaises(db.DatabaseError):self.archive.export({**body,'text':'different'},self.actor)
        reopened=ArchiveService(self.path,self.directory/'archives');self.assertEqual(reopened.get('exports',record['id']),record)
    def export_fixture(self, text='keep real business data'):
        body={'operation_id':uuid.uuid4().hex,'text':text,'fileName':'report.txt','mimeType':'text/plain'}
        return body,self.archive.export(body,self.actor)
    def prepare(self, selection=None):
        return self.archive.prepare_cleanup({'operation_id':uuid.uuid4().hex,'selection':selection or {'category':'all'}},self.actor)
    def commit(self, plan):
        return self.archive.commit_cleanup(plan['id'],{'confirmed':True,'planSha256':plan['planSha256']},self.actor)
    def test_cleanup_freezes_files_preserves_new_exports_and_live_database(self):
        _,first=self.export_fixture();before=digest(self.path)
        plan=self.prepare();self.assertEqual(plan['count'],1);self.assertEqual(len(self.archive.list('exports')),1)
        _,new=self.export_fixture('new after confirmation');result=self.commit(plan)
        self.assertEqual(result['status'],'completed');self.assertEqual(result['deletedCount'],1)
        self.assertEqual(result['freedBytes'],first['bytes']);self.assertEqual(digest(self.path),before)
        self.assertEqual([r['id'] for r in self.archive.list('exports')],[new['id']])
        self.assertFalse((self.archive._folder('exports',first['id'])/'content').exists())
        self.assertEqual(self.archive.get('exports',first['id'])['status'],'deleted')
        self.assertEqual(self.commit(plan),result)
        reopened=ArchiveService(self.path,self.directory/'archives');self.assertEqual(reopened.get_cleanup(plan['id']),result)
        self.assertEqual(reopened.list('exports'),self.archive.list('exports'))
    def test_cleanup_completed_zip_releases_snapshot_and_zip_but_keeps_business_tables(self):
        with self.session() as c:c.execute("INSERT INTO telemetry_samples(device_id,ts,frequency_khz) VALUES('keep',1,641000)")
        _,export=self.export_fixture();record=self.archive.create({'operation_id':uuid.uuid4().hex},self.actor)
        deadline=time.monotonic()+20
        while self.archive.get('archives',record['id'])['status'] in ('queued','running') and time.monotonic()<deadline:time.sleep(.02)
        self.assertEqual(self.archive.get('archives',record['id'])['status'],'saved')
        plan=self.prepare();result=self.commit(plan)
        self.assertEqual(result['deletedCount'],2);self.assertEqual(result['freedBytes'],plan['bytes'])
        self.assertEqual(self.archive.list('archives'),[]);self.assertEqual(self.archive.list('exports'),[])
        self.assertEqual({p.name for p in self.archive._folder('archives',record['id']).iterdir()},{'manifest.json'})
        with self.session() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM telemetry_samples').fetchone()[0],1)
        with self.assertRaises(db.DatabaseError):self.archive.download(None,'exports',export['id'])
        self.assertFalse(self.archive.downloads)
    def test_cleanup_requires_exact_confirmation_actor_and_fresh_plan(self):
        self.export_fixture();plan=self.prepare();body={'confirmed':True,'planSha256':plan['planSha256']}
        for changed in [{}, {**body,'confirmed':False}, {**body,'confirmed':1}, {**body,'planSha256':'wrong'}, {**body,'extra':True}]:
            with self.assertRaises(db.DatabaseError):self.archive.commit_cleanup(plan['id'],changed,self.actor)
        with self.assertRaises(db.DatabaseError):self.archive.commit_cleanup(plan['id'],body,{**self.actor,'id':'other'})
        with patch('server_archive.time.time',return_value=plan['createdAtMs']/1000+601):
            with self.assertRaises(db.DatabaseError):self.commit(plan)
        self.assertEqual(len(self.archive.list('exports')),1)
    def test_cleanup_changed_file_blocks_whole_selection_before_deleting(self):
        _,first=self.export_fixture();_,second=self.export_fixture();plan=self.prepare()
        folder=self.archive._folder('exports',second['id']);self.archive._save(folder,{**second,'generation':'changed'})
        with self.assertRaises(db.DatabaseError):self.commit(plan)
        self.assertTrue((self.archive._folder('exports',first['id'])/'content').exists())
        self.assertEqual(len(self.archive.list('exports')),2)
    def test_cleanup_archive_creation_and_download_leases_block_before_and_after_confirmation(self):
        _,record=self.export_fixture();plan=self.prepare()
        for busy in ['archive','download']:
            if busy=='archive':self.archive.active.add('active')
            else:self.archive.downloads[('exports',record['id'])]=1
            with self.assertRaises(db.DatabaseError):self.prepare()
            with self.assertRaises(db.DatabaseError):self.commit(plan)
            self.archive.active.clear();self.archive.downloads.clear()
        self.assertEqual(self.commit(plan)['deletedCount'],1)
    def test_cleanup_partial_failure_has_durable_receipt_and_never_replays(self):
        _,first=self.export_fixture();_,second=self.export_fixture();plan=self.prepare();original=Path.unlink
        def fail_one(path,*args,**kwargs):
            if path.parent.name==first['id'] and path.name=='content':raise PermissionError('file held')
            return original(path,*args,**kwargs)
        with patch.object(Path,'unlink',fail_one):result=self.commit(plan)
        self.assertEqual(result['status'],'partial');self.assertEqual(result['deletedCount'],1)
        self.assertEqual(self.commit(plan),result);self.assertEqual(len(self.archive.list('exports')),1)
        self.assertEqual(self.archive.get('exports',first['id'])['status'],'interrupted')
        self.assertEqual(self.commit(self.prepare())['deletedCount'],1)
    def test_cleanup_export_after_deletion_is_new_generation_not_old_receipt_success(self):
        body,record=self.export_fixture();plan=self.prepare();self.commit(plan)
        new=self.archive.export(body,self.actor);self.assertEqual(new['status'],'saved');self.assertNotEqual(new['generation'],record['generation'])
        self.commit(plan);self.assertTrue((self.archive._folder('exports',record['id'])/'content').exists())
        stale=self.prepare();self.commit(self.prepare());self.archive.export(body,self.actor)
        with self.assertRaises(db.DatabaseError):self.commit(stale)
    def test_cleanup_does_not_traverse_unknown_files_hardlinks_or_directory_junctions(self):
        _,record=self.export_fixture();folder=self.archive._folder('exports',record['id'])
        (folder/'unknown').write_text('preserve')
        with self.assertRaises(db.DatabaseError):self.prepare()
        (folder/'unknown').unlink();outside=self.directory/'outside.txt';outside.write_text('keep')
        content=folder/'content';content.unlink()
        import os
        os.link(outside,content)
        with self.assertRaises(db.DatabaseError):self.prepare()
        self.assertEqual(outside.read_text(),'keep');content.unlink();content.write_text('safe')
        with patch.object(Path,'is_symlink',lambda p:p==folder.parent):
            with self.assertRaises(db.DatabaseError):self.prepare()
        for selection in [{'category':'../'}, {'category':'all','id':record['id']}, {'category':'exports','id':'../../x'}, {'category':'exports','extra':1}]:
            with self.assertRaises(db.DatabaseError):self.prepare(selection)
    def test_cleanup_failed_archive_temporary_files_and_routes(self):
        identifier=uuid.uuid4().hex;folder=self.archive._folder('archives',identifier);folder.mkdir(parents=True)
        self.archive._save(folder,{'id':identifier,'status':'running','createdAtMs':1,'fileName':'incomplete.zip'})
        (folder/'archive.zip.partial').write_bytes(b'partial');(folder/'database.sqlite3').write_bytes(b'snapshot')
        status,data=self.request('/api/database/archive-cleanups',{'operation_id':uuid.uuid4().hex,'selection':{'category':'archives','id':identifier}})
        self.assertEqual(status,200);plan=data['record'];self.assertEqual(plan['bytes'],15)
        status,result=self.request('/api/database/archive-cleanups/'+plan['id']+'/commit',{'confirmed':True,'planSha256':plan['planSha256']})
        self.assertEqual(status,200);self.assertEqual(result['record']['deletedCount'],1)
        self.assertEqual(self.request('/api/database/archive-cleanups/'+plan['id'])[1]['record'],result['record'])
        self.assertEqual(self.request('/api/database/storage-status')[1]['archives'],0)
        self.assertEqual(self.request('/api/database/storage-status')[1]['cleanupProtocol'],'daty-archive-cleanup-v1')
    def test_cleanup_interrupted_receipt_reconciles_tombstones_without_resuming(self):
        _,first=self.export_fixture();_,second=self.export_fixture();plan=self.prepare()
        self.archive._save(self.archive._folder('cleanups',plan['id']),{**plan,'status':'running','deletedCount':0,'freedBytes':0})
        self.archive._save(self.archive._folder('exports',first['id']),{**first,'status':'deleted','cleanupId':plan['id']})
        reopened=ArchiveService(self.path,self.directory/'archives');result=reopened.get_cleanup(plan['id'])
        self.assertEqual(result['status'],'interrupted');self.assertEqual(result['deletedCount'],1)
        self.assertEqual(reopened.commit_cleanup(plan['id'],{'confirmed':True,'planSha256':plan['planSha256']},self.actor),result)
        self.assertTrue((self.archive._folder('exports',second['id'])/'content').exists())
    def test_invalid_filename_and_operation_do_not_escape_archive(self):
        for filename in ['../secret.txt','C:\\secret','a\n.txt']:
            with self.assertRaises(db.DatabaseError):self.archive.export({'operation_id':uuid.uuid4().hex,'text':'data','fileName':filename,'mimeType':'text/plain'},self.actor)
        with self.assertRaises(db.DatabaseError):self.archive.get('archives','../../x')
        self.assertEqual(self.archive.list('exports'),[])
    def test_full_archive_contains_every_table_all_rows_exports_and_verifiable_database(self):
        with self.session() as c:
            c.executemany('INSERT INTO telemetry_samples(device_id,ts,frequency_khz,muted) VALUES(?,?,?,?)',[('rx_ch1',i,641000,None) for i in range(1201)])
        self.archive.export({'operation_id':uuid.uuid4().hex,'text':'real text','fileName':'report.txt','mimeType':'text/plain'},self.actor)
        record=self.archive.create({'operation_id':uuid.uuid4().hex},self.actor);deadline=time.monotonic()+20
        while self.archive.get('archives',record['id'])['status'] in ('queued','running') and time.monotonic()<deadline:time.sleep(.02)
        complete=self.archive.get('archives',record['id']);self.assertEqual(complete['status'],'saved',complete)
        path=self.directory/'archives/archives'/record['id']/'archive.zip';self.assertEqual(digest(path),complete['sha256'])
        with zipfile.ZipFile(path) as z:
            meta=json.loads(z.read('manifest.json'));self.assertEqual(len(meta['tables']),51);self.assertEqual(meta['exports'][0]['fileName'],'report.txt')
            rows=list(csv.reader(io.StringIO(z.read('tables/telemetry_samples.csv').decode('utf-8-sig'))));self.assertEqual(len(rows),1202)
            (self.directory/'restored.sqlite3').write_bytes(z.read('database.sqlite3'))
        with closing(sqlite3.connect(self.directory/'restored.sqlite3')) as c:
            self.assertEqual(c.execute('PRAGMA integrity_check').fetchall(),[('ok',)])
            self.assertEqual(c.execute('SELECT COUNT(*) FROM telemetry_samples WHERE muted IS NULL').fetchone()[0],1201)
    def test_interrupted_archive_never_reports_saved_or_restarts_work(self):
        folder=self.directory/'archives/archives'/('a'*32);folder.mkdir(parents=True)
        (folder/'manifest.json').write_text(json.dumps({'id':'a'*32,'status':'running','createdAtMs':100}),encoding='utf-8')
        self.assertEqual(self.archive.get('archives','a'*32)['status'],'interrupted');self.assertFalse(self.archive.active)
    def test_draft_cas_keeps_incomplete_inputs_without_promoting_to_plan(self):
        body={'projectId':'default','fields':{'plannerRangeStart':'640.','plannerRangeEnd':''},'expected_draft_id':None,'operation_id':uuid.uuid4().hex,'epoch':self.meta['epoch']}
        code,result=self.request('/api/database/draft',body);self.assertEqual(code,200,result);self.assertFalse(result['draft']['value']['payload']['deploymentEligible'])
        code,conflict=self.request('/api/database/draft',{**body,'operation_id':uuid.uuid4().hex});self.assertEqual(code,409);self.assertEqual(conflict['code'],'DRAFT_CONFLICT')
        code,read=self.request('/api/database/draft?project_id=default');self.assertEqual(read['draft'],result['draft'])
        with self.session() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM biz_planning_records').fetchone()[0],0)
    def test_network_source_audit_is_not_an_operator(self):
        with self.session() as c:
            db.put_resource(c,{'kind':'settings','id':'alert_sound','operation_id':uuid.uuid4().hex,'epoch':self.meta['epoch'],'expected_revision':0,'value':{'enabled':True}},self.actor,100)
        with self.session() as c:actor=json.loads(c.execute('SELECT actor_json FROM db_audit').fetchone()[0])
        self.assertEqual(actor,self.actor);self.assertNotIn('role',actor)
    def test_bad_draft_operation_epoch_and_query_never_mutate(self):
        body={'projectId':'default','fields':{'plannerRangeStart':'640'},'expected_draft_id':None,'operation_id':uuid.uuid4().hex,'epoch':self.meta['epoch']}
        for value in [None,True,123,'bad']:
            self.assertEqual(self.request('/api/database/draft',{**body,'operation_id':value})[0],400)
        self.assertEqual(self.request('/api/database/draft',{**body,'epoch':'old'})[0],409)
        self.assertEqual(self.request('/api/database/draft?project_id=default&project_id=other')[0],400)
        self.assertIsNone(self.request('/api/database/draft?project_id=default')[1]['draft'])
    def test_completed_draft_replay_requires_same_epoch_actor_and_body(self):
        body={'projectId':'default','fields':{'plannerRangeStart':'640'},'expected_draft_id':None,'operation_id':uuid.uuid4().hex,'epoch':self.meta['epoch']}
        self.assertEqual(self.request('/api/database/draft',body)[0],200)
        self.assertEqual(self.request('/api/database/draft',body)[0],200)
        self.assertEqual(self.request('/api/database/draft',{**body,'epoch':'old'})[0],409)
        self.assertEqual(self.request('/api/database/draft',{**body,'fields':{'plannerRangeStart':'641'}})[0],409)
    def test_disk_failure_never_publishes_saved_export(self):
        body={'operation_id':uuid.uuid4().hex,'text':'original','fileName':'report.txt','mimeType':'text/plain'}
        import server_archive
        original=server_archive.os.fsync;calls=[]
        def fail_second(handle):
            calls.append(handle)
            if len(calls)==2:raise OSError('fixture disk full')
            return original(handle)
        with patch.object(server_archive.os,'fsync',side_effect=fail_second):
            with self.assertRaises(OSError):self.archive.export(body,self.actor)
        self.assertEqual(self.archive.get('exports',body['operation_id'])['status'],'interrupted')
        self.assertFalse((self.directory/'archives/exports'/body['operation_id']/'content').exists())
    def test_json_snapshot_is_read_only_server_content(self):
        code,value=self.request('/api/database/business-snapshot')
        self.assertEqual(code,200);self.assertEqual(value['source'],'server-sqlite');self.assertEqual(value['resources'],[])
        with self.session() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM db_audit').fetchone()[0],0)
    def test_unplanned_zero_is_preserved_but_negative_or_fractional_frequency_is_rejected(self):
        record={'id':'plan','projectId':'default','type':'daty_rf_planning','timestamp':100,'channels':1,'devices':[{'id':'rx_ch1','brand':'DATYaudio','freq':641000,'planned':0}]}
        self.assertEqual(unified_domains.validate_document('planning_records','plan',record)['devices'][0]['planned'],0)
        for value in [-1,True,0.5]:
            with self.assertRaises(unified_domains.DomainError):unified_domains.validate_document('planning_records','plan',{**record,'devices':[{**record['devices'][0],'planned':value}]})


if __name__=='__main__':unittest.main()
