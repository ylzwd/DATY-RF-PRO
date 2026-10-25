"""Disposable fixtures; prove catalogs cannot read telemetry or full payloads."""
import base64,json,sqlite3,sys,unittest,uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import unified_database as db
from unified_catalog import list_catalog,DOMAINS
from test_unified_database import legacy_connection

class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.c=legacy_connection();self.addCleanup(self.c.close)
        with self.c:db.migrate(self.c,100)
    def save(self,kind,id,value,deleted=False):
        old=db.get_resource(self.c,kind,id)
        with self.c:return db.put_resource(self.c,{'kind':kind,'id':id,'value':value,'deleted':deleted,'expected_revision':old['revision'] if old else 0,'epoch':db.status(self.c)['epoch'],'operation_id':uuid.uuid4().hex},{'id':'fixture'},200)
    def scan(self,name='scan',project='default'):
        return {'projectId':project,'name':name,'sourceKind':'imported_csv','frequencyUnit':'kHz','levelUnit':'dBm','points':[{'frequencyKHz':640000,'levelDbm':-80},{'frequencyKHz':641000,'levelDbm':-85}], 'original':{'name':'original.csv','text':'Frequency (MHz),Level (dBm)\n640,-80\n641,-85\n'}}
    def test_all_supported_projections_empty(self):
        for kind,(_,_,project,_) in DOMAINS.items():
            result=list_catalog(self.c,kind,**({'project_id':'default'} if project else {}))
            self.assertEqual(result['items'],[],kind)
    def test_catalog_never_reads_payload_original_points_or_telemetry(self):
        receipt=self.save('scans','scan',self.scan())
        denied=[]
        def authorize(action,table,column,*_):
            if action==sqlite3.SQLITE_READ and (table in {'live_samples','telemetry_samples','db_scan_points','db_scan_originals'} or column in {'value_json','metadata_json','input_json','result_json'}):
                denied.append((table,column));return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        self.c.set_authorizer(authorize)
        item=list_catalog(self.c,'scans',project_id='default')['items'][0]
        self.c.set_authorizer(None)
        self.assertEqual(denied,[]);self.assertEqual(item['summary']['point_count'],2)
        self.assertEqual(item['revision'],receipt['resource']['revision']);self.assertNotIn('value',item)
    def test_project_isolation_and_no_implicit_cross_project_list(self):
        self.save('project_metadata','other',{'id':'other','name':'Other','data':{}})
        self.save('scans','a',self.scan());self.save('scans','b',self.scan(project='other'))
        self.assertEqual([i['id'] for i in list_catalog(self.c,'scans',project_id='default')['items']],['a'])
        self.assertEqual([i['id'] for i in list_catalog(self.c,'scans',project_id='other')['items']],['b'])
        with self.assertRaises(db.DatabaseError):list_catalog(self.c,'scans')
        with self.assertRaises(db.DatabaseError):list_catalog(self.c,'settings',project_id='default')
    def test_bounded_pages_invalidated_only_by_same_domain_change(self):
        for id in ['a','b','c']:self.save('scans',id,self.scan(id))
        a=list_catalog(self.c,'scans',limit=1,project_id='default');cursor=a['next_cursor']
        self.save('settings','alert_sound',{'enabled':True})
        b=list_catalog(self.c,'scans',limit=1,cursor=cursor,project_id='default')
        self.assertEqual(b['items'][0]['id'],'b');self.assertEqual(a['as_of'],b['as_of'])
        self.save('scans','d',self.scan('new'))
        with self.assertRaises(db.DatabaseError) as error:list_catalog(self.c,'scans',limit=1,cursor=cursor,project_id='default')
        self.assertEqual(error.exception.code,'CATALOG_CHANGED')
    def test_tombstone_excluded_and_historical_receipt_preserved(self):
        first=self.save('settings','alert_sound',{'enabled':True})
        self.save('settings','alert_sound',None,True)
        self.assertEqual(list_catalog(self.c,'settings')['items'],[])
        self.assertTrue(db.get_operation(self.c,first['operation_id'],'fixture')['resource']['value']['enabled'])
    def test_validation_and_readonly_database(self):
        self.save('settings','alert_sound',{'enabled':True});before=self.c.total_changes
        self.c.execute('PRAGMA query_only=ON');list_catalog(self.c,'settings')
        self.assertEqual(before,self.c.total_changes)
        for limit in [0,51,True,'20',1.5]:
            with self.assertRaises(db.DatabaseError):list_catalog(self.c,'settings',limit=limit)
        for cursor in ['!',123,base64.b64encode(b'[]').decode(),'x'*4097]:
            with self.assertRaises(db.DatabaseError):list_catalog(self.c,'settings',cursor=cursor)
        for kind in ['live_samples','alerts',"scans';DROP TABLE projects",None,[]]:
            with self.assertRaises(db.DatabaseError):list_catalog(self.c,kind)

if __name__=='__main__':unittest.main(verbosity=2)
