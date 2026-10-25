using System.Windows;
using System.Windows.Controls;

namespace Daty.Native.App;

public partial class MainWindow
{
    private string? deviceDataError;
    private bool deviceDataToast;

    private static void SetStatusToolTip(FrameworkElement target,string value)
    {
        if(target.ToolTip is ToolTip tip)
        {
            if(!Equals(tip.Content,value))tip.Content=value;
            return;
        }
        target.ToolTip=new ToolTip { Content=value,Background=B("#171c2b"),Foreground=B("#a9b7d4"),
            BorderBrush=B("#2e3a56"),BorderThickness=new(1),Padding=new(10,7,10,7) };
    }

    private void DeviceDataUnavailable(string reason,bool showToast=true)
    {
        var changed=deviceDataError!=reason;
        deviceDataError=reason;
        UpdateLive();
        if(!showToast||!changed)return;
        Message(reason.Contains("503",StringComparison.Ordinal)
            ?"数据服务正在恢复，设备状态暂不可用。"
            :"设备数据暂不可用，正在自动恢复。",true);
        // Detailed failures remain inspectable; routine success has no popup.
        SetStatusToolTip(StatusToast,reason);
        deviceDataToast=true;
    }

    private void DeviceDataUpdated()
    {
        deviceDataError=null;
        // A normal refresh must not hide a save/command result or unrelated error.
        if(deviceDataToast)
        {
            deviceDataToast=false;toastTimer.Stop();StatusToast.Visibility=Visibility.Collapsed;
            StatusToast.ToolTip=null;StatusMessage.Text="";
        }
        UpdateLive();
    }
}
