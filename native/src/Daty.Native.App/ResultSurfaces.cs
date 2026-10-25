using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;
public partial class MainWindow
{
    private void BuildPlanSummary(StackPanel panel,JsonElement result)
    {
        var analysis=result.Field("analysis");var assignments=Array(result,"assignments");var options=result.Field("options");
        var metrics=new System.Windows.Controls.Primitives.UniformGrid{Columns=4};
        var metricValues=new[]{(assignments.Length.ToString(),"已规划通道","#6ee7b7"),(Array(analysis,"conflicts").Length.ToString(),"确定性冲突",Array(analysis,"conflicts").Length>0?"#fb7185":"#6ee7b7"),(analysis.Number("minChannelSpacingKHz") is double spacing?$"{spacing:0.###} kHz":"N/A","结果实际最小间隔","#e2e8f0"),(analysis.Number("minImdMarginKHz") is double margin?$"{margin:0.###} kHz":"N/A","最小 IMD 净裕量","#e2e8f0")};
        foreach(var(number,label,color)in metricValues){var cell=new StackPanel{Margin=new(0,0,8,0)};cell.Children.Add(Text(number,17,color));cell.Children.Add(Text(label,9,"#7c8db5",new(0,4,0,0)));metrics.Children.Add(cell);}panel.Children.Add(metrics);
        var retention=result.Field("retention");panel.Children.Add(Text($"保留原频 {retention.Text("retainedCount")} 个 · 建议调整 {retention.Text("changedCount")} 个 · 未分配 {Array(result,"unassignedDeviceIds").Length} 个",12,margin:new(0,15,0,7)));
        void Note(string value)=>panel.Children.Add(Text(value,11,"#7c8db5",new(0,0,0,6)));
        if(options.Number("rangeStartKHz") is double actualStart&&options.Number("rangeEndKHz") is double actualEnd)
            Note($"实际规划范围 {actualStart/1000:0.000}–{actualEnd/1000:0.000} MHz"+(options.Field("rangeExpansion").Field("expanded").True()?" · 已自动扩大":""));
        Note($"扫描峰 {Array(options,"scanPeakCarriers").Length} 个 · 与设备实频、固定占用联合计算");
        var frequencies=assignments.Select(a=>a.Number("frequencyKHz")).OfType<double>().ToArray();var range=frequencies.Length==0?"—–—":$"{frequencies.Min()/1000:0.000}–{frequencies.Max()/1000:0.000}";
        Note(range+" MHz · "+(result.Field("distribution").Field("enabled").True()?"按实际通道分布于计算范围 · ":"")+$"{options.Text("stepKHz")} kHz 全局栅格 ∩ 各品牌栅格");
        Note($"排除 {Array(options,"excludedRanges").Length} · 锁定 {Array(options,"lockedAssignments").Length} · 已知占用 {Array(options,"knownCarriers").Length} · 备用 {options.Text("backupCount")}/通道");
        if(Array(result,"monitoringOnlyChannels").Length>0)Note($"仅监测 {Array(result,"monitoringOnlyChannels").Length} 通道固定保留原频，不参与下发。");
        var compatibility=result.Field("compatibility");var devices=Array(compatibility,"devices");bool noImd=PlanningIntermodulation.FromOptions(options).Length==0||(devices.Length>0&&devices.All(d=>d.Number("intermodSpacingKHz")==0));
        string Span(string key){var values=devices.Select(d=>d.Number(key)).OfType<double>().ToArray();return values.Length==0?"—":values.Min()==values.Max()?$"{values.Min():0.###}":$"{values.Min():0.###}～{values.Max():0.###}";}
        Note(devices.Length==0?PlanningIntermodulation.Label(PlanningIntermodulation.FromOptions(options)):$"{PlanningIntermodulation.Label(PlanningIntermodulation.FromOptions(options))} · 通道保护 {Span("channelSpacingKHz")} kHz · 互调保护 {(noImd?"无":Span("intermodSpacingKHz")+" kHz")} · 扫描阈值 {Span("scanThresholdDbm")} dBm");
        var pool=result.Field("frequencyPool");if(pool.ValueKind==JsonValueKind.Object)Note($"紧凑目标至少 {pool.Text("targetCount")} 个频点 · 实际通道 {pool.Text("actualCount")} 个 + 预留 {Array(pool,"reservedFrequenciesKHz").Length} 个 = 已规划 {pool.Text("plannedCount")} 个"+(pool.Field("complete").True()?"":$" · 未达标，缺少 {pool.Text("shortfall")} 个"));
        Note((Array(options,"scanPoints").Length==0?"未导入真实扫描：仅校核设备与所选数学约束。":"已校核真实扫描；Profile 与部署限制请查详情。")+(noImd?"本次无互调保护。":""));
        var errors=Array(result,"errors").Length;var warnings=Array(result,"warnings").Length;
        panel.Children.Add(Hint((errors>0?$"方案未完整通过 · {errors} 项错误":"部署前须通过 Profile 与硬件频段预检")+(warnings>0?$" · {warnings} 项提示":"")+"，见「详情 / 限制」。",errors>0?"#fb7185":"#fbbf24"));
    }
    private void ShowAlertRecordDetail(JsonElement resource)
    {
        var value=resource.Field("value");var panel=new StackPanel();var metric=value.Text("metric");var label=metric switch{"rf"=>"RF 弱信号","af"=>"AF 过载","battery" or "battery_bars"=>"电池低电量",_=>"其他历史告警"};
        Paragraph(panel,label+" · "+(value.Text("archiveState") switch{"ended"=>"已结束","active"=>"归档状态：触发中",_=>"历史状态未记录"}),"#7c8db5");var unit=metric switch{"rf"=>"dBm","af"=>"dBFS","battery"=>"%","battery_bars"=>"格",_=>""};
        foreach(var(key,text)in new[]{("事件标识",value.Text("archiveId")??resource.Text("id")??"—"),("设备 / 通道",value.Text("deviceId")??value.Text("channelId")??"—"),("接收机 IP",value.Text("receiverIP")??"—"),("首次触发",Wire.LocalTime((value.Number("firstSeen")??value.Number("ts"))/1000)),("最后出现",Wire.LocalTime(value.Number("lastSeen")/1000)),("结束时间",value.Text("archiveState")=="ended"?Wire.LocalTime(value.Number("endedAt")/1000):"尚未结束"),("记录值",value.Text("value") is string reading?reading+" "+unit:"未记录"),("触发阈值",value.Text("threshold") is string threshold?threshold+" "+unit:"未记录")})panel.Children.Add(KeyValue(key,text));
        Paragraph(panel,"同一事件保留首次触发和最后出现时间；结束后再次触发使用新的事件标识。已结束可能来自条件恢复、离线或遥测不可用，旧记录不推断具体原因，也不表示人工确认。","#7c8db5");panel.Children.Add(RawDetails(value));ShowNativeDialog("告警事件详情",panel,780,610);
    }
}
