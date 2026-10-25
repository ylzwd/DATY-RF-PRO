using System.Text.Json;
using System.Text.Json.Nodes;
using Daty.Native.Core;

static class ScanFileCases
{
    static readonly byte[] Original = "isolated WWB bytes; no hardware"u8.ToArray();
    static void Check(bool value) { if(!value) throw new Exception("Scan file assertion failed"); }
    static async Task Reject(Func<Task> work) { try { await work(); } catch { return; } throw new Exception("Expected scan rejection"); }
    static JsonElement Reply(int count=6) => JsonSerializer.SerializeToElement(new {
        schema="daty-shure-scan-file-v1",file_sha256=R19Transfers.Digest(Original), source_kind="wwb-file",file_state="validated",device_scan_state="unknown",receiver_identity=(object?)null,
        frequency_unit="kHz",level_unit="dBm",plugin=new{id="shure-scp",version="fixture",sha256=new string('a',64)},point_count_per_record=count,
        header=new{BinarySchema=new object[]{new{},new{},new{},new{Curve=new{FreqRanges=new[]{new{StartFreq=632125,EndFreq=632125+(count-1)*25,StepFreq=25}}}}}},
        records=new[]{1,0}.Select(id=>new{id_raw=id,valid_points=count-count/3,missing_points=count/3,
            points=Enumerable.Range(0,count).Select(i=>new object?[]{632125+i*25,i%3==2?null:-95d+i%4+id}).ToArray()}).ToArray() });

    public static IEnumerable<(string Name,Func<Task> Run)> All()
    {
        yield return ("WWB selected records preserve missing runs and valid-only planning points",()=>{
            var records=PluginScanFiles.Parse(Reply(),Original,"fixture.sdb3",default);
            Check(records.Count==2&&records[0].RecordLabel=="记录 1"&&records[1].RecordLabel=="记录 0");
            Check(records[0].SourceLabel=="WWB 文件"&&records[0].SlotCount==6&&records[0].MissingPoints==2);
            Check(records[0].SampleStepKHz==25&&records[0].GridStartKHz==632125&&records[0].GridEndKHz==632250);
            Check(records[0].Points.Count==4&&records[0].TraceSegments!.Count==2&&records[0].TraceSegments!.All(s=>s.Count==2));
            Check(records[0].Points.All(p=>p.FrequencyKHz!=632175&&p.FrequencyKHz!=632250)&&records[0].Points[0].LevelDbm!=records[1].Points[0].LevelDbm);
            Check(records[0].Raw.Text("device_scan_state")=="unknown"&&records[0].Raw.Field("receiver_identity").ValueKind==JsonValueKind.Null);
            return Task.CompletedTask;
        });
        yield return ("WWB grid gap rejects a protection window crossing a single missing point",async()=>{
            using var golden=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"web-plan-golden.json")));
            var devices=golden.RootElement.Field("devices");var values=golden.RootElement.Field("options").Deserialize<Dictionary<string,JsonElement>>()!;
            var desired=new Dictionary<string,int>{{"test_ch1",641000},{"fixture_ch2",645000}};
            var points=Enumerable.Range(0,241).Select(i=>new{frequencyKHz=640000+i*25,levelDbm=-100}).ToArray();
            values["scanPoints"]=JsonSerializer.SerializeToElement(points);values["maxScanGapKHz"]=JsonSerializer.SerializeToElement(25);
            JsonElement Validate()=>CoordinationEngine.ValidateManualPlan(devices,JsonSerializer.SerializeToElement(values),JsonSerializer.SerializeToElement(Array.Empty<object>()),desired,default);
            Check(Validate().Field("search").Field("complete").True());
            values["scanPoints"]=JsonSerializer.SerializeToElement(points.Where(p=>p.frequencyKHz!=641025));
            await Reject(()=>{Validate();return Task.CompletedTask;});
            values["maxScanGapKHz"]=JsonSerializer.SerializeToElement(200);
            Check(Validate().Field("search").Field("complete").True());
        });
        yield return ("WWB rejects wrong file, invalid units, claimed completion and missing accounting",async()=>{
            foreach(var (key,value) in new[]{("file_sha256",(object)new string('f',64)),("frequency_unit","MHz"),("device_scan_state","complete"),("point_count_per_record",7)})
            {
                var changed=JsonNode.Parse(Reply().GetRawText())!.AsObject();changed[key]=JsonSerializer.SerializeToNode(value);
                await Reject(()=>{PluginScanFiles.Parse(JsonSerializer.SerializeToElement(changed),Original,"fixture.sdb3",default);return Task.CompletedTask;});
            }
            var malformed=JsonNode.Parse(Reply().GetRawText())!;malformed["records"]![0]!["points"]![1]![0]=632125;
            await Reject(()=>{PluginScanFiles.Parse(JsonSerializer.SerializeToElement(malformed),Original,"fixture.sdb3",default);return Task.CompletedTask;});
            await Reject(()=>{PluginScanFiles.Parse(Reply(),Original,"fixture.sdb3",new CancellationToken(true));return Task.CompletedTask;});
        });
        yield return ("WWB reader uses installed plugin only and propagates absent-plugin failure",async()=>{
            var calls=new List<string>();
            var result=await PluginScanFiles.ReadAsync((method,body,token)=>{
                calls.Add(method);var request=JsonSerializer.SerializeToElement(body);Check(method=="plugins.scan_file"&&request.Text("plugin_id")=="shure-scp"&&request.Text("file_sha256")==R19Transfers.Digest(Original));
                Check(Convert.FromBase64String(request.Text("file_base64")!).SequenceEqual(Original));return Task.FromResult(Reply());
            },Original,"fixture.sdb3",default);
            Check(calls.SequenceEqual(["plugins.scan_file"])&&result.Count==2);
            await Reject(()=>PluginScanFiles.ReadAsync((m,b,t)=>throw new R19RpcException("BRAND_PLUGIN_NOT_INSTALLED"),Original,"fixture.sdb3",default));
        });
        yield return ("WWB large result verifies every download chunk and closes temporary transfer",async()=>{
            var raw=JsonSerializer.SerializeToUtf8Bytes(Reply(15000));var digest=R19Transfers.Digest(raw);bool closed=false;int chunks=0;
            var result=await PluginScanFiles.ReadAsync((method,body,token)=>{
                var request=JsonSerializer.SerializeToElement(body);
                if(method=="plugins.scan_file")return Task.FromResult(JsonSerializer.SerializeToElement(new{status="download_required",encoding="json-utf8",transfer=new{id="fixture",sha256=digest,bytes=raw.Length,state="ready"}}));
                if(method=="downloads.close"){closed=true;return Task.FromResult(JsonSerializer.SerializeToElement(new{success=true}));}
                Check(method=="downloads.chunk");chunks++;int offset=(int)request.Number("offset")!;var block=raw.Skip(offset).Take(R19Transfers.ChunkBytes).ToArray();
                return Task.FromResult(JsonSerializer.SerializeToElement(new{download_id="fixture",offset,file_sha256=digest,bytes=block.Length,data=Convert.ToBase64String(block),sha256=R19Transfers.Digest(block),eof=offset+block.Length==raw.Length}));
            },Original,"fixture.sdb3",default);
            Check(chunks>1&&closed&&result.Count==2&&result.All(r=>r.Points.Count==10000&&r.MissingPoints==5000));
        });
    }
}
