using System.IO;
using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    // Only the marked loopback fixture can replace a user's native confirmation.
    private Func<bool>? fixturePlanConfirmation;
    private bool ConfirmPlanDeployment(string message,string action,(string Label,string Value)[] details,string note)
        =>verification&&fixtureNetwork&&fixturePlanConfirmation is not null?fixturePlanConfirmation():Confirm("下发频率规划",message,action,details:details,note:note);

    private async Task PrepareManualPlanAsync()
    {
        if(manualPlanned.Count==0)return;
        var edits=new Dictionary<string,string>(manualPlanned,StringComparer.Ordinal);
        var desired=edits.ToDictionary(p=>p.Key,p=>CoordinationEngine.ParseManualFrequency(p.Value),StringComparer.Ordinal);
        // An already validated manual plan follows the same drift checks as an automatic plan.
        if(planResult is JsonElement prior&&desired.All(p=>Array(prior,"assignments").Concat(Array(prior,"monitoringOnlyChannels")).SingleOrDefault(a=>a.Text("deviceId")==p.Key).Number("frequencyKHz")==p.Value))return;
        var epoch=generation;var boot=bridge?.BootId;
        if(!await SavePlannerDraftAsync())throw new InvalidDataException("请先完成规划设置的数据库保存");
        var fields=JsonSerializer.Serialize(DraftFields());var options=PlanningOptions();var profiles=customProfiles;
        await RefreshAsync();
        var current=ViewChannels.Where(c=>c.Online).ToArray();
        if(current.Length==0||desired.Keys.Any(id=>current.Count(c=>c.Id==id)!=1))throw new InvalidDataException("手动频率目标已离线或不能唯一定位");
        var devices=CoordinationEngine.CalculationDevices(current);
        var assignments=planResult is JsonElement result?Array(result,"assignments"):[];
        foreach(var c in current)if(!desired.ContainsKey(c.Id))
            desired[c.Id]=(int?)(assignments.SingleOrDefault(a=>a.Text("deviceId")==c.Id).Number("frequencyKHz"))??c.FrequencyKHz??throw new InvalidDataException("通道当前频率未知："+c.Group+" · "+c.ChannelLabel);
        var validated=await Task.Run(()=>CoordinationEngine.ValidateManualPlan(devices,options,profiles,desired,connection.Token),connection.Token);
        if(epoch!=generation||boot!=bridge?.BootId||fields!=JsonSerializer.Serialize(DraftFields())||!JsonElement.DeepEquals(options,PlanningOptions())||edits.Count!=manualPlanned.Count||edits.Any(p=>manualPlanned.GetValueOrDefault(p.Key)!=p.Value))throw new InvalidDataException("校验期间服务器或规划输入已变化，请再次下发");
        planResult=validated;plannedDevices=devices;plannedOptions=options;plannedFields=fields;plannedBoot=boot;
        deploymentRows.Clear();deploymentStatus="手动频率已校核 · 尚未下发";
    }
}
