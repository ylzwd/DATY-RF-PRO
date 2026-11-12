using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private ScanBackupStore? scanBackupStore;
    private ScanBackupOptions? scanBackupOptions;
    private ImmediateSettings? scanBackupWriter;
    private bool scanBackupSettingsReady;
    private bool BackupUnconfirmed => scanBackupWriter?.HasUnsaved == true || settingOperations.ContainsKey(ScanBackupOptions.DocumentId);
    private string scanBackupStatus = "正在读取备份设置";
    private int scanBackupCount;
    private bool scanBackupPromptShown;
    private string? scanBackupLastError;
    private bool scanUseForPlanning = true;
    private readonly Dictionary<string, (ScanDocument Document, string Name)> pendingScanBackups = [];
    private readonly Dictionary<ScanDocument, string> scanBackupKeys = new(ReferenceEqualityComparer.Instance);
    private Task scanBackupTask = Task.CompletedTask;
    private DateTime scanBackupNextCheckpoint;
    private ScanDocument? PlanningScan => scanUseForPlanning ? scan : null;
    private ScanBackupStore BackupStore() => scanBackupStore ??= new(Path.Combine(
        fixtureNetwork ? fixtureDirectory ?? throw new InvalidDataException("隔离测试目录缺失") :
        ProjectEnvironment.Current?.InstanceRoot ?? Path.GetDirectoryName(Path.GetDirectoryName(NativeSettings.SettingsPath))!, "data", "scan-backups"));

    private async Task InitializeScanBackupsAsync()
    {
        var epoch = generation;
        var resource = await OptionalResourceAsync("settings", ScanBackupOptions.DocumentId);
        if (resource is null)
        {
            if(resources.TryGetValue("settings:"+ScanBackupOptions.DocumentId,out var removed)&&removed.Field("deleted").True())
                throw new InvalidDataException("扫描备份设置已被移除，请核对数据库配置；不会自动重新启用备份");
            try { await WriteSystemSettingAsync(ScanBackupOptions.DocumentId, new ScanBackupOptions().ToJson()); }
            catch (R19RpcException e) when (e.Status == 409) { }
            resource = await OptionalResourceAsync("settings", ScanBackupOptions.DocumentId);
        }
        if (epoch != generation) return;
        if (resource is null) throw new InvalidDataException("扫描备份设置未初始化");
        if (!BackupUnconfirmed) ApplyScanBackupSetting(resource.Value.Field("value"));
        if(scan is { } current)QueueScanBackup(current,true);
        await RefreshScanBackupCountAsync();
        if(scanBackupCount>0&&!scanBackupPromptShown){scanBackupPromptShown=true;Message($"发现 {scanBackupCount} 份扫描备份，可在“频谱扫描 → 扫描备份”选择恢复");}
    }
    private void ApplyScanBackupSetting(JsonElement value)
    {
        scanBackupOptions = ScanBackupOptions.Parse(value); scanBackupSettingsReady = true;
        scanBackupStatus = scanBackupOptions.Enabled ? "自动备份已启用" : "自动备份已关闭";
        spectrumToolbarRefresh?.Invoke();
    }
    private async Task RefreshScanBackupCountAsync()
    {
        try
        {
            var entries = await Task.Run(() => BackupStore().ListAsync(lifetime.Token));
            scanBackupCount = entries.Count;
        }
        catch (Exception e) { scanBackupStatus = "备份目录读取失败：" + SafeError(e); }
        spectrumToolbarRefresh?.Invoke();
    }
    private void QueueScanBackup(ScanDocument document, bool force = false)
    {
        if ((verification && scanBackupStore is null) || !scanBackupSettingsReady || scanBackupOptions?.Enabled != true || BackupUnconfirmed ||
            document.Points.Count == 0 || document.SourceLabel == "历史备份") return;
        var liveDocument = document.Raw.Text("schema") == "daty-live-scan-v1";
        if (liveDocument && !force && DateTime.UtcNow < scanBackupNextCheckpoint) return;
        if (liveDocument) scanBackupNextCheckpoint = DateTime.UtcNow.AddSeconds(5);
        if (!scanBackupKeys.TryGetValue(document, out var id))
        {
            id = liveDocument ? document.Raw.Text("operation_id")! : Guid.NewGuid().ToString("N");
            if (!liveDocument) scanBackupKeys[document] = id;
        }
        var name = liveDocument?"接收机扫描 "+DateTime.Now.ToString("MM-dd HH:mm"):(document.RecordLabel ?? Path.GetFileNameWithoutExtension(document.FileName));
        if (name.Length > 80) name = name[..80];
        pendingScanBackups[id] = (document, string.IsNullOrWhiteSpace(name) ? "扫描记录" : name);
        if (scanBackupTask.IsCompleted) scanBackupTask = SavePendingScanBackupsAsync();
    }
    private async Task SavePendingScanBackupsAsync()
    {
        while (true)
        {
            if(pendingScanBackups.Count==0)
            {
                await RefreshScanBackupCountAsync();
                if(pendingScanBackups.Count==0)return;
            }
            var (id, pending) = pendingScanBackups.First(); pendingScanBackups.Remove(id);
            if (scanBackupOptions?.Enabled != true || BackupUnconfirmed) continue;
            try
            {
                var options = scanBackupOptions;
                await Task.Run(() => BackupStore().SaveAsync(pending.Document, id, pending.Name, options, lifetime.Token));
                scanBackupStatus = "已自动备份 · " + DateTime.Now.ToString("HH:mm:ss");
                scanBackupLastError=null;
            }
            catch (Exception error)
            {
                scanBackupStatus = "自动备份失败：" + SafeError(error);
                if(scanBackupLastError!=scanBackupStatus)Message(scanBackupStatus + "；当前曲线仍可手动导出", true);
                scanBackupLastError=scanBackupStatus;
            }
            spectrumToolbarRefresh?.Invoke();
        }
    }
    private async Task FlushScanBackupsAsync()
    {
        if (scan is { } document) QueueScanBackup(document, true);
        try { await scanBackupTask.WaitAsync(TimeSpan.FromSeconds(7)); }
        catch (Exception error) { System.Diagnostics.Trace.TraceWarning("Final scan backup unconfirmed: {0}", error.GetType().Name); }
    }
    private void ToggleHistoricalScanPlanning()
    {
        if (scan?.SourceLabel != "历史备份" || LiveScanActive) return;
        if (!scanUseForPlanning && !Confirm("历史扫描用于规划", "此记录来自历史备份，不能代表现场当前占用。确认将其有效测量点用于当前规划？", "用于规划")) return;
        scanUseForPlanning = !scanUseForPlanning; InvalidatePlan(); scanRefresh?.Invoke(); spectrumToolbarRefresh?.Invoke();
        Message(scanUseForPlanning ? "历史扫描已用于规划；生成方案后仍需审查和确认下发" : "历史扫描仅供查看，已退出当前规划");
    }
    private async Task RestoreScanBackupAsync(ScanBackupEntry entry)
    {
        if (LiveScanActive || liveScanSubmitting) throw new InvalidDataException("请先结束当前扫描");
        var request = ++scanRequest;
        var document = await Task.Run(() => BackupStore().LoadAsync(entry, lifetime.Token));
        if (request != scanRequest || LiveScanActive || shutdownStarted) throw new OperationCanceledException();
        scanRecords = [document]; scanUseForPlanning = false; SelectScanRecord(document);
        Message("已恢复历史备份，仅供查看；需要时点击“用于规划”");
    }
    private async Task ShowScanBackupsAsync()
    {
        try
        {
            var entries = await Task.Run(() => BackupStore().ListAsync(lifetime.Token));
            var panel = new StackPanel();
            panel.Children.Add(Text("历史备份恢复后先供查看，可在频谱工具栏选择是否用于规划。", 12));
            var location = Text("保存位置：" + BackupStore().DirectoryPath, 12, "#7c8db5", new(0, 8, 0, 8)); panel.Children.Add(location);
            var enabled = new CheckBox { Content = "自动备份导入资料和扫描进度（每 5 秒，结束时立即保存）", Foreground=B("#e2e8f0"), IsChecked = scanBackupOptions?.Enabled, Margin = new(0, 4, 0, 8), IsEnabled = scanBackupSettingsReady };
            panel.Children.Add(enabled);
            var limits = Select(["64 MiB", "128 MiB", "256 MiB", "512 MiB"]); limits.SelectedIndex = System.Array.IndexOf(new[] { 64, 128, 256, 512 }, scanBackupOptions?.MaxMiB ?? 128);
            limits.IsEnabled = scanBackupSettingsReady;
            panel.Children.Add(Horizontal(Text("容量上限（最多 200 份）：", 12), limits));
            var status = Text(scanBackupStatus, 12, "#7c8db5", new(0, 8, 0, 8)); panel.Children.Add(status);
            var table = Table(("备份时间", "Time", 160), ("名称", "Name", 190), ("原始来源", "Source", 100), ("记录状态", "Status", 0));
            table.Height = 260; table.ItemsSource = entries; panel.Children.Add(table);
            var name = Input("", 280); name.MaxLength = 80; panel.Children.Add(Horizontal(Text("记录名称：", 12), name));
            table.SelectionChanged += (_, _) => name.Text = (table.SelectedItem as ScanBackupEntry)?.Name ?? "";
            Window? dialog = null; bool busy = false;
            async Task Run(Func<Task> action)
            {
                if (busy) return; busy = true;
                try { await action(); status.Text = scanBackupStatus; }
                catch (Exception e) { status.Text = SafeError(e); }
                finally { busy = false; }
            }
            async Task Reload()
            {
                table.ItemsSource = await Task.Run(() => BackupStore().ListAsync(lifetime.Token));
                scanBackupCount = ((IReadOnlyList<ScanBackupEntry>)table.ItemsSource).Count; spectrumToolbarRefresh?.Invoke();
            }
            ScanBackupEntry Selected() => table.SelectedItem as ScanBackupEntry ?? throw new InvalidDataException("请先选择一份备份");
            var save = ActionButton("保存备份设置", () => _ = Run(async () =>
            {
                if (!scanBackupSettingsReady) throw new InvalidDataException("请等待数据库设置读取完成");
                var options = new ScanBackupOptions(enabled.IsChecked == true, new[] { 64, 128, 256, 512 }[limits.SelectedIndex]);
                scanBackupWriter ??= new(WriteSystemSettingAsync, (_, state, value, error) =>
                {
                    if (state == "saved" && value is JsonElement committed) ApplyScanBackupSetting(committed);
                    else scanBackupStatus = state == "saving" ? "正在保存备份设置…" : "备份设置未保存：" + SafeError(error!);
                    status.Text = scanBackupStatus;
                });
                if(scanBackupWriter.HasUnsaved)await scanBackupWriter.Retry();
                await scanBackupWriter.Submit(ScanBackupOptions.DocumentId, options.ToJson());
                if (BackupUnconfirmed) throw new InvalidDataException(scanBackupStatus);
                if (scan is { } current) QueueScanBackup(current, true);
            }));
            var restore = ActionButton("恢复查看", () => _ = Run(async () => { await RestoreScanBackupAsync(Selected()); dialog!.Close(); }), "PrimaryButton");
            var rename = ActionButton("重命名", () => _ = Run(async () => { var entry = Selected();var newName=name.Text;var options=scanBackupOptions??new(); await Task.Run(() => BackupStore().RenameAsync(entry, newName, options, lifetime.Token)); await Reload(); }));
            var delete = ActionButton("删除", () => _ = Run(async () =>
            {
                var entry = Selected(); if(LiveScanActive&&entry.Id==liveScanOperation)throw new InvalidDataException("请先结束当前扫描，再删除它的进度备份");
                if (!Confirm("删除扫描备份", "只删除所选备份：“" + entry.Name + "”。当前已显示曲线保持。", "删除", true)) return;
                await Task.Run(() => BackupStore().DeleteAsync(entry, lifetime.Token)); await Reload();
            }), "DangerButton");
            dialog = CreateSurfaceDialog("扫描备份（" + entries.Count + "）", panel, 900, 640,
                buttons: [save, ActionButton("刷新", () => _ = Run(Reload)), rename, delete, restore, ActionButton("关闭", () => dialog!.Close())]);
            PresentDialog(dialog);
        }
        catch (Exception e) { Message("扫描备份无法打开：" + SafeError(e), true); }
    }
}
