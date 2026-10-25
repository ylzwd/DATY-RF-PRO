"""System settings are typed, durable database resources; fixtures only."""
import copy,json,sqlite3,tempfile,unittest,uuid
from contextlib import closing
from unified_domains import DomainError
from pathlib import Path
from test_unified_database import legacy_connection
import unified_database as db

NETWORK=dict(localIp='192.0.2.7/24',heartbeatSeconds=15,reconnectStrategy='manual',shureExclusive=False,pcom1Enabled=True)
class SystemSettingsTests(unittest.TestCase):
 def setUp(self):
  self.c=legacy_connection();self.addCleanup(self.c.close)
  with self.c:self.meta=db.migrate(self.c,100)
  self.actor={'id':'settings-fixture','role':'operator','name':'Settings test'}
 def save(self,value,revision=0):
  with self.c:return db.put_resource(self.c,dict(operation_id=uuid.uuid4().hex,epoch=self.meta['epoch'],kind='settings',id='network_connection',expected_revision=revision,value=value),self.actor,101)
 def test_network_all_fields_survive_database_reopen(self):
  receipt=self.save(NETWORK)
  with tempfile.TemporaryDirectory(prefix='daty-settings-') as directory:
   file=Path(directory)/'fixture.sqlite3'
   with closing(sqlite3.connect(file)) as target:self.c.backup(target)
   with closing(sqlite3.connect(file)) as reopened:
    self.assertEqual(db.get_resource(reopened,'settings','network_connection'),receipt['resource'])
    row=reopened.execute("SELECT metadata_json FROM biz_settings WHERE id='network_connection'").fetchone()
    self.assertEqual(json.loads(row[0]),NETWORK)
 def test_invalid_network_values_do_not_advance_revision(self):
  self.save(NETWORK)
  for field,value in [('localIp','not an ip'),('localIp','192.0.2.7/99'),('heartbeatSeconds',True),('heartbeatSeconds',20),('reconnectStrategy','unknown'),('shureExclusive',1),('pcom1Enabled','false')]:
   bad=copy.deepcopy(NETWORK);bad[field]=value
   with self.subTest(field=field,value=value),self.assertRaises(DomainError):self.save(bad,1)
  record=db.get_resource(self.c,'settings','network_connection');self.assertEqual(record['revision'],1);self.assertEqual(record['value'],NETWORK)
 def test_stale_network_revision_cannot_replace_a_concurrent_edit(self):
  self.save(NETWORK);new={**NETWORK,'heartbeatSeconds':60};self.save(new,1)
  with self.assertRaises(db.DatabaseError):self.save({**NETWORK,'localIp':''},1)
  self.assertEqual(db.get_resource(self.c,'settings','network_connection')['value'],new)
if __name__=='__main__':unittest.main()
