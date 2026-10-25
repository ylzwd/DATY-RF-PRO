"""Upgrade only already-installed project plugins before backend activation."""
import base64, json, uuid
from pathlib import Path


def upgrade_installed(root, scope):
    from plugin_install import PluginStore, PackageCatalog
    from plugin_maintenance import replace_plugin
    root=Path(root)
    store=PluginStore(scope.archives.parent/'plugins',PackageCatalog(root/'app/server/contracts/trusted-plugin-packages.json'))
    catalog=json.loads((root/'native/assets/plugin-sources.json').read_bytes())
    results=[]
    for package in catalog:
        if package['id']!='shure-scp':continue
        state=store.status()
        previous=next((p for p in state['plugins'] if p['id']==package['id']),None)
        if not previous or previous['state']!='installed' or previous['sha256']==package['sha256']:continue
        results.append(replace_plugin(store,scope,base64.b64decode(package['base64'],validate=True),
            operation_id=uuid.uuid4().hex,expected_revision=state['revision'],
            expected_sha256=previous['sha256'],actor='project-startup-upgrade'))
    return results
