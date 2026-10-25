using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private async Task EnsureLocalServerAsync()
    {
        // Only this installed server's local endpoint can start its existing task.
        // Remote clients, development output and verification fixtures never do so.
        try
        {
            if(ProjectEnvironment.Current is { } project)
            {
                // The project host has already confirmed readiness and owns shutdown.
                // Never queue a second start that could outlive an early window close.
                if(Environment.GetEnvironmentVariable("DATY_PROJECT_DESKTOP_BOOT") is not null)return;
                throw new InvalidDataException("请使用启动 DATY RF PRO 或完整项目内的 EXE，统一启动界面与后台。");
            }
            var origin=new Uri(settings.Server);
            if(!IPAddress.TryParse(origin.Host,out var address)) return;
            if(!IPAddress.IsLoopback(address) && !NetworkInterface.GetAllNetworkInterfaces().SelectMany(n=>n.GetIPProperties().UnicastAddresses).Any(a=>a.Address.Equals(address))) return;
            var directory=new DirectoryInfo(AppContext.BaseDirectory);
            if(directory.Parent?.Name!="publish" || directory.Parent.Parent?.Name!="native") return;
            var root=directory.Parent.Parent.Parent?.FullName;
            if(root is null) return;
            var configFile=Path.Combine(root,"config","runtime-config.json");
            var layoutFile=Path.Combine(root,"project-layout.json");
            if(!File.Exists(configFile)||!File.Exists(layoutFile)) return;
            var token=lifetime.Token;
            using var config=JsonDocument.Parse(await LocalFiles.ReadBoundedAsync(configFile,32768,token));
            var c=config.RootElement;
            if(c.GetProperty("web_port").GetInt32()!=origin.Port || c.GetProperty("mqtt_port").GetInt32()!=settings.MqttPort) return;
            var statusFile=Path.Combine(c.GetProperty("runtime_directory").GetString()!,"runtime-status.json");
            var epoch=c.GetProperty("database_epoch").GetString()!;
            var python=Path.GetFullPath(Path.Combine(root,"app","tools","python","python.exe"));
            bool OwnsProcess(int pid)
            {
                try { using var p=Process.GetProcessById(pid);return !p.HasExited&&string.Equals(p.MainModule?.FileName,python,StringComparison.OrdinalIgnoreCase); }
                catch { return false; }
            }
            async Task<bool> Ready()
            {
                try { using var status=JsonDocument.Parse(await LocalFiles.ReadBoundedAsync(statusFile,131072,token));return LocalServerReadiness.IsReady(status.RootElement,epoch,DateTimeOffset.UtcNow,OwnsProcess); }
                catch(IOException) { return false; }
                catch(JsonException) { return false; }
            }
            if(await Ready()) return;
            Message("正在准备本机服务器，准备好后将自动连接…");
            using var layout=JsonDocument.Parse(await LocalFiles.ReadBoundedAsync(layoutFile,32768,token));
            var taskName=layout.RootElement.GetProperty("task").GetString()!;
            // Use the Windows task API directly; do not depend on a shell's script policy.
            await Task.Run(()=>StartExistingServerTask(taskName,python),token);
            var wait=Stopwatch.StartNew();
            while(wait.Elapsed<TimeSpan.FromSeconds(120))
            {
                token.ThrowIfCancellationRequested();
                if(await Ready()) return;
                await Task.Delay(250,token);
            }
            // Cancelling a window never kills the server or its pending transaction.
            Message("本机服务器尚未就绪，将继续自动连接；详细原因见服务器运行状态。",true);
        }
        catch(OperationCanceledException) when(lifetime.IsCancellationRequested) { }
        catch(Exception error) { if(!shutdownStarted) Message("本机服务器检查未完成："+SafeError(error),true); }
    }

    private static void StartExistingServerTask(string taskName,string python)
    {
        var objects=new List<object>();
        dynamic Keep(object value) { objects.Add(value);return value; }
        try
        {
            dynamic service=Keep(Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service",true)!)!);
            service.Connect();
            dynamic folder=Keep(service.GetFolder("\\"));
            dynamic task=Keep(folder.GetTask(taskName));
            dynamic definition=Keep(task.Definition);
            dynamic actions=Keep(definition.Actions);
            if((int)actions.Count!=1)throw new InvalidDataException("服务器启动任务不属于当前项目");
            dynamic action=Keep(actions.Item(1));
            if((int)action.Type!=0 || !string.Equals(Path.GetFullPath((string)action.Path),python,StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("服务器启动任务不属于当前项目");
            if((int)task.State!=4)
            {
                task.Enabled=true;
                Keep(task.Run(null));
            }
        }
        finally
        {
            for(var i=objects.Count-1;i>=0;i--)if(Marshal.IsComObject(objects[i]))Marshal.FinalReleaseComObject(objects[i]);
        }
    }
}
