"""Real SQLite planning configuration: raw drafts, CAS, durability and bounds."""
import copy,json,sqlite3,tempfile,unittest,uuid
from contextlib import closing
from pathlib import Path
from test_unified_database import legacy_connection
from unified_domains import DomainError
import unified_database as db
from planning_settings import IMD_PRODUCTS

def document():
    return dict(schema='daty-planning-settings-v1',fields=dict(
        plannerRange='custom',plannerRangeStart='630.',plannerRangeEnd='690.000',
        plannerCompatibility='robust',plannerExcludedRanges='638.000-639.000 摄像机\n',
        plannerKnownCarriers='650.000,250,在用',plannerBackupCount='0',plannerStepKHz='25',
        plannerMinSpacingKHz='',plannerImdSpacingKHz='350',plannerScanThresholdDbm='-',plannerImdPolicy='third-fifth'),
        locks=[dict(deviceId='shure:stable-mac:ch1',frequencyKHz=640000,note='主唱')],
        editor=dict(tab='constraints',selectedDeviceId='shure:stable-mac:ch1',lockNote='待确认草稿'))

class PlanningSettingsTests(unittest.TestCase):
    def setUp(self):
        self.c=legacy_connection();self.addCleanup(self.c.close)
        with self.c:self.meta=db.migrate(self.c,100)
        self.actor=dict(id='planner-fixture',role='operator',name='Planner test')
    def save(self,value,revision=0):
        with self.c:return db.put_resource(self.c,dict(operation_id=uuid.uuid4().hex,epoch=self.meta['epoch'],kind='settings',id='frequency_planning',expected_revision=revision,value=value),self.actor,101)
    def test_full_configuration_and_incomplete_draft_survive_reopen(self):
        receipt=self.save(document())
        with tempfile.TemporaryDirectory(prefix='daty-planner-') as directory:
            path=Path(directory)/'fixture.sqlite3'
            with closing(sqlite3.connect(path)) as target:self.c.backup(target)
            with closing(sqlite3.connect(path)) as reopened:
                self.assertEqual(db.get_resource(reopened,'settings','frequency_planning'),receipt['resource'])
                row=reopened.execute("SELECT setting_type,metadata_json FROM biz_settings WHERE id='frequency_planning'").fetchone()
                self.assertEqual(row[0],'frequency_planning');self.assertEqual(json.loads(row[1]),document())
    def test_invalid_shape_and_lock_never_change_saved_revision(self):
        self.save(document())
        cases=[]
        for key,val in [('plannerRange','unknown'),('plannerCompatibility','fake'),('plannerImdPolicy','none'),('plannerBackupCount',0),('plannerRangeStart','x'*65),('plannerExcludedRanges','x'*16385)]:
            bad=document();bad['fields'][key]=val;cases.append(bad)
        for key,val in [('deviceId',''),('frequencyKHz',640.0),('frequencyKHz',True),('note','x'*81)]:
            bad=document();bad['locks'][0][key]=val;cases.append(bad)
        bad=document();bad['locks']*=2;cases.append(bad)
        for key,val in [('scanPoints',[]),('planningHistory',[]),('session',{})]:
            bad=document();bad[key]=val;cases.append(bad)
        bad=document();bad['editor']['lockNote']='a\x00b';cases.append(bad)
        bad=document();del bad['fields']['plannerStepKHz'];cases.append(bad)
        for bad in cases:
            with self.subTest(bad=bad),self.assertRaises(DomainError):self.save(bad,1)
        self.assertEqual(db.get_resource(self.c,'settings','frequency_planning')['revision'],1)
    def test_size_and_lock_count_bounded_before_commit(self):
        for count in (1024,1025):
            bad=document();bad['locks']=[dict(deviceId='x'*490+str(i),frequencyKHz=640000,note='主唱'*40) for i in range(count)]
            with self.assertRaises(DomainError):self.save(bad)
        self.assertIsNone(db.get_resource(self.c,'settings','frequency_planning'))
    def test_stale_revision_does_not_overwrite_newer_editor(self):
        self.save(document());new=document();new['fields']['plannerBackupCount']='4';self.save(new,1)
        with self.assertRaises(db.DatabaseError):self.save(document(),1)
        self.assertEqual(db.get_resource(self.c,'settings','frequency_planning')['value'],new)

    def test_every_product_subset_round_trips_and_legacy_is_not_rewritten(self):
        legacy=document();self.save(legacy)
        before=self.c.total_changes
        for _ in range(3):
            self.assertEqual(db.get_resource(self.c,'settings','frequency_planning')['value'],legacy)
        self.assertEqual(self.c.total_changes,before)
        for mask in range(1 << len(IMD_PRODUCTS)):
            selected=[product for bit,product in enumerate(IMD_PRODUCTS) if mask & (1 << bit)]
            value=copy.deepcopy(legacy);value['fields']['plannerImdProducts']=','.join(selected)
            result=self.save(value,mask+1)['resource']
            self.assertEqual(result['revision'],mask+2)
            self.assertEqual(db.get_resource(self.c,'settings','frequency_planning'),result)
            # The prior compatibility and policy are retained for legacy history,
            # while the explicit product field (even empty) is authoritative.
            self.assertEqual(result['value']['fields']['plannerCompatibility'],'robust')
            self.assertEqual(result['value']['fields']['plannerImdPolicy'],'third-fifth')
        with tempfile.TemporaryDirectory(prefix='daty-planning-products-') as directory:
            path=Path(directory)/'fixture.sqlite3'
            with closing(sqlite3.connect(path)) as target:self.c.backup(target)
            with closing(sqlite3.connect(path)) as reopened:
                self.assertEqual(db.get_resource(reopened,'settings','frequency_planning'),result)

    def test_bad_product_selections_never_change_saved_configuration(self):
        value=document();value['fields']['plannerImdProducts']='2T7O,2T9O,3T3O'
        original=self.save(value)['resource']
        for invalid in (None,[],['2T3O'],0,'2T30','3T9O','2t3o',' 2T3O','2T3O,',
                        '2T3O,2T3O','3T3O,2T3O','2T3O, 3T3O','2T3O\n'):
            bad=copy.deepcopy(value);bad['fields']['plannerImdProducts']=invalid
            with self.subTest(invalid=invalid),self.assertRaises(DomainError):self.save(bad,1)
            self.assertEqual(db.get_resource(self.c,'settings','frequency_planning'),original)

if __name__=='__main__':unittest.main()
