namespace Daty.Native.Core;

public sealed record ScanThresholdRun(int StartKHz, int EndKHz, int PointCount, ScanPoint Peak);

/// <summary>Threshold analysis of measured scan samples; receiver RF readings are never an input.</summary>
public static class ScanThresholdAnalysis
{
    public const int DefaultMaxGapKHz = 200;

    public static IReadOnlyList<IReadOnlyList<ScanPoint>> Segments(
        IReadOnlyList<ScanPoint> points,
        IReadOnlyList<IReadOnlyList<ScanPoint>>? recordedSegments = null,
        int maxGapKHz = DefaultMaxGapKHz)
    {
        if (maxGapKHz <= 0) throw new ArgumentOutOfRangeException(nameof(maxGapKHz));
        var result = new List<IReadOnlyList<ScanPoint>>();
        foreach (var recorded in recordedSegments ?? [points])
        {
            var segment = new List<ScanPoint>();
            void Flush() { if (segment.Count > 0) { result.Add(segment.ToArray()); segment.Clear(); } }
            foreach (var point in recorded)
            {
                if (point.FrequencyKHz <= 0 || !double.IsFinite(point.LevelDbm))
                    throw new ArgumentException("Scan samples must contain a positive frequency and finite level.", nameof(points));
                if (segment.Count > 0)
                {
                    var gap = (long)point.FrequencyKHz - segment[^1].FrequencyKHz;
                    if (gap <= 0) throw new ArgumentException("Scan samples must be ordered and unique.", nameof(points));
                    if (gap > maxGapKHz) Flush();
                }
                segment.Add(point);
            }
            Flush(); // A declared missing slot always ends a run, even inside the gap limit.
        }
        return result;
    }

    public static IReadOnlyList<ScanThresholdRun> Runs(
        IReadOnlyList<IReadOnlyList<ScanPoint>> segments, double thresholdDbm)
    {
        if (!double.IsFinite(thresholdDbm)) throw new ArgumentOutOfRangeException(nameof(thresholdDbm));
        var result = new List<ScanThresholdRun>();
        foreach (var segment in segments)
        {
            var start = -1;
            void Flush(int end)
            {
                if (start < 0) return;
                var maximum = double.NegativeInfinity;
                var bestStart = start; var bestCount = 0; var plateauStart = start; var plateauCount = 0;
                for (var i = start; i < end; i++)
                {
                    var level = segment[i].LevelDbm;
                    if (level > maximum) { maximum = level; bestStart = plateauStart = i; bestCount = plateauCount = 1; }
                    else if (level == maximum)
                    {
                        if (plateauCount == 0) plateauStart = i;
                        plateauCount++;
                        if (plateauCount > bestCount) { bestStart = plateauStart; bestCount = plateauCount; }
                    }
                    else plateauCount = 0;
                }
                // Select a real sample from the longest highest plateau, never a fabricated midpoint.
                var peak = segment[bestStart + (bestCount - 1) / 2];
                result.Add(new(segment[start].FrequencyKHz, segment[end - 1].FrequencyKHz, end - start, peak));
                start = -1;
            }
            for (var i = 0; i < segment.Count; i++)
            {
                if (segment[i].LevelDbm >= thresholdDbm) { if (start < 0) start = i; }
                else Flush(i);
            }
            Flush(segment.Count);
        }
        return result;
    }
}
