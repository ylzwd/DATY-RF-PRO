using System.Globalization;
using System.Text.Json;

namespace Daty.Native.Core;

public static class Wire
{
    public static JsonElement Field(this JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v : default;
    public static string? Text(this JsonElement e) => e.ValueKind switch { JsonValueKind.String => e.GetString(), JsonValueKind.Number => e.GetRawText(), _ => null };
    public static string? Text(this JsonElement e, string name) => e.Field(name).Text();
    public static double? Number(this JsonElement e) => e.ValueKind == JsonValueKind.Number && e.TryGetDouble(out var v) && double.IsFinite(v) ? v : null;
    public static double? Number(this JsonElement e, string name) => e.Field(name).Number();
    public static double? Metric(this JsonElement e, string name, double min, double max) => e.Number(name) is double n && n >= min && n <= max ? n : null;
    public static bool True(this JsonElement e) => e.ValueKind == JsonValueKind.True || e.ValueKind == JsonValueKind.Number && e.GetRawText() == "1" || e.ValueKind == JsonValueKind.String && e.GetString() is "true" or "1";
    public static string Format(double? value, string format = "0.#", string unit = "") => value is double n && double.IsFinite(n) ? n.ToString(format, CultureInfo.InvariantCulture) + unit : "—";
    public static string LocalTime(double? seconds) { try { return seconds is double t ? DateTimeOffset.FromUnixTimeMilliseconds(checked((long)(t * 1000))).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") : "—"; } catch { return "—"; } }
}

public sealed record Channel(string Id, string ReceiverId, string Name, string Brand, string Model,
    string Ip, int? Number, string Group, int? FrequencyKHz, double? RfDbm, double? AfDbfs,
    double? Battery, bool? Muted, bool Online, double? RttMs, string RttState, JsonElement Raw)
{
    // Same trusted source and numeric rules as the server web views. GROUP is
    // display order only; it must never become receiver or command identity.
    public long? ActualGroupNumber => ChannelOrder.ReadGroup(Raw);
    public string DisplayReceiverKey
    {
        get
        {
            foreach(var key in new[]{"receiver_mac","receiverMac","mac_address","mac"})
            {
                var mac=new string((Raw.Text(key)??"").Where(Uri.IsHexDigit).ToArray());
                if(mac.Length==12)return "mac:"+mac.ToLowerInvariant();
            }
            if(System.Net.IPAddress.TryParse(Ip,out var address))return "ip:"+address;
            return "id:"+System.Text.RegularExpressions.Regex.Replace(ReceiverId,@"[_-]ch\d+$","",System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        }
    }
    public string ChannelLabel => Number is int n ? "CH" + n : "CH —";
    public string Frequency => Wire.Format(FrequencyKHz / 1000.0, "0.000");
    public string Rf => Wire.Format(RfDbm, "0.#", " dBm");
    public string Af => Wire.Format(AfDbfs, "0.#", " dBFS");
    public string BatteryLabel {get {
        if(Battery is not null)return Wire.Format(Battery,"0","%");if(!DisplayRules.IsShure(Raw))return "—";var s=Raw.Field("shure");
        if(DisplayRules.Fresh(Raw,"battery_bars")&&s.Number("battery_bars") is double bars&&bars>=0&&bars<=5&&Math.Truncate(bars)==bars)return $"{bars:0}/5 格";
        if(DisplayRules.Fresh(Raw,"battery_minutes")&&s.Number("battery_minutes") is double minutes&&minutes>=0&&minutes<=65532&&Math.Truncate(minutes)==minutes)return $"{minutes:0}分";
        var stale=s.Field("stale_fields");return stale.ValueKind==JsonValueKind.Array&&stale.EnumerateArray().Any(v=>v.Text()?.StartsWith("battery_",StringComparison.Ordinal)==true)?"已过期":"—";
    }}
    public string MuteLabel => Muted switch { true => "已静音", false => "未静音", _ => "—" };
    public string Transmitter => DisplayRules.IsShure(Raw) && DisplayRules.Fresh(Raw,"transmitter_type") ? Raw.Field("shure").Text("transmitter_type") ?? "—" : "—";
    public string OnlineLabel => Online ? "在线" : "离线";
    public string Rtt => RttState == "measured" && Online ? Wire.Format(RttMs, "0.00", " ms") : "—";
    public bool Alert => Online && (RfDbm is <= -80 || AfDbfs is >= -3 || Battery is <= 20);

    public static Channel Parse(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Object) throw new InvalidDataException("通道记录格式错误");
        var id = e.Text("id");
        if (string.IsNullOrWhiteSpace(id)) throw new InvalidDataException("通道缺少稳定 ID");
        string First(params string[] names) => names.Select(name => e.Text(name)).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x)) ?? "";
        int? Int(string name, int min, int max) => e.Number(name) is double v && v >= min && v <= max && Math.Truncate(v) == v ? (int)v : null;
        var ip = First("receiver_ip", "ip");
        var receiver = First("receiver_id", "receiver_mac");
        if (receiver.Length == 0) receiver = ip.Length > 0 ? "ip:" + ip : "unresolved:" + id;
        var status = e.Text("status")?.ToLowerInvariant();
        var online = DisplayRules.Online(e);
        var heartbeat = e.Field("heartbeat");
        var hStatus = heartbeat.Text("status") ?? "unmeasured";
        var age = heartbeat.Number("age_ms");
        var maxAge = heartbeat.Number("max_age_ms");
        if (hStatus == "measured" && (age is null || maxAge is null || age < 0 || age > maxAge)) hStatus = "stale";
        var muted = e.Field("muted");
        var af = DisplayRules.Af(e);
        var groupNumber = ChannelOrder.ReadGroup(e);
        return new(id, receiver, First("name"), First("brand"), First("model"), ip, Int("channel_number", 1, 128) ?? Int("channel", 1, 128),
            groupNumber.HasValue ? "GUP" + groupNumber : "—", Int("freq", 30000, 3000000),
            DisplayRules.Metric(e.Field("rf"), -150, 20), af, DisplayRules.IsShure(e) && !DisplayRules.Fresh(e,"battery_percent") ? null : DisplayRules.Metric(e.Field("batt"), 0, 100),
            muted.ValueKind == JsonValueKind.True ? true : muted.ValueKind == JsonValueKind.False ? false : null,
            online, hStatus == "measured" ? heartbeat.Metric("rtt_ms", 0, 600000) : null, hStatus, e.Clone());
    }
}

public static class ChannelOrder
{
    public static long? ReadGroup(JsonElement raw)
    {
        if (raw.Text("group_source") != "server-fifo-v1") return null;
        var value = raw.Field("group_number");
        const long maximum = 9007199254740991; // JavaScript safe integer contract.
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) &&
            double.IsFinite(number) && number > 0 && number <= maximum && Math.Truncate(number) == number)
            return (long)number;
        if (value.ValueKind == JsonValueKind.String && value.GetString() is string text && text.Length > 0 &&
            text.All(c => c is >= '0' and <= '9') && long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed > 0 && parsed <= maximum)
            return parsed;
        return null;
    }

    // LINQ OrderBy/ThenBy are stable; missing values follow known values.
    // Sort the complete collection before any view applies pagination.
    public static Channel[] Sort(IEnumerable<Channel> channels) => channels
        .OrderBy(c => c.ActualGroupNumber ?? long.MaxValue)
        .ThenBy(c => c.Number ?? int.MaxValue).ToArray();
}

public sealed record DeviceSnapshot(IReadOnlyList<Channel> Channels, DateTimeOffset ReceivedAt, double? ServerTimeMs, JsonElement Raw)
{
    public static DeviceSnapshot Parse(JsonElement root)
    {
        if (!root.Field("success").True() || root.Field("devices").ValueKind != JsonValueKind.Array) throw new InvalidDataException("服务器没有返回有效设备快照");
        var channels = root.Field("devices").EnumerateArray().Select(Channel.Parse).ToArray();
        if (channels.Length > 10000 || channels.Select(c => c.Id).Distinct(StringComparer.Ordinal).Count() != channels.Length) throw new InvalidDataException("设备快照包含重复 ID 或超出上限");
        return new(channels, DateTimeOffset.UtcNow, root.Number("server_time_ms"), root.Clone());
    }
}

public sealed class LiveState
{
    private readonly object gate = new();
    private long generation;
    public DeviceSnapshot? Snapshot { get; private set; }
    public bool Connected { get; private set; }
    public long SwitchTarget() { lock (gate) { Snapshot = null; Connected = false; return ++generation; } }
    public bool Apply(long token, DeviceSnapshot snapshot) { lock (gate) { if (token != generation) return false; Snapshot = snapshot; Connected = true; return true; } }
    public bool Fail(long token) { lock (gate) { if (token != generation) return false; Connected = false; return true; } }
    public void ClearCached(){lock(gate)Snapshot=null;}
    public IReadOnlyList<Channel> DisplayChannels => ChannelOrder.Sort(Snapshot?.Channels.Select(c => Connected ? c : c with { Online = false, RttMs = null, RttState = "stale" }) ?? []);
}

public sealed record ScanPoint(int FrequencyKHz, double LevelDbm);
public sealed record ScanDocument(string FileName, string Sha256, IReadOnlyList<ScanPoint> Points, int DuplicateRows, JsonElement Raw)
{
    public string SourceLabel { get; init; } = "CSV";
    public string? RecordLabel { get; init; }
    public int MissingPoints { get; init; }
    public int? SampleStepKHz { get; init; }
    public int? GridStartKHz { get; init; }
    public int? GridEndKHz { get; init; }
    public IReadOnlyList<IReadOnlyList<ScanPoint>>? TraceSegments { get; init; }
    public int SlotCount => Points.Count + MissingPoints;
    public string SelectionLabel => RecordLabel ?? SourceLabel;
    public override string ToString() => SelectionLabel;
    public string Summary => $"{SourceLabel}{(RecordLabel is null ? "" : " · " + RecordLabel)} · {Points.Count:N0} 点" + (MissingPoints > 0 ? $" · 缺失 {MissingPoints:N0}" : "");
}
public sealed record ProjectItem(string Id, string Name, string UpdatedAt);
public sealed record TimelineRow(string Time, string Type, string Target, string Summary, string Details);
public sealed record PlanningRow(string Time, string Name, string Channels, string Algorithm, string Conflicts, string Margin);
