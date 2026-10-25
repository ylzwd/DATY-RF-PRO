using System.Security.Cryptography;
using System.Text.Json;

namespace Daty.Native.Core;

public sealed record PendingDeviceCommand(string Path, JsonElement Intent, string Digest);

// Local recovery identity, not an execution receipt. Each server/channel is isolated.
public sealed class PendingDeviceCommands(string directory)
{
    private readonly string root = Path.GetFullPath(directory);
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static string Origin(string server) => new Uri(server).GetLeftPart(UriPartial.Authority).TrimEnd('/');
    private static bool Scope(JsonElement intent,string server,int port) =>
        Origin(intent.Text("server")??throw new InvalidDataException("待确认指令缺少服务器"))==Origin(server)
        && (intent.Number("mqtt_port")??8083)==port;
    private string Key(string server,int port,string device) => Hash(System.Text.Encoding.UTF8.GetBytes(Origin(server)+"\n"+port+"\n"+device));
    public IReadOnlyList<PendingDeviceCommand> Read(string server,int port)
    {
        if(!Directory.Exists(root))return [];
        var records=new List<PendingDeviceCommand>();
        foreach(var path in Directory.EnumerateFiles(root,"pending-device-*.json"))
        {
            if(new FileInfo(path).Length>16384)throw new InvalidDataException("待确认指令文件超过大小限制");
            var bytes=File.ReadAllBytes(path);using var document=JsonDocument.Parse(bytes);var intent=document.RootElement;
            if(!Scope(intent,server,port))continue;
            if(!R19MqttClient.HexId(intent.Text("operation_id")??"")||string.IsNullOrWhiteSpace(intent.Field("target").Text("device_id")))
                throw new InvalidDataException("待确认指令身份无效，原记录已保留");
            records.Add(new(path,intent.Clone(),Hash(bytes)));
        }
        return records;
    }
    public IDisposable Acquire(string server,int port,string device)
    {
        Directory.CreateDirectory(root);
        return new FileStream(Path.Combine(root,".device-command-"+Key(server,port,device)+".lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
    }
    public async Task<PendingDeviceCommand> CreateAsync(JsonElement intent,CancellationToken token)
    {
        var server=intent.Text("server")!;var port=(int)(intent.Number("mqtt_port")??8083);var device=intent.Field("target").Text("device_id")!;
        if(Read(server,port).Any(p=>p.Intent.Field("target").Text("device_id")==device))throw new InvalidDataException("服务器正在自动核对该通道的上一条指令，请稍候");
        Directory.CreateDirectory(root);var path=Path.Combine(root,"pending-device-"+Key(server,port,device)+".json");
        var bytes=JsonSerializer.SerializeToUtf8Bytes(intent);
        await using(var file=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None,4096,FileOptions.WriteThrough))
        {await file.WriteAsync(bytes,token);await file.FlushAsync(token);file.Flush(true);}
        return new(path,intent.Clone(),Hash(bytes));
    }
    public void Complete(PendingDeviceCommand pending)
    {
        var path=Path.GetFullPath(pending.Path);
        if(Path.GetDirectoryName(path)!=root||!Path.GetFileName(path).StartsWith("pending-device-",StringComparison.Ordinal))throw new InvalidDataException("待确认指令路径不匹配");
        if(!File.Exists(path)||Hash(File.ReadAllBytes(path))!=pending.Digest)throw new InvalidDataException("待确认指令已被另一个窗口修改，请重新核对");
        File.Delete(path);
    }
    public static bool CanComplete(JsonElement receipt,JsonElement intent)
    {
        CommandRules.ValidateReceipt(receipt,intent);
        return receipt.Text("state") is "acknowledged" or "readback_confirmed" or "not_sent" or "rejected" or "failed"
            || receipt.Text("state") is "unknown" or "timeout" && receipt.Field("review").Field("confirmed").True()
                && receipt.Field("review").Text("meaning")=="release-target-no-execution-claim";
    }
    public static void ValidateReview(JsonElement original,JsonElement result,JsonElement observation)
    {
        CommandRules.ValidateReceipt(result,original);
        if(original.Text("state") is not ("unknown" or "timeout") || result.Text("state")!=original.Text("state")
            || result.Number("revision")!=original.Number("revision")+1
            || !JsonElement.DeepEquals(result.Field("error"),original.Field("error"))
            || !JsonElement.DeepEquals(result.Field("actual_value"),original.Field("actual_value"))
            || !JsonElement.DeepEquals(result.Field("execution_evidence"),original.Field("execution_evidence"))
            || !JsonElement.DeepEquals(result.Field("review").Field("observed"),observation)
            || !CanComplete(result,original))throw new InvalidDataException("核对回执不匹配，原未知结果及锁定保留");
    }
}
