using Daty.Native.Core;

static class ScanThresholdCases
{
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static ScanPoint[] Points(params double[] levels) => levels.Select((level, i) => new ScanPoint(640000 + i * 25, level)).ToArray();

    public static IEnumerable<(string Name, Action Run)> All()
    {
        yield return ("Scan threshold includes equality and selects one measured peak per contiguous run", () => {
            var points = Points(-90, -60, -45, -60, -90, -60, -90);
            var runs = ScanThresholdAnalysis.Runs(ScanThresholdAnalysis.Segments(points), -60);
            Check(runs.Count == 2 && runs[0] == new ScanThresholdRun(640025, 640075, 3, points[2]), "first peak run");
            Check(runs[1] == new ScanThresholdRun(640125, 640125, 1, points[5]), "isolated threshold-equal sample");
            Check(ScanThresholdAnalysis.Runs(ScanThresholdAnalysis.Segments(points), -40).Count == 0, "threshold recomputes peaks");
        });
        yield return ("Scan peak plateaus retain a middle actual sample and never bridge equal separated maxima", () => {
            var plateau = Points(-90, -45, -45, -45, -90);
            Check(ScanThresholdAnalysis.Runs(ScanThresholdAnalysis.Segments(plateau), -60).Single().Peak == plateau[2], "odd plateau center");
            var even = Points(-45, -45, -45, -45);
            Check(ScanThresholdAnalysis.Runs(ScanThresholdAnalysis.Segments(even), -60).Single().Peak == even[1], "even plateau retains real lower center");
            var separate = Points(-45, -50, -45);
            Check(ScanThresholdAnalysis.Runs(ScanThresholdAnalysis.Segments(separate), -60).Single().Peak == separate[0], "valley cannot become an invented maximum");
        });
        yield return ("Missing WWB slots and CSV gaps split threshold and trace runs", () => {
            var all = new ScanPoint[] { new(640000, -50), new(640025, -40), new(640075, -35), new(640100, -55) };
            IReadOnlyList<ScanPoint>[] missing = [all[..2], all[2..]];
            var declared = ScanThresholdAnalysis.Segments(all, missing);
            Check(declared.Count == 2 && ScanThresholdAnalysis.Runs(declared, -60).Count == 2, "explicit missing slot stays a gap below 200 kHz");
            var csv = new ScanPoint[] { new(640000, -50), new(640200, -40), new(640401, -30) };
            var split = ScanThresholdAnalysis.Segments(csv);
            Check(split.Count == 2 && split[0].Count == 2 && split[1].Count == 1, "CSV 200 kHz allowed, 201 kHz splits");
            Check(ScanThresholdAnalysis.Segments(all, maxGapKHz: 25).Count == 2, "known grid prevents bridge even without explicit segments");
        });
        yield return ("Peak and exclusion thresholds analyze measured samples independently without extending coverage", () => {
            var points = Points(-100, -85, -75, -55, -90);
            var segments = ScanThresholdAnalysis.Segments(points);
            var peaks = ScanThresholdAnalysis.Runs(segments, -60);
            var excluded = ScanThresholdAnalysis.Runs(segments, -85);
            Check(peaks.Single().StartKHz == 640075 && peaks[0].EndKHz == 640075, "peak threshold");
            Check(excluded.Single().StartKHz == 640025 && excluded[0].EndKHz == 640075 && excluded[0].PointCount == 3, "exclusion threshold and equality");
            Check(ScanThresholdAnalysis.Runs(ScanThresholdAnalysis.Segments([]), -85).Count == 0, "empty scan has neither inferred peak nor exclusion");
            Check(points[0].LevelDbm == -100 && points[4].LevelDbm == -90, "analysis does not change source samples");
        });
    }
}
