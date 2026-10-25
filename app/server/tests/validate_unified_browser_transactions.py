"""Validate browser-produced normalized batches in actual SQLite :memory: only.

Input is nonsecret fixture JSON on stdin. Never opens the application DB or
starts the Bridge; shares the test-only legacy schema extractor and migrator.
"""
import json
import sys

from test_unified_database import legacy_connection
import unified_database as db
from unified_consistency import verify_consistency


def main():
    batches = json.load(sys.stdin)
    if not isinstance(batches, list) or not batches:
        raise ValueError('Expected explicit browser fixture batches')
    epochs={body.get('epoch') for body in batches if isinstance(body,dict)}
    if len(epochs)!=1 or len([body for body in batches if isinstance(body,dict)])!=len(batches):
        raise ValueError('Browser fixture batches must share one actual database epoch')
    fixture_ids=iter(['browser-fixture-instance',next(iter(epochs))])
    connection = legacy_connection()
    try:
        with connection:
            db.migrate(connection, 100, new_id=lambda:next(fixture_ids))
        actor = {'id': 'local-development', 'name': 'fixture local', 'role': 'operator'}
        for index, original in enumerate(batches):
            # Retain every browser-produced field, including nested input proof
            # epoch. Initialize the fixture to its declared epoch, not rewrite
            # incoming operations and thereby invalidate their actual evidence.
            body = original
            with connection:
                result = db.put_batch(connection, body, actor, 1000 + index)
            if result.get('success') is not True:
                raise AssertionError('Real SQLite batch did not confirm')
        verify_consistency(connection)
        if connection.execute('PRAGMA foreign_key_check').fetchall():
            raise AssertionError('Foreign key violations')
        print(json.dumps({'status': 'real-sqlite-browser-batches-passed',
                          'batches': len(batches), 'disk_database_writes': 0}))
    finally:
        connection.close()


if __name__ == '__main__':
    main()
