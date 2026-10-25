using System.Text.Json;
using System.Windows.Threading;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private readonly DispatcherTimer sharedSettingsTimer=new(){Interval=TimeSpan.FromSeconds(1)};
    private bool settingsReading;
    private readonly Dictionary<string,double> sharedSettingsVersions=[];
    private async Task PollSharedSettingsAsync()
    {
        if((verification&&!fixtureNetwork)||settingsReading||bridge is null||!live.Connected)return;
        settingsReading=true;
        try
        {
            // Stream recovery alone does not mean the initial settings/Profile reads succeeded.
            if(!parityDataReady){await LoadParityDataAsync();if(!parityDataReady)return;}
            if(SpectrumUnconfirmed&&DateTime.UtcNow>=spectrumRetryAt)await RetrySpectrumSettingsAsync();
            var reply=await ReadRpcAsync("database.resources.list",new{kind="settings",limit=50});
            ReadMonitoringResources(Array(reply,"resources"));
            var changed=false;
            foreach(var record in Array(reply,"resources"))
            {
                var id=record.Text("id")??"";if(((systemSettingsSavingAll&&SystemSettingDefaults.ContainsKey(id))||systemSettingsWriter?.IsDirty(id)==true||settingOperations.ContainsKey(id)||(id==PlanningSettingId&&(!planningSettingsReady||PlanningUnconfirmed||PlanningEditing))||(id==SpectrumSettingId&&(!spectrumSettingsReady||SpectrumUnconfirmed||SpectrumEditing)))||record.Field("deleted").True())continue;
                var revision=record.Number("revision")??0;
                if(sharedSettingsVersions.GetValueOrDefault(id)==revision)continue;
                sharedSettingsVersions[id]=revision;var value=record.Field("value");
                ApplyDatabaseSetting(id,value);changed=true;
                resources["settings:"+id]=record;
            }
            if(changed&&currentPage=="settings"){settingsStatusRefresh?.Invoke();settingsFormRefresh?.Invoke();}
        }
        catch(OperationCanceledException){}
        catch(Exception){/* Connection status is owned by the continuous stream. */}
        finally{settingsReading=false;}
    }
}
