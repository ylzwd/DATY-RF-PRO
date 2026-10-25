using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private bool soundEnabled,automaticFrequency,settingsFormSynchronizing;private Action? settingsStatusRefresh;
    private UIElement Settings()
    {
        settingsStatusRefresh=null;settingsFormRefresh=null;var compact=Height<=800;var grid=Columns(Star(),Star());grid.RowDefinitions.Add(new(){Height=Star(1.1)});grid.RowDefinitions.Add(new(){Height=Star(.9)});
        var alerts=new StackPanel();var alertTitle=HeaderRow("🔔 告警阈值设置");alertTitle.Margin=new(0,0,0,compact?6:9);alerts.Children.Add(alertTitle);
        Slider SettingSlider(string label,double min,double max,double value,string unit){var line=Columns(Star(),GridLength.Auto);var number=Text(value.ToString("0")+unit,12,"#22d3ee");At(line,Text(label,12,"#7c8db5"));At(line,number,0,1);alerts.Children.Add(line);var slider=new Slider{Minimum=min,Maximum=max,Value=value,TickFrequency=1,IsSnapToTickEnabled=true,Margin=new(0,compact?1:4,0,compact?4:8)};slider.ValueChanged+=(_,_)=>number.Text=slider.Value.ToString("0")+unit;alerts.Children.Add(slider);return slider;}
        var thresholdDraft=SettingDraft("alert_thresholds",new{rfWeakDbm=thresholds.Rf,batteryLowPercent=thresholds.Battery,batteryLowBars=thresholds.Bars,afOverloadDbfs=thresholds.Af});
        var rf=SettingSlider("RF 弱信号阈值",-90,-30,thresholdDraft.Number("rfWeakDbm")!.Value," dBm");var batt=SettingSlider("电池低电量阈值",5,50,thresholdDraft.Number("batteryLowPercent")!.Value,"%");var bars=SettingSlider("舒尔电池格数阈值（百分比未知时）",0,5,thresholdDraft.Number("batteryLowBars")!.Value," 格");var af=SettingSlider("AF 过载阈值",-40,0,thresholdDraft.Number("afOverloadDbfs")!.Value," dBFS");
        foreach(var slider in new[]{rf,batt,bars,af})slider.ValueChanged+=(_,_)=>{if(!settingsFormSynchronizing)_=SaveThresholdsAsync(new(rf.Value,batt.Value,bars.Value,af.Value));};
        alerts.Children.Add(Text("实时判定：RF ≤ 阈值、电池 ≤ 阈值、AF ≥ 阈值（边界包含）。缺失遥测不新增告警；舒尔异常失联后保留待确认，收到正常状态后恢复。",10,"#7c8db5",new(0,0,0,8)));
        var sound=SwitchRow("声音告警",soundEnabled?"声音告警已开启":"声音告警已关闭",SettingDraft("alert_sound",new{enabled=soundEnabled}).Field("enabled").True(),enabled=>_=SaveBooleanSettingAsync("alert_sound",enabled),ActionButton("试听",()=>{if(soundEnabled)System.Media.SystemSounds.Exclamation.Play();else Message("声音告警已关闭");}));alerts.Children.Add(sound);
        var automatic=SwitchRow("自动变频推荐",automaticFrequency?"自动变频推荐已开启":"自动变频推荐已关闭",SettingDraft("auto_frequency",new{enabled=automaticFrequency}).Field("enabled").True(),enabled=>_=SaveBooleanSettingAsync("auto_frequency",enabled),ActionButton("查看建议",()=>_=ShowFrequencySuggestionsAsync()));alerts.Children.Add(automatic);
        At(grid,Panel(Scroll(alerts),compact?12:16,new(0,0,7,10)),0,0);
        AtDatabaseNetwork();
        void AtDatabaseNetwork()
        {
            var network=new StackPanel();network.Children.Add(HeaderRow("🌐 网络与连接设置"));
            var networkDraft=SettingDraft("network_connection",networkSettings);
            var ip=Input(networkDraft.Text("localIp")??"");ip.ToolTip="留空表示自动检测；此处保存显示偏好，不修改电脑网卡或服务器地址";
            network.Children.Add(Labeled("本机 IP / 网段（留空自动）",ip));
            var heartbeat=Select(["30","15","60"],minWidth:120);heartbeat.SelectedItem=(networkDraft.Number("heartbeatSeconds")??30).ToString();
            var strategies=new[]{"指数退避（推荐）","固定间隔 5s","手动重连"};var strategy=Select(strategies);string[] strategyIds=["exponential","fixed5","manual"];
            strategy.SelectedIndex=System.Array.IndexOf(strategyIds,networkDraft.Text("reconnectStrategy")??"exponential");
            network.Children.Add(Labeled("心跳间隔（秒）",heartbeat));network.Children.Add(Labeled("断线重连策略",strategy));
            var exclusive=networkDraft.Field("shureExclusive").True();var remote=networkDraft.Field("pcom1Enabled").True();
            object Values()=>new{localIp=ip.Text.Trim(),heartbeatSeconds=int.Parse(heartbeat.SelectedItem?.ToString()??"30"),reconnectStrategy=strategyIds[Math.Max(0,strategy.SelectedIndex)],shureExclusive=exclusive,pcom1Enabled=remote};
            Action statusRefresh=()=>{};
            void SaveNetwork(){if(settingsFormSynchronizing)return;_=SaveSystemSettingAsync("network_connection",Values());}
            network.Children.Add(SwitchRow("Shure SCP 独占模式","选项入库；独占控制尚未接入",exclusive,v=>{exclusive=v;SaveNetwork();}));
            network.Children.Add(SwitchRow("pcom1 远程服务器","选项入库；远程协议尚未接入",remote,v=>{remote=v;SaveNetwork();}));
            network.Children.Add(Hint("所有选项直接保存到数据库。网络策略暂不改变当前协议连接。", "#7c8db5"));
            var saveStatus=Text(systemSettingsStatus,11,"#7c8db5",new(0,7,0,7));network.Children.Add(saveStatus);
            statusRefresh=()=>saveStatus.Text=systemSettingsStatus;
            Dictionary<string,JsonElement> ReadForm()=>new()
            {
                ["alert_thresholds"]=JsonSerializer.SerializeToElement(new{rfWeakDbm=rf.Value,batteryLowPercent=batt.Value,batteryLowBars=bars.Value,afOverloadDbfs=af.Value}),
                ["alert_sound"]=JsonSerializer.SerializeToElement(new{enabled=Descendants<CheckBox>(sound).Single().IsChecked==true}),
                ["auto_frequency"]=JsonSerializer.SerializeToElement(new{enabled=Descendants<CheckBox>(automatic).Single().IsChecked==true}),
                ["network_connection"]=JsonSerializer.SerializeToElement(Values())
            };
            var save=ActionButton("保存",()=>{if(!systemSettingsSavingAll)systemSettingsSaveTask=SaveAllSystemSettingsAsync(ReadForm);},"PrimaryButton");
            save.ToolTip="立即按告警阈值、声音告警、自动变频推荐、网络与连接保存本页全部 11 项选项；核对数据库回执和读回值后确认。";
            network.Children.Add(save);
            ip.TextChanged+=(_,_)=>SaveNetwork();heartbeat.SelectionChanged+=(_,_)=>SaveNetwork();strategy.SelectionChanged+=(_,_)=>SaveNetwork();
            settingsFormRefresh=()=>{
                settingsFormSynchronizing=true;
                try{
                    statusRefresh();var enabled=(systemSettingsReady||verification)&&!systemSettingsSavingAll;
                    foreach(var slider in new[]{rf,batt,bars,af})slider.IsEnabled=enabled;
                    foreach(var input in Descendants<System.Windows.Controls.Primitives.ToggleButton>(grid))input.IsEnabled=enabled;
                    ip.IsEnabled=heartbeat.IsEnabled=strategy.IsEnabled=save.IsEnabled=enabled;
                    save.Content=systemSettingsSavingAll?"保存中…":"保存";
                    if(systemSettingsSavingAll)return;
                    if(systemSettingsWriter?.IsDirty("alert_thresholds")!=true){rf.Value=thresholds.Rf;batt.Value=thresholds.Battery;bars.Value=thresholds.Bars;af.Value=thresholds.Af;}
                    if(systemSettingsWriter?.IsDirty("network_connection")!=true){ip.Text=networkSettings.Text("localIp")??"";heartbeat.SelectedItem=(networkSettings.Number("heartbeatSeconds")??30).ToString();strategy.SelectedIndex=System.Array.IndexOf(strategyIds,networkSettings.Text("reconnectStrategy")??"exponential");exclusive=networkSettings.Field("shureExclusive").True();remote=networkSettings.Field("pcom1Enabled").True();var toggles=Descendants<CheckBox>(network).ToArray();if(toggles.Length>=2){toggles[0].IsChecked=exclusive;toggles[1].IsChecked=remote;}}
                }finally{settingsFormSynchronizing=false;}
            };
            At(grid,Panel(Scroll(network),compact?12:16,new(7,0,0,10)),0,1);settingsFormRefresh();
        }
        var pluginPanel=Rows(GridLength.Auto,Star(),GridLength.Auto);var import=ActionButton("📥 导入插件",()=>_=ImportPluginAsync());var export=ActionButton("📤 开发者插件导出",()=>_=ExportPluginPackageAsync());var cloud=ActionButton("☁ 云端导入",()=>Message("云端插件服务尚未开放，请导入平台审核的本地插件包。",true));
        export.Visibility=Visibility.Collapsed;
        var pluginTitle=Heading("🧩 品牌插件管理");pluginTitle.HorizontalAlignment=HorizontalAlignment.Left;
        int titleClicks=0;long? firstTitleClick=null;
        pluginTitle.MouseLeftButtonUp+=(_,e)=>{
            e.Handled=true;if(export.Visibility==Visibility.Visible)return;
            var now=System.Diagnostics.Stopwatch.GetTimestamp();
            if(firstTitleClick is null||System.Diagnostics.Stopwatch.GetElapsedTime(firstTitleClick.Value,now).TotalSeconds>3){firstTitleClick=now;titleClicks=0;}
            if(++titleClicks>=5){export.Visibility=Visibility.Visible;titleClicks=0;firstTitleClick=null;}
        };
        var head=Columns(Star(),GridLength.Auto);At(head,pluginTitle);var pluginTools=Horizontal(export,cloud,import);foreach(var b in new[]{export,cloud,import}){b.Padding=new(8,4,8,4);b.FontSize=10;b.Margin=new(6,0,0,0);}At(head,pluginTools,0,1);head.Margin=new(0,0,0,10);Put(pluginPanel,head,0);var list=new StackPanel();Put(pluginPanel,Scroll(list),1);var query=ActionButton("查询安装结果",()=>_=QueryPluginAsync());query.HorizontalAlignment=HorizontalAlignment.Left;Put(pluginPanel,query,2);
        pluginRefresh=()=>{import.IsEnabled=!importing&&pluginImports is not null;query.Visibility=pluginImports?.Pending is null?Visibility.Collapsed:Visibility.Visible;query.IsEnabled=!importing;list.Children.Clear();if(pluginState is null){list.Children.Add(Text("等待服务器确认已安装插件…",11,"#7c8db5"));return;}foreach(var kind in new[]{"builtin","plugins"})foreach(var plugin in Array(pluginState.Value,kind)){var row=Columns(Star(),GridLength.Auto);var info=new StackPanel();info.Children.Add(Heading(plugin.Text("name")??(plugin.Text("brand")=="Shure"?"Shure SCP":plugin.Text("brand")=="DATYaudio"?"DATYaudio MQTT":plugin.Text("brand"))??"—",12));info.Children.Add(Text(plugin.Text("brand")=="Shure"?"ULX-D / AD4 · 发现、监测与受控下发":plugin.Text("brand")=="DATYaudio"?"DATYaudio 接收机 / FAshe":plugin.Text("description")??"已导入品牌配接插件",10,"#7c8db5"));At(row,info);var state=kind=="builtin"?"内置":plugin.Text("state") is "remove_requested" or "removing"?"移除中":plugin.Field("active").True()?"已导入":"未启用";At(row,new Border{Background=B("#13323a"),CornerRadius=new(4),Padding=new(14,4,14,4),Child=Text(state,10,"#5eead4"),VerticalAlignment=VerticalAlignment.Center},0,1);list.Children.Add(new Border{Child=row,Background=B("#171c2b"),BorderBrush=B("#242c42"),BorderThickness=new(1),CornerRadius=new(7),Padding=new(8,5,8,5),Margin=new(0,0,0,6)});}};pluginRefresh();At(grid,Panel(pluginPanel,16,new(0,0,7,0)),1,0);
        var about=new StackPanel();var aboutTitle=HeaderRow("ℹ️ 关于");aboutTitle.Margin=new(0,0,0,6);about.Children.Add(aboutTitle);var brand=Heading("DATY RF PRO",16);brand.HorizontalAlignment=HorizontalAlignment.Center;brand.Foreground=new System.Windows.Media.LinearGradientBrush(System.Windows.Media.Color.FromRgb(99,102,241),System.Windows.Media.Color.FromRgb(34,211,238),0);about.Children.Add(new Border{Child=brand,Background=B("#152236"),BorderBrush=B("#343967"),BorderThickness=new(1),CornerRadius=new(8),Padding=new(10,5,10,5),Margin=new(0,0,0,7)});
        foreach(var (name,value) in new[]{("版本",App.DisplayVersion),("内核版本","P0 2026-09-10"),("IMD 算法","2T30/50/70/90 · 3T30"),("支持平台","Windows 10/11"),("许可证","MIT License"),("开发者","ylzwd")}){var row=Columns(Star(),GridLength.Auto);row.Margin=new(0,0,0,4);At(row,Text(name,12,"#7c8db5"));At(row,Text(value,12),0,1);about.Children.Add(row);}about.Children.Add(Hint("DATY RF PRO — 专业射频管理平台\n打破品牌协议壁垒，一站式多品牌无线设备频率规划与实时控制"));At(grid,Panel(Scroll(about),compact?12:16,new(7,0,0,0)),1,1);return grid;
    }
    private UIElement SwitchRow(string title,string subtitle,bool value,Action<bool>? change,UIElement? extra=null)
    {
        var row=Columns(Star(),GridLength.Auto,GridLength.Auto);row.Margin=new(0,Height<=800?3:7,0,Height<=800?3:7);var text=new StackPanel();text.Children.Add(Heading(title,12));var subtitleText=Text(subtitle,11,"#7c8db5");text.Children.Add(subtitleText);At(row,text);if(extra is not null)At(row,extra,0,1);var toggle=new CheckBox{Style=(Style)FindResource("ToggleSwitch"),IsChecked=value,Margin=new(8,0,0,0),IsEnabled=change is not null};if(title=="声音告警")settingsStatusRefresh+=()=>{if(systemSettingsWriter?.IsDirty("alert_sound")!=true)toggle.IsChecked=soundEnabled;subtitleText.Text=soundEnabled?"声音告警已开启":"声音告警已关闭";};if(title=="自动变频推荐")settingsStatusRefresh+=()=>{if(systemSettingsWriter?.IsDirty("auto_frequency")!=true)toggle.IsChecked=automaticFrequency;subtitleText.Text=automaticFrequency?"自动变频推荐已开启":"自动变频推荐已关闭";};toggle.Click+=(_,_)=>change?.Invoke(toggle.IsChecked==true);At(row,toggle,0,2);return row;
    }
}
