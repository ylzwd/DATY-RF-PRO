using System.IO;
using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private MonitoringRules? monitoringRules;
    private long monitoringRevision;
    private string? monitoringReadError;
    private void ReadMonitoringResources(JsonElement[] records)
    {
        try { ApplyMonitoringResource(records.SingleOrDefault(r=>r.Text("id")==MonitoringRules.DocumentId));monitoringReadError=null; }
        catch(Exception e) { var message="数据库显示规则不可用："+SafeError(e);if(monitoringReadError!=message)Message(message,true);monitoringReadError=message; }
    }
    private void ApplyMonitoringResource(JsonElement record)
    {
        try
        {
            if(record.Text("kind")!="settings"||record.Text("id")!=MonitoringRules.DocumentId||record.Field("deleted").True()||record.Number("revision") is not double rev||rev<1)
                throw new InvalidDataException("服务器数据库缺少已提交的监控显示规则");
            if(monitoringRules is not null&&monitoringRevision==(long)rev&&JsonElement.DeepEquals(monitoringRules.Document,record.Field("value")))return;
            var parsed=MonitoringRules.Parse(record.Field("value"));
            monitoringRules=parsed;monitoringRevision=(long)rev;alertMonitor.Rules=parsed;
            resources["settings:"+MonitoringRules.DocumentId]=record.Clone();
            ObserveAlerts(ViewChannels);
            if(currentPage is "dashboard" or "channels")ShowPage(currentPage);
            else if(currentPage == "spectrum")liveRefresh?.Invoke();
        }
        catch
        {
            monitoringRules=null;monitoringRevision=0;alertMonitor.Rules=null;
            if(currentPage is "dashboard" or "channels")ShowPage(currentPage);
            else if(currentPage == "spectrum")liveRefresh?.Invoke();
            throw;
        }
    }
    private void LoadMonitoringVerificationFixture()
    {
        if(!verification)throw new InvalidOperationException("Only isolated verification can use fixtures");
        var path=Environment.GetEnvironmentVariable("DATY_MONITORING_RULES_FIXTURE");
        if(string.IsNullOrEmpty(path))return;
        using var json=JsonDocument.Parse(File.ReadAllText(path));
        monitoringRules=MonitoringRules.Parse(json.RootElement);monitoringRevision=1;alertMonitor.Rules=monitoringRules;
    }
}
