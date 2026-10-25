using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private async Task VerifySystemSettingsSaveAsync(JsonElement config)
    {
        var checks=new List<string>();
        void Check(bool okay,string name){if(!okay)throw new InvalidDataException(name+"; "+systemSettingsStatus);checks.Add(name);}
        async Task Idle(){for(int i=0;i<400&&systemSettingsWriter?.HasUnsaved==true;i++)await Task.Delay(20);Check(systemSettingsWriter?.HasUnsaved!=true,"automatic saves settled");}
        Dictionary<string,double> Revisions()=>SystemSettingDefaults.Keys.ToDictionary(id=>id,id=>resources["settings:"+id].Number("revision")!.Value);
        async Task<bool> Save(bool doubleClick=false)
        {
            var button=Descendants<Button>(this).Single(b=>Equals(b.Content,"保存"));
            button.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));
            var task=systemSettingsSaveTask;Check(task is not null,"actual Save button starts whole-page save");
            if(doubleClick){button.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));Check(ReferenceEquals(task,systemSettingsSaveTask),"duplicate click does not start another save");}
            var result=await task!;Check(!systemSettingsSavingAll&&Equals(button.Content,"保存")&&button.IsEnabled,"Save button recovers after completion");return result;
        }
        Check(verification&&fixtureNetwork&&systemSettingsReady,"isolated settings loaded");
        Width=1440;Height=900;ShowPage("settings");Show();UpdateLayout();
        if(config.Text("mode")=="settings-save-all")
        {
            var sliders=Descendants<Slider>(this).ToArray();Check(sliders.Length==4,"all four threshold controls present");
            var toggles=Descendants<CheckBox>(this).ToArray();Check(toggles.Length==4,"all four switches present");
            var combos=Descendants<ComboBox>(this).ToArray();Check(combos.Length==2,"both network selectors present");
            var ip=Descendants<TextBox>(this).Single();
            sliders[0].Value=-80;sliders[1].Value=30;sliders[2].Value=3;sliders[3].Value=-8;
            foreach(var (toggle,value) in toggles.Zip(new[]{true,true,false,true}))
            {toggle.IsChecked=value;toggle.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Button.ClickEvent));}
            combos[0].SelectedItem="15";combos[1].SelectedIndex=2;ip.Focus();ip.Text="192.0.2.7/24";
            Check(await Save(true),"Save joins in-flight edits and commits every form option");
            var first=Revisions();Check(await Save(true),"Save explicitly commits even clean categories");
            Check(first.All(x=>resources["settings:"+x.Key].Number("revision")==x.Value+1),"exactly one new revision per category after repeated click");
            ip.Focus();ip.Text="invalid-ip/";await Task.Delay(30);
            Check(systemSettingsWriter?.IsDirty("network_connection")==true,"invalid network edit remains unsaved in memory");
            var invalidBefore=Revisions();Check(!await Save(),"invalid form cannot report full save success");
            Check(invalidBefore.All(x=>resources["settings:"+x.Key].Number("revision")==x.Value),"invalid whole-page snapshot performs no category writes");
            Close();Check(IsVisible&&!shutdownStarted,"invalid unsaved edit blocks normal close");
            ip=Descendants<TextBox>(this).Single();Check(ip.Text=="invalid-ip/","failed edit survives page recreation");
            ip.Text="192.0.2.7/24";await Idle();Check(await Save(),"corrected form saves all categories");
            // A different client commits after this form's baseline. No automatic overwrite.
            var current=resources["settings:network_connection"];
            var externalValue=current.Field("value").Deserialize<Dictionary<string,JsonElement>>()!;
            externalValue["heartbeatSeconds"]=JsonSerializer.SerializeToElement(60);
            await ReadRpcAsync("database.write",new{kind="settings",id="network_connection",epoch=(await ReadRpcAsync("database.status")).Text("epoch"),operation_id=Guid.NewGuid().ToString("N"),expected_revision=(int)current.Number("revision")!,value=externalValue});
            Check(!await Save(),"concurrent database revision prevents false full-save success");
            var actual=(await ReadRpcAsync("database.resources.get",new{kind="settings",id="network_connection"})).Field("resource");
            Check(actual.Field("value").Number("heartbeatSeconds")==60&&systemSettingsWriter?.IsDirty("network_connection")==true,"conflicting category remains unchanged and pending");
            Check(await Save(),"new explicit Save resolves the known revision conflict");
            Check(systemSettingsStatus.StartsWith("已保存 · 全部 11 项"),"success requires all four database readbacks");
        }
        Check(thresholds==new AlertThresholds(-80,30,3,-8)&&soundEnabled&&automaticFrequency,"four thresholds and two booleans match database");
        Check(networkSettings.Text("localIp")=="192.0.2.7/24"&&networkSettings.Number("heartbeatSeconds")==15&&networkSettings.Text("reconnectStrategy")=="manual"&&!networkSettings.Field("shureExclusive").True()&&networkSettings.Field("pcom1Enabled").True(),"five network options match database");
        Check(systemSettingsWriter?.HasUnsaved!=true&&settingOperations.Count==0,"no unconfirmed settings remain");
        Check(!Directory.EnumerateFiles(fixtureDirectory!,"*",SearchOption.AllDirectories).Any(),"no local settings file created");
        Hide();
        await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,checks,records=SystemSettingDefaults.Keys.ToDictionary(id=>id,id=>resources["settings:"+id]),physicalCommands=0,loopbackOnly=true}));
    }
}
