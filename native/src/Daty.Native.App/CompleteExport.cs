using System.Text.Json;

namespace Daty.Native.App;

public partial class MainWindow
{
    private async Task ExportCompleteProjectAsync()
    {
        try
        {
            var project=await ReadRpcAsync("projects.get",new{id="default"});
            var groups=new Dictionary<string,JsonElement[]>();
            foreach(var kind in new[]{"profiles","planning_records","planning_current","scans","scan_current","simulation_settings","settings","preferences","manual_devices","device_overrides","alerts"})
                groups[kind]=await ReadAllResourcesAsync(kind,kind is "planning_records" or "planning_current" or "scans" or "scan_current" or "simulation_settings"?"default":null);
            await ExportAsync("完整方案",new{format="daty-native-project-export-v1",server=settings.Server,project,devices=live.Snapshot?.Raw,plan=planResult,resources=groups,capturedAt=DateTimeOffset.UtcNow});
        }
        catch(Exception e){Message("完整方案未导出："+SafeError(e),true);}
    }
}
