using System.Globalization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;

namespace Daty.Native.App;

public partial class MainWindow
{
    private FrameworkElement? spectrumEditor;
    private bool spectrumInputInvalid;
    private string? spectrumPeakInputDraft,spectrumExclusionInputDraft;
    private bool SpectrumEditing=>spectrumInputInvalid||(currentPage=="spectrum"&&spectrumEditor?.IsKeyboardFocusWithin==true);
    private UIElement SpectrumThresholdControls()
    {
        var row=Columns(GridLength.Auto,Star());row.Margin=new(0,0,0,4);spectrumEditor=row;
        var peak=Input(spectrumPeakInputDraft??"",62);var exclusion=Input(spectrumExclusionInputDraft??"",62);
        var status=Text("",11,"#fbbf24",new(12,0,0,0));status.VerticalAlignment=VerticalAlignment.Center;
        status.Cursor=Cursors.Hand;status.ToolTip="保存未完成时，点击核对数据库回执并重试。";
        status.MouseLeftButtonUp+=async(_,_)=>{try{await RetrySpectrumSettingsAsync();}catch(Exception error){status.Text="未保存："+SafeError(error);}};
        var syncing=false;
        static bool Read(TextBox input,out double value)=>double.TryParse(input.Text,NumberStyles.Float,CultureInfo.InvariantCulture,out value)&&double.IsFinite(value)&&value is >=-140 and <=0;
        async void Edited(object? sender,TextChangedEventArgs args)
        {
            if(syncing||!spectrumSettingsReady)return;
            spectrumInputInvalid=!Read(peak,out _)||!Read(exclusion,out _);
            if(spectrumInputInvalid){spectrumPeakInputDraft=peak.Text;spectrumExclusionInputDraft=exclusion.Text;status.Text="未保存：阈值须为 −140～0 dBm";return;}
            spectrumPeakInputDraft=spectrumExclusionInputDraft=null;
            Read(peak,out var p);Read(exclusion,out var e);
            try{await SetSpectrumThresholdsAsync(p,e);}
            catch(Exception error){status.Text="未保存："+SafeError(error);}
        }
        FrameworkElement Field(string title,TextBox input,string color,string hint,string id)
        {
            AutomationProperties.SetAutomationId(input,id);
            input.MaxLength=8;input.Foreground=B(color);input.BorderBrush=B(color);input.TextAlignment=TextAlignment.Right;
            var arrows=Rows(GridLength.Auto,GridLength.Auto);
            void Step(double delta){if(!Read(input,out var number))return;input.Text=Math.Clamp(number+delta,-140,0).ToString("0.##",CultureInfo.InvariantCulture);}
            Button Arrow(string label,double delta)
            {
                var button=ActionButton(label,()=>Step(delta));button.Width=20;button.Height=14;button.MinWidth=0;button.MinHeight=0;
                button.FontSize=8;button.Padding=new(0);button.Margin=new(1,0,0,0);button.Focusable=false;return button;
            }
            Put(arrows,Arrow("▲",1),0);Put(arrows,Arrow("▼",-1),1);
            input.PreviewKeyDown+=(_,e)=>{if(e.Key is Key.Up or Key.Down){Step(e.Key==Key.Up?1:-1);e.Handled=true;}};
            var label=Text(title,11,color,new(0,0,8,0));label.VerticalAlignment=VerticalAlignment.Center;
            var unit=Text("dBm",11,color,new(5,0,0,0));unit.VerticalAlignment=VerticalAlignment.Center;
            var field=Horizontal(label,input,arrows,unit);field.Margin=new(0,0,16,0);
            var tip=Text(hint,11);tip.MaxWidth=360;
            field.ToolTip=new ToolTip{Content=tip,Background=B("#171c2b"),Foreground=B("#e2e8f0"),BorderBrush=B("#313b55"),BorderThickness=new(1),Padding=new(10,7,10,7)};
            return field;
        }
        var fields=Horizontal(
            Field("扫描峰值阈值",peak,"#f59e0b","从真实扫描的连续超阈区中标记最高采样点；不把接收机离散 RF 频点或缺失数据当作扫描，不推断发射机型号。","ScanPeakThreshold"),
            Field("排除阈值",exclusion,"#ef4444","扫描电平达到此值时参与规划避让；设备 Profile 或规划安全参数更严格时取更严格值。两项阈值修改立即提交数据库。","ScanExclusionThreshold"));
        At(row,fields);At(row,status,0,1);
        spectrumSettingsRefresh=()=>
        {
            fields.IsEnabled=spectrumSettingsReady;
            syncing=true;
            try
            {
                if(!peak.IsKeyboardFocusWithin&&!spectrumInputInvalid)peak.Text=ScanPeakThresholdDbm?.ToString("0.##",CultureInfo.InvariantCulture)??"";
                if(!exclusion.IsKeyboardFocusWithin&&!spectrumInputInvalid)exclusion.Text=ScanExclusionThresholdDbm?.ToString("0.##",CultureInfo.InvariantCulture)??"";
            }
            finally{syncing=false;}
            status.Text=spectrumInputInvalid?"未保存：阈值须为 −140～0 dBm":spectrumSettingsStatus.StartsWith("已")?"":spectrumSettingsStatus;
        };
        spectrumSettingsRefresh();peak.TextChanged+=Edited;exclusion.TextChanged+=Edited;
        return row;
    }
}
