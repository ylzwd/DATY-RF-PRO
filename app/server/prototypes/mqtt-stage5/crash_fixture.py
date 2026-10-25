"""Child process for actual fsync/manifest crash boundary tests. No live paths."""
import base64
import os
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[1]
sys.path[:0]=[str(HERE),str(ROOT),str(HERE.parent/'mqtt-stage3')]
from m5_files import FileStore,hash_bytes
from m5_contract import CHUNK

root,directory,identifier,phase=sys.argv[1:]
store=FileStore(directory,fixture_root=root)
if phase=='chunk':
    store.after_chunk=lambda:os._exit(21)
    raw=b'C'*CHUNK
    store.chunk({'upload_id':identifier,'offset':0,'data':base64.b64encode(raw).decode(),'sha256':hash_bytes(raw)},'network:127.0.0.1',lambda:True)
elif phase=='finish':
    store.before_ready=lambda:os._exit(22)
    store.finish({'upload_id':identifier,'sha256':hash_bytes(b'C'*CHUNK)},'network:127.0.0.1',lambda:True)
else:raise ValueError('Invalid crash phase')
raise RuntimeError('Crash fixture did not reach boundary')
