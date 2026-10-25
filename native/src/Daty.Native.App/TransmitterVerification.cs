using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Daty.Native.Core;

namespace Daty.Native.App;

internal static partial class UiVerification
{
    private static void VerifyTransmitter(string directory)
    {
        var results = new List<object>();
        foreach (var width in new[] { 1024, 1366, 1920 })
        {
            var window = new MainWindow(true) { Width = width, Height = 768 };
            foreach (var (name, model, antenna, meter, muted, expected) in new[] {
                ("off", (string?)null, "XX", "live", false, "话筒离线"),
                ("rf-restored", (string?)null, "AX", "live", false, "话筒连接中"),
                ("model-restored", "ULXD2", "XB", "live", false, "话筒 ULXD2"),
                ("muted", "ULXD2", "AX", "live", true, "话筒 ULXD2"),
                ("off-again", "ULXD2", "XX", "live", false, "话筒离线"),
                ("off-noise", "ULXD2", "XX", "live", false, "话筒离线"),
                ("meter-stale", "ULXD2", "XX", "stale", false, "话筒状态未知"),
                ("different-model", "ULXD1", "AX", "live", false, "话筒 ULXD1") })
            {
                var raw = JsonSerializer.SerializeToElement(new { success=true, devices=new[] { new {
                    id="shure-fixture",receiver_id="rx",receiver_name="接收机标签 A",name="通道标签 B",channel_number=1,group_number=2,group_source="server-fifo-v1",
                    brand="Shure",model="ULXD4",receiver_ip="192.0.2.107",_source="shure-scp",_online=true,status="online",freq=690000,rf=name is "off" or "off-again" or "meter-stale" ? -95 : name=="off-noise"?-88:-60,muted,
                    shure=new {schema="daty-shure-telemetry-v1",transmitter_type=model,transmitter_name="手持话筒 C",transmitter_firmware="2.10.0.0",transmitter_muted=name=="off-noise",audio_dbfs=-1,battery_bars=4,rf_antenna=antenna,meter_state=meter,receiver_muted=muted,stale_fields=System.Array.Empty<string>()}
                } } });
                window.SetVerificationSnapshot(DeviceSnapshot.Parse(raw));window.ShowPage("channels");
                var root=(FrameworkElement)window.Content;root.Measure(new Size(width,768));root.Arrange(new Rect(0,0,width,768));root.UpdateLayout();
                var card=Descendants<Border>(root).Single(b=>Equals(b.Tag,"shure-fixture"));
                var label=Descendants<TextBlock>(card).Single(t=>t.Text==expected);
                var tip=label.ToolTip as ToolTip ?? throw new Exception("Missing native transmitter tooltip");
                var tipText=tip.Content as TextBlock ?? throw new Exception("Missing readable tooltip content");
                if(!tipText.Text.Contains("接收机标签：接收机标签 A")||!tipText.Text.Contains("通道标签：通道标签 B")||tipText.FontSize!=12||tipText.TextWrapping!=TextWrapping.Wrap||tipText.TextAlignment!=TextAlignment.Left)
                    throw new Exception("Receiver fields or unscaled wrapping absent");
                if(name is "off" or "off-again" or "off-noise" or "meter-stale" or "rf-restored") {
                    if(tipText.Text.Contains("手持话筒 C")||tipText.Text.Contains("2.10.0.0"))throw new Exception("Stale tooltip identity visible");
                } else if(!tipText.Text.Contains("话筒标签：手持话筒 C")||!tipText.Text.Contains("话筒型号："+model))throw new Exception("Live transmitter details absent");
                if(width==1366 && name=="model-restored") {
                    tip.ApplyTemplate();tip.Measure(new Size(400,700));tip.Arrange(new Rect(tip.DesiredSize));tip.UpdateLayout();
                    var tipBitmap=new RenderTargetBitmap((int)Math.Ceiling(tip.ActualWidth),(int)Math.Ceiling(tip.ActualHeight),96,96,PixelFormats.Pbgra32);tipBitmap.Render(tip);
                    var tipEncoder=new PngBitmapEncoder();tipEncoder.Frames.Add(BitmapFrame.Create(tipBitmap));using var tipStream=File.Create(Path.Combine(directory,"transmitter-hover.png"));tipEncoder.Save(tipStream);
                }
                var ch=Descendants<TextBlock>(card).Single(t=>t.Text=="GUP2 · CH1");
                var rect=new Rect(label.TranslatePoint(new Point(),card),label.RenderSize);
                var channelRect=new Rect(ch.TranslatePoint(new Point(),card),ch.RenderSize);
                if(label.TextAlignment!=TextAlignment.Right || label.TextWrapping!=TextWrapping.NoWrap || rect.Width<=0 || rect.Left<channelRect.Right-0.1)
                    throw new Exception("Transmitter label overlaps or is not right aligned: "+name);
                var rfLabel=Descendants<TextBlock>(card).Single(t=>t.Text=="RF");
                var rfRow=(Grid)rfLabel.Parent;var rfMeter=rfRow.Children.OfType<ProgressBar>().Single();
                var rfValue=rfRow.Children.OfType<TextBlock>().Single(t=>t!=rfLabel);
                bool hidden=name is "off" or "off-again" or "off-noise" or "meter-stale";
                if(rfMeter.Visibility!=(hidden?Visibility.Hidden:Visibility.Visible)||rfValue.Text!=(hidden?"—":"-60 dBm"))throw new Exception("RF stale/low values visible: "+name);
                if(name is "off" or "off-again" or "off-noise") {
                    if(!Descendants<TextBlock>(card).Any(t=>t.Text=="● 离线"))throw new Exception("Card offline status absent");
                    if(card.ToolTip is not null)throw new Exception("Offline transmitter must not create an alarm tooltip");
                    foreach(var field in new[]{"AF","🔋"}) {
                        var fieldLabel=Descendants<TextBlock>(card).Single(t=>t.Text==field);
                        var fieldRow=(Grid)fieldLabel.Parent;
                        if(fieldRow.Children.OfType<TextBlock>().Single(t=>t!=fieldLabel).Text!="—")throw new Exception("Offline cached metric visible: "+field);
                    }
                    if(name=="off-noise"&&Descendants<TextBlock>(card).Any(t=>t.Text=="🔇 已静音"&&((FrameworkElement)t.Parent).Visibility==Visibility.Visible))throw new Exception("Cached transmitter mute visible after absence");
                }
                if(muted){var badge=Descendants<TextBlock>(card).Single(t=>t.Text=="🔇 已静音");var badgeRect=new Rect(badge.TranslatePoint(new Point(),card),badge.RenderSize);if(rect.Right>badgeRect.Left+0.1)throw new Exception("Transmitter overlaps mute badge");}
                if(width==1366 && name is "off" or "off-noise" or "model-restored" or "muted") {
                    var bitmap=new RenderTargetBitmap((int)card.ActualWidth,(int)card.ActualHeight,96,96,PixelFormats.Pbgra32);bitmap.Render(card);
                    var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using var stream=File.Create(Path.Combine(directory,"transmitter-"+name+".png"));encoder.Save(stream);
                }
                if(name is "off" or "off-again" or "off-noise") {
                    window.ShowPage("dashboard");root.Measure(new Size(width,768));root.Arrange(new Rect(0,0,width,768));root.UpdateLayout();
                    if(!Descendants<TextBlock>(root).Any(t=>t.Text=="暂无告警事件"&&t.Visibility==Visibility.Visible))throw new Exception("Dashboard still has transmitter alarms after absence");
                    if(Descendants<SpectrumPlot>(root).Single().Channels.Any(c=>c.RfDbm is not null))throw new Exception("Dashboard plots offline RF noise");
                }
                results.Add(new{width,name,label=label.Text,rightAligned=true,noOverlap=true,rfHidden=hidden,rfValue=rfValue.Text,cardHeight=card.ActualHeight});
            }
            window.Close();
        }
        File.WriteAllText(Path.Combine(directory,"transmitter-verification.json"),JsonSerializer.Serialize(new{passed=true,scenes=results.Count,networkRequests=0,deviceCommands=0,results}));
    }
}
