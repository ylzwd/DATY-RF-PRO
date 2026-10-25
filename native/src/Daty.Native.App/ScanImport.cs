using System.IO;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;
using Microsoft.Win32;

namespace Daty.Native.App;

public partial class MainWindow
{
    private IReadOnlyList<ScanDocument> scanRecords = [];

    private async Task ImportScanAsync()
    {
        if(LiveScanActive){Message("请先停止当前扫描",true);return;}
        var dialog = new OpenFileDialog { Title = "导入扫描文件", Filter = "扫描文件|*.sdb3;*.datyscan;*.csv;*.txt|DATY 完整扫描|*.datyscan|WWB 扫描|*.sdb3|扫描 CSV|*.csv;*.txt", CheckFileExists = true };
        if (dialog.ShowDialog(this) != true) return;
        var request = ++scanRequest; var epoch = generation;
        scanReading.Cancel(); scanReading = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, connection.Token);
        var token = scanReading.Token;
        Message("正在读取并校验扫描文件…");
        try
        {
            var wwb = string.Equals(Path.GetExtension(dialog.FileName), ".sdb3", StringComparison.OrdinalIgnoreCase);
            var bytes = await LocalFiles.ReadBoundedAsync(dialog.FileName, wwb ? PluginScanFiles.MaxBytes : LocalFiles.ScanLimit, token);
            IReadOnlyList<ScanDocument> records;
            if (wwb)
            {
                var client = bridge ?? throw new IOException("请等待 DATY RF PRO 就绪后导入 WWB 文件");
                var boot = client.BootId;
                records = await PluginScanFiles.ReadAsync((method, body, ct) => client.CallAsync(method, body, ct, boot), bytes, dialog.FileName, token);
            }
            else records = [await Task.Run(() => string.Equals(Path.GetExtension(dialog.FileName),".datyscan",StringComparison.OrdinalIgnoreCase)?ScanExchange.Import(bytes,dialog.FileName,token):LocalFiles.ParseScan(bytes, dialog.FileName, token), token)];
            if (request != scanRequest || epoch != generation || token.IsCancellationRequested || LiveScanActive) return;
            scanRecords = records; SelectScanRecord(records[0]);
            Message($"已导入 {records[0].SourceLabel} · {records.Count} 条记录，仅当前会话使用");
        }
        catch (Exception error)
        {
            if (request != scanRequest || epoch != generation || token.IsCancellationRequested) return;
            var reason = error is R19RpcException rpc && rpc.Code is "BRAND_PLUGIN_NOT_INSTALLED" or "SCAN_FILE_ADAPTER_NOT_INSTALLED"
                ? "请先在品牌插件管理中导入支持 WWB 文件的舒尔插件" : SafeError(error);
            Message("扫描未导入：" + reason, true);
        }
    }

    private void SelectScanRecord(ScanDocument document)
    {
        scan = document; InvalidatePlan();
        if (document.GridStartKHz is int start && document.GridEndKHz is int end && end > start)
            settings = settings with { StartMHz = start / 1000d, EndMHz = end / 1000d };
        else if (document.Points.Count >= 2 && document.Points[^1].FrequencyKHz > document.Points[0].FrequencyKHz)
            settings = settings with { StartMHz = document.Points[0].FrequencyKHz / 1000d, EndMHz = document.Points[^1].FrequencyKHz / 1000d };
        scanRefresh?.Invoke();
    }

    private static string ScanExplanation(ScanDocument document) =>
        $"{document.FileName}\n{document.Summary}，共 {document.SlotCount:N0} 个位置。" +
        (document.SourceLabel == "接收机扫描" ? "\n"+ScanExchange.StateLabel(document.Raw.Text("state"))+"；缺失位置断开显示，不补值。" : document.SourceLabel is "WWB 文件" or "DATY 文件" ? "\n历史文件；不代表设备当前扫描或完成状态。缺失位置断开显示，不补值；规划只使用有效点。" : $"\n重复频点取峰值：{document.DuplicateRows:N0} 条。") +
        "\n仅当前会话使用，关闭后不保留。";

    private ComboBox ScanRecordSelector()
    {
        var selector = Select([], minWidth: 100); selector.MaxWidth = 180;
        System.Windows.Automation.AutomationProperties.SetAutomationId(selector, "ScanRecordSelector");
        selector.SelectionChanged += (_, _) =>
        {
            if (selector.SelectedItem is ScanDocument document && !ReferenceEquals(scan, document)) SelectScanRecord(document);
        };
        selector.DisplayMemberPath = nameof(ScanDocument.SelectionLabel);
        return selector;
    }

    private void RefreshScanRecordSelector(ComboBox selector)
    {
        if (!ReferenceEquals(selector.ItemsSource, scanRecords)) selector.ItemsSource = scanRecords;
        if (!ReferenceEquals(selector.SelectedItem, scan)) selector.SelectedItem = scan;
        selector.Visibility = scanRecords.Count > 1 ? Visibility.Visible : Visibility.Collapsed;
    }
}
