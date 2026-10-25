import json,sqlite3,sys,unittest,uuid
from unittest.mock import patch
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import unified_database as db
from unified_activity import list_activity,get_activity,RETENTION_SOURCE,RETENTION_ACTOR
from test_unified_database import legacy_connection

class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.c=legacy_connection();self.addCleanup(self.c.close)
        with self.c:db.migrate(self.c,1)
    def save(self,kind,id,value,deleted=False):
        old=db.get_resource(self.c,kind,id)
        with self.c:return db.put_resource(self.c,dict(kind=kind,id=id,value=value,deleted=deleted,expected_revision=old['revision'] if old else 0,epoch=db.status(self.c)['epoch'],operation_id=uuid.uuid4().hex),{'id':'network:127.0.0.1','ip':'127.0.0.1'},1000)
    def event(self,type='command.published',ts=100):
        with self.c:return self.c.execute('INSERT INTO timeline_events(project_id,ts,event_type,device_id,command_id,summary,details_json) VALUES(?,?,?,?,?,?,?)',('default',ts,type,'receiver_ch1','cmd','执行阶段',json.dumps({'expected':0,'actual':None,'unit':'kHz'}))).lastrowid
    def test_commits_are_historical_not_current_heads(self):
        self.save('settings','alert_sound',{'enabled':True});self.save('settings','alert_sound',{'enabled':False})
        page=list_activity(self.c,'operations');self.assertEqual([i['revision'] for i in page['items']],[2,1])
        record=get_activity(self.c,'operations',page['items'][0]['id'])['record']
        self.assertEqual(record['before']['fields']['enabled'],1);self.assertEqual(record['after']['fields']['enabled'],0)
        self.assertEqual(page['items'][0]['outcome'],'committed')
    def test_default_hides_preferences_but_explicit_category_keeps_them(self):
        self.save('preferences','view:fixture',{'historyPage':2});self.save('settings','alert_sound',{'enabled':True})
        self.assertEqual([r['kind'] for r in list_activity(self.c,'operations')['items']],['settings'])
        self.assertEqual(list_activity(self.c,'operations',category='preferences')['items'][0]['kind'],'preferences')
    def test_deletion_retains_before_state_and_receipt(self):
        self.save('settings','alert_sound',{'enabled':True});self.save('settings','alert_sound',None,True)
        row=list_activity(self.c,'operations')['items'][0];self.assertEqual(row['outcome'],'deleted')
        record=get_activity(self.c,'operations',row['id'])['record'];self.assertTrue(record['after']['deleted']);self.assertEqual(record['before']['fields']['enabled'],1)
    def test_more_than_200_same_timestamp_events_page_without_gaps(self):
        for _ in range(231):self.event()
        first=list_activity(self.c,'timeline',category='commands');self.event(ts=999)
        ids=[i['id'] for i in first['items']];cursor=first['next_cursor']
        while cursor:
            page=list_activity(self.c,'timeline',category='commands',cursor=cursor);ids.extend(i['id'] for i in page['items']);cursor=page['next_cursor']
        self.assertEqual(ids,list(range(231,0,-1)))
    def test_timestamp_order_and_command_stage_not_collapsed(self):
        ids=[self.event(s,t) for s,t in [('command.accepted',101),('command.published',100),('command.unknown',102),('command.reviewed',103)]]
        page=list_activity(self.c,'timeline',category='commands');self.assertEqual([i['id'] for i in page['items']],[ids[3],ids[2],ids[0],ids[1]])
        self.assertEqual([i['outcome'] for i in page['items']],['reviewed','unknown','accepted','published'])
    def test_cursor_filters_epoch_and_bad_limits_rejected(self):
        for _ in range(3):self.event()
        cursor=list_activity(self.c,'timeline',limit=1)['next_cursor']
        for change in [{'category':'commands'},{'source':'live'},{'target':'other'},{'from_ms':1}]:
            with self.assertRaises(db.DatabaseError):list_activity(self.c,**{'source':'timeline','cursor':cursor,**change})
        for limit in [0,51,True,'20']:
            with self.assertRaises(db.DatabaseError):list_activity(self.c,'timeline',limit=limit)
        for bad in [None,[],"x';DROP TABLE projects"]:
            with self.assertRaises(db.DatabaseError):list_activity(self.c,bad)
        with self.c:self.c.execute("UPDATE db_identity SET epoch='changed'")
        with self.assertRaises(db.DatabaseError):list_activity(self.c,'timeline',cursor=cursor)
    def test_filters_and_observations_never_claim_command_execution(self):
        self.event('command.acknowledged',100);self.event('device.discovered',101)
        self.assertEqual(len(list_activity(self.c,'timeline',category='commands',from_ms=100000,to_ms=100000)['items']),1)
        self.assertEqual(list_activity(self.c,'timeline',target='absent')['items'],[])
        with self.c:self.c.execute("INSERT INTO live_events(event_key,event_type,device_id,receiver_id,boot_id,observed_at_ms,details_json) VALUES('x','channel.changed','rx_ch1','rx','boot',1,'{}')")
        self.assertEqual(list_activity(self.c,'live')['items'][0]['outcome'],'observed')
    def test_list_cannot_read_scan_payloads_or_telemetry_or_details(self):
        self.save('settings','alert_sound',{'enabled':True});self.event()
        self.c.execute('PRAGMA query_only=ON')
        def authorizer(action,table,col,*_):
            if action==sqlite3.SQLITE_READ and (table in {'live_samples','telemetry_samples','db_scan_points','db_scan_originals'} or col in {'value_json','details_json','metadata_json'} or col=='payload_json' and table!='db_legacy_snapshots'):return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        self.c.set_authorizer(authorizer)
        for source in ['operations','timeline','live']:list_activity(self.c,source)
        self.c.set_authorizer(None)
    def test_detail_unknown_source_or_id_does_not_leak_internal_receipts(self):
        with self.assertRaises(db.DatabaseError):get_activity(self.c,'operations',9876)
        with self.assertRaises(db.DatabaseError):get_activity(self.c,[],1)

    def test_expensive_filter_is_interrupted_without_losing_records(self):
        for _ in range(300):self.event()
        with patch('unified_activity.time.monotonic',side_effect=[0]+[3]*20):
            with self.assertRaises(db.DatabaseError) as caught:list_activity(self.c,'timeline',target='absent')
        self.assertEqual(caught.exception.code,'ACTIVITY_QUERY_TIMEOUT')
        self.assertEqual(self.c.execute('SELECT count(*) FROM timeline_events').fetchone()[0],300)
        self.assertEqual(len(list_activity(self.c,'timeline')['items']),20)

    def boundary(self,through,actor=RETENTION_ACTOR,epoch=None):
        oid=uuid.uuid4().hex;current=db.status(self.c)['epoch']
        with self.c:db.put_resource(self.c,{'kind':'legacy_snapshots','id':'audit-clear-'+oid,'expected_revision':0,
            'operation_id':oid,'epoch':current,'value':{'sourceOrigin':RETENTION_SOURCE,'sourceKey':'operation-audit',
            'payload':{'protocol':RETENTION_SOURCE,'epoch':epoch or current,'clearedThrough':through,'clearedAtMs':2000,'recordCount':2}}},{'id':actor},2000)

    def test_clear_covers_all_categories_preserves_versions_and_new_records(self):
        self.save('settings','alert_sound',{'enabled':True});self.save('preferences','view:fixture',{'historyPage':2})
        old=list_activity(self.c,'operations')['items'][0];through=self.c.execute('SELECT max(seq) FROM db_audit').fetchone()[0]
        self.event();self.boundary(through)
        for category in ['all','settings','preferences']:self.assertEqual(list_activity(self.c,'operations',category=category)['items'],[])
        with self.assertRaises(db.DatabaseError):get_activity(self.c,'operations',old['id'])
        self.assertEqual(len(list_activity(self.c,'timeline')['items']),1)
        self.assertTrue(db.get_resource(self.c,'settings','alert_sound')['value']['enabled'])
        self.save('settings','alert_sound',{'enabled':False});page=list_activity(self.c,'operations')
        self.assertEqual([r['revision'] for r in page['items']],[2]);self.assertEqual(page['cleared_through'],through)
        self.assertEqual(get_activity(self.c,'operations',page['items'][0]['id'])['record']['before']['fields']['enabled'],1)

    def test_clear_invalidates_old_cursor_and_restore_only_changes_visibility(self):
        self.save('settings','alert_sound',{'enabled':True});self.save('settings','alert_sound',{'enabled':False})
        page=list_activity(self.c,'operations',limit=1);self.boundary(page['as_of'])
        with self.assertRaises(db.DatabaseError):list_activity(self.c,'operations',limit=1,cursor=page['next_cursor'])
        self.boundary(0);self.assertEqual(len(list_activity(self.c,'operations')['items']),2)

    def test_network_peer_cannot_hide_audit_or_replace_maintenance_boundary(self):
        self.save('settings','alert_sound',{'enabled':True});self.boundary(999999,actor='network:127.0.0.1')
        self.assertEqual(len(list_activity(self.c,'operations')['items']),1)
        self.boundary(0,epoch='wrong')
        with self.assertRaises(db.DatabaseError):list_activity(self.c,'operations')

if __name__=='__main__':unittest.main(verbosity=2)
