"""Actual file compaction; fake scope only avoids acquiring live ports/TLS."""
from pathlib import Path
from contextlib import closing
import importlib.util,json,sqlite3,sys,tempfile,unittest
from types import SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[3]
sys.path[:0]=[str(ROOT/'app/server'),str(Path(__file__).parent)]
import unified_database as db
import unified_live as live
from test_unified_database import legacy_connection
from test_unified_live import device,command
spec=importlib.util.spec_from_file_location('compact_fixture',ROOT/'scripts/compact-sample-history.py')
maintenance=importlib.util.module_from_spec(spec);spec.loader.exec_module(maintenance)

class Compaction(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.data=self.root/'data';self.data.mkdir()
        self.path=self.data/'business.sqlite3';self.backup=self.root/'before.sqlite3';self.report=self.root/'report.json'
        source=legacy_connection()
        with source:db.migrate(source,100)
        self.epoch=db.status(source)['epoch']
        with source:
            live.record_snapshot(source,'boot',[device()],1000)
            live.record_command(source,command(),1001)
            self.receipt=db.put_resource(source,dict(operation_id='keep-settings-fixture-001',epoch=self.epoch,kind='settings',id='alert_sound',value={'enabled':True},deleted=False,expected_revision=0),{'id':'fixture'},1002)
        with closing(sqlite3.connect(self.path)) as target:source.backup(target)
        source.close()
        with closing(sqlite3.connect(self.path)) as target:target.execute('PRAGMA journal_mode=WAL')
        self.state=self.root/'runtime-status.json';self.state.write_text(json.dumps({'state':'stopped'}))
        self.config=self.root/'config.json';self.config.write_text(json.dumps({'runtime_directory':str(self.root),'database_epoch':self.epoch}))
        self.fake=SimpleNamespace(database=self.path,public_directory=self.root/'public',close=lambda:None)

    def run_compact(self):
        with patch.object(maintenance,'RuntimeScope',return_value=self.fake):
            return maintenance.compact(self.config,self.epoch,self.backup,self.report)

    def test_clears_history_keeps_latest_settings_receipts_ids_and_backup(self):
        with closing(sqlite3.connect(self.path)) as before:
            latest=before.execute('SELECT * FROM live_latest').fetchall()
            command_rows=before.execute('SELECT * FROM live_commands').fetchall()
            sequences=before.execute('SELECT * FROM sqlite_sequence ORDER BY name').fetchall()
        result=self.run_compact();self.assertTrue(result['allRetainedValuesEqual'])
        with closing(sqlite3.connect(self.path)) as after:
            self.assertEqual(after.execute('SELECT count(*) FROM live_samples').fetchone()[0],0)
            self.assertEqual(after.execute('SELECT count(*) FROM live_sample_payloads').fetchone()[0],0)
            self.assertEqual(after.execute('SELECT * FROM live_latest').fetchall(),latest)
            self.assertEqual(after.execute('SELECT * FROM live_commands').fetchall(),command_rows)
            self.assertEqual(after.execute('SELECT * FROM sqlite_sequence ORDER BY name').fetchall(),sequences)
            self.assertEqual(db.get_operation(after,'keep-settings-fixture-001','fixture')['resource'],self.receipt['resource'])
            self.assertEqual(db.status(after)['epoch'],self.epoch)
        with closing(sqlite3.connect(self.backup)) as before:self.assertEqual(before.execute('SELECT count(*) FROM live_samples').fetchone()[0],1)

    def test_running_server_refused_before_any_copy(self):
        self.state.write_text(json.dumps({'state':'running'}))
        with self.assertRaises(ValueError):self.run_compact()
        self.assertFalse(self.backup.exists());self.assertFalse(self.report.exists())

    def test_wrong_epoch_and_existing_backup_refused(self):
        with patch.object(maintenance,'RuntimeScope',return_value=self.fake):
            with self.assertRaises(ValueError):maintenance.compact(self.config,'wrong',self.backup,self.report)
        self.backup.write_bytes(b'keep')
        with self.assertRaises(ValueError):self.run_compact()
        self.assertEqual(self.backup.read_bytes(),b'keep')

if __name__=='__main__':unittest.main()
