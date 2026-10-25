using System.IO;
using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private static readonly Dictionary<string,object> SystemSettingDefaults=new()
    {
        ["alert_thresholds"]=new{rfWeakDbm=-90,batteryLowPercent=20,batteryLowBars=1,afOverloadDbfs=-3},
        ["alert_sound"]=new{enabled=false},["auto_frequency"]=new{enabled=false},
        ["network_connection"]=new{localIp="",heartbeatSeconds=30,reconnectStrategy="exponential",shureExclusive=true,pcom1Enabled=false}
    };
    private ImmediateSettings? systemSettingsWriter;
    private bool systemSettingsReady,systemSettingsSavingAll;
    private Task<bool>? systemSettingsSaveTask;
    private readonly Dictionary<string,string> systemSettingErrors=[];
    private static readonly Dictionary<string,string> SystemSettingLabels=new()
    {
        ["alert_thresholds"]="告警阈值",["alert_sound"]="声音告警",
        ["auto_frequency"]="自动变频推荐",["network_connection"]="网络与连接"
    };
    private JsonElement SettingDraft(string id,object fallback)=>systemSettingsWriter?.PendingValue(id)??JsonSerializer.SerializeToElement(fallback);
    private JsonElement networkSettings=JsonSerializer.SerializeToElement(SystemSettingDefaults["network_connection"]);
    private string systemSettingsStatus="正在读取服务器数据库设置…";
    private Action? settingsFormRefresh;
    private readonly Dictionary<string,(string OperationId,Dictionary<string,object?> Body)> settingOperations=[];

    private ImmediateSettings SettingsWriter()=>systemSettingsWriter??=new(WriteSystemSettingAsync,(id,state,value,error)=>
    {
        if(state=="error")systemSettingErrors[id]=SafeError(error!);else systemSettingErrors.Remove(id);
        if(!systemSettingsSavingAll)systemSettingsStatus=systemSettingErrors.Count>0?"未保存 / 待核对："+string.Join("；",systemSettingErrors.Select(x=>(SystemSettingLabels.GetValueOrDefault(x.Key)??x.Key)+"："+x.Value)):
            state=="saved"?(systemSettingsWriter?.HasUnsaved==true?"仍有设置等待数据库确认，请点击保存核对":"已即时保存到服务器数据库"):"正在保存到服务器数据库…";
        if(state=="saved"&&value is JsonElement committed)ApplyDatabaseSetting(id,committed);
        if(currentPage=="settings")settingsFormRefresh?.Invoke();
    });
    private void ApplyDatabaseSetting(string id,JsonElement value)
    {
        switch(id)
        {
            case MonitoringRules.DocumentId:if(resources.TryGetValue("settings:"+id,out var monitorRecord))ApplyMonitoringResource(monitorRecord);break;
            case PlanningSettingId:ApplyPlanningSetting(value);if(currentPage=="planner"&&!PlanningEditing)ShowPage("planner");break;
            case SpectrumSettingId:ApplySpectrumSetting(value);break;
            case "alert_thresholds":thresholds=new(value.Number("rfWeakDbm")??-90,value.Number("batteryLowPercent")??20,value.Number("batteryLowBars")??1,value.Number("afOverloadDbfs")??-3);ObserveAlerts(ViewChannels);break;
            case "alert_sound":soundEnabled=value.Field("enabled").True();break;
            case "auto_frequency":automaticFrequency=value.Field("enabled").True();break;
            case "network_connection":networkSettings=value.Clone();break;
        }
        liveRefresh?.Invoke();settingsStatusRefresh?.Invoke();
    }
    private async Task InitializeDatabaseSettingsAsync()
    {
        var epoch=generation;systemSettingsReady=false;
        foreach(var (id,initial) in SystemSettingDefaults)
        {
            if(!resources.TryGetValue("settings:"+id,out var record)||record.Field("deleted").True())
            {
                try{await WriteSystemSettingAsync(id,JsonSerializer.SerializeToElement(initial));record=resources["settings:"+id];}
                catch(R19RpcException e)when(e.Status==409)
                {
                    // Another window may have initialized this category after our list read.
                    var current=await OptionalResourceAsync("settings",id);if(current is null)throw;record=current.Value;
                }
            }
            if(epoch!=generation)throw new OperationCanceledException();
            ApplyDatabaseSetting(id,record.Field("value"));
        }
        systemSettingsReady=true;systemSettingsStatus="设置已从服务器数据库读取 · 修改后立即保存";
    }
    private Task SaveSystemSettingAsync(string id,object value)
    {
        if(!systemSettingsReady&&!fixtureNetwork&&!verification){systemSettingsStatus="数据库设置尚未读取，当前修改未提交";settingsFormRefresh?.Invoke();return Task.CompletedTask;}
        return SettingsWriter().Submit(id,value);
    }
    private static void ValidateNetworkSetting(JsonElement value)
    {
        var text=value.Text("localIp")??"";var parts=text.Split('/');
        if(text.Length>0&&(!System.Net.IPAddress.TryParse(parts[0],out _)||parts.Length>2||
            (parts.Length==2&&(!int.TryParse(parts[1],out var prefix)||prefix<0||prefix>(parts[0].Contains(':')?128:32)))))
            throw new InvalidDataException("IP / 网段格式不完整，请更正后保存");
        if(value.Number("heartbeatSeconds") is not (15 or 30 or 60)||value.Text("reconnectStrategy") is not ("exponential" or "fixed5" or "manual"))
            throw new InvalidDataException("请选择有效的心跳间隔和重连策略");
    }
    private async Task<bool> SaveAllSystemSettingsAsync(Func<Dictionary<string,JsonElement>> readForm)
    {
        if(systemSettingsSavingAll)return false;
        var epoch=generation;var client=bridge;
        systemSettingsSavingAll=true;
        try
        {
            if(!systemSettingsReady)throw new InvalidDataException("尚未读取服务器数据库设置，请连接后保存");
            // Capture every editable option before any asynchronous save or form refresh.
            var values=readForm();
            if(values.Count!=SystemSettingDefaults.Count||!SystemSettingDefaults.Keys.All(values.ContainsKey))throw new InvalidDataException("系统设置类目不完整");
            ValidateNetworkSetting(values["network_connection"]);
            systemSettingsStatus="正在按 4 个类目保存全部 11 项设置…";settingsFormRefresh?.Invoke();
            await Task.WhenAll(values.Select(x=>SettingsWriter().Submit(x.Key,x.Value)));
            if(epoch!=generation||client!=bridge)throw new OperationCanceledException("服务器连接已变化");
            var unconfirmed=values.Keys.Where(id=>systemSettingsWriter?.IsDirty(id)==true||settingOperations.ContainsKey(id)).ToArray();
            if(unconfirmed.Length>0)throw new InvalidDataException(string.Join("；",unconfirmed.Select(id=>SystemSettingLabels[id]+"："+systemSettingErrors.GetValueOrDefault(id,"保存结果待核对"))));
            // Independently read the committed server resources, never infer success from a click.
            foreach(var (id,value) in values)
            {
                var expected=resources["settings:"+id];
                var current=(await ReadRpcAsync("database.resources.get",new{kind="settings",id})).Field("resource");
                if(epoch!=generation||client!=bridge)throw new OperationCanceledException("服务器连接已变化");
                if(current.Text("kind")!="settings"||current.Text("id")!=id||current.Field("deleted").True()||
                   current.Number("revision")!=expected.Number("revision")||!JsonElement.DeepEquals(current.Field("value"),value))
                    throw new InvalidDataException(SystemSettingLabels[id]+"保存后读回不一致，请核对其他窗口的修改");
            }
            systemSettingsStatus="已保存 · 全部 11 项设置已按 4 个类目提交并从数据库核对";
            return true;
        }
        catch(Exception error){systemSettingsStatus="未全部保存 / 待核对："+SafeError(error);return false;}
        finally{systemSettingsSavingAll=false;settingsFormRefresh?.Invoke();}
    }
    private async Task<JsonElement> WriteSystemSettingAsync(string id,JsonElement value)
    {
        if(id=="network_connection")ValidateNetworkSetting(value);
        if(id==SpectrumSettingId)ValidateSpectrumSetting(value);
        var epoch=generation;var client=bridge;var boot=client?.BootId;
        if(settingOperations.TryGetValue(id,out var pending))
        {
            var old=(await ReadRpcAsync("operations.get",new{operation_id=pending.OperationId})).Field("operation");
            if(old.Text("operation_id")!=pending.OperationId||old.Text("method")!="database.write"||old.Text("state") is not ("committed" or "rejected"))throw new InvalidDataException("上次设置保存仍待核对；未重复发送");
            var oldResult=ReadBody(old.Field("result"));
            if(old.Text("state")=="committed")VerifySettingReceipt(id,pending.Body,oldResult);
            settingOperations.Remove(id);
            var current=(await ReadRpcAsync("database.resources.get",new{kind="settings",id})).Field("resource");resources["settings:"+id]=current;
            if(!current.Field("deleted").True()&&JsonElement.DeepEquals(current.Field("value"),value)){sharedSettingsVersions[id]=current.Number("revision")??0;return current.Field("value").Clone();}
        }
        resources.TryGetValue("settings:"+id,out var baseline);
        var status=await ReadRpcAsync("database.status");
        var operation=Guid.NewGuid().ToString("N");
        var body=new Dictionary<string,object?>{{"operation_id",operation},{"epoch",status.Text("epoch")},{"kind","settings"},{"id",id},{"expected_revision",(int)(baseline.Number("revision")??0)},{"value",value},{"deleted",false}};
        settingOperations[id]=(operation,body);
        JsonElement result;
        try{result=await ReadRpcAsync("database.write",body,boot);}
        catch(R19RpcException e)when(e.Status is >=400 and <500||e.Code=="SERVER_BOOT_CHANGED")
        {
            settingOperations.Remove(id);
            if(e.Status==409){var current=(await ReadRpcAsync("database.resources.get",new{kind="settings",id})).Field("resource");resources["settings:"+id]=current;}
            throw;
        }
        catch
        {
            var old=(await ReadRpcAsync("operations.get",new{operation_id=operation})).Field("operation");
            if(old.Text("operation_id")!=operation||old.Text("method")!="database.write"||old.Text("state")!="committed")throw new InvalidDataException("数据库保存结果待核对；没有写入本机配置文件，也不会自动重发");
            result=ReadBody(old.Field("result"));
        }
        if(epoch!=generation||client!=bridge)throw new OperationCanceledException("服务器连接已变化");
        var saved=VerifySettingReceipt(id,body,result);resources["settings:"+id]=saved.Clone();sharedSettingsVersions[id]=saved.Number("revision")??0;settingOperations.Remove(id);
        return saved.Field("value").Clone();
    }
    private static JsonElement VerifySettingReceipt(string id,Dictionary<string,object?> body,JsonElement result)
    {
        var saved=result.Field("resource");var requested=JsonSerializer.SerializeToElement(body["value"]);
        if(!result.Field("success").True()||result.Text("operation_id")!=(string?)body["operation_id"]||saved.Text("kind")!="settings"||saved.Text("id")!=id||saved.Number("revision")!=Convert.ToInt32(body["expected_revision"])+1||saved.Field("deleted").True()||!JsonElement.DeepEquals(saved.Field("value"),requested))throw new InvalidDataException("数据库没有返回匹配的设置保存回执");
        return saved;
    }
}
