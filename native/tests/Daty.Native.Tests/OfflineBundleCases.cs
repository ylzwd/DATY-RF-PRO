using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using Daty.Native.Core;

static class OfflineBundleCases
{
    static void Check(bool condition){if(!condition)throw new Exception("Offline bundle assertion failed");}
    static async Task Reject(Func<Task> action){try{await action();}catch{return;}throw new Exception("Expected rejection");}
    static string Sha(byte[] raw)=>Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
    sealed class RecordingContext:SynchronizationContext
    {
        public int Posts;
        public override void Post(SendOrPostCallback callback,object? state){Interlocked.Increment(ref Posts);ThreadPool.QueueUserWorkItem(_=>callback(state));}
    }
    sealed class Fixture:IDisposable
    {
        public string Root=Path.Combine(Path.GetTempPath(),"daty-offline-test-"+Guid.NewGuid().ToString("N"));
        public byte[] Plugin="fixture-plugin"u8.ToArray(),Installer="fixture-installer-not-executable"u8.ToArray();
        public BundleManifest Manifest;
        public string PathName=>Path.Combine(Root,"bundle.zip");
        public Fixture()
        {
            Directory.CreateDirectory(Root);
            var security=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"daty-fixture-"+Guid.NewGuid().ToString("N"));
            Manifest=new("daty-plugin-offline-bundle-v1","fixture","v1","v1",new("plugin/source.zip",Sha(Plugin),Plugin.Length),[new("fixture-api","Fixture API","1","Fixture publisher","https://example.invalid",new("runtime/setup.exe",Sha(Installer),Installer.Length),new("https://127.0.0.1:12345/api",Path.Combine(security,"cert.cer"),Path.Combine(security,"key.txt"),"x-api-key"))]);
        }
        public BundleTrust Write(Action<ZipArchive>? extra=null,byte[]? installer=null)
        {
            using(var z=ZipFile.Open(PathName,ZipArchiveMode.Create))
            {
                void Add(string n,byte[] b){using var s=z.CreateEntry(n,CompressionLevel.NoCompression).Open();s.Write(b);}
                Add("bundle.json",JsonSerializer.SerializeToUtf8Bytes(Manifest));Add("README.md","fixture"u8.ToArray());Add(Manifest.Plugin.Path,Plugin);foreach(var runtime in Manifest.Runtimes)Add(runtime.Installer.Path,installer??Installer);extra?.Invoke(z);
            }
            var bytes=File.ReadAllBytes(PathName);return new("fixture","v1","bundle.zip",Sha(bytes),bytes.Length,Manifest.Plugin.Sha256);
        }
        public void Dispose(){Directory.Delete(Root,true);}
    }
    public static IEnumerable<(string Name,Func<Task> Run)> All()
    {
        yield return ("Import ZIP and catalog validation never require the caller UI context",()=>{
            using var f=new Fixture();f.Manifest=f.Manifest with {Runtimes=[]};var trust=f.Write();
            File.WriteAllBytes(Path.Combine(f.Root,"plugin-bundles.json"),JsonSerializer.SerializeToUtf8Bytes(new[]{trust}));
            var previous=SynchronizationContext.Current;var context=new RecordingContext();SynchronizationContext.SetSynchronizationContext(context);
            try
            {
                var task=PluginImportFile.OpenAsync(f.PathName,f.Root,default);
                Check(task.Wait(TimeSpan.FromSeconds(5)));var input=task.GetAwaiter().GetResult();
                try{Check(input.Package.SequenceEqual(f.Plugin)&&!input.RequiresDependencySetup&&context.Posts==0);}
                finally{input.DisposeAsync().AsTask().GetAwaiter().GetResult();}
            }
            finally{SynchronizationContext.SetSynchronizationContext(previous);}
            return Task.CompletedTask;
        });
        yield return ("Shure bundle skips legacy dependency setup while other runtime bundles retain it",async()=>{
            foreach(var shure in new[]{false,true})
            {
                using var f=new Fixture();if(shure)f.Manifest=f.Manifest with {Id="shure-scp"};var trust=f.Write() with {Id=f.Manifest.Id};
                await File.WriteAllBytesAsync(Path.Combine(f.Root,"plugin-bundles.json"),JsonSerializer.SerializeToUtf8Bytes(new[]{trust}));
                await using var input=await PluginImportFile.OpenAsync(f.PathName,f.Root,default);
                Check(input.RequiresDependencySetup!=shure&&input.Package.SequenceEqual(f.Plugin));
                Check(Directory.GetFiles(f.Root).Length==2); // No runtime staging, execution or service probe.
            }
        });
        yield return ("Background import honors cancellation and rejects untrusted bytes without file leaks",async()=>{
            using var f=new Fixture();f.Manifest=f.Manifest with {Runtimes=[]};var trust=f.Write();
            var catalog=Path.Combine(f.Root,"plugin-bundles.json");await File.WriteAllBytesAsync(catalog,JsonSerializer.SerializeToUtf8Bytes(Array.Empty<BundleTrust>()));
            await Reject(()=>PluginImportFile.OpenAsync(f.PathName,f.Root,default));
            await File.WriteAllBytesAsync(catalog,JsonSerializer.SerializeToUtf8Bytes(new[]{trust}));
            await Reject(()=>PluginImportFile.OpenAsync(f.PathName,f.Root,new CancellationToken(true)));
            // A rejected/cancelled read must leave the original import file movable.
            var renamed=Path.Combine(f.Root,"preserved.zip");File.Move(f.PathName,renamed);Check(File.Exists(renamed));
        });
        yield return ("Small source-only bundle is identified by manifest and roundtrips without runtime",async()=>{
            using var f=new Fixture();f.Manifest=f.Manifest with {Runtimes=[]};var trust=f.Write();
            Check(new FileInfo(f.PathName).Length<131072&&await PluginOfflineBundle.IsOfflineBundleAsync(f.PathName,default));
            await using var b=await PluginOfflineBundle.OpenAsync(f.PathName,[trust],default);Check(b.Manifest.Runtimes.Length==0&&(await b.PluginAsync(default)).SequenceEqual(f.Plugin));
            var exported=Path.Combine(f.Root,"export.zip");await b.ExportAsync(exported,default);
            Check(await PluginOfflineBundle.IsOfflineBundleAsync(exported,default));await PluginOfflineBundle.VerifyFileAsync(exported,trust.Sha256,trust.Bytes,default);
        });
        yield return ("Legacy runtime bundle remains a bundle independent of archive size",async()=>{
            using var f=new Fixture();f.Installer=new byte[150000];f.Manifest=f.Manifest with {Runtimes=[f.Manifest.Runtimes[0] with {Installer=f.Manifest.Runtimes[0].Installer with {Sha256=Sha(f.Installer),Bytes=f.Installer.Length}}]};var trust=f.Write();
            Check(new FileInfo(f.PathName).Length>131072&&await PluginOfflineBundle.IsOfflineBundleAsync(f.PathName,default));
            await using var b=await PluginOfflineBundle.OpenAsync(f.PathName,[trust],default);Check((await b.PluginAsync(default)).SequenceEqual(f.Plugin));Check(Directory.GetFiles(f.Root).Length==1);
        });
        yield return ("Raw source plugin preserves its original import route",async()=>{
            using var f=new Fixture();using(var z=ZipFile.Open(f.PathName,ZipArchiveMode.Create))
            {
                using(var s=z.CreateEntry("fixture/manifest.json").Open())await s.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(new{schema="daty-plugin-package-v1",id="fixture",installable=true}));
                using(var s=z.CreateEntry("fixture/README.md").Open())s.WriteByte(1);
                using(var s=z.CreateEntry("fixture/src/adapter.py").Open())s.WriteByte(1);
            }
            Check(!await PluginOfflineBundle.IsOfflineBundleAsync(f.PathName,default));
        });
        yield return ("ZIP routing rejects unknown corrupt duplicate traversal and oversized metadata",async()=>{
            using(var f=new Fixture()){await File.WriteAllTextAsync(f.PathName,"not a ZIP");await Reject(()=>PluginOfflineBundle.IsOfflineBundleAsync(f.PathName,default));}
            using(var f=new Fixture()){using(var z=ZipFile.Open(f.PathName,ZipArchiveMode.Create)){using var s=z.CreateEntry("unknown.json").Open();s.Write("{}"u8);}await Reject(()=>PluginOfflineBundle.IsOfflineBundleAsync(f.PathName,default));}
            foreach(var name in new[]{"unknown.json","../escape","bundle.json"})
            {
                using var f=new Fixture();using(var z=ZipFile.Open(f.PathName,ZipArchiveMode.Create)){using(var s=z.CreateEntry(name).Open())s.WriteByte(1);using(var s=z.CreateEntry(name).Open())s.WriteByte(1);}
                await Reject(()=>PluginOfflineBundle.IsOfflineBundleAsync(f.PathName,default));
            }
            using(var f=new Fixture()){f.Manifest=f.Manifest with {Runtimes=[]};f.Write(z=>{using var s=z.CreateEntry("../escape").Open();s.WriteByte(1);});await Reject(()=>PluginOfflineBundle.IsOfflineBundleAsync(f.PathName,default));}
            using(var f=new Fixture()){using(var z=ZipFile.Open(f.PathName,ZipArchiveMode.Create)){using(var s=z.CreateEntry("bundle.json").Open())s.Write(new byte[65537]);using(var s=z.CreateEntry("README.md").Open())s.WriteByte(1);using(var s=z.CreateEntry("plugin/a.zip").Open())s.WriteByte(1);}await Reject(()=>PluginOfflineBundle.IsOfflineBundleAsync(f.PathName,default));}
        });
        yield return ("Bundle routing never bypasses trust and honors cancellation",async()=>{
            using var f=new Fixture();f.Manifest=f.Manifest with {Runtimes=[]};f.Write();Check(await PluginOfflineBundle.IsOfflineBundleAsync(f.PathName,default));
            await Reject(async()=>{await using var b=await PluginOfflineBundle.OpenAsync(f.PathName,[],default);});
            await Reject(()=>PluginOfflineBundle.IsOfflineBundleAsync(f.PathName,new CancellationToken(true)));
        });
        yield return ("Import-only legacy trust accepts both envelopes but rejects modified ZIP bytes",async()=>{
            using var current=new Fixture();current.Manifest=current.Manifest with {Runtimes=[]};var now=current.Write();
            using var legacy=new Fixture();legacy.Installer=new byte[150000];legacy.Manifest=legacy.Manifest with {Runtimes=[legacy.Manifest.Runtimes[0] with {Installer=legacy.Manifest.Runtimes[0].Installer with {Sha256=Sha(legacy.Installer),Bytes=legacy.Installer.Length}}]};var old=legacy.Write();
            var trusts=PluginOfflineBundle.Catalog(JsonSerializer.SerializeToUtf8Bytes(new[]{now})).Concat(PluginOfflineBundle.Catalog(JsonSerializer.SerializeToUtf8Bytes(new[]{old}))).ToArray();
            foreach(var path in new[]{current.PathName,legacy.PathName})
            {
                Check(await PluginOfflineBundle.IsOfflineBundleAsync(path,default));
                await using(var b=await PluginOfflineBundle.OpenAsync(path,trusts,default))Check((await b.PluginAsync(default)).SequenceEqual(current.Plugin));
                await using(var output=new FileStream(path,FileMode.Append,FileAccess.Write))output.WriteByte(1);
                await Reject(async()=>{await using var b=await PluginOfflineBundle.OpenAsync(path,trusts,default);});
            }
        });
        yield return ("Relocated independent project exports the one shared verified bundle",async()=>{
            using var f=new Fixture();var trust=f.Write();var raw=File.ReadAllBytes(f.PathName);
            var root=Path.Combine(f.Root,"relocated project");var app=Path.Combine(root,"native","publish","version");Directory.CreateDirectory(app);
            var project=new ProjectEnvironment(root,18080,18083);var shared=PluginOfflineBundle.SourcePath(app,trust.FileName,project);
            Directory.CreateDirectory(Path.GetDirectoryName(shared)!);File.Move(f.PathName,shared);
            Check(!File.Exists(Path.Combine(app,"assets","plugin-bundles",trust.FileName)));
            await using var b=await PluginOfflineBundle.OpenAsync(shared,[trust],default);Check((await b.PluginAsync(default)).SequenceEqual(f.Plugin));
            var exported=Path.Combine(f.Root,"export.zip");await b.ExportAsync(exported,default);Check(File.ReadAllBytes(exported).SequenceEqual(raw));
        });
        yield return ("Shared bundle errors never fall back to a stale published copy",async()=>{
            using var f=new Fixture();var trust=f.Write();var app=Path.Combine(f.Root,"app");var project=new ProjectEnvironment(f.Root,18080,18083);
            var stale=PluginOfflineBundle.SourcePath(app,trust.FileName,null);Directory.CreateDirectory(Path.GetDirectoryName(stale)!);File.Move(f.PathName,stale);
            var shared=PluginOfflineBundle.SourcePath(app,trust.FileName,project);
            await Reject(async()=>{await using var b=await PluginOfflineBundle.OpenAsync(shared,[trust],default);});
            Directory.CreateDirectory(Path.GetDirectoryName(shared)!);await File.WriteAllTextAsync(shared,"corrupt");
            await Reject(async()=>{await using var b=await PluginOfflineBundle.OpenAsync(shared,[trust],default);});
            await using var legacy=await PluginOfflineBundle.OpenAsync(stale,[trust],default);Check((await legacy.PluginAsync(default)).SequenceEqual(f.Plugin));
        });
        yield return ("Shared bundle source rejects escaping or invalid catalog names",async()=>{
            using var f=new Fixture();foreach(var name in new[]{"../bundle.zip","folder/bundle.zip","C:/bundle.zip","..","bundle.zip ","bad?.zip"})
                await Reject(()=>{PluginOfflineBundle.SourcePath(f.Root,name,new ProjectEnvironment(f.Root,18080,18083));return Task.CompletedTask;});
        });
        yield return ("Offline bundle roundtrip preserves plugin and original installer bytes",async()=>{
            using var f=new Fixture();var trust=f.Write();await using var b=await PluginOfflineBundle.OpenAsync(f.PathName,[trust],default);
            Check((await b.PluginAsync(default)).SequenceEqual(f.Plugin));var staged=await b.StageInstallerAsync(b.Manifest.Runtimes[0],Path.Combine(f.Root,"stage"),default);Check(File.ReadAllBytes(staged).SequenceEqual(f.Installer));
            Check(await b.StageInstallerAsync(b.Manifest.Runtimes[0],Path.Combine(f.Root,"stage"),default)==staged);
            var exported=Path.Combine(f.Root,"export.zip");await b.ExportAsync(exported,default);Check(File.ReadAllBytes(exported).SequenceEqual(File.ReadAllBytes(f.PathName)));
        });
        yield return ("Offline bundle rejects untrusted whole package before extraction",async()=>{
            using var f=new Fixture();f.Write();await Reject(async()=>{await using var b=await PluginOfflineBundle.OpenAsync(f.PathName,[],default);});Check(Directory.GetFiles(f.Root).Length==1);
        });
        yield return ("Offline bundle rejects duplicate and path traversal entries",async()=>{
            foreach(var entry in new[]{"../escape","README.md"}){using var f=new Fixture();var trust=f.Write(z=>{using var s=z.CreateEntry(entry).Open();s.WriteByte(1);});await Reject(async()=>{await using var b=await PluginOfflineBundle.OpenAsync(f.PathName,[trust],default);});}
        });
        yield return ("Offline bundle rejects wrong inner identity and hash",async()=>{
            using var f=new Fixture();var trust=f.Write();await Reject(async()=>{await using var b=await PluginOfflineBundle.OpenAsync(f.PathName,[trust with {Id="another"}],default);});
            await Reject(async()=>{await using var b=await PluginOfflineBundle.OpenAsync(f.PathName,[trust with {PluginSha256=new string('0',64)}],default);});
        });
        yield return ("Offline bundle altered installer never becomes executable",async()=>{
            using var f=new Fixture();var changed=f.Installer.ToArray();changed[0]^=1;var trust=f.Write(installer:changed);await using var b=await PluginOfflineBundle.OpenAsync(f.PathName,[trust],default);
            var stage=Path.Combine(f.Root,"stage");await Reject(()=>b.StageInstallerAsync(b.Manifest.Runtimes[0],stage,default));Check(!Directory.GetFiles(stage).Any());
        });
        yield return ("Offline bundle cannot overwrite altered staged installer",async()=>{
            using var f=new Fixture();var trust=f.Write();await using var b=await PluginOfflineBundle.OpenAsync(f.PathName,[trust],default);var stage=Path.Combine(f.Root,"stage");Directory.CreateDirectory(stage);var target=Path.Combine(stage,b.Manifest.Runtimes[0].Installer.Sha256+".exe");await File.WriteAllTextAsync(target,"tampered");await Reject(()=>b.StageInstallerAsync(b.Manifest.Runtimes[0],stage,default));Check(await File.ReadAllTextAsync(target)=="tampered");
        });
        yield return ("Offline dependency forbids remote endpoints and non-ProgramData secrets",async()=>{
            using var f=new Fixture();foreach(var probe in new[]{f.Manifest.Runtimes[0].Probe with {Uri="https://192.0.2.1/api"},f.Manifest.Runtimes[0].Probe with {Uri="http://127.0.0.1/api"},f.Manifest.Runtimes[0].Probe with {CredentialFile=Path.Combine(f.Root,"secret")}})await Reject(()=>{LocalRuntimeDependency.ValidateProbe(probe);return Task.CompletedTask;});
            Check(!LocalRuntimeDependency.IsLocalServer(new Uri("https://192.0.2.1")));Check(LocalRuntimeDependency.IsLocalServer(new Uri("https://127.0.0.1")));
        });
        yield return ("Offline dependency absent is not reported installed or ready",async()=>{
            using var f=new Fixture();var health=await LocalRuntimeDependency.CheckAsync(f.Manifest.Runtimes[0].Probe,default);Check(!health.Installed&&!health.Ready);
        });
        yield return ("Offline bundle cancellation leaves existing export untouched",async()=>{
            using var f=new Fixture();var trust=f.Write();await using var b=await PluginOfflineBundle.OpenAsync(f.PathName,[trust],default);var target=Path.Combine(f.Root,"export.zip");await File.WriteAllTextAsync(target,"original");using var cts=new CancellationTokenSource();cts.Cancel();await Reject(()=>b.ExportAsync(target,cts.Token));Check(await File.ReadAllTextAsync(target)=="original");Check(!Directory.GetFiles(f.Root,"*.tmp").Any());
        });
    }
}
