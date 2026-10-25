using System.Text.Json;
using Daty.Native.Core;

static class PlanningScanSourceCases
{
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static ScanDocument Scan(params ScanPoint[] points) => new("test.csv", "fixture", points, 0, JsonSerializer.SerializeToElement(new { }));
    static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);
    static JsonElement Profiles => Json(Array.Empty<object>());
    static JsonElement Shure(int frequency = 632700) => Json(new[] { new {
        id = "fixture-shure", receiver_id = "fixture-rx", receiver_mac = "fixture-mac", receiver_ip = "192.0.2.104",
        channel_number = 1, group_number = 1, group_source = "server-fifo-v1", _online = true, _source = "shure-scp", status = "online",
        brand = "Shure", model = "ULXD4", freq = frequency,
        capabilities = new { adapter = "shure-scp", write_frequency = true, read_only = false,
            hardware_band = new { band = "L51", source = "chassis-label-confirmed", verified = true },
            frequency_control = new { scope = "shure-scp", min_khz = 632000, max_khz = 696000, step_khz = 25,
                origin_khz = 0, ack_mode = "readback", brand_binding = "expected-brand-v1" } }
    } });
    static Dictionary<string, object?> Options(ScanDocument? scan = null) => new() {
        ["rangeStartKHz"] = 640000, ["rangeEndKHz"] = 690000, ["stepKHz"] = 25, ["backupCount"] = 0,
        ["compatibilityLevel"] = "standard", ["imdProducts"] = new[] { "3T3O" }, ["preserveCurrent"] = true,
        ["allocationOrder"] = "receiver-group-ascending", ["frequencyDistribution"] = "spread-range",
        ["protectCurrentFrequencies"] = true, ["lockMonitoringOnly"] = true, ["autoExpandRange"] = true,
        // Isolated peak fixtures test carrier mathematics. They deliberately supply no invented continuous scan coverage.
        ["scanPeakCarriers"] = PlanningScanSources.Extract(scan ?? Scan(new(632450, -42), new(633790, -40), new(673790, -45)), -60)
    };
    static void CheckRange(JsonElement options, int start = 632450) {
        Check(options.GetProperty("rangeStartKHz").GetInt32() == start && options.GetProperty("rangeEndKHz").GetInt32() == 690000, "effective range is min/max union of requested range and actual frequencies");
        Check(options.GetProperty("requestedRangeStartKHz").GetInt32() == 640000 && options.GetProperty("requestedRangeEndKHz").GetInt32() == 690000, "requested range remains recorded");
        Check(options.GetProperty("planningGridOriginKHz").GetInt32() == 640000, "expanded boundary does not move the original candidate-grid phase");
        Check(options.GetProperty("rangeExpansion").GetProperty("expanded").GetBoolean(), "range expansion is explicit");
    }
    static void Reject(Action action, string expected) {
        try { action(); } catch (Exception error) { Check(error.Message.Contains(expected), "unexpected rejection: " + error.Message); return; }
        throw new Exception("Expected rejection containing: " + expected);
    }

    public static IEnumerable<(string Name, Action Run)> All()
    {
        yield return ("Planning scan sources retain the three observed non-grid peak frequencies", () => {
            var scan = Scan(new(632425, -90), new(632450, -42), new(632475, -90),
                new(633765, -90), new(633790, -40), new(633815, -90),
                new(673765, -90), new(673790, -45), new(673815, -90));
            var sources = PlanningScanSources.Extract(scan, -60);
            Check(sources.Select(p => p.FrequencyKHz).SequenceEqual(new[] { 632450, 633790, 673790 }), "all three exact measured frequencies are retained");
            Check(sources.All(p => p.Source == "scan-peak" && p.StartKHz == p.FrequencyKHz && p.EndKHz == p.FrequencyKHz), "noise-floor points are not carrier sources");
            var json = JsonSerializer.SerializeToElement(sources);
            Check(json[1].GetProperty("frequencyKHz").GetInt32() == 633790 && json[1].GetProperty("id").GetString() == "scan-peak:633790", "canonical JSON fields preserve precise frequency identity");
            Check(json[1].GetProperty("source").GetString() == "scan-peak" && !json[1].TryGetProperty("brand", out _) && !json[1].TryGetProperty("receiverId", out _), "scan evidence never invents an identified receiver or brand");
        });
        yield return ("Planning scan sources use database peak threshold inclusively and preserve actual plateau sample", () => {
            var scan = Scan(new(633765, -90), new(633790, -60), new(633815, -60), new(633840, -90), new(633865, -61));
            var sources = PlanningScanSources.Extract(scan, -60);
            Check(sources.Count == 1 && sources[0] == new PlanningScanCarrier(633790, -60, 633790, 633815), "equal threshold enters the peak run and the plateau uses a measured sample");
            Check(PlanningScanSources.Extract(scan, -59).Count == 0, "changing peak threshold recomputes carriers");
        });
        yield return ("Planning scan sources never bridge declared missing samples or a known scan grid gap", () => {
            var points = new ScanPoint[] { new(632400, -50), new(632425, -40), new(632475, -35), new(632500, -45) };
            var declared = Scan(points) with { MissingPoints = 1, TraceSegments = [points[..2], points[2..]] };
            var sources = PlanningScanSources.Extract(declared, -60);
            Check(sources.Count == 2 && sources[0] == new PlanningScanCarrier(632425, -40, 632400, 632425)
                && sources[1] == new PlanningScanCarrier(632475, -35, 632475, 632500), "declared missing point separates protection intervals and carrier peaks");
            var knownGrid = Scan(points) with { MissingPoints = 1, SampleStepKHz = 25 };
            Check(PlanningScanSources.Extract(knownGrid, -60).SequenceEqual(sources), "known sample grid detects the same missing point without recorded segments");
            Check(sources.All(p => p.FrequencyKHz != 632450), "no interpolation of unknown slot");
        });
        yield return ("Planning scan source deduplication retains maximum level and full measured protection range", () => {
            var first = Scan(new(633765, -55), new(633790, -40), new(633815, -50));
            var second = Scan(new(633790, -35), new(633815, -45), new(633840, -55));
            var sources = PlanningScanSources.ExtractMany([first, first, second], -60);
            Check(sources.Count == 1 && sources[0] == new PlanningScanCarrier(633790, -35, 633765, 633840), "duplicate measured carrier frequency is one source with stricter measured evidence");
            Check(PlanningScanSources.ExtractMany([second, first], -60).SequenceEqual(sources), "deduplication is independent of record order");
            Check(first.Points.Count == 3 && first.Points[1].LevelDbm == -40, "source document is unchanged");
        });
        yield return ("Planning scan sources do not fabricate carriers for absent, all-missing or below-threshold data", () => {
            Check(PlanningScanSources.Extract(null, -60).Count == 0, "no document creates no carriers");
            var missing = Scan() with { MissingPoints = 100, GridStartKHz = 632125, GridEndKHz = 634600, SampleStepKHz = 25, TraceSegments = [] };
            Check(PlanningScanSources.Extract(missing, -60).Count == 0, "grid metadata cannot fabricate zero-valued samples");
            Check(PlanningScanSources.Extract(Scan(new(632450, -85), new(632475, -84)), -60).Count == 0, "exclusion-only levels do not become peak carriers");
        });
        yield return ("Planning scan sources reject invalid measured data and non-finite threshold", () => {
            static void Reject(Action action) { try { action(); } catch (ArgumentException) { return; } throw new Exception("Invalid evidence was accepted"); }
            Reject(() => PlanningScanSources.Extract(Scan(new ScanPoint(632450, double.NaN)), -60));
            Reject(() => PlanningScanSources.Extract(Scan(new ScanPoint(0, -50)), -60));
            Reject(() => PlanningScanSources.Extract(Scan(new ScanPoint(632450, -50)), double.NaN));
            Reject(() => PlanningScanSources.Extract(Scan(), double.PositiveInfinity));
        });
        yield return ("Native planning jointly includes all three scan peaks and current Shure frequency in expanded range", () => {
            var options = Json(Options());
            var before = options.GetRawText();
            var result = CoordinationEngine.Plan(Shure(), options, Profiles, default);
            var effective = result.GetProperty("options");
            CheckRange(effective);
            var carriers = effective.GetProperty("knownCarriers").EnumerateArray().ToArray();
            Check(carriers.Select(c => c.GetProperty("frequencyKHz").GetInt32()).Order().SequenceEqual(new[] { 632450, 632700, 633790, 673790 }), "the three scan peaks and actual on-air Shure frequency are all IMD inputs");
            Check(carriers.All(c => c.GetProperty("intermodSource").GetBoolean()), "every occupied tone participates in selected IMD products");
            Check(carriers.Count(c => c.TryGetProperty("sourceKind", out var kind) && kind.GetString() == "scan-peak") == 3, "three anonymous measured peaks remain separately identified");
            Check(effective.GetProperty("imdProducts").EnumerateArray().Select(p => p.GetString()).SequenceEqual(new[] { "3T3O" }), "only the selected three-tone product is enabled");
            var expansion = effective.GetProperty("rangeExpansion");
            Check(expansion.GetProperty("participatingFrequencyCount").GetInt32() == 4 && expansion.GetProperty("outsideFrequencyCount").GetInt32() == 3, "range evidence deduplicates the actual four frequencies");
            Check(result.GetProperty("search").GetProperty("complete").GetBoolean() && result.GetProperty("assignments").GetArrayLength() == 1, "unlocked receiver gets a compatible mathematical solution");
            var planned = result.GetProperty("assignments")[0].GetProperty("frequencyKHz").GetInt32();
            Check(planned >= 632450 && planned <= 690000 && planned % 25 == 0, "planned output still honors the verified Shure hardware grid");
            Check(!result.GetProperty("retention").GetProperty("scanAvailable").GetBoolean(), "synthetic carrier fixture never claims continuous measured scan coverage");
            Check(options.GetRawText() == before, "calculation does not rewrite the requested inputs");
        });
        yield return ("Expanded native range does not hide real 250 kHz scan-to-Shure spacing conflict", () => {
            var values = Options();
            values["lockedAssignments"] = new[] { new { deviceId = "fixture-shure", frequencyKHz = 632700 } };
            var options = Json(values);
            var result = CoordinationEngine.Plan(Shure(), options, Profiles, default);
            CheckRange(result.GetProperty("options"));
            var errors = string.Join(";", result.GetProperty("errors").EnumerateArray().Select(e => e.GetString()));
            Check(errors.Contains("锁定") && errors.Contains("真实扫描峰") && !errors.Contains("超出规划范围"), "632.700 lock is rejected for the real scan occupancy, not the old 640 MHz boundary");
            Check(!result.GetProperty("search").GetProperty("complete").GetBoolean() && result.GetProperty("assignments").GetArrayLength() == 0, "strict 350 kHz Shure profile is not weakened to accept the 250 kHz gap");
            Check(result.GetProperty("analysis").GetProperty("totalImdProducts").GetInt32() == 12, "four distinct occupied tones produce all twelve three-tone third-order frequency products");
        });
        yield return ("Native manual validation rejects 3T3O from both scan-only and scan-plus-current source triples", () => {
            var devices = Shure(); var options = Json(Options());
            // 632450 + 673790 - 633790 = 672450; 632700 + 673790 - 633790 = 672700.
            foreach (var frequency in new[] { 672450, 672700 })
                Reject(() => CoordinationEngine.ValidateManualPlan(devices, options, Profiles,
                    new Dictionary<string, int> { ["fixture-shure"] = frequency }, default), "3T3O");
        });
        yield return ("Native automatic manual and deployment validation retain the same expanded frequency range", () => {
            var devices = Shure(); var options = Json(Options());
            var automatic = CoordinationEngine.Plan(devices, options, Profiles, default);
            var automaticRows = CoordinationEngine.ValidateDeploymentSequence(automatic, devices, options, Profiles, default);
            Check(automaticRows.GetArrayLength() == 1, "automatic result remains deployable through full preflight");
            var manual = CoordinationEngine.ValidateManualPlan(devices, options, Profiles,
                new Dictionary<string, int> { ["fixture-shure"] = 637000 }, default);
            CheckRange(manual.GetProperty("options"));
            Check(manual.GetProperty("assignments")[0].GetProperty("frequencyKHz").GetInt32() == 637000, "manual valid frequency below the original 640 MHz boundary is retained");
            Check(CoordinationEngine.ValidateDeployment(manual, devices, devices, options, Profiles, "fixture-shure", default).GetArrayLength() == 1, "single deployment preflight uses the expanded mathematical context");
            var sequence = CoordinationEngine.ValidateDeploymentSequence(manual, devices, options, Profiles, default);
            Check(sequence.GetArrayLength() == 1 && sequence[0].GetProperty("frequencyKHz").GetInt32() == 637000, "batch sequence preflight retains the same below-original-range assignment");
            Check(devices[0].GetProperty("freq").GetInt32() == 632700, "pure deployment preflight leaves the actual device snapshot unchanged");
        });
        yield return ("An off-grid minimum scan peak expands native bounds without breaking Shure candidate grid", () => {
            var devices = Shure(640000); var options = Json(Options(Scan(new ScanPoint(633790, -40))));
            var result = CoordinationEngine.Plan(devices, options, Profiles, default);
            CheckRange(result.GetProperty("options"), 633790);
            Check(result.GetProperty("search").GetProperty("complete").GetBoolean(), "off-grid boundary still has valid tuning-grid candidates");
            Check(result.GetProperty("assignments")[0].GetProperty("frequencyKHz").GetInt32() % 25 == 0, "scan source is never rounded to create a hardware candidate");
            var manual = CoordinationEngine.ValidateManualPlan(devices, options, Profiles,
                new Dictionary<string, int> { ["fixture-shure"] = 635000 }, default);
            Check(CoordinationEngine.ValidateDeploymentSequence(manual, devices, options, Profiles, default).GetArrayLength() == 1, "below-request but on-grid candidate survives all native preflight stages");
        });
    }
}
