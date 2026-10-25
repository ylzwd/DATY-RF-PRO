using System.Globalization;
using System.Text.Json;

namespace Daty.Native.Core;

// Immutable, validated memory snapshot of an actually committed DB document.
// There are deliberately no client defaults and no local-file fallback.
public sealed class MonitoringRules
{
    public const string DocumentId = "monitoring_display_rules";
    private readonly JsonElement value;
    private MonitoringRules(JsonElement value) { this.value = value.Clone(); }
    public JsonElement Document => value.Clone();
    public string Text(string category, string key) => value.GetProperty(category).GetProperty(key).GetString()
        ?? throw new InvalidDataException("数据库显示规则文字缺失");
    public double Number(string category, string key) => value.GetProperty(category).GetProperty(key).GetDouble();
    public string AlertLabel(string metric) => value.GetProperty("alerts").GetProperty("labels").GetProperty(metric).GetString()!;
    public string AlertLevel(string metric) => value.GetProperty("alerts").GetProperty("levels").GetProperty(metric).GetString()!;
    public double? AfFloor(Channel c) => value.GetProperty("signals").GetProperty("afFloors").Number(DisplayRules.IsShure(c.Raw)?c.Model:c.Brand);
    public string[] OverviewLabels => value.GetProperty("overview").GetProperty("labels").EnumerateArray().Select(e => e.GetString()!).ToArray();
    public double OfflineBelowDbm => Number("transmitter", "offlineBelowDbm");
    public bool SuppressOfflineAlert(Channel c,string metric) => TransmitterReception.IsOffline(c,this)
        && value.GetProperty("alerts").GetProperty("offlineSuppressedMetrics").EnumerateArray().Any(v=>v.GetString()==metric);
    public int PageSize => (int)Number("identity", "pageSize");
    public string Format(double? number, string category, string decimals, string unit)
        => number is double n && double.IsFinite(n) ? n.ToString((int)Number(category, decimals) is int precision && precision>0 ? "0."+new string('0',precision) : "0", CultureInfo.InvariantCulture) + (Text(category,unit).Length>0?" " + Text(category,unit):"") : Text("signals", "unknownText");
    public string Identity(Channel c) => (c.ActualGroupNumber is long g ? Text("identity","groupPrefix") + g : Text("signals","unknownText")) + " · " + Text("identity","channelPrefix") + (c.Number?.ToString() ?? Text("signals","unknownText"));
    public string Battery(Channel c)
    {
        if (c.Battery is double percent) return Format(percent,"signals","batteryDecimals","batteryUnit").Replace(" " + Text("signals","batteryUnit"),Text("signals","batteryUnit"));
        if (!DisplayRules.IsShure(c.Raw)) return Text("signals","unknownText");
        var s=c.Raw.Field("shure");
        if(DisplayRules.Fresh(c.Raw,"battery_bars")&&s.Number("battery_bars") is double bars&&bars>=0&&bars<=5&&Math.Truncate(bars)==bars)
            return Text("signals","batteryBarsText").Replace("{value}",bars.ToString("0",CultureInfo.InvariantCulture));
        if(DisplayRules.Fresh(c.Raw,"battery_minutes")&&s.Number("battery_minutes") is double minutes&&minutes>=0&&minutes<=65532&&Math.Truncate(minutes)==minutes)
            return Text("signals","batteryMinutesText").Replace("{value}",minutes.ToString("0",CultureInfo.InvariantCulture));
        return s.Field("stale_fields").ValueKind==JsonValueKind.Array&&s.Field("stale_fields").EnumerateArray().Any(e=>e.Text()?.StartsWith("battery_",StringComparison.Ordinal)==true)?Text("signals","staleText"):Text("signals","unknownText");
    }
    public static MonitoringRules Parse(JsonElement value)
    {
        if(value.Text("schema")!="daty-monitoring-display-v2")throw new InvalidDataException("数据库显示规则版本不受支持");
        var r=new MonitoringRules(value);
        foreach(var (category,keys) in new[]{
            ("overview","receiverCount channelCount centerFrequency brandVisibility"),
            ("identity","order groupPrefix channelPrefix receiverPrefix brandSource modelSource onlineText offlineText warningText brandFilter muteBadgeSource muteControl mutedText muteActionText unmuteActionText muteUnknownText commandPendingText"),
            ("frequency","source unit usageSource usageAlignment"),
            ("signals","source unknownText rfUnit afUnit batteryUnit batterySource batteryBarsText batteryMinutesText staleText"),
            ("transmitter","comparison recovery unknownRf modelSource alignment offlineText unknownText modelUnknownText connectingText modelPrefix"),
            ("alerts","thresholdSource soundSource unchanged lifecycle history offlineLevel pendingText")})
            foreach(var key in keys.Split(' ')) {var s=r.Text(category,key);if(string.IsNullOrWhiteSpace(s)||s.Length>100||s.Any(char.IsControl))throw new InvalidDataException("数据库显示规则文字无效");}
        foreach(var (cat,key,lo,hi) in new[]{("overview","rfMinDbm",-150d,-1d),("overview","rfMaxDbm",-149d,20d),("signals","rfMinDbm",-150d,-1d),("signals","rfMaxDbm",-149d,20d),("transmitter","offlineBelowDbm",-150d,-30d),("identity","pageSize",1d,100d),("frequency","decimals",0d,6d),("signals","rfDecimals",0d,3d),("signals","afDecimals",0d,3d),("signals","batteryDecimals",0d,2d)}) {
            var n=r.Number(cat,key);if(!double.IsFinite(n)||n<lo||n>hi||((key=="pageSize"||key.EndsWith("ecimals"))&&n!=Math.Truncate(n)))throw new InvalidDataException("数据库显示规则数字无效");
        }
        foreach(var cat in new[]{"overview","signals"})if(r.Number(cat,"rfMinDbm")>=r.Number(cat,"rfMaxDbm"))throw new InvalidDataException("RF显示范围无效");
        foreach(var (cat,key,expected) in new[]{("overview","receiverCount","online-deduplicated-receiver"),("overview","channelCount","receiver-online-channels"),("overview","centerFrequency","planning-range-midpoint"),("overview","brandVisibility","online-only"),("identity","order","numeric-group-channel"),("identity","brandSource","reported"),("identity","modelSource","reported"),("frequency","source","reported-khz"),("frequency","usageSource","frequency_planning.locks.note"),("frequency","usageAlignment","right"),("signals","source","current-valid-telemetry"),("signals","batterySource","percent-then-bars-then-runtime"),("transmitter","comparison","lt"),("transmitter","recovery","fresh-valid-reception"),("transmitter","offlineEvidence","fresh-rf-or-ulxd-no-reception"),("transmitter","unknownRf","pending-not-recovered"),("transmitter","modelSource","current-reported"),("transmitter","alignment","right"),("alerts","thresholdSource","alert_thresholds"),("alerts","soundSource","alert_sound"),("alerts","unchanged","last-seen-only"),("alerts","lifecycle","distinct-recovery-retrigger"),("alerts","history","memory-only")})
            if(r.Text(cat,key)!=expected)throw new InvalidDataException("数据库显示规则包含未支持的数据来源或判断方式");
        foreach(var (cat,key) in new[]{("signals","hideRfWhenOffline"),("signals","hideRfWhenUnknown"),("transmitter","requireFresh"),("alerts","offlineReplacesRfWeak")})
            if(value.GetProperty(cat).GetProperty(key).ValueKind!=JsonValueKind.True)throw new InvalidDataException("数据库显示规则不可关闭有效性保护");
        if(r.OverviewLabels.Length!=4||r.OverviewLabels.Any(string.IsNullOrWhiteSpace))throw new InvalidDataException("数据库统计卡标题缺失");
        foreach(var metric in new[]{"transmitter_offline","rf","af","battery","battery_bars","battery_error","rf_interference","rf_interference_secondary","encryption_mismatch","unregistered_transmitter"})
            if(string.IsNullOrWhiteSpace(r.AlertLabel(metric)))throw new InvalidDataException("数据库告警名称缺失");
        if(r.Text("alerts","offlineLevel") is not ("warn" or "crit"))throw new InvalidDataException("数据库告警级别无效");
        foreach(var metric in new[]{"rf","af","battery","battery_bars","battery_error","rf_interference","rf_interference_secondary","encryption_mismatch","unregistered_transmitter"})
            if(r.AlertLevel(metric) is not ("warn" or "crit"))throw new InvalidDataException("数据库告警分类级别无效");
        foreach(var (model,floor) in new[]{("DATYaudio",-40d),("ULXD4",-50d),("ULXD4D",-50d),("ULXD4Q",-50d),("AD4D",-120d),("AD4Q",-120d)})
            if(value.GetProperty("signals").GetProperty("afFloors").Number(model)!=floor)throw new InvalidDataException("数据库AF量程不符合已支持协议");
        if(r.Text("identity","brandFilter")!="installed-plugins"||r.Text("identity","muteBadgeSource")!="fresh-receiver-or-transmitter"||r.Text("identity","muteControl")!="receiver-output-real-confirmation")throw new InvalidDataException("数据库品牌或控制规则无效");
        var suppressed=value.GetProperty("alerts").GetProperty("offlineSuppressedMetrics").EnumerateArray().Select(v=>v.GetString()).ToArray();
        if(!suppressed.SequenceEqual(new[]{"transmitter_offline","rf","af","battery","battery_bars","battery_error","encryption_mismatch","unregistered_transmitter"}))throw new InvalidDataException("数据库离线告警策略不受支持");
        return r;
    }
}
