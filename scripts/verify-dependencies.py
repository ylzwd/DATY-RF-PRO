"""Read-only verification of the reviewed, locally carried toolchain."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parent.parent
inventory=json.loads((root/'config/dependency-inventory.json').read_text('utf-8'))
for name,expected in inventory['files'].items():
    path=root/name
    if not path.resolve().is_relative_to(root):raise ValueError('Inventory path escape')
    with path.open('rb') as source:digest=hashlib.file_digest(source,'sha256').hexdigest()
    if path.stat().st_size!=expected['bytes'] or digest!=expected['sha256']:raise ValueError('Dependency mismatch: '+name)
print(json.dumps({'ok':True,'files':len(inventory['files']),'bytes':sum(v['bytes'] for v in inventory['files'].values())}))
