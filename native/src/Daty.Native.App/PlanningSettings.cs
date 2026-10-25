using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private const string PlanningSettingId="frequency_planning";
    private ImmediateSettings? planningSettingsWriter;
    private bool planningSettingsReady,planningSafetyOpen;
    private string planningSettingsStatus="正在读取服务器数据库规划设置…";
    private string plannerBackupText="1",plannerSelectedDevice="",plannerLockNote="";
    private Action? planningStatusRefresh;
    private FrameworkElement? planningEditor;
    private bool PlanningUnconfirmed=>planningSettingsWriter?.HasUnsaved==true||settingOperations.ContainsKey(PlanningSettingId);
    private bool PlanningEditing=>planningSafetyOpen||(currentPage=="planner"&&planningEditor?.IsKeyboardFocusWithin==true);

    private JsonElement PlanningSettingValue()
    {
        var fields=DraftFields();fields.Remove("plannerLockedAssignments");
        return JsonSerializer.SerializeToElement(new{schema="daty-planning-settings-v1",fields,
            locks=locks.OrderBy(x=>x.Key,StringComparer.Ordinal).Select(x=>new{deviceId=x.Key,frequencyKHz=x.Value.Frequency,note=x.Value.Note}).ToArray(),
            editor=new{tab=plannerTab,selectedDeviceId=plannerSelectedDevice,lockNote=plannerLockNote}});
    }
    private ImmediateSettings PlanningWriter()=>planningSettingsWriter??=new(WritePlanningSettingAsync,(_,state,_,error)=>
    {
        // A receipt confirms that revision only; never replace newer keyboard input.
        planningSettingsStatus=state=="saved"?PlanningSavedLabel():state=="saving"?"正在保存到服务器数据库…":"未保存 / 待核对："+SafeError(error!);
        planningStatusRefresh?.Invoke();
    });
    private async Task<JsonElement> WritePlanningSettingAsync(string id,JsonElement value)
    {
        // Bound the encoded MQTT request before allocating a pending operation.
        if(JsonSerializer.SerializeToUtf8Bytes(value).Length>128*1024)throw new InvalidDataException("规划设置超过 128 KiB，请减少约束条目后重试");
        if(!resources.ContainsKey("settings:"+id))await OptionalResourceAsync("settings",id);
        return await WriteSystemSettingAsync(id,value);
    }
    private string PlanningSavedLabel()
    {
        try{_=PlanningOptions();return "已即时保存到服务器数据库";}
        catch{return "输入草稿已存入数据库 · 格式待修正后可计算";}
    }
    private void PlannerEdited(bool affectsPlan=true)
    {
        if(affectsPlan)InvalidatePlan();
        if(!planningSettingsReady){if(!verification)planningSettingsStatus="尚未读取数据库规划设置，请重试读取";return;}
        _=PlanningWriter().Submit(PlanningSettingId,PlanningSettingValue());
    }
    private async Task<bool> SavePlannerDraftAsync()
    {
        try
        {
            if(!planningSettingsReady)await InitializePlanningSettingsAsync();
            await PlanningWriter().Submit(PlanningSettingId,PlanningSettingValue());
            if(PlanningUnconfirmed)throw new InvalidDataException(planningSettingsStatus);
            return true;
        }
        catch(Exception e){planningSettingsStatus="未保存 / 待核对："+SafeError(e);planningStatusRefresh?.Invoke();Message(planningSettingsStatus,true);return false;}
    }
    private async Task RetryPlanningSettingsAsync()
    {
        if(!planningSettingsReady){try{await InitializePlanningSettingsAsync();if(currentPage=="planner")ShowPage("planner");}catch(Exception e){planningSettingsStatus="读取失败："+SafeError(e);planningStatusRefresh?.Invoke();}}
        else{await PlanningWriter().Retry();planningStatusRefresh?.Invoke();}
    }
    private async Task InitializePlanningSettingsAsync()
    {
        var epoch=generation;
        try
        {
        if(settingOperations.TryGetValue(PlanningSettingId,out var pending))
        {
            var operation=(await ReadRpcAsync("operations.get",new{operation_id=pending.OperationId})).Field("operation");
            if(operation.Text("operation_id")!=pending.OperationId||operation.Text("method")!="database.write"||operation.Text("state") is not ("committed" or "rejected"))throw new InvalidDataException("首次设置保存仍待核对；未重复发送");
            if(operation.Text("state")=="committed")VerifySettingReceipt(PlanningSettingId,pending.Body,ReadBody(operation.Field("result")));
            settingOperations.Remove(PlanningSettingId);
        }
        var record=await OptionalResourceAsync("settings",PlanningSettingId);
        if(record is null)
        {
            try{await WritePlanningSettingAsync(PlanningSettingId,PlanningSettingValue());record=resources["settings:"+PlanningSettingId];}
            catch(R19RpcException e)when(e.Status==409){record=await OptionalResourceAsync("settings",PlanningSettingId);if(record is null)throw;}
        }
        if(epoch!=generation)throw new OperationCanceledException();
        ApplyPlanningSetting(record.Value.Field("value"));
        sharedSettingsVersions[PlanningSettingId]=record.Value.Number("revision")??0;
        planningSettingsReady=true;planningSettingsStatus=PlanningSavedLabel();planningStatusRefresh?.Invoke();
        if(!verification&&!fixtureNetwork)await NativeSettings.RemoveLegacyPlanningRangeAsync(NativeSettings.SettingsPath,connection.Token);
        }
        catch(Exception e){planningSettingsStatus="规划设置读取 / 保存未完成："+SafeError(e);planningStatusRefresh?.Invoke();throw;}
    }
    private void ApplyPlanningSetting(JsonElement value)
    {
        if(value.Text("schema")!="daty-planning-settings-v1")throw new InvalidDataException("服务器规划设置版本不受支持");
        var f=value.Field("fields");string Field(string key)=>f.Text(key)??throw new InvalidDataException("缺少规划设置："+key);
        planRange=Field("plannerRange");planStart=Field("plannerRangeStart");planEnd=Field("plannerRangeEnd");compatibility=Field("plannerCompatibility");
        excludedText=Field("plannerExcludedRanges");occupiedText=Field("plannerKnownCarriers");plannerBackupText=Field("plannerBackupCount");
        backupInputValid=int.TryParse(plannerBackupText,out var count)&&count is >=0 and <=4;if(backupInputValid)backupCount=count;
        foreach(var (key,field) in new[]{("stepKHz","plannerStepKHz"),("minChannelSpacingKHz","plannerMinSpacingKHz"),("minImdSpacingKHz","plannerImdSpacingKHz"),("scanThresholdDbm","plannerScanThresholdDbm"),("imdOrders","plannerImdPolicy")})safety[key]=Field(field);
        plannerImdProducts=PlanningIntermodulation.Read(f.Text("plannerImdProducts"),safety["imdOrders"]);
        locks.Clear();foreach(var item in Array(value,"locks"))locks.Add(item.Text("deviceId")!,((int)item.Number("frequencyKHz")!,item.Text("note")??""));
        var editor=value.Field("editor");plannerTab=editor.Text("tab")??"basic";plannerSelectedDevice=editor.Text("selectedDeviceId")??"";plannerLockNote=editor.Text("lockNote")??"";
        InvalidatePlan();planningSettingsStatus=PlanningSavedLabel();
    }
    private void ResetPlanningSettings()
    {
        planningSettingsReady=false;planningSettingsWriter=null;planningStatusRefresh=null;planningEditor=null;planningSafetyOpen=false;
        planningSettingsStatus="正在读取服务器数据库规划设置…";
        plannerTab="basic";planRange="614250:638000";planStart="614.250";planEnd="638.000";compatibility="standard";excludedText=occupiedText="";
        plannerBackupText="1";backupCount=1;backupInputValid=true;plannerSelectedDevice=plannerLockNote="";locks.Clear();
        safety["stepKHz"]="25";safety["minChannelSpacingKHz"]=safety["minImdSpacingKHz"]=safety["scanThresholdDbm"]="";safety["imdOrders"]="third";plannerImdProducts=["2T3O","3T3O"];
        InvalidatePlan();
    }
}
