"""Validated immutable snapshot entry; secrets stay in protected ProgramData."""
from pathlib import Path
import os,sys,json
sys.path.insert(0,str(Path(__file__).resolve().parent))
from cluster_storage import backup_sqlite,create_snapshot
if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--workdir',default=str(Path(__file__).resolve().parent))
    p.add_argument('--syncdir',default=str(Path(os.environ.get('ProgramData','C:/ProgramData'))/'DATY RF PRO/sync'))
    a=p.parse_args()
    result=create_snapshot(a.workdir,a.syncdir,Path(os.environ.get('ProgramData','C:/ProgramData'))/'DATY RF PRO/security')
    print(json.dumps(result))
