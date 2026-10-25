"""Deliberately exit an isolated writer after its FULL dispatch claim."""
import importlib.util
import json
import os
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[1]
sys.path[:0]=[str(HERE),str(ROOT),*[str(HERE.parent/f'mqtt-stage{n}') for n in (5,4,3,2,1)]]
base=Path(sys.argv[1]).resolve()
if not (base/'.journal-crash-fixture').is_file() or base.is_relative_to(ROOT):raise ValueError('Isolated fixture required')
os.environ['DATY_DB_PATH']=str(base/'business.sqlite3');os.environ['DATY_ARCHIVE_PATH']=str(base/'archives')
for n in (4,6):(base/f'.daty-mqtt-stage{n}-fixture').write_text('isolated')
spec=importlib.util.spec_from_file_location('crash_test_bridge',ROOT/'mqtt-bridge.py');bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
from m6_repository import Repository,Journal,ACTOR
repo=Repository(bridge,fixture_root=base);journal=Journal(repo,fixture_root=base)
request=json.loads((base/'intent.json').read_text('utf-8'));ACTOR.set(repo.actor('127.0.0.1'))
record,_=journal.reserve(request,'mqtt')
journal.transition(record['operation_id'],{'reserved'},'dispatching',attempt=True)
os._exit(73)  # no graceful close(), atexit, replay or receiver send
