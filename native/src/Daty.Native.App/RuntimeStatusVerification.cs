using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    internal async Task VerifyRuntimeStatusAsync(JsonElement config,string ca,int port)
    {
        var checks=new List<string>();
        void Check(bool value,string name){if(!value)throw new InvalidDataException(name);checks.Add(name);}
        string Tip()=>((ToolTip)ConnectionLabel.ToolTip).Content.ToString()!;
        await RefreshAsync();
        Check(live.Connected&&StatusToast.Visibility==Visibility.Collapsed,"real first snapshot is quiet");
        Check(Tip().Contains("运行正常")&&!Tip().Contains("127.0.0.1")&&!Tip().Contains("MQTT"),"sidebar describes runtime instead of internal transport");
        var stableTip=ConnectionLabel.ToolTip;
        Message("设置已保存");
        await RefreshAsync();
        Check(StatusMessage.Text=="设置已保存"&&StatusToast.Visibility==Visibility.Visible,"background refresh preserves explicit action result");
        Check(ReferenceEquals(stableTip,ConnectionLabel.ToolTip)&&!Tip().Contains("设置已保存"),"status tooltip remains stable and independent of notifications");
        await bridge!.DisposeAsync();await RefreshAsync();
        Check(!live.Connected&&StatusToast.Visibility==Visibility.Visible&&ConnectionLabel.Text=="设备数据暂不可用","read failure remains visible and removes online status");
        Check(StatusToast.ToolTip is ToolTip,"actual failure details remain inspectable");
        bridge=new R19MqttClient(settings.Server,ca,port);await RefreshAsync();
        Check(live.Connected&&StatusToast.Visibility==Visibility.Collapsed&&Tip().Contains("运行正常"),"recovery clears only its stale connection warning");
        Message("系统设置尚未保存",true);await RefreshAsync();
        Check(StatusMessage.Text=="系统设置尚未保存"&&StatusToast.Visibility==Visibility.Visible,"normal data cannot hide unrelated unsaved-setting warning");
        var tip=(ToolTip)ConnectionLabel.ToolTip;
        Check(((SolidColorBrush)tip.Background).Color==Color.FromRgb(0x17,0x1c,0x2b),"runtime hint uses dark theme");
        tip.ApplyTemplate();tip.Measure(new Size(double.PositiveInfinity,double.PositiveInfinity));tip.Arrange(new Rect(tip.DesiredSize));tip.UpdateLayout();
        var image=new RenderTargetBitmap((int)Math.Ceiling(tip.ActualWidth),(int)Math.Ceiling(tip.ActualHeight),96,96,PixelFormats.Pbgra32);image.Render(tip);
        var output=config.GetProperty("output").GetString()!;var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(image));
        using(var stream=File.Create(Path.ChangeExtension(output,".png")))encoder.Save(stream);
        toastTimer.Stop();
        await File.WriteAllTextAsync(output,JsonSerializer.Serialize(new{ok=true,checks,physicalCommands=0,loopbackOnly=true},new JsonSerializerOptions{WriteIndented=true}));
    }
}
