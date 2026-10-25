using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using Daty.Native.Core;
namespace Daty.Native.App;
public partial class MainWindow
{
    // Only consumed by windows created explicitly for isolated verification.
    private Func<Task>? closeVerificationCleanup;
    private static MainWindow CloseTestWindow()=>new(true){ShowInTaskbar=false,WindowState=WindowState.Normal,Left=-12000,Top=-12000,WindowStartupLocation=WindowStartupLocation.Manual};
    private static void CloseCheck(bool condition,string message){if(!condition)throw new InvalidDataException(message);}
    private static async Task<object> CheckWindowExitAsync(MainWindow window,string name,int repeat=1,Action? beforeClose=null)
    {
        var closed=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var ticks=0;var timer=new DispatcherTimer{Interval=TimeSpan.FromMilliseconds(20)};
        timer.Tick+=(_,_)=>ticks++;timer.Start();window.Closed+=(_,_)=>closed.TrySetResult();
        window.Show();beforeClose?.Invoke();var watch=Stopwatch.StartNew();
        try
        {
            for(var i=0;i<repeat;i++)window.Close();
            await closed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if(window.shutdownTask is not null)await window.shutdownTask;
            CloseCheck(window.shutdownComplete&&!window.IsVisible,name+": window must close");
            if(name is "slow-cleanup" or "cleanup-timeout")CloseCheck(ticks>=5,name+": dispatcher remained responsive");
            if(name=="cleanup-timeout")CloseCheck(window.shutdownWarning=="transport cleanup exceeded 3 seconds",name+": bounded wait");
            else if(name!="cleanup-error")CloseCheck(window.shutdownWarning is null,name+": cleanup actually completed");
            return new{name,elapsedMs=watch.ElapsedMilliseconds,dispatcherTicks=ticks,warning=window.shutdownWarning};
        }
        finally{timer.Stop();}
    }
    internal static async Task VerifyCloseAsync(string directory)
    {
        Directory.CreateDirectory(directory);var errors=new List<string>();var results=new List<object>();
        DispatcherUnhandledExceptionEventHandler capture=(_,e)=>{errors.Add(e.Exception.ToString());e.Handled=true;};
        Application.Current.DispatcherUnhandledException+=capture;
        try
        {
            results.Add(await CheckWindowExitAsync(CloseTestWindow(),"idle"));
            results.Add(await CheckWindowExitAsync(CloseTestWindow(),"repeated-close",20));
            var calls=0;var slow=CloseTestWindow();
            slow.closeVerificationCleanup=()=>{Interlocked.Increment(ref calls);Thread.Sleep(250);return Task.CompletedTask;};
            results.Add(await CheckWindowExitAsync(slow,"slow-cleanup",20));
            CloseCheck(calls==1,"Repeated close must run cleanup exactly once");
            var stuck=CloseTestWindow();stuck.closeVerificationCleanup=()=>Task.Delay(3500);
            results.Add(await CheckWindowExitAsync(stuck,"cleanup-timeout",3));
            var broken=CloseTestWindow();broken.closeVerificationCleanup=()=>Task.FromException(new IOException("isolated cleanup failure"));
            results.Add(await CheckWindowExitAsync(broken,"cleanup-error"));
            var pending=CloseTestWindow();var commit=new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending.systemSettingsWriter=new ImmediateSettings((_,_)=>commit.Task,(_,_,_,_)=>{});
            var value=JsonSerializer.SerializeToElement(new{enabled=true});var save=pending.systemSettingsWriter.Submit("alert_sound",value);
            pending.Show();pending.Close();await Task.Delay(100);
            CloseCheck(pending.IsVisible&&pending.Shell.IsEnabled&&!pending.shutdownStarted&&!pending.connection.IsCancellationRequested&&pending.currentPage=="settings","Pending setting must keep a responsive connection and show settings");
            commit.SetResult(value);await save;
            results.Add(await CheckWindowExitAsync(pending,"setting-confirmed-after-block"));
            var unknown=CloseTestWindow();unknown.settingOperations["alert_sound"]=(Guid.NewGuid().ToString("N"),new());unknown.Show();unknown.Close();
            CloseCheck(unknown.IsVisible&&!unknown.shutdownStarted&&!unknown.connection.IsCancellationRequested,"Unknown commit receipt must block exit without canceling reconciliation");
            unknown.settingOperations.Clear();results.Add(await CheckWindowExitAsync(unknown,"receipt-resolved-after-block"));
            // An accepted TCP connection with no TLS reply exercises cancellation during handshake.
            using var listener=new TcpListener(IPAddress.Loopback,0);listener.Start();var port=((IPEndPoint)listener.LocalEndpoint).Port;
            var connecting=CloseTestWindow();var ca=Path.Combine(AppContext.BaseDirectory,"assets","DATY-root-ca.cer");
            connecting.bridge=new R19MqttClient("https://127.0.0.1:8080",ca,port);
            var read=connecting.bridge.CallAsync("devices.snapshot");using var accepted=await listener.AcceptTcpClientAsync().WaitAsync(TimeSpan.FromSeconds(5));
            connecting.deviceStream=new R19DeviceStream("https://127.0.0.1:8080",ca,port);connecting.deviceStream.Start();
            results.Add(await CheckWindowExitAsync(connecting,"pending-tls-handshake",3));
            try{await read;throw new InvalidDataException("Pending read unexpectedly succeeded");}catch(Exception e)when(e is OperationCanceledException or ObjectDisposedException or MQTTnet.Exceptions.MqttCommunicationException){}
            await connecting.bridge.DisposeAsync();await connecting.deviceStream.DisposeAsync();
            bool rejected=false;try{connecting.deviceStream.Start();}catch(ObjectDisposedException){rejected=true;}CloseCheck(rejected,"Disposed stream cannot restart");
            CloseCheck(errors.Count==0,"No WPF dispatcher exceptions: "+string.Join("\n",errors));
            File.WriteAllText(Path.Combine(directory,"close-result.json"),JsonSerializer.Serialize(new{ok=true,checks=results,unhandledErrors=errors,physicalCommands=0},new JsonSerializerOptions{WriteIndented=true}));
        }
        finally{File.WriteAllText(Path.Combine(directory,"close-errors.txt"),string.Join("\n",errors));Application.Current.DispatcherUnhandledException-=capture;}
    }
}
