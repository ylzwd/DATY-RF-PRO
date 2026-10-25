using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;
using Microsoft.Win32;

namespace Daty.Native.App;

public partial class MainWindow
{
    private readonly Dictionary<string,JsonElement> resources=[];
    private Func<string,object?,JsonElement>? verificationRead;
    private readonly HashSet<string> commandsBusy=[];
    private readonly SemaphoreSlim businessWriteGate=new(1,1);
    private string? databaseEpoch,activeDiscoveryOperation;private JsonElement? discoveryState;
    private bool parityDataReady;
    private long? parityLoadingGeneration;
    private static JsonElement[] Array(JsonElement e,string name)=>e.Field(name).ValueKind==JsonValueKind.Array?e.GetProperty(name).EnumerateArray().Select(x=>x.Clone()).ToArray():[];
    private string[] InstalledBrandNames()=>new[]{"全部品牌","DATYaudio"}.Concat(pluginState is JsonElement s?Array(s,"plugins").Select(p=>p.Text("brand")).OfType<string>():[]).Distinct().ToArray();
    private string Usage(Channel c)=>locks.TryGetValue(c.Id,out var locked)?locked.Note:"";
    private async Task<JsonElement> ReadRpcAsync(string method,object? body=null,string? expectedBoot=null)
    {
        if(shutdownStarted)throw new OperationCanceledException("窗口正在关闭");if(verification&&!fixtureNetwork){if(verificationRead is not null)return verificationRead(method,body);throw new InvalidOperationException("隔离界面验收不发送网络请求");}var client=bridge??throw new IOException("服务器尚未连接");var epoch=generation;var response=await client.CallAsync(method,body,connection.Token,expectedBoot);response=await new R19Transfers((m,b,t)=>client.CallAsync(m,b,t,expectedBoot)).JsonAsync(response,connection.Token);if(shutdownStarted||epoch!=generation)throw new OperationCanceledException("服务器连接已变化");if(response.Number("status") is >=400)throw new R19RpcException(response.Field("body").Text("code")??response.Field("body").Text("error")??"读取失败",(int?)response.Number("status"));return ReadBody(response);
    }
    private async Task LoadParityDataAsync()
    {
        var epoch=generation;if(parityLoadingGeneration==epoch)return;parityLoadingGeneration=epoch;
        try{
            var status=await ReadRpcAsync("database.status");databaseEpoch=status.Text("epoch");var read=await ReadRpcAsync("database.resources.list",new{kind="settings",limit=50});
            foreach(var r in Array(read,"resources"))
            {
                var id=r.Text("id")??"";
                if(systemSettingsWriter?.IsDirty(id)==true||settingOperations.ContainsKey(id)||(id==PlanningSettingId&&PlanningUnconfirmed)||(id==SpectrumSettingId&&(SpectrumUnconfirmed||SpectrumEditing)))continue;
                resources[r.Text("kind")+":"+id]=r;var value=r.Field("value");if(r.Field("deleted").True())continue;
                switch(id){case "alert_thresholds":thresholds=new(value.Number("rfWeakDbm")??-90,value.Number("batteryLowPercent")??20,value.Number("batteryLowBars")??1,value.Number("afOverloadDbfs")??-3);break;case "alert_sound":soundEnabled=value.Field("enabled").True();break;case "auto_frequency":automaticFrequency=value.Field("enabled").True();break;}
            }
            ReadMonitoringResources(Array(read,"resources"));
            if(!systemSettingsReady)await InitializeDatabaseSettingsAsync();
            var preferences=await ReadRpcAsync("database.resources.list",new{kind="preferences",limit=100});var latest=Array(preferences,"resources").Where(r=>!r.Field("deleted").True()).OrderByDescending(r=>r.Number("updated_at_ms")??r.Number("saved_at_ms")??0).FirstOrDefault();var preference=latest.Field("value");if(double.TryParse(preference.Text("specStartFreq"),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out var a)&&double.TryParse(preference.Text("specEndFreq"),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out var b)&&a>=30&&b<=3000&&a<b){settings=settings with{StartMHz=a,EndMHz=b};manualStart=a;manualEnd=b;}
            await LoadCalculationResourcesAsync();if(!planningSettingsReady)await InitializePlanningSettingsAsync();if(!spectrumSettingsReady)await InitializeSpectrumSettingsAsync();FollowPlanningRange();await LoadManualChannelsAsync();ObserveAlerts(ViewChannels);await LoadPluginsAsync();
            if(epoch==generation)
            {
                parityDataReady=systemSettingsReady&&planningSettingsReady&&spectrumSettingsReady&&pluginState is not null;
                liveRefresh?.Invoke();
                if(currentPage=="settings"){settingsStatusRefresh?.Invoke();settingsFormRefresh?.Invoke();}
                else if(currentPage=="planner"&&!PlanningEditing&&!PlanningUnconfirmed)ShowPage(currentPage);
            }
        }catch(Exception e){if(epoch==generation)Message("部分界面配置读取失败："+SafeError(e),true);}
        finally{if(parityLoadingGeneration==epoch)parityLoadingGeneration=null;}
    }
    private void RestoreLocks(string text){foreach(var line in text.Split('\n',StringSplitOptions.RemoveEmptyEntries)){var match=System.Text.RegularExpressions.Regex.Match(line,@"^([^=]+)=\s*(\d+(?:\.\d+)?)(?:\s+(.+))?$");if(!match.Success)continue;var id=match.Groups[1].Value.Trim();var c=ViewChannels.FirstOrDefault(c=>c.Id==id||c.Raw.Text("_fasheId")==id);var frequency=(int)Math.Round(double.Parse(match.Groups[2].Value,System.Globalization.CultureInfo.InvariantCulture)*1000);locks[c?.Id??id]=(frequency,match.Groups[3].Value);}}
    private async Task<JsonElement> SaveResourceAsync(string kind,string id,object value,bool deleted=false)
    {
        if(kind=="settings"&&!deleted){await WriteSystemSettingAsync(id,JsonSerializer.SerializeToElement(value));return resources["settings:"+id];}
        JsonElement baseline=default;
        try{baseline=(await ReadRpcAsync("database.resources.get",new{kind,id})).Field("resource");}
        catch(R19RpcException e)when(e.Code=="RESOURCE_NOT_FOUND"){}
        if(resources.TryGetValue(kind+":"+id,out var known)&&known.Number("revision")!=baseline.Number("revision"))
            throw new InvalidDataException("服务器记录已被其他窗口修改，请刷新后重试");
        var result=await WriteBusinessAsync("database.write",new(){{"kind",kind},{"id",id},{"expected_revision",(int)(baseline.Number("revision")??0)},{"value",value},{"deleted",deleted}});
        var saved=result.Field("resource");
        if(saved.Text("kind")!=kind||saved.Text("id")!=id||saved.Number("revision")!=(baseline.Number("revision")??0)+1)
            throw new InvalidDataException("保存回执资源或版本不匹配");
        resources[kind+":"+id]=saved.Clone();return saved;
    }
    private Task SaveThresholdsAsync(AlertThresholds t)=>SaveSystemSettingAsync("alert_thresholds",new{rfWeakDbm=t.Rf,batteryLowPercent=t.Battery,batteryLowBars=t.Bars,afOverloadDbfs=t.Af});
    private Task SaveBooleanSettingAsync(string id,bool enabled)
    {
        if(id=="alert_sound"&&!enabled)soundEnabled=false;
        return SaveSystemSettingAsync(id,new{enabled});
    }
    private bool CanMute(Channel c)=>c.Online&&c.Muted.HasValue&&!commandsBusy.Contains(c.Id)&&c.Raw.Field("capabilities").Field("mute").True();
    private async Task ToggleMuteAsync(Channel c){if(!CanMute(c))return;await SendDeviceCommandAsync(c,c.Muted==true?"unmute":"mute",c.Muted!=true);}
    private async Task<bool> SendDeviceCommandAsync(Channel c,string command,object value,JsonElement? boundTarget=null)
    {
        if(!commandsBusy.Add(c.Id))return false;
        var epoch=generation;var store=CommandStore();PendingDeviceCommand? pending=null;liveRefresh?.Invoke();
        try
        {
            using var lease=store.Acquire(settings.Server,settings.MqttPort,c.Id);
            foreach(var old in store.Read(settings.Server,settings.MqttPort).Where(p=>p.Intent.Field("target").Text("device_id")==c.Id))
            {
                var oldReceipt=await ReadRpcAsync("commands.get",new{operation_id=old.Intent.Text("operation_id")});
                if(!PendingDeviceCommands.CanComplete(oldReceipt,old.Intent))throw new InvalidDataException("服务器正在自动核对该通道的上一条指令，请稍候");
                store.Complete(old);
            }
            var targets=await ReadRpcAsync("commands.targets");
            var target=Array(targets,"targets").Select(t=>t.Field("target")).SingleOrDefault(t=>t.Text("device_id")==c.Id);
            if(target.ValueKind!=JsonValueKind.Object)throw new InvalidDataException("没有匹配的真实接收机控制目标");
            if(boundTarget is JsonElement originalTarget&&!JsonElement.DeepEquals(target,originalTarget))throw new InvalidDataException("接收机会话或目标已变化");
            var now=ViewChannels.SingleOrDefault(x=>x.Id==c.Id);
            if(now is null||!now.Online||now.ReceiverId!=c.ReceiverId||now.Number!=c.Number||now.FrequencyKHz!=c.FrequencyKHz||now.Muted!=c.Muted)throw new InvalidDataException("通道状态已变化，请重新操作");
            var expectedBoot=bridge?.BootId;var oid=Guid.NewGuid().ToString("N");
            if(command=="set_freq")CommandRules.ValidateFrequency(now,System.Convert.ToInt32(value));
            var intent=JsonSerializer.SerializeToElement(new{server=settings.Server,mqtt_port=settings.MqttPort,database_epoch=databaseEpoch,boot_id=expectedBoot,created_at_ms=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),operation_id=oid,target,command,expected_value=value});
            pending=await store.CreateAsync(intent,lifetime.Token);JsonElement receipt;
            try{receipt=await ReadRpcAsync("commands.request",new{operation_id=oid,target,command,expected_value=value},expectedBoot);}
            catch(R19RpcException e)when(e.Code is "SERVER_BOOT_CHANGED" or "TARGET_PENDING_OR_UNCERTAIN" or "CONTROL_ENTRY_DISABLED" or "REQUEST_EXPIRED_OR_TOO_LONG")
            {store.Complete(pending);pending=null;throw;}
            catch{receipt=await ReadRpcAsync("commands.get",new{operation_id=oid});}
            for(int i=0;i<35&&receipt.Text("state") is "reserved" or "dispatching" or "published";i++)
            {await Task.Delay(150,connection.Token);receipt=await ReadRpcAsync("commands.get",new{operation_id=oid});}
            if(epoch!=generation||receipt.Text("operation_id")!=oid)throw new IOException("设备执行回执身份不匹配");
            CommandRules.ValidateReceipt(receipt,intent);
            if(receipt.Text("state") is "acknowledged" or "readback_confirmed")
            {confirmedMute.Accept(c,receipt,intent,Environment.TickCount64);store.Complete(pending);pending=null;Message("设备已执行，服务器已确认回读");await RefreshAsync();return true;}
            if(PendingDeviceCommands.CanComplete(receipt,intent))
            {store.Complete(pending);pending=null;Message(receipt.Text("state") is "unknown" or "timeout"?"原指令结果未确认；服务器已自动核对当前参数，可继续操作":"设备未执行："+receipt.Text("error"),true);}
            else throw new IOException("该通道结果未确认，服务器将自动核对；其他通道可继续操作");
        }
        catch(Exception e){Message("控制结果："+SafeError(e),true);}
        finally
        {
            commandsBusy.Remove(c.Id);
            try{UpdatePendingCommandIds();}catch(Exception e){commandRecoveryError=SafeError(e);}
            liveRefresh?.Invoke();
        }
        return false;
    }
    private async Task ReadDiscoveryAsync(){try{discoveryState=await ReadRpcAsync("discovery.status");liveRefresh?.Invoke();}catch(Exception e){Message("发现状态读取失败："+SafeError(e),true);}}
    private async Task ScanReceiversAsync(){try{await ReadDiscoveryAsync();if(discoveryState is not JsonElement state||!state.Field("enabled").True())throw new IOException("发现插件未启用");var status=await ReadRpcAsync("database.status");var reply=await ReadRpcAsync("discovery.scan",new{operation_id=Guid.NewGuid().ToString("N"),epoch=status.Text("epoch"),expected_generation=(int)(state.Number("generation")??0)});activeDiscoveryOperation=reply.Text("operation_id");discoveryState=reply.Field("discovery");Message("服务器已接受扫描，等待真实发现结果");liveRefresh?.Invoke();}catch(Exception e){Message("扫描未确认："+SafeError(e),true);}}
    private async Task CancelScanAsync(){try{await ReadDiscoveryAsync();if(discoveryState is not JsonElement d||!d.Field("scanning").True()){Message("当前没有正在进行的扫描");return;}if(activeDiscoveryOperation is null)throw new InvalidDataException("本窗口没有正在扫描的原操作身份，不能取消其他窗口发起的扫描");var status=await ReadRpcAsync("database.status");var result=await ReadRpcAsync("discovery.cancel",new{operation_id=Guid.NewGuid().ToString("N"),epoch=status.Text("epoch"),expected_generation=(int)(d.Number("generation")??0),scan_operation_id=activeDiscoveryOperation});discoveryState=result.Field("discovery");Message("已请求停止本次扫描；等待服务器完成确认");liveRefresh?.Invoke();}catch(Exception e){Message(SafeError(e),true);}}
    private Dictionary<string,string> DraftFields()
    {
        var fields=new Dictionary<string,string>{{"plannerRange",planRange},{"plannerRangeStart",planStart},{"plannerRangeEnd",planEnd},{"plannerCompatibility",compatibility},{"plannerImdProducts",string.Join(",",plannerImdProducts)},{"plannerExcludedRanges",excludedText},{"plannerKnownCarriers",occupiedText},{"plannerBackupCount",plannerBackupText},{"plannerLockedAssignments",string.Join("\n",locks.Select(p=>$"{p.Key}={(p.Value.Frequency/1000.0).ToString("0.000",System.Globalization.CultureInfo.InvariantCulture)} {p.Value.Note}"))}};
        foreach(var (key,field) in new[]{("stepKHz","plannerStepKHz"),("minChannelSpacingKHz","plannerMinSpacingKHz"),("minImdSpacingKHz","plannerImdSpacingKHz"),("scanThresholdDbm","plannerScanThresholdDbm"),("imdOrders","plannerImdPolicy")})fields[field]=safety[key];return fields;
    }
    private Task<bool> FlushNativeAlertsAsync()=>Task.FromResult(false);
    private Task ClearNativeAlertsAsync()
    {
        var selected=alertMonitor.Active;
        if(selected.Count==0){Message("当前没有告警事件");return Task.CompletedTask;}
        if(!Confirm("清空实时告警",$"清空当前 {selected.Count} 条实时显示。仍在发生的告警会随新遥测再次显示。","确认清空",true))return Task.CompletedTask;
        var removed=alertMonitor.ClearDisplay(selected);liveRefresh?.Invoke();Message($"已清空 {removed} 条实时显示");return Task.CompletedTask;
    }
    private Task CreateArchiveAsync()=>Task.FromException(new InvalidOperationException("服务器存档已停用"));

    private async Task ImportProfileAsync(){var dialog=new OpenFileDialog{Title="导入设备 Profile",Filter="Profile JSON|*.json"};if(dialog.ShowDialog(this)!=true)return;try{var bytes=await LocalFiles.ReadBoundedAsync(dialog.FileName,262144,lifetime.Token);using var document=JsonDocument.Parse(bytes);var values=document.RootElement;if(values.ValueKind!=JsonValueKind.Array)throw new InvalidDataException("Profile 须为数组；硬件频段和来源仍需校验");CoordinationEngine.ValidateProfiles(values,connection.Token);await SaveProfilesAsync(values);InvalidatePlan();Message("Profile 已获服务器保存确认；控制能力仍按实际硬件校验");}catch(Exception e){Message("Profile 未导入："+SafeError(e),true);}}
    private async Task ExportPlanningFileAsync(string format){if(planResult is not JsonElement result){Message("请先生成规划结果",true);return;}var dialog=new SaveFileDialog{Title="导出规划结果",FileName="DATY-频率规划-"+DateTime.Now.ToString("yyyyMMdd-HHmmss")+"."+format,Filter=format=="csv"?"CSV|*.csv":"HTML 报告|*.html"};if(dialog.ShowDialog(this)!=true)return;try{var assignments=Array(result,"assignments");static string Csv(string? s)=>"\""+(s??"").Replace("\"","\"\"")+"\"";var content=format=="csv"?"品牌,设备ID,频率MHz,Profile,可部署\r\n"+string.Join("\r\n",assignments.Select(a=>string.Join(",",new[]{Csv(a.Text("brand")),Csv(a.Text("deviceId")),Wire.Format(a.Number("frequencyKHz")/1000,"0.000"),Csv(a.Text("profileId")),a.Field("deploymentEligible").True()?"true":"false"}))):"<!doctype html><meta charset=\"utf-8\"><title>DATY RF PRO 规划报告</title><h1>频率规划结果</h1><p>数学校核不代表现场扫描或已下发。</p><pre>"+System.Net.WebUtility.HtmlEncode(JsonSerializer.Serialize(result,new JsonSerializerOptions{WriteIndented=true}))+"</pre>";await LocalFiles.WriteAtomicAsync(dialog.FileName,content,lifetime.Token);Message("规划报告已保存");}catch(Exception e){Message("导出失败："+SafeError(e),true);}}
}
