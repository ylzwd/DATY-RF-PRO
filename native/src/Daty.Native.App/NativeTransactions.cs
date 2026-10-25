using System.IO;
using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private string PendingPath(string type)=>Path.Combine(fixtureDirectory??Path.GetDirectoryName(NativeSettings.SettingsPath)!,"pending-"+type+".json");

    private async Task<JsonElement> WriteBusinessAsync(string method,Dictionary<string,object?> body)
    {
        await businessWriteGate.WaitAsync(connection.Token);
        try
        {
            var path=PendingPath("business-write");
            if(File.Exists(path))throw new InvalidDataException("上一次保存结果待核对，请在系统设置查询待确认结果");
            var epoch=generation;var status=await ReadRpcAsync("database.status");
            var oid=Guid.NewGuid().ToString("N");body["operation_id"]=oid;body["epoch"]=status.Text("epoch");
            var boot=bridge?.BootId;
            await LocalFiles.WriteAtomicAsync(path,JsonSerializer.Serialize(new{server=settings.Server,operation_id=oid,method,body,createdAtMs=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}),lifetime.Token);
            JsonElement result;
            try
            {
                if(JsonSerializer.SerializeToUtf8Bytes(body).Length>220*1024)
                {
                    var client=bridge!;var transfers=new R19Transfers((m,b,t)=>client.CallAsync(m,b,t,boot));
                    result=ReadBody(await transfers.InvokeAsync(method,body,connection.Token));
                }
                else result=await ReadRpcAsync(method,body,boot);
            }
            catch(R19RpcException e) when(e.Status is >=400 and <500 || e.Code=="SERVER_BOOT_CHANGED")
            { File.Delete(path);throw; }
            catch
            {
                var operation=(await ReadRpcAsync("operations.get",new{operation_id=oid})).Field("operation");
                if(operation.Text("operation_id")!=oid||operation.Text("method")!=method||operation.Text("state") is not ("committed" or "rejected"))
                    throw new InvalidDataException("保存结果待确认，已保留原操作；不会重新发送");
                result=ReadBody(operation.Field("result"));
            }
            if(epoch!=generation||!result.Field("success").True())throw new InvalidDataException("没有取得服务器成功保存回执");
            File.Delete(path);return result;
        }
        finally{businessWriteGate.Release();}
    }

    private async Task QueryPendingActionsAsync()
    {
        await RefreshCommandRecoveryAsync();
        var messages=new List<string>();
        foreach(var type in new[]{"business-write"})
        {
            var path=PendingPath(type);if(!File.Exists(path))continue;
            try
            {
                using var doc=JsonDocument.Parse(await File.ReadAllBytesAsync(path,lifetime.Token));var pending=doc.RootElement;
                if(pending.Text("server")!=settings.Server){messages.Add("其他服务器仍有待确认操作："+pending.Text("server"));continue;}
                var oid=pending.Text("operation_id")??throw new InvalidDataException("待确认记录缺少操作身份");
                var record=(await ReadRpcAsync("operations.get",new{operation_id=oid})).Field("operation");
                if(record.Text("operation_id")!=oid||record.Text("method")!=pending.Text("method"))throw new InvalidDataException("操作身份不匹配");
                var state=record.Text("state");messages.Add("业务保存 "+oid+"："+state);
                if(state is "committed" or "rejected"){File.Delete(path);resources.Clear();await LoadParityDataAsync();}
            }
            catch(Exception e){messages.Add("仍待确认："+SafeError(e));}
        }
        var directory=Path.GetDirectoryName(PendingPath("file"))!;
        if(Directory.Exists(directory))foreach(var path in Directory.EnumerateFiles(directory,"pending-file-*.json"))
        {
            try
            {
                using var document=JsonDocument.Parse(await File.ReadAllBytesAsync(path,lifetime.Token));var pending=document.RootElement;
                if(pending.Text("server")!=settings.Server)continue;
                var oid=pending.Field("body").Text("operation_id")??throw new InvalidDataException("文件操作缺少身份");
                var result=await ReadRpcAsync("file.operations.get",new{operation_id=oid});
                if(result.Text("id")!=oid)throw new InvalidDataException("文件操作回执不匹配");
                messages.Add(pending.Text("method")+"："+result.Text("state"));
                if(result.Text("state") is "completed" or "failed" or "cancelled" or "interrupted")
                {
                    if(pending.Text("method")=="downloads.open"&&FileResult(result).Text("state")=="ready")
                        await ReadRpcAsync("downloads.close",new{download_id=FileResult(result).Text("id")});
                    File.Delete(path);
                }
            }
            catch(Exception e){messages.Add("文件操作仍待确认："+SafeError(e));}
        }
        if(messages.Count>0)ShowNativeDialog("待确认业务保存",Text(string.Join("\n\n",messages),12),760,400);
    }
}
