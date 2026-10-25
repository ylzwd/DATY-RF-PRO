using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;
using Microsoft.Win32;

namespace Daty.Native.App;

public partial class MainWindow
{
    private static JsonElement FileResult(JsonElement reply)=>reply.Field("result").ValueKind==JsonValueKind.Object?reply.Field("result"):reply.Field("domain_status").ValueKind==JsonValueKind.Object?reply.Field("domain_status"):reply;
    private async Task<JsonElement> FileOperationAsync(string method,Dictionary<string,object?> body)
    {
        var oid=Guid.NewGuid().ToString("N");body["operation_id"]=oid;var path=PendingPath("file-"+oid);
        await LocalFiles.WriteAtomicAsync(path,JsonSerializer.Serialize(new{server=settings.Server,method,body}),lifetime.Token);
        JsonElement result;
        try{result=await ReadRpcAsync(method,body,bridge?.BootId);}
        catch{result=await ReadRpcAsync("file.operations.get",new{operation_id=oid});}
        for(int i=0;i<240&&result.Text("state")=="preparing";i++)
        {
            Message("正在准备服务器文件："+FormatBytes(result.Field("result").Number("prepared_bytes"))+" / "+FormatBytes(result.Field("result").Number("bytes")));
            await Task.Delay(250,connection.Token);result=await ReadRpcAsync("file.operations.get",new{operation_id=oid});
        }
        if(result.Text("id")!=oid)throw new InvalidDataException("服务器文件操作身份不匹配");
        if(result.Text("state")=="completed"){File.Delete(path);return FileResult(result);}
        throw new InvalidDataException("文件操作结果待确认，原操作记录已保留："+oid+(fixtureNetwork?" "+result.GetRawText():""));
    }

    private async Task OpenActivityDetailAsync(TimelineRow row)
    {
        try
        {
            using var item=JsonDocument.Parse(row.Details);var r=item.RootElement;
            var detail=await ReadRpcAsync("database.activity.get",new{source=r.Text("source"),id=r.Field("id")});
            var p=new StackPanel();p.Children.Add(Heading("业务变更与执行证据",16));
            p.Children.Add(new TextBox{Text=JsonSerializer.Serialize(detail,new JsonSerializerOptions{WriteIndented=true}),IsReadOnly=true,AcceptsReturn=true,TextWrapping=TextWrapping.Wrap,Height=370,VerticalScrollBarVisibility=ScrollBarVisibility.Auto});
            p.Children.Add(ActionButton("导出本条记录",()=>_=ExportAsync("审计详情",detail)));ShowNativeDialog("审计详情",p,800,510);
        }catch(Exception e){Message("读取审计详情失败："+SafeError(e),true);}
    }

    private async Task DownloadArchiveAsync(ArchiveRow row)
    {
        if(row.Raw.Text("status")!="saved"){ShowNativeDialog("存档状态",Text(row.Raw.GetRawText(),12),700,440);return;}
        var save=new SaveFileDialog{Title="保存服务器文件",FileName=row.Name,Filter="所有文件|*.*"};if(save.ShowDialog(this)!=true)return;
        var target=Path.GetFullPath(save.FileName);var temporary=Path.Combine(Path.GetDirectoryName(target)!,".daty-download-"+Guid.NewGuid().ToString("N")+".part");
        try
        {
            var descriptor=await FileOperationAsync("downloads.open",new(){{"category",row.Type=="完整存档"?"archives":"exports"},{"id",row.Raw.Text("id")},{"sha256",row.Raw.Text("sha256")}});
            if(descriptor.Text("sha256")!=row.Raw.Text("sha256")||descriptor.Number("bytes")!=row.Raw.Number("bytes"))throw new InvalidDataException("服务器文件已改变，请刷新后重试");
            var client=bridge??throw new IOException("未连接");var epoch=generation;
            await using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None,131072,FileOptions.Asynchronous|FileOptions.WriteThrough))
            {await new R19Transfers((m,b,t)=>client.CallAsync(m,b,t)).DownloadAsync(descriptor,stream,connection.Token);stream.Flush(true);}
            if(epoch!=generation)throw new OperationCanceledException();File.Move(temporary,target,true);Message("服务器文件已下载，完整 SHA256 校验通过");
        }catch(Exception e){Message("下载未完成："+SafeError(e),true);}finally{if(File.Exists(temporary))File.Delete(temporary);}
    }

    private async Task ClearArchiveFilesAsync(ArchiveRow? selectedFile=null)
    {
        try
        {
            var plan=await FileOperationAsync("cleanups.prepare",new(){{"selection",selectedFile is null?(object)new{category="all"}:new{category=selectedFile.Type=="完整存档"?"archives":"exports",id=selectedFile.Raw.Text("id")}}});var items=Array(plan,"items");
            if(plan.Text("protocol")!="daty-archive-cleanup-v1"||plan.Text("status")!="prepared"||string.IsNullOrEmpty(plan.Text("planSha256")))throw new InvalidDataException("服务器清理清单不完整");
            if(items.Length==0){Message("没有可清理的服务器存档文件");return;}
            var details=items.Select(r=>(Label:r.Text("category")=="archives"?"完整存档":"导出文件",Value:(r.Text("fileName")??r.Text("id")??"—")+" · "+FormatBytes(r.Number("bytes")))).ToArray();
            if(!Confirm("清空服务器存档文件",$"删除清单中的 {items.Length} 份文件。请先下载需要保留的备份，删除后不能从此页面恢复。","删除清单文件",true,details,"只处理上述文件；业务数据库与设备数据保留。"))return;
            var result=await FileOperationAsync("cleanups.commit",new(){{"cleanup_id",plan.Text("id")},{"confirmed",true},{"planSha256",plan.Text("planSha256")}});
            if(result.Text("id")!=plan.Text("id"))throw new InvalidDataException("清理回执身份不匹配");
            Message($"服务器清理结果：{result.Text("status")} · 已删除 {result.Text("deletedCount")??"0"} 份");if(currentPage=="data")ShowPage("data");
        }catch(Exception e){Message("清理结果未确认："+SafeError(e),true);}
    }
    private static string FormatBytes(double? bytes)=>bytes is not double size?"—":size>=1073741824?$"{size/1073741824:0.0} GB":size>=1048576?$"{size/1048576:0.0} MB":$"{size/1024:0.0} KB";
}
