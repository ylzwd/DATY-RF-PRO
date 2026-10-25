using System.Security.Cryptography;
using System.Text.Json;
using System.Diagnostics;

namespace Daty.Native.Core;

public sealed record PreparedPlugin(string Id,string Brand,string Name,string Version,string Sha256,int Revision,int SourceFiles,string PackageBase64,string Boot,bool AlreadyActive);
public sealed record PendingPlugin(string Origin,string OperationId,string Id,string Brand,string Version,string Sha256);

/// <summary>Same server installer as the platform, with a native binary file host and durable query-only recovery.</summary>
public sealed class PluginImportService
{
    private readonly R19MqttClient client;
    private readonly string pendingPath;
    public PendingPlugin? Pending { get; private set; }
    public PluginImportService(R19MqttClient client,string pendingPath)
    {
        this.client=client;this.pendingPath=pendingPath;
        if(File.Exists(pendingPath))
        {
            if(new FileInfo(pendingPath).Length>4096)throw new InvalidDataException("插件待确认记录过大");
            Pending=JsonSerializer.Deserialize<PendingPlugin>(File.ReadAllText(pendingPath))??throw new InvalidDataException("插件待确认记录无效");
            if(!R19MqttClient.HexId(Pending.OperationId)||Pending.Sha256.Length!=64)throw new InvalidDataException("插件待确认记录格式错误");
        }
    }
    public async Task<PreparedPlugin> PrepareAsync(byte[] bytes,CancellationToken token)
    {
        var elapsed=Stopwatch.StartNew();
        if(Pending is not null)throw new InvalidOperationException("请先查询上次安装结果，不会重复发送安装");
        if(bytes.Length is <1 or >131072)throw new InvalidDataException("请选择不超过128 KiB的品牌插件ZIP");
        var encoded=Convert.ToBase64String(bytes);var digest=Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var preview=await client.CallAsync("plugins.preview",new {package_base64=encoded},token).ConfigureAwait(false);var boot=client.BootId!;
        Trace.WriteLine($"[PLUGIN_IMPORT] server_preview elapsed_ms={elapsed.ElapsedMilliseconds}");
        if(preview.Field("trusted").ValueKind!=JsonValueKind.True||preview.Text("sha256")!=digest||!preview.Field("revision").TryGetInt32(out var revision))throw new InvalidDataException("插件校验回执不一致");
        var state=await client.CallAsync("plugins.status",token:token,expectedBoot:boot).ConfigureAwait(false);
        Trace.WriteLine($"[PLUGIN_IMPORT] server_prepared elapsed_ms={elapsed.ElapsedMilliseconds}");
        if(state.Number("revision")!=revision||state.Field("plugins").ValueKind!=JsonValueKind.Array)throw new InvalidDataException("插件状态已变化，请重新选择文件");
        var existing=state.GetProperty("plugins").EnumerateArray().FirstOrDefault(x=>x.Text("id")==preview.Text("id"));
        bool active=existing.Text("sha256")==digest&&existing.Text("version")==preview.Text("version")&&existing.Text("state")=="installed"&&existing.Text("activation")=="active"&&existing.Field("active").ValueKind==JsonValueKind.True;
        return new(preview.GetProperty("id").GetString()!,preview.GetProperty("brand").GetString()!,preview.GetProperty("name").GetString()!,preview.GetProperty("version").GetString()!,digest,revision,preview.GetProperty("source_files").GetInt32(),encoded,boot,active);
    }
    public async Task<JsonElement> InstallAsync(PreparedPlugin plugin,CancellationToken token)
    {
        var elapsed=Stopwatch.StartNew();
        if(Pending is not null||plugin.AlreadyActive)throw new InvalidOperationException("无需重复安装；待确认的操作只能查询");
        var pending=new PendingPlugin(client.BaseUri.GetLeftPart(UriPartial.Authority),Guid.NewGuid().ToString("N"),plugin.Id,plugin.Brand,plugin.Version,plugin.Sha256);
        // WriteThrough/Flush(true) can be slow on an external disk or under file
        // inspection. Persist the intent off the UI thread before sending once.
        await Task.Run(()=>LocalFiles.WriteAtomicAsync(pendingPath,JsonSerializer.Serialize(pending),token),token).ConfigureAwait(false);Pending=pending;
        Trace.WriteLine($"[PLUGIN_IMPORT] intent_saved elapsed_ms={elapsed.ElapsedMilliseconds}");
        try
        {
            var result=await client.CallAsync("plugins.install",new {package_base64=plugin.PackageBase64,operation_id=pending.OperationId,expected_revision=plugin.Revision,sha256=plugin.Sha256},token,plugin.Boot).ConfigureAwait(false);
            var receipt=ValidateReceipt(result,pending);
            Trace.WriteLine($"[PLUGIN_IMPORT] receipt_validated elapsed_ms={elapsed.ElapsedMilliseconds}");
            return receipt;
        }
        catch(R19RpcException error) when(error.Code is "PLUGIN_REVISION_CHANGED" or "PLUGIN_PACKAGE_CHANGED" or "INSTALL_REQUEST_EXPIRED" or "REQUEST_EXPIRED" or "SERVER_BOOT_CHANGED" or "PLUGIN_UPDATE_REQUIRES_MAINTENANCE" or "PLUGIN_PACKAGE_NOT_TRUSTED" or "INSTALLED_FILES_CHANGED")
        { ClearPending();throw; }
    }
    public async Task<JsonElement> QueryAsync(CancellationToken token)
    {
        var pending=Pending??throw new InvalidOperationException("没有待确认的插件安装");
        if(pending.Origin!=client.BaseUri.GetLeftPart(UriPartial.Authority))throw new InvalidOperationException("请连接原服务器后查询安装结果");
        try{return ValidateReceipt(await client.CallAsync("plugins.operation",new {operation_id=pending.OperationId},token).ConfigureAwait(false),pending);}
        catch(R19RpcException error)when(error.Code=="INSTALL_OPERATION_NOT_FOUND"){ClearPending();throw;}
    }
    private JsonElement ValidateReceipt(JsonElement result,PendingPlugin pending)
    {
        if(result.Text("operation_id")!=pending.OperationId||result.Text("sha256")!=pending.Sha256||result.Text("id")!=pending.Id)throw new InvalidDataException("安装回执与本次插件不匹配，只能查询核对");
        if(result.Text("activation")=="failed" || result.Text("activation")=="active" && result.Text("state")=="installed")ClearPending();
        return result;
    }
    private void ClearPending(){File.Delete(pendingPath);Pending=null;}
}
