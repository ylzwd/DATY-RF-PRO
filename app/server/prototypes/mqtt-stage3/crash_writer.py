"""Isolated crash fixture. Never receives a socket, target authority or secret."""
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from command_journal import Journal

if __name__ == '__main__':
    root, db, request_file = map(Path, sys.argv[1:4])
    if not request_file.resolve().is_relative_to(root.resolve()):
        raise ValueError('Fixture request required')
    journal = Journal(db, fixture_root=root)
    request = json.loads(request_file.read_text(encoding='utf-8'))
    record, created = journal.reserve(request, 'mqtt')
    assert created
    journal.transition(record['operation_id'], {'reserved'}, 'dispatching', attempt=True)
    # Deliberately bypass Python cleanup to exercise FULL commit and OS lease.
    os._exit(23)
