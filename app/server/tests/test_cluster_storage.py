"""Temporary databases/security only; no production services or network."""
import json,shutil,sqlite3,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import contextmanager
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'tests'))
from pairing_test_support import PairingFixture,create_tls_fixture
import cluster_storage as cs

@contextmanager
def database(path):
    c=sqlite3.connect(path)
    try:
        with c:yield c
    finally:c.close()

def scalar(path,query):
    with database(path) as c:return c.execute(query).fetchone()[0]

class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='daty-snapshot-test-');self.root=Path(self.temp.name)
        self.work=self.root/'work';self.work.mkdir();self.sync=self.root/'sync'
        create_tls_fixture(self.root);fixture=PairingFixture(self.root)
        self.security=self.root/'security';shutil.copyfile(fixture.path,self.security/'receiver-pairings.json')
        self.ca=cs.ca_fingerprint(self.security/'root-ca.pem')
        with database(self.work/'daty-rf.sqlite3') as c:c.execute('create table sample(id integer primary key,value text)');c.execute("insert into sample values(1,'original')")
    def tearDown(self):self.temp.cleanup()
    def snapshot(self):
        m=cs.create_snapshot(self.work,self.sync,self.security);return self.sync/m['id']
    def test_wal_is_included_and_no_private_key_is_packaged(self):
        with database(self.work/'daty-rf.sqlite3') as c:
            c.execute('pragma journal_mode=wal');c.execute("insert into sample values(2,'wal')");c.commit()
            folder=self.snapshot()
            self.assertEqual(scalar(folder/'database.sqlite3','select count(*) from sample'),2)
        self.assertEqual(set(p.relative_to(folder).as_posix() for p in folder.rglob('*') if p.is_file()),cs.FILES|{'manifest.json'})
    def test_corrupt_backup_does_not_replace_good_latest_pointer(self):
        self.snapshot();previous=(self.sync/'latest.json').read_bytes()
        (self.work/'daty-rf.sqlite3').write_bytes(b'not sqlite')
        with self.assertRaises(sqlite3.DatabaseError):self.snapshot()
        self.assertEqual(previous,(self.sync/'latest.json').read_bytes())
    def test_truncated_payload_is_rejected_before_restore(self):
        folder=self.snapshot();old=(self.work/'daty-rf.sqlite3').read_bytes()
        (folder/'database.sqlite3').write_bytes(b'bad')
        with self.assertRaises(ValueError):cs.restore_snapshot(folder,self.work,self.security)
        self.assertEqual(old,(self.work/'daty-rf.sqlite3').read_bytes())
    def test_foreign_ca_and_stale_snapshot_are_rejected(self):
        folder=self.snapshot()
        with self.assertRaises(ValueError):cs.verify_snapshot(folder,'0'*64)
        with self.assertRaises(ValueError):cs.verify_snapshot(folder,self.ca,now=time.time()+1000)
    def test_restore_keeps_prior_database_and_restores_matching_pairings(self):
        folder=self.snapshot();pairs=(self.security/'receiver-pairings.json').read_bytes()
        with database(self.work/'daty-rf.sqlite3') as c:c.execute("update sample set value='later'")
        result=cs.restore_snapshot(folder,self.work,self.security)
        self.assertEqual(scalar(self.work/'daty-rf.sqlite3','select value from sample'),'original')
        self.assertEqual(scalar(Path(result['rollback'])/'daty-rf.sqlite3','select value from sample'),'later')
        self.assertEqual(pairs,(self.security/'receiver-pairings.json').read_bytes())
    def test_pairing_install_failure_rolls_back_database(self):
        folder=self.snapshot()
        with database(self.work/'daty-rf.sqlite3') as c:c.execute("update sample set value='later'")
        original=cs.os.replace
        def fail_pairing(src,dest):
            if Path(dest)==self.security/'receiver-pairings.json':raise OSError('injected replacement failure')
            return original(src,dest)
        with patch.object(cs.os,'replace',side_effect=fail_pairing):
            with self.assertRaises(OSError):cs.restore_snapshot(folder,self.work,self.security)
        self.assertEqual(scalar(self.work/'daty-rf.sqlite3','select value from sample'),'later')
    def test_manifest_cannot_select_outside_files(self):
        folder=self.snapshot();path=folder/'manifest.json';m=json.loads(path.read_text());m['files']['../outside']={};path.write_text(json.dumps(m))
        with self.assertRaises(ValueError):cs.verify_snapshot(folder,self.ca)

if __name__=='__main__':unittest.main()
