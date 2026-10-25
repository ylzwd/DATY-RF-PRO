"""Only explicit, MAC-bound scan evidence is accepted as a database setting."""
import copy
import unittest
import uuid
from test_unified_database import legacy_connection
from unified_domains import DomainError
import unified_database as db
from shure_scan_profiles import DOCUMENT_ID, SCHEMA, VERIFIED_RANGE


def document():
    return {'schema':SCHEMA,'receivers':[{'receiver_mac':'00:0E:DD:AD:31:A3','model':'ULXD4','band':'L51',
        'source':'user-confirmed-chassis-label','scan_range_khz':copy.deepcopy(VERIFIED_RANGE),'evidence_id':'isolated-fixture'}]}


class Profiles(unittest.TestCase):
    def setUp(self):
        self.c=legacy_connection();self.addCleanup(self.c.close)
        with self.c:self.meta=db.migrate(self.c,100)

    def save(self,value,revision=0):
        with self.c:return db.put_resource(self.c,{'operation_id':uuid.uuid4().hex,'epoch':self.meta['epoch'],
            'kind':'settings','id':DOCUMENT_ID,'expected_revision':revision,'value':value},{'id':'fixture','role':'operator'},101)

    def test_exact_category_and_binding_committed(self):
        receipt=self.save(document())
        self.assertEqual(receipt['resource']['value'],document())
        row=self.c.execute('SELECT setting_type FROM biz_settings WHERE id=?',(DOCUMENT_ID,)).fetchone()
        self.assertEqual(row[0],DOCUMENT_ID)

    def test_unverified_band_duplicate_mac_ip_and_grid_never_commit(self):
        cases=[]
        for key,value in [('band','G50'),('model','ULXD4D'),('source','guessed-from-frequency'),('receiver_mac','00:0e:dd:ad:31:a3'),('evidence_id','')]:
            invalid=document();invalid['receivers'][0][key]=value;cases.append(invalid)
        invalid=document();invalid['receivers']*=2;cases.append(invalid)
        invalid=document();invalid['receivers'][0]['receiver_ip']='192.0.2.1';cases.append(invalid)
        invalid=document();invalid['receivers'][0]['scan_range_khz']['start_khz']+=25;cases.append(invalid)
        for invalid in cases:
            with self.subTest(value=invalid),self.assertRaises(DomainError):self.save(invalid)
        self.assertIsNone(db.get_resource(self.c,'settings',DOCUMENT_ID))

    def test_atomic_removal_and_cas_preserve_other_profiles(self):
        self.save(document())
        cleared={'schema':SCHEMA,'receivers':[]};self.save(cleared,1)
        with self.assertRaises(db.DatabaseError):self.save(document(),1)
        self.assertEqual(db.get_resource(self.c,'settings',DOCUMENT_ID)['value'],cleared)


if __name__=='__main__':unittest.main()
