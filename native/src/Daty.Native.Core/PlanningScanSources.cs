using System.Globalization;
using System.Text.Json.Serialization;

namespace Daty.Native.Core;

/// <summary>A measured above-threshold peak, not an identified transmitter or receiver.</summary>
public sealed record PlanningScanCarrier(
    [property: JsonPropertyName("frequencyKHz")] int FrequencyKHz,
    [property: JsonPropertyName("levelDbm")] double LevelDbm,
    [property: JsonPropertyName("startKHz")] int StartKHz,
    [property: JsonPropertyName("endKHz")] int EndKHz)
{
    [JsonPropertyName("id")]
    public string Id => "scan-peak:" + FrequencyKHz.ToString(CultureInfo.InvariantCulture);

    [JsonPropertyName("source")]
    public string Source => "scan-peak";
}

/// <summary>Builds IMD inputs from the same measured peak runs displayed by the spectrum plot.</summary>
public static class PlanningScanSources
{
    public static IReadOnlyList<PlanningScanCarrier> Extract(ScanDocument? scan, double peakThresholdDbm)
        => ExtractMany(scan is null ? [] : [scan], peakThresholdDbm);

    public static IReadOnlyList<PlanningScanCarrier> ExtractMany(IEnumerable<ScanDocument> scans, double peakThresholdDbm)
    {
        ArgumentNullException.ThrowIfNull(scans);
        if (!double.IsFinite(peakThresholdDbm)) throw new ArgumentOutOfRangeException(nameof(peakThresholdDbm));
        var carriers = new Dictionary<int, PlanningScanCarrier>();
        foreach (var scan in scans)
        {
            ArgumentNullException.ThrowIfNull(scan);
            var segments = ScanThresholdAnalysis.Segments(
                scan.Points, scan.TraceSegments, scan.SampleStepKHz ?? ScanThresholdAnalysis.DefaultMaxGapKHz);
            foreach (var run in ScanThresholdAnalysis.Runs(segments, peakThresholdDbm))
            {
                var frequency = run.Peak.FrequencyKHz;
                var carrier = new PlanningScanCarrier(frequency, run.Peak.LevelDbm, run.StartKHz, run.EndKHz);
                if (carriers.TryGetValue(frequency, out var previous))
                    carrier = carrier with
                    {
                        LevelDbm = Math.Max(previous.LevelDbm, carrier.LevelDbm),
                        StartKHz = Math.Min(previous.StartKHz, carrier.StartKHz),
                        EndKHz = Math.Max(previous.EndKHz, carrier.EndKHz)
                    };
                carriers[frequency] = carrier;
            }
        }
        // Exact measured integer kHz are retained; device tuning grids must not move an IMD source.
        return carriers.Values.OrderBy(carrier => carrier.FrequencyKHz).ToArray();
    }
}
