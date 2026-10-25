"""Read-only project and runtime path verification; never opens a write connection."""
from pathlib import Path
import hashlib,json,sys,sqlite3
root=Path(__file__).resolve().parents[1];layout=json.loads((root/'project-layout.json').read_text('utf-8'));app=root/layout['paths']['application']
manifest=app/'package-manifest.json'
assert hashlib.sha256(manifest.read_bytes()).hexdigest()==layout['packageManifestSha256']
package=json.loads(manifest.read_text('utf-8'))
for name,digest in package['files'].items():
    path=app/name;assert path.resolve().is_relative_to(app.resolve()),name
    assert hashlib.sha256(path.read_bytes()).hexdigest()==digest,name
sys.path.insert(0,str(root/'scripts'))
from project_identity import instance_root
independent=(root/'config/project-development.json').is_file()
local=instance_root(root) if independent else root
config=json.loads((local/layout['paths']['config']).read_text('utf-8-sig'))
for key,logical in [('database','database'),('archives','archives'),('staging','staging'),('runtime_directory','runtime'),('public_directory','webAssets')]:
    target=Path(config[key]).resolve();assert target==((root if logical=='webAssets' else local)/layout['paths'][logical]).resolve(),key
    assert target.is_relative_to(root.resolve()),key
    assert target.exists(),key
independent=(root/'config/project-development.json').is_file()
expected=json.loads((local/'config/project-instance.local.json').read_text('utf-8'))['epoch'] if independent else layout['databaseEpoch']
assert config['database_epoch']==expected
sys.path[:0]=[str(app/'tools/pylib'),str(app/'server'),*[str(app/f'server/prototypes/mqtt-stage{n}') for n in range(1,7)]]
from m6_scope import validate_database
validate_database(Path(config['database']),config['database_epoch'])
from tls_support import load_config
_,tls=load_config(Path(config['tls']));assert tls['ca_sha256']==config['ca_sha256']
if independent:
    assert Path(config['tls']).parent==local/'data/security'
    assert Path(config['pairing']).parent==local/'data/security'
print(json.dumps({'passed':True,'packageFiles':len(package['files']),'databaseEpoch':config['database_epoch'],'root':str(root),'security':'project-local protected directory' if independent else 'original protected system directory','fullDatabaseScan':False}))
