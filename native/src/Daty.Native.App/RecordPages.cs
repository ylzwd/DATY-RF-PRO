using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private sealed record HistoryRecord(string Time,string Name,string Channels,string Algorithm,string Constraints,string Imd,JsonElement Resource);
    private sealed record AlarmRecord(string Time,string Level,string Device,string Event,string State,JsonElement Resource);

    private async Task<JsonElement[]> ReadAllResourcesAsync(string kind,string? project=null)
    {
        var all=new List<JsonElement>();string? cursor=null;var seen=new HashSet<string>();var epoch=generation;
        do
        {
            var body=new Dictionary<string,object?>{{"kind",kind},{"limit",100}};
            if(cursor is not null)body["cursor"]=cursor;if(project is not null)body["project_id"]=project;
            var reply=await ReadRpcAsync("database.resources.list",body);
            if(epoch!=generation)throw new OperationCanceledException();
            foreach(var item in Array(reply,"resources"))if(!item.Field("deleted").True())all.Add(item);
            cursor=reply.Text("next_cursor");
            if(cursor is not null&&!seen.Add(cursor))throw new InvalidDataException("服务器目录游标重复");
            if(all.Count>100000)throw new InvalidDataException("记录超过单次视图上限，请按服务器资料分批导出");
        }while(cursor is not null);
        return all.ToArray();
    }

    private UIElement RecordHistory(bool alarms)
    {
        var root=Rows(GridLength.Auto,GridLength.Auto,Star(),GridLength.Auto);
        var heading=Text(alarms?"服务器告警（待读取）":"当前项目：默认项目",12,"#7c8db5");
        var refresh=ActionButton("刷新",()=>{});var actions=new WrapPanel();actions.Children.Add(refresh);
        var save=ActionButton("💾 立即保存",()=>_=FlushNativeAlertsAsync(),"PrimaryButton");
        var remove=ActionButton("🗑️ 移除归档告警",()=>{},"DangerButton");var clear=ActionButton("🧹 清空显示",()=>{});
        if(alarms){actions.Children.Add(save);actions.Children.Add(remove);actions.Children.Add(clear);}
        var title=Columns(Star(),GridLength.Auto);At(title,heading);At(title,actions,0,1);Put(root,title,0);
        var search=Input("",210);search.ToolTip=alarms?"设备、IP 或事件":"规划名称、算法或时间";
        var type=Select(alarms?["全部告警","RF 弱信号","AF 过载","电池低电量","其他历史记录"]:["全部记录","当前记录","有 IMD 冲突"]);
        var level=Select(["全部级别","严重","警告","信息"]);var state=Select(["全部状态","触发中","已结束"]);
        var fields=new List<UIElement>{FilterField("搜索",search),FilterField(alarms?"类型":"记录",type)};if(alarms){fields.Add(FilterField("级别",level));fields.Add(FilterField("状态",state));}var filterArea=new StackPanel{Margin=new(0,12,0,0)};filterArea.Children.Add(FilterBar(fields.ToArray()));var lifecycle=Text("等待读取已归档事件",11,"#7c8db5",new(0,0,0,10));if(alarms)filterArea.Children.Add(lifecycle);Put(root,filterArea,1);
        var table=alarms?Table(("首次发生","Time",155),("级别","Level",65),("设备","Device",170),("事件","Event",0),("状态 / 结束时间","State",190)):
            Table(("时间","Time",155),("规划名称","Name",0),("通道数","Channels",65),("算法","Algorithm",105),("规划约束","Constraints",140),("IMD 结果","Imd",105));
        AddActionColumn(table,"操作","详情",row=>{if(alarms)ShowAlertRecordDetail(((AlarmRecord)row).Resource);else _=OpenCatalogDetailAsync(((HistoryRecord)row).Resource);});
        if(!alarms){AddActionColumn(table,"恢复","恢复约束",row=>RestoreHistory(((HistoryRecord)row).Resource));AddActionColumn(table,"删除","删除",async row=>{if(await RemovePlanningRecordAsync(((HistoryRecord)row).Resource))ShowPage("data");});}
        Put(root,TableSurface(table,"当前筛选范围没有记录；可调整类型、时间或目标筛选。"),2);var prev=ActionButton("上一页",()=>{});var next=ActionButton("下一页",()=>{});var info=Text("等待读取已保存记录",11,"#7c8db5");var footer=Horizontal(prev,info,next);footer.HorizontalAlignment=HorizontalAlignment.Center;footer.Margin=new(0,10,0,0);Put(root,footer,3);
        JsonElement[] records=[];string? currentId=null;int page=0,ticket=0;
        void Render()
        {
            IEnumerable<JsonElement> query=records;var q=search.Text.Trim();
            if(q.Length>0)query=query.Where(r=>r.Field("value").GetRawText().Contains(q,StringComparison.OrdinalIgnoreCase));
            if(alarms)
            {
                if(type.SelectedIndex>0)query=query.Where(r=>{var metric=r.Field("value").Text("metric");return type.SelectedIndex switch{1=>metric=="rf",2=>metric=="af",3=>metric is "battery" or "battery_bars",_=>metric is not ("rf" or "af" or "battery" or "battery_bars")};});
                if(level.SelectedIndex>0)query=query.Where(r=>r.Field("value").Text("level")==new[]{"","crit","warn","info"}[level.SelectedIndex]);
                if(state.SelectedIndex>0)query=query.Where(r=>r.Field("value").Text("archiveState")==new[]{"","active","ended"}[state.SelectedIndex]);
            }
            else if(type.SelectedIndex==1)query=query.Where(r=>r.Text("id")==currentId);
            else if(type.SelectedIndex==2)query=query.Where(r=>Array(r.Field("value").Field("coordination").Field("analysis"),"conflicts").Length>0);
            lifecycle.Text=$"已归档 {records.Length} 个事件 · 归档中触发中 {records.Count(r=>r.Field("value").Text("archiveState")=="active")} · 已结束 {records.Count(r=>r.Field("value").Text("archiveState")=="ended")}；实时状态请查看设备概览。";
            var values=query.OrderByDescending(r=>r.Field("value").Number(alarms?"firstSeen":"timestamp")??0).ToArray();var pages=Math.Max(1,(values.Length+19)/20);page=Math.Clamp(page,0,pages-1);
            var visible=values.Skip(page*20).Take(20);
            if(alarms)table.ItemsSource=visible.Select(r=>{var v=r.Field("value");return new AlarmRecord(Wire.LocalTime((v.Number("firstSeen")??v.Number("ts"))/1000),v.Text("level") switch{"crit"=>"严重","warn"=>"警告","info"=>"信息",_=>"未知"},(v.Text("receiverBrand")??"")+" "+(v.Text("receiverIP")??v.Text("deviceId")),v.Text("msg")??"—",v.Text("archiveState")=="ended"?"已结束 · "+Wire.LocalTime(v.Number("endedAt")/1000):"触发中",r);}).ToArray();
            else table.ItemsSource=visible.Select(r=>{var v=r.Field("value");var options=v.Field("options");var analysis=v.Field("coordination").Field("analysis");return new HistoryRecord(Wire.LocalTime(v.Number("timestamp")/1000),v.Text("name")??v.Text("id")??"—",v.Text("channels")??"—",v.Text("algorithm")??"全局规划",$"锁定 {Array(options,"lockedAssignments").Length} · 排除 {Array(options,"excludedRanges").Length} · 备用 {options.Text("backupCount")??"0"}",Wire.Format(analysis.Number("minImdMarginKHz"),"0"," kHz"),r);}).ToArray();
            heading.Text=alarms?$"💾 服务器告警（{records.Length} 条） · 每 30 秒自动保存 · 待存 {alertMonitor.PendingArchives.Count} 条":"当前项目：默认项目";
            info.Text=$"第 {page+1} / {pages} 页 · 筛选 {values.Length} / {records.Length} 条";prev.IsEnabled=page>0;next.IsEnabled=page+1<pages;
        }
        async Task Load()
        {
            var own=++ticket;refresh.IsEnabled=false;heading.Text="正在读取服务器记录…";
            try{var items=await ReadAllResourcesAsync(alarms?"alerts":"planning_records",alarms?null:"default");if(own!=ticket)return;records=items;if(!alarms){try{currentId=(await ReadRpcAsync("database.resources.get",new{kind="planning_current",id="default"})).Field("resource").Field("value").Text("currentRecordId");}catch(R19RpcException e)when(e.Code=="RESOURCE_NOT_FOUND"){} }page=0;Render();}
            catch(Exception e){heading.Text="读取失败："+SafeError(e);}finally{refresh.IsEnabled=true;}
        }
        refresh.Click+=(_,_)=>_=Load();prev.Click+=(_,_)=>{page--;Render();};next.Click+=(_,_)=>{page++;Render();};search.TextChanged+=(_,_)=>{page=0;Render();};foreach(var select in new[]{type,level,state})select.SelectionChanged+=(_,_)=>{page=0;Render();};clear.Click+=(_,_)=>{ticket++;records=[];Render();};
        remove.Click+=async(_,_)=>{if(records.Length==0)return;var selected=records.ToArray();if(!Confirm("移除归档告警",$"移除当前已读取的 {selected.Length} 条服务器归档告警。保留实时告警、待存事件和历史审计版本。","确认移除",true,note:"这会修改服务器告警记录；不会删除设备数据或数据库文件。"))return;remove.IsEnabled=false;try{foreach(var batch in selected.Chunk(100)){var writes=batch.Select(r=>new{kind="alerts",id=r.Text("id"),expected_revision=(int)r.Number("revision")!,deleted=true,value=(object?)null}).ToArray();await WriteBusinessAsync("database.batch",new(){{"writes",writes}});}await Load();}catch(Exception e){Message("移除未完整确认："+SafeError(e),true);}finally{remove.IsEnabled=true;}};
        root.Loaded+=(_,_)=>{if(!verification||verificationRead is not null)_=Load();};Render();return root;
    }

    private void RestoreHistory(JsonElement resource)
    {
        var value=resource.Field("value");if(!Confirm("恢复历史约束","恢复此记录的规划输入到当前编辑区；下发前重新计算并校验当前接收机。","恢复约束"))return;
        var fields=value.Field("constraintFields");if(fields.ValueKind==JsonValueKind.Object)ApplyDraftFields(fields);
        else
        {
            var options=value.Field("options");planRange="custom";planStart=Wire.Format(options.Number("rangeStartKHz")/1000,"0.000");planEnd=Wire.Format(options.Number("rangeEndKHz")/1000,"0.000");compatibility=options.Text("compatibilityLevel")??"standard";
            backupCount=(int)(options.Number("backupCount")??0);excludedText=string.Join("\n",Array(options,"excludedRanges").Select(r=>$"{r.Number("startKHz")/1000:0.000}-{r.Number("endKHz")/1000:0.000} {r.Text("reason")}"));occupiedText=string.Join("\n",Array(options,"knownCarriers").Select(r=>$"{r.Number("frequencyKHz")/1000:0.000},{r.Text("guardKHz")},{r.Text("reason")}"));foreach(var key in new[]{"stepKHz","minChannelSpacingKHz","minImdSpacingKHz","scanThresholdDbm"})safety[key]=options.Text(key)??(key=="stepKHz"?"25":"");safety["imdOrders"]=Array(options,"imdOrders").Any(o=>o.Number()==5)?"third-fifth":"third";plannerImdProducts=PlanningIntermodulation.FromOptions(options);locks.Clear();foreach(var item in Array(options,"lockedAssignments"))if(item.Text("deviceId") is string id&&item.Number("frequencyKHz") is double f)locks[id]=((int)f,item.Text("reason")??"");
        }
        InvalidatePlan();ShowPage("planner");
    }

    private void ApplyDraftFields(JsonElement fields)
    {
        backupInputValid=true;planRange=fields.Text("plannerRange")??planRange;planStart=fields.Text("plannerRangeStart")??planStart;planEnd=fields.Text("plannerRangeEnd")??planEnd;compatibility=fields.Text("plannerCompatibility")??compatibility;
        excludedText=fields.Text("plannerExcludedRanges")??"";occupiedText=fields.Text("plannerKnownCarriers")??"";if(int.TryParse(fields.Text("plannerBackupCount"),out var count))backupCount=Math.Clamp(count,0,4);
        foreach(var (key,field) in new[]{("stepKHz","plannerStepKHz"),("minChannelSpacingKHz","plannerMinSpacingKHz"),("minImdSpacingKHz","plannerImdSpacingKHz"),("scanThresholdDbm","plannerScanThresholdDbm"),("imdOrders","plannerImdPolicy")})if(fields.Text(field) is string text)safety[key]=text;
        plannerImdProducts=PlanningIntermodulation.Read(fields.Text("plannerImdProducts"),safety["imdOrders"]);
        locks.Clear();RestoreLocks(fields.Text("plannerLockedAssignments")??"");
    }
}
