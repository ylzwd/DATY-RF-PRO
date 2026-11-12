using System.Text;
using System.Text.Json;
using Daty.Native.Core;

static class ScanBackupCases
{
    static void Check(bool value, string message = "Scan backup assertion failed") { if (!value) throw new Exception(message); }
    static async Task Reject(Func<Task> action) { try { await action(); } catch { return; } throw new Exception("Expected rejection"); }
    static ScanDocument Live(string state = "partial")
    {
        var complete = state == "completed";
        var raw = JsonSerializer.SerializeToElement(new
        {
            schema = "daty-live-scan-v1", operation_id = Guid.NewGuid().ToString("N"), target = new { device_id = "fixture" }, state,
            actual_range = new { start_khz = 640000, end_khz = 640100, step_khz = 25 },
            points = new object?[][] { [640000, -95.1], [640025, -40.2], [640050, complete ? -88.0 : null], [640075, -99.3], [640100, complete ? -89.0 : null] },
            received_points = complete ? 5 : 3, missing_points = complete ? 0 : 2,
            coverage_complete = complete, device_ended = state is "partial" or "completed", complete
        });
        return ScanExchange.FromLive(raw, raw.Text("operation_id")!, "fixture", default);
    }
    static async Task Folder(Func<string, ScanBackupStore, Task> action)
    {
        var folder = Path.Combine(Path.GetTempPath(), "daty-scan-backup-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try { await action(folder, new(folder)); }
        finally { Directory.Delete(folder, true); }
    }
    public static IEnumerable<(string Name, Func<Task> Run)> All()
    {
        yield return ("Backup survives store restart with exact samples, gaps and original outcome", () => Folder(async (folder, store) =>
        {
            foreach (var state in new[] { "completed", "partial", "cancelled", "interrupted", "scanning", "unknown" })
            {
                var scan = Live(state); var id = Guid.NewGuid().ToString("N");
                var saved = await store.SaveAsync(scan, id, state, new(), default);
                var reopened = new ScanBackupStore(folder);
                var entry = (await reopened.ListAsync(default)).Single(e => e.Id == id);
                var restored = await reopened.LoadAsync(entry, default);
                Check(restored.Points.SequenceEqual(scan.Points) && restored.MissingPoints == scan.MissingPoints);
                Check(restored.TraceSegments!.Count == scan.TraceSegments!.Count && restored.GridEndKHz == 640100);
                Check(restored.SourceLabel == "历史备份" && restored.Raw.Field("provenance").Text("state") == state);
                Check(saved.Revision == entry.Revision && entry.Error is null);
            }
        }));
        yield return ("Repeated backup and export preserve original provenance without nesting growth", () => Folder(async (_, store) =>
        {
            var document = Live("cancelled"); var id = Guid.NewGuid().ToString("N");
            for (var i = 0; i < 20; i++)
            {
                var entry = await store.SaveAsync(document, id, "重复保存", new(), default);
                document = await store.LoadAsync(entry, default);
                Check(document.Raw.Field("provenance").Text("schema") == "daty-live-scan-v1");
                Check(entry.Bytes < 3000 && entry.State == "已停止");
            }
            Check((await store.ListAsync(default)).Count == 1);
        }));
        yield return ("Quota rejection and cancelled checkpoint leave previous file byte-identical", () => Folder(async (folder, store) =>
        {
            var id = Guid.NewGuid().ToString("N"); var entry = await store.SaveAsync(Live(), id, "旧记录", new(), default);
            var path = Path.Combine(folder, id + ".datyscan"); var before = await File.ReadAllBytesAsync(path);
            await using (var filler = File.Create(Path.Combine(folder, ".capacity-fixture"))) filler.SetLength(64L * 1024 * 1024);
            await Reject(() => store.SaveAsync(Live("completed"), id, "新记录", new(MaxMiB: 64), default));
            var afterQuota=await File.ReadAllBytesAsync(path);Check(before.SequenceEqual(afterQuota));
            await Reject(() => store.SaveAsync(Live(), id, "取消", new(), new CancellationToken(true)));
            var afterCancel=await File.ReadAllBytesAsync(path);Check(before.SequenceEqual(afterCancel));
        }));
        yield return ("Rename preserves timestamp and CAS rejects stale restore, rename and delete", () => Folder(async (_, store) =>
        {
            var entry = await store.SaveAsync(Live(), Guid.NewGuid().ToString("N"), "原名", new(), default);
            await store.RenameAsync(entry, "正式演出前", new(), default);
            var updated = (await store.ListAsync(default)).Single();
            Check(updated.Name == "正式演出前" && updated.SavedAt == entry.SavedAt && updated.Revision != entry.Revision);
            await Reject(() => store.LoadAsync(entry, default));
            await Reject(() => store.RenameAsync(entry, "旧窗口", new(), default));
            await Reject(() => store.DeleteAsync(entry, default));
            await store.SaveAsync(Live("completed"),entry.Id,"自动检查点默认名",new(),default);
            updated=(await store.ListAsync(default)).Single();Check(updated.Name=="正式演出前","Auto checkpoint must keep the user's name");
            await store.DeleteAsync(updated, default); Check((await store.ListAsync(default)).Count == 0);
        }));
        yield return ("Corrupt and oversized backups remain listed and can be explicitly deleted", () => Folder(async (folder, store) =>
        {
            foreach (var oversized in new[] { false, true })
            {
                var id = Guid.NewGuid().ToString("N"); var path = Path.Combine(folder, id + ".datyscan");
                if (oversized) { using var f = File.Create(path); f.SetLength(LocalFiles.ScanLimit + 1); }
                else await File.WriteAllTextAsync(path, "{broken");
                var entry = (await store.ListAsync(default)).Single(); Check(entry.Error is not null);
                await Reject(() => store.LoadAsync(entry, default)); await store.DeleteAsync(entry, default);
            }
            Check((await store.ListAsync(default)).Count == 0);
        }));
        yield return ("Backup rejects path traversal, invalid name and unexpected settings", () => Folder(async (_, store) =>
        {
            await Reject(() => store.SaveAsync(Live(), "../escape", "无效", new(), default));
            await Reject(() => store.SaveAsync(Live(), Guid.NewGuid().ToString("N"), "\n", new(), default));
            await Reject(() => store.SaveAsync(Live(), Guid.NewGuid().ToString("N"), "无效", new(MaxMiB: 1), default));
            foreach (var text in new[] { "{}", "{\"schema\":\"daty-scan-backup-settings-v1\",\"enabled\":1,\"maxMiB\":128}", "{\"schema\":\"daty-scan-backup-settings-v1\",\"enabled\":true,\"maxMiB\":128,\"path\":\"x\"}" })
                await Reject(() => { ScanBackupOptions.Parse(JsonSerializer.Deserialize<JsonElement>(text)); return Task.CompletedTask; });
        }));
        yield return ("Concurrent windows serialize distinct writes without losing backups", () => Folder(async (folder, store) =>
        {
            var other = new ScanBackupStore(folder);
            await Task.WhenAll(Enumerable.Range(0, 12).Select(n => (n % 2 == 0 ? store : other).SaveAsync(Live(), Guid.NewGuid().ToString("N"), "记录" + n, new(), default)));
            Check((await store.ListAsync(default)).Count == 12);
        }));
        yield return ("Record limit rejects new writes while keeping existing checkpoints editable", () => Folder(async (folder, store) =>
        {
            var id = Guid.NewGuid().ToString("N"); await store.SaveAsync(Live(), id, "有效", new(), default);
            for (var i = 1; i < ScanBackupStore.MaxRecords; i++) await File.WriteAllTextAsync(Path.Combine(folder, Guid.NewGuid().ToString("N") + ".datyscan"), "{}");
            await Reject(() => store.SaveAsync(Live(), Guid.NewGuid().ToString("N"), "超限", new(), default));
            await store.SaveAsync(Live("completed"), id, "检查点", new(), default);
            Check((await store.ListAsync(default)).Count == ScanBackupStore.MaxRecords);
        }));
    }
}
