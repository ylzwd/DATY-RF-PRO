using System.Text.Json;
using System.Text.Json.Nodes;
using Daty.Native.Core;

internal static class SpectrumRfCases
{
    private static Channel Make(double? rf = -60, string? antenna = "AX", string meter = "live", string[]? stale = null,
        bool online = true, string model = "ULXD4", bool shure = true) => Channel.Parse(JsonSerializer.SerializeToElement(new {
            id = "spectrum-rf", receiver_id = "rx", receiver_ip = "192.0.2.16", channel_number = 1, freq = 632700,
            brand = shure ? "Shure" : "DATYaudio", model, rf, _source = shure ? "shure-scp" : "fashe-mqtt",
            _online = online, status = online ? "online" : "offline",
            shure = new { schema = "daty-shure-telemetry-v1", meter_state = meter, rf_antenna = antenna, stale_fields = stale ?? [] }
        }));
    private static void Check(bool value) { if (!value) throw new Exception("Spectrum RF projection failed"); }
    public static IEnumerable<(string Name, Action Run)> All()
    {
        yield return ("Spectrum XX noise never becomes a live RF height or rewrites source measurements", () => {
            foreach (var rf in new[] { -100d, -85, -60, -40, -100, -60 }) {
                var channel = Make(rf, "XX"); var raw = channel.Raw.GetRawText();
                var display = SpectrumRfPresentation.For(channel, TestMonitoringRules.Value);
                Check(display.IsOffline && display.RfDbm is null && channel.RfDbm == rf && channel.Online
                    && channel.FrequencyKHz == 632700 && channel.Raw.GetRawText() == raw);
            }
            Check(SpectrumRfPresentation.For(Make(-40, "XX", stale: ["rf_dbm"]), TestMonitoringRules.Value).IsOffline);
        });
        yield return ("Spectrum uses fresh reception to recover and rejects stale or invalid ULXD antennas", () => {
            foreach (var antenna in new[] { "AX", "XB" }) {
                var display = SpectrumRfPresentation.For(Make(-60, antenna), TestMonitoringRules.Value);
                Check(!display.IsOffline && display.RfDbm == -60);
            }
            foreach (var channel in new[] { Make(antenna: null), Make(antenna: "OFF"), Make(antenna: "AB"),
                Make(antenna: "XX", stale: ["rf_antenna"]), Make(stale: ["rf_dbm"]), Make(meter: "stale"), Make(rf: null), Make(online: false) }) {
                var display = SpectrumRfPresentation.For(channel, TestMonitoringRules.Value);
                Check(!display.IsOffline && display.RfDbm is null);
            }
            foreach (var model in new[] { "ULXD4D", "ULXD4Q" })
                Check(SpectrumRfPresentation.For(Make(antenna: "AB", model: model), TestMonitoringRules.Value).RfDbm == -60);
            Check(SpectrumRfPresentation.For(Make(antenna: "XX", model: "AD4D"), TestMonitoringRules.Value).RfDbm == -60);
        });
        yield return ("Spectrum has no default threshold before database rules arrive", () => {
            foreach (var channel in new[] { Make(-40, "XX"), Make(), Make(-95, shure: false) }) {
                var display = SpectrumRfPresentation.For(channel, null);
                Check(!display.IsOffline && display.RfDbm is null);
            }
        });
        yield return ("Spectrum strictly follows a changed database offline threshold across brands", () => {
            var document = JsonNode.Parse(TestMonitoringRules.Value.Document.GetRawText())!;
            document["transmitter"]!["offlineBelowDbm"] = -100;
            var rules = MonitoringRules.Parse(JsonSerializer.SerializeToElement(document));
            foreach (var shure in new[] { true, false }) foreach (var rf in new[] { -100.001, -100, -95, -90, -40 }) {
                var display = SpectrumRfPresentation.For(Make(rf, shure: shure), rules);
                Check(display.IsOffline == (rf < -100) && display.RfDbm == (rf < -100 ? null : rf));
            }
            Check(SpectrumRfPresentation.For(Make(-95), TestMonitoringRules.Value).IsOffline);
            Check(SpectrumRfPresentation.For(Make(-90), TestMonitoringRules.Value).RfDbm == -90);
        });
    }
}
