using System.Text.Json;
using System.Text.Json.Nodes;

namespace Daty.Native.Core;

// A short-lived display projection of a validated independent Shure readback.
// RF packets with older mute metadata cannot undo it. Newer mute data always wins.
public sealed class ConfirmedMuteView
{
    private sealed record Entry(string Identity, string Stream, bool Muted, double At, long Expires);
    private readonly Dictionary<string, Entry> entries = [];
    private static string Identity(Channel c) => JsonSerializer.Serialize(new { c.Id, c.ReceiverId, c.Ip, c.Number, mac=c.Raw.Text("receiver_mac"), source=c.Raw.Text("_source"), c.Brand });
    public void Clear() => entries.Clear();

    public void Accept(Channel channel, JsonElement receipt, JsonElement intent, long now)
    {
        CommandRules.ValidateReceipt(receipt, intent);
        if (!DisplayRules.IsShure(channel.Raw) || receipt.Text("state") != "readback_confirmed" || intent.Text("command") is not ("mute" or "unmute")) return;
        var stream = channel.Raw.Field("shure").Text("meter_stream_id");
        var at = receipt.Field("execution_evidence").Number("received_at_ms");
        if (string.IsNullOrEmpty(stream) || at is null || at <= 0) return;
        var target=intent.Field("target");
        if(target.Text("device_id")!=channel.Id || target.Text("receiver_session_id")!=stream || target.Number("channel_number")!=channel.Number) return;
        if (entries.Count >= 256 && !entries.ContainsKey(channel.Id)) entries.Remove(entries.Keys.First());
        entries[channel.Id] = new(Identity(channel), stream, intent.Field("expected_value").True(), at.Value, now + 15000);
    }

    public Channel Apply(Channel channel, long now)
    {
        if (!entries.TryGetValue(channel.Id, out var entry)) return channel;
        var shure=channel.Raw.Field("shure");
        if (!channel.Online || now >= entry.Expires || Identity(channel) != entry.Identity ||
            shure.Text("meter_stream_id") != entry.Stream || shure.Field("field_times").Number("muted") >= entry.At)
        { entries.Remove(channel.Id); return channel; }
        var raw=JsonNode.Parse(channel.Raw.GetRawText())!.AsObject();
        raw["muted"]=entry.Muted;
        if(raw["shure"] is JsonObject details) details["receiver_muted"]=entry.Muted;
        return channel with { Muted=entry.Muted, Raw=JsonSerializer.SerializeToElement(raw) };
    }
}
