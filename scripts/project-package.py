"""Seal/check complete development sources and export a clean offline ZIP."""
from pathlib import Path
import argparse,hashlib,json,os,platform,subprocess,sys,tempfile,time,zipfile
ROOT=Path(__file__).resolve().parent.parent
GIT=ROOT/'tools/git/cmd/git.exe'
MAX_DELIVERY_BYTES=1_000_000_000  # Decimal GB; never label a larger archive as the compact delivery.
sys.path.insert(0,str(ROOT/'scripts'))

def git(*args):
    return subprocess.check_output([str(GIT),'-C',str(ROOT),*args],stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
def hashfile(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def checked(name):
    p=ROOT/name
    if not p.resolve().is_relative_to(ROOT) or p.is_symlink() or not p.is_file():raise ValueError('Invalid source path: '+name)
    for parent in p.parents:
        if parent==ROOT:break
        if parent.is_junction() or parent.is_symlink():raise ValueError('Dependency path links forbidden: '+name)
    return p
def source_files():
    return [n for n in git('ls-files','-z').decode('utf-8').split('\0') if n]
def seal():
    if git('status','--porcelain').strip():raise ValueError('Commit source changes before sealing/exporting')
    files={n:hashfile(checked(n)) for n in source_files()}
    record={'schema':'daty-development-source-v1','commit':git('rev-parse','HEAD').decode().strip(),'files':files}
    (ROOT/'config/source-inventory.local.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return record
def verify():
    if sys.platform!='win32' or platform.machine().lower() not in ('amd64','x86_64'):raise ValueError('This package requires Windows x64')
    win=sys.getwindowsversion()
    if win.major<10 or win.build<19045:raise ValueError('Use Windows 10 22H2 or Windows 11 x64')
    source=json.loads((ROOT/'config/source-inventory.local.json').read_text('utf-8'))
    if source['commit']!=git('rev-parse','HEAD').decode().strip():raise ValueError('Source snapshot does not match current Git commit; reseal after publishing')
    if set(source['files'])!=set(source_files()):raise ValueError('Tracked source file list differs from delivery; reseal after reviewed development changes')
    for n,digest in source['files'].items():
        if hashfile(checked(n))!=digest:raise ValueError('Source is missing/changed: '+n)
    dependency=json.loads((ROOT/'config/dependency-inventory.json').read_text('utf-8'))
    for n,row in dependency['files'].items():
        p=checked(n)
        if p.stat().st_size!=row['bytes'] or hashfile(p)!=row['sha256']:raise ValueError('Offline dependency missing/changed: '+n)
    if not (ROOT/'.git').is_dir() or (ROOT/'.git/objects/info/alternates').exists():raise ValueError('Independent Git repository required')
    git('fsck','--no-reflogs')
    from project_release import verify as verify_release
    release=verify_release(ROOT,source['commit'])
    # Reject restored caches that point to another machine; normal build clears/recreates obj.
    return {'ok':True,'sourceFiles':len(source['files']),'dependencyFiles':len(dependency['files']),'releaseFiles':len(release['files']),'commit':source['commit'],'platform':platform.platform(),'offlineFeed':True}
def export():
    source=seal();verified=verify()
    profile=json.loads((ROOT/'config/project-development.json').read_text('utf-8'))
    publication=ROOT/profile['native_output']
    if not (publication/'DATY.RF.Native.exe').is_file():raise ValueError('Publish the native executable first')
    names=set(source['files'])|set(json.loads((ROOT/'config/dependency-inventory.json').read_text('utf-8'))['files'])
    names.add('config/source-inventory.local.json')
    from project_release import ENTRY, RECORD
    names.update((ENTRY,RECORD))
    for base in [ROOT/'.git',publication]:
        for p in base.rglob('*'):
            if p.is_file():
                n=p.relative_to(ROOT).as_posix()
                if p.name.endswith('.lock'):raise ValueError('Git/build operation in progress')
                names.add(n)
    # Known build paths may contain public certificate resources; no private/local state is selected.
    forbidden=('data/','runtime/','.local-instances/','verification/','delivery/')
    for n in names:
        if n.startswith(forbidden) or (n.startswith('config/') and n.endswith('.local.json') and n not in ('config/source-inventory.local.json',RECORD)) or n=='config/runtime-config.json':raise ValueError('Private state selected: '+n)
    output=ROOT/'delivery';output.mkdir(exist_ok=True)
    final=output/('DATY-RF-PRO-source-'+time.strftime('%Y%m%d-%H%M%S')+'.zip');temporary=final.with_suffix('.partial')
    if temporary.exists() or final.exists():raise FileExistsError(final)
    snapshot={}
    try:
        with zipfile.ZipFile(temporary,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as archive:
            for n in sorted(names):
                p=checked(n);before=p.stat();digest=hashfile(p)
                archive.write(p,'DATY RF PRO/'+n)
                if p.stat().st_size!=before.st_size or p.stat().st_mtime_ns!=before.st_mtime_ns or hashfile(p)!=digest:raise ValueError('File changed during export: '+n)
                snapshot[n]={'bytes':before.st_size,'sha256':digest}
            if git('rev-parse','HEAD').decode().strip()!=source['commit'] or git('status','--porcelain').strip():raise ValueError('Sources changed during export')
            archive.writestr('DATY RF PRO/transfer-manifest.json',json.dumps({'schema':'daty-development-transfer-v1','sourceCommit':source['commit'],'files':snapshot},ensure_ascii=False,indent=2))
        if temporary.stat().st_size>=MAX_DELIVERY_BYTES:
            raise ValueError('开发包必须小于 1,000,000,000 字节；当前 '+str(temporary.stat().st_size)+' 字节，请检查重复发布资源')
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None:raise ValueError('Export ZIP CRC failure')
        os.rename(temporary,final)
        receipt={'ok':True,'file':str(final),'sha256':hashfile(final),'bytes':final.stat().st_size,'files':len(snapshot),'newIdentityOnFirstStart':True,'sizeLimitBytes':MAX_DELIVERY_BYTES,'compression':'ZIP Deflate level 6',**verified}
        final.with_suffix('.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
        return receipt
    except Exception:
        # Leave this uniquely named partial for diagnosis; never delete user exports.
        raise
def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['seal','verify','export']);a=p.parse_args()
    result=seal() if a.action=='seal' else verify() if a.action=='verify' else export()
    if a.action=='seal':result={'ok':True,'commit':result['commit'],'sourceFiles':len(result['files'])}
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':
    try:main()
    except Exception as e:print(str(e),file=sys.stderr);raise SystemExit(1)
