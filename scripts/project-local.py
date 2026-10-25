"""Independent local development lifecycle. Never reads site identities or tasks."""
from pathlib import Path
import argparse, contextlib, ctypes, hashlib, json, os, runpy, sqlite3, subprocess, sys, time
from datetime import datetime, timezone

ROOT=Path(__file__).resolve().parent.parent
sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'app/tools/pylib'),str(ROOT/'app/server'),str(ROOT/'app/server/prototypes/mqtt-stage3')]
from project_identity import instance_root, host_id

def base():return instance_root(ROOT)

from command_journal import ProcessLease, CommandError
from security_storage import secure_directory, exclusive_write
from tls_support import load_config
from unified_bootstrap import open_database, initialize, enable_wal
import unified_database

def read(path):return json.loads(path.read_text('utf-8-sig'))
@contextlib.contextmanager
def launch_lease():
    deadline=time.monotonic()+130
    while True:
        try:lease=ProcessLease(str(base()/'runtime/project-launch.lock'));break
        except CommandError:
            if time.monotonic()>=deadline:raise RuntimeError('Another project startup is still pending')
            time.sleep(.1)
    try:yield
    finally:lease.close()

def atomic(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    raw=json.dumps(value,ensure_ascii=False,indent=2).encode('utf-8')
    if path.exists() and path.read_bytes()==raw:return
    temp=path.with_name(path.name+'.tmp-'+str(os.getpid()))
    with temp.open('xb') as out:out.write(raw);out.flush();os.fsync(out.fileno())
    os.replace(temp,path)

def profile():
    for p in (ROOT,*ROOT.parents):
        if p.is_symlink() or p.is_junction():raise ValueError('Project directory links are not supported')
    p=read(ROOT/'config/project-development.json')
    if p['schema']!='daty-standalone-project-v1':raise ValueError('Invalid project profile')
    if any(type(p[k]) is not int or not 1024<=p[k]<=65535 for k in ('web_port','mqtt_port')) or p['web_port']==p['mqtt_port']:raise ValueError('Invalid project ports')
    output=ROOT/p['native_output']
    if not output.resolve().is_relative_to(ROOT/'native/publish'):raise ValueError('Invalid native output')
    return p

def process_matches(pid):
    from project_desktop import process_image
    path=process_image(pid)
    return path is not None and path.resolve()==(ROOT/'app/tools/python/python.exe').resolve()

def state(require_fresh=True,match_profile=True):
    try:
        s=read(base()/'runtime/runtime-status.json');instance=read(base()/'config/project-instance.local.json')
        p=profile() if match_profile else s
        age=(datetime.now(timezone.utc)-datetime.fromisoformat(s['at_utc'])).total_seconds()
        return s if (s['database_epoch']==instance['epoch'] and (not require_fresh or -2<=age<=15) and s['mqtt_port']==p['mqtt_port'] and s['web_port']==p['web_port'] and process_matches(s['pid'])) else None
    except (OSError,ValueError,KeyError,TypeError):return None

def ready(s):
    return bool(s and s['state']=='running' and s.get('transport',{}).get('ready') and s.get('persistence',{}).get('writable') and s.get('persistence',{}).get('writer',{}).get('running'))

def prepare():
    p=profile();db=base()/'data/db/daty-rf.sqlite3';security=base()/'data/security'
    running=state(require_fresh=False,match_profile=False)
    if running and any(running[k]!=p[k] for k in ('web_port','mqtt_port')):
        raise RuntimeError('Project ports changed while the server is running; close its windows or use the stop entry before restarting')
    identity=base()/'config/project-instance.local.json';tls=security/'tls-config.json'
    # Never repair/reset partially provisioned or externally supplied data.
    if not identity.exists():
        if (base()/'data').exists() and any((base()/'data').iterdir()):raise ValueError('Unregistered data exists; initialization refused')
        db.parent.mkdir(parents=True,exist_ok=True)
        c=open_database(db)
        try:
            initialize(c,int(time.time()*1000));c.commit();enable_wal(c);epoch=unified_database.status(c)['epoch']
        finally:c.close()
        provision=runpy.run_path(str(ROOT/'app/server/manage-tls.py'))
        metadata=provision['install_material'](tls,provision['create_material'](['127.0.0.1','localhost']))
        exclusive_write(security/'receiver-pairings.json',json.dumps({'version':1,'receivers':[]}))
        atomic(identity,{'schema':'daty-project-instance-v1','epoch':epoch,'ca_sha256':metadata['ca_sha256'],'host_id':host_id()})
    i=read(identity)
    if i['schema']!='daty-project-instance-v1' or i.get('host_id')!=host_id():raise ValueError('Invalid project identity')
    # Rebase local paths after relocation, preserving actual key bytes and epoch.
    for name in ('root-ca.pem','server-cert.pem','server-key.pem','receiver-pairings.json'):
        f=security/name
        if not f.is_file() or f.is_symlink() or f.stat().st_nlink!=1:raise ValueError('Missing or linked local identity')
    secure_directory(security)
    atomic(tls,{'version':1,'certificate_file':str(security/'server-cert.pem'),'private_key_file':str(security/'server-key.pem'),'ca_file':str(security/'root-ca.pem')})
    _,meta=load_config(tls)
    if meta['ca_sha256']!=i['ca_sha256']:raise ValueError('Project CA identity mismatch')
    with contextlib.closing(sqlite3.connect(db.as_uri()+'?mode=ro',uri=True)) as c:
        c.row_factory=sqlite3.Row
        if unified_database.status(c)['epoch']!=i['epoch']:raise ValueError('Project database identity mismatch')
    paths={'database':db,'archives':base()/'data/archives','staging':base()/'data/staging','runtime_directory':base()/'runtime','pairing':security/'receiver-pairings.json','tls':tls,'public_directory':ROOT/'app/public'}
    cfg={'schema':'daty-mqtt6-runtime-v1',**{k:str(v) for k,v in paths.items()},'database_epoch':i['epoch'],'ca_sha256':i['ca_sha256'],'bind_host':'127.0.0.1','mqtt_port':p['mqtt_port'],'web_port':p['web_port']}
    for key in ('archives','staging','runtime_directory'):paths[key].mkdir(parents=True,exist_ok=True)
    atomic(base()/'config/runtime-config.json',cfg)
    native=base()/'config/native.local.json'
    if native.exists():
        if native.stat().st_size>16384:raise ValueError('Native connection bootstrap is too large')
        bootstrap=read(native)
        if not isinstance(bootstrap,dict) or type(bootstrap.get('PollSeconds',2)) is not int or not 1<=bootstrap.get('PollSeconds',2)<=60:
            raise ValueError('Invalid native connection bootstrap; original file preserved')
    else:bootstrap={'PollSeconds':2}
    bootstrap.update(Server=f"https://127.0.0.1:{p['web_port']}",MqttPort=p['mqtt_port'])
    atomic(native,bootstrap)
    return cfg

def start(desktop_owner=None):
    prepare();s=state()
    if ready(s):return s
    if s and s['state'] in ('running','degraded'):raise RuntimeError('Existing project server is recovering; do not start a second writer')
    # Scope validates and exclusively reserves both ports before importing backend.
    from importlib import import_module
    sys.path.insert(0,str(ROOT/'app/server/prototypes/mqtt-stage6'))
    from m6_scope import RuntimeScope
    scope=RuntimeScope(base()/'config/runtime-config.json')
    try:
        from project_plugin_upgrade import upgrade_installed
        upgrade_installed(ROOT,scope)
    finally:scope.close()
    command=[str(ROOT/'app/tools/python/python.exe'),'-X','utf8','-B',str(ROOT/('scripts/project_service.py' if desktop_owner else 'app/service-launch.py')),'--config',str(base()/'config/runtime-config.json')]
    if desktop_owner:command += ['--desktop-owner',str(desktop_owner)]
    with (base()/'runtime/launcher.log').open('ab') as log:
        child=subprocess.Popen(command,cwd=ROOT,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
    return wait_ready(child)

def wait_ready(child):
    for _ in range(240):
        s=state()
        if ready(s):return s
        if child.poll() is not None:raise RuntimeError('Server did not start; see runtime/service-*.log')
        time.sleep(.5)
    owned=state(require_fresh=False,match_profile=False)
    if owned and owned['pid']==child.pid:
        stop(expected_boot=owned['boot_id'])
    raise RuntimeError('Server readiness timeout; owned backend requested to close; see runtime logs')

def stop(expected_boot=None):
    # A stale heartbeat is not evidence that the owned process has exited.
    # The backend also checks the boot nonce before accepting this request.
    s=state(require_fresh=False,match_profile=False)
    if not s:return {'state':'not-running'}
    if expected_boot is not None and s['boot_id']!=expected_boot:return {'state':'replacement-preserved','boot_id':s['boot_id']}
    atomic(base()/'runtime/stop.request.json',{'boot_id':s['boot_id']})
    for _ in range(120):
        if not process_matches(s['pid']):return {'state':'stopped','boot_id':s['boot_id']}
        time.sleep(.5)
    raise RuntimeError('Graceful stop pending; process was not killed')

def finish_desktop(boot_id):
    from project_desktop import native_processes
    with launch_lease():
        others=native_processes(ROOT)
        if others:
            current=state(require_fresh=False,match_profile=False)
            if not current:return {'state':'not-running'}
            if current['boot_id']!=boot_id:return {'state':'replacement-preserved','boot_id':current['boot_id']}
            return {'state':'desktop-still-open','native_pids':others,'boot_id':boot_id}
        return stop(expected_boot=boot_id)


def launch_desktop():
    # Serialize launch/stop decisions, but never hold the lease while a GUI is open.
    with launch_lease():
        exe=ROOT/profile()['native_output']/'DATY.RF.Native.exe'
        if not exe.is_file():raise RuntimeError('Build first using the project build entry')
        existing=state();started=start(desktop_owner=os.getpid());boot_id=started['boot_id']
        env=dict(os.environ,DATY_PROJECT_ROOT=str(ROOT),DATY_PROJECT_DESKTOP_BOOT=boot_id)
        try:
            child=subprocess.Popen([str(exe)],cwd=exe.parent,env=env,creationflags=subprocess.CREATE_NO_WINDOW)
        except Exception:
            if not ready(existing):stop(expected_boot=boot_id)
            raise
    # The native window confirms pending saves before exiting. Its process handle
    # prevents PID reuse from being mistaken for this window's lifetime.
    exit_code=child.wait()
    previous=None
    while True:
        result=finish_desktop(boot_id)
        if result!=previous:
            atomic(base()/'runtime/desktop-lifecycle.json',{'at_utc':datetime.now(timezone.utc).isoformat(),
                'native_pid':child.pid,'native_exit_code':exit_code,**result})
            previous=result
        if result['state']!='desktop-still-open':return result
        # Older direct-launched windows have no supervising host of their own.
        # Retain responsibility until they exit, without holding the launch lease.
        time.sleep(1)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['prepare','start','stop','status','launch']);a=parser.parse_args()
    (base()/'runtime').mkdir(parents=True,exist_ok=True)
    if a.action=='launch':
        result=launch_desktop()
        if sys.stdout:print(json.dumps(result,ensure_ascii=False))
        return
    with launch_lease():
        if a.action=='status':result=state() or {'state':'not-running'}
        elif a.action=='prepare':prepare();result={'state':'prepared','identity':'project-local'}
        elif a.action=='stop':result=stop()
        else:result=start()
    if sys.stdout:print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except Exception as error:
        try:log_root=base()
        except Exception:log_root=ROOT
        (log_root/'runtime').mkdir(parents=True,exist_ok=True)
        with (log_root/'runtime/project-launch-error.log').open('a',encoding='utf-8') as out:out.write(f'{datetime.now().isoformat()} {type(error).__name__}: {error}\n')
        if sys.stderr:print(str(error),file=sys.stderr)
        else:ctypes.windll.user32.MessageBoxW(None,str(error),'DATY RF PRO 独立开发环境',0x10)
        raise SystemExit(1)
