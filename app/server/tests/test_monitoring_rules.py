import copy,json,sqlite3,tempfile,unittest,uuid
from pathlib import Path
from contextlib import closing
from test_unified_database import legacy_connection
import unified_database as db
from unified_domains import DomainError
from monitoring_rules import SEED,LEGACY_SEED,DOCUMENT_ID,ensure,validate
from unittest.mock import patch

class MonitoringRulesTests(unittest.TestCase):
    def setUp(self):
        self.c=legacy_connection();self.addCleanup(self.c.close)
        with self.c:self.meta=db.migrate(self.c,100)
    def save(self,value,revision=1,**extra):
        with self.c:return db.put_resource(self.c,dict(operation_id=uuid.uuid4().hex,epoch=self.meta['epoch'],kind='settings',id=DOCUMENT_ID,expected_revision=revision,value=value,**extra),{'id':'rule-test'},102)
    def test_seed_commit_and_no_overwrite(self):
        with self.c:first=ensure(self.c,101)
        self.assertEqual(first['value'],SEED)
        value=copy.deepcopy(SEED);value['transmitter']['offlineBelowDbm']=-100;value['identity']['pageSize']=12
        saved=self.save(value)['resource']
        with self.c:self.assertEqual(ensure(self.c,103),saved)
        self.assertEqual(json.loads(self.c.execute('SELECT metadata_json FROM biz_settings WHERE id=?',(DOCUMENT_ID,)).fetchone()[0]),value)
    def legacy(self):
        value=copy.deepcopy(LEGACY_SEED);value['transmitter']['offlineBelowDbm']=-100;value['identity']['groupPrefix']='CUSTOM'
        with patch('monitoring_rules.validate',side_effect=lambda value,fail:validate(value,fail,_template=LEGACY_SEED)):
            return self.save(value,revision=0)['resource']
    def test_v1_upgrade_preserves_values_is_atomic_and_runs_once(self):
        original=self.legacy()
        try:
            with self.c:ensure(self.c,103);raise RuntimeError('rollback')
        except RuntimeError:pass
        self.assertEqual(db.get_resource(self.c,'settings',DOCUMENT_ID),original)
        with self.c:upgraded=ensure(self.c,104)
        self.assertEqual(upgraded['revision'],original['revision']+1)
        expected=copy.deepcopy(original['value']);expected['schema']=SEED['schema']
        expected['transmitter']['offlineEvidence']=SEED['transmitter']['offlineEvidence']
        expected['transmitter']['recovery']=SEED['transmitter']['recovery']
        expected['alerts']['offlineSuppressedMetrics']=SEED['alerts']['offlineSuppressedMetrics']
        self.assertEqual(upgraded['value'],expected)
        with self.c:self.assertEqual(ensure(self.c,105),upgraded)
        with self.assertRaises((db.DatabaseError,DomainError)):self.save(original['value'],revision=upgraded['revision'])
    def test_rollback_does_not_leave_partial_seed(self):
        try:
            with self.c:ensure(self.c,101);raise RuntimeError('power-loss fixture')
        except RuntimeError:pass
        self.assertIsNone(db.get_resource(self.c,'settings',DOCUMENT_ID))
        with self.c:self.assertEqual(ensure(self.c,102)['revision'],1)
    def test_sqlite_reopen_retains_actual_rules(self):
        with self.c:ensure(self.c,101)
        value=copy.deepcopy(SEED);value['identity']['groupPrefix']='TEST';value['signals']['rfDecimals']=2
        saved=self.save(value)['resource']
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'test.sqlite3'
            with closing(sqlite3.connect(path)) as target:self.c.backup(target)
            with closing(sqlite3.connect(path)) as target:self.assertEqual(db.get_resource(target,'settings',DOCUMENT_ID),saved)
    def test_all_categories_validate_atomically(self):
        with self.c:original=ensure(self.c,101)
        edits=[('identity','pageSize',0),('identity','pageSize',1.5),('transmitter','offlineBelowDbm',True),('transmitter','offlineBelowDbm',-151),('transmitter','comparison','eval'),('transmitter','requireFresh',False),('signals','rfMinDbm',0),('signals','rfDecimals',4),('signals','hideRfWhenOffline',False),('signals','batteryBarsText','{eval}'),('overview','receiverCount','all'),('alerts','history','write'),('alerts','offlineSuppressedMetrics',[]),('transmitter','offlineEvidence','power-switch'),('frequency','usageSource','javascript')]
        for category,key,value in edits:
            with self.subTest(category=category,key=key):
                bad=copy.deepcopy(SEED);bad[category][key]=value
                with self.assertRaises((db.DatabaseError,DomainError)):self.save(bad)
                self.assertEqual(db.get_resource(self.c,'settings',DOCUMENT_ID),original)
        bad=copy.deepcopy(SEED);bad['identity']['injected']='code'
        with self.assertRaises((db.DatabaseError,DomainError)):self.save(bad)
    def test_cas_and_deleted_records_not_silently_reseeded(self):
        with self.c:ensure(self.c,101)
        with self.assertRaises(db.DatabaseError):self.save(copy.deepcopy(SEED),revision=0)
        saved=self.save(None,deleted=True)['resource']
        with self.c:self.assertEqual(ensure(self.c,104),saved)

if __name__=='__main__':unittest.main()
