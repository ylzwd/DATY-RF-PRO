using System.Globalization;
using System.Text.Json;

namespace Daty.Native.Core;

// Display-only interpretation of the current web telemetry contract. Never
// changes receiver identity, sends a command or turns unknown data into zero.
public static class DisplayRules
{
    private static readonly string[] Offline = ["offline","disconnected","disconnect","connection_lost","connection-lost","timeout","unavailable","lost","false","no"];
    public static double? Numeric(JsonElement v) => v.Number() ?? (v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString()) && double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && double.IsFinite(d) ? d : null);
    public static double? Metric(JsonElement v,double min,double max) => Numeric(v) is double n && n>=min && n<=max?n:null;
    public static bool Online(JsonElement e) {
        var flag=e.Field("_online");var text=flag.Text()?.Trim().ToLowerInvariant();var status=e.Text("status")?.Trim().ToLowerInvariant()??"";
        if(flag.ValueKind==JsonValueKind.False || text=="0" || text=="false" || text is not null && Offline.Contains(text) || Offline.Contains(status))return false;
        return status.Length==0 ? flag.True() || e.Text("_source") is {Length:>0} || e.Field("_serverManaged").True() || e.Text("_fasheId") is {Length:>0} : status is "online" or "warn" or "0" or "1";
    }
    public static bool Fresh(JsonElement e,string key) {
        var stale=e.Field("shure").Field("stale_fields");
        return Online(e) && (stale.ValueKind!=JsonValueKind.Array || !stale.EnumerateArray().Any(v=>v.Text()==key));
    }
    public static bool IsShure(JsonElement e)=>e.Text("_source")=="shure-scp" && e.Text("brand")=="Shure" && e.Field("shure").Text("schema")=="daty-shure-telemetry-v1";
    public static double? Af(JsonElement e) {
        var shure=e.Field("shure");
        if(IsShure(e)) {
            if(!Online(e) || shure.Text("meter_state") is string state && state!="live")return null;
            var floor=e.Text("model") switch {"ULXD4" or "ULXD4D" or "ULXD4Q"=>-50,"AD4D" or "AD4Q"=>-120,_=>double.NaN};
            return double.IsFinite(floor)?Metric(shure.Field("audio_dbfs"),floor,0):null;
        }
        foreach(var key in new[]{"afDbfs","af_dbfs","afLevel","af_level"})if(e.Field(key).ValueKind!=JsonValueKind.Undefined)return Metric(e.Field(key),-40,0);
        var value=Numeric(e.Field("af"));if(value is not double a)return null;
        var realtime=e.Text("_source") is {Length:>0} || e.Text("_fasheId") is {Length:>0} || e.Field("_thresholdStatusManaged").True() || e.Text("afUnit")=="dBFS" || e.Text("af_unit")=="dBFS";
        if(a<0 || realtime)return a>=-40&&a<=0?a:null;
        return a<=100?-40+a*.4:null;
    }
}

public sealed record AlertThresholds(double Rf=-90,double Battery=20,double Bars=1,double Af=-3);
public sealed record LiveIssue(string Key,string ChannelId,string Metric,string Level,string Message,double? Value,double? Threshold);
public static class LiveIssues
{
    public static IReadOnlyList<LiveIssue> Evaluate(Channel c,AlertThresholds t,MonitoringRules? rules=null) {
        var issues=new List<LiveIssue>();if(!c.Online||rules is null)return issues;
        var name=$"{c.Ip} · {rules.Identity(c)} · {c.Brand} {c.Model}";
        void Add(string metric,double? value,double? threshold,string unit){if(!rules.SuppressOfflineAlert(c,metric))issues.Add(new(c.Id+":"+metric,c.Id,metric,rules.AlertLevel(metric),$"{rules.AlertLabel(metric)}：{name}"+(value.HasValue?$" 当前 {value:0.#}{unit}（阈值 {threshold:0.#}{unit}）":""),value,threshold));}
        if(TransmitterReception.IsOffline(c,rules) && !rules.SuppressOfflineAlert(c,"transmitter_offline"))
            issues.Add(new(c.Id+":transmitter_offline",c.Id,"transmitter_offline",rules.Text("alerts","offlineLevel"),$"{rules.AlertLabel("transmitter_offline")}：{name}（RF 低于 {rules.OfflineBelowDbm:0.###} dBm）",null,rules.OfflineBelowDbm));
        else if(TransmitterReception.CurrentRf(c) is double rf && rf<=t.Rf)Add("rf",rf,t.Rf," dBm");
        if(c.Battery is double battery && battery<=t.Battery)Add("battery",battery,t.Battery,"%");
        if(c.AfDbfs is double af && af>=t.Af)Add("af",af,t.Af," dBFS");
        if(!DisplayRules.IsShure(c.Raw))return issues;var s=c.Raw.Field("shure");
        if(c.Battery is null && s.Number("battery_bars") is double bars && Math.Truncate(bars)==bars && bars>=0 && bars<=5 && bars<=t.Bars && DisplayRules.Fresh(c.Raw,"battery_bars"))Add("battery_bars",bars,t.Bars," 格");
        foreach(var (field,metric,positive) in new[]{("battery_runtime_status","battery_error",new[]{"error"}),("interference","rf_interference",new[]{"CRITICAL","DETECTED"}),("interference_secondary","rf_interference_secondary",new[]{"DETECTED"}),("encryption_warning","encryption_mismatch",new[]{"ON","ERROR"}),("unregistered_transmitter","unregistered_transmitter",new[]{"ERROR"})})
            if(DisplayRules.Fresh(c.Raw,field) && positive.Contains(s.Text(field)))Add(metric,null,null,"");
        return issues;
    }
}
