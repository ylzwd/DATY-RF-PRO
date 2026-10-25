using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;
public partial class MainWindow
{
    private UIElement BuildPlanDetails()
    {
        var p=new StackPanel();
        if(planResult is not JsonElement r){Paragraph(p,"尚无有效规划结果。请先连接设备、设置规划范围，再点击「一键全局规划」。");return p;}
        var options=r.Field("options");var assignments=Array(r,"assignments");var frequencies=assignments.Select(a=>a.Number("frequencyKHz")).OfType<double>().ToArray();
        Paragraph(p,"所有计算均使用整数 kHz，结果可重复。IMD 净裕量 = 频率距离 − 要求间距。");
        if(r.Field("distribution").Field("enabled").True())Paragraph(p,$"按本次 {r.Field("distribution").Text("targetCount")} 个实际通道，在实际计算范围 {Wire.Format(options.Number("rangeStartKHz")/1000,"0.000")}–{Wire.Format(options.Number("rangeEndKHz")/1000,"0.000")} MHz 内分散规划，优先接近均匀分布；实际频点仍服从栅格、锁频、硬件频段、扫描与所选互调保护，不强行等间距。锁频作为固定锚点；不自动补足25个预留频点。");
        Paragraph(p,$"输入范围 {Wire.Format(options.Number("requestedRangeStartKHz")/1000,"0.000")}–{Wire.Format(options.Number("requestedRangeEndKHz")/1000,"0.000")} MHz；设备实频、锁频、固定占用及扫描峰共同决定扩展边界。扩大范围不改变各品牌硬件频段和调谐步进。原始范围设置保留在数据库，实际范围随本轮输入计算。");
        foreach(var peak in Array(options,"scanPeakCarriers"))Paragraph(p,$"扫描峰参与互调：{Wire.Format(peak.Number("frequencyKHz")/1000,"0.000")} MHz · {Wire.Format(peak.Number("levelDbm"),"0.#")} dBm；实测峰，不推定设备身份。");
        var pool=r.Field("frequencyPool");if(pool.ValueKind==JsonValueKind.Object){Paragraph(p,$"紧凑目标至少 {pool.Text("targetCount")} 个频点 · 实际通道 {pool.Text("actualCount")} 个 + 预留 {Array(pool,"reservedFrequenciesKHz").Length} 个 = 已规划 {pool.Text("plannedCount")} 个。按所有本次设备 Profile 的共同可用范围及当前约束计算，预留与主频、备用共同校核；不宣称频段最大容量。");Paragraph(p,"预留频点（未绑定设备）："+string.Join("、",Array(pool,"reservedFrequenciesKHz").Select(v=>Wire.Format(v.Number()/1000,"0.000"," MHz")))+"。新接收机接入后须重新规划，预留不会自动下发。");}
        foreach(var fixedChannel in Array(r,"monitoringOnlyChannels"))Paragraph(p,$"仅监测固定占用：{fixedChannel.Text("brand")} · {fixedChannel.Text("deviceId")} · {Wire.Format(fixedChannel.Number("frequencyKHz")/1000,"0.000")} MHz；参与避让，不下发。");
        Paragraph(p,"当前在线实频在本轮规划中保留占用，自身保留原频不会重复计算；下发接收机后也不假定话筒已经同步改频。扫描只避让实际覆盖范围，未知场外发射源不能凭空识别。");
        Paragraph(p,"DATYaudio 最小间隔 250 kHz，候选频点为 250 kHz 的整数倍。IMD 冲突会跳过候选，并非最终频率全部连续等距。多品牌任意两通道取各自间隔的较大值；互调保护距离取来源与受影响通道中较大值，统一联合求解。");
        foreach(var a in assignments)Paragraph(p,$"• {a.Text("brand")} · {ViewChannels.FirstOrDefault(c=>c.Id==a.Text("deviceId"))?.ChannelLabel??a.Text("deviceId")}：{Wire.Format(a.Number("frequencyKHz")/1000,"0.000")} MHz；栅格交集步进 {a.Text("candidateStepKHz")} kHz；采用通道间隔 {a.Text("channelSpacingKHz")} kHz / IMD 保护 {(a.Number("intermodSpacingKHz")==0?"无":a.Text("intermodSpacingKHz")+" kHz")}");
        Paragraph(p,$"本次联合约束（人工输入已确认入库，设备实频取当前快照）：排除 {Array(options,"excludedRanges").Length} · 锁定 {Array(options,"lockedAssignments").Length} · 占用 {Array(options,"knownCarriers").Length} · 备用 {options.Text("backupCount")}/通道。排除区、锁定和固定占用联合生效，优先于自动保留原频；不能覆盖 Profile 频段、调谐栅格、扫描与 IMD 安全限制，冲突时不静默忽略。备用仅为未锁定通道寻找，不足会提示，不会降低安全标准。");
        Paragraph(p,$"保留原频 {r.Field("retention").Text("retainedCount")} 个 · 建议调整 {r.Field("retention").Text("changedCount")} 个 · 未分配 {Array(r,"unassignedDeviceIds").Length} 个。"+(r.Field("allocationOrder").Field("enabled").True()?"按真实 GROUP 数字升序、同组 CH 升序从低频向高频规划；未知编组置后。锁定频率不变；升序与锁定或设备约束冲突时，明确返回未完成方案。":"先保护通过校验的原频率，仅重规划其余通道；规划范围、锁定、Profile 和扫描约束仍然有效。"));
        Paragraph(p,$"使用频段 {(frequencies.Length==0?"—":$"{frequencies.Min()/1000:0.000}–{frequencies.Max()/1000:0.000}")} MHz\n{PlanningIntermodulation.Label(PlanningIntermodulation.FromOptions(options))} · {options.Text("stepKHz")} kHz 栅格 · 全局搜索 {r.Field("search").Text("nodes")} 节点");
        Paragraph(p,Array(options,"scanPoints").Length>0?"已检查真实扫描保护窗口峰值、覆盖范围与采样缺口。":"未导入真实扫描，本次仅按设备与所选数学约束计算。");
        var noImd=PlanningIntermodulation.FromOptions(options).Length==0||(assignments.Length>0&&assignments.All(a=>a.Number("intermodSpacingKHz")==0));Paragraph(p,noImd?"本次未启用互调规则或有效保护间隔为零；频段、通道间隔、扫描和占用仍需校验。":PlanningIntermodulation.Label(PlanningIntermodulation.FromOptions(options))+"；按已选规则联合校验在线通道、当前实频、扫描峰和固定占用。仅计算频率位置，不预测产物功率。");
        Paragraph(p,assignments.Length>0&&Array(r,"errors").Length==0&&assignments.All(a=>a.Field("deploymentEligible").True())?"所有 Profile 与硬件频段已标记验证，可进入下发预检。":"结果仅供规划；未验证 Profile/频段或不完整方案不能开放跨品牌批量下发。");
        foreach(var warning in Array(r,"warnings"))Paragraph(p,"• "+warning.Text(),"#fbbf24");foreach(var error in Array(r,"errors"))Paragraph(p,error.Text()??"","#fb7185");return p;
    }
    private void ShowPlanDetails()=>PresentDialog(CreateSurfaceDialog("规划详情与限制",BuildPlanDetails(),760,650,"DATY RF PRO · 频率规划",footnote:"完整结果与限制以本次规划为准"));
    private void ShowSafetySettings()
    {
        var p=new StackPanel();Paragraph(p,"以下输入实时参与下一次全局规划。留空采用各设备 Profile；间隔取较大值、占用阈值取较低值，只加严，不降低 Profile 安全要求。无真实扫描时不能判断现场干扰。");
        var fields=Columns(Star(),Star());var rows=new[]{("stepKHz","全局搜索步进 kHz"),("minChannelSpacingKHz","最小通道间隔 kHz"),("minImdSpacingKHz","最小 IMD 间距 kHz"),("scanThresholdDbm","扫描占用阈值 dBm")};for(var row=0;row<3;row++)fields.RowDefinitions.Add(new(){Height=GridLength.Auto});
        for(var i=0;i<rows.Length;i++){var(key,label)=rows[i];var input=Input(safety[key]);input.MaxLength=64;input.TextChanged+=(_,_)=>{safety[key]=input.Text;PlannerEdited();};var field=(FrameworkElement)Labeled(label,input);field.Margin=new(i%2==0?0:8,0,i%2==0?8:0,12);At(fields,field,i/2,i%2);}
        var last=Labeled("兼容级别 / IMD 联合校验",PlannerIntermodulationChoices());At(fields,last,2);Grid.SetColumnSpan(last,2);p.Children.Add(fields);
        Paragraph(p,"DATYaudio 候选如 641.000、641.250、641.500 MHz；三阶 IMD 会排除相互冲突的组合，不保证连续等间距分配。按基本设置所选互调规则校核，通道间隔取各品牌要求中较大值。使用真实扫描时，扫描占用阈值与频谱排除阈值、设备 Profile 取更严格值。协议可执行验证不等于硬件 RF 认证。");
        var saveState=Text(planningSettingsStatus,11,"#7c8db5");p.Children.Add(saveState);var prior=planningStatusRefresh;planningStatusRefresh=()=>{prior?.Invoke();saveState.Text=planningSettingsStatus;};planningSafetyOpen=true;
        try{PresentDialog(CreateSurfaceDialog("自定义安全参数",p,760,540,"DATY RF PRO · 频率规划","⚙", "修改立即提交数据库；确认保存后可恢复，计算仍需校验"));}
        finally{planningSafetyOpen=false;planningStatusRefresh=prior;prior?.Invoke();}
    }
}
