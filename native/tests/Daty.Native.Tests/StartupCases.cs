using System.Text.Json;
using System.Text.Json.Nodes;
using Daty.Native.Core;

internal static class StartupCases
{
    public static IEnumerable<(string Name, Action Run)> All()
    {
        var now=DateTimeOffset.UtcNow;
        JsonObject Baseline()=>JsonSerializer.SerializeToNode(new{schema="daty-mqtt6-runtime-status-v1",state="running",database_epoch="epoch",pid=123,at_utc=now.ToString("O"),
            transport=new{ready=true},persistence=new{accepting=true,writable=true,failed=6,refused=20,writer=new{running=true}}})!.AsObject();
        bool Ready(JsonObject value,Func<int,bool>? owns=null)=>LocalServerReadiness.IsReady(JsonSerializer.SerializeToElement(value),"epoch",now,owns??(pid=>pid==123));
        void Check(bool condition){if(!condition)throw new Exception("Local server readiness was incorrect");}
        yield return ("Recovered writer is usable without erasing historical gaps",()=>Check(Ready(Baseline())));
        yield return ("Open process and ports cannot hide blocked persistence",()=>{var s=Baseline();s["persistence"]!["writable"]=false;Check(!Ready(s));});
        yield return ("Desktop rejects stale pre-sleep runtime status",()=>{var s=Baseline();s["at_utc"]=now.AddMinutes(-1).ToString("O");Check(!Ready(s));});
        yield return ("Desktop rejects foreign epoch and unrelated process",()=>{var s=Baseline();Check(!Ready(s,_=>false));s["database_epoch"]="foreign";Check(!Ready(s));});
        yield return ("Desktop rejects recovering transport and missing writer",()=>{var s=Baseline();s["transport"]!["ready"]=false;Check(!Ready(s));s=Baseline();s["persistence"]!["writer"]!["running"]=false;Check(!Ready(s));});
        yield return ("Desktop rejects incomplete status and future timestamps",()=>{Check(!Ready(new()));var s=Baseline();s["at_utc"]=now.AddMinutes(1).ToString("O");Check(!Ready(s));});
        yield return ("503 connection status explains automatic recovery",()=>Check(!LocalServerReadiness.ConnectionMessage("The server returned status code '503' when '101' was expected").Contains("101")));
    }
}
