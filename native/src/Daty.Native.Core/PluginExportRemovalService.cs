using System.Security.Cryptography;
using System.Text.Json;

namespace Daty.Native.Core;

public sealed record PendingPluginRemoval(string Origin,string OperationId,string Id,string Sha256,string ExportSha256,long ExportBytes);

/// <summary>Request removal only after reopening and hashing the saved ZIP.
/// Lost replies are recovered by operation lookup; never issue a new deletion.</summary>
public sealed class PluginExportRemovalService
{
    private readonly R19MqttClient client;
    private readonly string pendingPath;
    public PendingPluginRemoval? Pending {get;private set;}
    public PluginExportRemovalService(R19MqttClient client,string pendingPath)
    {
        this.client=client;this.pendingPath=pendingPath;
        if(!File.Exists(pendingPath))return;
        if(new FileInfo(pendingPath).Length>4096)throw new InvalidDataException("插件卸载回执记录无效");
        Pending=JsonSerializer.Deserialize<PendingPluginRemoval>(File.ReadAllText(pendingPath))??throw new InvalidDataException("插件卸载回执记录无效");
        if(!R19MqttClient.HexId(Pending.OperationId)||Pending.Sha256.Length!=64)throw new InvalidDataException("插件卸载回执记录无效");
    }
    public async Task<JsonElement> RemoveVerifiedExportAsync(string path,string id,string sha,int revision,string boot,string exportSha,long exportBytes,CancellationToken token)
    {
        if(Pending is not null)throw new InvalidOperationException("正在自动查询上次导出卸载结果");
        // Hold the verified destination read-locked until the durable server response.
        await using var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read,65536,FileOptions.Asynchronous|FileOptions.SequentialScan);
        if(file.Length!=exportBytes||Convert.ToHexString(await SHA256.HashDataAsync(file,token)).ToLowerInvariant()!=exportSha)throw new InvalidDataException("导出文件校验失败，插件已保留");
        token.ThrowIfCancellationRequested();
        var pending=new PendingPluginRemoval(client.BaseUri.GetLeftPart(UriPartial.Authority),Guid.NewGuid().ToString("N"),id,sha,exportSha,exportBytes);
        await LocalFiles.WriteAtomicAsync(pendingPath,JsonSerializer.Serialize(pending),token);Pending=pending;
        try
        {
            return Receipt(await client.CallAsync("plugins.remove_exported",new{plugin_id=id,sha256=sha,operation_id=pending.OperationId,expected_revision=revision,export_sha256=exportSha,export_bytes=exportBytes},token,boot),pending);
        }
        catch(R19RpcException e)when(e.Code is "PLUGIN_REVISION_CHANGED" or "EXPORTED_PLUGIN_CHANGED" or "PLUGIN_REMOVAL_PENDING" or "REMOVAL_REQUEST_EXPIRED" or "SERVER_BOOT_CHANGED" or "REQUEST_EXPIRED" or "BUILTIN_OR_INVALID_PLUGIN" or "INVALID_EXPORT_REMOVAL")
        {Clear();throw;}
    }
    public async Task<JsonElement> QueryAsync(CancellationToken token)
    {
        var pending=Pending??throw new InvalidOperationException("没有待查询的插件卸载");
        if(pending.Origin!=client.BaseUri.GetLeftPart(UriPartial.Authority))throw new InvalidOperationException("需连接原服务器才能查询插件卸载");
        try{return Receipt(await client.CallAsync("plugins.operation",new{operation_id=pending.OperationId},token),pending);}
        catch(R19RpcException e)when(e.Code=="INSTALL_OPERATION_NOT_FOUND"){Clear();throw;}
    }
    private JsonElement Receipt(JsonElement result,PendingPluginRemoval pending)
    {
        if(result.Text("action")!="remove_exported"||result.Text("id")!=pending.Id||result.Text("sha256")!=pending.Sha256||result.Text("operation_id")!=pending.OperationId||result.Text("export_sha256")!=pending.ExportSha256||result.Number("export_bytes")!=pending.ExportBytes)throw new InvalidDataException("插件卸载回执不一致，等待查询");
        if(result.Text("state")=="removed")Clear();
        return result;
    }
    private void Clear(){File.Delete(pendingPath);Pending=null;}
}
