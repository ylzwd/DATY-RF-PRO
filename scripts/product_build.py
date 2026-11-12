"""Generate product metadata and nested inventories, then verify them as a unit."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'app/server'))
from product_info import read_product, digest, installed_build, BUILD_RECORD, checked_file

RUNTIME_SCRIPTS = ('project-local.py', 'project_desktop.py', 'project_service.py',
                   'project_identity.py', 'project_plugin_upgrade.py', 'project_release.py',
                   'product_distribution.py')


def write(path, data):
    old = path.read_bytes() if path.exists() else b''
    raw = data.encode('utf-8')
    if b'\r\n' in old:
        raw = raw.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
    if raw != old:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)


def write_json(path, value):
    write(path, json.dumps(value, ensure_ascii=False, indent=2)+'\n')


def synchronize(root=ROOT):
    root = Path(root)
    product = read_product(root)
    version = product['version']
    server = root/'app/server/version.json'
    value = json.loads(server.read_bytes()); value['version'] = version
    write_json(server, value)
    profile = root/'config/project-development.json'
    value = json.loads(profile.read_bytes()); value['native_output'] = 'native/publish/'+version
    write_json(profile, value)
    readme = root/'README.md'
    text = readme.read_text('utf-8')
    block = '<!-- product-version:start -->\n**当前统一版本：V'+version+' ｜ Windows 原生一体化产品**\n<!-- product-version:end -->'
    text, count = re.subn(r'<!-- product-version:start -->.*?<!-- product-version:end -->', block, text, flags=re.S)
    if count != 1:
        raise ValueError('README requires exactly one generated product version block')
    write(readme, text)
    candidate = root/'app/public/candidate-manifest.json'
    value = json.loads(candidate.read_bytes())
    for name in value['files']:
        value['files'][name] = digest(checked_file(root/'app/public', name))
    write_json(candidate, value)
    package = root/'app/package-manifest.json'
    value = json.loads(package.read_bytes())
    # Browser automation is a development dependency, not a service dependency.
    value['files'] = {n:d for n,d in value['files'].items() if not n.startswith('tools/playwright/')}
    value['files']['server/product_info.py'] = digest(root/'app/server/product_info.py')
    for name in value['files']:
        value['files'][name] = digest(checked_file(root/'app', name))
    write_json(package, value)
    layout = root/'project-layout.json'
    value = json.loads(layout.read_bytes()); value['packageManifestSha256'] = digest(package)
    write_json(layout, value)
    return product


def runtime_files(root=ROOT):
    package = json.loads((root/'app/package-manifest.json').read_bytes())
    names = {'app/'+name for name in package['files']}
    names.update(('app/package-manifest.json', 'config/product.json', 'config/project-development.json',
                  'project-layout.json', 'LICENSE', 'README.md', '启动DATY RF PRO.vbs'))
    names.update('scripts/'+name for name in RUNTIME_SCRIPTS)
    for path in (root/'native/assets').glob('*.json'):
        names.add(path.relative_to(root).as_posix())
    names.update(path.relative_to(root).as_posix() for path in (root/'plugins/packages').glob('*.zip'))
    return {name: digest(checked_file(root, name)) for name in sorted(names)}


def prepare(root=ROOT):
    root = Path(root)
    product = synchronize(root)
    git = root/'tools/git/cmd/git.exe'
    def output(*args):
        return subprocess.check_output([str(git), '-C', str(root), *args], creationflags=subprocess.CREATE_NO_WINDOW)
    names = sorted(set(n for n in output('ls-files', '--cached', '--others', '--exclude-standard', '-z').decode('utf-8').split('\0') if n))
    source = {name: digest(checked_file(root, name)) for name in names}
    source_digest = hashlib.sha256(json.dumps(source, sort_keys=True).encode()).hexdigest()
    contract = json.loads((root/'contracts/r19-mqtt-app.json').read_bytes())['schema']
    from unified_database import SCHEMA_VERSION
    commit = output('rev-parse', 'HEAD').decode().strip()
    build = {'schema': 'daty-product-build-v1', 'product': product['product'], 'version': product['version'],
             'sourceCommit': commit, 'sourceClean': not bool(output('status', '--porcelain').strip()),
             'sourceDigest': source_digest, 'contractSchema': contract, 'databaseSchema': SCHEMA_VERSION}
    build['buildId'] = hashlib.sha256(json.dumps(build, sort_keys=True).encode()).hexdigest()
    build['runtimeFiles'] = runtime_files(root)
    write_json(root/BUILD_RECORD, build)
    props = '<Project><PropertyGroup><Version>{v}</Version><AssemblyVersion>{v}.0</AssemblyVersion><FileVersion>{v}.0</FileVersion><InformationalVersion>{v}+{b}</InformationalVersion></PropertyGroup><ItemGroup><AssemblyMetadata Include="ProductVersion" Value="{v}" /><AssemblyMetadata Include="ProductBuildId" Value="{b}" /><AssemblyMetadata Include="ProductContract" Value="{c}" /><AssemblyMetadata Include="ProductDatabaseSchema" Value="{d}" /></ItemGroup></Project>\n'
    write(root/'config/product-build.local.props', props.format(v=build['version'], b=build['buildId'], c=contract, d=SCHEMA_VERSION))
    verify(root)
    return build


def verify(root=ROOT):
    root = Path(root)
    build = installed_build(root, verify_files=True)
    for manifest, base in (('app/public/candidate-manifest.json', 'app/public'), ('app/package-manifest.json', 'app')):
        for name, expected in json.loads((root/manifest).read_bytes())['files'].items():
            if digest(checked_file(root/base, name)) != expected:
                raise ValueError('Nested manifest mismatch: '+name)
    layout = json.loads((root/'project-layout.json').read_bytes())
    if layout['packageManifestSha256'] != digest(root/'app/package-manifest.json'):
        raise ValueError('Layout manifest mismatch')
    return build


if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser(); p.add_argument('action', choices=('prepare', 'verify'))
    result = prepare() if p.parse_args().action == 'prepare' else verify()
    print(json.dumps({key: result[key] for key in ('version', 'buildId', 'sourceCommit', 'sourceClean')}, indent=2))
