namespace Daty.Native.App;

public partial class MainWindow
{
    private long discoveryReadGeneration=-1, nextDiscoveryRead;

    private void PollPluginHealth()
    {
        if(verification||shutdownStarted||currentPage!="devices"||deviceTab!="protocol")return;
        if(!live.Connected||bridge is null){discoveryState=null;return;}
        if(discoveryReadGeneration==generation||Environment.TickCount64<nextDiscoveryRead)return;
        discoveryReadGeneration=generation;nextDiscoveryRead=Environment.TickCount64+2000;
        _=ReadPluginHealthAsync(generation);
    }

    private async Task ReadPluginHealthAsync(long epoch)
    {
        try
        {
            var state=await ReadRpcAsync("discovery.status");
            if(shutdownStarted||epoch!=generation)return;
            discoveryState=live.Connected?state:null;
        }
        catch
        {
            // The runtime status reports connection errors. A failed health read
            // must clear cached health rather than keep displaying ready.
            if(shutdownStarted||epoch!=generation)return;
            discoveryState=null;
        }
        finally
        {
            if(discoveryReadGeneration==epoch)discoveryReadGeneration=-1;
            if(!shutdownStarted&&epoch==generation&&currentPage=="devices"&&deviceTab=="protocol")liveRefresh?.Invoke();
        }
    }
}
