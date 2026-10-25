using System.Text.Json;
using Daty.Native.Core;

internal static class TransmitterCases
{
    private static Channel Make(string? tx = null, string? antenna = "XX", string? meter = "live",
        bool online = true, string model = "ULXD4", string[]? stale = null, string source = "shure-scp", double rf = -60)
        => Channel.Parse(JsonSerializer.SerializeToElement(new {
            id = "s1", receiver_id = "rx1", receiver_name = "接收机 A", name = "主唱通道", channel_number = 1, brand = "Shure", model, rf,
            _source = source, _online = online, status = online ? "online" : "offline",
            shure = new { schema = "daty-shure-telemetry-v1", transmitter_type = tx,
                transmitter_name = "手持 B", transmitter_firmware = "2.10.0.0", transmitter_muted = true, receiver_muted = false, battery_bars = 4,
                rf_antenna = antenna, meter_state = meter, stale_fields = stale ?? [] }
        }));

    private static void Expect(Channel c, string label)
    {
        if (TestMonitoringRules.Display(c).Label != label) throw new Exception("Expected " + label);
    }

    public static IEnumerable<(string Name, Action Run)> All()
    {
        yield return ("ULXD off noise crossing the RF threshold stays offline and never alarms", () => {
            var monitor=new LiveAlertMonitor(archiveEnabled:false,rules:TestMonitoringRules.Value);
            foreach(var rf in new[]{-88d,-94,-89,-92,-91,-95,-93,-90,-40}) {
                var c=Make("ULXD2","XX",rf:rf);var raw=c.Raw.GetRawText();
                Expect(c,"话筒离线");
                if(!TestMonitoringRules.Offline(c)||TestMonitoringRules.CardRf(c) is not null||TestMonitoringRules.Issues(c,new(Bars:5)).Count!=0||monitor.Observe([c],new(Bars:5),1000)!=0||monitor.Active.Count!=0||raw!=c.Raw.GetRawText())throw new Exception("Noise caused false recovery, cached battery warning or raw mutation");
            }
            Expect(Make(null,"AX",rf:-70),"话筒连接中");Expect(Make("ULXD1","XB",rf:-70),"话筒 ULXD1");
            if(TestMonitoringRules.Issues(Make("ULXD1","XB",rf:-70),new(Rf:-60)).All(i=>i.Metric!="rf"))throw new Exception("Real online weak signal was suppressed");
        });
        yield return ("Confirmed absence clears prior transmitter alarms instead of keeping them pending", () => {
            var monitor=new LiveAlertMonitor(archiveEnabled:false,rules:TestMonitoringRules.Value);
            monitor.Observe([Make("ULXD2","AX",rf:-70)],new(Rf:-60,Bars:5),1000);
            if(monitor.Active.Count!=2)throw new Exception("Expected genuine weak RF and low battery");
            var offline=Make("ULXD2","XX",rf:-88,stale:["battery_bars"]);
            if(monitor.Observe([offline],new(Rf:-60,Bars:5),2000)!=0||monitor.Active.Count!=0)throw new Exception("Old battery pending survived confirmed absence");
        });
        yield return ("Offline suppression preserves other channels and genuine receiver interference", () => {
            var raw=System.Text.Json.Nodes.JsonNode.Parse(Make("ULXD2","XX",rf:-88).Raw.GetRawText())!;
            raw["shure"]!["interference"]="DETECTED";
            var off=Channel.Parse(JsonSerializer.SerializeToElement(raw));
            var other=Make("ULXD2","AX",rf:-75) with{Id="other"};
            var monitor=new LiveAlertMonitor(archiveEnabled:false,rules:TestMonitoringRules.Value);
            monitor.Observe([off,other],new(Rf:-60),1000);
            if(monitor.Active.Count!=2||!monitor.Active.Any(a=>a.Issue.ChannelId=="other"&&a.Issue.Metric=="rf")||!monitor.Active.Any(a=>a.Issue.ChannelId==off.Id&&a.Issue.Metric=="rf_interference"))throw new Exception("Offline policy hid an independent real alarm");
        });
        yield return ("Hover separates receiver label channel label transmitter and output mute", () => {
            var tip=TestMonitoringRules.Display(Make("ULXD2","AX")).Tooltip;
            foreach(var text in new[]{"接收机标签：接收机 A","通道标签：主唱通道","话筒型号：ULXD2","话筒标签：手持 B","话筒固件：2.10.0.0","话筒静音：已静音","接收机输出：未静音","话筒电池：4/5 格"})
                if(!tip.Contains(text)) throw new Exception("Missing actual reported hover field: "+text);
        });
        yield return ("Hover never exposes cached transmitter identity without valid reception", () => {
            foreach(var c in new[]{Make("ULXD2","AX",rf:-95),Make("ULXD2","AX",meter:"stale"),Make("ULXD2","AX",online:false),Make("ULXD2","AX",stale:["transmitter_type"]),Make("ULXD2","XX")}) {
                var tip=TestMonitoringRules.Display(c).Tooltip;
                if(tip.Contains("ULXD2")||tip.Contains("手持 B")||tip.Contains("2.10.0.0")||tip.Contains("4/5"))throw new Exception("Cached transmitter identity leaked");
                if(!tip.Contains("接收机标签：接收机 A"))throw new Exception("Receiver identity lost");
            }
        });
        yield return ("Hover checks freshness of each slow field independently", () => {
            var tip=TestMonitoringRules.Display(Make("ULXD2","AX",stale:["transmitter_name","transmitter_firmware","transmitter_muted","battery_bars","name","muted"])).Tooltip;
            if(!tip.Contains("话筒型号：ULXD2")||tip.Contains("手持 B")||tip.Contains("2.10.0.0")||tip.Contains("未静音")||tip.Contains("4/5")||tip.Contains("主唱通道"))throw new Exception("Stale slow field presented as fresh");
        });
        yield return ("Hover recovers real identity after an unknown interval", () => {
            var values=new[]{Make("ULXD2","AX"),Make("ULXD2","AX",rf:-95),Make("ULXD1","XB")}.Select(c=>TestMonitoringRules.Display(c).Tooltip).ToArray();
            if(!values[0].Contains("话筒型号：ULXD2")||values[1].Contains("ULXD2")||!values[2].Contains("话筒型号：ULXD1"))throw new Exception("Hover recovery mismatch");
        });
        yield return ("ULXD confirmed-off fixture shows reception offline", () => Expect(Make(rf: -95), "话筒离线"));
        yield return ("RF absence clears previously reported transmitter model", () => Expect(Make("ULXD2", rf: -95), "话筒离线"));
        yield return ("Fresh RF and real model restore transmitter name", () => Expect(Make("ULXD2", "AX"), "话筒 ULXD2"));
        yield return ("RF returns before metadata without false offline", () => Expect(Make(null, "XB"), "话筒连接中"));
        yield return ("Unknown model markers never become model names", () => {
            foreach (var value in new[] { "", " ", "UNKN", "unknown", "—" }) Expect(Make(value, "AX"), "话筒连接中");
        });
        yield return ("Stale transmitter metadata waits for real recovery", () => Expect(Make("ULXD2", "AX", stale: ["transmitter_type"]), "话筒连接中"));
        yield return ("Stale antenna state cannot report offline or model", () => Expect(Make("ULXD2", "XX", stale: ["rf_antenna"]), "话筒状态未知"));
        yield return ("Meter absent stale and disconnected remain unknown", () => {
            foreach (var value in new string?[] { null, "stale", "disconnected" }) Expect(Make("ULXD2", "AX", value), "话筒状态未知");
        });
        yield return ("Receiver loss and projected stream loss do not infer power off", () => {
            Expect(Make(online: false), "话筒状态未知"); Expect(Make("ULXD2", "AX") with { Online = false }, "话筒状态未知");
        });
        yield return ("Antenna validity respects ULXD model", () => {
            Expect(Make("ULXD2", "AB"), "话筒状态未知"); Expect(Make("ULXD2", "AB", model: "ULXD4D"), "话筒 ULXD2");
            Expect(Make(antenna: null), "话筒状态未知"); Expect(Make(antenna: "OFF"), "话筒状态未知");
        });
        yield return ("User RF threshold takes priority over antenna and cached model", () => {
            Expect(Make("ULXD2", "AX", rf: -110), "话筒离线"); Expect(Make(rf: -20), "话筒离线");
        });
        yield return ("No ULXD assumptions or labels on other protocols", () => {
            Expect(Make(model: "AD4D"), "话筒型号未知"); Expect(Make("AD2", model: "AD4D"), "话筒 AD2"); Expect(Make(source: "fashe-mqtt"), "");
        });
        yield return ("Repeated off and recovery do not latch status or change receiver", () => {
            foreach (var c in new[] { Make(), Make(null,"AX"), Make("ULXD2","AX"), Make("ULXD2"), Make("ULXD1","XB") }) {
                var raw=c.Raw.GetRawText();_ = TestMonitoringRules.Display(c);
                if (!c.Online || raw!=c.Raw.GetRawText()) throw new Exception("Display altered reception evidence");
            }
            Expect(Make("ULXD1","XB"), "话筒 ULXD1");
            if (!TestMonitoringRules.Display(Make(rf: -95)).Tooltip.Contains("电源开关")) throw new Exception("Protocol limitation must be visible");
        });
    }
}
