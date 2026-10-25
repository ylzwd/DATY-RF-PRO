"""Offline native build using only project-carried tools, no shell policy change."""
from pathlib import Path
import argparse,hashlib,json,os,shutil,subprocess,sys
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'scripts'))
def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['Build','Test','Publish'],nargs='?',default='Publish');args=parser.parse_args()
    dotnet=ROOT/'tools/dotnet/dotnet.exe'
    git=ROOT/'tools/git/cmd/git.exe'
    def git_output(*args):return subprocess.check_output([str(git),'-C',str(ROOT),*args],creationflags=subprocess.CREATE_NO_WINDOW).decode('utf-8').strip()
    build_commit=git_output('rev-parse','HEAD');build_clean=not bool(git_output('status','--porcelain'))
    profile=json.loads((ROOT/'config/project-development.json').read_text('utf-8'))
    env=dict(os.environ,DOTNET_ROOT=str(dotnet.parent),DOTNET_CLI_HOME=str(ROOT/'tools/dotnet-home'),NUGET_PACKAGES=str(ROOT/'tools/nuget-packages'),NUGET_HTTP_CACHE_PATH=str(ROOT/'tools/nuget-http-cache'),DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1',DOTNET_CLI_TELEMETRY_OPTOUT='1',DOTNET_NOLOGO='1',DOTNET_GENERATE_ASPNET_CERTIFICATE='false')
    def run(argv):subprocess.run([str(p) for p in argv],cwd=ROOT/'native',env=env,check=True,stdout=sys.stdout,stderr=sys.stderr,creationflags=subprocess.CREATE_NO_WINDOW)
    run([dotnet,'restore','DATY.RF.Native.slnx','--locked-mode','--configfile',ROOT/'NuGet.Config','-p:NuGetAudit=false'])
    run([dotnet,'build','DATY.RF.Native.slnx','-c','Release','--no-restore'])
    if args.action=='Test':
        run([ROOT/'app/tools/python/python.exe','-X','utf8','-B',ROOT/'scripts/test-project-desktop.py'])
        run([ROOT/'app/tools/python/python.exe','-X','utf8','-B',ROOT/'scripts/test-project-release.py'])
        fixture=ROOT/'verification/monitoring-rules-fixture.json';env['DATY_MONITORING_RULES_FIXTURE']=str(fixture)
        run([ROOT/'app/tools/python/python.exe','-X','utf8','-B',ROOT/'scripts/export-monitoring-fixture.py',fixture])
        run([dotnet,'run','--project','tests/Daty.Native.Tests/Daty.Native.Tests.csproj','-c','Release','--no-build','--',ROOT/'verification/native-core.json'])
        run([dotnet,'run','--project','tests/Daty.Native.Contracts.Tests/Daty.Native.Contracts.Tests.csproj','-c','Release','--no-build'])
    if args.action=='Publish':
        for b in json.loads((ROOT/'native/assets/plugin-bundles.json').read_text('utf-8')):
            if Path(b['fileName']).name!=b['fileName']:raise ValueError('Invalid bundle path')
            p=ROOT/'native/assets/plugin-bundles'/b['fileName']
            with p.open('rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
            if p.stat().st_size!=b['bytes'] or digest!=b['sha256']:raise ValueError('Reviewed offline bundle mismatch')
        output=(ROOT/profile['native_output']).resolve()
        if not output.is_relative_to(ROOT/'native/publish'):raise ValueError('Invalid publication directory')
        run([dotnet,'publish','src/Daty.Native.App/Daty.Native.App.csproj','-c','Release','-r','win-x64','--self-contained','true','-p:RestoreLockedMode=true','-p:NuGetAudit=false','-p:PublishSingleFile=false','-p:DebugType=None','-p:DebugSymbols=false','-o',output])
        shutil.copy2(ROOT/'native/THIRD-PARTY-NOTICES.md',output/'THIRD-PARTY-NOTICES.md')
        shutil.copytree(ROOT/'native/licenses',output/'licenses',dirs_exist_ok=True)
        templates=list((dotnet.parent/'packs/Microsoft.NETCore.App.Host.win-x64').glob('*/runtimes/win-x64/native/apphost.exe'))
        if len(templates)!=1:raise ValueError('Expected exactly one locked offline apphost template')
        from project_release import ENTRY, record
        managed=output/'DATY.RF.Native.dll'
        run([dotnet,ROOT/'native/tools/Daty.PortableHost/bin/Release/net10.0/Daty.PortableHost.dll',
             templates[0],ROOT/ENTRY,managed.relative_to(ROOT).as_posix(),managed])
        record(ROOT,build_commit,build_clean and git_output('rev-parse','HEAD')==build_commit and not bool(git_output('status','--porcelain')))
        print('Native executable: '+str(output/'DATY.RF.Native.exe'))
        print('Portable entry: '+str(ROOT/ENTRY))
if __name__=='__main__':
    try:main()
    except (OSError,ValueError,subprocess.CalledProcessError) as error:print(str(error),file=sys.stderr);raise SystemExit(1)
