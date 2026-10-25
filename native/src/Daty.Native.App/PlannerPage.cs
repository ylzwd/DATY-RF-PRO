using System.IO;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private string plannerTab="basic",planRange="614250:638000",planStart="614.250",planEnd="638.000",compatibility="standard",excludedText="",occupiedText="";
    private string[] plannerImdProducts=["2T3O","3T3O"];
    private int backupCount=1, plannerPage=1;private bool planning,backupInputValid=true;
    private readonly Dictionary<string,string> manualPlanned=[];
    private readonly Dictionary<string,(int Frequency,string Note)> locks=[];
    private readonly Dictionary<string,string> safety=new(){["stepKHz"]="25",["minChannelSpacingKHz"]="",["minImdSpacingKHz"]="",["scanThresholdDbm"]="",["imdOrders"]="third"};
    private JsonElement? planResult;private JsonElement customProfiles=JsonSerializer.SerializeToElement(System.Array.Empty<object>());
    private UIElement Planner()
    {
        var page=Rows(GridLength.Auto,Star());var top=Columns(Star(3),Star(2));
        var controls=Rows(GridLength.Auto,GridLength.Auto,Star(),GridLength.Auto);Put(controls,HeaderRow("🧮 频率规划控制"),0);
        var saved=Text("",10,"#7c8db5");saved.TextWrapping=TextWrapping.NoWrap;saved.TextTrimming=TextTrimming.CharacterEllipsis;
        System.Windows.Automation.AutomationProperties.SetAutomationId(saved,"PlannerSaveStatus");
        var saveRow=new Grid{MinHeight=26};saveRow.Children.Add(saved);Put(controls,saveRow,1);
        planningEditor=(FrameworkElement)Segmented([("basic","基本设置"),("constraints","规划约束")],plannerTab,key=>{plannerTab=key;PlannerEdited(false);ShowPage("planner");},PlannerEditorContent());planningEditor.IsEnabled=planningSettingsReady||verification;Put(controls,planningEditor,2);
        planningStatusRefresh=()=>{
            saved.Inlines.Clear();var attention=(PlanningUnconfirmed||!planningSettingsReady)&&!planningSettingsStatus.StartsWith("正在");
            var conflict=planningSettingsStatus.Contains("RESOURCE_REVISION_CONFLICT");
            var label=conflict?"未保存：其他窗口已更新规划设置":planningSettingsStatus;
            if(attention){var link=new Hyperlink(new Run(label+(planningSettingsReady?" · 点击核对并保存":" · 点击重新读取"))){Foreground=B("#fbbf24"),TextDecorations=null};link.Click+=(_,_)=>_=RetryPlanningSettingsAsync();saved.Inlines.Add(link);}
            else saved.Inlines.Add(new Run(label));
            saved.ToolTip=attention?(conflict?"其他窗口已修改数据库。点击后保留本窗口输入，按最新修订重新提交；收到真实回执后才显示已保存。":planningSettingsStatus+"。点击后先核对待确认操作；结果未知时不会重复发送。"):null;
        };planningStatusRefresh();
        var run=ActionButton(planning?"正在计算…":"⚡ 一键全局规划（跨品牌 IMD）",()=>_=RunPlanAsync(),"PrimaryButton");run.IsEnabled=!planning&&(planningSettingsReady||verification);run.HorizontalAlignment=HorizontalAlignment.Stretch;run.HorizontalContentAlignment=HorizontalAlignment.Center;run.Margin=new(0,8,0,0);Put(controls,run,3);var controlCard=Panel(controls,12,new(0,0,5,0));At(top,controlCard);
        var result=Rows(GridLength.Auto,Star());Put(result,HeaderRow("📋 规划结果摘要",ActionButton("详情 / 限制",ShowPlanDetails),ActionButton("导出报告",()=>_=ExportPlanningFileAsync("html"))),0);var summary=new StackPanel();Put(result,Scroll(summary),1);var summaryCard=Panel(result,12,new(5,0,0,0));
        // The complete editor determines the shared row height; long result
        // details scroll within the matching summary instead of growing the row.
        summaryCard.SetBinding(FrameworkElement.HeightProperty,new System.Windows.Data.Binding(nameof(FrameworkElement.ActualHeight)){Source=controlCard,Mode=System.Windows.Data.BindingMode.OneWay});
        At(top,summaryCard,0,1);Put(page,top,0);
        var lower=Rows(GridLength.Auto,Star(),GridLength.Auto);var allocationHeader=HeaderRow("📋 频率分配表（GROUP 升序）",ActionButton("📤 全部下发",()=>_=DeployPlanAsync(),"SuccessButton"),ActionButton("⬇ 导出方案",()=>_=ExportPlanningFileAsync("csv")));allocationHeader.Margin=new(0,0,0,8);Put(lower,allocationHeader,0);
        var table=Table(("编组","Group",68),("通道","Channel",60),("使用分类","Name",95),("品牌","Brand",0),("当前频率","Current",93),("锁定频率","Locked",93),("规划频率","Planned",93),("IMD 状态","Imd",70));AddActionColumn(table,"操作","下发",row=>_=DeployPlanAsync(((PlanRow)row).Id));table.MinHeight=70;Put(lower,table,1);var pageInfo=Text("",11,"#7c8db5");int pageCount=1;
        var prev=ActionButton("上一页",()=>{plannerPage--;liveRefresh?.Invoke();});var next=ActionButton("下一页",()=>{plannerPage++;liveRefresh?.Invoke();});
        var pagination=Columns(Star(),GridLength.Auto);At(pagination,pageInfo);At(pagination,Horizontal(prev,next),0,1);pagination.Margin=new(0,4,0,0);Put(lower,pagination,2);
        table.SizeChanged+=(_,_)=>liveRefresh?.Invoke();
        var plannedInput=new FrameworkElementFactory(typeof(TextBox));plannedInput.SetBinding(TextBox.TextProperty,new System.Windows.Data.Binding("Planned"){Mode=System.Windows.Data.BindingMode.OneWay});plannedInput.SetValue(TextBox.PaddingProperty,new Thickness(4,2,4,2));plannedInput.SetValue(FrameworkElement.MarginProperty,new Thickness(4,1,4,1));plannedInput.SetValue(TextBox.MaxLengthProperty,32);plannedInput.SetValue(FrameworkElement.ToolTipProperty,"输入 MHz 频率，点击下发时自动校验范围、栅格、锁定与冲突");plannedInput.AddHandler(TextBox.TextChangedEvent,new TextChangedEventHandler((sender,_)=>{if(sender is TextBox{IsKeyboardFocusWithin:true,DataContext:PlanRow row} box){manualPlanned[row.Id]=box.Text;deploymentRows.Remove(row.Id);deploymentStatus="手动频率待校验 · 点击下发后自动校验";}}));table.Columns[6]=new DataGridTemplateColumn{Header="规划频率",CellTemplate=new DataTemplate{VisualTree=plannedInput},Width=93};Put(page,Panel(lower,12,new(0,10,0,0)),1);
        string? previous=null,rowSignature=null;liveRefresh=()=>{var assignments=planResult is JsonElement r?Array(r,"assignments"):[];var rows=ViewChannels.Select(c=>{var assignment=assignments.FirstOrDefault(a=>a.Text("deviceId")==c.Id);return new PlanRow(c.Id,c.Group,c.ChannelLabel,Usage(c),c.Brand+" "+c.Model,c.Frequency,locks.TryGetValue(c.Id,out var locked)?Wire.Format(locked.Frequency/1000.0,"0.000"):"—",manualPlanned.GetValueOrDefault(c.Id)??(assignment.Number("frequencyKHz") is double assigned?Wire.Format(assigned/1000,"0.000"):c.Frequency),deploymentRows.GetValueOrDefault(c.Id)??(planResult is JsonElement background&&Array(background,"monitoringOnlyChannels").Any(m=>m.Text("deviceId")==c.Id)?"仅监测 · 原频":assignment.ValueKind==JsonValueKind.Object&&planResult is JsonElement check&&Array(check,"errors").Length==0&&Array(check.Field("analysis"),"conflicts").Length==0?"已校核":"—"));}).ToArray();var size=Math.Max(1,(int)Math.Floor((table.ActualHeight-36)/34));pageCount=Math.Max(1,(rows.Length+size-1)/size);plannerPage=Math.Clamp(plannerPage,1,pageCount);
            var shown=rows.Skip((plannerPage-1)*size).Take(size).ToArray();var rowKey=JsonSerializer.Serialize(shown);if(rowKey!=rowSignature&&!table.IsKeyboardFocusWithin){rowSignature=rowKey;table.ItemsSource=shown;}
            pageInfo.Text=$"{deploymentStatus} · 第 {plannerPage} / {pageCount} 页 · {rows.Length} 通道";prev.IsEnabled=plannerPage>1;next.IsEnabled=plannerPage<pageCount;
            var signature=planResult?.GetRawText();if(signature==previous&&summary.Children.Count>0)return;previous=signature;summary.Children.Clear();if(planResult is not JsonElement value){summary.Children.Add(Empty("点击「一键全局规划」生成频率方案"));return;}BuildPlanSummary(summary,value);};return page;
    }
    private sealed record PlanRow(string Id,string Group,string Channel,string Name,string Brand,string Current,string Locked,string Planned,string Imd);
    private UIElement PlannerEditorContent()
    {
        // Hidden keeps the other pane in WPF measurement without displaying it
        // or allowing focus/input. Both tabs reserve the same responsive height.
        var area=new Grid();
        var basic=(FrameworkElement)PlannerBasics();var constraints=(FrameworkElement)PlannerConstraints();
        basic.VerticalAlignment=constraints.VerticalAlignment=VerticalAlignment.Top;
        basic.Visibility=plannerTab=="basic"?Visibility.Visible:Visibility.Hidden;
        constraints.Visibility=plannerTab=="constraints"?Visibility.Visible:Visibility.Hidden;
        area.Children.Add(basic);area.Children.Add(constraints);return area;
    }
    private static FrameworkElement PlannerField(string label,FrameworkElement input,string? hint=null)
    {
        input.HorizontalAlignment=HorizontalAlignment.Stretch;input.VerticalAlignment=VerticalAlignment.Top;
        input.Margin=new(0);input.MinHeight=30;
        if(input is TextBox box){box.VerticalContentAlignment=VerticalAlignment.Center;}
        var field=(FrameworkElement)Labeled(label,input);field.VerticalAlignment=VerticalAlignment.Top;field.Tag="planner-field";
        if(hint is not null){field.ToolTip=hint;ToolTipService.SetShowOnDisabled(field,true);}
        return field;
    }
    private static Grid PlannerPair(UIElement left,UIElement right)
    {
        var row=Columns(Star(),new GridLength(12),Star());At(row,left);At(row,right,0,2);row.Margin=new(0,0,0,10);return row;
    }
    private UIElement PlannerBasics()
    {
        var p=new StackPanel();
        string[] ranges=["614.250–638.000 MHz","470.000–608.000 MHz","640.000–690.000 MHz","自定义起止频率","按导入扫描范围"],keys=["614250:638000","470000:608000","640000:690000","custom","scan"];
        var range=Select(ranges,Math.Max(0,System.Array.IndexOf(keys,planRange)));
        var start=Input(planStart);var end=Input(planEnd);start.MaxLength=end.MaxLength=64;start.MinWidth=end.MinWidth=70;var inputs=Columns(Star(),Star());At(inputs,start);At(inputs,end,0,1);start.Margin=new(0,0,6,0);bool updating=false;
        range.SelectionChanged+=(_,_)=>{if(updating||range.SelectedIndex<0)return;planRange=keys[range.SelectedIndex];updating=true;if(planRange!="custom"&&PlanningDisplayRange() is { } bounds){planStart=start.Text=bounds.Start.ToString("0.000",CultureInfo.InvariantCulture);planEnd=end.Text=bounds.End.ToString("0.000",CultureInfo.InvariantCulture);}updating=false;PlannerEdited();};
        void RangeEdited(){if(updating)return;planStart=start.Text;planEnd=end.Text;planRange="custom";updating=true;range.SelectedIndex=3;updating=false;PlannerEdited();}
        start.TextChanged+=(_,_)=>RangeEdited();end.TextChanged+=(_,_)=>RangeEdited();p.Children.Add(PlannerPair(PlannerField("频率范围",range,"计算时自动扩大到设定范围、在线设备实频、锁频、固定占用和扫描峰的最小至最大频率；实际计算范围在结果摘要显示。"),PlannerField("自定义范围（MHz）",inputs)));
        var target=Select([$"{ViewChannels.Count(c=>c.Online)} 个实际通道"]);target.IsEnabled=false;var targetLabel=PlannerField("本次规划目标（自动统计）",target,"实际在线通道联合参与；仅监测设备作为固定占用保留原频，只有具备品牌调频能力的通道分配新频点。");var level=PlannerIntermodulationChoices();var levelLabel=PlannerField("兼容级别",level,"多选互调规则；T 表示发射源数量，末位表示阶数。各品牌频段、栅格和保护间隔仍独立生效，修改立即保存到数据库。");p.Children.Add(PlannerPair(targetLabel,levelLabel));
        var profile=HeaderRow("📋 Profile / 全局求解",ActionButton("安全参数",ShowSafetySettings),ActionButton("导入 Profile",()=>_=ImportProfileAsync()));profile.Margin=new(0);
        profile.ToolTip="DATYaudio 最小间隔 / 候选步进 250 kHz；多品牌联合 IMD，冲突候选跳过，结果按原品牌＋接收机＋CH 下发。";p.Children.Add(profile);return p;
    }
    private FrameworkElement PlannerIntermodulationChoices()
    {
        var panel=new WrapPanel{Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center};
        foreach(var product in PlanningIntermodulation.Products)
        {
            var check=new CheckBox{Content=PlanningIntermodulation.Display(product),IsChecked=plannerImdProducts.Contains(product),Foreground=B("#e2e8f0"),FontSize=12,Margin=new(0,5,12,5),ToolTip=PlanningIntermodulation.Explanation(product)};
            System.Windows.Automation.AutomationProperties.SetAutomationId(check,"PlannerImd"+product);
            void Changed(){plannerImdProducts=PlanningIntermodulation.Products.Where(p=>p==product?check.IsChecked==true:plannerImdProducts.Contains(p)).ToArray();safety["imdOrders"]=plannerImdProducts.Contains("2T5O")?"third-fifth":"third";PlannerEdited();}
            check.Checked+=(_,_)=>Changed();check.Unchecked+=(_,_)=>Changed();panel.Children.Add(check);
        }
        return new Border{Child=panel,Background=B("#171c2b"),BorderBrush=B("#242c42"),BorderThickness=new(1),CornerRadius=new(6),Padding=new(8,0,0,0)};
    }
    private UIElement PlannerConstraints()
    {
        var p=new StackPanel();
        var candidates=ViewChannels.Where(c=>(c.Online&&c.FrequencyKHz.HasValue)||locks.ContainsKey(c.Id)).Select(c=>(Id:c.Id,Label:$"{c.Group} · {c.ChannelLabel} · {Wire.Format((locks.TryGetValue(c.Id,out var saved)?saved.Frequency:c.FrequencyKHz)/1000d,"0.000")} MHz"+(c.Online?"":" · 离线锁定"),Frequency:locks.TryGetValue(c.Id,out var existing)?existing.Frequency:c.FrequencyKHz??0)).Concat(locks.Where(x=>!ViewChannels.Any(c=>c.Id==x.Key)).Select(x=>(Id:x.Key,Label:$"历史锁定 · {x.Key} · {x.Value.Frequency/1000d:0.000} MHz",Frequency:x.Value.Frequency))).ToArray();
        var choose=Select(new[]{"选择在线 CH / 频点…"}.Concat(candidates.Select(c=>c.Label)).ToArray());var note=Input(plannerLockNote);note.MaxLength=80;note.IsEnabled=false;note.ToolTip="职位 / 属性 / 使用者，如主持人";
        var confirm=ActionButton("确定锁定",()=>{});var remove=ActionButton("取消锁定",()=>{});confirm.IsEnabled=remove.IsEnabled=false;
        var lockHeader=HeaderRow($"锁定频率（{locks.Count} 个）",confirm,remove);lockHeader.Margin=new(0,0,0,10);lockHeader.ToolTip="人工约束即时入库，计算前校验；冲突不自动忽略。";p.Children.Add(lockHeader);
        p.Children.Add(PlannerPair(PlannerField("接收通道",choose,"预选通道后填写使用分类，再点击确定锁定。"),PlannerField("使用分类",note,"职位 / 属性 / 使用者，如主持人；确定锁定后用于通道显示。")));
        choose.SelectedIndex=System.Array.FindIndex(candidates,c=>c.Id==plannerSelectedDevice)+1;note.IsEnabled=confirm.IsEnabled=remove.IsEnabled=choose.SelectedIndex>0;bool choosing=false;
        choose.SelectionChanged+=(_,_)=>{var selected=choose.SelectedIndex>0;plannerSelectedDevice=selected?candidates[choose.SelectedIndex-1].Id:"";note.IsEnabled=confirm.IsEnabled=remove.IsEnabled=selected;plannerLockNote=selected&&locks.TryGetValue(plannerSelectedDevice,out var value)?value.Note:"";choosing=true;note.Text=plannerLockNote;choosing=false;PlannerEdited(false);};
        note.TextChanged+=(_,_)=>{if(choosing)return;plannerLockNote=note.Text;PlannerEdited(false);};
        confirm.Click+=(_,_)=>{if(choose.SelectedIndex<=0)return;var c=candidates[choose.SelectedIndex-1];locks[c.Id]=(c.Frequency,note.Text.Trim());PlannerEdited();ShowPage("planner");};remove.Click+=(_,_)=>{if(choose.SelectedIndex<=0)return;locks.Remove(candidates[choose.SelectedIndex-1].Id);PlannerEdited();ShowPage("planner");};
        var excludes=Input(excludedText);excludes.MaxLength=16384;excludes.AcceptsReturn=true;excludes.Height=30;excludes.VerticalScrollBarVisibility=ScrollBarVisibility.Hidden;var carriers=Input(occupiedText);carriers.MaxLength=16384;carriers.AcceptsReturn=true;carriers.Height=30;carriers.VerticalScrollBarVisibility=ScrollBarVisibility.Hidden;excludes.TextChanged+=(_,_)=>{excludedText=excludes.Text;PlannerEdited();};carriers.TextChanged+=(_,_)=>{occupiedText=carriers.Text;PlannerEdited();};p.Children.Add(PlannerPair(PlannerField("排除区（MHz）",excludes,"每行：起点-终点 原因；含两端，空=不排除。Enter换行，上下方向键或滚轮查看多条。"),PlannerField("固定占用（MHz/kHz）",carriers,"每行：频率,保护kHz,原因；也参与IMD。Enter换行，上下方向键或滚轮查看多条。")));
        var backup=Input(plannerBackupText);backup.MaxLength=64;backup.BorderBrush=B(backupInputValid?"#242c42":"#fb7185");backup.TextChanged+=(_,_)=>{plannerBackupText=backup.Text;backupInputValid=int.TryParse(plannerBackupText,out var value)&&value is >=0 and <=4;if(backupInputValid)backupCount=value;backup.BorderBrush=B(backupInputValid?"#242c42":"#fb7185");PlannerEdited();};var check=ActionButton("校验约束",()=>{try{_=PlanningOptions();Message("输入格式校验通过；保存状态见上方");}catch(Exception e){Message(SafeError(e),true);}});check.HorizontalContentAlignment=HorizontalAlignment.Center;
        var final=PlannerPair(PlannerField("每通道备用频率数",backup,"0～4整数；锁定通道不备选，不足会提示"),PlannerField("约束检查",check,"检查输入格式；不执行规划或向接收机下发。"));final.Margin=new(0);p.Children.Add(final);return p;
    }
    private void InvalidatePlan(){FollowPlanningRange();manualPlanned.Clear();planResult=null;plannedDevices=null;plannedOptions=null;plannedFields=null;deploymentRows.Clear();deploymentStatus="待重新规划 · 输入已变化";}
    private JsonElement PlanningOptions()
    {
        if(planRange=="scan"&&scan is null)throw new InvalidDataException("请先导入当前会话的真实扫描，再按扫描范围计算");
        if(scan is {Points.Count:0})throw new InvalidDataException("当前扫描记录没有有效点，请选择其他记录或清除扫描后重新规划");
        if(!backupInputValid)throw new InvalidDataException("每通道备用频率数必须是 0～4 的整数");
        static int KHz(string text){var value=decimal.Parse(text,CultureInfo.InvariantCulture)*1000;if(value!=decimal.Truncate(value)||value is <30000 or >3000000)throw new InvalidDataException("频率必须为 30～3000 MHz，最多 3 位小数");return (int)value;}
        var bounds=planRange.Split(':');int start,end;if(bounds.Length==2){start=int.Parse(bounds[0]);end=int.Parse(bounds[1]);}else if(planRange=="scan"&&scan is not null){start=scan.Points.Min(p=>p.FrequencyKHz);end=scan.Points.Max(p=>p.FrequencyKHz);}else{start=KHz(planStart);end=KHz(planEnd);}
        if(start>=end)throw new InvalidDataException("规划范围终点必须大于起点");
        var excluded=new List<object>();foreach(var line in excludedText.Split('\n',StringSplitOptions.RemoveEmptyEntries)){var m=Regex.Match(line.Trim(),@"^(\d+(?:\.\d+)?)\s*[-–~～—]\s*(\d+(?:\.\d+)?)(?:\s+(.+))?$");if(!m.Success)throw new InvalidDataException("排除区格式应为：起始MHz-结束MHz 原因");excluded.Add(new{startKHz=KHz(m.Groups[1].Value),endKHz=KHz(m.Groups[2].Value),reason=m.Groups[3].Value});}
        var carriers=new List<object>();foreach(var line in occupiedText.Split('\n',StringSplitOptions.RemoveEmptyEntries)){var parts=line.Split([',','，'],3);if(parts.Length<2)throw new InvalidDataException("固定占用格式应为：频率MHz,保护kHz,原因");carriers.Add(new{frequencyKHz=KHz(parts[0]),guardKHz=int.Parse(parts[1],CultureInfo.InvariantCulture),reason=parts.Length==3?parts[2]:"固定占用"});}
        var values=new Dictionary<string,object?>{{"rangeStartKHz",start},{"rangeEndKHz",end},{"autoExpandRange",true},{"stepKHz",int.Parse(safety["stepKHz"],CultureInfo.InvariantCulture)},{"compatibilityLevel",compatibility},{"frequencyDistribution","spread-range"},{"allocationOrder","receiver-group-ascending"},{"preserveCurrent",true},{"protectCurrentFrequencies",true},{"lockMonitoringOnly",true},{"backupCount",backupCount},{"solver","global"},{"lockedAssignments",locks.Select(p=>new{deviceId=p.Key,frequencyKHz=p.Value.Frequency,reason=p.Value.Note}).ToArray()},{"excludedRanges",excluded},{"knownCarriers",carriers},{"scanPoints",scan?.Points.Select(p=>new{frequencyKHz=p.FrequencyKHz,levelDbm=p.LevelDbm}).ToArray()??[]},{"imdProducts",plannerImdProducts}};if(scan?.SampleStepKHz is int scanStep)values["maxScanGapKHz"]=scanStep;foreach(var field in new[]{"minChannelSpacingKHz","minImdSpacingKHz","scanThresholdDbm"})if(safety[field].Trim().Length>0)values[field]=double.Parse(safety[field],CultureInfo.InvariantCulture);if(scan is {Points.Count:>0})
        {
            if(!spectrumSettingsReady||SpectrumUnconfirmed||spectrumInputInvalid||ScanExclusionThresholdDbm is not double exclusion||ScanPeakThresholdDbm is not double peak)
                throw new InvalidDataException("请先完成频谱阈值的数据库读取与保存");
            values["scanPeakCarriers"]=PlanningScanSources.Extract(scan,peak);
            values["scanThresholdDbm"]=values.TryGetValue("scanThresholdDbm",out var stricter)&&stricter is double manual?Math.Min(manual,exclusion):exclusion;
        }
        return JsonSerializer.SerializeToElement(values);
    }
    private async Task RunPlanAsync(){if(planning)return;planning=true;if(currentPage=="planner")ShowPage("planner");var epoch=generation;try{if(!await SavePlannerDraftAsync())throw new InvalidDataException("请先完成规划设置的数据库保存");var options=PlanningOptions();var channels=ViewChannels.Where(c=>c.Online).ToArray();if(channels.Length==0)throw new InvalidDataException("请先连接接收机");var devices=CoordinationEngine.CalculationDevices(channels);var capturedFields=JsonSerializer.Serialize(DraftFields());var capturedBoot=bridge?.BootId;var result=await Task.Run(()=>CoordinationEngine.Plan(devices,options,customProfiles,connection.Token),connection.Token);if(epoch!=generation)return;if(capturedFields!=JsonSerializer.Serialize(DraftFields())||!JsonElement.DeepEquals(options,PlanningOptions()))throw new InvalidDataException("计算期间规划输入已变化，请重新计算");manualPlanned.Clear();planResult=result;plannedDevices=devices;plannedOptions=options;plannedFields=capturedFields;plannedBoot=capturedBoot;deploymentRows.Clear();deploymentStatus="未下发 · 下发前核对在线身份 / 频段 / 当前频率";Message("规划计算完成，仅用于当前会话；未向接收机下发");}catch(Exception e){Message("规划未完成："+SafeError(e),true);}finally{planning=false;if(currentPage=="planner")ShowPage("planner");}}

}
