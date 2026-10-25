"""Service scripts' explicit snapshot/restore boundary."""
from pathlib import Path
import argparse,json,os,sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from cluster_storage import create_snapshot,verify_snapshot,restore_snapshot,ca_fingerprint
p=argparse.ArgumentParser()
p.add_argument('action',choices=['backup','verify','restore'])
p.add_argument('--workdir',default=str(Path(__file__).resolve().parent))
p.add_argument('--syncdir',default=str(Path(os.environ.get('ProgramData','C:/ProgramData'))/'DATY RF PRO/sync'))
p.add_argument('--securitydir',default=str(Path(os.environ.get('ProgramData','C:/ProgramData'))/'DATY RF PRO/security'))
p.add_argument('--snapshot');p.add_argument('--max-age',type=int,default=900)
a=p.parse_args()
if a.action=='backup':value=create_snapshot(a.workdir,a.syncdir,a.securitydir)
else:
    if not a.snapshot:p.error('--snapshot is required; never implicitly restore latest')
    if a.action=='verify':value=verify_snapshot(a.snapshot,ca_fingerprint(Path(a.securitydir)/'root-ca.pem'),max_age=a.max_age)
    else:value=restore_snapshot(a.snapshot,a.workdir,a.securitydir,max_age=a.max_age)
print(json.dumps(value,ensure_ascii=True))
