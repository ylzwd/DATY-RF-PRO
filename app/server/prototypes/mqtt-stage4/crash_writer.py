"""Isolated process-crash fixture: no network or production Bridge import."""
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
HERE=Path(__file__).resolve().parent
sys.path[:0]=[str(HERE),str(HERE.parents[1]),str(HERE.parent/'mqtt-stage3')]
from data_repository import Repository
from data_service import DataService

root,path,request,phase=sys.argv[1:]
repo=Repository(SimpleNamespace(_db_path=path),fixture_root=root)
def crash(c):os._exit(23)
if phase=='before':repo.before_commit=crash
elif phase=='after':repo.after_commit=crash
else:raise ValueError('Unknown phase')
service=DataService(repo,discovery=None)
service.run(json.loads(Path(request).read_text()),repo.actor('127.0.0.1'),lambda:True)
raise AssertionError('Crash hook was not reached')
