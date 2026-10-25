using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Daty.Native.Core;

namespace Daty.Native.App;
public partial class MainWindow
{
    private async Task VerifyPlanningFixtureAsync(JsonElement config)
    {
        var checks=new List<string>();void Check(bool ok,string name){if(!ok)throw new InvalidDataException(name+"; "+planningSettingsStatus);checks.Add(name);}
        Check(verification&&fixtureNetwork&&planningSettingsReady,"planning configuration loaded in isolated native process");
        var mode=config.Text("mode");
        if(mode=="planning-write")
        {
            // Exercise the actual WPF TextChanged handler, not just the serializer.
            ShowPage("planner");Show();UpdateLayout();
            static IEnumerable<T> Descendants<T>(DependencyObject root) where T:DependencyObject
            {for(int i=0;i<VisualTreeHelper.GetChildrenCount(root);i++){var child=VisualTreeHelper.GetChild(root,i);if(child is T found)yield return found;foreach(var nested in Descendants<T>(child))yield return nested;}}
            var start=Descendants<TextBox>(planningEditor!).Single(x=>x.Text=="614.250");
            start.Text="630.";start.Text="630.000";
            Check(planRange=="custom"&&planStart=="630.000"&&PlanningUnconfirmed,"WPF frequency input immediately queues database edit and selects custom");
            planEnd="690.000";compatibility="robust";excludedText="638.000-639.000 摄像机\n";occupiedText="650.000,250,在用";plannerBackupText="0";backupCount=0;
            safety["stepKHz"]="25";safety["minChannelSpacingKHz"]="350";safety["minImdSpacingKHz"]="300";safety["scanThresholdDbm"]="-85";safety["imdOrders"]="third-fifth";
            ShowPage("planner");UpdateLayout();
            foreach(var product in new[]{"2T5O","2T7O","2T9O"})Descendants<CheckBox>(planningEditor!).Single(x=>System.Windows.Automation.AutomationProperties.GetAutomationId(x)=="PlannerImd"+product).IsChecked=true;
            Check(plannerImdProducts.SequenceEqual(PlanningIntermodulation.Products)&&PlanningUnconfirmed,"all five WPF IMD controls immediately queue persistent selection");
            var channel=ViewChannels[0];locks[channel.Id]=(640000,"主唱");plannerTab="constraints";plannerSelectedDevice=channel.Id;plannerLockNote="尚未确认的用途";
            PlannerEdited();Check(await SavePlannerDraftAsync()&&!PlanningUnconfirmed,"all basic safety constraints locks and editor drafts committed");Hide();
        }
        if(mode is "planning-write" or "planning-read")
        {
            Check(planRange=="custom"&&planStart=="630.000"&&planEnd=="690.000"&&compatibility=="robust","basic options restored exactly");
            Check(excludedText=="638.000-639.000 摄像机\n"&&occupiedText=="650.000,250,在用"&&plannerBackupText=="0"&&backupCount==0,"multiline constraints and zero backup restored exactly");
            Check(safety["stepKHz"]=="25"&&safety["minChannelSpacingKHz"]=="350"&&safety["minImdSpacingKHz"]=="300"&&safety["scanThresholdDbm"]=="-85"&&safety["imdOrders"]=="third-fifth","all safety options restored exactly");
            Check(plannerImdProducts.SequenceEqual(PlanningIntermodulation.Products),"five independent IMD rules survive fresh native process");
            Check(locks.Count==1&&locks[plannerSelectedDevice]==(640000,"主唱")&&plannerTab=="constraints"&&plannerLockNote=="尚未确认的用途","confirmed stable-identity lock separated from unconfirmed note draft");
        }
        if(mode=="planning-draft-write")
        {
            planStart="-";plannerBackupText="";backupInputValid=false;safety["scanThresholdDbm"]="-";
            Check(await SavePlannerDraftAsync()&&!PlanningUnconfirmed,"incomplete input persisted without local fallback");
        }
        if(mode is "planning-draft-write" or "planning-draft-read")
        {
            Check(planStart=="-"&&plannerBackupText==""&&!backupInputValid&&safety["scanThresholdDbm"]=="-","incomplete numeric draft survives fresh process");
            bool refused=false;try{_=PlanningOptions();}catch{refused=true;}Check(refused,"incomplete draft cannot be calculated");
        }
        if(mode=="planning-conflict")
        {
            var before=resources["settings:"+PlanningSettingId];var dbstatus=await ReadRpcAsync("database.status");
            var body=new Dictionary<string,object?>{{"kind","settings"},{"id",PlanningSettingId},{"expected_revision",(int)before.Number("revision")!},{"value",PlanningSettingValue()},{"epoch",dbstatus.Text("epoch")},{"operation_id",Guid.NewGuid().ToString("N")}};
            var external=await ReadRpcAsync("database.write",body);
            plannerBackupText="3";backupCount=3;backupInputValid=true;
            Check(!await SavePlannerDraftAsync()&&PlanningUnconfirmed,"stale revision remains unsaved without automatic overwrite");
            ShowPage("planner");
            var status=Descendants<TextBlock>(planningEditor!.Parent).Single(t=>System.Windows.Automation.AutomationProperties.GetAutomationId(t)=="PlannerSaveStatus");
            var recover=status.Inlines.OfType<System.Windows.Documents.Hyperlink>().Single();
            Check(new System.Windows.Documents.TextRange(recover.ContentStart,recover.ContentEnd).Text.Contains("其他窗口已更新"),"conflict remains visible through inline recovery");
            recover.RaiseEvent(new RoutedEventArgs(System.Windows.Documents.Hyperlink.ClickEvent));
            for(var wait=0;wait<100&&PlanningUnconfirmed;wait++)await Task.Delay(50);
            Check(!PlanningUnconfirmed,"inline explicit recovery confirms revised database CAS");
            // Simulate a lost reply after a real commit; retry queries original operation, never replays it.
            before=resources["settings:"+PlanningSettingId];body["expected_revision"]=(int)before.Number("revision")!;body["value"]=PlanningSettingValue();body["operation_id"]=Guid.NewGuid().ToString("N");
            external=await ReadRpcAsync("database.write",body);settingOperations[PlanningSettingId]=((string)body["operation_id"]!,body);
            Check(await SavePlannerDraftAsync()&&!PlanningUnconfirmed,"lost commit response reconciled by original operation receipt");
            var actual=(await ReadRpcAsync("database.resources.get",new{kind="settings",id=PlanningSettingId})).Field("resource");
            Check(actual.Number("revision")==external.Field("resource").Number("revision"),"reconciliation did not duplicate database write");
            body["expected_revision"]=(int)actual.Number("revision")!;body["operation_id"]=Guid.NewGuid().ToString("N");external=await ReadRpcAsync("database.write",body);
            settingOperations[PlanningSettingId]=((string)body["operation_id"]!,body);planningSettingsReady=false;
            await InitializePlanningSettingsAsync();
            Check(planningSettingsReady&&!PlanningUnconfirmed&&resources["settings:"+PlanningSettingId].Number("revision")==external.Field("resource").Number("revision"),"initialization reconciles a lost seed receipt without overwriting existing settings");
        }
        Check(!Directory.EnumerateFiles(fixtureDirectory!,"*",SearchOption.AllDirectories).Any(),"no local planning or pending business files");
        await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,checks,records=new Dictionary<string,JsonElement>{{PlanningSettingId,resources["settings:"+PlanningSettingId]}},physicalCommands=0,loopbackOnly=true}));
    }
}
