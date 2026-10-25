"""Real isolated backend/SQLite/TLS: exiting the desktop owner releases resources."""
from pathlib import Path
import contextlib, importlib.util, json, socket, sqlite3, subprocess, sys, time, uuid
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('project_local',ROOT/'scripts/project-local.py')
local=importlib.util.module_from_spec(spec);spec.loader.exec_module(local)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0));return s.getsockname()[1]


def main():
    output=ROOT/'verification'/('desktop-owner-'+uuid.uuid4().hex)
    fixture=output/'instance';fixture.mkdir(parents=True)
    profile={'web_port':free_port(),'mqtt_port':free_port()}
    while profile['mqtt_port']==profile['web_port']:profile['mqtt_port']=free_port()
    with patch.object(local,'base',return_value=fixture),patch.object(local,'profile',return_value=profile):local.prepare()
    owner=subprocess.Popen([sys.executable,'-c','import sys;sys.stdin.read()'],stdin=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
    # Only the lifetime guard is attached manually. The actual service, writer,
    # broker, transport, database and shutdown implementation run unchanged.
    code='''import sys,runpy,threading
from pathlib import Path
root=Path(sys.argv[1]);fixture=Path(sys.argv[2]);pid=int(sys.argv[3])
sys.path.insert(0,str(root/'scripts'))
import project_service as host
owner=host.ProcessLifetime(pid,[root/'app/tools/python/python.exe'])
done=threading.Event();worker=threading.Thread(target=host.watch_owner,args=(owner,fixture,fixture/'runtime',done),daemon=True);worker.start()
try:
    sys.argv=[str(root/'app/service-launch.py'),'--config',str(fixture/'config/runtime-config.json')]
    runpy.run_path(sys.argv[0],run_name='__main__')
finally:
    done.set();worker.join(timeout=2);owner.close()
'''
    with (output/'process.txt').open('w',encoding='utf-8') as log:
        backend=subprocess.Popen([sys.executable,'-X','utf8','-B','-c',code,str(ROOT),str(fixture),str(owner.pid)],stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
        status_file=fixture/'runtime/runtime-status.json';started=time.monotonic();ready=None
        try:
            while time.monotonic()-started<40:
                if status_file.exists():
                    status=json.loads(status_file.read_text('utf-8'))
                    if status.get('pid')==backend.pid and local.ready(status):ready=status;break
                if backend.poll() is not None:raise RuntimeError('Isolated backend did not start: '+str(output))
                time.sleep(.2)
            assert ready,'Isolated readiness timed out'
            owner.stdin.close();owner.wait(timeout=5);backend.wait(timeout=35)
            status=json.loads(status_file.read_text('utf-8'))
            assert backend.returncode==0 and status['state']=='stopped',status
            assert not local.process_matches(ready['persistence']['writer']['pid'])
            for port in profile.values():
                with socket.socket() as s:s.bind(('127.0.0.1',port))
            with contextlib.closing(sqlite3.connect(fixture/'data/db/daty-rf.sqlite3',timeout=.2)) as c:
                assert c.execute('pragma integrity_check').fetchone()[0]=='ok'
                c.execute('begin exclusive');c.rollback()
            report={'ok':True,'case':'desktop-owner-exit','backend_exit_code':backend.returncode,'state':status['state'],
                    'ports_released':True,'writer_exited':True,'database_integrity':'ok','physical_commands':0}
            (output/'result.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
            print(json.dumps({**report,'evidence':str(output)}))
        finally:
            if owner.stdin and not owner.stdin.closed:owner.stdin.close()
            owner.wait(timeout=5)
            if backend.poll() is None:
                # Normal cleanup even when an assertion fails; never kill the writer.
                if status_file.exists():
                    status=json.loads(status_file.read_text('utf-8'))
                    if status.get('pid')==backend.pid:local.atomic(fixture/'runtime/stop.request.json',{'boot_id':status['boot_id']})
                backend.wait(timeout=35)


if __name__=='__main__':main()
