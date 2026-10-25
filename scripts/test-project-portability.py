from pathlib import Path
import sys,subprocess,json,importlib.util,tempfile,shutil,contextlib,sqlite3
r=Path(__file__).resolve().parent.parent;sys.path.insert(0,str(r/'scripts'));from project_identity import host_id,instance_root
p=subprocess.check_output([str(r/'tools/dotnet/dotnet.exe'),str(r/'native/tests/Daty.Native.Tests/bin/Release/net10.0/Daty.Native.Tests.dll'),'--host-id'],text=True).strip();assert p==host_id();print('PASS Python and WPF host keys match')
spec=importlib.util.spec_from_file_location('pl',r/'scripts/project-local.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='daty-other-pc-') as t:
 root=Path(t).resolve();(root/'config').mkdir();shutil.copy2(r/'config/project-development.json',root/'config/project-development.json');old_identity={'host_id':'f'*32 if host_id()!='f'*32 else 'e'*32,'epoch':'0'*32,'ca_sha256':'0'*64};(root/'config/project-instance.local.json').write_text(json.dumps(old_identity));(root/'data/security').mkdir(parents=True);(root/'data/security/keep.txt').write_text('old keys never opened')
 local=instance_root(root);assert local==root/'.local-instances'/host_id()
 # Route code resources to the real source; only the new per-computer data root is a fixture.
 oldbase=m.base;m.base=lambda:local
 try:
  a=m.prepare();i=json.loads((local/'config/project-instance.local.json').read_text());m.prepare();assert json.loads((local/'config/project-instance.local.json').read_text())==i
  assert i['epoch']!=old_identity['epoch'] and i['ca_sha256']!=old_identity['ca_sha256']
  assert json.loads((root/'config/project-instance.local.json').read_text())==old_identity
  assert (root/'data/security/keep.txt').read_text()=='old keys never opened'
  assert Path(a['database']).is_relative_to(local)
  with contextlib.closing(sqlite3.connect(a['database'])) as c:assert c.execute('select count(*) from live_samples').fetchone()[0]==0
 finally:m.base=oldbase
print('PASS different host uses new epoch/CA/empty database, preserves old state, and restart retains new identity')
