"""Export/verify a runtime-only ZIP; upgrade owned program files with recovery.

Run upgrades using the NEW package's Python, outside the installation being
updated. Private data is never selected for replacement or rollback.
"""
import argparse
import contextlib
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import stat
import sys
import time
import uuid
import zipfile

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'app/server'),str(ROOT/'scripts')]
from product_info import checked_file, digest, identity, installed_build

MANIFEST='distribution-manifest.json'
JOURNAL='config/update-journal.local.json'
PREFIX='DATY RF PRO/'
LIMIT=8*1024**3


def program_name(name):
    if (not isinstance(name,str) or not name or '\\' in name or ':' in name
            or any(p in ('','.','..') for p in name.split('/')) or PurePosixPath(name).is_absolute()):
        raise ValueError('Invalid archive program path')
    reserved={'CON','PRN','AUX','NUL',*(f'COM{i}' for i in range(1,10)),*(f'LPT{i}' for i in range(1,10))}
    if any(p.endswith((' ','.')) or p.split('.')[0].upper() in reserved or any(ord(c)<32 for c in p) for p in name.split('/')):
        raise ValueError('Noncanonical Windows program path')
    allowed=(name in ('DATY RF PRO.exe','README.md','LICENSE','启动DATY RF PRO.vbs',
                      'project-layout.json',MANIFEST,'config/product.json','config/project-development.json',
                      'config/product-build.local.json','config/portable-release.local.json')
             or name.startswith(('app/server/','app/public/','app/FAshe/','app/tools/python/',
                                  'app/tools/pylib/','app/tools/broker/','app/tools/node/',
                                  'native/publish/','native/assets/','plugins/packages/'))
             or name in ('app/service-launch.py','app/package-manifest.json','app/release-manifest.json','app/maintenance-schema.py')
             or (name.startswith('scripts/') and name.count('/')==1 and name.endswith('.py')))
    if not allowed or any(p in ('.git','__pycache__','node_modules') for p in name.split('/')):
        raise ValueError('Private/development path forbidden in runtime package: '+name)
    return name


def atomic_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+'.tmp-'+uuid.uuid4().hex)
    try:
        with temp.open('x',encoding='utf-8') as stream:
            json.dump(value,stream,ensure_ascii=False,indent=2);stream.flush();os.fsync(stream.fileno())
        replace_file(temp,path)
    finally:
        if temp.exists():temp.unlink()


def replace_file(source,target):
    # Windows readers/virus scanners may briefly deny rename sharing. Keep
    # retries bounded; persistent faults still enter the recovery path.
    for attempt in range(16):
        try:os.replace(source,target);return
        except PermissionError:
            if attempt==15:raise
            time.sleep(min(.02*(attempt+1),.15))


def durable_copy(source,target):
    with Path(source).open('rb') as incoming,Path(target).open('xb') as output:
        shutil.copyfileobj(incoming,output);output.flush();os.fsync(output.fileno())


def verify_directory(root):
    root=Path(root)
    manifest=json.loads(checked_file(root,MANIFEST).read_text('utf-8'))
    if manifest.get('schema')!='daty-runtime-distribution-v1' or not manifest.get('files'):
        raise ValueError('Invalid runtime distribution')
    total=0
    for name,row in manifest['files'].items():
        program_name(name)
        path=checked_file(root,name)
        if path.stat().st_size!=row['bytes'] or digest(path)!=row['sha256']:
            raise ValueError('Distribution file mismatch: '+name)
        total+=row['bytes']
    if total>LIMIT:raise ValueError('Runtime package exceeds size limit')
    build=installed_build(root,verify_files=True)
    if manifest['product']!=identity(root):raise ValueError('Distribution build identity mismatch')
    from project_release import verify_installed
    verify_installed(root)
    return manifest


def export_runtime(root=ROOT, *, require_clean=True):
    root=Path(root)
    build=installed_build(root,verify_files=True)
    from project_release import verify_installed
    release=verify_installed(root)
    if require_clean:
        from project_release import verify
        verify(root,build['sourceCommit'])
        import subprocess
        git=root/'tools/git/cmd/git.exe'
        commit=subprocess.check_output([str(git),'-C',str(root),'rev-parse','HEAD'],creationflags=subprocess.CREATE_NO_WINDOW).decode().strip()
        if commit!=build['sourceCommit']:raise ValueError('Publish the current commit before exporting')
        if subprocess.check_output([str(git),'-C',str(root),'status','--porcelain'],creationflags=subprocess.CREATE_NO_WINDOW).strip():
            raise ValueError('Commit and publish current sources before exporting a release')
    names=set(build['runtimeFiles'])|set(release['files'])
    names.update(('config/product-build.local.json','config/portable-release.local.json'))
    dependency=json.loads((root/'config/dependency-inventory.json').read_bytes())['files']
    selected={n:row for n,row in dependency.items() if n.startswith(('app/tools/python/','app/tools/pylib/','app/tools/broker/','app/tools/node/','native/assets/plugin-bundles/'))}
    for name,row in selected.items():
        path=checked_file(root,program_name(name))
        if path.stat().st_size!=row['bytes'] or digest(path)!=row['sha256']:
            raise ValueError('Runtime dependency changed: '+name)
    names.update(selected)
    out=root/'delivery';out.mkdir(exist_ok=True)
    destination=out/('DATY-RF-PRO-'+build['version']+'-windows-x64-'+build['buildId'][:12]+'.zip')
    if destination.exists():raise FileExistsError(destination)
    partial=destination.with_suffix('.partial')
    files={}
    with zipfile.ZipFile(partial,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
        for name in sorted(names):
            path=checked_file(root,program_name(name));before=digest(path)
            files[name]={'bytes':path.stat().st_size,'sha256':before}
            archive.write(path,PREFIX+name)
            if digest(path)!=before:raise ValueError('Program changed during export: '+name)
        manifest={'schema':'daty-runtime-distribution-v1','product':identity(root),
                  'sourceCommit':build['sourceCommit'],'sourceClean':build['sourceClean'],
                  'databaseSchemaMin':build['databaseSchema'],'databaseSchemaMax':build['databaseSchema'],'files':files}
        archive.writestr(PREFIX+MANIFEST,json.dumps(manifest,ensure_ascii=False,indent=2))
    if require_clean:
        current=subprocess.check_output([str(git),'-C',str(root),'rev-parse','HEAD'],creationflags=subprocess.CREATE_NO_WINDOW).decode().strip()
        dirty=subprocess.check_output([str(git),'-C',str(root),'status','--porcelain'],creationflags=subprocess.CREATE_NO_WINDOW).strip()
        if current!=build['sourceCommit'] or dirty:
            raise ValueError('Sources changed during export; incomplete ZIP retained for diagnosis')
    verify_archive(partial)
    os.replace(partial,destination)
    receipt={'file':destination.name,'sha256':digest(destination),'bytes':destination.stat().st_size,
             'files':len(files),'product':identity(root),'sourceCommit':build['sourceCommit'],
             'sourceClean':build['sourceClean'],'includesGit':False,'includesSDK':False,'includesPrivateData':False}
    atomic_json(destination.with_suffix('.json'),receipt)
    return receipt


def verify_archive(path, expected_sha256=None):
    path=Path(path)
    if expected_sha256 is not None and digest(path)!=expected_sha256.lower():
        raise ValueError('ZIP SHA256 mismatch')
    with zipfile.ZipFile(path) as archive:
        infos=archive.infolist()
        if len(infos)>10000 or sum(i.file_size for i in infos)>LIMIT:
            raise ValueError('Archive limits exceeded')
        names={};case_names=set()
        for info in infos:
            if not info.filename.startswith(PREFIX) or info.is_dir() or stat.S_ISLNK(info.external_attr>>16):
                raise ValueError('Invalid ZIP member')
            name=program_name(info.filename[len(PREFIX):])
            if name.casefold() in case_names or info.flag_bits&1 or info.file_size>512*1024**2:
                raise ValueError('Duplicate/encrypted/oversized ZIP member')
            case_names.add(name.casefold());names[name]=info
        if MANIFEST not in names or names[MANIFEST].file_size>4*1024**2:
            raise ValueError('Missing distribution manifest')
        manifest=json.loads(archive.read(names[MANIFEST]))
        if manifest.get('schema')!='daty-runtime-distribution-v1' or set(names)!=(set(manifest['files'])|{MANIFEST}):
            raise ValueError('Archive file inventory mismatch')
        for name,row in manifest['files'].items():
            info=names[name]
            with archive.open(info) as stream:actual=hashlib.file_digest(stream,'sha256').hexdigest()
            if info.file_size!=row['bytes'] or actual!=row['sha256']:
                raise ValueError('Archive content mismatch: '+name)
    return manifest


def extract_verified(path,destination,expected_sha256):
    # Verify all paths before creating any files. ZIP symlinks and duplicate paths
    # are rejected; no extractall or archive-provided absolute path is used.
    manifest=verify_archive(path,expected_sha256)
    destination=Path(destination);destination.mkdir(exist_ok=False)
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            name=program_name(info.filename[len(PREFIX):]);target=destination/name
            target.parent.mkdir(parents=True,exist_ok=True)
            with archive.open(info) as source,target.open('xb') as output:shutil.copyfileobj(source,output)
    verify_directory(destination)
    return manifest


def database_schemas(root):
    roots=[root]
    local=root/'.local-instances'
    if local.exists():
        if local.is_symlink() or local.is_junction():raise ValueError('Linked instances forbidden')
        roots.extend(p for p in local.iterdir() if p.is_dir())
    versions=[]
    for base in roots:
        path=base/'data/db/daty-rf.sqlite3'
        if path.exists():
            checked_file(root,path.relative_to(root).as_posix())
            # The caller holds the stopped-installation lease. Ordinary mode=ro
            # can still create/update WAL shared memory; immutable prevents it.
            # Never ignore uncheckpointed WAL or a recovery journal to read an
            # older schema from the main file. Leave recovery to normal startup.
            for suffix in ('-wal','-journal'):
                log=path.with_name(path.name+suffix)
                if log.exists():
                    checked_file(root,log.relative_to(root).as_posix())
                    if log.stat().st_size:
                        raise ValueError('数据库仍有待恢复或待检查点日志；请正常启动并关闭原版本后重试，未改写数据')
            with contextlib.closing(sqlite3.connect(path.as_uri()+'?mode=ro&immutable=1',uri=True)) as db:
                versions.append(db.execute('pragma user_version').fetchone()[0])
    return versions


def require_database_compatible(root,manifest):
    minimum,maximum=manifest['databaseSchemaMin'],manifest['databaseSchemaMax']
    if type(minimum) is not int or type(maximum) is not int or minimum>maximum:
        raise ValueError('Invalid database compatibility declaration')
    if any(not minimum<=v<=maximum for v in database_schemas(root)):
        raise ValueError('数据库结构与目标版本不兼容；未替换程序或业务数据')


@contextlib.contextmanager
def update_lease(root):
    # Same exclusive lease as launch_desktop; an updater never kills processes.
    from project_identity import instance_root
    sys.path.insert(0,str(ROOT/'app/server/prototypes/mqtt-stage3'))
    from command_journal import ProcessLease
    from project_desktop import native_processes,process_image
    local=instance_root(root)
    (local/'runtime').mkdir(parents=True,exist_ok=True)
    lease=ProcessLease(str(local/'runtime/project-launch.lock'))
    try:
        if native_processes(root):raise ValueError('请先正常关闭目标目录的所有 DATY RF PRO 窗口')
        for base in [root,*((root/'.local-instances').iterdir() if (root/'.local-instances').exists() else [])]:
            status=base/'runtime/runtime-status.json'
            if status.exists():
                value=json.loads(status.read_text('utf-8'))
                image=process_image(value.get('pid',0))
                if image is not None and image.resolve()==(root/'app/tools/python/python.exe').resolve():
                    raise ValueError('目标后台仍在运行，请等待正常停服后重试')
        yield
    finally:lease.close()


def safe_target(root,name,*,temporary_of=None):
    if temporary_of is None:program_name(name)
    else:
        program_name(temporary_of)
        if not re.fullmatch(re.escape(temporary_of)+r'\.tmp-[0-9a-f]{32}',name):raise ValueError('Invalid owned temporary path')
    path=root/name
    if not path.resolve().is_relative_to(root):raise ValueError('Update path escaped target')
    for parent in (path,*path.parents):
        if parent.is_symlink() or parent.is_junction():raise ValueError('Linked update target forbidden')
        if parent==root:break
    if path.exists() and (not path.is_file() or path.stat().st_nlink!=1):raise ValueError('Invalid update target')
    return path


def restore(root,journal):
    backup=Path(journal['backup'])
    if backup.parent!=root.parent or not backup.name.startswith('.daty-program-backup-'):
        raise ValueError('Invalid program backup location')
    # Validate all backups BEFORE restoring the first byte.
    for entry in journal['entries']:
        safe_target(root,entry['name'])
        temporary=entry.get('temporary','')
        if not re.fullmatch(re.escape(entry['name'])+r'\.tmp-[0-9a-f]{32}',temporary):
            raise ValueError('Invalid owned temporary path')
        safe_target(root,temporary,temporary_of=entry['name'])
        if entry['existed'] and digest(checked_file(backup,entry['name']))!=entry['sha256']:
            raise ValueError('Program backup damaged; recovery remains pending')
    for entry in reversed(journal['entries']):
        target=safe_target(root,entry['name'])
        temp=safe_target(root,entry['temporary'],temporary_of=entry['name'])
        if temp.exists():temp.unlink()
        if entry['existed']:
            if target.exists() and digest(target)==entry['sha256']:continue
            target.parent.mkdir(parents=True,exist_ok=True)
            durable_copy(backup/entry['name'],temp);replace_file(temp,target)
        elif target.exists():target.unlink()
    journal['state']='rolled-back';atomic_json(root/JOURNAL,journal)


def apply_program(root,incoming,*,fault=None):
    root=Path(root).resolve();incoming=Path(incoming).resolve()
    if root==incoming or root.is_relative_to(incoming) or incoming.is_relative_to(root):raise ValueError('New package must be outside target')
    if (root/'.git').exists():raise ValueError('开发仓库请使用构建流程；升级工具仅用于独立使用包')
    pending=root/JOURNAL
    if pending.exists() and json.loads(pending.read_bytes()).get('state') not in ('completed','rolled-back'):
        raise ValueError('Previous update is pending; run recover first')
    new=verify_directory(incoming)
    if (root/MANIFEST).exists():
        old=verify_directory(root)
        old_names=set(old['files'])|{MANIFEST}
    else:
        raise ValueError('目标需为带 distribution-manifest.json 的统一使用包；旧开发目录请使用构建流程')
    require_database_compatible(root,new)
    require_database_compatible(root,old)
    backup=root.parent/('.daty-program-backup-'+uuid.uuid4().hex);backup.mkdir()
    journal={'schema':'daty-program-update-v1','state':'applying','backup':str(backup),
             'previousCompatibility':{k:old[k] for k in ('databaseSchemaMin','databaseSchemaMax')},'entries':[]}
    atomic_json(pending,journal)
    try:
        names=old_names|set(new['files'])|{MANIFEST}
        # Install the pending-update guard first, and restore it last. A crashed
        # upgrade cannot launch an otherwise partially replaced installation.
        for index,name in enumerate(sorted(names,key=lambda n:(n!='scripts/project-local.py',n))):
            target=safe_target(root,name);existed=target.exists()
            expected=new['files'].get(name)
            if existed and expected and target.stat().st_size==expected['bytes'] and digest(target)==expected['sha256']:continue
            if name==MANIFEST and existed and digest(target)==digest(incoming/name):continue
            entry={'name':name,'existed':existed,'temporary':name+'.tmp-'+uuid.uuid4().hex}
            if existed:
                source=checked_file(root,name);saved=backup/name;saved.parent.mkdir(parents=True,exist_ok=True)
                durable_copy(source,saved);entry['sha256']=digest(saved)
                if digest(source)!=entry['sha256']:raise ValueError('Target changed during backup')
            # Record intent before each replacement so power loss is recoverable.
            journal['entries'].append(entry);atomic_json(pending,journal)
            source=incoming/name
            if name in new['files'] or name==MANIFEST:
                checked_file(incoming,name);target.parent.mkdir(parents=True,exist_ok=True)
                temp=safe_target(root,entry['temporary'],temporary_of=name)
                durable_copy(source,temp);replace_file(temp,target)
            elif existed:target.unlink()
            if fault:fault(index)
        verify_directory(root)
        journal['state']='completed';journal['product']=new['product'];atomic_json(pending,journal)
    except Exception:
        restore(root,journal)
        raise
    return {'ok':True,'product':new['product'],'businessDataReplaced':False,'rollbackAvailable':True}


def recover(root):
    root=Path(root).resolve()
    journal=json.loads((root/JOURNAL).read_bytes())
    if journal.get('schema')!='daty-program-update-v1':raise ValueError('Invalid update journal')
    if journal['state']=='rolled-back':return {'ok':True,'state':'rolled-back'}
    require_database_compatible(root,journal['previousCompatibility'])
    restore(root,journal)
    return {'ok':True,'state':'rolled-back','businessDataReplaced':False}


def main():
    p=argparse.ArgumentParser(description='DATY RF PRO 使用包导出、核验与保留数据升级')
    sub=p.add_subparsers(dest='action',required=True)
    sub.add_parser('export')
    v=sub.add_parser('verify');v.add_argument('archive',type=Path);v.add_argument('--sha256')
    u=sub.add_parser('upgrade');u.add_argument('archive',type=Path);u.add_argument('--target',type=Path,required=True);u.add_argument('--sha256',required=True)
    r=sub.add_parser('recover');r.add_argument('--target',type=Path,required=True)
    a=p.parse_args()
    if a.action=='export':result=export_runtime()
    elif a.action=='verify':
        m=verify_archive(a.archive,a.sha256);result={'ok':True,'product':m['product'],'files':len(m['files'])}
    else:
        target=a.target.absolute()
        if not target.is_dir() or target.resolve()!=target or target==ROOT.resolve():raise ValueError('请选择独立使用包目录；升级器必须从新包运行')
        if a.action=='upgrade':
            incoming=target.parent/('.daty-program-incoming-'+uuid.uuid4().hex)
            extract_verified(a.archive,incoming,a.sha256)
            with update_lease(target):result=apply_program(target,incoming)
        else:
            with update_lease(target):result=recover(target)
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':
    try:main()
    except Exception as error:print(str(error),file=sys.stderr);raise SystemExit(1)
