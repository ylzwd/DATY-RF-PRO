"""Real exported-EXE acceptance in new marked directories, never site devices."""
import argparse
import contextlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'app/server')]
import product_distribution as dist
from product_info import digest


def main():
    parser=argparse.ArgumentParser();parser.add_argument('archive',type=Path);parser.add_argument('--sha256',required=True);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--previous-archive',type=Path);parser.add_argument('--previous-sha256')
    args=parser.parse_args();output=args.output.resolve();output.mkdir(exist_ok=False,parents=True)
    target=output/'installed';incoming=output/'incoming'
    dist.extract_verified(args.previous_archive or args.archive,target,args.previous_sha256 or args.sha256)
    dist.extract_verified(args.archive,incoming,args.sha256)
    (target/'.portable-test-fixture').write_text('isolated product acceptance',encoding='utf-8')
    with (output/'green.log').open('w',encoding='utf-8') as log:
        subprocess.run([sys.executable,'-X','utf8','-B',str(ROOT/'scripts/test-project-green.py'),'--root',str(target)],stdout=log,stderr=log,check=True,timeout=180,creationflags=subprocess.CREATE_NO_WINDOW)
    # Startup has already committed default settings through real MQTT/SQLite.
    # Add a local scan work file; snapshots below compare every private byte.
    backup=target/'data/scan-backups/acceptance.datyscan';backup.parent.mkdir(exist_ok=True)
    backup.write_text('{"acceptance":"preserve exact scan bytes"}',encoding='utf-8')
    def private_files():
        names=[p for p in (target/'data').rglob('*') if p.is_file()]
        names.extend(target/'config'/name for name in ('project-instance.local.json','native.local.json'))
        return {p.relative_to(target).as_posix():digest(p) for p in names}
    def saved_settings():
        dist.database_schemas(target)
        with contextlib.closing(sqlite3.connect((target/'data/db/daty-rf.sqlite3').as_uri()+'?mode=ro&immutable=1',uri=True)) as db:
            return db.execute("select r.id,r.revision,v.value_json,v.digest from db_resources r join db_resource_versions v on v.kind=r.kind and v.id=r.id and v.revision=r.revision where r.kind='settings' order by r.id").fetchall()
    before=private_files();settings=saved_settings();assert settings,'Native defaults did not commit'
    (output/'private-before-sha256.json').write_text(json.dumps(before,indent=2),encoding='utf-8')
    assert private_files()==before,'Acceptance reader changed private bytes'
    python=incoming/'app/tools/python/python.exe';tool=incoming/'scripts/product_distribution.py'
    def run(*argv):
        with (output/'upgrade.log').open('a',encoding='utf-8') as log:
            subprocess.run([str(python),'-X','utf8','-B',str(tool),*map(str,argv)],stdout=log,stderr=log,check=True,timeout=240,creationflags=subprocess.CREATE_NO_WINDOW)
    run('upgrade',args.archive.resolve(),'--target',target,'--sha256',args.sha256)
    (output/'private-after-upgrade-sha256.json').write_text(json.dumps(private_files(),indent=2),encoding='utf-8')
    assert private_files()==before,'Upgrade changed private bytes'
    dist.verify_directory(target)
    run('recover','--target',target)
    (output/'private-after-rollback-sha256.json').write_text(json.dumps(private_files(),indent=2),encoding='utf-8')
    assert private_files()==before,'Rollback changed private bytes'
    dist.verify_directory(target)
    # Start the recovered real EXE, observe its actual HWND and writable backend,
    # then request normal close and verify saved settings survive another boot.
    spec=importlib.util.spec_from_file_location('product_green',ROOT/'scripts/test-project-green.py')
    green=importlib.util.module_from_spec(spec);spec.loader.exec_module(green);green.ROOT=target
    child=subprocess.Popen([str(target/'DATY RF PRO.exe')],cwd=target,creationflags=subprocess.CREATE_NO_WINDOW)
    status_file=target/'runtime/runtime-status.json'
    boot=None
    try:
        def ready():
            value=json.loads(status_file.read_bytes())
            return value if value.get('state')=='running' and value.get('transport',{}).get('ready') and value.get('persistence',{}).get('writable') else None
        status=green.wait_for(ready);boot=status['boot_id'];green.wait_for(green.windows)
        child.wait(timeout=15)
        # A running target must be rejected by the real shared update lease.
        rejection=subprocess.run([str(python),'-X','utf8','-B',str(tool),'recover','--target',str(target)],capture_output=True,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
        assert rejection.returncode!=0 and ('窗口' in rejection.stderr or '运行' in rejection.stderr),rejection.stderr
    finally:
        green.close_windows()
        if boot:
            green.wait_for(lambda:json.loads(status_file.read_bytes()).get('state')=='stopped')
    assert saved_settings()==settings,'Committed settings changed across update/rollback/restart'
    assert digest(backup)==before[backup.relative_to(target).as_posix()]
    result={'ok':True,'product':status['product'],'upgradeProduct':json.loads((incoming/dist.MANIFEST).read_bytes())['product'],'exactExportedFilesUsed':True,'noGitOrSDK':not (target/'.git').exists() and not (target/'tools').exists(),
            'greenEntries':json.loads((target/'verification/green-runtime.json').read_bytes())['entries'],
            'privateFilesCompared':len(before),'upgradePreservedEveryPrivateByte':True,'rollbackPreservedEveryPrivateByte':True,
            'settingsPreservedAcrossRestart':len(settings),'runningTargetRejected':True,'physicalDeviceCommands':0}
    (output/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
