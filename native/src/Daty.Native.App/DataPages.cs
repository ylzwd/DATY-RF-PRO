using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private string dataTab="devices",auditTab="alerts";
    internal static readonly (string Key,string Label)[] DataTabs=[("devices","设备与通道"),("config","系统配置")];
    private UIElement Data()=>Segmented(DataTabs,dataTab,key=>{dataTab=key;ShowPage("data");},dataTab switch{"config"=>ConfigDataPage(),_=>DeviceDataPage()});
    private UIElement Intro(string title,string explanation,params (string Label,string Page)[] links)
    {
        var p=new StackPanel();var head=HeaderRow(title,links.Select(l=>(UIElement)ActionButton(l.Label+" ↗",()=>ShowPage(l.Page))).ToArray());((TextBlock)head.Children[0]).FontSize=17;head.Margin=new(0,0,0,6);p.Children.Add(head);var note=Text(explanation,12,"#7c8db5");note.LineHeight=20;p.Children.Add(note);return new Border{Child=p,Margin=new(0,0,0,14)};
    }
    private UIElement DeviceDataPage(){var g=Rows(GridLength.Auto,Star());Put(g,Intro("设备与通道资料","设备概览、通道总览和设备管理共用设备身份；通道名称与手动设备配置集中查询。实时在线状态以接收机当前连接为准。",("设备概览","dashboard"),("通道总览","channels"),("设备管理","devices")),0);Put(g,CatalogView([("device_overrides","通道名称"),("manual_devices","手动设备")]),1);return g;}
    private UIElement ConfigDataPage(){var g=Rows(GridLength.Auto,Star(),GridLength.Auto);Put(g,Intro("系统配置资料","查看服务器已确认保存的告警阈值、声音与推荐开关、视图和频率范围。修改配置请前往对应功能，保存后刷新目录。",("系统设置","settings")),0);Put(g,CatalogView([("settings","告警与推荐设置"),("preferences","视图与频率范围"),("plugins","协议插件资料")]),1);Put(g,Text("阈值与推荐设置为服务器共享；视图偏好按来源标识保存。连接证书、配对密钥由服务器运行配置管理。",11,"#7c8db5",new(0,12,0,0)),2);return g;}
    private sealed record CatalogRow(string Name,string Summary,string Revision,string Saved,JsonElement Item){public string Id=>Item.Text("id")??"";}
    private FrameworkElement CatalogView((string Kind,string Label)[] types)
    {
        var grid=Rows(GridLength.Auto,GridLength.Auto,Star(),GridLength.Auto);grid.MinHeight=210;var type=Select(types.Select(t=>t.Label).ToArray(),minWidth:150);var search=Input("",185);search.ToolTip="本页搜索名称或标识";var refresh=ActionButton("刷新目录",()=>{});var toolbar=FilterBar(FilterField("资料类型",type),FilterField("本页搜索",search),refresh);Put(grid,toolbar,0);
        var status=Text("等待读取服务器目录",11,"#7c8db5",new(0,10,0,10));Put(grid,status,1);var table=Table(("名称 / 标识","Name",0),("内容概要","Summary",0),("版本","Revision",60),("服务器保存时间","Saved",160));AddActionColumn(table,"操作","查看 / 导出",r=>_ = OpenCatalogDetailAsync(((CatalogRow)r).Item));var cell=new FrameworkElementFactory(typeof(StackPanel));cell.SetValue(FrameworkElement.MarginProperty,new Thickness(10,7,10,7));foreach(var(binding,size,color)in new[]{("Name",12d,"#e2e8f0"),("Id",10d,"#7c8db5")}){var field=new FrameworkElementFactory(typeof(TextBlock));field.SetBinding(TextBlock.TextProperty,new System.Windows.Data.Binding(binding));field.SetValue(TextBlock.FontSizeProperty,size);field.SetValue(TextBlock.ForegroundProperty,B(color));field.SetValue(TextBlock.TextTrimmingProperty,TextTrimming.CharacterEllipsis);field.SetValue(FrameworkElement.MarginProperty,new Thickness(0,2,0,0));cell.AppendChild(field);}table.Columns[0]=new DataGridTemplateColumn{Header="名称 / 标识",CellTemplate=new DataTemplate{VisualTree=cell},MinWidth=110};table.RowHeight=54;for(var col=0;col<5;col++)table.Columns[col].Width=new DataGridLength(new[]{27,29,7,21,16}[col],DataGridLengthUnitType.Star);Put(grid,TableSurface(table,"尚无已保存记录，可前往对应功能保存后刷新。"),2);
        var previous=ActionButton("上一页",()=>{});var next=ActionButton("下一页",()=>{});var label=Text("",11,"#7c8db5");var pager=Horizontal(previous,label,next);pager.HorizontalAlignment=HorizontalAlignment.Center;pager.Margin=new(0,10,0,0);Put(grid,pager,3);
        var cursors=new List<string?>{null};int index=0,ticket=0;CatalogRow[] rows=[];
        void Render(){var q=search.Text.Trim();table.ItemsSource=rows.Where(r=>q.Length==0||(r.Name+" "+r.Summary).Contains(q,StringComparison.OrdinalIgnoreCase)).ToArray();label.Text=$"第 {index+1} 页 · 本页 {table.Items.Count} / {rows.Length} 条";previous.IsEnabled=index>0;next.IsEnabled=cursors.Count>index+1&&cursors[index+1] is not null;}
        async Task Load(int target){var own=++ticket;var epoch=generation;index=target;rows=[];Render();refresh.IsEnabled=previous.IsEnabled=next.IsEnabled=false;status.Text="正在查询服务器已保存记录…";
            try{var kind=types[type.SelectedIndex].Kind;var body=new Dictionary<string,object?>{{"kind",kind},{"limit",20}};if(cursors[index] is string cursor)body["cursor"]=cursor;if(kind is "scans" or "scan_current" or "simulation_settings" or "planning_records" or "planning_current" or "planning_runs")body["project_id"]="default";
                var data=await ReadRpcAsync("database.catalog",body);if(own!=ticket||epoch!=generation)return;rows=Array(data,"items").Select(r=>new CatalogRow(r.Field("summary").Text("name")??r.Field("summary").Text("alias")??SettingLabel(r.Text("id"))??r.Text("id")??"—",CatalogSummary(r),"v"+r.Text("revision"),Wire.LocalTime(r.Number("saved_at_ms")/1000),r)).ToArray();var after=data.Text("next_cursor");if(cursors.Count>index+1)cursors.RemoveRange(index+1,cursors.Count-index-1);cursors.Add(after);status.Text="已读取服务器保存版本 · 每页 20 条，按标识排序";
            }catch(Exception e){if(own==ticket)status.Text="读取失败："+SafeError(e);}finally{if(own==ticket){refresh.IsEnabled=true;Render();}}}
        refresh.Click+=(_,_)=>{cursors=[null];_ = Load(0);};previous.Click+=(_,_)=>_=Load(index-1);next.Click+=(_,_)=>_=Load(index+1);type.SelectionChanged+=(_,_)=>{cursors=[null];_=Load(0);};search.TextChanged+=(_,_)=>Render();grid.Loaded+=(_,_)=>{if(!verification||verificationRead is not null)_=Load(0);};Render();return Panel(grid,14,new(0,0,0,0));
    }
    private static string? SettingLabel(string? id)=>id switch{"monitoring_display_rules"=>"概览与通道卡显示规则（六类）","frequency_planning"=>"频率规划设置","network_connection"=>"网络连接偏好","alert_thresholds"=>"告警阈值","alert_sound"=>"声音告警","auto_frequency"=>"自动变频推荐",_=>null};
    private static string CatalogSummary(JsonElement item)
    {
        var s=item.Field("summary");string MHz(string key)=>Wire.Format(s.Number(key)/1000,"0.000");return item.Text("kind") switch{
            "device_overrides"=>$"{s.Text("receiver_id")} · CH{s.Text("channel_number")}",
            "manual_devices"=>$"{s.Text("brand")} · {s.Text("model")} · 配置 {MHz("configured_frequency_khz")} MHz",
            "settings"=>item.Text("id")==MonitoringRules.DocumentId?"概览统计 · 身份 · 频率用途 · 信号 · 话筒状态 · 告警":item.Text("id")=="frequency_planning"?"频率规划基本设置与约束 · 数据库保存":item.Text("id")=="network_connection"?"网络连接偏好 · 已存入数据库":item.Text("id")=="alert_thresholds"?$"RF {s.Text("rf_weak_dbm")} dBm · 电池 {s.Text("battery_low_percent")}% · AF {s.Text("af_overload_dbfs")} dBFS":s.Field("enabled").True()||s.Number("enabled")==1?"已启用":"已关闭",
            "scans"=>$"{(s.Text("source_kind") switch{"imported_csv"=>"导入扫描","instrument"=>"仪器扫描","simulation"=>"模拟资料",_=>s.Text("source_kind")})} · {s.Text("point_count")} 点 · {MHz("min_khz")}–{MHz("max_khz")} MHz",
            "profiles"=>$"{MHz("start_khz")}–{MHz("end_khz")} MHz · {(s.Text("source")=="planning-snapshot"?"规划保留版本":"设备参数")}",
            "planning_runs"=>"引擎 "+(s.Text("engine_version")??"未记录")+" · "+(s.Text("scan_id") is null?"未引用扫描":"含扫描引用"),"scan_current"=>"扫描资料："+s.Text("scan_id"),"planning_current"=>"当前方案："+(s.Text("current_record_id")??"未选择"),"simulation_settings"=>$"噪底 {s.Text("floor_dbm")} dBm · 占用阈值 {s.Text("threshold_dbm")} dBm","plugins"=>"资料状态："+s.Text("status"),_=>ActivityType(item.Text("kind"))};
    }
    private UIElement BuildCatalogDetail(JsonElement item,JsonElement resource)
    {
        var p=new StackPanel();Paragraph(p,(item.Field("summary").Text("name")??SettingLabel(item.Text("id"))??item.Text("id"))+" · 服务器已保存 · 版本 "+resource.Text("revision"),"#7c8db5");
        foreach(var(k,v)in new[]{("类型",ActivityType(item.Text("kind"))),("归属",item.Text("project_id") is null?"服务器共享":"项目：默认项目"),("记录标识",item.Text("id")??"—"),("保存时间",Wire.LocalTime(item.Number("saved_at_ms")/1000)),("内容摘要",item.Text("digest")??"未记录")})p.Children.Add(KeyValue(k,v));
        var value=resource.Field("value");if(value.ValueKind==JsonValueKind.Object)foreach(var f in value.EnumerateObject())if(f.Value.ValueKind is not (JsonValueKind.Array or JsonValueKind.Object))p.Children.Add(KeyValue(f.Name,f.Value.Text()??"null"));
        p.Children.Add(RawDetails(resource));p.Children.Add(ActionButton("导出此版本 JSON",()=>_=ExportAsync("业务记录",resource)));return p;
    }
    private async Task OpenCatalogDetailAsync(JsonElement item)
    {
        try{var result=await ReadRpcAsync("database.resources.get",new{kind=item.Text("kind"),id=item.Text("id")});var r=result.Field("resource");if(r.Text("kind")!=item.Text("kind")||r.Text("id")!=item.Text("id")||r.Number("revision")!=item.Number("revision")||r.Field("deleted").True())throw new InvalidDataException("记录已改变，请刷新目录后重试");ShowNativeDialog("记录详情",BuildCatalogDetail(item,r),780,610);}catch(Exception e){Message("读取失败："+SafeError(e),true);}
    }
    private sealed record ArchiveRow(string Type,string Name,string Saved,string State,string Size,JsonElement Raw)
    {
        public static ArchiveRow Parse(string type,JsonElement r)=>new(type,r.Text("fileName")??r.Text("id")??"—",Wire.LocalTime(r.Number("createdAtMs")/1000),r.Text("status") switch{"saved"=>"已保存","failed"=>"失败","queued"=>"排队中","writing" or "running"=>"处理中",_=>r.Text("status")??"—"},FormatBytes(r.Number("bytes")),r);
    }
}
