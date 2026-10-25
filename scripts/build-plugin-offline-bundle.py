"""Build DATY's standalone source plugin bundle without vendor installers.
SystemAPI is a design reference, not a product dependency.
"""
from pathlib import Path
import argparse, hashlib, json, zipfile
root = Path(__file__).resolve().parents[1]


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def build():
    catalog = json.loads((root/'native/assets/plugin-sources.json').read_bytes())
    plugin = next(p for p in catalog if p['id'] == 'shure-scp')
    if Path(plugin['fileName']).name != plugin['fileName']:
        raise ValueError('Invalid source package name')
    source = root/'plugins/packages'/plugin['fileName']
    if source.stat().st_size != plugin['bytes'] or sha(source) != plugin['sha256']:
        raise ValueError('Reviewed source package mismatch')
    manifest = {'schema': 'daty-plugin-offline-bundle-v1', 'id': plugin['id'],
        'brand': plugin['brand'], 'version': plugin['revision'],
        'plugin': {'path': 'plugin/'+source.name, 'sha256': plugin['sha256'],
                   'bytes': source.stat().st_size}, 'runtimes': []}
    directory = root/'native/assets/plugin-bundles'
    directory.mkdir(parents=True, exist_ok=True)
    target = directory/f"DATY-{plugin['id']}-{plugin['revision']}-full.zip"
    readme = ('# DATY 舒尔完整源码插件包\n\n'
        '在 DATY RF PRO V1.0.3-0.4.56 或兼容新版的品牌插件管理中直接导入本 ZIP。\n'
        '发现、实时监测、重连、能力判断、指令下发及独立回读均由 DATY 自有 SCP 源码实现。\n'
        'SystemAPI 仅作开发设计参考；本包不包含或安装官方程序，不读取其认证材料。\n'
        '源码及逐文件摘要见内层 ZIP；依赖 DATY 母平台提供的运行时和真实数据库事务。\n'
        '旧固件按真实 SCP 回报选择兼容协议；已知硬件频段仍参与校验，执行结果以实际回读为准。\n'
        '支持已验证的 ULXD4 WWB SDB3 双记录扫描文件解析，保留真实频率、电平、缺失点及 CRC 校验。\n'
        '已验证机身频段的 ULXD4 可直接扫描：自有会话协商、状态回读、真实点接收及停止清理均包含在插件内。\n'
        '开始、结束和数据完整性分别确认；缺失或未解码位置保持空值，不把单频点或文件导入冒充实时扫描。\n'
        '不包含业务数据库、配对、私钥、现场机身绑定或遥测缓存。\n')
    entries = [('bundle.json', (json.dumps(manifest, ensure_ascii=False, indent=2)+'\n').encode()),
               ('README.md', readme.encode()), (manifest['plugin']['path'], source.read_bytes())]
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
    entry = {'id': plugin['id'], 'version': plugin['revision'], 'fileName': target.name,
             'sha256': sha(target), 'bytes': target.stat().st_size, 'pluginSha256': plugin['sha256']}
    (root/'native/assets/plugin-bundles.json').write_text(
        json.dumps([entry], ensure_ascii=False, indent=2)+'\n', 'utf-8')
    return entry


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    print(json.dumps(build(), ensure_ascii=False))
