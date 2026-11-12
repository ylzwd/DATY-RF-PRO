using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Threading;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class App
{
    private const string StartupPipeVariable="DATY_PROJECT_STARTUP_PIPE";
    private static bool ValidPipe(string name)=>Regex.IsMatch(name,"^daty-startup-[a-f0-9]{32}$");
    private async Task<bool> StartProjectDesktopHostAsync()
    {
        if(ProjectEnvironment.Current is not { } project)return false;
        var boot=Environment.GetEnvironmentVariable("DATY_PROJECT_DESKTOP_BOOT");
        if(boot is not null)
        {
            Identity.VerifyInstallation(project.Root);
            if(!Regex.IsMatch(boot,"^[a-f0-9]{32}$"))throw new InvalidDataException("独立项目窗口启动身份无效");
            return false;
        }
        ShutdownMode=ShutdownMode.OnExplicitShutdown;
        var splash=new StartupWindow();MainWindow=splash;
        var cancel=new CancellationTokenSource(TimeSpan.FromSeconds(270));
        splash.Closed+=(_,_)=>{cancel.Cancel();cancel.Dispose();Shutdown(0);};splash.Show();
        try
        {
            // Render before identity checks, hashing or starting the Python host.
            await Dispatcher.InvokeAsync(()=>{},DispatcherPriority.ContextIdle);
            if(!splash.IsVisible)return true;
            Identity.VerifyInstallation(project.Root);
            var name="daty-startup-"+Guid.NewGuid().ToString("N");
            using var pipe=new NamedPipeServerStream(name,PipeDirection.In,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
            var info=new ProcessStartInfo(Path.Combine(project.Root,"app/tools/python/python.exe")){
                UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=project.Root,RedirectStandardOutput=true,RedirectStandardError=true,
                StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};
            info.Environment[StartupPipeVariable]=name;
            foreach(var argument in new[]{"-X","utf8","-B",Path.Combine(project.Root,"scripts/project-local.py"),"launch","--startup-owner",Environment.ProcessId.ToString()})info.ArgumentList.Add(argument);
            using var host=Process.Start(info)??throw new IOException("启动任务无法打开");
            var errors=host.StandardError.ReadToEndAsync();
            _=errors.ContinueWith(t=>_ =t.Exception,TaskContinuationOptions.OnlyOnFaulted);
            async Task Progress()
            {
                try
                {
                    while(await host.StandardOutput.ReadLineAsync(cancel.Token) is { } line)
                    {
                        if(line.Length>4096)continue;
                        using var doc=JsonDocument.Parse(line);
                        if(doc.RootElement.Text("schema")=="daty-startup-v1")splash.SetStage(doc.RootElement.Text("stage")??"waiting");
                    }
                }
                catch(Exception e)when(e is OperationCanceledException or IOException or ObjectDisposedException or JsonException){}
            }
            async Task Rendered()
            {
                await pipe.WaitForConnectionAsync(cancel.Token);
                using var reader=new StreamReader(pipe);
                var line=await reader.ReadLineAsync(cancel.Token);
                if(line is null||line.Length>4096)throw new InvalidDataException("工作台启动确认无效");
                using var doc=JsonDocument.Parse(line);Identity.RequireMatch(doc.RootElement.Field("product"));
                if(doc.RootElement.Text("stage")!="rendered")throw new InvalidDataException("工作台尚未完成显示");
            }
            var progress=Progress();var rendered=Rendered();var exit=host.WaitForExitAsync(cancel.Token);
            await Task.WhenAny(rendered,exit).WaitAsync(cancel.Token);
            if(!rendered.IsCompletedSuccessfully)
            {
                if(rendered.IsCompleted)await rendered;
                var message=await errors;
                throw new IOException(string.IsNullOrWhiteSpace(message)?"启动任务未能打开工作台，请查看本项目启动日志。":message.Trim());
            }
            await rendered;cancel.Cancel();await progress;Shutdown(0);
        }
        catch(OperationCanceledException){if(splash.IsVisible)splash.ShowFailure("启动等待超时，请关闭后重试；原有数据已保留。");}
        catch(Exception error){if(splash.IsVisible)splash.ShowFailure(error.Message);}
        return true;
    }
    private static void AttachStartupReady(MainWindow window)
    {
        var name=Environment.GetEnvironmentVariable(StartupPipeVariable);
        if(name is null)return;
        Environment.SetEnvironmentVariable(StartupPipeVariable,null);
        window.ContentRendered+=Rendered;
        async void Rendered(object? sender,EventArgs e)
        {
            window.ContentRendered-=Rendered;
            try
            {
                if(!ValidPipe(name))throw new InvalidDataException("启动确认通道无效");
                using var pipe=new NamedPipeClientStream(".",name,PipeDirection.Out,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
                await pipe.ConnectAsync(5000);
                using var writer=new StreamWriter(pipe){AutoFlush=true};
                await writer.WriteLineAsync(JsonSerializer.Serialize(new{stage="rendered",product=new{product=Identity.Product,version=Identity.Version,buildId=Identity.BuildId,contractSchema=Identity.ContractSchema,databaseSchema=Identity.DatabaseSchema}}));
            }
            catch(Exception error)when(error is IOException or TimeoutException or InvalidDataException or UnauthorizedAccessException)
            {
                // Cancellation closes only this new window. Its ordinary host
                // still owns graceful shutdown and preserves other windows.
                if(window.IsVisible)window.Close();
            }
        }
    }
}
