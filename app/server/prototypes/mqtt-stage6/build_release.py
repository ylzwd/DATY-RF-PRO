"""Copy explicit source/runtime inputs into a new immutable test/release tree.

No database, local IP cache, logs, security bundle, pairing secret or certificate
is taken from the production project. External runtime binaries are inventoried
by digest. This does not install tasks, restart services or update remote copies.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
from datetime import datetime,timezone

ROOT=Path(__file__).resolve().parents[2]


def copy_file(source,target):
    if source.is_symlink() or source.stat().st_nlink!=1:raise ValueError('Linked release input forbidden')
    target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)


def copy_tree(source,target):
    for path in source.rglob('*'):
        if '__pycache__' in path.parts or path.suffix=='.pyc':continue
        if path.is_symlink() or (hasattr(path,'is_junction') and path.is_junction()):raise ValueError('Linked release input forbidden')
        if path.is_file():copy_file(path,target/path.relative_to(source))


if __name__=='__main__':
    ap=argparse.ArgumentParser()
    for name in ('output','python','broker-directory','paho-directory'):ap.add_argument('--'+name,required=True)
    ap.add_argument('--node',default=shutil.which('node'))
    ap.add_argument('--playwright-directory',required=True)
    args=ap.parse_args();out=Path(args.output).resolve()
    if any(out.is_relative_to(p.resolve()) for p in (ROOT,ROOT.parent/'FAshe',Path('C:/ProgramData/DATY RF PRO'))):raise ValueError('Release output must be separate')
    out.mkdir(parents=True,exist_ok=False)
    for source in ROOT.glob('*.py'):copy_file(source,out/'server'/source.name)
    for name in ('unirf-app.html','DATYlogo.png','version.json'):copy_file(ROOT/name,out/'server'/name)
    for folder in ('src','profiles','contracts','tests'):
        copy_tree(ROOT/folder,out/'server'/folder)
    for stage in range(1,7):
        directory=ROOT/'prototypes'/f'mqtt-stage{stage}'
        for source in directory.iterdir():
            if source.is_file() and source.suffix in ('.py','.cjs','.js','.json','.md'):
                copy_file(source,out/'server/prototypes'/directory.name/source.name)
    fashe=ROOT.parent/'FAshe'
    copy_file(fashe/'index.html',out/'FAshe/index.html')
    for folder in ('src','vendor','profiles'):copy_tree(fashe/folder,out/'FAshe'/folder)
    copy_tree(Path(args.python).resolve().parent,out/'tools/python')
    # The installed embedded interpreter includes the production source root.
    # A fixed release must never resolve a missing module back into that tree.
    for config in (out/'tools/python').glob('python*._pth'):
        lines=config.read_text('utf-8-sig').splitlines()
        config.write_text('\n'.join(line for line in lines if not Path(line).is_absolute())+'\n','utf-8')
    broker=Path(args.broker_directory).resolve()
    for path in broker.iterdir():
        if path.is_file() and (path.suffix=='.dll' or path.name in ('mosquitto.exe','mosquitto_passwd.exe','NOTICE.md','edl-v10','epl-v20','README.md','README-windows.txt')):
            copy_file(path,out/'tools/broker'/path.name)
    copy_tree(Path(args.paho_directory).resolve(),out/'tools/pylib')
    copy_file(Path(args.node).resolve(),out/'tools/node/node.exe')
    copy_tree(Path(args.playwright_directory).resolve(),out/'tools/playwright')
    files={path.relative_to(out).as_posix():hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(out.rglob('*')) if path.is_file()}
    (out/'release-manifest.json').write_text(json.dumps({'schema':'daty-mqtt6-fixed-release-v1',
        'created_utc':datetime.now(timezone.utc).isoformat(),'files':files,'production_deployed':False},indent=2),'utf-8')
    print(json.dumps({'directory':str(out),'files':len(files),'bytes':sum(p.stat().st_size for p in out.rglob('*') if p.is_file())}))
