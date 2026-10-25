using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private JsonElement? plannedDevices,plannedOptions;
    private string? plannedFields,plannedBoot;
    private bool deploying,stopDeployment;
    private readonly Dictionary<string,string> deploymentRows=[];
    private string deploymentStatus="未规划 · 下发须通过完整校验和设备确认";

    private async Task DeployPlanAsync(string? id=null)
    {
        if(deploying)return;deploying=true;stopDeployment=false;Window? progressDialog=null;
        try
        {
            await PrepareManualPlanAsync();
            if(planResult is not JsonElement result||plannedDevices is not JsonElement original||plannedOptions is not JsonElement options||plannedBoot!=bridge?.BootId)
                throw new InvalidDataException("没有当前服务器的有效规划，请先重新规划");
            void InputsUnchanged(){if(manualPlanned.Any(p=>Array(result,"assignments").Concat(Array(result,"monitoringOnlyChannels")).SingleOrDefault(a=>a.Text("deviceId")==p.Key).Number("frequencyKHz") is not double expected||!decimal.TryParse(p.Value,System.Globalization.CultureInfo.InvariantCulture,out var input)||input*1000!=(decimal)expected))throw new InvalidDataException("规划频率有未校验修改，请重新规划");if(plannedFields!=JsonSerializer.Serialize(DraftFields())||!JsonElement.DeepEquals(options,PlanningOptions()))throw new InvalidDataException("规划约束或扫描输入已变化，请重新规划");}
            InputsUnchanged();var epoch=generation;await RefreshAsync();
            var active=CoordinationEngine.CalculationDevices(ViewChannels.Where(c=>c.Online));
            var assignments=CoordinationEngine.ValidateDeployment(result,original,active,options,customProfiles,id,connection.Token).EnumerateArray().Select(a=>a.Clone()).ToArray();
            if(id is null)assignments=CoordinationEngine.ValidateDeploymentSequence(result,active,options,customProfiles,connection.Token).EnumerateArray().Select(a=>a.Clone()).ToArray();
            if(assignments.Length==0){deploymentStatus="当前通道仅监测，已保留原频，无需下发";Message(deploymentStatus);return;}
            var targets=Array(await ReadRpcAsync("commands.targets"),"targets").Select(t=>t.Field("target")).ToDictionary(t=>t.Text("device_id")!,StringComparer.Ordinal);
            foreach(var a in assignments)if(!targets.ContainsKey(a.Text("deviceId")!))throw new InvalidDataException("规划通道缺少实际控制目标");
            var details=assignments.Select(a=>{var c=ViewChannels.Single(c=>c.Id==a.Text("deviceId"));return(Label:c.Group+" · "+c.ChannelLabel+" · "+c.Ip,Value:c.Frequency+" → "+Wire.Format(a.Number("frequencyKHz")/1000,"0.000")+" MHz");}).ToArray();
            if(!ConfirmPlanDeployment($"核对 {assignments.Length} 个通道。改频可能使话筒短时断音，请确认当前允许调整。","确认下发",details:details,note:"逐通道下发；未知或失败立即停止，不自动重发。"))return;
            InputsUnchanged();if(epoch!=generation||plannedBoot!=bridge?.BootId)throw new InvalidDataException("服务器连接已变化");
            var progress=new StackPanel();var status=Text("正在复核目标…",13);progress.Children.Add(Heading("频率下发进度",18));progress.Children.Add(status);var list=new StackPanel();progress.Children.Add(list);
            var dialog=progressDialog=new Window{Owner=this,Title="频率下发进度",Width=700,Height=460,WindowStartupLocation=WindowStartupLocation.CenterOwner,Content=Panel(Scroll(progress))};
            var stop=ActionButton("停止后续",()=>{stopDeployment=true;status.Text="正在等待当前操作确认；不再发送后续通道";});progress.Children.Add(stop);dialog.Closing+=(_,_)=>stopDeployment=true;dialog.Show();
            var baseline=original.Deserialize<List<Dictionary<string,JsonElement>>>()!;int confirmed=0,skipped=0;
            foreach(var assignment in assignments)
            {
                if(stopDeployment)break;InputsUnchanged();if(epoch!=generation||plannedBoot!=bridge?.BootId)throw new InvalidDataException("连接已变化，停止后续下发");
                await RefreshAsync();var current=ViewChannels.Where(c=>c.Online).ToArray();
                var saved=JsonSerializer.SerializeToElement(baseline);
                // Every step must also be safe alongside channels that have not moved yet.
                CoordinationEngine.ValidateDeployment(result,saved,CoordinationEngine.CalculationDevices(current),options,customProfiles,assignment.Text("deviceId"),connection.Token);
                var key=assignment.Text("deviceId")!;var channel=current.Single(c=>c.Id==key);var frequency=(int)assignment.Number("frequencyKHz")!;
                if(channel.FrequencyKHz==frequency){deploymentRows[key]="原频一致 · 未发送";skipped++;}
                else
                {
                    deploymentRows[key]="等待设备确认";status.Text=$"正在下发 {channel.Group} · {channel.ChannelLabel}";liveRefresh?.Invoke();
                    if(!await SendDeviceCommandAsync(channel,"set_freq",frequency,targets[key])){deploymentRows[key]="未确认 · 已停止后续";break;}
                    deploymentRows[key]="设备确认完成";confirmed++;baseline.Single(d=>d["id"].Text()==key)["freq"]=JsonSerializer.SerializeToElement(frequency);
                }
                list.Children.Add(Text(channel.Group+" · "+channel.ChannelLabel+"："+deploymentRows[key],12,"#7c8db5",new(0,8,0,0)));liveRefresh?.Invoke();
            }
            plannedDevices=JsonSerializer.SerializeToElement(baseline);deploymentStatus=$"设备确认 {confirmed} · 原频一致 {skipped} · 未完成 {assignments.Length-confirmed-skipped}";status.Text=deploymentStatus;stop.Content="关闭";stop.Click+=(_,_)=>dialog.Close();if(verification&&fixtureNetwork)dialog.Close();
        }
        catch(Exception e){progressDialog?.Close();deploymentStatus="未完成 · "+SafeError(e);if(id is not null)deploymentRows[id]=deploymentStatus;Message(deploymentStatus,true);}
        finally{deploying=false;liveRefresh?.Invoke();}
    }

    private Task SavePlanningResultAsync(JsonElement devices,JsonElement options,JsonElement result)=>Task.CompletedTask;

}
