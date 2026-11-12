using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Daty.Native.Core;

public sealed record ScanBackupOptions(bool Enabled = true, int MaxMiB = 128)
{
    public const string DocumentId = "scan_backup";
    public static ScanBackupOptions Parse(JsonElement value)
    {
        if (value.Text("schema") != "daty-scan-backup-settings-v1" || value.EnumerateObject().Count() != 3 ||
            value.Field("enabled").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            value.Number("maxMiB") is not (64 or 128 or 256 or 512))
            throw new InvalidDataException("扫描备份设置无效");
        return new(value.Field("enabled").True(), (int)value.Number("maxMiB")!);
    }
    public JsonElement ToJson() => JsonSerializer.SerializeToElement(new { schema = "daty-scan-backup-settings-v1", enabled = Enabled, maxMiB = MaxMiB });
}

public sealed record ScanBackupEntry(string Id, string Name, DateTimeOffset SavedAt, string Source,
    string State, int Points, int Missing, long Bytes, string Revision, string? Error = null)
{
    public string Time => SavedAt == default ? "—" : SavedAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");
    public string Status => Error is null ? State + $" · {Points:N0} 点 · 缺失 {Missing:N0}" : "无法读取：" + Error;
}

/// <summary>Instance-local working files, independent of the retired database history APIs.</summary>
public sealed class ScanBackupStore(string directory)
{
    public const int MaxRecords = 200;
    public string DirectoryPath { get; } = Path.GetFullPath(directory);

    private void GuardDirectory()
    {
        for (var d = new DirectoryInfo(DirectoryPath); d is not null; d = d.Parent)
            if (d.Exists && (d.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("扫描备份目录不能使用目录链接");
        Directory.CreateDirectory(DirectoryPath);
    }
    private string FilePath(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new InvalidDataException("备份标识无效");
        var path = Path.Combine(DirectoryPath, id + ".datyscan");
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("扫描备份不能使用文件链接");
        return path;
    }
    private async Task<FileStream> LockAsync(CancellationToken token)
    {
        GuardDirectory();
        var path = Path.Combine(DirectoryPath, ".backup.lock");
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("备份锁不能使用文件链接");
        for (var i = 0; ; i++)
        {
            token.ThrowIfCancellationRequested();
            try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (i < 50) { await Task.Delay(100, token); }
        }
    }
    private string[] Files()
    {
        var files = Directory.EnumerateFiles(DirectoryPath, "*.datyscan").Take(2049).ToArray();
        if (files.Length > 2048) throw new IOException("扫描备份文件过多，请先整理备份目录");
        return files;
    }
    private static string ValidName(string name)
    {
        name = name.Trim();
        if (name.Length is < 1 or > 80 || name.Any(char.IsControl)) throw new InvalidDataException("备份名称须为 1～80 个字符");
        return name;
    }
    private void Capacity(string path, int bytes, ScanBackupOptions options)
    {
        _ = ScanBackupOptions.Parse(options.ToJson());
        if (bytes > LocalFiles.ScanLimit) throw new IOException("单份扫描备份超过 16 MiB，请手动导出");
        var files = Files();
        if (!File.Exists(path) && files.Length >= MaxRecords) throw new IOException("扫描备份已达 200 份，请删除不需要的记录后重试");
        long total = 0;
        var allFiles = Directory.EnumerateFiles(DirectoryPath).Take(4097).ToArray();
        if (allFiles.Length > 4096) throw new IOException("备份目录文件过多，请先整理");
        foreach (var file in allFiles)
        {
            if (Path.GetFileName(file) == ".backup.lock") continue;
            var info = new FileInfo(file);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("备份目录含文件链接");
            total = checked(total + info.Length);
        }
        var previous = File.Exists(path) ? new FileInfo(path).Length : 0;
        if (total - previous + bytes > (long)options.MaxMiB * 1024 * 1024)
            throw new IOException($"扫描备份已达 {options.MaxMiB} MiB 容量限制，请删除记录或提高上限");
    }
    private static ScanBackupEntry ReadEntry(byte[] bytes, string id, CancellationToken token)
    {
        var document = ScanExchange.Import(bytes, id + ".datyscan", token);
        var metadata = document.Raw.Field("backup");
        if (metadata.Text("schema") != "daty-scan-backup-v1" || metadata.Text("id") != id ||
            !DateTimeOffset.TryParse(metadata.Text("saved_at"), System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.RoundtripKind, out var saved))
            throw new InvalidDataException("备份资料不完整");
        return new(id, ValidName(metadata.Text("name") ?? ""), saved, document.Raw.Text("source") ?? "未知来源",
            ScanExchange.OutcomeLabel(document), document.Points.Count, document.MissingPoints, bytes.Length, R19Transfers.Digest(bytes));
    }
    public async Task<IReadOnlyList<ScanBackupEntry>> ListAsync(CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if(!Directory.Exists(DirectoryPath))return [];
        using var lease = await LockAsync(token);
        var entries = new List<ScanBackupEntry>();
        foreach (var file in Files())
        {
            token.ThrowIfCancellationRequested();
            var id = Path.GetFileNameWithoutExtension(file);
            if (!Guid.TryParseExact(id, "N", out _)) continue;
            try { entries.Add(ReadEntry(await LocalFiles.ReadBoundedAsync(FilePath(id), LocalFiles.ScanLimit, token), id, token)); }
            catch (Exception e) when (e is IOException or InvalidDataException or JsonException or InvalidOperationException or FormatException or ArgumentException or UnauthorizedAccessException)
            { var info = new FileInfo(file); entries.Add(new(id, id, default, "—", "—", 0, 0, info.Length, Stamp(info), e is InvalidDataException ? e.Message : "文件损坏或无法读取")); }
        }
        return entries.OrderByDescending(e => e.SavedAt).ToArray();
    }
    public async Task<ScanBackupEntry> SaveAsync(ScanDocument document, string id, string name, ScanBackupOptions options, CancellationToken token)
    {
        var root = JsonNode.Parse(ScanExchange.Export(document))!.AsObject();
        root["backup"] = JsonSerializer.SerializeToNode(new { schema = "daty-scan-backup-v1", id, name = ValidName(name), saved_at = DateTimeOffset.UtcNow });
        var bytes = Encoding.UTF8.GetBytes(root.ToJsonString());
        var entry = ReadEntry(bytes, id, token); // Validate before touching the previous checkpoint.
        using var lease = await LockAsync(token);
        var path = FilePath(id);
        if(File.Exists(path))
        {
            var previous=ReadEntry(await LocalFiles.ReadBoundedAsync(path,LocalFiles.ScanLimit,token),id,token);
            root["backup"]!["name"]=previous.Name;bytes=Encoding.UTF8.GetBytes(root.ToJsonString());entry=ReadEntry(bytes,id,token);
        }
        Capacity(path, bytes.Length, options);
        await LocalFiles.WriteAtomicBytesAsync(path, bytes, token);
        return entry;
    }
    public async Task<ScanDocument> LoadAsync(ScanBackupEntry entry, CancellationToken token)
    {
        using var lease = await LockAsync(token);
        var bytes = await LocalFiles.ReadBoundedAsync(FilePath(entry.Id), LocalFiles.ScanLimit, token);
        var current = ReadEntry(bytes, entry.Id, token);
        if (current.Revision != entry.Revision) throw new IOException("备份已被其他窗口修改，请刷新后选择");
        return ScanExchange.Import(bytes, entry.Id + ".datyscan", token) with { SourceLabel = "历史备份", RecordLabel = current.Name };
    }
    public async Task RenameAsync(ScanBackupEntry entry, string name, ScanBackupOptions options, CancellationToken token)
    {
        using var lease = await LockAsync(token);
        var path = FilePath(entry.Id);
        var bytes = await LocalFiles.ReadBoundedAsync(path, LocalFiles.ScanLimit, token);
        if (ReadEntry(bytes, entry.Id, token).Revision != entry.Revision) throw new IOException("备份已变化，请刷新后重试");
        var root = JsonNode.Parse(bytes)!.AsObject(); root["backup"]!["name"] = ValidName(name);
        bytes = Encoding.UTF8.GetBytes(root.ToJsonString()); Capacity(path, bytes.Length, options);
        await LocalFiles.WriteAtomicBytesAsync(path, bytes, token);
    }
    public async Task DeleteAsync(ScanBackupEntry entry, CancellationToken token)
    {
        using var lease = await LockAsync(token);
        var path = FilePath(entry.Id);
        if (entry.Error is null)
        {
            var bytes = await LocalFiles.ReadBoundedAsync(path, LocalFiles.ScanLimit, token);
            if (R19Transfers.Digest(bytes) != entry.Revision) throw new IOException("备份已变化，请刷新后重试");
        }
        else if (Stamp(new FileInfo(path)) != entry.Revision) throw new IOException("备份已变化，请刷新后重试");
        File.Delete(path);
    }
    private static string Stamp(FileInfo file) => file.Length + ":" + file.LastWriteTimeUtc.Ticks;
}
