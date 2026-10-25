"""Subprocess fixture for C2 JS/HTTP integration; never opens production state."""
import json
from pathlib import Path
import sys

from test_project_revision_api import ProjectRevisionApiTests
from access_test_support import TEST_TOKEN


def main():
    suite = ProjectRevisionApiTests
    suite.setUpClass()
    instance = suite(methodName='runTest')
    try:
        instance.setUp()
        config = json.loads(Path(suite.tls_config).read_text(encoding='utf-8'))
        # Public ephemeral test CA and explicitly fixed fixture token only.
        # Nothing is read from ProgramData, browser state or the live database.
        ca = Path(config['ca_file']).read_text(encoding='ascii')
        print(json.dumps({'fixture': 'daty-c2-isolated-v1', 'port': suite.http.server_port,
                          'ca': ca, 'token': TEST_TOKEN}), flush=True)
        for line in sys.stdin:
            command = line.strip()
            if command == 'stop':
                break
            if command != 'stats':
                raise ValueError('Unknown fixture command')
            with suite.bridge._db_session() as connection:
                stats = {table: connection.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]
                         for table in ('projects', 'project_devices', 'timeline_events', 'commands')}
            print(json.dumps({'fixture_stats': stats}), flush=True)
        instance.tearDown()
    finally:
        instance.doCleanups()
        suite.tearDownClass()


if __name__ == '__main__':
    main()
