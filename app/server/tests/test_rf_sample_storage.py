"""Storage, migration and restart tests use disposable SQLite only."""
from pathlib import Path
import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT),str(Path(__file__).parent)]
import rf_sample_storage as storage
import unified_live as live
import unified_database as database
from unified_schema import validate_schema
from test_unified_live import device
import test_data_management_v2 as old_tests


class SnapshotStorage(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'storage.sqlite3'
        self.c=sqlite3.connect(self.path);self.addCleanup(self.c.close)
        self.c.execute('PRAGMA foreign_keys=ON');self.c.execute('PRAGMA journal_mode=WAL')
        self.c.execute('PRAGMA synchronous=FULL')
        for sql in live.schema_statements():self.c.execute(sql)
        self.c.commit()

    def write(self,when=1000,**changes):
        value=device(**changes)
        with self.c:live.record_snapshot(self.c,'boot-a',[value],when)
        sample=self.c.execute('SELECT max(id) FROM live_samples').fetchone()[0]
        return sample,json.loads(storage.load_snapshot(self.c,sample))

    def test_exact_original_bytes_digest_and_scalar_queries(self):
        for when,rf in [(1000,-90.0),(1001,-90.1),(1002,0.0)]:
            sid,_=self.write(when,rf=rf,af_dbfs=-50,batt=None,extra={'label':'主唱','future':None})
            raw=storage.load_snapshot(self.c,sid)
            latest=self.c.execute('SELECT snapshot_json FROM live_latest').fetchone()[0]
            self.assertEqual(raw,latest)
            self.assertEqual(self.c.execute('SELECT rf_dbm FROM live_samples WHERE id=?',(sid,)).fetchone()[0],rf)
            self.assertEqual(hashlib.sha256(raw.encode()).hexdigest(),self.c.execute('SELECT snapshot_sha256 FROM live_samples WHERE id=?',(sid,)).fetchone()[0])

    def test_per_channel_session_minute_blocks_and_out_of_order(self):
        for when in (1000,59999,60000,61000,2000):self.write(when)
        self.assertEqual(self.c.execute('SELECT count(*) FROM live_sample_blocks').fetchone()[0],2)
        with self.c:live.record_snapshot(self.c,'boot-a',[device(2)],62000)
        self.assertEqual(self.c.execute('SELECT count(*) FROM live_sample_blocks').fetchone()[0],3)
        with self.c:live.record_snapshot(self.c,'boot-b',[device()],63000)
        self.assertEqual(self.c.execute('SELECT count(*) FROM live_sample_blocks').fetchone()[0],4)
        for sid, in self.c.execute('SELECT id FROM live_samples'):storage.load_snapshot(self.c,sid)

    def test_duplicate_no_extra_payload_or_dictionary(self):
        self.write();before=[self.c.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ('live_samples',*storage.TABLES)]
        self.write();self.assertEqual(before,[self.c.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ('live_samples',*storage.TABLES)])

    def test_new_and_explicit_unknown_values_preserved(self):
        for when,changes in [(1000,{'freq':641000,'rf':-40,'muted':False}),
                             (1001,{'freq':None,'rf':None,'muted':None,'batt':None}),
                             (1002,{'freq':642000,'rf':-35,'muted':True})]:
            _,value=self.write(when,**changes)
            for field,want in changes.items():self.assertEqual(value[field],want)

    def test_invalid_payload_rolls_back_latest_sample_and_block(self):
        self.write();before=self.c.execute('SELECT * FROM live_latest').fetchall()
        self.c.execute("CREATE TRIGGER reject_payload BEFORE INSERT ON live_sample_payloads BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.DatabaseError):
            with self.c:live.record_snapshot(self.c,'boot-a',[device(rf=-10)],61000)
        self.assertEqual(before,self.c.execute('SELECT * FROM live_latest').fetchall())
        self.assertEqual(self.c.execute('SELECT count(*) FROM live_samples').fetchone()[0],1)
        self.assertEqual(self.c.execute('SELECT count(*) FROM live_sample_blocks').fetchone()[0],1)

    def test_legacy_mixed_rows_still_load(self):
        sid,_=self.write();raw=storage.load_snapshot(self.c,sid)
        with self.c:
            self.c.execute('DELETE FROM live_sample_payloads WHERE sample_id=?',(sid,))
            self.c.execute("UPDATE live_samples SET snapshot_json=?,sample_kind='bridge-snapshot' WHERE id=?",(raw,sid))
        self.write(1001)
        self.assertEqual(storage.load_snapshot(self.c,sid),raw)

    def test_corrupt_truncated_trailing_and_length_fail_closed(self):
        sid,_=self.write();payload=self.c.execute('SELECT payload FROM live_sample_payloads').fetchone()[0]
        for bad in (b'broken',payload[:-1],payload+b'extra'):
            with self.c:self.c.execute('UPDATE live_sample_payloads SET payload=?',(bad,))
            with self.assertRaises(storage.CorruptSampleError):storage.load_snapshot(self.c,sid)
        with self.c:self.c.execute('UPDATE live_sample_payloads SET payload=?,raw_bytes=2',(payload,))
        with self.assertRaises(storage.CorruptSampleError):storage.load_snapshot(self.c,sid)

    def test_dictionary_identity_and_checksums_verified(self):
        sid,_=self.write()
        with self.c:self.c.execute("UPDATE live_sample_blocks SET dictionary_sha256='wrong'")
        with self.assertRaises(storage.CorruptSampleError):storage.load_snapshot(self.c,sid)
        with self.assertRaises(storage.CorruptSampleError):
            with self.c:live.record_snapshot(self.c,'boot-a',[device()],1001)
        self.assertEqual(self.c.execute('SELECT count(*) FROM live_samples').fetchone()[0],1)

    def test_missing_payload_and_unknown_encoding_fail_closed(self):
        sid,_=self.write()
        with self.c:self.c.execute('DELETE FROM live_sample_payloads')
        with self.assertRaises(storage.CorruptSampleError):storage.load_snapshot(self.c,sid)
        with self.c:self.c.execute("UPDATE live_samples SET sample_kind='future-v9'")
        with self.assertRaises(storage.CorruptSampleError):storage.load_snapshot(self.c,sid)

    def test_independent_process_reads_committed_bytes(self):
        sid,_=self.write(extra={'label':'主唱'})
        digest=hashlib.sha256(storage.load_snapshot(self.c,sid).encode()).hexdigest()
        code="import sys,sqlite3,hashlib;sys.path.insert(0,sys.argv[1]);from rf_sample_storage import load_snapshot;c=sqlite3.connect(sys.argv[2]);print(hashlib.sha256(load_snapshot(c,int(sys.argv[3])).encode()).hexdigest());c.close()"
        result=subprocess.run([sys.executable,'-X','utf8','-B','-c',code,str(ROOT),str(self.path),str(sid)],capture_output=True,text=True,check=True)
        self.assertEqual(result.stdout.strip(),digest)

    def test_history_delete_cascades_payload_without_live_changes(self):
        self.write();before=self.c.execute('SELECT * FROM live_latest').fetchall()
        with self.c:self.c.execute('DELETE FROM live_samples')
        self.assertEqual(self.c.execute('SELECT count(*) FROM live_sample_payloads').fetchone()[0],0)
        self.assertEqual(before,self.c.execute('SELECT * FROM live_latest').fetchall())


class Migration(unittest.TestCase):
    def setUp(self):
        self.fixture=old_tests.DataManagementV2Tests();self.addCleanup(self.fixture.doCleanups)
        self.c=self.fixture.old_database()
        with self.c:
            for sql in database.INDEX_V2_DDL:self.c.execute(sql)
            self.c.execute('INSERT INTO db_schema_migrations VALUES(?,?,?)',(*database.migration_checksums(2)[1],200))
            self.c.execute('PRAGMA user_version=2')

    def test_v2_upgrade_preserves_identity_receipt_and_old_sample(self):
        saved=self.fixture.save(self.c,'settings','alert_sound',{'enabled':True})
        with self.c:live.record_snapshot(self.c,'before',[device()],1000)
        old=self.c.execute('SELECT * FROM live_samples').fetchall()
        with self.c:database.migrate(self.c,300)
        self.assertEqual(validate_schema(self.c)['schema_version'],3)
        self.assertEqual(old,self.c.execute('SELECT * FROM live_samples').fetchall())
        self.assertEqual(database.get_operation(self.c,saved['operation_id'],'fixture')['resource'],saved['resource'])
        self.assertEqual(database.status(self.c)['epoch'],'kept-epoch')
        with self.c:live.record_snapshot(self.c,'after',[device(rf=-30)],2000)
        for sid, in self.c.execute('SELECT id FROM live_samples'):storage.load_snapshot(self.c,sid)
        self.assertEqual(self.c.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_failed_v3_migration_restores_exact_v2(self):
        before=validate_schema(self.c)
        self.c.set_authorizer(lambda action,name,*_:sqlite3.SQLITE_DENY if action==sqlite3.SQLITE_CREATE_TABLE and name=='live_sample_payloads' else sqlite3.SQLITE_OK)
        with self.assertRaises(sqlite3.DatabaseError):
            with self.c:database.migrate(self.c,300)
        self.c.set_authorizer(None);self.assertEqual(validate_schema(self.c),before)

    def test_old_index_downgrade_cannot_silently_lose_payloads(self):
        with self.c:database.migrate(self.c,300)
        with self.assertRaises(database.DatabaseError):
            with self.c:database.rollback_index_migration(self.c,'kept-epoch')
        self.assertEqual(validate_schema(self.c)['schema_version'],3)

    def test_offline_conversion_preserves_new_samples_and_later_settings(self):
        with self.c:database.migrate(self.c,300)
        saved=self.fixture.save(self.c,'settings','alert_sound',{'enabled':False})
        with self.c:
            for t in range(1000,1004):live.record_snapshot(self.c,'new',[device(rf=-t/20,batt=None)],t)
        raws={sid:storage.load_snapshot(self.c,sid) for sid, in self.c.execute('SELECT id FROM live_samples')}
        latest=self.c.execute('SELECT * FROM live_latest').fetchall()
        with self.c:database.rollback_sample_storage(self.c,'kept-epoch')
        self.assertEqual(validate_schema(self.c)['schema_version'],2)
        self.assertEqual(dict(self.c.execute('SELECT id,snapshot_json FROM live_samples')),raws)
        self.assertEqual(self.c.execute('SELECT * FROM live_latest').fetchall(),latest)
        self.assertEqual(database.get_operation(self.c,saved['operation_id'],'fixture')['resource'],saved['resource'])
        self.assertEqual(self.c.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_failed_offline_conversion_rolls_back_every_row(self):
        with self.c:
            database.migrate(self.c,300)
            for t in (1000,1001):live.record_snapshot(self.c,'new',[device()],t)
            self.c.execute("UPDATE live_sample_payloads SET payload=X'00' WHERE sample_id=(SELECT max(sample_id) FROM live_sample_payloads)")
        before=self.c.execute('SELECT * FROM live_samples').fetchall()
        with self.assertRaises(storage.CorruptSampleError):
            with self.c:database.rollback_sample_storage(self.c,'kept-epoch')
        self.assertEqual(validate_schema(self.c)['schema_version'],3)
        self.assertEqual(before,self.c.execute('SELECT * FROM live_samples').fetchall())

    def test_wrong_epoch_conversion_refused(self):
        with self.c:database.migrate(self.c,300)
        with self.assertRaises(database.DatabaseError):
            with self.c:database.rollback_sample_storage(self.c,'another-epoch')
        self.assertEqual(validate_schema(self.c)['schema_version'],3)


if __name__=='__main__':unittest.main()
