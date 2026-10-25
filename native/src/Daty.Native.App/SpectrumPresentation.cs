using Daty.Native.Core;

namespace Daty.Native.App;

// Display-only rules shared by the spectrum view and its offline verification.
// These never change a receiver's frequency or the persisted planning range.
internal static class SpectrumPresentation
{
    internal static Channel[] Visible(IEnumerable<Channel> channels, double start, double end) =>
        channels.Where(c => c.Online && c.FrequencyKHz.HasValue && c.FrequencyKHz >= start * 1000 && c.FrequencyKHz <= end * 1000).ToArray();

    internal static int Count(IEnumerable<Channel> channels, double start, double end) =>
        Visible(channels, start, end).Select(c => c.FrequencyKHz).Distinct().Count();

    internal static (double Start, double End)? Fit(IEnumerable<Channel> channels)
    {
        var frequencies = channels.Where(c => c.Online && c.FrequencyKHz.HasValue).Select(c => c.FrequencyKHz!.Value).Distinct().Order().ToArray();
        if (frequencies.Length == 0) return null;
        var padding = frequencies.Length > 1 ? (frequencies[^1] - frequencies[0]) / (frequencies.Length - 1d) / 2 : 1000;
        return (Math.Max(0, Math.Floor(frequencies[0] - padding)) / 1000, Math.Ceiling(frequencies[^1] + padding) / 1000);
    }

    // Preserve first/last/min/max in input order, including narrow model peaks.
    // Hover must use this same rendered path, not another interpolation.
    internal static IReadOnlyList<ScanPoint> Reduce(IReadOnlyList<ScanPoint> points, double start, double end, double width)
    {
        var pixels = Math.Max(1, (int)width);
        if (end <= start || points.Count <= pixels * 4) return points;
        var result = new List<ScanPoint>();
        int bucket = -1, first = 0, last = 0, low = 0, high = 0;
        void Flush() { foreach (var i in new[] { first, low, high, last }.Distinct().Order()) result.Add(points[i]); }
        for (int i = 0; i < points.Count; i++)
        {
            var pixel = Math.Clamp((int)Math.Floor((points[i].FrequencyKHz / 1000d - start) / (end - start) * pixels), 0, pixels - 1);
            if (pixel != bucket) { if (bucket >= 0) Flush(); bucket = pixel; first = last = low = high = i; }
            else { last = i; if (points[i].LevelDbm < points[low].LevelDbm) low = i; if (points[i].LevelDbm > points[high].LevelDbm) high = i; }
        }
        if (bucket >= 0) Flush();
        return result;
    }
}
