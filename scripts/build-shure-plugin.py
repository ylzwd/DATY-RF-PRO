"""Development build and explicit catalog review input, never used by runtime."""
from pathlib import Path
import base64,hashlib,importlib.util,json
root=Path(__file__).resolve().parents[1];server=root/'app/server'
spec=importlib.util.spec_from_file_location('plugin_exports',server/'scripts/build-plugin-exports.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
registry=server/'contracts/brand-plugin-exports.json'
payload=module.build(server,registry)
(server/'src/modules/plugin-source-catalog.js').write_text(payload,'utf-8')
module.package_public(server,root/'app/public',payload)
# These two public assets are generated together with the plugin catalog.
# Keep their approved static-file digests synchronized, otherwise the next
# project launch rejects an otherwise valid rebuilt package before startup.
static_manifest=root/'app/public/candidate-manifest.json'
static=json.loads(static_manifest.read_bytes())
for name in ('src/modules/discovery.js','unirf-app.html'):
    if name not in static['files']:raise ValueError('Generated asset missing from static allowlist: '+name)
    static['files'][name]=hashlib.sha256((root/'app/public'/name).read_bytes()).hexdigest()
static_manifest.write_text(json.dumps(static,ensure_ascii=False,indent=2)+'\n','utf-8')
catalog=json.loads(payload.split('Object.freeze(',1)[1].rsplit(');',1)[0])
(root/'native/assets/plugin-sources.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n','utf-8')
package=next(p for p in catalog if p['id']=='shure-scp');raw=base64.b64decode(package['base64'])
path=root/'plugins/packages'/package['fileName'];path.write_bytes(raw)
definition=json.loads(registry.read_bytes())['plugins'][0]
release={k:definition[k] for k in ('id','brand','name','adapterKeys')}
release.update(definition['release'],version=package['revision'],sha256=package['sha256'])
p=server/'contracts/trusted-plugin-packages.json';trusted=json.loads(p.read_bytes())
trusted['releases']=[r for r in trusted['releases'] if r['sha256']!=release['sha256']]+[release]
p.write_text(json.dumps(trusted,ensure_ascii=False,indent=2)+'\n','utf-8')
print(json.dumps({k:v for k,v in package.items() if k!='base64'},ensure_ascii=False))
