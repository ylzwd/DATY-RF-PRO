using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Data;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Daty.Native.Core;
using Microsoft.Win32;

namespace Daty.Native.App;

public partial class MainWindow : Window
{
    internal static readonly (string Key, string Title)[] Pages = [("dashboard", "📊 设备概览"), ("channels", "📡 通道总览"), ("spectrum", "📈 频谱扫描"), ("planner", "🧮 频率规划"), ("devices", "🔌 设备管理"), ("data", "💾 数据管理"), ("settings", "⚙ 系统设置")];
    private readonly bool verification;
    private readonly LiveState live = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim refreshing = new(1, 1);
    private CancellationTokenSource connection = new();
    private CancellationTokenSource scanReading = new();
    private R19MqttClient? bridge;
    private R19DeviceStream? deviceStream;
    private PluginImportService? pluginImports;
    private Action? pluginRefresh;
    private JsonElement? pluginState;
    private bool importing;
    private readonly System.Collections.Concurrent.ConcurrentQueue<(long Epoch,DeviceSnapshot Snapshot)> incomingSnapshots=new();
    private long liveVersion;
    private readonly DispatcherTimer renderTimer = new() { Interval = TimeSpan.FromMilliseconds(100) };
    private NativeSettings settings = new();
    private long generation;
    private long pageRequest;
    private long scanRequest;
    private string currentPage = "dashboard";
    private Action? liveRefresh;
    private Action? scanRefresh;
    private readonly Dictionary<string, Button> navButtons = [];
    private ScanDocument? scan;
    private JsonElement? projectData;
    private JsonElement? timelineData;
    private int channelPage = 1, devicePage = 1, timelinePage = 1;
    private bool settingsDamaged;
    private double manualStart = 400, manualEnd = 900;

    public MainWindow(bool forVerification = false)
    {
        verification = forVerification;
        if(verification)LoadMonitoringVerificationFixture();
        InitializeComponent(); ProductVersionLabel.Text="统一射频管理平台 "+App.DisplayVersion; InitializeParityShell();
        WindowTheme.Attach(this);
        var icon=Path.Combine(AppContext.BaseDirectory,"assets","DATY-RF-PRO.ico");
        if(File.Exists(icon))Icon=BitmapFrame.Create(new Uri(icon));
        try { if (!verification) settings = NativeSettings.Load(NativeSettings.SettingsPath); }
        catch { if(ProjectEnvironment.Current is not null)throw; settingsDamaged = true; StatusMessage.Text = "桌面设置无法读取，当前使用内存默认值；原设置文件保留。"; }
        manualStart = settings.StartMHz; manualEnd = settings.EndMHz;
        ResetNetworkAddress();
        foreach (var (key, title) in Pages)
        {
            if (key is "dashboard" or "spectrum" or "devices") Navigation.Children.Add(Text(key == "dashboard" ? "概览" : key == "spectrum" ? "频率管理" : "工具", 10, "#4a5578", new Thickness(16, 14, 0, 6)));
            var glyph=new Image{Width=20,Height=20,Margin=new Thickness(0,0,10,0),Source=new BitmapImage(new Uri(Path.Combine(AppContext.BaseDirectory,"assets","ui",key+".png")))};
            var navText=Text(title[(title.IndexOf(' ')+1)..],13,"#7c8db5");navText.SetBinding(TextBlock.ForegroundProperty,new Binding("Foreground"){RelativeSource=new RelativeSource(RelativeSourceMode.FindAncestor,typeof(Button),1)});
            var button = new Button { Content = Horizontal(glyph,navText), Style = (Style)FindResource("NavButton"), Tag = key, Height=42 };
            button.Click += (_, _) => ShowPage(key); navButtons[key] = button; Navigation.Children.Add(button);
        }
        ShowPage("dashboard");
        renderTimer.Tick += (_, _) => {
            PollCommandReceipts();
            DeviceSnapshot? snapshot=null;while(incomingSnapshots.TryDequeue(out var item)){if(item.Epoch!=generation)continue;ObserveAlerts(item.Snapshot.Channels);snapshot=item.Snapshot;}
            if (snapshot is not null && live.Apply(generation, snapshot)) {
                liveVersion++; DeviceDataUpdated();
            }
            PollServerNetwork();
            PollPluginHealth();
            PollLiveScan();
        };
        Loaded += async (_, _) => { if (!verification && !shutdownStarted) { renderTimer.Start(); await EnsureLocalServerAsync(); if(shutdownStarted)return;await ConnectTargetAsync(); if(shutdownStarted)return;await RefreshAsync();if(shutdownStarted)return;await LoadParityDataAsync();if(shutdownStarted)return;await RefreshCommandRecoveryAsync(); } };
    }

    private static Brush B(string value) => new SolidColorBrush((Color)ColorConverter.ConvertFromString(value));
    internal static TextBlock Text(string value, double size = 13, string color = "#e2e8f0", Thickness? margin = null) => new() { Text = value, FontSize = size, FontWeight = FontWeights.Normal, Foreground = B(color), TextWrapping = TextWrapping.Wrap, Margin = margin ?? new Thickness(0), VerticalAlignment = VerticalAlignment.Center };
    private static Border Card(UIElement child, Thickness? margin = null) => new() { Background = B("#111520"), BorderBrush = B("#242c42"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Padding = new Thickness(12), Child = child, Margin = margin ?? new Thickness(0) };
    private static Button Button(string label, Action click) { var button = new Button { Content = label }; button.Click += (_, _) => click(); return button; }
    private static Grid Rows(params GridLength[] values) { var grid = new Grid(); foreach (var v in values) grid.RowDefinitions.Add(new() { Height = v }); return grid; }
    private static void Put(Grid grid, UIElement child, int row) { Grid.SetRow(child, row); grid.Children.Add(child); }
    private static StackPanel Horizontal(params UIElement[] items) { var panel = new StackPanel { Orientation = Orientation.Horizontal }; foreach (var item in items) panel.Children.Add(item); return panel; }
    private static DataGrid Table(params (string Header, string Property, double Width)[] columns)
    {
        var grid = new DataGrid();
        var elementStyle=new Style(typeof(TextBlock));elementStyle.Setters.Add(new Setter(MarginProperty,new Thickness(8,0,8,0)));elementStyle.Setters.Add(new Setter(VerticalAlignmentProperty,VerticalAlignment.Center));elementStyle.Setters.Add(new Setter(TextBlock.TextTrimmingProperty,TextTrimming.CharacterEllipsis));elementStyle.Setters.Add(new Setter(TextBlock.TextWrappingProperty,TextWrapping.NoWrap));elementStyle.Setters.Add(new Setter(ToolTipProperty,new Binding("Text"){RelativeSource=new RelativeSource(RelativeSourceMode.Self)}));
        foreach (var (header, property, width) in columns) grid.Columns.Add(new DataGridTextColumn { Header = header, Binding = new Binding(property), ElementStyle=elementStyle, Width = width <= 0 ? new DataGridLength(1, DataGridLengthUnitType.Star) : new DataGridLength(width), MinWidth = 65 });
        StretchTableColumns(grid);return grid;
    }
    private void Message(string value, bool error = false) { if(shutdownStarted && value!="正在关闭 DATY RF PRO…")return;deviceDataToast=false;StatusToast.ToolTip=null;StatusMessage.Text = value; StatusMessage.Foreground = B(error ? "#fbbf24" : "#a9b7d4"); { StatusToast.Visibility=Visibility.Visible;toastTimer.Stop();toastTimer.Start(); } }

    private async Task ConnectTargetAsync()
    {
        if(shutdownStarted)return;
        await PersistAlertsAsync(true);
        connection.Cancel(); deviceStream?.Dispose(); bridge?.Dispose(); connection = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        generation = live.SwitchTarget(); parityDataReady=false; projectData = null; timelineData = null; pluginState = null; pageRequest++;
        deviceDataError=null;
        monitoringRules=null;monitoringRevision=0;alertMonitor.Rules=null;if(currentPage is "dashboard" or "channels")ShowPage(currentPage);else if(currentPage == "spectrum")liveRefresh?.Invoke();
        systemSettingsReady=false;systemSettingsWriter=null;systemSettingErrors.Clear();systemSettingsSaveTask=null;ResetPlanningSettings();ResetSpectrumSettings();settingOperations.Clear();networkSettings=JsonSerializer.SerializeToElement(SystemSettingDefaults["network_connection"]);
        incomingSnapshots.Clear();manualChannels=[];confirmedMute.Clear();soundEnabled=false;sharedSettingsVersions.Clear();thresholds=new();automaticFrequency=false;scan=null;scanRecords=[];customProfiles=JsonSerializer.SerializeToElement(System.Array.Empty<object>());RestoreAlertState();resources.Clear();databaseEpoch=null;planResult=null;locks.Clear(); pluginImports = null;
        var epoch = generation;
        try {
            var ca = ProjectEnvironment.Current?.CertificatePath ?? Path.Combine(AppContext.BaseDirectory, "assets", "DATY-root-ca.cer");
            bridge = new R19MqttClient(settings.Server, ca, settings.MqttPort);
            try { pluginImports = new PluginImportService(bridge, Path.Combine(Path.GetDirectoryName(NativeSettings.SettingsPath)!, "pending-plugin-install.json")); }
            catch (Exception error) { Message("插件待确认记录无法读取：" + SafeError(error), true); }
            pluginRemovals=null;
            try { pluginRemovals=new PluginExportRemovalService(bridge,Path.Combine(Path.GetDirectoryName(NativeSettings.SettingsPath)!,"pending-plugin-removal.json")); }
            catch(Exception error){Message("插件卸载待确认记录无法读取："+SafeError(error),true);}
            _=RecoverPluginRemovalAsync();
            deviceStream = new R19DeviceStream(settings.Server, ca, settings.MqttPort);
            deviceStream.SnapshotReceived += snapshot => {
                if (!shutdownStarted && !connection.IsCancellationRequested && epoch == generation) incomingSnapshots.Enqueue((epoch,snapshot));
            };
            deviceStream.Offline += reason => Dispatcher.InvokeAsync(() => {
                if (shutdownStarted || epoch != generation || lifetime.IsCancellationRequested) return;
                incomingSnapshots.Clear(); live.Fail(epoch); ResetNetworkAddress(); ObserveAlerts(ViewChannels);
                DeviceDataUnavailable(reason,showToast:!importing);
            });
            deviceStream.Start();
        }
        catch (Exception error) { bridge = null; DeviceDataUnavailable("运行初始化失败：" + SafeError(error)); }
        ResetNetworkAddress();
        UpdateLive();
    }
    private async Task RefreshAsync()
    {
        if (shutdownStarted || bridge is null || !await refreshing.WaitAsync(0)) return;
        var client = bridge; var token = connection.Token; var epoch = generation; var version = liveVersion;
        RefreshButton.IsEnabled = false;
        try
        {
            var snapshot = await client.SnapshotAsync(token);
            if (!token.IsCancellationRequested && version == liveVersion && live.Apply(epoch, snapshot))
            {
                ObserveAlerts(snapshot.Channels);
                DeviceDataUpdated();
            }
        }
        catch (Exception error)
        {
            if (!token.IsCancellationRequested && version == liveVersion && live.Fail(epoch))
            {
                DeviceDataUnavailable(SafeError(error));
            }
        }
        finally { refreshing.Release(); RefreshButton.IsEnabled = true; }
    }
    private static string SafeError(Exception error) => error switch
    {
        OperationCanceledException => "请求超时或已取消",
        R19RpcException rpc => rpc.Code switch {
            "PLUGIN_PACKAGE_NOT_TRUSTED" => "插件包未经平台审核，或文件内容已改变",
            "PLUGIN_REVISION_CHANGED" => "服务器插件状态已变化，请重新选择",
            "TARGET_PENDING_OR_UNCERTAIN" => "服务器正在自动核对该通道的上一条指令，请稍候",
            "REVIEW_OBSERVATION_CHANGED" or "REVIEW_REVISION_CHANGED" or "REVIEW_EXPIRED_OR_CHANGED" => "接收机状态已变化，服务器将继续自动核对",
            "SERVER_BOOT_CHANGED" => "服务器已重新启动，请重新操作",
            "INSTALL_OPERATION_NOT_FOUND" => "服务器未记录本次安装，可以重新选择插件包",
            _ => rpc.Code },
        System.Net.Http.HttpRequestException http => http.StatusCode.HasValue ? $"HTTP {(int)http.StatusCode}" : "网络或服务器证书验证失败",
        InvalidDataException invalid => invalid.Message,
        IOException io => io.Message.Length <= 240 ? io.Message : "文件或数据无法读取",
        _ => error.Message.Length <= 240 ? error.Message : "数据格式或处理异常"
    };
    private async void Refresh_Click(object sender, RoutedEventArgs e) { await RefreshAsync(); if (currentPage is "planner" or "data") await LoadDataAsync(); }
    private void UpdateLive()
    {
        var online = ViewChannels.Where(c => c.Online).ToArray();
        var receiverCount=online.Select(c => c.DisplayReceiverKey).Distinct().Count();
        ConnectionLabel.Text = live.Connected ? $"{receiverCount}台接收机在线" : deviceDataError is null&&live.Snapshot is null ? "正在启动…" : "设备数据暂不可用";
        SetStatusToolTip(ConnectionLabel,live.Connected?$"运行正常 · {receiverCount} 台接收机在线\n设备数据实时更新":deviceDataError is null&&live.Snapshot is null?"正在准备设备数据":"设备数据暂不可用，正在自动恢复。\n上次数据不作为当前在线状态。");
        ConnectionLabel.Foreground = B("#7c8db5"); ConnectionDot.Fill=AddressDot.Fill=B(live.Connected?"#10b981":"#f59e0b");
        ClockLabel.Text = "服务器时钟：" + (live.Connected ? Wire.LocalTime(live.Snapshot?.ServerTimeMs / 1000.0).Split(' ').Last() : "—");
        UpdateNetworkAddressLabel();
        liveRefresh?.Invoke();
    }

    internal void ShowPage(string key)
    {
        if(shutdownStarted)return;
        if (!Pages.Any(p => p.Key == key)) return;
        if (currentPage == "spectrum" && key != "spectrum") { scanRequest++; scanReading.Cancel(); }
        currentPage = key; pageRequest++; liveRefresh = null; scanRefresh = null; pluginRefresh = null;
        foreach (var (id, button) in navButtons) { button.Foreground=B(id==key?"#6366f1":"#7c8db5");button.Background=B(id==key?"#191b2c":"#111520");button.BorderBrush=B(id==key?"#6366f1":"Transparent"); } ApplyPageSpacing();
        SetHeadingText(PageTitle,Pages.Single(p => p.Key == key).Title);
        PageContent.Content = key switch { "dashboard" => Dashboard(), "channels" => Channels(), "spectrum" => Spectrum(), "planner" => Planner(), "devices" => Devices(), "data" => Data(), _ => Settings() };
        liveRefresh?.Invoke();
        if (!verification && key is "planner" or "data") _ = LoadDataAsync();
        if (!verification && key == "settings") _ = LoadPluginsAsync();
    }

    private UIElement LegacySpectrum()
    {
        var grid = Rows(GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto);
        var start = new TextBox { Text = settings.StartMHz.ToString(CultureInfo.InvariantCulture), Width = 75, Margin = new Thickness(0, 0, 6, 0) };
        var end = new TextBox { Text = settings.EndMHz.ToString(CultureInfo.InvariantCulture), Width = 75, Margin = new Thickness(6, 0, 8, 0) };
        var plot = new SpectrumPlot { MinHeight = 180 }; var label = Text("", 12, "#7c8db5", new Thickness(0, 12, 0, 0));
        var tools = new WrapPanel { Margin = new Thickness(0, 0, 0, 14) };
        foreach (var child in new UIElement[] { start, Text("—"), end, Text("MHz  ") }) tools.Children.Add(child);
        tools.Children.Add(Button("应用范围", () => { if (!double.TryParse(start.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out var a) || !double.TryParse(end.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out var b) || !double.IsFinite(a) || !double.IsFinite(b) || a < 30 || b > 3000 || a >= b) { Message("频谱范围需为 30～3000 MHz 内递增数值", true); return; } manualStart = a; manualEnd = b; settings = settings with { StartMHz = a, EndMHz = b }; liveRefresh?.Invoke(); }));
        tools.Children.Add(Button("适配设备", () => { var freqs = ViewChannels.Where(c => c.Online && c.FrequencyKHz.HasValue).Select(c => c.FrequencyKHz!.Value / 1000.0).ToArray(); if (freqs.Length == 0) { Message("没有可适配的在线设备频点", true); return; } var margin = Math.Max(1, (freqs.Max() - freqs.Min()) * .1); settings = settings with { StartMHz = Math.Max(30, freqs.Min() - margin), EndMHz = Math.Min(3000, freqs.Max() + margin) }; start.Text = settings.StartMHz.ToString("0.###", CultureInfo.InvariantCulture); end.Text = settings.EndMHz.ToString("0.###", CultureInfo.InvariantCulture); liveRefresh?.Invoke(); }));
        tools.Children.Add(Button("恢复范围", () => { settings = settings with { StartMHz = manualStart, EndMHz = manualEnd }; start.Text = manualStart.ToString(CultureInfo.InvariantCulture); end.Text = manualEnd.ToString(CultureInfo.InvariantCulture); liveRefresh?.Invoke(); }));
        tools.Children.Add(Button("导入扫描 CSV", () => _ = ImportScanAsync()));
        tools.Children.Add(Button("清除扫描", () => { scanRequest++; scanReading.Cancel(); scan = null; liveRefresh?.Invoke(); Message("已清除本次预览扫描；原始文件保留"); }));
        Put(grid, tools, 0); Put(grid, Card(plot), 1); Put(grid, label, 2);
        liveRefresh = () => { plot.Channels = ViewChannels; plot.MonitoringRules = monitoringRules; plot.Points = scan?.Points ?? []; plot.StartMHz = settings.StartMHz; plot.EndMHz = settings.EndMHz; plot.InvalidateVisual(); label.Text = scan is null ? "设备离散频点不等于连续频谱扫描 · 尚未导入真实 CSV" : $"真实 CSV：{scan.FileName} · {scan.Points.Count:N0} 点 · {scan.DuplicateRows} 条重复频点取峰值 · 本次会话预览，未上传"; };
        scanRefresh = liveRefresh; return grid;
    }

    private UIElement LegacyDevices()
    {
        var grid = Rows(GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto);
        Put(grid, Text("在线设备与通道 · 接收机身份和 CH 独立定位 · RTT 使用服务端同会话 ACK 测量", 12, "#7c8db5", new Thickness(0, 0, 0, 12)), 0);
        var table = Table(("品牌", "Brand", 100), ("接收机 IP", "Ip", 125), ("编组", "Group", 90), ("通道", "ChannelLabel", 75), ("频率 MHz", "Frequency", 100), ("RF", "Rf", 95), ("AF", "Af", 100), ("电池", "BatteryLabel", 80), ("RTT", "Rtt", 100), ("状态", "OnlineLabel", 75));
        Put(grid, table, 1); var count = Text("", 12, "#7c8db5"); var prev = Button("上一页", () => { devicePage--; liveRefresh?.Invoke(); }); var next = Button("下一页", () => { devicePage++; liveRefresh?.Invoke(); }); Put(grid, Horizontal(prev, next, count), 2);
        liveRefresh = () => { var rows = ViewChannels.ToArray(); var pages = Math.Max(1, (rows.Length + 19) / 20); devicePage = Math.Clamp(devicePage, 1, pages); table.ItemsSource = rows.Skip((devicePage - 1) * 20).Take(20).ToArray(); count.Text = $"第 {devicePage}/{pages} 页 · 共 {rows.Length} 通道 · 每页 20 条"; prev.IsEnabled = devicePage > 1; next.IsEnabled = devicePage < pages; };
        return grid;
    }

    private UIElement LegacyPlanner()
    {
        var grid = Rows(GridLength.Auto, GridLength.Auto, new GridLength(1, GridUnitType.Star), new GridLength(1, GridUnitType.Star));
        Put(grid, Text("当前阶段提供服务器规划历史的原生只读查看。完整规划器、人工约束编辑、Profile 和单独/批量下发仍待迁移验收。", 12, "#7c8db5", new Thickness(0, 0, 0, 12)), 0);
        var refresh = Button("读取当前项目", () => _ = LoadDataAsync()); var export = Button("导出项目快照", () => _ = ExportProjectAsync()); Put(grid, Horizontal(refresh, export), 1);
        var table = Table(("时间", "Time", 165), ("方案", "Name", 0), ("通道", "Channels", 70), ("算法", "Algorithm", 180), ("冲突", "Conflicts", 70), ("净裕量", "Margin", 100)); table.Margin = new Thickness(0, 12, 0, 12); Put(grid, table, 2);
        var detail = new TextBox { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, AcceptsReturn = true, Text = "尚未读取规划数据" }; Put(grid, detail, 3);
        liveRefresh = () =>
        {
            var project = projectData?.Field("project") ?? default;
            var records = project.Field("data").Field("planningHistory");
            var rows = records.ValueKind == JsonValueKind.Array ? records.EnumerateArray().ToArray() : [];
            table.ItemsSource = rows.Select(r => new PlanningRow(r.Text("time") ?? Wire.LocalTime(r.Number("timestamp") / 1000), r.Text("name") ?? "—", r.Text("channels") ?? "—", r.Text("algo") ?? "—", r.Text("imdConflicts") ?? "—", r.Text("imdMargin") ?? "—")).ToArray();
            detail.Text = project.ValueKind == JsonValueKind.Undefined ? "未取得项目数据；不会用历史文件冒充当前服务器数据。" : JsonSerializer.Serialize(project, new JsonSerializerOptions { WriteIndented = true });
        };
        return grid;
    }

    private UIElement LegacyData()
    {
        var grid = Rows(GridLength.Auto, GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto);
        var actions = new WrapPanel(); foreach (var b in new[] { Button("导出设备快照", () => _ = ExportSnapshotAsync()), Button("导出项目快照", () => _ = ExportProjectAsync()), Button("导出 Timeline", () => _ = ExportTimelineAsync()), Button("重新读取", () => _ = LoadDataAsync()) }) actions.Children.Add(b);
        Put(grid, actions, 0); Put(grid, Text("Timeline · 当前服务器接口最多读取最新 200 条，再按每页 20 条显示；导出包含来源与采集时间。", 12, "#7c8db5", new Thickness(0, 12, 0, 12)), 1);
        var table = Table(("时间", "Time", 170), ("事件类型", "Type", 150), ("目标", "Target", 170), ("摘要", "Summary", 0)); Put(grid, table, 2);
        var count = Text("", 12, "#7c8db5"); var prev = Button("上一页", () => { timelinePage--; liveRefresh?.Invoke(); }); var next = Button("下一页", () => { timelinePage++; liveRefresh?.Invoke(); }); Put(grid, Horizontal(prev, next, count), 3);
        liveRefresh = () => { var events = timelineData?.Field("events") ?? default; var rows = events.ValueKind == JsonValueKind.Array ? events.EnumerateArray().Select(e => new TimelineRow(Wire.LocalTime(e.Number("ts")), e.Text("event_type") ?? "—", e.Text("device_id") ?? e.Text("project_id") ?? "—", e.Text("summary") ?? "—", e.Field("details").ValueKind != JsonValueKind.Undefined ? e.Field("details").GetRawText() : "")).ToArray() : []; var pages = Math.Max(1, (rows.Length + 19) / 20); timelinePage = Math.Clamp(timelinePage, 1, pages); table.ItemsSource = rows.Skip((timelinePage - 1) * 20).Take(20).ToArray(); count.Text = $"第 {timelinePage}/{pages} 页 · 已读取 {rows.Length} 条"; prev.IsEnabled = timelinePage > 1; next.IsEnabled = timelinePage < pages; };
        return grid;
    }

    private async Task LoadDataAsync()
    {
        if (bridge is null) { Message("数据服务尚未就绪", true); return; }
        var client = bridge; var epoch = generation; var request = ++pageRequest; var page = currentPage; var token = connection.Token;
        try
        {
            var projectReply = await ReadRpcAsync("projects.get", new { id = "default" });
            var project = ReadBody(projectReply);
            JsonElement timeline = default;
            if (epoch != generation || request != pageRequest || page != currentPage || token.IsCancellationRequested) return;
            if (!project.Field("success").True() || project.Field("project").ValueKind != JsonValueKind.Object) throw new InvalidDataException("项目返回格式错误");
            // Audit history is no longer queried.
            projectData = project; if (page == "data") timelineData = timeline; liveRefresh?.Invoke();
        }
        catch (Exception error) { if (epoch == generation && request == pageRequest && !token.IsCancellationRequested) Message("读取未完成：" + SafeError(error), true); }
    }

    private UIElement LegacySettings()
    {
        var stack = new StackPanel(); stack.Children.Add(Text("本机桌面连接", 16));
        stack.Children.Add(Text("服务器地址（HTTPS 标识，业务使用 MQTT）", 12, "#7c8db5", new Thickness(0, 16, 0, 6)));
        var address = new TextBox { Text = settings.Server, MaxWidth = 540, HorizontalAlignment = HorizontalAlignment.Left, MinWidth = 420 }; stack.Children.Add(address);
        stack.Children.Add(Text("连接偏好周期（1～60 秒；实时电平由 MQTT 连续推送）", 12, "#7c8db5", new Thickness(0, 16, 0, 6)));
        var interval = new TextBox { Text = settings.PollSeconds.ToString(), Width = 100, HorizontalAlignment = HorizontalAlignment.Left }; stack.Children.Add(interval);
        var save = Button("保存并重新连接", () => _ = SaveSettingsAsync(address.Text, interval.Text)); save.Margin = new Thickness(0, 18, 0, 16); save.HorizontalAlignment = HorizontalAlignment.Left; stack.Children.Add(save);
        if (settingsDamaged) stack.Children.Add(Text("原设置文件读取失败，已保留。明确保存将替换本机桌面设置，不影响服务器或浏览器数据。", 12, "#fbbf24", new Thickness(0, 0, 0, 12)));
        stack.Children.Add(Text("连接与数据边界", 14, "#e2e8f0", new Thickness(0, 12, 0, 10)));
        stack.Children.Add(Text("• 直接使用 MQTT 5 / WSS 接入 r19，严格校验 CA 与主机名。\n• DATYaudio 内置；其他品牌须导入并由服务器确认启用。\n• 插件超时只查询原操作结果，不自动重复安装。\n• 原生开发版 0.2.0：完整规划、设备下发、声音和业务编辑仍待迁移。", 12, "#7c8db5"));
        var pluginList = new StackPanel { Margin = new Thickness(0, 12, 0, 0) };
        stack.Children.Add(Text("品牌插件管理", 16, margin:new Thickness(0,24,0,10)));
        var importButton = Button("📥 导入插件", () => _ = ImportPluginAsync());
        var queryButton = Button("查询安装结果", () => _ = QueryPluginAsync());
        var statusButton = Button("读取插件状态", () => _ = LoadPluginsAsync());
        stack.Children.Add(Horizontal(importButton, queryButton, statusButton)); stack.Children.Add(pluginList);
        pluginRefresh = () => {
            importButton.IsEnabled = !importing && pluginImports is not null;
            queryButton.IsEnabled = !importing && pluginImports?.Pending is not null;
            pluginList.Children.Clear();
            if (pluginState is null) { pluginList.Children.Add(Text("等待服务器确认插件状态…",12,"#7c8db5")); return; }
            foreach(var key in new[]{"builtin","plugins"}) {
                var items=pluginState.Value.Field(key);
                if(items.ValueKind!=JsonValueKind.Array)continue;
                foreach(var item in items.EnumerateArray()) {
                    var state=key=="builtin"?"内置":item.Field("active").True()?"已导入 · 已启用":"已安装 · 未启用";
                    pluginList.Children.Add(Card(Text($"{item.Text("name")??item.Text("brand")}   {item.Text("version")}   {state}",13),new Thickness(0,0,0,8)));
                }
            }
        };
        pluginRefresh();
        return Card(new ScrollViewer { Content = stack, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
    }
    private async Task SaveSettingsAsync(string address, string interval)
    {
        try
        {
            if (!int.TryParse(interval, out var seconds)) throw new InvalidDataException("刷新周期必须是整数");
            if(PlanningUnconfirmed||SpectrumUnconfirmed||spectrumInputInvalid||systemSettingsSavingAll||systemSettingsWriter?.HasUnsaved==true||settingOperations.Count>0)throw new InvalidDataException("请先完成规划、频谱及系统设置的数据库保存，再切换服务器");
            var candidate = settings with { Server = BridgeClient.ValidateOrigin(address).GetLeftPart(UriPartial.Authority), PollSeconds = seconds };
            candidate.Validate(); await candidate.SaveAsync(NativeSettings.SettingsPath, lifetime.Token); settings = candidate; settingsDamaged = false;
            await ConnectTargetAsync(); Message("桌面设置已保存，正在重新连接"); await RefreshAsync();await LoadParityDataAsync();await RefreshCommandRecoveryAsync();
        }
        catch (Exception error) { Message("设置未保存：" + SafeError(error), true); }
    }

    private Task ExportSnapshotAsync() => live.Snapshot is null ? NoExport("尚无服务器设备快照可导出") : ExportAsync("设备快照", new { format = "daty-native-observation-v1", source = settings.Server, capturedAt = live.Snapshot.ReceivedAt, connectedNow = live.Connected, snapshot = live.Snapshot.Raw });
    private Task ExportProjectAsync() => projectData is null ? NoExport("请先读取服务器项目") : ExportAsync("项目快照", new { format = "daty-native-project-observation-v1", source = settings.Server, project = projectData });
    private Task ExportTimelineAsync() => timelineData is null ? NoExport("请先读取服务器 Timeline") : ExportAsync("Timeline", new { format = "daty-native-timeline-observation-v1", source = settings.Server, timeline = timelineData });
    private Task NoExport(string message) { Message(message, true); return Task.CompletedTask; }
    private async Task ExportAsync(string title, object data)
    {
        var dialog = new SaveFileDialog { Title = "导出" + title, Filter = "JSON 数据|*.json", FileName = $"DATY-{title}-{DateTime.Now:yyyyMMdd-HHmmss}.json", OverwritePrompt = true, AddExtension = true };
        if (dialog.ShowDialog(this) != true) return;
        try { await LocalFiles.WriteAtomicAsync(dialog.FileName, JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true }), lifetime.Token); Message(title + "已保存到所选文件"); }
        catch (Exception error) { Message("文件未保存：" + SafeError(error), true); }
    }

    internal void SetVerificationSnapshot(DeviceSnapshot snapshot, bool connected = true) { generation = live.SwitchTarget(); live.Apply(generation, snapshot); if (!connected) live.Fail(generation);ObserveAlerts(ViewChannels); Message(connected ? "隔离固定数据 · 无网络请求 · 不代表现场设备" : "隔离断线场景 · 上次数据已标记离线"); UpdateLive(); }
    internal void SetVerificationScan(ScanDocument value) { scan = value; settings = settings with { StartMHz = 640, EndMHz = 645 }; scanRefresh?.Invoke(); }
    internal void SetVerificationRange(double start,double end){planRange="custom";planStart=(start+10).ToString(CultureInfo.InvariantCulture);planEnd=(end-10).ToString(CultureInfo.InvariantCulture);settings=settings with{StartMHz=start,EndMHz=end};}
    internal void ShowVerificationView(string view){var parts=view.Split(':');if(parts[0]=="devices")deviceTab=parts[1];if(parts[0]=="data")dataTab=parts[1];if(parts[0]=="planner")plannerTab=parts[1];if(parts[0]=="audit"){dataTab="audit";auditTab=parts[1];}ShowPage(parts[0]=="audit"?"data":parts[0]);}
}
