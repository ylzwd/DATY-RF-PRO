using System.IO;
using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private async Task VerifySpectrumSettingsFixtureAsync(JsonElement config)
    {
        var checks=new List<string>();
        void Check(bool okay,string name){if(!okay)throw new InvalidDataException(name+"; "+spectrumSettingsStatus);checks.Add(name);}
        Check(verification&&fixtureNetwork&&spectrumSettingsReady,"spectrum settings loaded from isolated server database");
        if(config.Text("mode")=="spectrum-write")
        {
            Check(ScanPeakThresholdDbm==-60&&ScanExclusionThresholdDbm==-85,"server initialized spectrum defaults");
            var first=SetSpectrumThresholdsAsync(-61,-86);
            var latest=SetSpectrumThresholdsAsync(-59.5,-88.2);
            Check(ScanPeakThresholdDbm==-59.5&&ScanExclusionThresholdDbm==-88.2&&SpectrumUnconfirmed,"rapid edits keep newest draft while commit is pending");
            await Task.WhenAll(first,latest);
            Check(!SpectrumUnconfirmed&&ScanPeakThresholdDbm==-59.5&&ScanExclusionThresholdDbm==-88.2,"rapid edits commit exact latest threshold pair");
        }
        if(config.Text("mode") is "spectrum-write" or "spectrum-read")
            Check(ScanPeakThresholdDbm==-59.5&&ScanExclusionThresholdDbm==-88.2,"fresh native process restores both database thresholds");
        if(config.Text("mode")=="spectrum-recovery")
        {
            var before=resources["settings:"+SpectrumSettingId];
            ShowPage("spectrum");
            System.Windows.Controls.TextBox Field(string id)=>Descendants<System.Windows.Controls.TextBox>(PageContent).Single(e=>System.Windows.Automation.AutomationProperties.GetAutomationId(e)==id);
            Field("ScanExclusionThreshold").Text="-";
            Check(spectrumInputInvalid&&SpectrumEditing,"incomplete input remains protected after focus leaves");
            var dbstatus=await ReadRpcAsync("database.status");
            var externalValue=JsonSerializer.SerializeToElement(new{schema="daty-spectrum-settings-v1",peakThresholdDbm=-57.0,exclusionThresholdDbm=-89.0});
            var body=new Dictionary<string,object?>{{"kind","settings"},{"id",SpectrumSettingId},{"expected_revision",(int)before.Number("revision")!},{"value",externalValue},{"epoch",dbstatus.Text("epoch")},{"operation_id",Guid.NewGuid().ToString("N")}};
            var external=await ReadRpcAsync("database.write",body);
            await PollSharedSettingsAsync();await LoadParityDataAsync();
            Check(resources["settings:"+SpectrumSettingId].Number("revision")==before.Number("revision")&&ScanPeakThresholdDbm==-59.5,"poll and recovery do not advance editing baseline over external changes");
            ShowPage("dashboard");ShowPage("spectrum");
            Check(Field("ScanExclusionThreshold").Text=="-"&&Field("ScanPeakThreshold").Text=="-59.5","incomplete pair survives page navigation");
            Show();Close();Check(IsVisible&&!shutdownStarted,"incomplete threshold cannot silently close and discard input");Hide();
            Field("ScanPeakThreshold").Text="-58";Field("ScanExclusionThreshold").Text="-90";
            for(int i=0;i<400&&spectrumSettingsStatus.StartsWith("正在");i++)await Task.Delay(10);
            Check(SpectrumUnconfirmed&&ScanPeakThresholdDbm==-58&&ScanExclusionThresholdDbm==-90,"CAS conflict retains unsaved user values");
            await PollSharedSettingsAsync();
            var stored=(await ReadRpcAsync("database.resources.get",new{kind="settings",id=SpectrumSettingId})).Field("resource");
            Check(JsonElement.DeepEquals(stored.Field("value"),externalValue)&&ScanExclusionThresholdDbm==-90,"poll does not overwrite dirty input or conflicting database revision");
            await RetrySpectrumSettingsAsync();
            Check(!SpectrumUnconfirmed,"explicit retry saves after revision conflict");
            body["expected_revision"]=(int)resources["settings:"+SpectrumSettingId].Number("revision")!;
            body["value"]=spectrumSettingsValue!.Value;body["operation_id"]=Guid.NewGuid().ToString("N");
            external=await ReadRpcAsync("database.write",body);
            settingOperations[SpectrumSettingId]=((string)body["operation_id"]!,body);
            await SetSpectrumThresholdsAsync(-58,-90);
            Check(!SpectrumUnconfirmed&&resources["settings:"+SpectrumSettingId].Number("revision")==external.Field("resource").Number("revision"),"lost receipt reconciles original operation without duplicate commit");
            var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            spectrumSettingsWriter=new ImmediateSettings(async(id,value)=>{await release.Task;return await WriteSystemSettingAsync(id,value);},(_,_,_,_)=>{});
            var pending=SetSpectrumThresholdsAsync(-56,-91);Show();Close();
            Check(IsVisible&&!shutdownStarted&&!connection.IsCancellationRequested,"pending spectrum save blocks close with connection preserved");
            release.SetResult();await pending;Hide();Check(!SpectrumUnconfirmed,"pending spectrum pair obtains database receipt before shutdown");
            spectrumSettingsWriter=null;
            await bridge!.DisposeAsync();bridge=new R19MqttClient(settings.Server,config.Text("ca")!,config.GetProperty("port").GetInt32());
            spectrumSettingsReady=false;spectrumSettingsValue=null;
            await InitializeSpectrumSettingsAsync();
            Check(spectrumSettingsReady&&ScanPeakThresholdDbm==-56&&ScanExclusionThresholdDbm==-91,"new MQTT connection restores committed thresholds");
        }
        Check(!Directory.EnumerateFiles(fixtureDirectory!,"*",SearchOption.AllDirectories).Any(),"no local threshold configuration or pending business files");
        await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,checks,records=new Dictionary<string,JsonElement>{{SpectrumSettingId,resources["settings:"+SpectrumSettingId]}},physicalCommands=0,loopbackOnly=true}));
    }
}
