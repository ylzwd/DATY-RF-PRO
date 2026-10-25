using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jint;

namespace Daty.Native.Core;

public static class LocalFiles
{
    public const int ScanLimit = 16 * 1024 * 1024;
    public static async Task<byte[]> ReadBoundedAsync(string path, int maxBytes, CancellationToken token)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 16384, true);
        if (stream.Length > maxBytes) throw new InvalidDataException("文件超过大小限制");
        using var output = new MemoryStream();
        var buffer = new byte[16384];
        while (true) { var n = await stream.ReadAsync(buffer, token); if (n == 0) break; if (output.Length + n > maxBytes) throw new InvalidDataException("文件读取期间超过大小限制"); output.Write(buffer, 0, n); }
        return output.ToArray();
    }
    public static ScanDocument ParseScan(byte[] bytes, string fileName, CancellationToken token)
    {
        if (bytes.Length > ScanLimit) throw new InvalidDataException("扫描 CSV 超过 16 MiB");
        var text = new UTF8Encoding(false, true).GetString(bytes);
        var assembly = typeof(LocalFiles).Assembly;
        string Script(string name) { var resource = assembly.GetManifestResourceNames().Single(n => n.EndsWith("." + name, StringComparison.Ordinal)); using var stream = assembly.GetManifestResourceStream(resource)!; using var reader = new StreamReader(stream); return reader.ReadToEnd(); }
        var engine = new Engine(o => o.TimeoutInterval(TimeSpan.FromSeconds(12)).CancellationToken(token).LimitMemory(192 * 1024 * 1024));
        engine.Execute("var window = globalThis;");
        engine.Execute(Script("frequency.js"));
        engine.Execute(Script("scan-csv.js"));
        engine.SetValue("scanText", text);
        var json = engine.Evaluate("JSON.stringify(DatyScanCsv.parseScanCsv(scanText))").AsString();
        using var document = JsonDocument.Parse(json);
        var result = document.RootElement;
        var points = result.Field("points").EnumerateArray().Select(p => new ScanPoint(p.GetProperty("frequencyKHz").GetInt32(), p.GetProperty("levelDbm").GetDouble())).ToArray();
        return new(Path.GetFileName(fileName), Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), points, result.GetProperty("duplicateRows").GetInt32(), result.Clone());
    }

    public static async Task WriteAtomicAsync(string path, string content, CancellationToken token)
        => await WriteAtomicBytesAsync(path,Encoding.UTF8.GetBytes(content),token);
    public static async Task WriteAtomicBytesAsync(string path,byte[] bytes,CancellationToken token)
    {
        var full = Path.GetFullPath(path);
        var directory = Path.GetDirectoryName(full)!;
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(directory, ".daty-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 16384, FileOptions.WriteThrough))
            { await output.WriteAsync(bytes, token); await output.FlushAsync(token); output.Flush(true); }
            token.ThrowIfCancellationRequested();
            File.Move(temporary, full, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}

public sealed record NativeSettings(string Server = "https://127.0.0.1:18080", int PollSeconds = 2, [property:System.Text.Json.Serialization.JsonIgnore] double StartMHz = 400, [property:System.Text.Json.Serialization.JsonIgnore] double EndMHz = 900, int MqttPort = 18083)
{
    public static string SettingsPath => ProjectEnvironment.Current?.SettingsPath ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DATY RF PRO Native", "settings-v1.json");
    public static async Task RemoveLegacyPlanningRangeAsync(string path,CancellationToken token)
    {
        if(!File.Exists(path))return;
        var bytes=await LocalFiles.ReadBoundedAsync(path,16384,token);
        var data=System.Text.Json.Nodes.JsonNode.Parse(bytes)?.AsObject()??throw new InvalidDataException("桌面连接设置为空");
        var changed=data.Remove("StartMHz")|data.Remove("EndMHz");
        if(changed){var current=await File.ReadAllBytesAsync(path,token);if(!bytes.SequenceEqual(current))throw new IOException("本机连接设置正在被其他窗口修改");await LocalFiles.WriteAtomicAsync(path,data.ToJsonString(),token);}
    }
    public static NativeSettings Load(string path)
    {
        if (!File.Exists(path)) return ProjectEnvironment.Current?.Defaults ?? new();
        if (new FileInfo(path).Length > 16384) throw new InvalidDataException("桌面设置文件过大");
        var value = JsonSerializer.Deserialize<NativeSettings>(File.ReadAllText(path)) ?? throw new InvalidDataException("桌面设置为空");
        // Old native preview stored only an HTTPS origin on 8802. Normalize the known legacy port in memory.
        if (Uri.TryCreate(value.Server,UriKind.Absolute,out var old) && old.Port == 8802) value=value with {Server=new UriBuilder(old){Port=8080}.Uri.GetLeftPart(UriPartial.Authority)};
        value.Validate();
        if(ProjectEnvironment.Current is { } project && Path.GetFullPath(path)==project.SettingsPath && (value.Server!=project.Defaults.Server || value.MqttPort!=project.MqttPort))
            throw new InvalidDataException("独立项目的连接地址必须与本项目端口一致，禁止回退到正式服务器。");
        return value;
    }
    public void Validate()
    {
        Daty.Native.Contracts.R19Endpoints.FromWebOrigin(Server,MqttPort);
        if (PollSeconds is < 1 or > 60 || !double.IsFinite(StartMHz) || !double.IsFinite(EndMHz) || StartMHz < 30 || EndMHz > 3000 || StartMHz >= EndMHz) throw new InvalidDataException("刷新周期或频谱范围无效");
    }
    public Task SaveAsync(string path, CancellationToken token) {
        Validate();
        if(ProjectEnvironment.Current is { } project && Path.GetFullPath(path)==project.SettingsPath && (Server!=project.Defaults.Server || MqttPort!=project.MqttPort))
            throw new InvalidDataException("DATY RF PRO 一体运行，界面固定连接本项目后台。");
        return LocalFiles.WriteAtomicAsync(path, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }), token);
    }
}
