using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private ServerNetworkInfo? serverNetwork;
    private long networkReadGeneration = -1, nextNetworkRead;
    private string? networkReadError;

    private void ResetNetworkAddress()
    {
        serverNetwork = null; networkReadError = null; nextNetworkRead = 0;
        UpdateNetworkAddressLabel();
    }

    private void UpdateNetworkAddressLabel()
    {
        AddressLabel.Text = "局域网 " + (!live.Connected ? "未连接" : serverNetwork?.Address ?? (networkReadError is null && serverNetwork is null ? "读取中…" : "未获取"));
        var integrated = ProjectEnvironment.Current is not null;
        var details = (integrated ? "本机局域网：" : "服务器网卡：")
            + (live.Connected && serverNetwork is not null ? string.Join("、", serverNetwork.Addresses) : "尚未获取")
            + (integrated ? "\nDATY RF PRO 一体运行 · 随窗口启动和关闭" : "\n连接：" + settings.Server)
            + (networkReadError is null ? "" : "\n" + networkReadError);
        AddressLabel.ToolTip = null;
        SetStatusToolTip(NetworkButton,details);
        NetworkButton.Cursor = integrated ? System.Windows.Input.Cursors.Arrow : System.Windows.Input.Cursors.Hand;
    }

    private void PollServerNetwork()
    {
        if (verification || shutdownStarted || bridge is null || !live.Connected || networkReadGeneration == generation || Environment.TickCount64 < nextNetworkRead) return;
        networkReadGeneration = generation; nextNetworkRead = Environment.TickCount64 + 30000;
        _ = ReadServerNetworkAsync(generation);
    }

    private async Task ReadServerNetworkAsync(long epoch)
    {
        try
        {
            var info = ServerNetworkInfo.Parse(await ReadRpcAsync("network.status"));
            if (shutdownStarted || epoch != generation) return;
            serverNetwork = info; networkReadError = null;
        }
        catch (Exception error)
        {
            if (shutdownStarted || epoch != generation) return;
            serverNetwork = null; networkReadError = SafeError(error);
        }
        finally
        {
            if (networkReadGeneration == epoch) networkReadGeneration = -1;
            if (!shutdownStarted && epoch == generation) UpdateNetworkAddressLabel();
        }
    }
}
