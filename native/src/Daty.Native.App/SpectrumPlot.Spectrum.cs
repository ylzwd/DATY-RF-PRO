using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using Daty.Native.Core;

namespace Daty.Native.App;

public sealed partial class SpectrumPlot
{
    public double? ScanPeakThresholdDbm { get; set; }
    public double? ScanExclusionThresholdDbm { get; set; }
    private IReadOnlyList<ScanThresholdRun> measuredPeaks = [];
    private IReadOnlyList<ScanThresholdRun> excludedRuns = [];
    internal IReadOnlyList<ScanThresholdRun> MeasuredPeaks => measuredPeaks;
    internal IReadOnlyList<ScanThresholdRun> ExcludedRuns => excludedRuns;
    private const double spectrumMin = -110, spectrumMax = -20;
    private readonly TextBlock spectrumTipText = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12, Foreground = Brush("#e2e8f0") };
    private readonly ToolTip spectrumTip = new() { Placement = PlacementMode.Relative, StaysOpen = true, Padding = new(10, 7, 10, 7), Background = Brush("#171c2b"), Foreground = Brush("#e2e8f0"), BorderThickness = new(1), MaxWidth = 390 };
    public SpectrumPlot() { spectrumTip.Content = spectrumTipText; Unloaded += (_, _) => spectrumTip.IsOpen = false; }

    internal Rect SpectrumArea => new(50, 18, Math.Max(1, ActualWidth - 74), Math.Max(1, ActualHeight - 58));
    internal double SpectrumX(double mhz) => SpectrumArea.Left + (mhz - StartMHz) / (EndMHz - StartMHz) * SpectrumArea.Width;
    internal double SpectrumY(double dbm) => SpectrumArea.Bottom - (dbm - spectrumMin) / (spectrumMax - spectrumMin) * SpectrumArea.Height;
    private static bool InSpectrumRange(double dbm)=>double.IsFinite(dbm)&&dbm>=spectrumMin&&dbm<=spectrumMax;
    private sealed record SpectrumDevicePoint(Channel Channel, SpectrumRfPresentation Reception, Point Position);
    private SpectrumDevicePoint[] SpectrumDevicePoints() => SpectrumPresentation.Visible(Channels, StartMHz, EndMHz)
        .OrderBy(c => c.FrequencyKHz).Select(c => {
            var reception = SpectrumRfPresentation.For(c, MonitoringRules);
            return new SpectrumDevicePoint(c, reception, new(SpectrumX(c.FrequencyKHz!.Value / 1000d),
                reception.RfDbm is double rf ? SpectrumY(rf) : SpectrumArea.Bottom - 4));
        }).ToArray();
    private double SpectrumFrequencyStep()
    {
        var target=(EndMHz-StartMHz)/Math.Max(2,Math.Round(SpectrumArea.Width/95));
        var magnitude=Math.Pow(10,Math.Floor(Math.Log10(target)));
        return new[]{1d,2d,5d,10d}.First(n=>n*magnitude>=target-1e-10)*magnitude;
    }

    private void RenderSpectrum(DrawingContext dc)
    {
        if (ActualWidth < 160 || ActualHeight < 100 || EndMHz <= StartMHz) return;
        var measuredSegments = ScanThresholdAnalysis.Segments(Points, PointSegments, SampleStepKHz ?? ScanThresholdAnalysis.DefaultMaxGapKHz);
        measuredPeaks = ScanPeakThresholdDbm is double peakThreshold && double.IsFinite(peakThreshold) ? ScanThresholdAnalysis.Runs(measuredSegments, peakThreshold) : [];
        excludedRuns = ScanExclusionThresholdDbm is double exclusionThreshold && double.IsFinite(exclusionThreshold) ? ScanThresholdAnalysis.Runs(measuredSegments, exclusionThreshold) : [];
        var area = SpectrumArea;
        FormattedText Label(string text, string color) => new(text, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, new Typeface("Segoe UI"), 10, Brush(color), VisualTreeHelper.GetDpi(this).PixelsPerDip);
        dc.DrawRectangle(Brush("#050608"),null,area);
        var majorStep=SpectrumFrequencyStep();var minorStep=majorStep/5;
        var firstTick=(long)Math.Ceiling(StartMHz/minorStep-1e-7);var lastTick=(long)Math.Floor(EndMHz/minorStep+1e-7);
        for (var tick=firstTick;tick<=lastTick;tick++)
        {
            var mhz=tick*minorStep;var x=SpectrumX(mhz);var major=tick%5==0;
            dc.DrawLine(new Pen(Brush(major?"#30343b":"#171b21"),1),new(x,area.Top),new(x,area.Bottom));
            if(major)
            {
                var text=Label(mhz.ToString("0.###",CultureInfo.InvariantCulture)+" MHz","#b4bdcc");
                dc.DrawText(text,new(Math.Clamp(x-text.Width/2,area.Left,Math.Max(area.Left,area.Right-text.Width)),area.Bottom+9));
            }
        }
        for (var dbm=spectrumMin;dbm<=spectrumMax;dbm+=5)
        {
            var y=SpectrumY(dbm);var major=dbm%10==0;
            dc.DrawLine(new Pen(Brush(major?"#30343b":"#12161c"),1),new(area.Left,y),new(area.Right,y));
            if(major){var text=Label(dbm.ToString("0",CultureInfo.InvariantCulture),"#cbd5e1");dc.DrawText(text,new(area.Left-text.Width-7,y-text.Height/2));}
        }
        dc.DrawRectangle(null,new Pen(Brush("#50545b"),1),area);
        var axisTitle=Label("幅度 (dBm)","#cbd5e1");
        dc.PushTransform(new RotateTransform(-90,7,area.Top+area.Height/2));
        dc.DrawText(axisTitle,new(7-axisTitle.Width/2,area.Top+area.Height/2-axisTitle.Height/2));dc.Pop();
        dc.PushClip(new RectangleGeometry(area));
        // Preserve per-pixel CSV peaks and their input order. First/last anchors
        // prevent a narrow peak from becoming a broad ramp to the previous pixel.
        foreach(var segment in measuredSegments)
        {
            // Reduce each valid run independently: never bridge missing slots.
            var samples = segment.Where(p => p.FrequencyKHz >= StartMHz * 1000 && p.FrequencyKHz <= EndMHz * 1000).ToArray();
            var csv = SpectrumPresentation.Reduce(samples, StartMHz, EndMHz, area.Width).Select(p => new Point(SpectrumX(p.FrequencyKHz / 1000d), SpectrumY(p.LevelDbm))).ToArray();
            if (csv.Length > 0)
            {
                var fill = new StreamGeometry(); using (var g = fill.Open()) { g.BeginFigure(new(csv[0].X, area.Bottom), true, true); g.PolyLineTo(csv, true, false); g.LineTo(new(csv[^1].X, area.Bottom), true, false); }
                fill.Freeze(); dc.DrawGeometry(new LinearGradientBrush(Color.FromArgb(45, 99, 102, 241), Colors.Transparent, 90), null, fill);
                if(csv.Length==1)dc.DrawEllipse(Brush("#6366f1"),null,csv[0],2,2);else DrawTrace(dc, csv, "#6366f1", 1.5);
            }
        }
        // Mark only measured above-threshold runs along the floor. The source trace stays visible;
        // no red span crosses a missing sample or an unmeasured file gap.
        foreach (var run in excludedRuns)
        {
            if (run.EndKHz < StartMHz * 1000 || run.StartKHz > EndMHz * 1000) continue;
            var left = Math.Max(area.Left, SpectrumX(run.StartKHz / 1000d));
            var right = Math.Min(area.Right, SpectrumX(run.EndKHz / 1000d));
            if (left == right) dc.DrawLine(new Pen(Brush("#ef4444"), 2), new(left, area.Bottom - 4), new(left, area.Bottom));
            else dc.DrawRectangle(Brush("#ccdc2626"), null, new Rect(left, area.Bottom - 3, right - left, 3));
        }
        foreach (var (threshold, title, color) in new[] { (ScanPeakThresholdDbm, "扫描峰值阈值", "#f59e0b"), (ScanExclusionThresholdDbm, "排除阈值", "#ef4444") })
        {
            if (threshold is not double value || !InSpectrumRange(value)) continue;
            var y = SpectrumY(value);
            dc.DrawLine(new Pen(Brush(color), 1), new(area.Left, y), new(area.Right, y));
            var label = Label($"{title} {value:0.#} dBm", color);
            var labelX = title == "扫描峰值阈值" ? area.Left + 4 : area.Right - label.Width - 4;
            dc.DrawText(label, new(labelX, y >= area.Top + 17 ? y - 15 : y + 2));
        }
        foreach (var peak in measuredPeaks.Select(r => r.Peak).Where(p => p.FrequencyKHz >= StartMHz * 1000 && p.FrequencyKHz <= EndMHz * 1000&&InSpectrumRange(p.LevelDbm)))
        {
            var x = SpectrumX(peak.FrequencyKHz / 1000d); var y = SpectrumY(peak.LevelDbm) - 7;
            var diamond = new StreamGeometry(); using (var g = diamond.Open()) { g.BeginFigure(new(x, y - 4), true, true); g.LineTo(new(x + 4, y), true, false); g.LineTo(new(x, y + 4), true, false); g.LineTo(new(x - 4, y), true, false); }
            diamond.Freeze(); dc.DrawGeometry(Brush("#f59e0b"), null, diamond);
        }
        var devicePoints = SpectrumDevicePoints();
        foreach (var point in devicePoints)
        {
            var position = point.Position; var brush = Brush(point.Reception.RfDbm.HasValue ? "#10b981" : "#7c8db5");
            if (point.Reception.RfDbm.HasValue) dc.DrawLine(new Pen(brush, 2), new(position.X, area.Bottom), position);
            dc.DrawEllipse(brush, null, position, 4, 4);
        }
        dc.Pop();
        var laneEnds = new[] { double.NegativeInfinity, double.NegativeInfinity, double.NegativeInfinity };
        foreach (var c in devicePoints.Select(p => p.Channel))
        {
            var text = Label(c.ChannelLabel, "#7c8db5"); var width = Math.Max(18, text.Width); var left = Math.Clamp(SpectrumX(c.FrequencyKHz!.Value / 1000d) + 5, area.Left, area.Right - width);
            var lane = System.Array.FindIndex(laneEnds, end => left >= end + 6); if (lane < 0) lane = System.Array.IndexOf(laneEnds, laneEnds.Min());
            laneEnds[lane] = left + width; dc.DrawText(text, new(left, area.Bottom - 18 - lane * 14));
        }
        if (Points.Count == 0 && devicePoints.Length == 0) dc.DrawText(Label("等待范围内设备频点或真实扫描", "#7c8db5"), new(area.Left + 20, area.Top + 20));
        if (spectrumTip.IsOpen) UpdateSpectrumHover(Mouse.GetPosition(this));
    }

    private static void DrawTrace(DrawingContext dc, Point[] points, string color, double thickness)
    {
        if (points.Length < 2) return;
        var path = new StreamGeometry(); using (var g = path.Open()) { g.BeginFigure(points[0], false, false); g.PolyLineTo(points.Skip(1).ToArray(), true, false); }
        path.Freeze(); dc.DrawGeometry(null, new Pen(Brush(color), thickness), path);
    }

    // Hit testing reports actual source samples, preserving missing slots.
    internal string? SpectrumHover(Point point)
    {
        var area = SpectrumArea; if (EndMHz <= StartMHz || !area.Contains(point)) return null;
        SpectrumDevicePoint? hit = null; var distance = 100d;
        var devicePoints = SpectrumDevicePoints();
        foreach (var device in devicePoints.Where(p=>p.Reception.RfDbm is not double rf||InSpectrumRange(rf)))
        {
            var dx = device.Position.X - point.X; var dy = device.Position.Y - point.Y; var d = dx * dx + dy * dy;
            var radiusSquared = device.Reception.RfDbm.HasValue ? 100 : 25;
            if (d <= radiusSquared && d <= distance) { distance = d; hit = device; }
        }
        if (hit is null)
        {
            distance = double.PositiveInfinity;
            foreach (var device in devicePoints.Where(p => p.Reception.RfDbm.HasValue))
            {
                var dx = device.Position.X - point.X;
                if (point.Y >= device.Position.Y && dx * dx <= 25 && dx * dx < distance) { distance = dx * dx; hit = device; }
            }
        }
        if (hit is not null)
        {
            var c = hit.Channel;
            var rfText = hit.Reception.RfDbm is double rf ? "RF " + MonitoringRules!.Format(rf, "signals", "rfDecimals", "rfUnit")
                : hit.Reception.IsOffline ? MonitoringRules!.Text("transmitter", "offlineText") + " · 不显示实时 RF"
                : "RF 未知 · " + (MonitoringRules?.Text("transmitter", "unknownText") ?? "数据库显示规则尚未读取");
            return $"{c.Brand} · {c.Ip} · {c.ChannelLabel}\n{c.Frequency} MHz · {rfText}\n设备离散频点，不是连续扫描";
        }
        foreach (var peak in measuredPeaks.Select(r => r.Peak).Where(p=>InSpectrumRange(p.LevelDbm)))
        {
            var dx = SpectrumX(peak.FrequencyKHz / 1000d) - point.X;
            var dy = SpectrumY(peak.LevelDbm) - 7 - point.Y;
            if (dx * dx + dy * dy <= 49)
                return $"扫描峰值 · {ScanSourceLabel}\n{peak.FrequencyKHz / 1000d:0.000} MHz · {peak.LevelDbm:0.#} dBm\n达到扫描峰值阈值 {ScanPeakThresholdDbm:0.#} dBm；参与所选互调规则计算，不推定发射机型号。";
        }
        var cursorFrequency=StartMHz+(point.X-area.Left)/area.Width*(EndMHz-StartMHz);
        if(Points.Count>0)
        {
            int low=0,high=Points.Count-1;
            while(low<high){var mid=(low+high)/2;if(Points[mid].FrequencyKHz<cursorFrequency*1000)low=mid+1;else high=mid;}
            var candidates=new[]{Points[low],Points[Math.Max(0,low-1)]};
            var measured=candidates.OrderBy(p=>Math.Abs(SpectrumX(p.FrequencyKHz/1000d)-point.X)).First();
            if(InSpectrumRange(measured.LevelDbm)&&Math.Abs(SpectrumX(measured.FrequencyKHz/1000d)-point.X)<=8&&Math.Abs(SpectrumY(measured.LevelDbm)-point.Y)<=8)
                return $"{ScanSourceLabel}\n{measured.FrequencyKHz/1000d:0.000} MHz · {measured.LevelDbm:0.#} dBm\n历史文件采样，不是设备当前扫描" + (ScanExclusionThresholdDbm is double exclusion && measured.LevelDbm >= exclusion ? $"\n达到排除阈值 {exclusion:0.#} dBm" : "");
        }
        foreach (var (threshold, title, explanation) in new[] {
            (ScanPeakThresholdDbm, "扫描峰值阈值", "连续实测超阈区的最高采样点参与规划互调；不以接收机单频 RF 推算谱峰。"),
            (ScanExclusionThresholdDbm, "排除阈值", "达到阈值的真实扫描参与规划排除；规划同时保留设备 Profile 和更严格的手动约束。") })
        {
            if (threshold is double value && InSpectrumRange(value) && Math.Abs(point.Y - SpectrumY(value)) <= 3)
                return $"{title} {value:0.#} dBm\n{explanation}";
        }
        if (point.Y >= area.Bottom - 5)
        {
            var run = excludedRuns.FirstOrDefault(r => r.StartKHz <= cursorFrequency * 1000 && r.EndKHz >= cursorFrequency * 1000);
            if (run is not null) return $"扫描超阈采样范围\n{run.StartKHz / 1000d:0.000}–{run.EndKHz / 1000d:0.000} MHz · {run.PointCount} 点\n实测电平达到排除阈值 {ScanExclusionThresholdDbm:0.#} dBm；缺失位置不连接。";
        }
        return null;
    }

    private void UpdateSpectrumHover(Point point)
    {
        var text = SpectrumHover(point); ToolTip = null;
        if (text is null) { spectrumTip.IsOpen = false; Cursor = null; return; }
        if (spectrumTipText.Text != text) spectrumTipText.Text = text;
        spectrumTip.BorderBrush = Brush(text.StartsWith("扫描峰值", StringComparison.Ordinal) ? "#f59e0b" : text.StartsWith("排除阈值", StringComparison.Ordinal) || text.StartsWith("扫描超阈", StringComparison.Ordinal) ? "#ef4444" : text.StartsWith("WWB",StringComparison.Ordinal)||text.StartsWith("CSV",StringComparison.Ordinal)?"#6366f1":"#10b981");
        spectrumTipText.Measure(new Size(366, double.PositiveInfinity));
        var size = new Size(spectrumTipText.DesiredSize.Width + 24, spectrumTipText.DesiredSize.Height + 18);
        spectrumTip.HorizontalOffset = Math.Clamp(point.X + 12 + size.Width <= ActualWidth - 4 ? point.X + 12 : point.X - size.Width - 12, 4, Math.Max(4, ActualWidth - size.Width - 4));
        spectrumTip.VerticalOffset = Math.Clamp(point.Y + 12 + size.Height <= ActualHeight - 4 ? point.Y + 12 : point.Y - size.Height - 12, 4, Math.Max(4, ActualHeight - size.Height - 4));
        spectrumTip.PlacementTarget = this; spectrumTip.IsOpen = true; Cursor = Cursors.Cross;
    }
    protected override void OnMouseLeave(MouseEventArgs e) { base.OnMouseLeave(e); spectrumTip.IsOpen = false; ToolTip = null; Cursor = null; }
}
