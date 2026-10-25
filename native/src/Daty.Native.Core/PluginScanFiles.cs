using System.Text.Json;

namespace Daty.Native.Core;

/// <summary>WWB bytes are interpreted only by the installed brand plugin.</summary>
public static class PluginScanFiles
{
    public const int MaxBytes = 128 * 1024;

    public static async Task<IReadOnlyList<ScanDocument>> ReadAsync(
        Func<string, object, CancellationToken, Task<JsonElement>> call,
        byte[] bytes, string fileName, CancellationToken token)
    {
        if (bytes.Length is < 1 or > MaxBytes) throw new InvalidDataException("WWB 扫描文件须小于 128 KiB");
        token.ThrowIfCancellationRequested();
        var reply = await call("plugins.scan_file", new { plugin_id = "shure-scp", file_base64 = Convert.ToBase64String(bytes), file_sha256 = R19Transfers.Digest(bytes) }, token);
        reply = await new R19Transfers(call).JsonAsync(reply, token);
        return await Task.Run(() => Parse(reply, bytes, fileName, token), token);
    }

    public static IReadOnlyList<ScanDocument> Parse(JsonElement reply, byte[] bytes, string fileName, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var digest = R19Transfers.Digest(bytes);
        if (reply.Text("schema") != "daty-shure-scan-file-v1" || reply.Text("file_sha256") != digest ||
            reply.Text("source_kind") != "wwb-file" || reply.Text("file_state") != "validated" ||
            reply.Text("device_scan_state") != "unknown" || reply.Field("receiver_identity").ValueKind != JsonValueKind.Null ||
            reply.Text("frequency_unit") != "kHz" || reply.Text("level_unit") != "dBm" ||
            reply.Field("plugin").Text("id") != "shure-scp")
            throw new InvalidDataException("舒尔扫描文件校验结果与所选文件不一致");
        var records = reply.Field("records");
        if (records.ValueKind != JsonValueKind.Array || records.GetArrayLength() is < 1 or > 32 ||
            !reply.Field("point_count_per_record").TryGetInt32(out var expected) || expected is < 1 or > 30000)
            throw new InvalidDataException("扫描记录或点数无效");
        var schema = reply.Field("header").Field("BinarySchema");
        if(schema.ValueKind!=JsonValueKind.Array||schema.GetArrayLength()<4)throw new InvalidDataException("扫描网格缺失");
        var ranges=schema[3].Field("Curve").Field("FreqRanges");
        if(ranges.ValueKind!=JsonValueKind.Array||ranges.GetArrayLength()!=1||
            !ranges[0].Field("StepFreq").TryGetInt32(out var step)||step<=0||
            !ranges[0].Field("StartFreq").TryGetInt32(out var start)||start<=0||
            !ranges[0].Field("EndFreq").TryGetInt32(out var end)||end!=start+(long)(expected-1)*step)
            throw new InvalidDataException("扫描网格无效");
        var documents = new List<ScanDocument>();
        var ids = new HashSet<uint>();
        foreach (var record in records.EnumerateArray())
        {
            token.ThrowIfCancellationRequested();
            if (!record.Field("id_raw").TryGetUInt32(out var id) || !ids.Add(id)) throw new InvalidDataException("扫描记录标识无效");
            var slots = record.Field("points");
            if (slots.ValueKind != JsonValueKind.Array || slots.GetArrayLength() != expected) throw new InvalidDataException("扫描记录点数不完整");
            var points = new List<ScanPoint>(); var segments = new List<IReadOnlyList<ScanPoint>>();
            var segment = new List<ScanPoint>(); int previous = 0, missing = 0, position = 0;
            void Flush() { if (segment.Count > 0) { segments.Add(segment.ToArray()); segment.Clear(); } }
            foreach (var slot in slots.EnumerateArray())
            {
                token.ThrowIfCancellationRequested();
                if (slot.ValueKind != JsonValueKind.Array || slot.GetArrayLength() != 2 ||
                    !slot[0].TryGetInt32(out var frequency) || frequency <= previous || frequency > 10000000 || frequency != start+(long)position*step)
                    throw new InvalidDataException("扫描频率位置无效或未按顺序排列");
                previous = frequency;position++;
                if (slot[1].ValueKind == JsonValueKind.Null) { missing++; Flush(); continue; }
                if (slot[1].Number() is not double level || level is < -200 or > 50) throw new InvalidDataException("扫描电平无效");
                var point = new ScanPoint(frequency, level); points.Add(point); segment.Add(point);
            }
            Flush();
            if (record.Number("valid_points") != points.Count || record.Number("missing_points") != missing)
                throw new InvalidDataException("扫描有效点与缺失点数量不匹配");
            documents.Add(new(Path.GetFileName(fileName), digest, points.ToArray(), 0, reply.Clone())
            {
                SourceLabel = "WWB 文件", RecordLabel = "记录 " + id,
                MissingPoints = missing, SampleStepKHz = step, GridStartKHz = start, GridEndKHz = end, TraceSegments = segments.ToArray()
            });
        }
        return documents;
    }
}
