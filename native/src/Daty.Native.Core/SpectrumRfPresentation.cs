namespace Daty.Native.Core;

// A display projection only: a missing RF is a frequency placeholder, never
// a measured value at the bottom of the spectrum axis.
public readonly record struct SpectrumRfPresentation(double? RfDbm, bool IsOffline)
{
    public static SpectrumRfPresentation For(Channel channel, MonitoringRules? rules)
    {
        if (rules is null || !channel.Online) return new(null, false);
        if (TransmitterReception.IsOffline(channel, rules)) return new(null, true);
        var rf = TransmitterReception.CurrentRf(channel);
        if (rf is not double value || !double.IsFinite(value)) return new(null, false);
        if (TransmitterReception.IsUlxd(channel))
        {
            var antenna = channel.Raw.Field("shure").Text("rf_antenna");
            // Match the supported ULXD reception states used by transmitter display.
            if (!DisplayRules.Fresh(channel.Raw, "rf_antenna") ||
                !(antenna is "AX" or "XB" || antenna == "AB" && channel.Model != "ULXD4"))
                return new(null, false);
        }
        return new(value, false);
    }
}
