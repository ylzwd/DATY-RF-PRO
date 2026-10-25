using System.Text.Json;

namespace Daty.Native.Core;

public static class LocalServerReadiness
{
    public static bool IsReady(JsonElement status, string epoch, DateTimeOffset now, Func<int, bool> ownsProcess)
    {
        if(status.Text("schema")!="daty-mqtt6-runtime-status-v1" || status.Text("state")!="running" || status.Text("database_epoch")!=epoch) return false;
        if(!DateTimeOffset.TryParse(status.Text("at_utc"),out var at) || now-at>TimeSpan.FromSeconds(15) || at-now>TimeSpan.FromSeconds(2)) return false;
        if(status.Field("pid").ValueKind!=JsonValueKind.Number || !status.Field("pid").TryGetInt32(out var pid) || pid<=0 || !ownsProcess(pid)) return false;
        var persistence=status.Field("persistence");
        return status.Field("transport").Field("ready").True() && persistence.Field("accepting").True()
            && persistence.Field("writable").True() && persistence.Field("writer").Field("running").True();
    }

    public static string ConnectionMessage(string reason) => reason.Contains("503",StringComparison.Ordinal)
        ? "服务器正在启动或恢复存储，准备好后将自动连接。"
        : reason.Contains("STREAM_",StringComparison.Ordinal)
            ? "实时连接中断，正在自动恢复。"
            : "实时连接暂不可用，正在重新连接："+reason;
}
