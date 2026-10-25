using System.Security.Cryptography;
using System.Text.Json;

namespace Daty.Native.Core;

/// <summary>MQTT file transfers: every block and the final file are verified.</summary>
public sealed class R19Transfers(Func<string,object,CancellationToken,Task<JsonElement>> call)
{
    public const int ChunkBytes=128*1024;
    public static string Digest(ReadOnlySpan<byte> data)=>Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

    public async Task DownloadAsync(JsonElement descriptor,Stream output,CancellationToken token)
    {
        var id=descriptor.Text("id")??throw new InvalidDataException("下载缺少身份");
        var sha=descriptor.Text("sha256")??throw new InvalidDataException("下载缺少摘要");
        if(descriptor.Text("state")!="ready"||descriptor.Number("bytes") is not double size||size<0||size>8L*1024*1024*1024||size!=Math.Truncate(size))
            throw new InvalidDataException("下载描述无效");
        using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        for(long offset=0;offset<(long)size;)
        {
            var chunk=await call("downloads.chunk",new{download_id=id,offset,sha256=sha},token);
            var bytes=Convert.FromBase64String(chunk.Text("data")??throw new InvalidDataException("下载分块缺失"));
            if(chunk.Text("download_id")!=id||chunk.Number("offset")!=offset||chunk.Text("file_sha256")!=sha||
               bytes.Length!=Math.Min(ChunkBytes,(long)size-offset)||chunk.Number("bytes")!=bytes.Length||Digest(bytes)!=chunk.Text("sha256")||
               chunk.Field("eof").True()!=(offset+bytes.Length==(long)size))throw new InvalidDataException("下载分块身份或摘要不匹配");
            await output.WriteAsync(bytes,token);hash.AppendData(bytes);offset+=bytes.Length;
        }
        if(Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant()!=sha)throw new InvalidDataException("下载文件完整摘要不匹配");
        await output.FlushAsync(token);
        await call("downloads.close",new{download_id=id},token);
    }

    public async Task<JsonElement> JsonAsync(JsonElement reply,CancellationToken token)
    {
        if(reply.Text("status")!="download_required")return reply;
        var descriptor=reply.Field("transfer");
        if(reply.Text("encoding")!="json-utf8"||descriptor.Number("bytes") is not double size||size>64*1024*1024)
            throw new InvalidDataException("服务器 JSON 快照过大或编码无效");
        using var stream=new MemoryStream();await DownloadAsync(descriptor,stream,token);
        using var doc=JsonDocument.Parse(stream.ToArray());return doc.RootElement.Clone();
    }

    public async Task<JsonElement> InvokeAsync(string method,object body,CancellationToken token)
    {
        var bytes=JsonSerializer.SerializeToUtf8Bytes(new{method,body});
        if(bytes.Length>64*1024*1024)throw new InvalidDataException("业务输入超过传输上限");
        var id=Guid.NewGuid().ToString("N");var sha=Digest(bytes);
        var begin=await call("uploads.begin",new{operation_id=id,bytes=bytes.Length,sha256=sha,media_type="application/json"},token);
        if(begin.Text("id")!=id||begin.Text("sha256")!=sha||begin.Number("offset")!=0)throw new InvalidDataException("上传身份不匹配");
        for(int offset=0;offset<bytes.Length;offset+=ChunkBytes)
        {
            var block=bytes.AsMemory(offset,Math.Min(ChunkBytes,bytes.Length-offset)).ToArray();
            var receipt=await call("uploads.chunk",new{upload_id=id,offset,sha256=Digest(block),data=Convert.ToBase64String(block)},token);
            if(receipt.Text("id")!=id||receipt.Text("sha256")!=sha||receipt.Number("offset")!=offset+block.Length)throw new InvalidDataException("上传分块未获保存确认");
        }
        var finish=await call("uploads.finish",new{upload_id=id,sha256=sha},token);
        if(finish.Text("state")!="ready"||finish.Text("id")!=id||finish.Text("sha256")!=sha||finish.Number("bytes")!=bytes.Length)throw new InvalidDataException("上传未完整保存");
        var result=await JsonAsync(await call("data.invoke",new{upload_id=id,sha256=sha},token),token);
        // Release only bytes whose consuming operation returned definitively.
        // Cleanup failure must not turn a committed business save into a retry.
        try { await call("uploads.release",new{upload_id=id,sha256=sha,consumed=true},token); }
        catch(OperationCanceledException) { }
        catch(R19RpcException) { }
        catch(IOException) { }
        return result;
    }
}
