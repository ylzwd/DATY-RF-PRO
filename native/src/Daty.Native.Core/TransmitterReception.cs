namespace Daty.Native.Core;

// User-defined reception rule, not a measurement of the transmitter's power
// switch. Keep the raw telemetry and receiver's network status unchanged.
public static class TransmitterReception
{

    public static double? CurrentRf(Channel channel)
    {
        if (!channel.Online) return null;
        if (DisplayRules.IsShure(channel.Raw) &&
            (channel.Raw.Field("shure").Text("meter_state") != "live" ||
             !DisplayRules.Fresh(channel.Raw, "rf_dbm"))) return null;
        return channel.RfDbm;
    }

    public static bool IsUlxd(Channel channel) => DisplayRules.IsShure(channel.Raw) && channel.Model is "ULXD4" or "ULXD4D" or "ULXD4Q";
    public static bool NoReception(Channel channel, MonitoringRules? rules = null) => rules is not null
        && rules.Text("transmitter","offlineEvidence")=="fresh-rf-or-ulxd-no-reception"
        && channel.Online && IsUlxd(channel) && channel.Raw.Field("shure").Text("meter_state")=="live"
        && DisplayRules.Fresh(channel.Raw,"rf_antenna") && channel.Raw.Field("shure").Text("rf_antenna")=="XX";
    public static bool IsOffline(Channel channel, MonitoringRules? rules = null) => rules is not null
        && (NoReception(channel,rules) || CurrentRf(channel) is double rf && rf < rules.OfflineBelowDbm);
    public static double? CardRf(Channel channel, MonitoringRules? rules = null) => rules is null || IsOffline(channel, rules) ? null : CurrentRf(channel);
}
