using System.Diagnostics;
using System.Text.Json;
using Daty.Native.Core;
using Daty.Native.Contracts;

static class ReducerPerformance
{
    internal const string Stream = "view-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    internal static JsonElement Event(long seq, string kind, object? payload) => JsonSerializer.SerializeToElement(new
    { schema="daty-device-mqtt6-v1",server_id="daty-rf-pro",stream_id=Stream,boot_id=new string('b',32),seq,kind,payload });
    internal static object Device(int i) => new { id="rx-"+i,receiver_id="rx-"+i,channel_number=1,
        brand="Shure",model="ULXD4",freq=640000+i*25,rf=-50,af_dbfs=-20,batt=(int?)null,
        _online=true,status="online",group_source="server-fifo-v1",group_number=i+1,
        shure=new { transmitter_type="ULXD2",battery_bars=4,stale_fields=Array.Empty<string>(),
            field_times=new{transmitter_type=1_780_000_000,battery_bars=1_780_000_000},
            receiver_firmware="2.10.0.0",receiver_mac="00:0E:DD:11:22:33"} };
    internal static void Run(string output)
    {
        var results=new List<object>();
        foreach(var count in new[]{1,50,128})
        {
            var first=Event(1,"device_list",new{devices=Enumerable.Range(0,count).Select(Device).ToArray()});
            foreach(var type in new[]{"heartbeat","single_update"})
            {
                int iterations=type=="heartbeat"?1000:300;
                var inputs=Enumerable.Range(0,iterations).Select(i=>Event(i+2,type=="heartbeat"?"heartbeat":"device_update",
                    type=="heartbeat"?null:new{devices=new[]{new{id="rx-0",rf=-50-i%10,af_dbfs=-20-i%8}}})).ToArray();
                var samples=new List<object>();
                for(int run=0;run<4;run++)
                {
                    var reducer=new R19DeviceReducer(Stream);reducer.Apply(first);
                    GC.Collect();GC.WaitForPendingFinalizers();GC.Collect();
                    var start=GC.GetAllocatedBytesForCurrentThread();var watch=Stopwatch.StartNew();
                    foreach(var e in inputs)reducer.Apply(e);
                    watch.Stop();long allocated=GC.GetAllocatedBytesForCurrentThread()-start;
                    if(run>0)samples.Add(new{milliseconds=watch.Elapsed.TotalMilliseconds,allocatedBytes=allocated});
                }
                results.Add(new{channels=count,type,iterations,samples});
            }
        }
        var contractStart=GC.GetAllocatedBytesForCurrentThread();var contractWatch=Stopwatch.StartNew();
        for(int i=0;i<1000;i++)if(!R19Contract.ReadReference().GetProperty("methods").EnumerateArray().Any(x=>x.GetString()=="devices.snapshot"))throw new Exception("Missing method");
        contractWatch.Stop();
        File.WriteAllText(output,JsonSerializer.Serialize(new{environment="local deterministic reducer only; no network or receiver writes",results,
            contract=new{iterations=1000,milliseconds=contractWatch.Elapsed.TotalMilliseconds,allocatedBytes=GC.GetAllocatedBytesForCurrentThread()-contractStart}},new JsonSerializerOptions{WriteIndented=true}));
    }
}
