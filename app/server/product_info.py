"""Product/build identity shared by the launcher and the running service.

Hashes detect incomplete/mixed installations; they are not a publisher signature.
No Git, SDK, credentials or writable business connection is needed at runtime.
"""
import hashlib
import json
import re
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
BUILD_RECORD = 'config/product-build.local.json'
IDENTITY_FIELDS = ('product', 'version', 'buildId', 'contractSchema', 'databaseSchema')


def read_product(root=ROOT):
    value = json.loads((Path(root)/'config/product.json').read_text('utf-8-sig'))
    if (set(value) != {'schema', 'product', 'version'} or value['schema'] != 'daty-product-v1'
            or value['product'] != 'DATY RF PRO'
            or not isinstance(value['version'], str)
            or not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value['version'])
            or any(int(v) > 65534 for v in value['version'].split('.'))):
        raise ValueError('产品版本配置无效，请使用完整发布包')
    return value


def checked_file(root, name):
    root = Path(root).absolute()
    part = PurePosixPath(name)
    if (not isinstance(name, str) or not name or '\\' in name or ':' in name
            or part.is_absolute() or any(p in ('', '.', '..') for p in name.split('/'))):
        raise ValueError('Invalid program path: '+str(name))
    path = root.joinpath(*part.parts)
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('Program path escapes installation')
    for parent in (path, *path.parents):
        if parent.is_symlink() or parent.is_junction():
            raise ValueError('Program path links forbidden: '+name)
        if parent == root:
            break
    if not path.is_file() or path.stat().st_nlink != 1:
        raise ValueError('Program file missing/linked: '+name)
    return path


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def installed_build(root=ROOT, *, verify_files=False):
    root = Path(root)
    product = read_product(root)
    record = json.loads(checked_file(root, BUILD_RECORD).read_text('utf-8'))
    if (record.get('schema') != 'daty-product-build-v1'
            or any(record.get(k) != product[k] for k in ('product', 'version'))
            or not re.fullmatch('[0-9a-f]{64}', str(record.get('buildId', '')))
            or record.get('contractSchema') != 'daty-mqtt6-app-v1'
            or type(record.get('databaseSchema')) is not int):
        raise ValueError('程序版本或构建身份不匹配，请重新构建或使用完整发布包')
    if verify_files:
        files = record.get('runtimeFiles')
        if not isinstance(files, dict) or not files:
            raise ValueError('Missing runtime inventory')
        for name, expected in files.items():
            if digest(checked_file(root, name)) != expected:
                raise ValueError('程序文件与本次构建不一致：'+name)
    return record


def identity(root=ROOT):
    build = installed_build(root)
    return {key: build[key] for key in IDENTITY_FIELDS}


def require_identity(actual, expected):
    if not isinstance(actual, dict) or any(actual.get(k) != expected[k] for k in IDENTITY_FIELDS):
        raise ValueError('界面与后台版本或构建批次不一致，请关闭旧窗口后使用同一完整发布包')
