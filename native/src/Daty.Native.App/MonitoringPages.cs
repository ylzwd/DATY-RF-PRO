using System.Globalization;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private AlertThresholds thresholds=new();
    private string brandFilter="全部品牌",statusFilter="全部状态",channelSort="按编组排序";
    private readonly Dictionary<string,DateTimeOffset> issueTimes=[];
    private readonly LiveAlertMonitor alertMonitor=new(archiveEnabled:false);
    private IReadOnlyList<LiveIssue> CurrentIssues() {
        var episodes=alertMonitor.Active;var result=episodes.Select(a=>a.Issue).ToArray();
        foreach(var episode in episodes)issueTimes[episode.Issue.Key]=DateTimeOffset.FromUnixTimeMilliseconds(episode.FirstSeen).ToLocalTime();
        foreach(var key in issueTimes.Keys.Except(result.Select(i=>i.Key)).ToArray())issueTimes.Remove(key);
        return result;
    }
    private void ObserveAlerts(IReadOnlyList<Channel> channels){var added=alertMonitor.Observe(channels,thresholds,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());if(!verification)_=PersistAlertsAsync();if(added>0&&automaticFrequency&&!verification)_=GenerateFrequencySuggestionsAsync(false);if(added>0&&soundEnabled&&!verification)try{System.Media.SystemSounds.Exclamation.Play();}catch{} }
    private UIElement Dashboard()
    {
        if(monitoringRules is not {} rules)return Empty("等待服务器数据库显示规则…");
        var page=Rows(GridLength.Auto,Star(),new GridLength(28),Star());var stats=new UniformGrid{Columns=4,Margin=new(0,0,0,14)};
        var numbers=new TextBlock[4];var notes=new TextBlock[4];
        string[] labels=rules.OverviewLabels, colors=["#818cf8","#22d3ee","#6ee7b7","#fbbf24"];
        for(int i=0;i<4;i++) {
            var stack=new StackPanel();numbers[i]=Text("—",20,colors[i]);numbers[i].FontWeight=FontWeights.Black;numbers[i].Height=20;numbers[i].LineHeight=20;numbers[i].LineStackingStrategy=LineStackingStrategy.BlockLineHeight;notes[i]=Text("",9,"#4a5578",new(0,3,0,0));
            stack.Children.Add(numbers[i]);stack.Children.Add(Text(labels[i],10,"#7c8db5",new(0,2,0,0)));stack.Children.Add(notes[i]);
            var holder=new Grid();holder.Children.Add(new Border{Child=stack,Padding=new(12,8,12,8)});
            holder.Children.Add(new Border{Background=B(colors[i]),Height=2,VerticalAlignment=VerticalAlignment.Top,CornerRadius=new(10,10,0,0)});
            stats.Children.Add(new Border{Background=B("#111520"),BorderBrush=B("#242c42"),BorderThickness=new(1),CornerRadius=new(10),Child=holder,Margin=new(0,0,i<3?8:0,0),Height=72});
        }
        Put(page,stats,0);
        var alarms=Rows(GridLength.Auto,Star());var alarmList=new StackPanel();var empty=Empty("暂无告警事件");empty.VerticalAlignment=VerticalAlignment.Top;empty.Margin=new(20,40,20,0);
        var display=new Grid();display.Children.Add(Scroll(alarmList));display.Children.Add(empty);
        Put(alarms,HeaderRow("⚡ 实时告警",ActionButton("▥ 清空",()=>_ = ClearNativeAlertsAsync())),0);Put(alarms,display,1);
        Put(page,Panel(alarms),1);
        var graph=Rows(GridLength.Auto,Star());Put(graph,HeaderRow("📊 通道总览（RF电平）"),0);var plot=new SpectrumPlot{Bars=true,MinHeight=100,RfMin=rules.Number("overview","rfMinDbm"),RfMax=rules.Number("overview","rfMaxDbm")};Put(graph,plot,1);Put(page,Panel(graph),3);
        string? previous=null;
        liveRefresh=()=>{
            var online=ViewChannels.Where(c=>c.Online).ToArray();var receivers=online.DistinctBy(c=>c.DisplayReceiverKey).ToArray();var issues=CurrentIssues();
            numbers[0].Text=live.Snapshot is null?"—":receivers.Length.ToString();numbers[1].Text=live.Snapshot is null?"—":online.Length.ToString();numbers[2].Text=((settings.StartMHz+settings.EndMHz)/2).ToString("0.0",CultureInfo.InvariantCulture);numbers[3].Text=live.Snapshot is null?"—":issues.Count.ToString();
            notes[0].Text=string.Join(" · ",receivers.GroupBy(c=>string.IsNullOrWhiteSpace(c.Brand)?"未知品牌":c.Brand,StringComparer.OrdinalIgnoreCase)
                .OrderBy(g=>g.Key.Equals("DATYaudio",StringComparison.OrdinalIgnoreCase)?0:1).ThenBy(g=>g.Key,StringComparer.OrdinalIgnoreCase).Select(g=>$"{g.Key} ×{g.Count()}"));
            notes[1].Text="已分配频率 / 无冲突";var range=PlanningDisplayRange();notes[2].Text=$"规划范围 {range?.Start??settings.StartMHz:0.000}–{range?.End??settings.EndMHz:0.000} MHz";notes[3].Text=issues.Count==0?"无告警":string.Join(" · ",issues.GroupBy(i=>i.Metric).Select(g=>$"{g.Count()} {rules.AlertLabel(g.Key)}"));
            // Do not imply a verified collision-free plan from a live count alone.
            notes[1].Text=online.Length==0?"等待在线通道":$"{online.Count(c=>c.FrequencyKHz.HasValue)} 个通道已上报频率";
            var signature=string.Join("|",issues.Select(i=>i.Key+":"+i.Message));if(signature!=previous){previous=signature;alarmList.Children.Clear();foreach(var issue in issues){var row=Columns(GridLength.Auto,Star());At(row,Text(issue.Level=="crit"?"🔴":"🟡",16,margin:new(0,0,10,0)));var body=new StackPanel();body.Children.Add(Text(issue.Message,12));body.Children.Add(Text(issue.ChannelId+" · "+issueTimes[issue.Key].ToString("yyyy/M/d HH:mm:ss"),11,"#4a5578",new(0,2,0,0)));At(row,body,0,1);alarmList.Children.Add(new Border{Background=B(issue.Level=="crit"?"#261724":"#252018"),BorderBrush=B(issue.Level=="crit"?"#f43f5e":"#f59e0b"),BorderThickness=new(3,0,0,0),CornerRadius=new(6),Padding=new(12,10,12,10),Margin=new(0,0,0,8),Child=row});}}
            empty.Visibility=issues.Count==0?Visibility.Visible:Visibility.Collapsed;empty.ToolTip=live.Connected?null:"服务器未连接；未将断线当作故障恢复";
            plot.StartMHz=settings.StartMHz;plot.EndMHz=settings.EndMHz;plot.Channels=ViewChannels.Select(c=>c with{RfDbm=TransmitterReception.CardRf(c,rules)}).ToArray();plot.InvalidateVisual();
        };return page;
    }

    private UIElement Channels()
    {
        if(monitoringRules is not {} rules)return Empty("等待服务器数据库显示规则…");
        var page=Rows(GridLength.Auto,Star(),GridLength.Auto);var title=Heading("📡 设备通道总览（0通道）");
        var brands=Select(InstalledBrandNames(),minWidth:110);brands.SelectedItem=brandFilter;if(brands.SelectedIndex<0)brands.SelectedIndex=0;
        var status=Select(["全部状态","在线","警告","离线"],System.Array.IndexOf(new[]{"全部状态","在线","警告","离线"},statusFilter));var sort=Select(["按编组排序","按RF强度","按电池","按频率"],System.Array.IndexOf(new[]{"按编组排序","按RF强度","按电池","按频率"},channelSort));
        var header=Columns(Star(),GridLength.Auto);At(header,title);At(header,Horizontal(brands,status,sort),0,1);header.Margin=new(0,0,0,14);Put(page,header,0);
        var columns=Math.Min(10,rules.PageSize);var cards=new UniformGrid{Columns=columns,Rows=(rules.PageSize+columns-1)/columns};
        var cardArea=new Grid{ClipToBounds=true};cardArea.Children.Add(cards);Put(page,cardArea,1);
        var emptyCards=Text("",13,"#7c8db5");emptyCards.HorizontalAlignment=HorizontalAlignment.Center;emptyCards.Visibility=Visibility.Collapsed;cardArea.Children.Add(emptyCards);
        var info=Text("",11,"#7c8db5");int totalPages=1;
        var first=ActionButton("首页",()=>{channelPage=1;liveRefresh?.Invoke();});var prev=ActionButton("上一页",()=>{channelPage--;liveRefresh?.Invoke();});var next=ActionButton("下一页",()=>{channelPage++;liveRefresh?.Invoke();});var last=ActionButton("末页",()=>{channelPage=totalPages;liveRefresh?.Invoke();});
        var pager=Columns(Star(),GridLength.Auto);pager.Margin=new(0,8,0,0);At(pager,info);At(pager,Horizontal(first,prev,next,last),0,1);Put(page,pager,2);
        string? rendered=null;var bindings=new Dictionary<string,Action<Channel>>();
        liveRefresh=()=>{
            var all=ViewChannels.Where(c=>(brandFilter=="全部品牌" || c.Brand==brandFilter) && (statusFilter switch {"在线"=>c.Online&&!TransmitterReception.IsOffline(c,rules)&&!LiveIssues.Evaluate(c,thresholds,rules).Any(),"警告"=>c.Online&&!TransmitterReception.IsOffline(c,rules)&&LiveIssues.Evaluate(c,thresholds,rules).Any(),"离线"=>!c.Online||TransmitterReception.IsOffline(c,rules),_=>true}));
            var ordered=all.OrderBy(c=>c.ActualGroupNumber??long.MaxValue).ThenBy(c=>channelSort switch {"按RF强度"=>-(c.RfDbm??-999),"按电池"=>-(c.Battery??-999),"按频率"=>c.FrequencyKHz??int.MaxValue,_=>c.Number??int.MaxValue}).ToArray();
            totalPages=Math.Max(1,(ordered.Length+rules.PageSize-1)/rules.PageSize);channelPage=Math.Clamp(channelPage,1,totalPages);var shown=ordered.Skip((channelPage-1)*rules.PageSize).Take(rules.PageSize).ToArray();
            var signature=string.Join("|",shown.Select(c=>c.Id));if(signature!=rendered){rendered=signature;bindings.Clear();cards.Children.Clear();foreach(var c in shown){var (view,update)=ChannelCard();view.Tag=c.Id;view.Width=230;view.Height=228;view.Margin=new(0);
                cards.Children.Add(new Viewbox{Child=view,Stretch=Stretch.Uniform,StretchDirection=StretchDirection.DownOnly,HorizontalAlignment=HorizontalAlignment.Left,VerticalAlignment=VerticalAlignment.Top,Margin=new(0,0,6,6)});bindings[c.Id]=update;}}
            foreach(var c in shown)bindings[c.Id](c);
            emptyCards.Visibility=shown.Length==0?Visibility.Visible:Visibility.Collapsed;emptyCards.Text=live.Connected?"没有符合条件的通道":"等待接收机连接…";
            SetHeadingText(title,$"📡 设备通道总览（{ViewChannels.Count}通道）");info.Text=$"第 {channelPage} / {totalPages} 页 · 共 {ordered.Length} 通道 · 每页 {rules.PageSize} 张通道卡";first.IsEnabled=prev.IsEnabled=channelPage>1;next.IsEnabled=last.IsEnabled=channelPage<totalPages;
        };
        void Filter(){brandFilter=brands.SelectedItem?.ToString()??"全部品牌";statusFilter=status.SelectedItem?.ToString()??"全部状态";channelSort=sort.SelectedItem?.ToString()??"按编组排序";channelPage=1;liveRefresh?.Invoke();}
        brands.SelectionChanged+=(_,_)=>Filter();status.SelectionChanged+=(_,_)=>Filter();sort.SelectionChanged+=(_,_)=>Filter();return page;
    }
    private (Border View,Action<Channel> Update) ChannelCard()
    {
        var rules=monitoringRules??throw new InvalidOperationException("数据库显示规则尚未读取");
        var body=new StackPanel();var top=Columns(Star(),GridLength.Auto);var model=Text("",13);model.FontWeight=FontWeights.SemiBold;var brand=Text("",10);At(top,model);var badge=new Border{Child=brand,CornerRadius=new(3),Padding=new(5,2,5,2),Margin=new(8,0,0,0)};At(top,badge,0,1);body.Children.Add(top);
        var ip=Text("",11,"#4a5578",new(0,6,0,0));ip.FontFamily=new FontFamily("Consolas");body.Children.Add(ip);
        var meta=Columns(GridLength.Auto,Star(),GridLength.Auto);meta.Height=22;meta.Margin=new(0,6,0,6);var ch=Text("",12,"#7c8db5");ch.TextWrapping=TextWrapping.NoWrap;At(meta,ch);var transmitter=Text("",12,"#7c8db5",new(4,0,4,0));transmitter.TextAlignment=TextAlignment.Right;transmitter.TextWrapping=TextWrapping.NoWrap;transmitter.TextTrimming=TextTrimming.CharacterEllipsis;At(meta,transmitter,0,1);
        var transmitterTipText=Text("",12);transmitterTipText.MaxWidth=360;transmitterTipText.TextAlignment=TextAlignment.Left;
        var transmitterTip=new ToolTip{Content=transmitterTipText,Background=B("#171c2b"),Foreground=B("#e2e8f0"),BorderBrush=B("#313b55"),BorderThickness=new(1),Padding=new(12,9,12,9),Placement=PlacementMode.Mouse,FontSize=12};
        transmitter.ToolTip=transmitterTip;ToolTipService.SetInitialShowDelay(transmitter,350);ToolTipService.SetShowDuration(transmitter,60000);
        var mutedBadge=new Border{Child=Text(rules.Text("identity","mutedText"),10,"#fb7185"),CornerRadius=new(4),BorderBrush=B("#713147"),BorderThickness=new(1),Background=B("#311b2a"),Padding=new(3,1,3,1),VerticalAlignment=VerticalAlignment.Center};At(meta,mutedBadge,0,2);body.Children.Add(meta);
        var frequencyRow=Columns(GridLength.Auto,Star());var frequency=Text("",18,"#22d3ee");frequency.FontFamily=new FontFamily("Consolas");frequency.FontWeight=FontWeights.Bold;var usage=Text("",18,"#22d3ee",new(8,0,0,0));usage.TextAlignment=TextAlignment.Right;usage.TextTrimming=TextTrimming.CharacterEllipsis;usage.TextWrapping=TextWrapping.NoWrap;usage.FontWeight=FontWeights.Bold;At(frequencyRow,frequency);At(frequencyRow,usage,0,1);body.Children.Add(frequencyRow);
        var rf=MeterRow(body,"RF",rules.Number("signals","rfMinDbm"),rules.Number("signals","rfMaxDbm"),hideWhenUnknown:true);var af=MeterRow(body,"AF",0,100);var battery=MeterRow(body,"🔋",0,100);
        Channel? current=null;var footer=Columns(Star(),GridLength.Auto);footer.Margin=new(0,13,0,0);var online=Text("",11);At(footer,online);var mute=ActionButton(rules.Text("identity","muteActionText"),()=>{if(current is not null)_=ToggleMuteAsync(current);});mute.Padding=new(6,3,6,3);mute.Height=26;mute.Width=112;mute.Margin=new(0,0,4,0);mute.FontSize=11;var tune=ActionButton("📡",()=>{if(current is not null)ShowFrequencyDialog(current);});tune.Padding=new(6,3,6,3);tune.Margin=new(0);At(footer,Horizontal(mute,tune),0,1);body.Children.Add(footer);
        var card=Panel(body,10,new(0,0,10,10));card.CornerRadius=new(6);card.MinHeight=222;card.Child=null;var statusLine=new Border{BorderThickness=new(2,0,0,0),CornerRadius=new(5),Padding=new(8,9,9,9),Child=body};card.Padding=new(0);card.Child=statusLine;
        return(card,c=>{current=c;var issues=LiveIssues.Evaluate(c,thresholds,rules);var transmitterOffline=TransmitterReception.IsOffline(c,rules);var color=!c.Online||transmitterOffline?"#4a5578":issues.Count>0?"#f59e0b":"#10b981";model.Text=c.Brand+" "+c.Model;brand.Text=c.Brand;badge.Background=B(c.Brand=="Shure"?"#242442":"#142b27");brand.Foreground=B(c.Brand=="Shure"?"#a5b4fc":"#6ee7b7");online.Text="● "+(!c.Online||transmitterOffline?rules.Text("identity","offlineText"):issues.Count>0?rules.Text("identity","warningText"):rules.Text("identity","onlineText"));online.ToolTip=transmitterOffline?"话筒离线；接收机网络连接仍在线":null;online.Foreground=B(color);ip.Text=rules.Text("identity","receiverPrefix")+c.Ip;ch.Text=rules.Identity(c);var transmitterDisplay=TransmitterDisplay.For(c,rules);transmitter.Text=transmitterDisplay.Label;transmitterTipText.Text=transmitterDisplay.Tooltip;frequency.Text=rules.Format(c.FrequencyKHz/1000d,"frequency","decimals","unit");usage.Text=Usage(c);usage.ToolTip=string.IsNullOrWhiteSpace(usage.Text)?null:usage.Text;
            var s=c.Raw.Field("shure");bool visuallyMuted=DisplayRules.IsShure(c.Raw)?(DisplayRules.Fresh(c.Raw,"muted")&&s.Field("receiver_muted").True())||(!transmitterOffline&&DisplayRules.Fresh(c.Raw,"transmitter_muted")&&s.Field("transmitter_muted").True()):c.Muted==true;mutedBadge.Visibility=visuallyMuted?Visibility.Visible:Visibility.Collapsed;card.Opacity=visuallyMuted?.6:1;statusLine.BorderBrush=B(color);card.BorderBrush=B("#242c42");card.BorderThickness=new(1);var issueTip=string.Join("；",issues.Select(i=>i.Message).Where(message=>!string.IsNullOrWhiteSpace(message)));card.ToolTip=string.IsNullOrWhiteSpace(issueTip)?null:issueTip;
            mute.Content=commandsBusy.Contains(c.Id)?rules.Text("identity","commandPendingText"):c.Muted switch{true=>rules.Text("identity","unmuteActionText"),false=>rules.Text("identity","muteActionText"),_=>rules.Text("identity","muteUnknownText")};mute.IsEnabled=CanMute(c);mute.Foreground=B(c.Muted==true?"#6ee7b7":"#fbbf24");mute.ToolTip=c.Brand=="Shure"?"接收机输出静音 · 下发后回读确认":"接收机输出静音 · 真实执行回执";tune.IsEnabled=c.Online&&c.Raw.Field("capabilities").Field("write_frequency").True();
            var cardRf=TransmitterReception.CardRf(c,rules);rf(cardRf,rules.Format(cardRf,"signals","rfDecimals","rfUnit"));var floor=rules.AfFloor(c);var cardAf=transmitterOffline?null:c.AfDbfs;af(cardAf is double audio&&floor is double f?(audio-f)/-f*100:null,rules.Format(cardAf,"signals","afDecimals","afUnit"));battery(transmitterOffline?null:c.Battery??(DisplayRules.Fresh(c.Raw,"battery_bars")?s.Number("battery_bars")*20:null),transmitterOffline?rules.Text("signals","unknownText"):rules.Battery(c));
        });
    }

    private Action<double?,string> MeterRow(StackPanel stack,string name,double min,double max,bool hideWhenUnknown=false) {
        var row=Columns(new(22),Star(),new(76));row.Margin=new(0,7,0,0);At(row,Text(name,11,"#7c8db5"));var meter=new ProgressBar{Minimum=min,Maximum=max,Height=4,BorderThickness=new(0),Background=B("#242c42"),Foreground=B(name=="AF"?"#22d3ee":"#10b981"),VerticalAlignment=VerticalAlignment.Center};At(row,meter,0,1);var value=Text("—",11,"#7c8db5");value.TextAlignment=TextAlignment.Right;At(row,value,0,2);stack.Children.Add(row);return(v,label)=>{meter.Visibility=hideWhenUnknown&&!v.HasValue?Visibility.Hidden:Visibility.Visible;meter.Value=v.HasValue?Math.Clamp(v.Value,min,max):min;value.Text=label;var warn=name=="RF"?v<=thresholds.Rf:name=="AF"?double.TryParse(label.Split(' ')[0],System.Globalization.CultureInfo.InvariantCulture,out var af)&&af>=thresholds.Af:v<=thresholds.Battery;meter.Foreground=B(warn?(name=="AF"?"#f43f5e":"#f59e0b"):name=="AF"?"#22d3ee":"#10b981");};
    }

    private UIElement Spectrum()
    {
        var card=Rows(GridLength.Auto,GridLength.Auto,Star());var plot=new SpectrumPlot{MinHeight=180};
        var recordSelector=ScanRecordSelector();
        Put(card,SpectrumToolbar(recordSelector),0);
        Put(card,SpectrumThresholdControls(),1);Put(card,plot,2);
        liveRefresh=()=>{
            var channels=ViewChannels;
            plot.Channels=channels;plot.MonitoringRules=monitoringRules;plot.Points=scan?.Points??[];plot.PointSegments=scan?.TraceSegments;plot.ScanSourceLabel=scan is null?"文件扫描":scan.SourceLabel+(scan.RecordLabel is null?"":" · "+scan.RecordLabel);
            plot.StartMHz=settings.StartMHz;plot.EndMHz=settings.EndMHz;
            plot.SampleStepKHz=scan?.SampleStepKHz;
            plot.ScanPeakThresholdDbm=ScanPeakThresholdDbm;plot.ScanExclusionThresholdDbm=ScanExclusionThresholdDbm;
            plot.InvalidateVisual();
            RefreshScanRecordSelector(recordSelector);
            spectrumToolbarRefresh?.Invoke();
        };scanRefresh=liveRefresh;return Panel(card);
    }
    private void FitRange()
    {
        if(SpectrumPresentation.Fit(ViewChannels) is not { } range){Message("没有可适配的在线设备频点",true);return;}
        settings=settings with{StartMHz=range.Start,EndMHz=range.End};liveRefresh?.Invoke();
    }
}
