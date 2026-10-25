"""Bind the portable entry and self-contained publication to the source commit."""
import hashlib, json
from pathlib import Path

ENTRY = 'DATY RF PRO.exe'
RECORD = 'config/portable-release.local.json'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def publication(root):
    profile = json.loads((root/'config/project-development.json').read_text('utf-8'))
    path = (root/profile['native_output']).resolve()
    if not path.is_relative_to((root/'native/publish').resolve()):
        raise ValueError('Invalid portable publication')
    return path


def release_files(root):
    output = publication(root)
    for required in ('DATY.RF.Native.exe', 'DATY.RF.Native.dll', 'hostfxr.dll', 'coreclr.dll', 'PresentationFramework.dll'):
        if not (output/required).is_file():
            raise ValueError('Self-contained release missing: '+required)
    return [root/ENTRY, *(p for p in output.rglob('*') if p.is_file())]


def record(root, commit, clean):
    root = root.resolve()
    files = {p.relative_to(root).as_posix(): {'bytes': p.stat().st_size, 'sha256': digest(p)}
             for p in release_files(root)}
    result = {'schema': 'daty-portable-release-v1', 'sourceCommit': commit,
              'sourceClean': clean, 'files': files}
    (root/RECORD).write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    return result


def verify(root, commit):
    root = root.resolve()
    result = json.loads((root/RECORD).read_text('utf-8'))
    if result.get('schema') != 'daty-portable-release-v1' or result.get('sourceCommit') != commit or result.get('sourceClean') is not True:
        raise ValueError('Portable executable does not match committed sources; publish again after committing')
    actual = {p.relative_to(root).as_posix(): p for p in release_files(root)}
    if set(actual) != set(result['files']):
        raise ValueError('Portable release file list changed; publish again')
    for name, path in actual.items():
        expected = result['files'][name]
        if path.stat().st_size != expected['bytes'] or digest(path) != expected['sha256']:
            raise ValueError('Portable release missing/changed: '+name)
    return result
