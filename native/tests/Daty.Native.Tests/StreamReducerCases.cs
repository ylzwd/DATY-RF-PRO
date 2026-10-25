using System.Text.Json;
using Daty.Native.Core;
using Daty.Native.Contracts;

static class StreamReducerCases
{
    static JsonElement E(long seq,string kind,object? payload)=>ReducerPerformance.Event(seq,kind,payload);
    static object Update(params object[] devices)=>new{kind="device_update",payload=new{devices}};
    static JsonElement Batch(long seq,params object[] events)=>E(seq,"event_batch",new{events});
    static (R19DeviceReducer Reducer,DeviceSnapshot Initial) Start()
    {
        var reducer=new R19DeviceReducer(ReducerPerformance.Stream);
        return (reducer,reducer.Apply(E(1,"device_list",new{devices=Enumerable.Range(0,50).Select(ReducerPerformance.Device).ToArray()})).Snapshot!);
    }
    static void Check(bool condition){if(!condition)throw new Exception("Stream reducer assertion");}
    static void Reject(Action action){try{action();}catch(InvalidDataException){return;}throw new Exception("Invalid batch accepted");}
    public static IEnumerable<(string Name,Action Run)> All()
    {
        yield return ("Heartbeat advances only sequence, duplicates do not refresh liveness",()=>{
            var(r,_)=Start();var e=E(2,"heartbeat",null);var result=r.Apply(e);
            Check(result.Accepted&&result.Snapshot is null&&r.Sequence==2&&!r.Apply(e).Accepted);
            Reject(()=>r.Apply(E(3,"heartbeat",new{})));Check(r.Sequence==2);
        });
        yield return ("Repeated channel deltas merge atomically and old snapshots remain immutable",()=>{
            var(r,old)=Start();var original=old.Raw.GetRawText();
            var next=r.Apply(Batch(2,Update(new{id="rx-0",rf=-72}),Update(new{id="rx-0",af_dbfs=-3}))).Snapshot!;
            Check(next.Channels[0].RfDbm==-72&&next.Channels[0].AfDbfs==-3&&next.Channels[0].FrequencyKHz==640000);
            Check(next.Channels[49].Raw.GetRawText()==old.Channels[49].Raw.GetRawText());
            Check(old.Raw.GetRawText()==original&&old.Channels[0].RfDbm==-50);
        });
        yield return ("Invalid event after valid delta rolls back data, boot and sequence",()=>{
            var(r,_)=Start();Reject(()=>r.Apply(Batch(2,Update(new{id="rx-0",rf=-100}),new{kind="invalid",payload=(object?)null})));
            Check(r.Sequence==1);var next=r.Apply(E(2,"device_update",new{devices=new[]{new{id="rx-0",af_dbfs=-7}}})).Snapshot!;
            Check(next.Channels[0].RfDbm==-50&&next.Channels[0].AfDbfs==-7);
        });
        yield return ("Full list replaces inventory inside batch without reviving removed devices",()=>{
            var(r,old)=Start();var next=r.Apply(Batch(2,Update(new{id="rx-0",rf=-80}),
                new{kind="device_list",payload=new{devices=new[]{new{id="new",freq=650000}}}},Update(new{id="new",rf=-40}))).Snapshot!;
            Check(next.Channels.Count==1&&next.Channels[0].Id=="new"&&next.Channels[0].RfDbm==-40&&old.Channels.Count==50);
        });
        yield return ("Duplicate and invalid IDs cannot partially commit a channel update",()=>{
            foreach(var bad in new[]{"rx-0"," "}){
                var(r,_)=Start();Reject(()=>r.Apply(E(2,"device_update",new{devices=new[]{new{id="rx-0",rf=-100},new{id=bad,rf=-90}}})));
                Check(r.Sequence==1);var next=r.Apply(E(2,"device_update",new{devices=Array.Empty<object>()})).Snapshot!;
                Check(next.Channels[0].RfDbm==-50&&next.Channels.Count==50);
            }
        });
        yield return ("Explicit null and nested telemetry replacement stay authoritative",()=>{
            var(r,old)=Start();var next=r.Apply(E(2,"device_update",new{devices=new[]{new{id="rx-0",rf=(int?)null,shure=new{stale_fields=new[]{"transmitter_type"}}}}})).Snapshot!;
            Check(next.Channels[0].RfDbm is null&&next.Channels[0].Raw.Field("shure").Field("transmitter_type").ValueKind==JsonValueKind.Undefined);
            Check(old.Channels[0].Raw.Field("shure").Text("transmitter_type")=="ULXD2");
        });
        yield return ("Sequence gaps and foreign stream or boot never change inventory",()=>{
            var(r,_)=Start();Reject(()=>r.Apply(E(3,"heartbeat",null)));
            foreach(var field in new[]{"stream_id","boot_id"}){
                var changed=E(2,"heartbeat",null).Deserialize<Dictionary<string,JsonElement>>()!;
                changed[field]=JsonSerializer.SerializeToElement(field=="stream_id"?"view-"+new string('c',32):new string('c',32));
                Reject(()=>r.Apply(JsonSerializer.SerializeToElement(changed)));
            }
            Check(r.Sequence==1&&r.Apply(E(2,"heartbeat",null)).Accepted);
        });
        yield return ("Immutable embedded method cache preserves exact contract across concurrent reads",()=>{
            var expected=R19Contract.ReadReference().GetProperty("methods").EnumerateArray().Select(x=>x.GetString()!).ToArray();
            Parallel.For(0,200,_=>{foreach(var method in expected)Check(R19Contract.SupportsMethod(method));
                Check(!R19Contract.SupportsMethod("DEVICES.SNAPSHOT")&&!R19Contract.SupportsMethod("unreviewed.method"));});
        });
    }
}
