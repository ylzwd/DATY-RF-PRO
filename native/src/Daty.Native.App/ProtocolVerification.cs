using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Daty.Native.Core;

namespace Daty.Native.App;

internal static partial class UiVerification
{
    private static async Task VerifyProtocolsAsync(string directory)
    {
        var results=new List<object>();
        var rules=MonitoringRules.Parse(JsonDocument.Parse(File.ReadAllText(Environment.GetEnvironmentVariable("DATY_MONITORING_RULES_FIXTURE")??throw new Exception("Monitoring fixture required"))).RootElement);
        Channel Shure(double rf=-40,bool? muted=false,string[]? stale=null,string meter="live",string? model="ULXD2")=>Channel.Parse(JsonSerializer.SerializeToElement(new{
            id="s1",receiver_id="shure-rx",brand="Shure",model="ULXD4",channel_number=1,group_number=2,group_source="server-fifo-v1",receiver_ip="192.0.2.107",_online=true,status="online",_source="shure-scp",freq=690000,rf,muted,af_dbfs=(double?)null,
            shure=new{schema="daty-shure-telemetry-v1",receiver_firmware="2.10.0.0",transmitter_type=model,transmitter_firmware="2.10.0.0",transmitter_muted=true,receiver_muted=muted,rf_antenna="AX",meter_state=meter,audio_dbfs=-50,battery_bars=3,battery_percent=(double?)null,battery_minutes=(double?)null,battery_health_percent=(double?)null,battery_cycles=(double?)null,battery_temperature_c=(double?)null,meter_seq=123456,stale_fields=stale??[]}
        }));
        var report=ProtocolReport.Read(Shure(),rules);
        if(report.Length!=8||!report[0].Detail.Contains("接收机固件：2.10.0.0")||!report[0].Detail.Contains("发射机固件：2.10.0.0")||!report[1].Detail.Contains("-50.0 dBFS")||!report[1].Value.Contains("-50.0")||!report[2].Value.Contains("3/5")||report[2].Detail.Contains("60%")||report[3].Value!="未静音")throw new Exception("Live protocol telemetry, firmware, battery or independent output mute incorrect");
        if(!report[4].Value.Contains("未提供")||!report[5].Value.Contains("未提供")||!report[6].Value.Contains("未提供")||report.Any(r=>r.Value.Contains("123456")))throw new Exception("Unsupported raw statistics must not be inferred from sequence or PDF");
        var offline=ProtocolReport.Read(Shure(-95),rules);
        if(offline[0].Value.Contains("ULXD2")||offline[1].Value.Contains("-95")||offline[2].Value!="当前不可用"||offline[3].Value!="未静音")throw new Exception("RF offline must suppress cached TX and battery without muting receiver output");
        var expired=ProtocolReport.Read(Shure(stale:["audio_dbfs","battery_bars","muted","receiver_firmware","transmitter_firmware"]),rules);
        if(expired[1].Value.Contains("-50")||expired[2].Value.Contains("3/5")||expired[3].Value!="已过期"||expired[0].Detail.Contains("固件：2.10.0.0")||!expired[7].Value.Contains("5 项陈旧"))throw new Exception("Stale protocol fields must not be presented as current");
        if(ProtocolReport.Read(Shure(muted:null),rules)[3].Value!="未提供"||ProtocolReport.Read(Shure(muted:true),rules)[3].Value!="已静音")throw new Exception("Output mute must use actual boolean, never AF or TX mute");
        if(ProtocolReport.Read(Shure(meter:"stale"),rules)[0].Value.Contains("ULXD2")||ProtocolReport.Read(Shure(meter:"stale"),rules)[1].Value.Contains("-40")||ProtocolReport.Read(Shure(model:null),rules)[2].Value!="当前不可用")throw new Exception("Missing current transmitter must not reuse its battery or model");
        if(!ProtocolReport.Read(Shure(),null)[1].Value.Contains("等待数据库规则"))throw new Exception("No local monitoring defaults allowed");
        DeviceSnapshot Snapshot(double rtt,bool shureOnline=true)=>DeviceSnapshot.Parse(JsonSerializer.SerializeToElement(new{success=true,devices=new object[]{
            new{id="d1",receiver_id="daty-rx",brand="DATYaudio",model="RF PRO",channel_number=1,group_number=1,group_source="server-fifo-v1",receiver_ip="192.0.2.103",_online=true,status="online",freq=640000,rf=-42,af_dbfs=-25,batt=75,heartbeat=new{status="measured",rtt_ms=(double?)rtt,age_ms=10,max_age_ms=5000}},
            new{id="d2",receiver_id="daty-rx",brand="DATYaudio",model="RF PRO",channel_number=2,group_number=1,group_source="server-fifo-v1",receiver_ip="192.0.2.103",_online=true,status="online",freq=641250,rf=-55,af_dbfs=-33,batt=50,heartbeat=new{status="measured",rtt_ms=(double?)rtt,age_ms=10,max_age_ms=5000}},
            shureOnline?Shure().Raw:JsonSerializer.SerializeToElement(new{id="s1",brand="Shure",_online=false,status="offline"}),
            new{id="p1",receiver_id="plugin-rx",brand="FixtureBrand",model="Isolated receiver",channel_number=1,group_number=3,group_source="server-fifo-v1",receiver_ip="192.0.2.108",_online=true,status="online",heartbeat=new{status="unmeasured",rtt_ms=(double?)null,age_ms=10,max_age_ms=5000}},
            new{id="off",receiver_id="off-rx",brand="OfflineBrand",model="Offline",channel_number=1,group_number=4,group_source="server-fifo-v1",receiver_ip="192.0.2.109",_online=false,status="offline",heartbeat=new{status="unmeasured",rtt_ms=(double?)null,age_ms=10,max_age_ms=5000}},
        }}));
        foreach(var (width,height) in new[]{(1024,700),(1280,720),(1366,768),(1440,900),(1920,1080)})
        {
            var window=new MainWindow(true){Width=width,Height=height};window.SetVerificationSnapshot(Snapshot(1.23));window.SetSurfaceFixtures();window.ShowVerificationView("devices:protocol");
            var root=(FrameworkElement)window.Content;
            void Layout(){root.Measure(new Size(width,height));root.Arrange(new Rect(0,0,width,height));root.UpdateLayout();}
            Layout();await window.Dispatcher.InvokeAsync(()=>{},DispatcherPriority.Render);Layout();
            Border[] Cards()=>Descendants<Border>(root).Where(b=>b.Tag is string t&&t.StartsWith("protocol-card:")).ToArray();
            string[] Texts(Border card)=>Descendants<TextBlock>(card).Select(t=>t.Text).ToArray();
            var cards=Cards();if(cards.Length!=3)throw new Exception("Only actual online protocol brands may be shown");
            var daty=cards.Single(c=>Equals(c.Tag,"protocol-card:DATYaudio"));var shure=cards.Single(c=>Equals(c.Tag,"protocol-card:Shure"));var generic=cards.Single(c=>Equals(c.Tag,"protocol-card:FixtureBrand"));
            if(!Texts(daty).Contains("1 台 · 2 通道")||Texts(daty).Any(t=>t.Contains("253/")))throw new Exception("Protocol receiver count or brand-specific fields incorrect");
            if(!Texts(shure).Contains("TCP :2202")||!Texts(shure).Contains("253/253 · 1 台")||Texts(generic).Contains("MQTT / TLS"))throw new Exception("Protocol values must come from their own source");
            var healthTip=Descendants<TextBlock>(shure).Single(t=>t.Text=="已就绪 · 直接接入").ToolTip as ToolTip;
            var healthText=(healthTip?.Content as TextBlock)?.Text??"";
            if(!healthText.Contains("DATY 自有 SCP")||!healthText.Contains("有效监测会话：1 / 1")||healthText.Contains("SystemAPI"))throw new Exception("Protocol health must use DATY monitoring state");
            if(Descendants<Button>(daty).Any(b=>b.Content?.ToString()?.Contains("扫描")==true)||Descendants<Button>(generic).Any(b=>b.Content?.ToString()?.Contains("扫描")==true))throw new Exception("Other brands must not inherit Shure scan actions");
            void Geometry()
            {
                if(cards.Max(c=>c.ActualWidth)-cards.Min(c=>c.ActualWidth)>.5||cards.Max(c=>c.ActualHeight)-cards.Min(c=>c.ActualHeight)>.5||cards.Min(c=>c.ActualWidth)<262)throw new Exception("Protocol cards must have matching readable dimensions");
                foreach(var card in cards)foreach(var e in Descendants<FrameworkElement>(card).Where(e=>e is TextBlock or Button or Expander))
                {
                    if(e.Visibility!=Visibility.Visible||e.ActualHeight<=0||e.ActualWidth<=0)continue;
                    var hidden=false;for(DependencyObject? ancestor=e;ancestor is not null&&ancestor!=card;ancestor=VisualTreeHelper.GetParent(ancestor))if(ancestor is UIElement ui&&ui.Visibility!=Visibility.Visible){hidden=true;break;}if(hidden)continue;
                    var bounds=new Rect(e.TranslatePoint(new Point(),card),e.RenderSize);
                    if(bounds.Left<-.5||bounds.Right>card.ActualWidth+.5||bounds.Top<-.5||bounds.Bottom>card.ActualHeight+.5)throw new Exception("Protocol content clipped: "+card.Tag+" "+e.GetType().Name+" "+width+" "+(e as TextBlock)?.Text+" bounds="+bounds+" card="+card.RenderSize);
                }
            }
            string Value(Border card,string label)=>Descendants<TextBlock>(card).Single(t=>Equals(t.Tag,"protocol-report:"+label)).Text;
            var selector=Descendants<ComboBox>(daty).Single(c=>Equals(c.Tag,"protocol-report-channel"));
            selector.SelectedIndex=1;Layout();if(!Value(daty,ProtocolReport.Labels[1]).Contains("641.250")||!Value(daty,ProtocolReport.Labels[2]).Contains("50%")||!Descendants<TextBlock>(selector).Any(t=>t.Text.Contains("GUP1 · CH2 · 192.0.2.103")))throw new Exception("Selected channel data or displayed identity incorrect");
            if(!Value(shure,ProtocolReport.Labels[0]).Contains("ULXD2")||Value(generic,ProtocolReport.Labels[0]).Contains("ULXD2")||Value(daty,ProtocolReport.Labels[3])!="未提供")throw new Exception("Cross-brand report leakage");
            Geometry();
            window.SetVerificationSnapshot(Snapshot(3.45));Layout();
            if(!ReferenceEquals(shure,Cards().Single(c=>Equals(c.Tag,shure.Tag)))||!Texts(daty).Contains("3.45 ms")||selector.SelectedIndex!=1||!Value(daty,ProtocolReport.Labels[1]).Contains("641.250"))throw new Exception("Live updates must preserve selection and cards while updating RTT");
            Geometry();
            var bitmap=new RenderTargetBitmap(width,height,96,96,PixelFormats.Pbgra32);bitmap.Render(root);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using(var output=File.Create(Path.Combine(directory,"protocol-brands-"+width+".png")))encoder.Save(output);
            window.SetVerificationSnapshot(Snapshot(3.45,false));Layout();if(Cards().Any(c=>Equals(c.Tag,"protocol-card:Shure")))throw new Exception("Offline brand must disappear");
            results.Add(new{width,height,brands=3,receiverDeduplication=true,stableRefresh=true,selectedChannelPreserved=true,offlineHidden=true});window.Close();
        }
        File.WriteAllText(Path.Combine(directory,"protocol-verification.json"),JsonSerializer.Serialize(new{passed=true,scenes=results.Count,telemetrySemantics=true,networkRequests=0,deviceCommands=0,results}));
    }
}
