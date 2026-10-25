using System.IO;
using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private async Task VerifyInitialSettingsRecoveryAsync(JsonElement config,string ca,int port)
    {
        var checks=new List<string>();
        void Check(bool okay,string name){if(!okay)throw new InvalidDataException(name);checks.Add(name);}
        var existing=Array(await ReadRpcAsync("database.resources.list",new{kind="settings",limit=50}),"resources");
        await bridge!.DisposeAsync();
        await LoadParityDataAsync();
        Check(!systemSettingsReady&&!planningSettingsReady,"failed initial read leaves settings unavailable");
        bridge=new R19MqttClient(settings.Server,ca,port);
        live.Apply(generation,await bridge.SnapshotAsync(connection.Token));
        await PollSharedSettingsAsync();
        Check(systemSettingsReady&&planningSettingsReady,"normal background poll restores configuration after initial failure");
        Check(pluginState is not null&&monitoringRules is not null,"plugin and display rules also recover");
        foreach(var record in existing.Where(r=>!r.Field("deleted").True()))
        {
            var actual=(await ReadRpcAsync("database.resources.get",new{kind="settings",id=record.Text("id")})).Field("resource");
            Check(JsonElement.DeepEquals(actual,record),"recovery preserves existing database record "+record.Text("id"));
        }
        var initialized=resources["settings:alert_sound"];
        resources.Remove("settings:alert_sound");
        await InitializeDatabaseSettingsAsync();
        Check(systemSettingsReady&&JsonElement.DeepEquals(resources["settings:alert_sound"],initialized),"concurrent initialization reads the winning record without overwriting it");
        // A partial reload must not erase another category's unconfirmed input.
        systemSettingsWriter=new ImmediateSettings((_,_)=>Task.FromException<JsonElement>(new IOException("isolated lost connection")),(_,_,_,_)=>{});
        await systemSettingsWriter.Submit("alert_sound",new{enabled=true});
        plannerBackupText="draft awaiting correction";
        planningSettingsWriter=new ImmediateSettings((_,_)=>Task.FromException<JsonElement>(new IOException("isolated pending draft")),(_,_,_,_)=>{});
        await planningSettingsWriter.Submit(PlanningSettingId,PlanningSettingValue());
        await LoadParityDataAsync();
        Check(systemSettingsWriter.HasUnsaved&&systemSettingsWriter.PendingValue("alert_sound")!.Value.Field("enabled").True(),"reload preserves unconfirmed system edit");
        Check(PlanningUnconfirmed&&plannerBackupText=="draft awaiting correction","reload preserves unconfirmed planning draft");
        systemSettingsWriter=null;planningSettingsWriter=null;
        await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,checks,physicalCommands=0,loopbackOnly=true}));
    }
}
