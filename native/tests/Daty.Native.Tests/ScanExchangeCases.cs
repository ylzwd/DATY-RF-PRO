using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Daty.Native.Core;

static class ScanExchangeCases
{
    static void Check(bool value){if(!value)throw new Exception("Scan exchange assertion failed");}
    static void Reject(Action action){try{action();}catch{return;}throw new Exception("Invalid scan was accepted");}
    static JsonElement Live(string state="partial")=>JsonSerializer.SerializeToElement(new {
        schema="daty-live-scan-v1",operation_id="scan1",target=new{device_id="ch1"},state,
        actual_range=new{start_khz=632125,end_khz=632225,step_khz=25},
        points=new object?[][]{[632125,-95.1],[632150,-40.2],[632175,null],[632200,-99.3],[632225,null]},
        received_points=3,missing_points=2,coverage_complete=false,device_ended=true,complete=false
    });
    public static IEnumerable<(string Name,Func<Task> Run)> All()
    {
        yield return("Live scan and DATY export roundtrip preserve gaps, edge slot and source outcome",()=>{
            var original=ScanExchange.FromLive(Live(),"scan1","ch1",default);
            Check(original.TraceSegments!.Count==2&&original.MissingPoints==2&&original.SlotCount==5);
            var imported=ScanExchange.Import(Encoding.UTF8.GetBytes(ScanExchange.Export(original)),"scan.datyscan",default);
            Check(imported.Points.SequenceEqual(original.Points)&&imported.MissingPoints==2&&imported.GridEndKHz==632225&&imported.TraceSegments!.Count==2);
            Check(imported.SourceLabel=="DATY 文件"&&imported.Raw.Field("provenance").Text("state")=="partial");
            var csv=LocalFiles.ParseScan(Encoding.UTF8.GetBytes(ScanExchange.Csv(original)),"scan.csv",default);
            Check(csv.Points.SequenceEqual(original.Points));return Task.CompletedTask;
        });
        yield return("Live scan rejects identity mismatch, false complete and displaced missing slot",()=>{
            Reject(()=>ScanExchange.FromLive(Live(),"other","ch1",default));
            Reject(()=>ScanExchange.FromLive(Live(),"scan1","other",default));
            Reject(()=>ScanExchange.FromLive(Live("completed"),"scan1","ch1",default));
            var invalid=JsonNode.Parse(Live().GetRawText())!;invalid["points"]![2]![0]=632176;
            Reject(()=>ScanExchange.FromLive(JsonSerializer.SerializeToElement(invalid),"scan1","ch1",default));
            invalid=JsonNode.Parse(Live().GetRawText())!;invalid["received_points"]=4;
            Reject(()=>ScanExchange.FromLive(JsonSerializer.SerializeToElement(invalid),"scan1","ch1",default));
            return Task.CompletedTask;
        });
        yield return("DATY import rejects malformed grid, reordered segments and cancellation",()=>{
            var text=ScanExchange.Export(ScanExchange.FromLive(Live(),"scan1","ch1",default));
            foreach(var field in new[]{"missing_points","sample_step_khz"}) {
                var invalid=JsonNode.Parse(text)!;invalid[field]=1;
                Reject(()=>ScanExchange.Import(JsonSerializer.SerializeToUtf8Bytes(invalid),"scan.datyscan",default));
            }
            var reordered=JsonNode.Parse(text)!;reordered["segments"]![0]![0]=632200;
            Reject(()=>ScanExchange.Import(JsonSerializer.SerializeToUtf8Bytes(reordered),"scan.datyscan",default));
            var bridged=JsonNode.Parse(text)!;bridged["segments"]=JsonSerializer.SerializeToNode(new[]{new[]{632125,632150,632200}});
            Reject(()=>ScanExchange.Import(JsonSerializer.SerializeToUtf8Bytes(bridged),"scan.datyscan",default));
            Check(ScanExchange.Terminal("not_started"));
            Reject(()=>ScanExchange.Import(Encoding.UTF8.GetBytes(text),"scan.datyscan",new CancellationToken(true)));
            return Task.CompletedTask;
        });
    }
}
