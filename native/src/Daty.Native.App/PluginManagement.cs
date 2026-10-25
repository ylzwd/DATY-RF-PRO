using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using Daty.Native.Core;
using Microsoft.Win32;

namespace Daty.Native.App;

public partial class MainWindow
{
    private static JsonElement ReadBody(JsonElement reply)
    {
        if (reply.Text("status")=="download_required") throw new InvalidDataException("此结果需要分块下载，原生文件传输尚待下一阶段接入");
        if (reply.Number("status") is >=400) throw new IOException(reply.Field("body").Text("error")??"服务器读取失败");
        return reply.Field("body").ValueKind==JsonValueKind.Object?reply.GetProperty("body"):reply;
    }
    private async Task LoadPluginsAsync()
    {
        var client=bridge;var epoch=generation;var token=connection.Token;
        if(client is null)return;
        try
        {
            await RecoverPluginRemovalAsync();
            var status=await client.CallAsync("plugins.status",token:token);
            if(epoch!=generation||token.IsCancellationRequested)return;
            ApplyPluginStatus(status);
        }
        catch(Exception error){if(epoch==generation&&!token.IsCancellationRequested)Message("插件状态读取失败："+SafeError(error),true);}
    }
    private bool IsOlderPluginState(JsonElement incoming)=>pluginState is { } current&&current.Number("revision") is double known
        &&(incoming.Number("revision") is not double next||next<known);
    private void ApplyPluginStatus(JsonElement status)
    {
        if(IsOlderPluginState(status))return;
        pluginState=status;pluginRefresh?.Invoke();
    }
    private async Task ImportPluginAsync()
    {
        if(importing||pluginImports is null)return;
        if(pluginImports.Pending is not null){await QueryPluginAsync();return;}
        var dialog=new OpenFileDialog{Title="导入品牌插件",Filter="品牌插件 ZIP|*.zip",CheckFileExists=true,Multiselect=false};
        if(dialog.ShowDialog(this)!=true)return;
        var service=pluginImports;var epoch=generation;var token=connection.Token;
        importing=true;pluginRefresh?.Invoke();
        try
        {
            Message("正在校验品牌插件…");
            await using var file=await PluginImportFile.OpenAsync(dialog.FileName,Path.Combine(AppContext.BaseDirectory,"assets"),token);
            var bundle=file.Bundle;var bytes=file.Package;
            var prepared=await service.PrepareAsync(bytes,token);
            if(epoch!=generation||token.IsCancellationRequested)return;
            if(file.RequiresDependencySetup)
            {
                if(!await PrepareBundleDependenciesAsync(bundle!,epoch,token))return;
                if(epoch!=generation||token.IsCancellationRequested)return;
                // An official setup may outlive the original server revision/boot.
                prepared=await service.PrepareAsync(bytes,token);
            }
            if(prepared.AlreadyActive){Message(prepared.Brand+" 插件已导入并启用，无需重复安装");_=LoadPluginsAsync();return;}
            var answer=Confirm("导入品牌插件","服务器已完成校验。安装并启用此插件？","安装并启用",details:[("品牌",prepared.Brand),("版本",prepared.Version),("源码文件",prepared.SourceFiles.ToString())]);
            if(!answer){Message("已取消，未安装插件");return;}
            if(epoch!=generation||token.IsCancellationRequested)return;
            Message("正在保存并启用插件…");
            var receipt=await service.InstallAsync(prepared,token);
            if(epoch!=generation||token.IsCancellationRequested)return;
            ShowInstallReceipt(receipt);
            // The durable matched receipt completes installation. Discovery and
            // the optional status refresh must not keep the import button busy.
            _=LoadPluginsAsync();
        }
        catch(Exception error)
        {
            if(epoch==generation&&!token.IsCancellationRequested)Message(service.Pending is not null?"安装结果尚未确认，请点击“查询安装结果”；不会自动重复安装。":"插件未安装："+SafeError(error),true);
        }
        finally{importing=false;pluginRefresh?.Invoke();}
    }
    private async Task QueryPluginAsync()
    {
        if(importing||pluginImports?.Pending is null)return;
        var service=pluginImports;var epoch=generation;var token=connection.Token;importing=true;pluginRefresh?.Invoke();
        try{var receipt=await service.QueryAsync(token);if(epoch!=generation||token.IsCancellationRequested)return;ShowInstallReceipt(receipt);_=LoadPluginsAsync();}
        catch(Exception error){if(epoch==generation&&!token.IsCancellationRequested)Message("安装结果查询："+SafeError(error),true);}
        finally{importing=false;pluginRefresh?.Invoke();}
    }
    private void ShowInstallReceipt(JsonElement receipt)
    {
        if(IsOlderPluginState(receipt)){Message("已核实此前安装回执，当前插件状态已有更新");return;}
        if(receipt.Text("activation")=="active"&&receipt.Text("state")=="installed")
        {
            // Only a validated installation receipt updates the card. This is
            // not an online receiver assertion and does not wait for LAN scans.
            var state=pluginState is { } prior?JsonNode.Parse(prior.GetRawText())!.AsObject():new JsonObject();
            var plugins=state["plugins"] as JsonArray??new JsonArray();
            if(state["plugins"] is null)state["plugins"]=plugins;
            for(int i=plugins.Count-1;i>=0;i--)if(plugins[i]?["id"]?.GetValue<string>()==receipt.Text("id"))plugins.RemoveAt(i);
            var installed=JsonNode.Parse(receipt.GetRawText())!.AsObject();installed["active"]=true;plugins.Add(installed);
            if(receipt.Number("revision") is { } revision)state["revision"]=revision;
            pluginState=JsonSerializer.SerializeToElement(state);pluginRefresh?.Invoke();
            Message("插件已保存并启用，接收机将在后台自动发现");
        }
        else if(receipt.Text("activation")=="failed")Message("安装已记录，但启用失败："+receipt.Text("error"),true);
        else Message("安装结果尚未确认，请查询原操作结果",true);
    }
}
