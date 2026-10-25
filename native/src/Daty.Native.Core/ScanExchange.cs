using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Daty.Native.Core;

/// <summary>Lossless scan interchange. Missing samples remain missing, including at the grid edges.</summary>
public static class ScanExchange
{
    public static string Export(ScanDocument scan) => JsonSerializer.Serialize(new {
        schema="daty-scan-v1", frequency_unit="kHz", level_unit="dBm",
        source=scan.SourceLabel, record=scan.RecordLabel, original_file=scan.FileName,
        exported_at=DateTimeOffset.UtcNow, sample_step_khz=scan.SampleStepKHz,
        grid_start_khz=scan.GridStartKHz, grid_end_khz=scan.GridEndKHz,
        missing_points=scan.MissingPoints,
        points=scan.Points.Select(p=>new double[]{p.FrequencyKHz,p.LevelDbm}),
        segments=scan.TraceSegments?.Select(s=>s.Select(p=>p.FrequencyKHz)),
        provenance=scan.Raw.ValueKind==JsonValueKind.Undefined? (object?)null:scan.Raw
    },new JsonSerializerOptions{WriteIndented=true});

    public static string Csv(ScanDocument scan)
    {
        var text=new StringBuilder("frequency_mhz,level_dbm\r\n");
        foreach(var p in scan.Points)text.Append((p.FrequencyKHz/1000d).ToString("0.000",CultureInfo.InvariantCulture))
            .Append(',').Append(p.LevelDbm.ToString("R",CultureInfo.InvariantCulture)).Append("\r\n");
        return text.ToString();
    }

    public static ScanDocument Import(byte[] bytes,string fileName,CancellationToken token)
    {
        if(bytes.Length>LocalFiles.ScanLimit)throw new InvalidDataException("扫描文件超过大小限制");
        using var json=JsonDocument.Parse(bytes);var root=json.RootElement;
        if(root.Text("schema")!="daty-scan-v1"||root.Text("frequency_unit")!="kHz"||root.Text("level_unit")!="dBm")
            throw new InvalidDataException("不支持的 DATY 扫描格式或单位");
        var points=ReadPoints(root.Field("points"),false,token).Points;
        var start=OptionalInt(root,"grid_start_khz");var end=OptionalInt(root,"grid_end_khz");var step=OptionalInt(root,"sample_step_khz");
        var missing=OptionalInt(root,"missing_points")??0;
        ValidateGrid(points,start,end,step,missing);
        IReadOnlyList<IReadOnlyList<ScanPoint>>? segments=null;
        if(root.Field("segments").ValueKind==JsonValueKind.Array)
        {
            var map=points.ToDictionary(p=>p.FrequencyKHz);var seen=new List<int>();var runs=new List<IReadOnlyList<ScanPoint>>();
            foreach(var run in root.Field("segments").EnumerateArray())
            {
                token.ThrowIfCancellationRequested();var segment=new List<ScanPoint>();
                foreach(var value in run.EnumerateArray()) {var f=value.GetInt32();if(!map.TryGetValue(f,out var p))throw new InvalidDataException("分段包含未知频点");segment.Add(p);seen.Add(f);}
                if(segment.Count==0)throw new InvalidDataException("空扫描分段");
                if(step is int gap&&segment.Zip(segment.Skip(1),(a,b)=>b.FrequencyKHz-a.FrequencyKHz).Any(delta=>delta!=gap))throw new InvalidDataException("扫描分段跨越缺失位置");
                runs.Add(segment);
            }
            if(!seen.SequenceEqual(points.Select(p=>p.FrequencyKHz)))throw new InvalidDataException("扫描分段与采样点不一致");
            segments=runs;
        }
        else if(step is int spacing)segments=Split(points,spacing);
        return new(Path.GetFileName(fileName),R19Transfers.Digest(bytes),points,0,root.Clone()) {
            SourceLabel="DATY 文件",RecordLabel=root.Text("record"),MissingPoints=missing,
            GridStartKHz=start,GridEndKHz=end,SampleStepKHz=step,TraceSegments=segments
        };
    }

    public static ScanDocument FromLive(JsonElement reply,string operationId,string deviceId,CancellationToken token)
    {
        if(reply.Text("schema")!="daty-live-scan-v1"||reply.Text("operation_id")!=operationId||reply.Field("target").Text("device_id")!=deviceId)
            throw new InvalidDataException("扫描回执身份不匹配");
        var grid=reply.Field("actual_range");var start=OptionalInt(grid,"start_khz");var end=OptionalInt(grid,"end_khz");var step=OptionalInt(grid,"step_khz");
        var data=ReadPoints(reply.Field("points"),true,token);
        if(start is int gridStart&&end is int gridEnd&&step is int gridStep&&gridStep>0) {
            var raw=reply.Field("points");
            if(raw.GetArrayLength()!=(gridEnd-gridStart)/gridStep+1)throw new InvalidDataException("扫描槽数与网格不一致");
            var index=0;foreach(var point in raw.EnumerateArray())if(point[0].GetInt32()!=gridStart+index++*gridStep)throw new InvalidDataException("扫描缺失位置与网格不一致");
        }
        var missing=OptionalInt(reply,"missing_points")??data.Missing;
        ValidateGrid(data.Points,start,end,step,missing);
        if(reply.Number("received_points")!=data.Points.Count||missing!=data.Missing)
            throw new InvalidDataException("扫描点统计与数据不一致");
        var complete=reply.Field("complete").True();
        if(complete&&(!reply.Field("device_ended").True()||!reply.Field("coverage_complete").True()||missing!=0||reply.Text("state")!="completed"))
            throw new InvalidDataException("扫描完成状态与覆盖率不一致");
        if(reply.Text("state")=="completed"&&!complete)throw new InvalidDataException("扫描完成未经确认");
        return new("scan-"+operationId+".datyscan","",data.Points,0,reply.Clone()) {
            SourceLabel="接收机扫描",RecordLabel=StateLabel(reply.Text("state")),MissingPoints=missing,
            GridStartKHz=start,GridEndKHz=end,SampleStepKHz=step,TraceSegments=step is int spacing?Split(data.Points,spacing):null
        };
    }

    public static string StateLabel(string? state)=>state switch {
        "starting"=>"正在连接", "scanning"=>"扫描中", "completed"=>"扫描完成", "partial"=>"扫描结束 · 数据不完整",
        "cancelled"=>"已停止", "cancel_requested"=>"正在停止", "not_started"=>"扫描未开始", "interrupted"=>"扫描中断", "failed"=>"扫描失败", _=>"状态待确认"
    };
    public static bool Terminal(string? state)=>state is "completed" or "partial" or "cancelled" or "interrupted" or "failed" or "not_started" or "unknown";

    private static int? OptionalInt(JsonElement root,string field)
    {
        var value=root.Field(field);if(value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)return null;
        return value.TryGetInt32(out var number)?number:throw new InvalidDataException("扫描网格不是整数");
    }
    private static (IReadOnlyList<ScanPoint> Points,int Missing) ReadPoints(JsonElement raw,bool nullable,CancellationToken token)
    {
        if(raw.ValueKind!=JsonValueKind.Array||raw.GetArrayLength()>30000)throw new InvalidDataException("扫描点数量超限");
        var points=new List<ScanPoint>();int previous=0,missing=0;
        foreach(var pair in raw.EnumerateArray()) {
            token.ThrowIfCancellationRequested();
            if(pair.ValueKind!=JsonValueKind.Array||pair.GetArrayLength()!=2||!pair[0].TryGetInt32(out var f)||f<=previous||f<30000||f>3000000)
                throw new InvalidDataException("扫描频点重复、乱序或越界");
            previous=f;
            if(nullable&&pair[1].ValueKind==JsonValueKind.Null){missing++;continue;}
            if(pair[1].Number() is not double level||level < -200||level>50)throw new InvalidDataException("扫描电平无效");
            points.Add(new(f,level));
        }
        return(points,missing);
    }
    private static void ValidateGrid(IReadOnlyList<ScanPoint> points,int? start,int? end,int? step,int missing)
    {
        if(missing<0||missing>30000)throw new InvalidDataException("缺失点数量无效");
        if(start is null&&end is null&&step is null){if(missing>0)throw new InvalidDataException("缺失点缺少网格");return;}
        if(start is not int a||end is not int b||step is not int s||a<30000||b>3000000||b<a||s<=0||(b-a)%s!=0||(b-a)/s+1>30000)
            throw new InvalidDataException("扫描网格无效");
        if(points.Count+missing!=(b-a)/s+1||points.Any(p=>p.FrequencyKHz<a||p.FrequencyKHz>b||(p.FrequencyKHz-a)%s!=0))
            throw new InvalidDataException("扫描覆盖率与网格不一致");
    }
    private static IReadOnlyList<IReadOnlyList<ScanPoint>> Split(IReadOnlyList<ScanPoint> points,int step)
    {
        var runs=new List<IReadOnlyList<ScanPoint>>();List<ScanPoint>? run=null;int previous=0;
        foreach(var p in points){if(run is null||p.FrequencyKHz-previous!=step){run=[];runs.Add(run);}run.Add(p);previous=p.FrequencyKHz;}
        return runs;
    }
}
