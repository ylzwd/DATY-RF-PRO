using System.Text.Json;
using Daty.Native.Contracts;
var checks=0;
void Check(bool condition) { if(!condition) throw new Exception("Contract assertion failed"); checks++; }
var endpoint=R19Endpoints.FromWebOrigin("https://192.0.2.16:8080");
Check(endpoint.Application.AbsoluteUri=="wss://192.0.2.16:8083/mqtt-app");
Check(endpoint.Live.AbsoluteUri=="wss://192.0.2.16:8083/mqtt-readonly");
foreach(var bad in new[]{"http://192.0.2.16:8080","https://user:pass@localhost:8080","https://localhost:8080/path","https://localhost:8080/?key=x","https://localhost:8080/#x"}) {
    var rejected=false;try{R19Endpoints.FromWebOrigin(bad);}catch(ArgumentException){rejected=true;}Check(rejected);
}
var reference=R19Contract.ReadReference();
Check(reference.GetProperty("schema").GetString()=="daty-mqtt6-app-v1");
Check(reference.GetProperty("methods").EnumerateArray().Any(x=>x.GetString()=="devices.snapshot"));
Check(reference.GetProperty("topics").GetProperty("request").GetString()=="daty/v2/daty-rf-pro/app/request");
var request=new R19Request("daty-mqtt6-app-v1","daty-rf-pro","boot","session","request","devices.snapshot",12345,JsonSerializer.SerializeToElement(new{}));
var dto=JsonSerializer.SerializeToElement(request);
Check(dto.EnumerateObject().Select(p=>p.Name).Order().SequenceEqual(reference.GetProperty("requestFields").EnumerateArray().Select(v=>v.GetString()!).Order()));
Check(dto.GetProperty("deadline_at_ms").GetInt64()==12345);
Console.WriteLine($"PASS {checks} contract checks; no production network or writes.");
