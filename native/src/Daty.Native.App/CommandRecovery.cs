using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private readonly SemaphoreSlim commandRecoveryGate=new(1,1);
    private readonly HashSet<string> pendingCommandIds=[];
    private string? commandRecoveryError;
    private long commandRecoveryPollAt;
    private void PollCommandReceipts(){if(!verification&&!shutdownStarted&&live.Connected&&Environment.TickCount64>=commandRecoveryPollAt){commandRecoveryPollAt=Environment.TickCount64+2000;_=RefreshCommandRecoveryAsync();}}
    private JsonElement[] uncertainCommands=[];
    private PendingDeviceCommands CommandStore()=>new(Path.GetDirectoryName(PendingPath("device-command"))!);
    private void UpdatePendingCommandIds()
    {
        pendingCommandIds.Clear();
        foreach(var pending in CommandStore().Read(settings.Server,settings.MqttPort))pendingCommandIds.Add(pending.Intent.Field("target").Text("device_id")!);
        foreach(var record in uncertainCommands)pendingCommandIds.Add(record.Field("target").Text("device_id")!);
    }
    private async Task RefreshCommandRecoveryAsync()
    {
        if(!await commandRecoveryGate.WaitAsync(0))return;
        var epoch=generation;var server=settings.Server;var port=settings.MqttPort;var store=CommandStore();
        try
        {
            commandRecoveryError=null;
            foreach(var pending in store.Read(server,port))
            {
                var device=pending.Intent.Field("target").Text("device_id")!;
                if(commandsBusy.Contains(device))continue;
                try {
                    using var lease=store.Acquire(server,port,device);
                    var receipt=await ReadRpcAsync("commands.get",new{operation_id=pending.Intent.Text("operation_id")});
                    if(epoch!=generation)throw new OperationCanceledException();
                    if(PendingDeviceCommands.CanComplete(receipt,pending.Intent))store.Complete(pending);
                } catch(Exception e) {if(epoch!=generation)throw;commandRecoveryError=SafeError(e);}
            }
            uncertainCommands=Array(await ReadRpcAsync("commands.uncertain"),"operations");
            UpdatePendingCommandIds();
        }
        catch(Exception e){if(epoch==generation){commandRecoveryError=SafeError(e);try{UpdatePendingCommandIds();}catch{}}}
        finally{commandRecoveryGate.Release();if(epoch==generation)liveRefresh?.Invoke();}
    }
}
