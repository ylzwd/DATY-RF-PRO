using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Daty.Native.Core;

namespace Daty.Native.App;
public partial class MainWindow
{
    private static string ActivityType(string? kind)=>kind switch{"settings"=>"系统设置","device_overrides"=>"通道名称","manual_devices"=>"手动设备","scans"=>"扫描资料","scan_current"=>"当前扫描引用","simulation_settings"=>"模拟参数","planning_records"=>"规划历史","planning_current"=>"当前方案引用","planning_runs"=>"规划运行","profiles"=>"兼容参数版本","project_metadata"=>"项目信息","preferences"=>"视图偏好","plugins"=>"协议资料","device.discovered"=>"设备上线","device.state_changed"=>"设备状态变化","receiver.discovered"=>"发现接收机","channel.observed"=>"首次观测通道","channel.changed"=>"通道状态变化","channel.offline"=>"通道离线","channel.removed"=>"通道移出快照","server.boot"=>"服务器启动","planning.deployment"=>"方案下发记录","coordination.completed"=>"规划计算完成",_=>kind?.StartsWith("command.")==true?"设备指令":kind??"其他事件"};
    private static string ActivityOutcome(string? state)=>state switch{"accepted"=>"已受理","prepared"=>"准备发送","queued"=>"等待发送","published" or "dispatched"=>"已发出 · 待确认","readback_confirmed"=>"回读确认（非设备 ACK）","acknowledged"=>"设备已确认","not_sent"=>"未发送","rejected"=>"已拒绝","failed"=>"失败","timeout"=>"确认超时","unknown"=>"结果未知","reviewed"=>"已人工核对","committed"=>"保存已提交","deleted"=>"移除已提交","observed"=>"观测记录",_=>state??"—"};
    private sealed record ActivityListRow(string Time,string Type,string Target,string Summary,string Outcome,JsonElement Item);
    private async Task OpenActivityItemAsync(JsonElement item)
    {
        try{var reply=await ReadRpcAsync("database.activity.get",new{source=item.Text("source"),id=item.Field("id")});if(reply.Text("source")!=item.Text("source")||reply.Number("id")!=item.Number("id"))throw new System.IO.InvalidDataException("活动详情身份不匹配");ShowNativeDialog("记录详情",BuildActivityDetail(item,reply),780,650);}catch(Exception e){Message("读取审计详情失败："+SafeError(e),true);}
    }
    private UIElement BuildActivityDetail(JsonElement item,JsonElement reply)
    {
        var p=new StackPanel();Paragraph(p,ActivityType(item.Text("kind"))+" · "+ActivityOutcome(item.Text("outcome")),"#7c8db5");var r=reply.Field("record");
        foreach(var (key,value) in new[]{("记录时间",Wire.LocalTime(item.Number("time_ms")/1000)),("记录来源",item.Text("source")=="operations"?"数据库提交审计":item.Text("source")=="live"?"设备状态观测":"服务器事件"),("目标标识",item.Text("target")??"—"),("记录编号",item.Text("source")+":"+item.Text("id"))})p.Children.Add(KeyValue(key,value));
        if(item.Text("source")=="operations")
        {
            p.Children.Add(KeyValue("操作标识",r.Text("operation_id")??"未记录"));p.Children.Add(KeyValue("网络来源",r.Field("actor").Text("ip")??r.Field("actor").Text("id")??"未记录"));p.Children.Add(KeyValue("历史版本","v"+r.Text("revision")));
            var before=r.Field("before").Field("fields");var after=r.Field("after").Field("fields");var keys=(before.ValueKind==JsonValueKind.Object?before.EnumerateObject().Select(x=>x.Name):[]).Concat(after.ValueKind==JsonValueKind.Object?after.EnumerateObject().Select(x=>x.Name):[]).Distinct();
            var table=Table(("字段","Name",0),("保存前","Before",0),("保存后","After",0));table.ItemsSource=keys.Select(k=>new{Name=FieldLabel(k),Before=before.Field(k).Text()??"未记录",After=after.Field(k).Text()??"未记录"}).ToArray();table.Height=Math.Clamp(38+table.Items.Count*34,80,300);p.Children.Add(table);Paragraph(p,"展示该次提交的主要业务字段；移除为历史版本标记。保存已提交不代表设备已执行。","#7c8db5");
        }
        else if(item.Text("kind")?.StartsWith("command.")==true){var d=r.Field("details");foreach(var(key,value)in new[]{("指令标识",r.Text("command_id")),("操作标识",d.Text("operation_id")),("期望值",d.Field("expected").Text()),("设备回报值",d.Field("actual").Text()),("单位",d.Text("unit")),("错误信息",d.Text("error")),("执行证据",d.Field("execution_evidence").Text())})p.Children.Add(KeyValue(key,value??"未记录"));Paragraph(p,"“设备已确认”只用于 acknowledged 记录；人工核对与发送状态不改写此前未知或失败结果。","#7c8db5");}
        p.Children.Add(RawDetails(r));return p;
    }
    private static string FieldLabel(string key)=>key switch{"rfWeakDbm"=>"RF 阈值（dBm）","afOverloadDbfs"=>"AF 阈值（dBFS）","batteryLowPercent"=>"电池阈值（%）","batteryLowBars"=>"电池阈值（格）","enabled"=>"开关","alias"=>"通道名称","receiverId"=>"接收机标识","channelNumber"=>"通道号","projectId"=>"项目标识","name"=>"名称","currentRecordId"=>"当前方案","scanId"=>"扫描引用","engineVersion"=>"引擎版本","configuredFrequencyKHz"=>"配置频率（kHz）","configuredChannelNumber"=>"配置通道","configuredIp"=>"配置 IP","specStartFreq"=>"起始频率（MHz）","specEndFreq"=>"结束频率（MHz）","brand"=>"品牌","model"=>"型号","status"=>"状态",_=>key};
}
