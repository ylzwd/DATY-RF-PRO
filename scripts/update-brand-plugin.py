"""Maintenance-only installer; stop normal server first. Does not start devices."""
from pathlib import Path
import argparse,json,sys
p=argparse.ArgumentParser()
for name in ('config','package','expected-sha256','operation-id'):p.add_argument('--'+name,required=True)
p.add_argument('--expected-revision',type=int,required=True);a=p.parse_args()
root=Path(__file__).resolve().parents[1];server=root/'app/server'
sys.path[:0]=[str(root/'app/tools/pylib'),str(server),*[str(server/f'prototypes/mqtt-stage{n}') for n in range(6,0,-1)]]
from m6_scope import RuntimeScope
from plugin_install import PluginStore,PackageCatalog
from plugin_maintenance import replace_plugin
scope=RuntimeScope(Path(a.config).resolve())
try:
    store=PluginStore(scope.archives.parent/'plugins',PackageCatalog(server/'contracts/trusted-plugin-packages.json'))
    result=replace_plugin(store,scope,Path(a.package).read_bytes(),operation_id=a.operation_id,expected_revision=a.expected_revision,expected_sha256=a.expected_sha256,actor='local-maintenance')
    print(json.dumps(result,ensure_ascii=False))
finally:scope.close()
