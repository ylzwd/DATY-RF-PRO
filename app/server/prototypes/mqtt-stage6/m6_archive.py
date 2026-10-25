"""Original archive format/builder with a pinned SQLite backup read snapshot.

The original module is loaded into its own namespace; its SQLite API alone is
injected. No process-wide sqlite3 monkeypatch, production file edit, domain
rewrite or change to ZIP contents, integrity checks, cleanup or confirmations.
"""
import importlib.util
from pathlib import Path
import sqlite3


class SnapshotConnection(sqlite3.Connection):
    def backup(self,target,**options):
        if options.get('name','main')!='main':raise ValueError('Archive snapshot requires the main database')
        owned=not self.in_transaction
        try:
            if owned:
                self.execute('BEGIN').close()
                cursor=self.execute('SELECT rootpage FROM sqlite_schema LIMIT 1')
                cursor.fetchone();cursor.close()
            # Holding the source read transaction prevents SQLite's incremental
            # backup from restarting after each concurrent telemetry commit.
            return super().backup(target,**options)
        finally:
            # Release the WAL reader before integrity checks/ZIP compression of
            # the destination, while preserving any caller-owned transaction.
            if owned:self.rollback()


class SnapshotSQLite:
    @staticmethod
    def connect(*args,**kwargs):
        return sqlite3.connect(*args,**{**kwargs,'factory':SnapshotConnection})

    def __getattr__(self,name):return getattr(sqlite3,name)


source=Path(__file__).resolve().parents[2]/'server_archive.py'
spec=importlib.util.spec_from_file_location('mqtt6_original_archive',source)
implementation=importlib.util.module_from_spec(spec)
spec.loader.exec_module(implementation)
implementation.sqlite3=SnapshotSQLite()
ArchiveService=implementation.ArchiveService
