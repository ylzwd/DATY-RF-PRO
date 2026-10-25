"""SQLite spectrum thresholds: server seed, atomic CAS and reopen durability."""
import copy
import json
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import closing
from pathlib import Path
from test_unified_database import legacy_connection
from unified_domains import DomainError
import unified_database as db
from spectrum_settings import DOCUMENT_ID, SEED, ensure


class SpectrumSettingsTests(unittest.TestCase):
    def setUp(self):
        self.c = legacy_connection()
        self.addCleanup(self.c.close)
        with self.c:
            self.meta = db.migrate(self.c, 100)
            self.original = ensure(self.c, 101)

    def save(self, value, revision=1, deleted=False):
        with self.c:
            return db.put_resource(self.c, dict(operation_id=uuid.uuid4().hex,
                epoch=self.meta['epoch'], kind='settings', id=DOCUMENT_ID,
                expected_revision=revision, value=value, deleted=deleted),
                {'id': 'spectrum-fixture', 'role': 'operator'}, 102)

    def test_server_seed_once_and_exact_category(self):
        self.assertEqual(self.original['value'], SEED)
        with self.c:
            self.assertEqual(ensure(self.c, 103), self.original)
        row = self.c.execute('SELECT setting_type,metadata_json FROM biz_settings WHERE id=?', (DOCUMENT_ID,)).fetchone()
        self.assertEqual(row[0], 'spectrum_scan')
        self.assertEqual(json.loads(row[1]), SEED)

    def test_two_thresholds_commit_and_survive_reopen(self):
        value = dict(SEED, peakThresholdDbm=-59.5, exclusionThresholdDbm=-90.2)
        result = self.save(value)['resource']
        with tempfile.TemporaryDirectory(prefix='daty-spectrum-') as folder:
            path = Path(folder) / 'fixture.sqlite3'
            with closing(sqlite3.connect(path)) as target:
                self.c.backup(target)
            with closing(sqlite3.connect(path)) as reopened:
                self.assertEqual(db.get_resource(reopened, 'settings', DOCUMENT_ID), result)
                with reopened:
                    self.assertEqual(ensure(reopened, 104), result)

    def test_invalid_numeric_shape_never_changes_either_value(self):
        cases = []
        for key in ('peakThresholdDbm', 'exclusionThresholdDbm'):
            for value in (True, '-85', None, -140.1, .1, float('inf'), float('nan')):
                cases.append(dict(SEED, **{key: value}))
        cases += [dict(SEED, injected=[]), {'schema': SEED['schema']}, dict(SEED, schema='unknown')]
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises((DomainError, db.DatabaseError, ValueError)):
                    self.save(value)
                self.assertEqual(db.get_resource(self.c, 'settings', DOCUMENT_ID), self.original)

    def test_cas_conflict_and_tombstone_do_not_overwrite_or_reseed(self):
        updated = self.save(dict(SEED, exclusionThresholdDbm=-88))['resource']
        with self.assertRaises(db.DatabaseError):
            self.save(SEED)
        self.assertEqual(db.get_resource(self.c, 'settings', DOCUMENT_ID), updated)
        deleted = self.save(None, revision=2, deleted=True)['resource']
        with self.c:
            self.assertEqual(ensure(self.c, 104), deleted)

    def test_independent_threshold_order_and_bounds(self):
        for revision, pair in enumerate(((-140, 0), (0, -140), (-85, -85)), 1):
            value = dict(SEED, peakThresholdDbm=pair[0], exclusionThresholdDbm=pair[1])
            self.assertEqual(self.save(value, revision)['resource']['value'], value)


if __name__ == '__main__':
    unittest.main()
