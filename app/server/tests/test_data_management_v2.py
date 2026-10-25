"""Disposable SQLite fixtures only. No production files, telemetry or services."""
import hashlib
import sqlite3
import unittest
import uuid
import unified_database as db
from unified_schema import validate_schema, SchemaError
from test_unified_database import legacy_connection


class DataManagementV2Tests(unittest.TestCase):
    def old_database(self):
        c=legacy_connection();self.addCleanup(c.close)
        with c:
            c.execute('ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
            for sql in db.schema_statements(1):c.execute(sql)
            c.execute("INSERT INTO db_identity VALUES(1,'kept-instance','kept-epoch',1)")
            c.execute('INSERT INTO db_schema_migrations VALUES(1,?,1)',(db.migration_checksums(1)[0][1],))
            c.execute('PRAGMA user_version=1')
        return c

    def save(self,c,kind,id,value,deleted=False):
        head=db.get_resource(c,kind,id)
        with c:
            return db.put_resource(c,dict(operation_id=uuid.uuid4().hex,epoch=db.status(c)['epoch'],kind=kind,id=id,
                value=value,deleted=deleted,expected_revision=head['revision'] if head else 0),{'id':'fixture'},100)

    def test_upgrade_keeps_identity_all_rows_and_prior_receipt(self):
        c=self.old_database()
        saved=self.save(c,'settings','alert_sound',{'enabled':True})
        before={t:c.execute('SELECT * FROM '+t+' ORDER BY 1').fetchall() for t in db.supported_tables(1)}
        with c:db.migrate(c,200)
        self.assertEqual(validate_schema(c)['schema_version'],3)
        for table,rows in before.items():
            if table!='db_schema_migrations':self.assertEqual(c.execute('SELECT * FROM '+table+' ORDER BY 1').fetchall(),rows,table)
        self.assertEqual(db.get_operation(c,saved['operation_id'],'fixture')['resource'],saved['resource'])
        self.assertEqual(db.status(c)['epoch'],'kept-epoch')
        self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_failed_index_upgrade_rolls_back_to_exact_v1(self):
        c=self.old_database();before=validate_schema(c)
        def deny(action,name,*_):
            return sqlite3.SQLITE_DENY if action==sqlite3.SQLITE_CREATE_INDEX and name=='idx_db_versions_project' else sqlite3.SQLITE_OK
        c.set_authorizer(deny)
        with self.assertRaises(sqlite3.DatabaseError):
            with c:db.migrate(c,200)
        c.set_authorizer(None)
        self.assertEqual(validate_schema(c),before)

    def test_offline_index_rollback_keeps_new_writes_and_exact_old_schema(self):
        c=self.old_database();old_schema=validate_schema(c)['schema_sha256']
        # Exercise the historical v2-only tool on its supported schema.
        with c:
            for sql in db.INDEX_V2_DDL:c.execute(sql)
            c.execute('INSERT INTO db_schema_migrations VALUES(?,?,?)',(*db.migration_checksums(2)[1],200))
            c.execute('PRAGMA user_version=2')
        receipt=self.save(c,'settings','alert_sound',{'enabled':False})
        with self.assertRaises(db.DatabaseError):
            with c:db.rollback_index_migration(c,'wrong')
        self.assertEqual(db.status(c)['schema_version'],2)
        with c:db.rollback_index_migration(c,'kept-epoch')
        self.assertEqual(validate_schema(c)['schema_sha256'],old_schema)
        self.assertEqual(db.get_operation(c,receipt['operation_id'],'fixture')['resource'],receipt['resource'])
        self.assertFalse(db.get_resource(c,'settings','alert_sound')['value']['enabled'])
        with c:db.migrate(c,300)
        self.assertEqual(db.status(c)['schema_version'],3)

    def test_extra_index_and_forged_migration_still_fail_closed(self):
        c=self.old_database()
        with c:db.migrate(c,200)
        c.execute('CREATE INDEX unexpected ON db_resources(id)')
        with self.assertRaises(SchemaError):validate_schema(c)
        c.execute('DROP INDEX unexpected');c.execute('DELETE FROM db_schema_migrations WHERE version=1')
        with self.assertRaises(SchemaError):validate_schema(c)

    def test_delta_pagination_tombstones_unchanged_rows_and_epoch(self):
        c=self.old_database()
        with c:db.migrate(c,200)
        for id in ('alert_sound','auto_frequency'):self.save(c,'settings',id,{'enabled':True})
        old=db.list_resources(c,'settings')['as_of']
        options={'since':old,'since_epoch':db.status(c)['epoch']}
        self.assertEqual(db.list_resources(c,'settings',**options)['resources'],[])
        self.save(c,'settings','alert_sound',None,True)
        self.save(c,'settings','auto_frequency',{'enabled':False})
        first=db.list_resources(c,'settings',1,**options)
        self.assertTrue(first['resources'][0]['deleted'])
        self.save(c,'settings','auto_frequency',{'enabled':True})
        second=db.list_resources(c,'settings',1,first['next_cursor'],**options)
        self.assertFalse(second['resources'][0]['value']['enabled'])
        self.assertEqual(first['as_of'],second['as_of'])
        with self.assertRaises(db.DatabaseError):db.list_resources(c,'settings',1,first['next_cursor'])
        with self.assertRaises(db.DatabaseError):db.list_resources(c,'settings',since=old,since_epoch='different')
        for bad in (True,-1,1.2,10**30):
            with self.assertRaises(db.DatabaseError):db.list_resources(c,'settings',since=bad,since_epoch=options['since_epoch'])

    def test_project_snapshot_and_tombstone_keep_original_attribution(self):
        c=self.old_database()
        with c:db.migrate(c,200)
        self.save(c,'project_metadata','other',{'id':'other','name':'Other','data':{}})
        for id,project in [('a','default'),('b','default'),('aa','other')]:
            self.save(c,'planning_records',id,{'id':id,'type':'daty_rf_planning','projectId':project,'timestamp':1,'channels':0,'devices':[]})
        first=db.list_resources(c,'planning_records',1,project_id='default')
        self.save(c,'planning_current','default',{'projectId':'default','currentRecordId':'a','deletedRecordIds':['b']})
        second=db.list_resources(c,'planning_records',1,first['next_cursor'],project_id='default')
        self.assertEqual(second['resources'][0]['id'],'b');self.assertFalse(second['resources'][0]['deleted'])
        current=db.list_resources(c,'planning_records',project_id='default')['resources']
        self.assertEqual([r['id'] for r in current],['a','b']);self.assertTrue(current[1]['deleted'])
        self.assertEqual([r['id'] for r in db.list_resources(c,'planning_records',project_id='other')['resources']],['aa'])
        with self.assertRaises(db.DatabaseError):db.list_resources(c,'planning_records',1,first['next_cursor'],project_id='other')


if __name__=='__main__':unittest.main()
