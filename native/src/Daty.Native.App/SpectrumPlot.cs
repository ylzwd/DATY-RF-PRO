using System.Globalization;
using System.Windows;
using System.Windows.Media;
using Daty.Native.Core;

namespace Daty.Native.App;

public sealed partial class SpectrumPlot : FrameworkElement
{
    public IReadOnlyList<Channel> Channels { get; set; } = [];
    public MonitoringRules? MonitoringRules { get; set; }
    public IReadOnlyList<ScanPoint> Points { get; set; } = [];
    public IReadOnlyList<IReadOnlyList<ScanPoint>>? PointSegments { get; set; }
    public string ScanSourceLabel { get; set; } = "CSV";
    public int? SampleStepKHz { get; set; }
    public double StartMHz { get; set; } = 400;
    public double EndMHz { get; set; } = 900;
    public bool Bars { get; set; }
    public double RfMin {get;set;}=-90;
    public double RfMax {get;set;}=-30;
    private static Brush Brush(string c) => new SolidColorBrush((Color)ColorConverter.ConvertFromString(c));
    protected override void OnRender(DrawingContext dc)
    {
        base.OnRender(dc);
        if (!Bars) { RenderSpectrum(dc); return; }
        double w = ActualWidth, h = ActualHeight;
        if (w < 160 || h < 100 || EndMHz <= StartMHz || RfMax<=RfMin) return;
        var area = Bars ? new Rect(56,10,w-104,h-34) : new Rect(50,18,w-74,h-58);
        double X(double mhz) => area.Left + (mhz - StartMHz) / (EndMHz - StartMHz) * area.Width;
        double Y(double dbm) => area.Bottom - (Math.Clamp(dbm, RfMin, RfMax) - RfMin) / (RfMax-RfMin) * area.Height;
        void Label(string text, double x, double y, Brush? brush = null) => dc.DrawText(new FormattedText(text, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, new Typeface("Segoe UI"), 10, brush ?? Brush("#7c8db5"), VisualTreeHelper.GetDpi(this).PixelsPerDip), new Point(x, y));
        for (double db = RfMin; db <= RfMax+.0001; db += (RfMax-RfMin)/(Bars?4:3)) { var y = Y(db); dc.DrawLine(new Pen(Brush("#1c2231"), 1), new Point(area.Left, y), new Point(area.Right, y)); Label(db+" dBm", 3, y - 7); }
        for (int n = 0; n <= 10; n++) { var value = StartMHz + (EndMHz - StartMHz) * n / 10; var x = X(value); Label(value.ToString("0.###", CultureInfo.InvariantCulture)+" MHz", x - 1, area.Bottom + 9,Brush("#4a5578")); }
        dc.PushClip(new RectangleGeometry(area));
        // Preserve peaks while drawing at most roughly two samples per display pixel.
        var bins = new SortedDictionary<int, (double min, double max)>();
        foreach (var point in Points)
        {
            var x = X(point.FrequencyKHz / 1000.0); if (x < area.Left || x > area.Right) continue;
            var k = (int)x; var y = Y(point.LevelDbm);
            bins[k] = bins.TryGetValue(k, out var old) ? (Math.Min(old.min, y), Math.Max(old.max, y)) : (y, y);
        }
        Point? previous = null;
        foreach (var (x, range) in bins) { var next = new Point(x, range.min); if (previous.HasValue) dc.DrawLine(new Pen(Brush("#6366f1"), 1), previous.Value, next); if (range.max > range.min) dc.DrawLine(new Pen(Brush("#6366f1"), 1), next, new Point(x, range.max)); previous = new Point(x, range.max); }
        foreach (var channel in Channels.Where(c => c.Online && c.FrequencyKHz.HasValue && c.RfDbm.HasValue))
        {
            var x = X(channel.FrequencyKHz!.Value / 1000.0); if (x < area.Left || x > area.Right) continue;
            var y = Y(channel.RfDbm!.Value); var color = Brush("#10b981");
            dc.DrawLine(new Pen(color, Bars ? 4 : 1.5), new Point(x, area.Bottom), new Point(x, y));
            if (!Bars) dc.DrawEllipse(color, null, new Point(x, y), 3, 3);
        }
        dc.Pop();
        var labelEnds = new[] { area.Left - 6, area.Left - 6, area.Left - 6 };
        foreach (var channel in Channels.Where(c => c.Online && c.FrequencyKHz.HasValue).OrderBy(c => c.FrequencyKHz))
        {
            var x = X(channel.FrequencyKHz!.Value / 1000.0); if (x < area.Left || x > area.Right) continue;
            var left = Math.Clamp(x + 3, area.Left, area.Right - 36);
            var row = Array.FindIndex(labelEnds, end => left >= end + 5);
            if (row < 0) continue; // Crowded labels stay available in the precise hover readout.
            Label(channel.ChannelLabel, left, Bars?area.Bottom-16-row*12:area.Top + row * 14, Brush("#4a5578")); labelEnds[row] = left + 32;
        }
        if (Points.Count == 0 && Channels.All(c => !c.Online || c.RfDbm is null)) Label("暂无真实数据", area.Left + 20, area.Top + 35);
    }
    protected override void OnMouseMove(System.Windows.Input.MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (!Bars) { UpdateSpectrumHover(e.GetPosition(this)); return; }
        var fraction = (e.GetPosition(this).X - (Bars?56:50)) / Math.Max(1, ActualWidth - (Bars?104:74));
        if (fraction < 0 || fraction > 1) { ToolTip = null; return; }
        var frequency = StartMHz + fraction * (EndMHz - StartMHz);
        var nearest = Channels.Where(c => c.Online && c.FrequencyKHz.HasValue).OrderBy(c => Math.Abs(c.FrequencyKHz!.Value / 1000.0 - frequency)).FirstOrDefault();
        ToolTip = nearest is null || Math.Abs(nearest.FrequencyKHz!.Value/1000d-frequency)>12*(EndMHz-StartMHz)/Math.Max(1,ActualWidth-(Bars?104:74)) ? frequency.ToString("0.000", CultureInfo.InvariantCulture) + " MHz" : $"{nearest.Brand} · {nearest.Ip} · {nearest.ChannelLabel}\n{nearest.Frequency} MHz\nRF {nearest.Rf} · AF {nearest.Af}\n设备离散频点，不是连续扫描";
    }
}
