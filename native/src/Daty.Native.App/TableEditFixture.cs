using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Daty.Native.Core;

namespace Daty.Native.App;
public partial class MainWindow
{
    private async Task VerifyTableEditDeployAsync(JsonElement config)
    {
        var checks=new List<string>();
        void Check(bool ok,string label){if(!ok)throw new InvalidDataException(label+"; "+deploymentStatus+"; "+StatusMessage.Text);checks.Add(label);}
        static IEnumerable<T> Visuals<T>(DependencyObject root) where T:DependencyObject
        {for(int i=0;i<VisualTreeHelper.GetChildrenCount(root);i++){var child=VisualTreeHelper.GetChild(root,i);if(child is T found)yield return found;foreach(var nested in Visuals<T>(child))yield return nested;}}
        async Task Until(Func<bool> predicate){for(int i=0;i<500&&!predicate();i++)await Task.Delay(20);Check(predicate(),"asynchronous native action completed");}
        Check(verification&&fixtureNetwork&&planningSettingsReady,"isolated native DB initialized");
        Width=1440;Height=900;ShowPage("devices");Show();UpdateLayout();
        var table=Visuals<DataGrid>(this).Single();var before=table.ItemsSource;var first=(Channel)table.Items[0];
        Check(table.Columns.Count==8&&!Visuals<Button>(table).Any(b=>Equals(b.Content,"编辑")),"online device table has no action column or edit button");
        for(int i=0;i<30;i++){
            var changed=ViewChannels.Select(c=>{var value=c.Raw.Deserialize<Dictionary<string,JsonElement>>()!;value["rf"]=JsonSerializer.SerializeToElement(-30-i);return value;}).ToArray();
            live.Apply(generation,DeviceSnapshot.Parse(JsonSerializer.SerializeToElement(new{success=true,devices=changed})));liveRefresh?.Invoke();UpdateLayout();
        }
        Check(ReferenceEquals(before,table.ItemsSource),"RF ticks preserve online table rows");
        ShowOnlineDeviceEditor(first);
        var editor=verificationDialogs["DATY RF PRO · 编辑设备"];
        Check(Descendants<CheckBox>(editor).Single().IsEnabled&&Descendants<TextBox>(editor).Single().MaxLength==80,"shared editor exposes explicit lock and usage form");
        await SaveOnlineUsageAsync(first,null,true,"主唱");
        var record=(await ReadRpcAsync("database.resources.get",new{kind="settings",id=PlanningSettingId})).Field("resource");
        Check(Array(record.Field("value"),"locks").Single().Text("note")=="主唱"&&Usage(first)=="主唱","online classification saves with lock through real database receipt");
        bool stale=false;try{await SaveOnlineUsageAsync(first,null,true,"不能覆盖");}catch(InvalidDataException){stale=true;}
        Check(stale&&Usage(first)=="主唱","stale editor cannot overwrite newer lock");
        await SaveOnlineUsageAsync(first,(first.FrequencyKHz!.Value,"主唱"),false,"");
        Check(!locks.ContainsKey(first.Id),"explicit unlock persists without hardware command");
        planRange="640000:690000";planStart="640.000";planEnd="690.000";backupCount=0;plannerBackupText="0";compatibility="standard";
        Check(await SavePlannerDraftAsync(),"manual test range committed");InvalidatePlan();
        var originalDevices=CoordinationEngine.CalculationDevices(ViewChannels.Where(c=>c.Online));var originalOptions=PlanningOptions();
        var interim=ViewChannels.ToDictionary(c=>c.Id,c=>c.FrequencyKHz!.Value);interim[first.Id]=645000;interim[ViewChannels[1].Id]=652000;
        bool occupiedRefused=false;try{CoordinationEngine.ValidateManualPlan(originalDevices,originalOptions,customProfiles,interim,default);}catch{occupiedRefused=true;}
        Check(occupiedRefused,"current occupancy rejects moving onto another active carrier before a plan is accepted");
        // Historical plans without occupancy snapshots still require the independent
        // hybrid deployment guard; exercise that compatibility path explicitly.
        var legacyFields=originalOptions.Deserialize<Dictionary<string,JsonElement>>()!;legacyFields["protectCurrentFrequencies"]=JsonSerializer.SerializeToElement(false);
        var legacyOptions=JsonSerializer.SerializeToElement(legacyFields);
        var interimPlan=CoordinationEngine.ValidateManualPlan(originalDevices,legacyOptions,customProfiles,interim,default);
        bool collision=false;try{CoordinationEngine.ValidateDeployment(interimPlan,originalDevices,originalDevices,legacyOptions,customProfiles,first.Id,default);}catch{collision=true;}
        Check(collision,"valid final plan cannot collide with a channel that has not moved yet");
        var drift=ViewChannels.Select(c=>{var obj=c.Raw.Deserialize<Dictionary<string,JsonElement>>()!;if(c.Id==first.Id)obj["freq"]=JsonSerializer.SerializeToElement(640250);return obj;}).ToArray();
        bool driftRefused=false;try{CoordinationEngine.ValidateDeployment(interimPlan,originalDevices,JsonSerializer.SerializeToElement(drift),legacyOptions,customProfiles,first.Id,default);}catch{driftRefused=true;}
        Check(driftRefused,"frequency drift invalidates earlier deployment snapshot");
        ShowPage("planner");UpdateLayout();
        var planner=Visuals<DataGrid>(this).Single();
        var input=Visuals<TextBox>(planner).Single(b=>b.DataContext is PlanRow r&&r.Id==first.Id);
        var send=Visuals<Button>(planner).Single(b=>Equals(b.Content,"下发")&&b.DataContext is PlanRow r&&r.Id==first.Id);
        Check(input.Text=="640.000","unplanned input starts at actual receiver frequency");
        var confirms=0;fixturePlanConfirmation=()=>{confirms++;return false;};
        foreach(var bad in new[]{"630.000","641.025","641."}){
            input.Focus();input.Text=bad;Check(manualPlanned.GetValueOrDefault(first.Id)==bad,"focused WPF input captured before lost focus");
            send.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));await Until(()=>!deploying);
            Check(confirms==0&&deploymentStatus.StartsWith("未完成")&&manualPlanned[first.Id]==bad,"invalid manual frequency blocked without confirmation or losing edit");
        }
        input.Focus();input.Text="641.000";send.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));await Until(()=>!deploying);
        Check(confirms==1&&planResult?.Field("manualValidation").True()==true&&ViewChannels.Single(c=>c.Id==first.Id).FrequencyKHz==640000,"valid manual frequency revalidated; cancellation sends nothing");
        fixturePlanConfirmation=()=>{confirms++;return true;};
        await DeployPlanAsync(first.Id);
        Check(deploymentRows.GetValueOrDefault(first.Id)=="设备确认完成"&&ViewChannels.Single(c=>c.Id==first.Id).FrequencyKHz==641000,"manual frequency obtains real DATY execution ACK and snapshot");
        await DeployPlanAsync(first.Id);
        Check(deploymentRows.GetValueOrDefault(first.Id)=="原频一致 · 未发送","repeat deploy of actual frequency is skipped");
        // Resize away and back: all columns, including the input and action, remain equal.
        foreach(var width in new[]{1024d,1920d,1366d}){Width=width;UpdateLayout();await Dispatcher.InvokeAsync(()=>{},System.Windows.Threading.DispatcherPriority.Render);var widths=planner.Columns.Select(c=>c.ActualWidth).ToArray();Check(widths.Max()-widths.Min()<1,"equal table columns at "+width);}
        fixturePlanConfirmation=null;Hide();
        await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,checks,physicalCommands=0,loopbackOnly=true}));
    }
}
