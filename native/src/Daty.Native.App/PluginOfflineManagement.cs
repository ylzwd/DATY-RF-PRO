using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;
using Microsoft.Win32;

namespace Daty.Native.App;

public partial class MainWindow
{
    private bool exportingPlugin;
    private PluginExportRemovalService? pluginRemovals;
    private bool queryingPluginRemoval;
    private async Task<BundleTrust[]> OfflineCatalogAsync(CancellationToken token)
        =>PluginOfflineBundle.Catalog(await LocalFiles.ReadBoundedAsync(Path.Combine(AppContext.BaseDirectory,"assets","plugin-bundles.json"),65536,token));
    private async Task<PluginOfflineBundle> OpenOfflineBundleAsync(string path,CancellationToken token,bool includeLegacy=false)
    {
        var catalog=await OfflineCatalogAsync(token);
        if(includeLegacy)
        {
            var legacyPath=Path.Combine(AppContext.BaseDirectory,"assets","plugin-bundles-legacy.json");
            if(File.Exists(legacyPath))
                catalog=catalog.Concat(PluginOfflineBundle.Catalog(await LocalFiles.ReadBoundedAsync(legacyPath,65536,token))).Distinct().ToArray();
        }
        return await PluginOfflineBundle.OpenAsync(path,catalog,token);
    }
    private async Task<bool> PrepareBundleDependenciesAsync(PluginOfflineBundle bundle,long epoch,CancellationToken token)
    {
        // Shure discovery, telemetry and commands use SCP directly. The bundled
        // official installer is an optional resource, not an import prerequisite.
        if(bundle.Manifest.Id=="shure-scp")return epoch==generation&&!token.IsCancellationRequested;
        if(!LocalRuntimeDependency.IsLocalServer(new Uri(settings.Server)))throw new InvalidDataException("完整包包含本机官方服务，请在目标服务器电脑上导入；不能将依赖安装到远程客户端。");
        foreach(var runtime in bundle.Manifest.Runtimes)
        {
            var health=await LocalRuntimeDependency.CheckAsync(runtime.Probe,token);
            if(epoch!=generation||token.IsCancellationRequested)return false;
            if(health.Ready)continue;
            if(health.Installed)throw new IOException(runtime.Name+"："+health.Message+"。请恢复官方服务后重新导入；不会重复安装。");
            if(!Confirm("安装插件依赖",runtime.Name+" 尚未安装。打开包内官方安装向导，完成后继续导入插件。","打开官方安装程序",details:[("发布者",runtime.Publisher),("版本",runtime.Version),("提示","按官方向导完成许可和管理员步骤；取消不会启用新插件")]))return false;
            if(epoch!=generation||token.IsCancellationRequested)return false;
            var directory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"DATY RF PRO Native","RuntimeInstallers");
            var installer=await bundle.StageInstallerAsync(runtime,directory,token);
            await PluginOfflineBundle.VerifyFileAsync(installer,runtime.Installer.Sha256,runtime.Installer.Bytes,token);
            if(epoch!=generation||token.IsCancellationRequested)return false;
            // Keep reviewed bytes read-locked until the installer exits. No shell
            // arguments, silent license acceptance or copied credentials.
            using var guard=new FileStream(installer,FileMode.Open,FileAccess.Read,FileShare.Read);
            Message("请在官方安装向导完成 "+runtime.Name+" 安装，完成后将自动核验…");
            using var process=Process.Start(new ProcessStartInfo(installer){UseShellExecute=true})??throw new IOException("无法启动官方安装程序");
            await process.WaitForExitAsync(token);
            if(process.ExitCode is not 0 and not 3010)throw new IOException("官方安装未完成，退出码 "+process.ExitCode);
            var wait=Stopwatch.StartNew();
            do
            {
                if(epoch!=generation||token.IsCancellationRequested)return false;
                health=await LocalRuntimeDependency.CheckAsync(runtime.Probe,token);if(health.Ready)break;
                await Task.Delay(1000,token);
            }while(wait.Elapsed<TimeSpan.FromSeconds(60));
            if(!health.Ready)throw new IOException(runtime.Name+" 尚未就绪："+health.Message+"。完成官方配置后重新导入；本次未启用新插件。");
        }
        return true;
    }
    private async Task RecoverPluginRemovalAsync()
    {
        if(queryingPluginRemoval||pluginRemovals?.Pending is null)return;
        var service=pluginRemovals;var epoch=generation;var token=connection.Token;queryingPluginRemoval=true;
        try
        {
            int attempts=0;
            while(service.Pending is not null&&!token.IsCancellationRequested&&epoch==generation)
            {
                try
                {
                    var receipt=await service.QueryAsync(token);
                    if(epoch!=generation||token.IsCancellationRequested)return;
                    var status=await bridge!.CallAsync("plugins.status",token:token);
                    if(epoch!=generation||token.IsCancellationRequested)return;
                    ApplyPluginStatus(status);
                    if(receipt.Text("state")=="removed"){Message("插件包已导出并校验，母平台已自动移除该品牌插件");return;}
                    if(attempts==0)Message("完整包已保存，服务器将在在途指令核对完成后自动移除插件");
                }
                catch(OperationCanceledException)when(token.IsCancellationRequested){return;}
                catch(Exception e)
                {
                    if(epoch!=generation||token.IsCancellationRequested)return;
                    if(attempts==0||service.Pending is null)Message("导出卸载状态："+SafeError(e),true);
                    if(service.Pending is null||e is InvalidDataException)return;
                }
                attempts++;await Task.Delay(attempts<8?500:2000,token);
            }
        }
        catch(OperationCanceledException){ }

        finally{queryingPluginRemoval=false;}
    }
    private async Task ExportPluginPackageAsync()
    {
        if(exportingPlugin||pluginRemovals is null)return;
        if(pluginRemovals.Pending is not null){await RecoverPluginRemovalAsync();return;}
        exportingPlugin=true;bool saved=false;
        try
        {
            var epoch=generation;var token=connection.Token;var remover=pluginRemovals;
            var state=await ReadRpcAsync("plugins.status");var boot=bridge!.BootId!;
            using var catalog=JsonDocument.Parse(await LocalFiles.ReadBoundedAsync(Path.Combine(AppContext.BaseDirectory,"assets","plugin-sources.json"),1048576,token));
            var items=catalog.RootElement.EnumerateArray().Where(i=>Array(state,"plugins").Any(p=>p.Text("id")==i.Text("id")&&p.Text("sha256")==i.Text("sha256")&&p.Field("active").True())).ToArray();
            if(items.Length==0)throw new InvalidDataException("当前安装版本没有匹配的导出包，请使用与服务器插件版本一致的原生发行包");
            var selected=items[0];
            if(items.Length>1)
            {
                var panel=new StackPanel();panel.Children.Add(Heading("选择品牌配接文件"));
                var window=new Window{Owner=this,Title="开发者插件导出",Width=420,Height=280,WindowStartupLocation=WindowStartupLocation.CenterOwner,Content=Panel(panel)};
                bool accepted=false;foreach(var item in items)panel.Children.Add(ActionButton(item.Text("name")??item.Text("id")??"—",()=>{selected=item;accepted=true;window.Close();}));
                window.ShowDialog();if(!accepted)return;
            }
            var offline=(await OfflineCatalogAsync(token)).SingleOrDefault(b=>b.Id==selected.Text("id")&&b.PluginSha256==selected.Text("sha256"));
            if(epoch!=generation||token.IsCancellationRequested)return;
            var dialog=new SaveFileDialog{Title="导出完整包后自动移除母平台中的插件",Filter="品牌插件 ZIP|*.zip",FileName=offline?.FileName??selected.Text("fileName")??"DATY-plugin.zip"};
            if(dialog.ShowDialog(this)!=true)return;
            if(epoch!=generation||token.IsCancellationRequested)return;
            Message("正在校验并导出完整插件包…");
            if(offline is not null)
            {
                await using var bundle=await OpenOfflineBundleAsync(PluginOfflineBundle.SourcePath(AppContext.BaseDirectory,offline.FileName,ProjectEnvironment.Current),token);
                await bundle.ExportAsync(dialog.FileName,token);
                saved=true;
            }
            else
            {
                var bytes=Convert.FromBase64String(selected.Text("base64")??"");
                if(bytes.Length!=selected.Number("bytes")||Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant()!=selected.Text("sha256"))throw new InvalidDataException("配接文件校验失败");
                await LocalFiles.WriteAtomicBytesAsync(dialog.FileName,bytes,token);saved=true;
            }
            if(epoch!=generation||token.IsCancellationRequested)return;
            var receipt=await remover.RemoveVerifiedExportAsync(dialog.FileName,selected.Text("id")!,selected.Text("sha256")!,state.GetProperty("revision").GetInt32(),boot,offline?.Sha256??selected.Text("sha256")!,offline?.Bytes??(long)selected.Number("bytes")!.Value,token);
            Message(receipt.Text("state")=="removed"?"插件包已导出并校验，母平台已移除该品牌插件":"插件包已导出并校验，服务器正在自动移除插件…");
            await RecoverPluginRemovalAsync();await LoadPluginsAsync();
        }
        catch(OperationCanceledException){if(saved)Message("导出文件已保存；卸载状态将在连接恢复后自动查询",true); }
        catch(Exception e){Message((saved?"导出文件已保存，卸载尚未完成：":"插件导出失败：")+SafeError(e),true);}
        finally{exportingPlugin=false;}
    }
}
