using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace Daty.Native.Core;

public sealed record BundleTrust(string Id,string Version,string FileName,string Sha256,long Bytes,string PluginSha256);
public sealed record BundleFile(string Path,string Sha256,long Bytes);
public sealed record RuntimeProbe(string Uri,string Certificate,string CredentialFile,string Header);
public sealed record BundleRuntime(string Id,string Name,string Version,string Publisher,string Source,BundleFile Installer,RuntimeProbe Probe);
public sealed record BundleManifest(string Schema,string Id,string Brand,string Version,BundleFile Plugin,BundleRuntime[] Runtimes);

/// <summary>Large offline delivery stays on the local machine. Only the original small
/// trusted plugin is sent through MQTT; the existing server installer remains authoritative.</summary>
public sealed class PluginOfflineBundle : IAsyncDisposable
{
    // A complete independent project carries the reviewed ZIP once in its source assets.
    // Installed/non-project editions continue using their own publication assets.
    public static string SourcePath(string applicationDirectory,string fileName,ProjectEnvironment? project)
    {
        if(!SafePath(fileName)||Path.GetFileName(fileName)!=fileName||fileName.IndexOfAny(Path.GetInvalidFileNameChars())>=0)
            throw new InvalidDataException("离线插件文件名无效");
        var directory=project is null ? Path.Combine(applicationDirectory,"assets","plugin-bundles")
            : Path.Combine(project.Root,"native","assets","plugin-bundles");
        return Path.Combine(directory,fileName);
    }
    public const long Limit=512L*1024*1024;
    private readonly FileStream source;
    private readonly ZipArchive archive;
    public BundleManifest Manifest { get; }
    private PluginOfflineBundle(FileStream stream,ZipArchive zip,BundleManifest manifest)
        {source=stream;archive=zip;Manifest=manifest;}
    private static readonly JsonSerializerOptions JsonOptions=new(){PropertyNameCaseInsensitive=true};
    public static BundleTrust[] Catalog(byte[] bytes)
        => JsonSerializer.Deserialize<BundleTrust[]>(bytes,JsonOptions)??throw new InvalidDataException("离线插件目录无效");
    private static bool SafePath(string path)=>!string.IsNullOrEmpty(path)&&path.Length<240&&!path.Contains('\\')&&!path.Contains(':')&&!path.StartsWith('/')&&path.Split('/').All(p=>p.Length>0&&p is not "." and not ".."&&!p.EndsWith('.')&&!p.EndsWith(' '));
    private static bool Digest(string value)=>value.Length==64&&value.All(c=>c is >= '0' and <= '9' or >= 'a' and <= 'f');
    /// <summary>Identify the envelope from bounded ZIP metadata, never its file size.
    /// This is only routing: OpenAsync and the server preview still verify trust.</summary>
    public static async Task<bool> IsOfflineBundleAsync(string path,CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        await using var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read,65536,FileOptions.Asynchronous|FileOptions.SequentialScan);
        if(stream.Length is <1 or >Limit)throw new InvalidDataException("插件包大小超限");
        using var zip=new ZipArchive(stream,ZipArchiveMode.Read,true);
        if(zip.Entries.Count is <1 or >128||zip.Entries.Sum(e=>e.Length)>Limit||zip.Entries.Any(e=>!SafePath(e.FullName)||((e.ExternalAttributes>>16)&0xF000)==0xA000)||zip.Entries.Select(e=>e.FullName).Distinct(StringComparer.OrdinalIgnoreCase).Count()!=zip.Entries.Count)
            throw new InvalidDataException("插件包目录结构无效");
        if(zip.GetEntry("bundle.json") is { } bundle)
        {
            if(zip.Entries.Count is <3 or >8)throw new InvalidDataException("离线包目录结构无效");
            var metadata=JsonSerializer.Deserialize<BundleManifest>(await ReadEntryAsync(bundle,65536,token),JsonOptions);
            if(metadata?.Schema!="daty-plugin-offline-bundle-v1")
                throw new InvalidDataException("离线包清单无效");
            return true;
        }
        if(stream.Length>131072||zip.Entries.Sum(e=>e.Length)>4L*1024*1024)throw new InvalidDataException("品牌插件源码包大小超限");
        var manifests=zip.Entries.Where(e=>e.FullName.Split('/') is [_,"manifest.json"]).ToArray();
        if(manifests.Length!=1)throw new InvalidDataException("缺少品牌插件清单");
        using var source=JsonDocument.Parse(await ReadEntryAsync(manifests[0],65536,token));
        var manifest=source.RootElement;
        if(manifest.ValueKind!=JsonValueKind.Object||manifest.Text("schema")!="daty-plugin-package-v1"||!manifest.Field("installable").True()||manifest.Text("id")!=manifests[0].FullName.Split('/')[0])
            throw new InvalidDataException("品牌插件清单无效");
        return false;
    }
    public static async Task<PluginOfflineBundle> OpenAsync(string path,IReadOnlyList<BundleTrust> trusted,CancellationToken token)
    {
        var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read,65536,FileOptions.Asynchronous|FileOptions.SequentialScan);
        ZipArchive? zip=null;
        try
        {
            if(stream.Length is <1 or >Limit)throw new InvalidDataException("离线包大小超限");
            var digest=Convert.ToHexString(await SHA256.HashDataAsync(stream,token)).ToLowerInvariant();
            var trust=trusted.SingleOrDefault(t=>t.Sha256==digest&&t.Bytes==stream.Length)??throw new InvalidDataException("离线插件包未获本版本审核或文件已损坏");
            stream.Position=0;zip=new ZipArchive(stream,ZipArchiveMode.Read,true);
            if(zip.Entries.Count is <3 or >8||zip.Entries.Sum(e=>e.Length)>Limit||zip.Entries.Any(e=>!SafePath(e.FullName)||((e.ExternalAttributes>>16)&0xF000)==0xA000)||zip.Entries.Select(e=>e.FullName).Distinct(StringComparer.OrdinalIgnoreCase).Count()!=zip.Entries.Count)throw new InvalidDataException("离线包目录结构无效");
            var metadata=zip.GetEntry("bundle.json")??throw new InvalidDataException("缺少离线包清单");
            var raw=await ReadEntryAsync(metadata,65536,token);
            var m=JsonSerializer.Deserialize<BundleManifest>(raw,JsonOptions)??throw new InvalidDataException("离线包清单无效");
            if(m.Schema!="daty-plugin-offline-bundle-v1"||m.Id!=trust.Id||m.Version!=trust.Version||m.Plugin.Sha256!=trust.PluginSha256||m.Plugin.Bytes is <1 or >131072||m.Runtimes.Length>3)throw new InvalidDataException("离线包与审核目录不匹配");
            var files=new[]{m.Plugin}.Concat(m.Runtimes.Select(r=>r.Installer)).ToArray();
            var expected=new[]{"bundle.json","README.md"}.Concat(files.Select(f=>f.Path)).ToHashSet(StringComparer.Ordinal);
            if(expected.Count!=files.Length+2||!expected.SetEquals(zip.Entries.Select(e=>e.FullName)))throw new InvalidDataException("离线包含未声明或重复文件");
            foreach(var f in files)
                if(!SafePath(f.Path)||!Digest(f.Sha256)||f.Bytes<1||zip.GetEntry(f.Path)?.Length!=f.Bytes)throw new InvalidDataException("离线文件声明无效");
            foreach(var runtime in m.Runtimes)
            {
                if(!runtime.Installer.Path.EndsWith(".exe",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("依赖必须为审核的原始安装程序");
                LocalRuntimeDependency.ValidateProbe(runtime.Probe);
            }
            return new(stream,zip,m);
        }
        catch {zip?.Dispose();await stream.DisposeAsync();throw;}
    }
    private static async Task<byte[]> ReadEntryAsync(ZipArchiveEntry entry,int limit,CancellationToken token)
    {
        if(entry.Length<1||entry.Length>limit)throw new InvalidDataException("离线包条目超限");
        using var input=entry.Open();using var output=new MemoryStream();var buffer=new byte[16384];
        for(int n;(n=await input.ReadAsync(buffer,token))!=0;){if(output.Length+n>limit)throw new InvalidDataException("离线包展开超限");await output.WriteAsync(buffer.AsMemory(0,n),token);}
        if(output.Length!=entry.Length)throw new InvalidDataException("离线包条目截断");return output.ToArray();
    }
    public async Task<byte[]> PluginAsync(CancellationToken token)
    {
        var bytes=await ReadEntryAsync(archive.GetEntry(Manifest.Plugin.Path)!,131072,token);
        if(Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()!=Manifest.Plugin.Sha256)throw new InvalidDataException("内层插件摘要不匹配");return bytes;
    }
    public async Task<string> StageInstallerAsync(BundleRuntime runtime,string directory,CancellationToken token)
    {
        if(!Manifest.Runtimes.Contains(runtime))throw new InvalidDataException("未声明的依赖");
        Directory.CreateDirectory(directory);
        // The destination is derived from reviewed content, never a ZIP path.
        var path=Path.Combine(directory,runtime.Installer.Sha256+".exe");
        if(File.Exists(path)) {await VerifyFileAsync(path,runtime.Installer.Sha256,runtime.Installer.Bytes,token);return path;}
        var temp=Path.Combine(directory,".daty-"+Guid.NewGuid().ToString("N")+".tmp");
        try
        {
            using var input=archive.GetEntry(runtime.Installer.Path)!.Open();
            await using(var output=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None,65536,FileOptions.Asynchronous|FileOptions.WriteThrough))
            {
                var buffer=new byte[65536];long written=0;
                for(int n;(n=await input.ReadAsync(buffer,token))!=0;){written+=n;if(written>runtime.Installer.Bytes)throw new InvalidDataException("安装文件展开超限");await output.WriteAsync(buffer.AsMemory(0,n),token);}
                if(written!=runtime.Installer.Bytes)throw new InvalidDataException("安装文件不完整");await output.FlushAsync(token);output.Flush(true);
            }
            await VerifyFileAsync(temp,runtime.Installer.Sha256,runtime.Installer.Bytes,token);token.ThrowIfCancellationRequested();File.Move(temp,path);return path;
        }
        finally{if(File.Exists(temp))File.Delete(temp);}
    }
    public static async Task VerifyFileAsync(string path,string sha,long size,CancellationToken token)
    {
        await using var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read,65536,FileOptions.Asynchronous|FileOptions.SequentialScan);
        if(file.Length!=size||Convert.ToHexString(await SHA256.HashDataAsync(file,token)).ToLowerInvariant()!=sha)throw new InvalidDataException("离线文件完整性校验失败");
    }
    public async Task ExportAsync(string path,CancellationToken token)
    {
        var full=Path.GetFullPath(path);Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        var temp=Path.Combine(Path.GetDirectoryName(full)!,".daty-"+Guid.NewGuid().ToString("N")+".tmp");
        try
        {
            source.Position=0;
            await using(var output=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None,65536,FileOptions.Asynchronous|FileOptions.WriteThrough))
            {await source.CopyToAsync(output,token);await output.FlushAsync(token);output.Flush(true);}
            token.ThrowIfCancellationRequested();File.Move(temp,full,true);
        }
        finally{if(File.Exists(temp))File.Delete(temp);}
    }
    public async ValueTask DisposeAsync(){archive.Dispose();await source.DisposeAsync();}
}
