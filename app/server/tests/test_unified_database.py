"""Entirely isolated database/CAS/scan contracts. Never imports the running Bridge."""
import ast
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import sys
import unittest
import uuid

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import unified_database as db


def legacy_connection():
    source=ast.parse((ROOT/'mqtt-bridge.py').read_text(encoding='utf-8-sig'))
    init=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='_init_database')
    schema=next(ast.literal_eval(n.value) for n in init.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='schema' for t in n.targets))
    connection=sqlite3.connect(':memory:')
    connection.execute('PRAGMA foreign_keys=ON');connection.executescript(schema)
    connection.execute('INSERT INTO projects VALUES(?,?,?,?,?)',('default','默认项目','{"keep":true}',1,1));connection.commit()
    return connection


class UnifiedDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.c=legacy_connection();self.addCleanup(self.c.close)
        with self.c:
            self.meta=db.migrate(self.c,100)
        self.actor={'id':'fixture-operator','name':'测试','role':'operator'}

    def body(self,kind='settings',id='alert_thresholds',value=None,revision=0,**extra):
        if value is None:
            value={'rfWeakDbm':-90,'batteryLowPercent':20,'afOverloadDbfs':-3}
        return dict(operation_id=uuid.uuid4().hex,epoch=self.meta['epoch'],kind=kind,id=id,
                    expected_revision=revision,value=value,**extra)

    def save(self,body):
        with self.c:
            return db.put_resource(self.c,body,self.actor,1000)

    def test_incremental_migration_preserves_legacy_and_is_idempotent(self):
        before=self.c.execute('SELECT * FROM projects').fetchall()
        with self.c:
            observed=db.migrate(self.c,200)
        self.assertEqual(self.meta,observed);self.assertEqual(self.c.execute('SELECT * FROM projects').fetchall(),before)
        self.assertEqual(before[0][2],'{"keep":true}');self.assertEqual(before[0][-1],1)
        self.assertEqual(self.c.execute('PRAGMA foreign_key_check').fetchall(),[])
        self.assertEqual(len(self.c.execute('SELECT * FROM db_schema_migrations').fetchall()),db.SCHEMA_VERSION)

    def test_failed_migration_rolls_back_ddl_and_revision(self):
        c=legacy_connection();self.addCleanup(c.close)
        with self.assertRaises(db.DatabaseError):
            with c:
                db.migrate(c,100,new_id=lambda:'')
        self.assertNotIn('revision',[r[1] for r in c.execute('PRAGMA table_info(projects)')])
        self.assertEqual(c.execute("SELECT name FROM sqlite_master WHERE name LIKE 'db_%'").fetchall(),[])

    def test_unknown_future_schema_and_tampered_checksum_refused(self):
        self.c.execute("UPDATE db_schema_migrations SET checksum='wrong'");self.c.commit()
        with self.assertRaises(db.DatabaseError):
            with self.c:
                db.migrate(self.c,200)

    def test_cas_creates_versions_and_receipt_once(self):
        body=self.body();first=self.save(body);again=self.save(body)
        self.assertEqual(first['resource'],again['resource']);self.assertTrue(again['replayed_receipt'])
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM db_audit').fetchone()[0],1)
        self.assertEqual(db.get_operation(self.c,body['operation_id'],self.actor['id'])['resource'],first['resource'])
        stale=self.body()
        with self.assertRaisesRegex(db.DatabaseError,'版本冲突'):
            self.save(stale)
        self.assertIsNone(db.get_operation(self.c,stale['operation_id'],self.actor['id']))

    def test_same_operation_different_payload_or_principal_refused(self):
        body=self.body();self.save(body);changed=json.loads(json.dumps(body));changed['value']['rfWeakDbm']=-80
        for actor,request in [(self.actor,changed),({'id':'other'},body)]:
            with self.assertRaises(db.DatabaseError):
                with self.c:
                    db.put_resource(self.c,request,actor,1001)
        with self.assertRaises(db.DatabaseError):
            db.get_operation(self.c,body['operation_id'],'other')

    def test_invalid_units_secrets_boolean_and_missing_revision_write_nothing(self):
        attempts=[]
        for v in [-91,-29,None,True]:
            b=self.body();b['value']['rfWeakDbm']=v;attempts.append(b)
        b=self.body();b['value']['access_token']='must-not-persist';attempts.append(b)
        b=self.body();b.pop('expected_revision');attempts.append(b)
        b=self.body();b['expected_revision']=True;attempts.append(b)
        for b in attempts:
            with self.assertRaises(ValueError):
                self.save(b)
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM db_resource_versions').fetchone()[0],0)

    def test_transaction_failure_cannot_leave_projection_or_receipt(self):
        self.c.execute("CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON db_audit BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.save(self.body())
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM db_resources').fetchone()[0],0)
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM db_operations').fetchone()[0],0)
        # Projector table names are deliberately not guessed; all candidate biz
        # tables must roll back together even when the failure is after projection.
        for name in db.unified_domains.TABLES:
            self.assertEqual(self.c.execute('SELECT COUNT(*) FROM '+name).fetchone()[0],0,name)

    def scan(self,source='imported_csv'):
        return {'projectId':'default','name':'真实测试扫描','sourceKind':source,'frequencyUnit':'kHz','levelUnit':'dBm',
            'points':[{'frequencyKHz':640000,'levelDbm':-80.5},{'frequencyKHz':640250,'levelDbm':-75}],
            'original':{'name':'scan.csv','text':'frequency_MHz,level_dBm\n640.000,-80.5\n640.250,-75\n'}}

    def test_scan_original_points_and_source_are_exact_and_separate(self):
        value=self.scan();self.save(self.body('scans','scan-1',value))
        stored=self.c.execute('SELECT frequency_khz,level_dbm FROM db_scan_points ORDER BY ordinal').fetchall()
        self.assertEqual(stored,[(640000,-80.5),(640250,-75)])
        self.assertEqual(self.c.execute('SELECT content_utf8 FROM db_scan_originals').fetchone()[0],value['original']['text'].encode())
        self.save(self.body('scans','sim-1',self.scan('simulation')))
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM db_scans WHERE source_kind='imported_csv'").fetchone()[0],1)

    def test_bad_scan_never_enters_real_measurement_tables(self):
        for change in ['unit','duplicate','nan','hash']:
            value=self.scan()
            if change=='unit':value['frequencyUnit']='MHz'
            if change=='duplicate':value['points'][1]['frequencyKHz']=640000
            if change=='nan':value['points'][1]['levelDbm']=float('nan')
            if change=='hash':value['original']['sha256']='0'*64
            with self.assertRaises(db.DatabaseError):
                self.save(self.body('scans',change,value))
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM db_scan_points').fetchone()[0],0)

    def test_run_is_immutable_and_receipt_survives_later_resource_updates(self):
        value={'projectId':'default','input':{},'result':{},'engineVersion':'fixture','profileRefs':[]}
        b=self.body('planning_runs','run-1',value);self.save(b)
        with self.assertRaises(db.DatabaseError):
            self.save(self.body('planning_runs','run-1',value,1))
        first=self.body();receipt=self.save(first);next=self.body(revision=1);next['value']['rfWeakDbm']=-85;self.save(next)
        self.assertEqual(db.get_operation(self.c,first['operation_id'],self.actor['id'])['resource'],receipt['resource'])

    def test_keyset_list_pins_versions_while_another_writer_changes_values(self):
        for id in ['a','b','c']:
            self.save(self.body('scans',id,self.scan()))
        first=db.list_resources(self.c,'scans',1)
        v=self.scan();v['name']='new version';self.save(self.body('scans','b',v,1))
        self.save(self.body('scans','aa',self.scan()))
        second=db.list_resources(self.c,'scans',1,first['next_cursor'])
        self.assertEqual(second['resources'][0]['id'],'b');self.assertEqual(second['resources'][0]['revision'],1)
        third=db.list_resources(self.c,'scans',1,second['next_cursor']);self.assertEqual(third['resources'][0]['id'],'c')
        self.assertIsNone(third['next_cursor'])

    def test_restore_epoch_invalidates_old_pending_and_receipts_without_deleting_data(self):
        b=self.body();self.save(b)
        with self.c:
            new=db.rotate_recovery_epoch(self.c,self.meta['epoch'],uuid.uuid4().hex)
        self.assertNotEqual(new['epoch'],self.meta['epoch'])
        with self.assertRaises(db.DatabaseError):self.save(b)
        with self.assertRaises(db.DatabaseError):db.get_operation(self.c,b['operation_id'],self.actor['id'])
        self.assertEqual(db.get_resource(self.c,'settings','alert_thresholds')['revision'],1)

    def test_domain_deletion_has_null_version_and_normalized_tombstone(self):
        self.save(self.body('settings','alert_sound',{'enabled':True}))
        body=self.body('settings','alert_sound',{},1,deleted=True);body['value']=None
        self.save(body)
        resource=db.get_resource(self.c,'settings','alert_sound')
        self.assertEqual(resource['value'],None);self.assertTrue(resource['deleted'])
        self.assertEqual(self.c.execute("SELECT revision,deleted FROM biz_settings WHERE id='alert_sound'").fetchone(),(2,1))

    def batch(self,writes):
        return {'operation_id':uuid.uuid4().hex,'epoch':self.meta['epoch'],'writes':writes}

    def save_batch(self,body):
        with self.c:
            return db.put_batch(self.c,body,self.actor,1000)

    def test_batch_all_or_nothing_and_receipt_survives_later_writes(self):
        writes=[{'kind':'settings','id':id,'value':{'enabled':True},'expected_revision':0}
            for id in ['alert_sound','auto_frequency']]
        body=self.batch(writes);saved=self.save_batch(body)
        self.assertEqual([r['id'] for r in saved['resources']],['alert_sound','auto_frequency'])
        self.assertEqual(self.save_batch(body)['resources'],saved['resources'])
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM db_audit').fetchone()[0],2)
        self.save(self.body('settings','alert_sound',{'enabled':False},1))
        receipt=db.get_operation(self.c,body['operation_id'],self.actor['id'])
        self.assertTrue(receipt['resources'][0]['value']['enabled'])
        bad=self.batch([dict(writes[0],expected_revision=2,value={'enabled':False}),writes[1]])
        with self.assertRaises(db.DatabaseError):self.save_batch(bad)
        self.assertEqual(db.get_resource(self.c,'settings','alert_sound')['revision'],2)
        self.assertIsNone(db.get_operation(self.c,bad['operation_id'],self.actor['id']))

    def test_batch_duplicate_target_ids_cross_single_and_changed_body_rejected(self):
        item={'kind':'settings','id':'alert_sound','value':{'enabled':True},'expected_revision':0}
        with self.assertRaises(db.DatabaseError):self.save_batch(self.batch([item,item]))
        body=self.batch([item]);self.save_batch(body)
        other=self.body('settings','alert_sound',{'enabled':False},1);other['operation_id']=body['operation_id']
        with self.assertRaises(db.DatabaseError):self.save(other)
        changed=json.loads(json.dumps(body));changed['writes'][0]['value']['enabled']=False
        with self.assertRaises(db.DatabaseError):self.save_batch(changed)
        with self.assertRaises(db.DatabaseError):db.get_operation(self.c,body['operation_id'],'other')

    def test_project_history_current_and_tombstone_versions_share_transaction(self):
        def record(id):
            return {'id':id,'type':'daty_rf_planning','projectId':'default','timestamp':1,'channels':0,'devices':[]}
        records=[{'kind':'planning_records','id':id,'value':record(id),'expected_revision':0} for id in ['a','b']]
        current={'kind':'planning_current','id':'default','value':{'projectId':'default','currentRecordId':'b','deletedRecordIds':[]},'expected_revision':0}
        self.save_batch(self.batch([*records,current]))
        first=db.list_resources(self.c,'planning_records',1)
        changed={**current,'expected_revision':1,'value':{'projectId':'default','currentRecordId':'a','deletedRecordIds':['b']}}
        self.save_batch(self.batch([changed]))
        live=db.get_resource(self.c,'planning_records','b');self.assertTrue(live['deleted']);self.assertEqual(live['revision'],2)
        historic=db.list_resources(self.c,'planning_records',1,first['next_cursor'])['resources'][0]
        self.assertEqual(historic['id'],'b');self.assertFalse(historic['deleted']);self.assertEqual(historic['revision'],1)
        self.assertEqual(self.c.execute("SELECT revision,deleted FROM biz_planning_records WHERE id='b'").fetchone(),(2,1))

    def test_scan_project_foreign_key_and_run_reference_protect_history(self):
        scan=self.scan();scan['projectId']='missing'
        with self.assertRaises(sqlite3.IntegrityError):self.save(self.body('scans','missing-project',scan))
        self.save(self.body('scans','scan-1',self.scan()))
        self.save(self.body('planning_runs','run-1',{'projectId':'default','input':{},'result':{},'scanId':'scan-1'}))
        with self.assertRaisesRegex(db.DatabaseError,'引用'):self.save(self.body('scans','scan-1',self.scan(),1))
        self.assertEqual(self.c.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_new_project_can_be_created_in_same_transaction_as_scan(self):
        value=self.scan();value['projectId']='new-project'
        writes=[{'kind':'project_metadata','id':'new-project','expected_revision':0,'value':{'id':'new-project','name':'新项目','data':{'future':1}}},
            {'kind':'scans','id':'new-scan','expected_revision':0,'value':value}]
        self.save_batch(self.batch(writes))
        self.assertEqual(self.c.execute("SELECT project_id FROM db_scans WHERE id='new-scan'").fetchone()[0],'new-project')
        self.assertEqual(db.get_resource(self.c,'project_metadata','new-project')['value']['data'],{'future':1})

    def test_new_scan_and_current_pointer_are_atomic_and_keep_old_run_input(self):
        def scan_write(id):return {'kind':'scans','id':id,'value':self.scan(),'expected_revision':0}
        def pointer(id,revision=0):return {'kind':'scan_current','id':'default','value':{'projectId':'default','scanId':id},'expected_revision':revision}
        saved=self.save_batch(self.batch([scan_write('scan-1'),pointer('scan-1')]))
        self.save(self.body('planning_runs','run-1',{'projectId':'default','input':{},'result':{},'scanId':'scan-1'}))
        with self.assertRaises(db.DatabaseError):self.save_batch(self.batch([scan_write('scan-2'),pointer('scan-2')]))
        self.assertIsNone(db.get_resource(self.c,'scans','scan-2'))
        self.save_batch(self.batch([scan_write('scan-2'),pointer('scan-2',1)]))
        self.assertEqual(db.get_resource(self.c,'scan_current','default')['value']['scanId'],'scan-2')
        self.assertEqual(db.get_resource(self.c,'planning_runs','run-1')['value']['scanId'],'scan-1')
        self.assertEqual(saved['resources'][0]['value']['original'],self.scan()['original'])
        with self.assertRaises(db.DatabaseError):self.save(self.body('scans','scan-2',self.scan(),1))

    def test_current_scan_rejects_missing_cross_project_and_simulation_references(self):
        self.save(self.body('scans','simulation',self.scan('simulation')))
        value=self.scan();value['projectId']='other'
        self.save_batch(self.batch([
            {'kind':'project_metadata','id':'other','value':{'id':'other','name':'Other'},'expected_revision':0},
            {'kind':'scans','id':'other-scan','value':value,'expected_revision':0}]))
        for identifier in ['missing','simulation','other-scan']:
            with self.assertRaises(db.DatabaseError):self.save(self.body('scan_current','default',{'projectId':'default','scanId':identifier}))
        self.assertIsNone(db.get_resource(self.c,'scan_current','default'))
        self.assertEqual(self.c.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_scan_evidence_is_checked_atomically_not_only_by_preceding_client_get(self):
        self.save(self.body('scans','scan-1',self.scan()))
        run={'projectId':'default','input':{},'result':{'options':{'scanPoints':self.scan()['points']}},'scanId':'scan-1',
             'inputEvidence':{'protocol':'daty-planning-input-evidence-v1','scanUse':'used',
                 'scan':{'id':'scan-1','revision':1,'epoch':self.meta['epoch']}}}
        changed=self.scan();changed['name']='another writer';self.save(self.body('scans','scan-1',changed,1))
        body=self.batch([
            {'kind':'settings','id':'alert_sound','expected_revision':0,'value':{'enabled':True}},
            {'kind':'planning_runs','id':'run-1','expected_revision':0,'value':run}])
        with self.assertRaises(db.DatabaseError) as caught:self.save_batch(body)
        self.assertEqual(caught.exception.code,'SCAN_EVIDENCE_CONFLICT')
        self.assertIsNone(db.get_resource(self.c,'settings','alert_sound'))
        self.assertIsNone(db.get_operation(self.c,body['operation_id'],self.actor['id']))
        run['inputEvidence']['scan']['revision']=2
        run['result']['options']['scanPoints'][0]['levelDbm']=-20
        with self.assertRaises(db.DatabaseError):self.save(self.body('planning_runs','run-1',run))
        run['result']['options']['scanPoints']=changed['points']
        self.save(self.body('planning_runs','run-1',run))
        with self.c:db.rotate_recovery_epoch(self.c,self.meta['epoch'],uuid.uuid4().hex)
        from unified_consistency import verify_consistency
        self.assertEqual(verify_consistency(self.c)['status'],'verified')

    def test_manual_configuration_is_not_live_state_or_control_identity(self):
        value={'id':'manual-1','source':'manual','brand':'DATYaudio','model':'测试','configuredFrequencyKHz':641000}
        self.save(self.body('manual_devices','manual-1',value))
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM live_receivers').fetchone()[0],0)
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM live_channels').fetchone()[0],0)
        for field in ['_fasheId','_online','rf','muted','ack']:
            with self.assertRaises(db.DatabaseError):self.save(self.body('manual_devices','manual-1',{**value,field:True},1))

    def test_legacy_snapshot_preserves_source_but_is_immutable_and_cannot_be_online(self):
        value={'sourceOrigin':'https://localhost:8080','sourceKey':'daty_devices',
               'payload':[{'id':1,'_online':True,'freq':641000}]}
        self.save(self.body('legacy_snapshots','archive-1',value))
        self.assertEqual(db.get_resource(self.c,'legacy_snapshots','archive-1')['value'],value)
        with self.assertRaises(db.DatabaseError):self.save(self.body('legacy_snapshots','archive-1',value,1))
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM live_latest').fetchone()[0],0)

    def test_simulation_run_source_and_profile_reference_are_strict(self):
        self.save(self.body('scans','sim-1',self.scan('simulation')))
        value={'projectId':'default','input':{},'result':{},'scanId':'sim-1'}
        with self.assertRaisesRegex(db.DatabaseError,'仿真'):self.save(self.body('planning_runs','r1',value))
        self.save(self.body('planning_runs','r2',{**value,'purpose':'simulation-study'}))
        for refs in ['profile-1',[{'id':'missing','revision':1}],[{'id':'x','revision':True}]]:
            with self.assertRaises(db.DatabaseError):self.save(self.body('planning_runs','r3',{**value,'purpose':'simulation-study','profileRefs':refs}))

    def test_planning_profile_snapshot_is_immutable_and_exactly_referenced(self):
        from test_unified_domains import profile
        value=profile();value.update(id='run-profile:run-1:0',source='planning-snapshot',originalProfileId='test-daty')
        run={'projectId':'default','input':{},'result':{},'profileRefs':[{'id':value['id'],'revision':1}]}
        self.save_batch(self.batch([
            {'kind':'profiles','id':value['id'],'value':value,'expected_revision':0},
            {'kind':'planning_runs','id':'run-1','value':run,'expected_revision':0}]))
        changed={**value,'name':'changed'}
        with self.assertRaises(db.DatabaseError):self.save(self.body('profiles',value['id'],changed,1))
        deleted=self.body('profiles',value['id'],{},1,deleted=True);deleted['value']=None
        with self.assertRaises(db.DatabaseError):self.save(deleted)
        self.assertEqual(db.get_resource(self.c,'profiles',value['id'])['value'],value)
        reserved={**value,'id':'run-profile:other','source':'custom'}
        with self.assertRaises(db.DatabaseError):self.save(self.body('profiles',reserved['id'],reserved))

    def test_simulation_options_persist_only_in_scenario_domain(self):
        options={'peakWidthKHz':100,'floorDbm':-90,'rippleDb':2.5,'textureStepKHz':0.5,'thresholdDbm':-80,
                 'imdSuppressionDb':40,'includeImd':True,'includeFifth':False,'includeThreeTone':True}
        value={'projectId':'default','sourceKind':'simulation','options':options}
        self.save(self.body('simulation_settings','default',value))
        self.assertEqual(db.get_resource(self.c,'simulation_settings','default')['value'],value)
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM db_scan_points').fetchone()[0],0)
        for field,invalid in [('rippleDb',2.3),('floorDbm',-121),('includeImd',False),('includeFifth',1)]:
            with self.assertRaises(db.DatabaseError):self.save(self.body('simulation_settings','default',{**value,'options':{**options,field:invalid}},1))

    def test_internal_batch_child_ids_cannot_be_preclaimed_by_http_operations(self):
        body=self.body();body['operation_id']='batch_'+'a'*64
        with self.assertRaises(db.DatabaseError):self.save(body)
        request=self.batch([{'kind':'settings','id':'alert_sound','value':{'enabled':False},'expected_revision':0}])
        request['operation_id']=body['operation_id']
        with self.assertRaises(db.DatabaseError):self.save_batch(request)
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM db_operations').fetchone()[0],0)


if __name__=='__main__':unittest.main()
