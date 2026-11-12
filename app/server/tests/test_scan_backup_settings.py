"""Backup preferences use real versioned SQLite; retired history remains retired."""
import copy
import json
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from contextlib import closing
from test_unified_database import legacy_connection
import unified_database as db
from unified_domains import DomainError
from data_retirement import check_request, RetiredDataError


class ScanBackupSettingsTests(unittest.TestCase):
    def setUp(self):
        self.c = legacy_connection()
        self.addCleanup(self.c.close)
        with self.c:
            self.meta = db.migrate(self.c, 100)
        self.value = dict(schema='daty-scan-backup-settings-v1', enabled=True, maxMiB=128)

    def save(self, value, revision=0):
        with self.c:
            return db.put_resource(self.c, dict(operation_id=uuid.uuid4().hex,
                epoch=self.meta['epoch'], kind='settings', id='scan_backup', expected_revision=revision,
                value=value, deleted=False), {'id': 'backup-fixture', 'role': 'operator'}, 101)['resource']

    def test_disabled_and_capacity_survive_sqlite_reopen(self):
        saved = self.save(dict(self.value, enabled=False, maxMiB=256))
        with tempfile.TemporaryDirectory(prefix='daty-backup-settings-') as folder:
            path = Path(folder) / 'fixture.sqlite3'
            with closing(sqlite3.connect(path)) as target:
                self.c.backup(target)
            with closing(sqlite3.connect(path)) as reopened:
                self.assertEqual(db.get_resource(reopened, 'settings', 'scan_backup'), saved)

    def test_invalid_document_and_stale_revision_do_not_change_committed_value(self):
        saved = self.save(self.value)
        cases = [dict(self.value, enabled=1), dict(self.value, maxMiB=True), dict(self.value, maxMiB=128.0),
                 dict(self.value, maxMiB=1), dict(self.value, schema='other'), dict(self.value, path='outside')]
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises((DomainError, db.DatabaseError, ValueError)):
                    self.save(value, 1)
                self.assertEqual(db.get_resource(self.c, 'settings', 'scan_backup'), saved)
        with self.assertRaises(db.DatabaseError):
            self.save(dict(self.value, enabled=False))

    def test_capacity_choices_and_history_retirement(self):
        for revision, limit in enumerate((64, 128, 256, 512)):
            self.assertEqual(self.save(dict(self.value, maxMiB=limit), revision)['value']['maxMiB'], limit)
        check_request('database.write', dict(kind='settings', id='scan_backup', value=self.value))
        for kind in ('scans', 'scan_current', 'planning_records', 'alerts'):
            with self.assertRaises(RetiredDataError):
                check_request('database.resources.list', dict(kind=kind))


if __name__ == '__main__':
    unittest.main()
