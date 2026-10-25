using System.IO;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;
using Microsoft.Win32;

namespace Daty.Native.App;

public partial class MainWindow
{
    private Action? spectrumToolbarRefresh;
    private UIElement SpectrumToolbar(ComboBox records)
    {
        var header=Columns(GridLength.Auto,Star());header.Margin=new(0,0,0,8);
        var title=Heading("📈 频谱与设备频点视图");title.Margin=new(0,0,16,6);title.VerticalAlignment=VerticalAlignment.Top;
        At(header,title);
        var actions=new WrapPanel{HorizontalAlignment=HorizontalAlignment.Right};At(header,actions,0,1);
        Button Tool(string text,string id,Action action)
        {
            var button=ActionButton(text,action);button.SetResourceReference(StyleProperty,"SpectrumToolbarButton");
            System.Windows.Automation.AutomationProperties.SetAutomationId(button,id);actions.Children.Add(button);return button;
        }
        var start=Tool("开始扫描","SpectrumScanStart",()=>_=ToggleLiveScanAsync());
        var hardware=Tool("扫描频段","SpectrumScanHardware",ShowScanHardwareProfiles);
        var import=Tool("导入扫描","SpectrumScanImport",()=>_=ImportScanAsync());
        records.SetResourceReference(StyleProperty,"SpectrumToolbarSelector");records.Margin=new(0,0,6,6);actions.Children.Add(records);
        var export=Tool("导出文件","SpectrumScanExport",()=>_=ExportScanAsync());
        Tool("⤢ 适配设备","SpectrumFit",FitRange);
        Tool("↩ 恢复范围","SpectrumRestore",()=>{settings=settings with{StartMHz=manualStart,EndMHz=manualEnd};liveRefresh?.Invoke();});
        var clear=Tool("🧹 清除扫描","SpectrumScanClear",()=>_=ClearCurrentScanAsync());
        foreach(var control in new Control[]{start,export,import,clear})ToolTipService.SetShowOnDisabled(control,true);
        spectrumToolbarRefresh=()=>{
            start.Content=LiveScanActive?"停止扫描":"开始扫描";
            var pending=UnconfirmedScanReceivers().Count>0;
            start.IsEnabled=!liveScanSubmitting&&!scanProfileSaving&&(LiveScanActive||(!verification&&bridge is not null&&(ScanReceivers().Count>0||pending)));
            hardware.Visibility=pending?Visibility.Visible:Visibility.Collapsed;hardware.IsEnabled=!LiveScanActive&&!liveScanSubmitting&&!scanProfileSaving;
            hardware.ToolTip="保存当前机身标签对应的扫描频段";
            start.ToolTip=liveScanOperation is not null?liveScanSummary:"读取 ULXD4 已确认频段的真实扫描点。自动完成本次连接的会话协商；扫描期间可停止，结束后可导出文件。";
            if(!LiveScanActive&&ScanReceivers().Count==0)start.ToolTip=pending?"该接收机未上报硬件频段；点击确认机身标签后即可扫描。":"需要已安装舒尔扫描插件和在线、受支持的 ULXD4 接收机。";
            if(!LiveScanActive&&!pending&&ScanReceivers().Count==0) {
                var reason=ViewChannels.Where(c=>c.Online&&c.Brand=="Shure").Select(c=>c.Raw.Field("capabilities").Text("scan_unavailable_reason")).FirstOrDefault(c=>c is "SCAN_HARDWARE_BAND_UNSUPPORTED" or "SCAN_RECEIVER_IDENTITY_UNAVAILABLE" or "SCAN_HARDWARE_IDENTITY_STALE");
                if(reason is not null)start.ToolTip=LiveScanError(reason);
            }
            import.IsEnabled=clear.IsEnabled=!LiveScanActive&&!liveScanSubmitting;
            import.ToolTip=clear.ToolTip=LiveScanActive?"停止当前扫描后可导入或清除":null;
            export.IsEnabled=scan?.Points.Count>0;
            export.ToolTip=scan is null?"先扫描或导入有效扫描文件":"导出当前记录；DATY 格式保留缺失位置及扫描状态，CSV 仅含有效实测点。";
            records.IsEnabled=!LiveScanActive;records.ToolTip=scan is null?null:ScanExplanation(scan);
        };
        spectrumToolbarRefresh();return header;
    }
    private async Task ExportScanAsync()
    {
        var document=scan;if(document is null||document.Points.Count==0){Message("当前没有可导出的扫描数据",true);return;}
        var dialog=new SaveFileDialog {Title="导出扫描文件",Filter="DATY 完整扫描|*.datyscan|扫描 CSV（仅有效点）|*.csv",
            FileName="DATY-扫描-"+DateTime.Now.ToString("yyyyMMdd-HHmmss"),AddExtension=true,DefaultExt=".datyscan"};
        if(dialog.ShowDialog(this)!=true)return;
        try {
            var csv=string.Equals(Path.GetExtension(dialog.FileName),".csv",StringComparison.OrdinalIgnoreCase);
            await LocalFiles.WriteAtomicAsync(dialog.FileName,csv?ScanExchange.Csv(document):ScanExchange.Export(document),lifetime.Token);
            Message($"已导出 {document.Points.Count:N0} 个实测点"+(csv&&document.MissingPoints>0?"；CSV 未包含缺失位置，请用 DATY 格式保留完整状态":""));
        } catch(Exception error){Message("导出失败："+SafeError(error),true);}
    }
}
