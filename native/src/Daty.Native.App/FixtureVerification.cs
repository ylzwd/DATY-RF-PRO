using System.IO;
using System.Text;
using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private bool fixtureNetwork;
    private string? fixtureDirectory;
    internal async Task VerifyFixtureActionsAsync(string configPath)
    {
        using var document=JsonDocument.Parse(await File.ReadAllBytesAsync(configPath));var config=document.RootElement;
        var directory=Path.GetFullPath(config.GetProperty("root").GetString()!);var origin=new Uri(config.GetProperty("origin").GetString()!);var port=config.GetProperty("port").GetInt32();var ca=Path.GetFullPath(config.GetProperty("ca").GetString()!);
        if(!verification||origin.Host!="127.0.0.1"||port==8083||!Path.GetFileName(directory).StartsWith("daty-mqtt-stage6-",StringComparison.Ordinal)||
           !File.Exists(Path.Combine(directory,".daty-mqtt-stage6-fixture"))||!ca.StartsWith(directory+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Only a marked isolated loopback fixture is accepted");
        fixtureDirectory=Path.Combine(directory,"native-ui");Directory.CreateDirectory(fixtureDirectory);fixtureNetwork=true;settings=new NativeSettings(origin.GetLeftPart(UriPartial.Authority),MqttPort:port);generation=live.SwitchTarget();
        bridge=new R19MqttClient(settings.Server,ca,port);var results=new List<string>();
        void Check(bool okay,string name){if(!okay)throw new InvalidDataException(name+"; "+StatusMessage.Text);results.Add(name);}
        try
        {
            var snapshot=await bridge.SnapshotAsync(connection.Token);
            if(config.Text("mode")=="runtime-status")
            {
                await VerifyRuntimeStatusAsync(config,ca,port);
                return;
            }
            if(config.Text("mode")=="settings-initial-recovery")
            {
                live.Apply(generation,snapshot);
                await VerifyInitialSettingsRecoveryAsync(config,ca,port);
                return;
            }
            if(config.Text("mode") is "close-connected" or "close-inflight" or "close-settings" or "close-planning")
            {
                live.Apply(generation,snapshot);await LoadParityDataAsync();
                Check(systemSettingsReady,"settings loaded before normal shutdown");
                var received=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                deviceStream=new R19DeviceStream(settings.Server,ca,port);deviceStream.SnapshotReceived+=_=>received.TrySetResult();deviceStream.Start();
                await received.Task.WaitAsync(TimeSpan.FromSeconds(8));
                var requests=new List<Task<JsonElement>>();
                if(config.Text("mode")=="close-settings")
                {
                    var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    systemSettingsWriter=new ImmediateSettings(async(id,value)=>{await release.Task;return await WriteSystemSettingAsync(id,value);},(_,_,_,_)=>{});
                    var save=systemSettingsWriter.Submit("alert_sound",new{enabled=true});Show();Close();
                    Check(IsVisible&&!shutdownStarted&&!connection.IsCancellationRequested&&Shell.IsEnabled,"pending real setting blocks close without disconnecting");
                    release.SetResult();await save;
                    Check(!systemSettingsWriter.HasUnsaved&&settingOperations.Count==0,"real database commit confirmed before close");
                }
                if(config.Text("mode")=="close-planning")
                {
                    var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    planningSettingsWriter=new ImmediateSettings(async(id,value)=>{await release.Task;return await WritePlanningSettingAsync(id,value);},(_,_,_,_)=>{});
                    plannerBackupText="4";backupCount=4;var save=planningSettingsWriter.Submit(PlanningSettingId,PlanningSettingValue());Show();Close();
                    Check(IsVisible&&!shutdownStarted&&!connection.IsCancellationRequested&&Shell.IsEnabled,"pending planning setting blocks close without disconnecting");
                    release.SetResult();await save;Check(!PlanningUnconfirmed,"planning commit confirmed before close");
                }
                var inflight=config.Text("mode")=="close-inflight";
                var closeResult=await CheckWindowExitAsync(this,config.Text("mode")!,10,()=>{if(inflight)for(var i=0;i<64;i++)requests.Add(bridge.CallAsync("devices.snapshot"));});
                var cancelled=0;foreach(var request in requests){try{await request;}catch(Exception e)when(e is OperationCanceledException or ObjectDisposedException or R19RpcException){cancelled++;}}
                if(requests.Count>0)Check(cancelled>0,"queued reads cancel during shutdown");
                await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,checks=results,closeResult,cancelled,physicalCommands=0,loopbackOnly=true}));return;
            }
            if(config.Text("mode")=="recovery")
            {
                live.Apply(generation,snapshot);Directory.CreateDirectory(fixtureDirectory);
                var intent=config.GetProperty("pending");var legacy=PendingPath("device-command");await File.WriteAllTextAsync(legacy,intent.GetRawText());
                var blocked=ViewChannels.Single(c=>c.Id==intent.Field("target").Text("device_id"));
                var other=ViewChannels.First(c=>c.ReceiverId!=blocked.ReceiverId);Check(await SendDeviceCommandAsync(other,"mute",true),"other receiver remains controllable during automatic recovery");
                other=ViewChannels.Single(c=>c.Id==other.Id);Check(await SendDeviceCommandAsync(other,"unmute",false),"other receiver unmute confirms real ACK");
                for(var poll=0;poll<100;poll++){await RefreshCommandRecoveryAsync();if(!File.Exists(legacy))break;await Task.Delay(100);}
                Check(!File.Exists(legacy)&&pendingCommandIds.Count==0,"server auto review retires exact legacy pending without UI action");
                var reviewed=await ReadRpcAsync("commands.get",new{operation_id=intent.Text("operation_id")});
                Check(reviewed.Text("state")=="timeout"&&reviewed.Field("execution_evidence").ValueKind==JsonValueKind.Null&&reviewed.Field("review").Text("mode")=="automatic","automatic review preserves unknown execution result");
                await RefreshAsync();blocked=ViewChannels.Single(c=>c.Id==blocked.Id);Check(await SendDeviceCommandAsync(blocked,"unmute",false),"new explicit command succeeds after automatic review");
                await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,checks=results,physicalCommands=0,loopbackOnly=true}));return;
            }
            if(config.Text("mode")=="shure-manual")
            {
                Check(snapshot.Channels.Count==5&&snapshot.Channels.Count(c=>c.Brand=="Shure"&&c.Ip=="127.0.0.1")==1,"loopback manual Shure identity");
                live.Apply(generation,snapshot);await LoadParityDataAsync();
                planRange="640000:690000";planStart="640.000";planEnd="690.000";backupCount=0;plannerBackupText="0";
                Check(await SavePlannerDraftAsync(),"Shure test planning settings committed");ShowPage("planner");Show();UpdateLayout();
                var shure=ViewChannels.Single(c=>c.Brand=="Shure");manualPlanned[shure.Id]="678.000";
                fixturePlanConfirmation=()=>true;await DeployPlanAsync(shure.Id);fixturePlanConfirmation=null;
                Check(deploymentRows.GetValueOrDefault(shure.Id)=="设备确认完成","manual Shure frequency verified by independent TCP readback");
                for(int poll=0;poll<40&&ViewChannels.Single(c=>c.Id==shure.Id).FrequencyKHz!=678000;poll++){await Task.Delay(50);await RefreshAsync();}
                Check(ViewChannels.Single(c=>c.Id==shure.Id).FrequencyKHz==678000,"Shure actual frequency displayed after real telemetry follows readback");Hide();
                await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,checks=results,physicalCommands=0,loopbackOnly=true}));return;
            }
            if(config.Text("mode")=="shure")
            {
                Check(snapshot.Channels.Count==5&&snapshot.Channels.Count(c=>c.Brand=="Shure"&&c.Ip=="127.0.0.1"&&c.Raw.Text("receiver_mac")=="00:0E:DD:AD:31:A3")==1,"loopback Shure receiver identity");
                live.Apply(generation,snapshot);var shure=ViewChannels.Single(c=>c.Brand=="Shure");
                Check(await SendDeviceCommandAsync(shure,"mute",true),"native Shure mute independent readback");
                shure=ViewChannels.Single(c=>c.Brand=="Shure");Check(shure.Muted==true,"confirmed mute overrides older RF metadata");
                Check(await SendDeviceCommandAsync(shure,"unmute",false),"native Shure unmute independent readback");
                Check(ViewChannels.Single(c=>c.Brand=="Shure").Muted==false,"confirmed unmute displayed");
                await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,checks=results,physicalCommands=0,loopbackOnly=true}));return;
            }
            Check(snapshot.Channels.Count==4&&snapshot.Channels.All(c=>c.Brand=="DATYaudio"&&c.Raw.Text("receiver_mac") is "02:00:00:00:00:98" or "02:00:00:00:00:99"),"isolated receiver identities");live.Apply(generation,snapshot);
            await LoadParityDataAsync();
            if(config.Text("mode")?.StartsWith("spectrum-",StringComparison.Ordinal)==true){await VerifySpectrumSettingsFixtureAsync(config);return;}
            if(config.Text("mode") is "monitoring-write" or "monitoring-read"){await VerifyMonitoringDatabaseAsync(config);return;}
            if(config.Text("mode") is "settings-save-all" or "settings-save-all-read"){await VerifySystemSettingsSaveAsync(config);return;}
            if(config.Text("mode")=="table-edit-deploy"){await VerifyTableEditDeployAsync(config);return;}
            if(config.Text("mode")?.StartsWith("planning-",StringComparison.Ordinal)==true){await VerifyPlanningFixtureAsync(config);return;}
            if(config.Text("mode") is "settings-write" or "settings-read")
            {
                Check(systemSettingsReady&&SystemSettingDefaults.Keys.All(id=>resources.ContainsKey("settings:"+id)),"all settings loaded from actual database");
                if(config.Text("mode")=="settings-write")
                {
                    var a=SaveThresholdsAsync(new(-85,25,2,-5));var b=SaveThresholdsAsync(new(-80,30,3,-8));await Task.WhenAll(a,b);
                    await SaveBooleanSettingAsync("alert_sound",true);await SaveBooleanSettingAsync("auto_frequency",true);
                    await SaveSystemSettingAsync("network_connection",new{localIp="192.0.2.7/24",heartbeatSeconds=15,reconnectStrategy="manual",shureExclusive=false,pcom1Enabled=true});
                    Check(systemSettingsWriter?.HasUnsaved==false&&settingOperations.Count==0,"all edits have exact committed receipts");
                }
                Check(thresholds==new AlertThresholds(-80,30,3,-8)&&soundEnabled&&automaticFrequency,"all alert and recommendation settings survive database read");
                Check(networkSettings.Text("localIp")=="192.0.2.7/24"&&networkSettings.Number("heartbeatSeconds")==15&&networkSettings.Text("reconnectStrategy")=="manual"&&!networkSettings.Field("shureExclusive").True()&&networkSettings.Field("pcom1Enabled").True(),"all five network fields survive database read");
                Check(!Directory.EnumerateFiles(fixtureDirectory,"*",SearchOption.AllDirectories).Any(),"no local settings or pending-business files created");
                await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,checks=results,records=SystemSettingDefaults.Keys.ToDictionary(id=>id,id=>resources["settings:"+id]),physicalCommands=0,loopbackOnly=true}));return;
            }
            var first=await SaveResourceAsync("settings","alert_sound",new{enabled=false});Check(first.Number("revision")==resources["settings:alert_sound"].Number("revision")&&first.Number("revision")>=2,"native settings commit receipt after database initialization");
            var external=await ReadRpcAsync("database.write",new{kind="settings",id="alert_sound",expected_revision=(int)first.Number("revision")!,value=new{enabled=true},epoch=(await ReadRpcAsync("database.status")).Text("epoch"),operation_id=Guid.NewGuid().ToString("N")});
            bool conflict=false;try{await SaveResourceAsync("settings","alert_sound",new{enabled=false});}catch(R19RpcException e)when(e.Status==409){conflict=true;}Check(conflict,"concurrent setting edit rejected");resources.Clear();
            planRange="custom";planStart="630.000";planEnd="690.000";backupCount=0;plannerBackupText="0";
            Check(await SavePlannerDraftAsync(),"native planning configuration committed to database");
            var csv="Frequency (MHz),Level (dBm)\n"+string.Join("\n",Enumerable.Range(0,12000).Select(i=>$"{(630000+i)/1000d:0.000},-100"));var bytes=Encoding.UTF8.GetBytes(csv);var parsed=LocalFiles.ParseScan(bytes,"fixture.csv",default);await SaveScanImportAsync(parsed,bytes);
            Check(scan?.Points.Count==12000,"native scan remains in memory");scan=null;
            var options=PlanningOptions();var devices=CoordinationEngine.CalculationDevices(ViewChannels.Where(c=>c.Online));var plan=CoordinationEngine.Plan(devices,options,customProfiles,default);Check(Array(plan,"errors").Length==0&&Array(plan,"assignments").Length==4,"complete native planning calculation");
            CoordinationEngine.ValidateDeployment(plan,devices,devices,options,customProfiles,null,default);results.Add("native complete-plan preflight");await SavePlanningResultAsync(devices,options,plan);results.Add("native calculation has no history save");
            var channel=ViewChannels.First();Check(await SendDeviceCommandAsync(channel,"mute",true),"native mute real fixture ACK");await Task.Delay(150);await RefreshAsync();channel=ViewChannels.First(c=>c.Id==channel.Id);Check(channel.Muted==true,"native mute actual snapshot");Check(await SendDeviceCommandAsync(channel,"unmute",false),"native unmute real fixture ACK");
            foreach(var method in new[]{"archives.create","timeline.list","database.activity.list","database.draft.get"})
            {
                bool refused=false;try{await ReadRpcAsync(method,new{});}catch(R19RpcException e)when(e.Code=="DATA_FEATURE_RETIRED"){refused=true;}
                Check(refused,"retired API rejected: "+method);
            }
            Check(DataTabs.Length==2&&DataTabs.All(t=>t.Key is "devices" or "config"),"only retained data tabs exist");
            RestoreAlertState();ObserveAlerts(ViewChannels);Check(alertMonitor.PendingArchives.Count==0,"realtime alerts do not queue archives");
            await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,checks=results,deviceCommands=2,physicalCommands=0,loopbackOnly=true},new JsonSerializerOptions{WriteIndented=true}));
        }
        finally{fixtureNetwork=false;await bridge.DisposeAsync();if(deviceStream is not null)await deviceStream.DisposeAsync();bridge=null;}
    }
}
