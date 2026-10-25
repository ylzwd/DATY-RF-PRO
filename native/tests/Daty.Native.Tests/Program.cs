using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Daty.Native.Core;

if(args.Length==2&&args[0]=="--benchmark-reducer"){ReducerPerformance.Run(args[1]);return;}

if(args.Length==1&&args[0]=="--host-id"){Console.WriteLine(ProjectEnvironment.HostId());return;}

var results = new List<object>();
int failed = 0;
async Task Test(string name, Func<Task> action) { try { await action(); results.Add(new { name, pass = true }); Console.WriteLine("PASS " + name); } catch (Exception e) { failed++; results.Add(new { name, pass = false, error = e.Message }); Console.WriteLine("FAIL " + name + ": " + e); } }
void Check(bool valid, string message = "Assertion failed") { if (!valid) throw new Exception(message); }
async Task Throws(Func<Task> action) { try { await action(); } catch { return; } throw new Exception("Expected rejection"); }
JsonElement Json(string value) => JsonSerializer.Deserialize<JsonElement>(value);
JsonElement Device(string fields = "") => Json("{\"id\":\"rx_ch1\",\"receiver_id\":\"rx\",\"channel_number\":1,\"_online\":true,\"status\":\"online\"" + fields + "}");
DeviceSnapshot Snapshot(JsonElement device) => DeviceSnapshot.Parse(JsonSerializer.SerializeToElement(new { success = true, devices = new[] { device } }));

foreach (var test in RfOfflineCases.All().Concat(SpectrumRfCases.All()).Concat(TransmitterCases.All()).Concat(StartupCases.All()).Concat(ProjectCases.All()).Concat(ServerNetworkCases.All()).Concat(StreamReducerCases.All()).Concat(ScanThresholdCases.All()).Concat(ShureScanProfileCases.All()).Concat(PlanningScanSourceCases.All()).Concat(MonitoringPlanningCases.All())) await Test(test.Name, () => { test.Run(); return Task.CompletedTask; });
await Test("HTTPS origin accepts deployed server", () => { Check(BridgeClient.ValidateOrigin("https://192.0.2.16:8802").Port == 8802); return Task.CompletedTask; });
foreach (var bad in new[] { "http://192.0.2.16:8802", "https://u:p@localhost:8802", "https://localhost:8802/path", "https://localhost:8802/?key=secret", "https://localhost:8802/#x", "https://localhost\\evil" })
    await Test("Reject origin " + bad, () => Throws(() => { BridgeClient.ValidateOrigin(bad); return Task.CompletedTask; }));
await Test("AF zero remains 0 dBFS, not missing", () => { var c = Channel.Parse(Device(",\"af_dbfs\":0")); Check(c.AfDbfs == 0 && c.Af == "0 dBFS"); return Task.CompletedTask; });
await Test("Null AF is authoritative; valid numeric RF text matches web", () => { var c = Channel.Parse(Device(",\"af_dbfs\":null,\"af\":-10,\"rf\":\"-50\",\"batt\":-1")); Check(c.AfDbfs is null && c.RfDbm == -50 && c.Battery is null && c.Muted is null); return Task.CompletedTask; });
await Test("Group is not identity or CH", () => { var a = Channel.Parse(Device(",\"group_source\":\"server-fifo-v1\",\"group_number\":7")); var b = Channel.Parse(Device(",\"group_source\":\"server-fifo-v1\",\"group_number\":9")); Check(a.ReceiverId == b.ReceiverId && a.Number == 1 && b.Number == 1 && a.Group != b.Group); return Task.CompletedTask; });
await Test("Numeric GROUP then CH order, stable ties and unknowns last", () => {
    Channel Row(string id, object? group, object? ch, string source = "server-fifo-v1") => Channel.Parse(JsonSerializer.SerializeToElement(new { id, receiver_id = id, group_number = group, group_source = source, channel_number = ch }));
    var input = new[] { Row("g10",10,1), Row("g2ch10",2,10), Row("unknown",null,1), Row("g2ch2",2,2), Row("tie",2,2), Row("unknown-ch",2,null), Row("untrusted",1,2,"browser"), Row("string","0002",3) };
    var original = input.Select(c => c.Id).ToArray();
    Check(ChannelOrder.Sort(input).Select(c => c.Id).SequenceEqual(new[] {"g2ch2","tie","string","g2ch10","unknown-ch","g10","unknown","untrusted"}));
    Check(input.Select(c => c.Id).SequenceEqual(original)); Check(input[6].Group == "—"); return Task.CompletedTask;
});
foreach (var value in new object?[] { null, -1, 0, 1.5, "2.0", " 2", "+2", "GROUP2", true, "9007199254740992" })
    await Test("Untrusted or malformed GROUP remains unknown: " + value, () => { Check(ChannelOrder.ReadGroup(JsonSerializer.SerializeToElement(new { group_source = "server-fifo-v1", group_number = value })) is null); return Task.CompletedTask; });
await Test("Full sort precedes pagination and survives live regroup/disconnect", () => {
    var state = new LiveState(); var token = state.SwitchTarget();
    var rows = Enumerable.Range(1,205).Reverse().Select(n => new { id = "rx-"+n, receiver_id = "rx-"+n, group_source = "server-fifo-v1", group_number = (n-1)/20+1, channel_number = (n-1)%20+1, _online = true, status = "online" }).ToArray();
    state.Apply(token,DeviceSnapshot.Parse(JsonSerializer.SerializeToElement(new { success=true,devices=rows })));
    Check(state.DisplayChannels.Select(c=>c.Id).SequenceEqual(Enumerable.Range(1,205).Select(n=>"rx-"+n)));
    Check(state.DisplayChannels.Skip(20).Take(20).First().Id=="rx-21");
    state.Apply(token,DeviceSnapshot.Parse(JsonSerializer.SerializeToElement(new {success=true,devices=rows.Select(r=>r.id=="rx-205" ? r with {group_number=1,channel_number=1} : r)})));
    Check(state.DisplayChannels[0].Id=="rx-205"); state.Fail(token); Check(state.DisplayChannels[0].Id=="rx-205"&&!state.DisplayChannels[0].Online); return Task.CompletedTask;
});
await Test("Malformed frequency does not round or coerce", () => { var c = Channel.Parse(Device(",\"freq\":641000.25")); Check(c.FrequencyKHz is null && c.Frequency == "—"); return Task.CompletedTask; });
await Test("Fractional channel rejected as unknown", () => { var c = Channel.Parse(Json("{\"id\":\"a\",\"channel_number\":1.5}")); Check(c.Number is null && !c.Online); return Task.CompletedTask; });
await Test("String false never marks online", () => { Check(!Channel.Parse(Json("{\"id\":\"a\",\"_online\":\"false\",\"status\":\"online\"}")).Online); return Task.CompletedTask; });
await Test("Stale RTT is not a live measurement", () => { var c = Channel.Parse(Device(",\"heartbeat\":{\"status\":\"measured\",\"rtt_ms\":2,\"age_ms\":6000,\"max_age_ms\":5000}")); Check(c.Rtt == "—"); return Task.CompletedTask; });
await Test("Duplicate device IDs reject whole snapshot", () => Throws(() => { DeviceSnapshot.Parse(JsonSerializer.SerializeToElement(new { success = true, devices = new[] { Device(), Device() } })); return Task.CompletedTask; }));
await Test("Empty snapshot clears stale channels", () => { var state = new LiveState(); var token = state.SwitchTarget(); state.Apply(token, Snapshot(Device())); state.Apply(token, DeviceSnapshot.Parse(Json("{\"success\":true,\"devices\":[]}"))); Check(state.DisplayChannels.Count == 0); return Task.CompletedTask; });
await Test("Old server response cannot overwrite new target", () => { var state = new LiveState(); var first = state.SwitchTarget(); var second = state.SwitchTarget(); Check(!state.Apply(first, Snapshot(Device())) && !state.Fail(first)); Check(state.Apply(second, Snapshot(Device())) && state.Connected); return Task.CompletedTask; });
await Test("Disconnect preserves observation but removes online", () => { var state = new LiveState(); var token = state.SwitchTarget(); state.Apply(token, Snapshot(Device())); state.Fail(token); Check(!state.Connected && state.Snapshot is not null && !state.DisplayChannels[0].Online); return Task.CompletedTask; });
await Test("Whitelisted native transport is GET-only with no credential headers", async () => { var fake = new FixtureHandler((request, _) => { Check(request.Method == HttpMethod.Get && request.Headers.Authorization is null && request.RequestUri?.AbsolutePath == "/api/devices"); return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"success\":true,\"devices\":[]}") }); }); using var client = new BridgeClient("https://localhost:8802", fake); Check((await client.SnapshotAsync(default)).Channels.Count == 0); });
foreach (var route in new[] { "/api/command", "/api/receivers/enroll", "//evil.test/api/devices", "/api/projects/../command" })
    await Test("Block unapproved route " + route, async () => { using var client = new BridgeClient("https://localhost:8802", new FixtureHandler((_, _) => throw new Exception("Transport must not be called"))); await Throws(() => client.GetAsync(route, default)); });
await Test("HTTP redirect is rejected", async () => { using var client = new BridgeClient("https://localhost:8802", new FixtureHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Redirect)))); await Throws(() => client.GetAsync("/health", default)); });
await Test("Oversized HTTP response is rejected", async () => { using var client = new BridgeClient("https://localhost:8802", new FixtureHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[8 * 1024 * 1024 + 1]) }))); await Throws(() => client.GetAsync("/health", default)); });
await Test("Caller cancellation reaches native transport", async () => { using var cts = new CancellationTokenSource(60); using var client = new BridgeClient("https://localhost:8802", new FixtureHandler(async (_, token) => { await Task.Delay(10000, token); return new HttpResponseMessage(HttpStatusCode.OK); })); await Throws(() => client.GetAsync("/health", cts.Token)); });
await Test("Invalid JSON is rejected", async () => { using var client = new BridgeClient("https://localhost:8802", new FixtureHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("bad json") }))); await Throws(() => client.GetAsync("/health", default)); });
await Test("Original CSV parser preserves MHz/kHz and peak duplicate", () => { var scan = LocalFiles.ParseScan(Encoding.UTF8.GetBytes("frequency_mhz,level_dbm\n641.000,-80\n641.250,-60\n641.000,-50\n"), "test.csv", default); Check(scan.Points.Count == 2 && scan.Points[0].FrequencyKHz == 641000 && scan.Points[0].LevelDbm == -50 && scan.DuplicateRows == 1); return Task.CompletedTask; });
await Test("Invalid scan row rejected without fake zero", () => Throws(() => { LocalFiles.ParseScan(Encoding.UTF8.GetBytes("frequency_khz,level_dbm\n641000,\n641250,-60\n"), "bad.csv", default); return Task.CompletedTask; }));
await Test("Already-cancelled parser rejects", () => Throws(() => { LocalFiles.ParseScan(Encoding.UTF8.GetBytes("frequency_khz,level_dbm\n641000,-70\n641250,-60\n"), "test.csv", new CancellationToken(true)); return Task.CompletedTask; }));
var temporary = Path.Combine(Path.GetTempPath(), "daty-native-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(temporary);
await Test("Atomic local settings round-trip", async () => { var path = Path.Combine(temporary, "settings.json"); var expected = new NativeSettings(); await expected.SaveAsync(path, default); Check(NativeSettings.Load(path) == expected); });
await Test("Damaged local settings do not auto-overwrite", () => { var path = Path.Combine(temporary, "damaged.json"); File.WriteAllText(path, "broken"); try { NativeSettings.Load(path); throw new Exception("Expected failure"); } catch (JsonException) { Check(File.ReadAllText(path) == "broken"); } return Task.CompletedTask; });
await Test("Planning range never persists to bootstrap file; legacy keys pruned without losing endpoint",async()=>{
    var path=Path.Combine(temporary,"connection-only.json");
    await File.WriteAllTextAsync(path,"{\"Server\":\"https://127.0.0.1:8080\",\"PollSeconds\":5,\"MqttPort\":18083,\"StartMHz\":630,\"EndMHz\":690,\"extra\":\"keep\"}");
    var loaded=NativeSettings.Load(path);Check(loaded.StartMHz==400&&loaded.EndMHz==900,"legacy planning fields not loaded");
    await NativeSettings.RemoveLegacyPlanningRangeAsync(path,default);var cleaned=Json(await File.ReadAllTextAsync(path));
    Check(cleaned.Text("extra")=="keep"&&cleaned.Number("MqttPort")==18083&&cleaned.Text("Server")=="https://127.0.0.1:8080"&&!cleaned.TryGetProperty("StartMHz",out _),"bootstrap fields preserved");
    await (loaded with{StartMHz=614.25,EndMHz=638}).SaveAsync(path,default);var saved=Json(await File.ReadAllTextAsync(path));
    Check(!saved.TryGetProperty("StartMHz",out _)&&!saved.TryGetProperty("EndMHz",out _),"current range is memory only");
});
await Test("Cancelled save keeps previous file", async () => { var path = Path.Combine(temporary, "keep.json"); File.WriteAllText(path, "old"); await Throws(() => LocalFiles.WriteAtomicAsync(path, "new", new CancellationToken(true))); Check(File.ReadAllText(path) == "old"); });
await Test("Input file byte limit enforced", async () => { var path = Path.Combine(temporary, "big.txt"); File.WriteAllText(path, new string('a', 100)); await Throws(() => LocalFiles.ReadBoundedAsync(path, 10, default)); });

await Test("Real HTTPS accepts matching private CA and hostname", async () => Check(await TlsFixture.RequestAsync("valid")));
foreach (var scenario in new[] { "wrong-ca", "wrong-host", "expired" })
    await Test("Real HTTPS rejects " + scenario, async () => Check(!await TlsFixture.RequestAsync(scenario)));
using(var golden=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"web-display-golden.json"))))foreach(var testCase in golden.RootElement.GetProperty("cases").EnumerateArray())await Test("Web parity: "+testCase.Text("name"),()=>{var channel=Channel.Parse(testCase.GetProperty("input"));Check(channel.Online==testCase.Field("online").True(),"online differs");Check(channel.RfDbm==testCase.Number("rf"),"RF differs");Check(channel.AfDbfs==testCase.Number("af"),"AF differs");Check(channel.BatteryLabel.Replace(" ","")==testCase.Text("battery"),"battery differs");Check(TestMonitoringRules.Issues(channel,new()).Select(i=>i.Metric).Order().SequenceEqual(testCase.GetProperty("issues").EnumerateArray().Select(e=>e.GetString()).Order()),"alarms differ");return Task.CompletedTask;});
await Test("Original r19 mathematical planner agrees across JavaScript and native Jint",()=>{using var golden=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"web-plan-golden.json")));var root=golden.RootElement;var actual=CoordinationEngine.Plan(root.GetProperty("devices"),root.GetProperty("options"),Json("[]"),default);Check(System.Text.Json.Nodes.JsonNode.DeepEquals(System.Text.Json.Nodes.JsonNode.Parse(actual.GetRawText()),System.Text.Json.Nodes.JsonNode.Parse(root.GetProperty("result").GetRawText())),"planner output differs");return Task.CompletedTask;});
await Test("Alarm edges survive UI coalescing and unchanged alarms only touch lastSeen",()=>{var monitor=new LiveAlertMonitor(rules:TestMonitoringRules.Value);var low=Channel.Parse(Device(",\"rf\":-90"));var recovered=Channel.Parse(Device(",\"rf\":-40"));monitor.Observe([low],new(),1000);var first=monitor.Active.Single();monitor.Acknowledge(first);monitor.Observe([low],new(),1100);Check(monitor.Active.Single().LastSeen==1100&&monitor.PendingArchives.Count==0,"steady active must not enqueue merge");monitor.Observe([recovered],new(),1200);monitor.Observe([low],new(),1300);Check(monitor.PendingArchives.Count==2&&monitor.PendingArchives.Any(a=>a.EndedAt==1200)&&monitor.Active.Single().ArchiveId!=first.ArchiveId,"recovery and retrigger must retain separate episodes");return Task.CompletedTask;});
await Test("Unknown Shure fault is pending, never false recovery",()=>{Channel Shure(string state,string status="online")=>Channel.Parse(JsonSerializer.SerializeToElement(new{id="shure_ch1",receiver_id="rx",brand="Shure",model="ULXD4",channel_number=1,_source="shure-scp",_online=status=="online",status,shure=new{schema="daty-shure-telemetry-v1",interference=state}}));var monitor=new LiveAlertMonitor(rules:TestMonitoringRules.Value);monitor.Observe([Shure("DETECTED")],new(),1000);var first=monitor.Active.Single();monitor.Observe([Shure("unknown","offline")],new(),2000);Check(monitor.Active.Single().Pending&&monitor.Active.Single().ArchiveId==first.ArchiveId);monitor.Observe([Shure("NONE")],new(),3000);Check(monitor.Active.Count==0&&monitor.PendingArchives.Single().EndedAt==3000);return Task.CompletedTask;});
await Test("Clear waits for exact saved version; newer alarm observation stays visible",()=>{var monitor=new LiveAlertMonitor(rules:TestMonitoringRules.Value);var low=Channel.Parse(Device(",\"rf\":-90"));monitor.Observe([low],new(),1000);var selected=monitor.Active;monitor.QueueCurrent(selected);monitor.Observe([low],new(),1100);monitor.Acknowledge(selected[0]);Check(monitor.ClearConfirmed(selected)==0&&monitor.Active.Count==1);return Task.CompletedTask;});
await Test("Pending alarm lifecycle survives native restart without losing ended/retriggered records",()=>{var m=new LiveAlertMonitor(rules:TestMonitoringRules.Value);var low=Channel.Parse(Device(",\"rf\":-90"));m.Observe([low],new(),1000);m.Observe([Channel.Parse(Device(",\"rf\":-30"))],new(),1100);m.Observe([low],new(),1200);var restored=new LiveAlertMonitor(rules:TestMonitoringRules.Value);restored.Restore(m.Serialize());Check(restored.Active.Single().ArchiveId==m.Active.Single().ArchiveId&&restored.PendingArchives.Count==2);Check(restored.PendingArchives.Single(r=>r.EndedAt.HasValue).EndedAt==1100);return Task.CompletedTask;});
await Test("Hardware frequency gate rejects unsupported band/grid/offline",async()=>{
    var c=Channel.Parse(Device(",\"brand\":\"Shure\",\"capabilities\":{\"write_frequency\":true,\"frequency_control\":{\"min_khz\":632000,\"max_khz\":696000,\"step_khz\":25,\"origin_khz\":0}}"));
    CommandRules.ValidateFrequency(c,640025);foreach(var bad in new[]{631975,696025,640001})await Throws(()=>{CommandRules.ValidateFrequency(c,bad);return Task.CompletedTask;});await Throws(()=>{CommandRules.ValidateFrequency(c with{Online=false},640000);return Task.CompletedTask;});
});
await Test("MQTT downloads validate chunks and complete digest before closing",async()=>{
    var bytes=Enumerable.Range(0,300001).Select(i=>(byte)(i%251)).ToArray();var sha=R19Transfers.Digest(bytes);var descriptor=JsonSerializer.SerializeToElement(new{id="test-download",state="ready",bytes=bytes.Length,sha256=sha});int closed=0;
    var service=new R19Transfers((method,body,token)=>{var b=JsonSerializer.SerializeToElement(body);if(method=="downloads.close"){closed++;return Task.FromResult(Json("{}"));}var offset=(int)b.Number("offset")!;var block=bytes.Skip(offset).Take(R19Transfers.ChunkBytes).ToArray();return Task.FromResult(JsonSerializer.SerializeToElement(new{download_id="test-download",offset,bytes=block.Length,sha256=R19Transfers.Digest(block),file_sha256=sha,eof=offset+block.Length==bytes.Length,data=Convert.ToBase64String(block)}));});
    using var output=new MemoryStream();await service.DownloadAsync(descriptor,output,default);Check(output.ToArray().SequenceEqual(bytes)&&closed==1);
    var corrupt=new R19Transfers((method,body,token)=>Task.FromResult(JsonSerializer.SerializeToElement(new{download_id="test-download",offset=0,bytes=1,sha256=sha,file_sha256=sha,eof=false,data="AA=="})));await Throws(()=>corrupt.DownloadAsync(descriptor,new MemoryStream(),default));
});
await Test("RF simulation uses actual receiver points and is separate from scan data",()=>{
    var devices=CoordinationEngine.CalculationDevices([Channel.Parse(Device(",\"freq\":640000,\"rf\":-42,\"brand\":\"DATYaudio\",\"model\":\"RF PRO\""))]);var result=CoordinationEngine.Simulate(devices,Json("{}"),630,650,default);Check(result.GetProperty("points").GetArrayLength()>0&&result.GetProperty("carriers").GetArrayLength()==1);return Task.CompletedTask;
});
await Test("Shure readback display is bound to identity, stream, field timestamp and expiry",async()=>{
    var target=Json("{\"device_id\":\"s1\",\"receiver_id\":\"rx\",\"receiver_session_id\":\"stream\",\"channel_number\":1,\"expected_brand\":\"Shure\"}");
    var intent=JsonSerializer.SerializeToElement(new{operation_id="op",target,command="mute",expected_value=true});
    var receipt=JsonSerializer.SerializeToElement(new{operation_id="op",target,command="mute",expected_value=true,actual_value=true,state="readback_confirmed",command_id="command",execution_evidence=new{command_id="command",receiver_session_id="stream",source="shure-post-write-readback",execution_ack_supported=false,target,command="mute",actual_value=true,received_at_ms=2000}});
    Channel Make(long at=1000,string stream="stream",string ip="127.0.0.1",bool online=true)=>Channel.Parse(JsonSerializer.SerializeToElement(new{id="s1",receiver_id="rx",receiver_ip=ip,channel_number=1,brand="Shure",model="ULXD4",_source="shure-scp",_online=online,status=online?"online":"offline",muted=false,rf=-40,shure=new{schema="daty-shure-telemetry-v1",meter_state="live",meter_stream_id=stream,field_times=new{muted=at},transmitter_muted=false,receiver_muted=false}}));
    var view=new ConfirmedMuteView();var original=Make();view.Accept(original,receipt,intent,5000);
    var projected=view.Apply(original,5001);Check(projected.Muted==true&&projected.RfDbm==-40&&!projected.Raw.Field("shure").Field("transmitter_muted").True()&&original.Muted==false,"projection must preserve real telemetry and raw source");
    Check(view.Apply(Make(2100),5002).Muted==false,"new mute timestamp wins");
    foreach(var newer in new[]{Make(stream:"new-stream"),Make(ip:"127.0.0.2"),Make(online:false)}){view.Accept(original,receipt,intent,5000);Check(view.Apply(newer,5001).Muted==false,"changed identity/stream/offline must invalidate");}
    view.Accept(original,receipt,intent,5000);Check(view.Apply(original,20000).Muted==false,"15s maximum lifetime");
    var bad=System.Text.Json.Nodes.JsonNode.Parse(receipt.GetRawText())!;bad["execution_evidence"]!["source"]="mqtt-puback";await Throws(()=>{view.Accept(original,JsonSerializer.SerializeToElement(bad),intent,5000);return Task.CompletedTask;});
});
await Test("Receiver counts deduplicate MAC aliases without changing routing identity",()=>{
    var a=Channel.Parse(Json("{\"id\":\"a\",\"receiver_id\":\"one\",\"receiver_mac\":\"00:0E:DD:AD:31:A3\",\"ip\":\"192.0.2.1\"}"));
    var b=Channel.Parse(Json("{\"id\":\"b\",\"receiver_id\":\"two\",\"receiver_mac\":\"000e-ddad-31a3\",\"ip\":\"192.0.2.2\"}"));
    Check(a.DisplayReceiverKey==b.DisplayReceiverKey&&a.ReceiverId!=b.ReceiverId);return Task.CompletedTask;
});

await Test("Memory-only alerts keep live lifecycle without an archive queue",()=>{
    var monitor=new LiveAlertMonitor(archiveEnabled:false,rules:TestMonitoringRules.Value);
    var channel=Channel.Parse(Json("{\"id\":\"memory-only\",\"brand\":\"DATYaudio\",\"_online\":true,\"rf\":-75,\"batt\":80,\"af_dbfs\":-50}"));
    monitor.Observe([channel],new AlertThresholds(Rf:-60),1000);
    Check(monitor.Active.Count>0&&monitor.PendingArchives.Count==0,"live warning exists without queued archive");
    for(int i=0;i<1000;i++){monitor.Observe([],new AlertThresholds(Rf:-60),2000+i*2);monitor.Observe([channel],new AlertThresholds(Rf:-60),2001+i*2);}
    Check(monitor.PendingArchives.Count==0,"recovery/retrigger does not accumulate archives");
    Check(monitor.ClearDisplay(monitor.Active)>0&&monitor.Active.Count==0,"clear display does not require database acknowledgement");
    monitor.Observe([channel],new AlertThresholds(Rf:-60),5000);Check(monitor.Active.Count>0,"persistent condition reappears on new telemetry");return Task.CompletedTask;
});

await Test("Legacy pending blocks only matching server/channel and prevents concurrent ownership", async()=>{
    var dir=Path.Combine(Path.GetTempPath(),"daty-native-recovery-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);
    try {
        var store=new PendingDeviceCommands(dir);var server="https://127.0.0.1:8080";
        JsonElement Intent(string device,int port=8083)=>JsonSerializer.SerializeToElement(new{server,mqtt_port=port,operation_id=Guid.NewGuid().ToString("N"),target=new{device_id=device},command="mute",expected_value=true});
        var legacy=Intent("old");await File.WriteAllTextAsync(Path.Combine(dir,"pending-device-command.json"),legacy.GetRawText());
        using(var lease=store.Acquire(server,8083,"old")){await Throws(()=>Task.FromResult(store.Acquire(server,8083,"old")));using var other=store.Acquire(server,8083,"other");}
        await Throws(()=>store.CreateAsync(Intent("old"),default));
        var pending=await store.CreateAsync(Intent("other"),default);Check(store.Read(server,8083).Count==2);
        var otherPort=await store.CreateAsync(Intent("old",18083),default);Check(store.Read(server,18083).Count==1);
        Check(store.Read("https://127.0.0.2:8080",8083).Count==0);
        store.Complete(pending);Check(store.Read(server,8083).Single().Intent.Text("operation_id")==legacy.Text("operation_id"));
        var old=store.Read(server,8083).Single();await File.AppendAllTextAsync(old.Path," ");await Throws(()=>{store.Complete(old);return Task.CompletedTask;});Check(File.Exists(old.Path));
        store.Complete(otherPort);
    } finally {Directory.Delete(dir,true);}
});
await Test("Unknown result needs real review receipt; observed equality is not execution evidence", async()=>{
    var intent=Json("{\"operation_id\":\"11111111111111111111111111111111\",\"target\":{\"device_id\":\"one\"},\"command\":\"mute\",\"expected_value\":true}");
    var receipt=JsonSerializer.Deserialize<Dictionary<string,object?>>(intent.GetRawText())!;receipt["state"]="unknown";receipt["revision"]=3;receipt["error"]="SEND_OUTCOME_UNKNOWN";receipt["actual_value"]=null;receipt["execution_evidence"]=null;
    var original=JsonSerializer.SerializeToElement(receipt);Check(!PendingDeviceCommands.CanComplete(original,intent));
    var observation=Json("{\"frequency_khz\":640000,\"muted\":true}");receipt["revision"]=4;receipt["review"]=new{confirmed=true,meaning="release-target-no-execution-claim",observed=observation};
    var reviewed=JsonSerializer.SerializeToElement(receipt);PendingDeviceCommands.ValidateReview(original,reviewed,observation);Check(PendingDeviceCommands.CanComplete(reviewed,intent));
    receipt["state"]="acknowledged";await Throws(()=>{PendingDeviceCommands.ValidateReview(original,JsonSerializer.SerializeToElement(receipt),observation);return Task.CompletedTask;});
    receipt["state"]="unknown";receipt["actual_value"]=true;await Throws(()=>{PendingDeviceCommands.ValidateReview(original,JsonSerializer.SerializeToElement(receipt),observation);return Task.CompletedTask;});
    receipt["actual_value"]=null;receipt["revision"]=7;await Throws(()=>{PendingDeviceCommands.ValidateReview(original,JsonSerializer.SerializeToElement(receipt),observation);return Task.CompletedTask;});
    await Throws(()=>{PendingDeviceCommands.ValidateReview(original,reviewed,Json("{\"muted\":false}"));return Task.CompletedTask;});
});

await Test("Settings submit immediately and preserve the last edit until actual commit",async()=>{
    var gate=new TaskCompletionSource<JsonElement>();var values=new List<JsonElement>();var states=new List<string>();
    var writer=new ImmediateSettings((id,value)=>{values.Add(value);return values.Count==1?gate.Task:Task.FromResult(value);},(id,state,value,error)=>states.Add(state));
    var first=writer.Submit("network_connection",new{heartbeatSeconds=15});var last=writer.Submit("network_connection",new{heartbeatSeconds=60});
    Check(values.Count==1&&writer.HasUnsaved&&!states.Contains("saved"),"immediate request but no premature acknowledgement");
    gate.SetResult(values[0]);await Task.WhenAll(first,last);
    Check(values.Count==2&&values[1].Number("heartbeatSeconds")==60&&!writer.HasUnsaved&&states.Last()=="saved","latest edit really committed");
});
await Test("Settings mismatch or lost receipt remains unsaved until explicit retry",async()=>{
    int calls=0;var states=new List<string>();
    var writer=new ImmediateSettings((id,value)=>{calls++;return calls==1?Task.FromResult(Json("{\"enabled\":false}")):Task.FromResult(value);},(id,state,value,error)=>states.Add(state));
    await writer.Submit("alert_sound",new{enabled=true});Check(writer.HasUnsaved&&states.Last()=="error"&&calls==1&&writer.PendingValue("alert_sound")?.Field("enabled").True()==true);
    await writer.Retry();Check(!writer.HasUnsaved&&states.Last()=="saved"&&calls==2&&writer.PendingValue("alert_sound") is null);
});
await Test("One failed setting does not hide another setting's committed receipt",async()=>{
    var writer=new ImmediateSettings((id,value)=>id=="alert_sound"?Task.FromException<JsonElement>(new IOException("offline")):Task.FromResult(value),(id,state,value,error)=>{});
    await writer.Submit("alert_sound",new{enabled=false});await writer.Submit("auto_frequency",new{enabled=true});
    Check(writer.IsDirty("alert_sound")&&!writer.IsDirty("auto_frequency")&&writer.HasUnsaved);
});

using(var manualGolden=JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"web-plan-golden.json"))))
{
    var root=manualGolden.RootElement;var devices=root.GetProperty("devices");var options=root.GetProperty("options");
    var desired=new Dictionary<string,int>{{"test_ch1",641000},{"fixture_ch2",645000}};
    JsonElement ChangedOptions(string key,object value){var obj=options.Deserialize<Dictionary<string,JsonElement>>()!;obj[key]=JsonSerializer.SerializeToElement(value);return JsonSerializer.SerializeToElement(obj);}
    await Test("Manual exact MHz parsing rejects partial exponent comma and excess precision",async()=>{
        Check(CoordinationEngine.ParseManualFrequency(" 640.025 ")==640025);
        foreach(var input in new[]{"640.","","640.0001","6.4e2","640,000","+640","29.999","3000.001"})await Throws(()=>{CoordinationEngine.ParseManualFrequency(input);return Task.CompletedTask;});
    });
    await Test("Manual revalidation keeps desired frequencies without creating persisted locks or fake backups",()=>{
        var result=CoordinationEngine.ValidateManualPlan(devices,options,Json("[]"),desired,default);
        Check(result.Field("manualValidation").True()&&result.Field("search").Field("complete").True());
        Check(result.Field("assignments").EnumerateArray().All(a=>a.Number("frequencyKHz")==desired[a.Text("deviceId")!]&&!a.Field("locked").True()&&a.Field("backupFrequenciesKHz").GetArrayLength()==0));
        Check(result.Field("options").Field("lockedAssignments").GetArrayLength()==0&&result.Field("options").Number("backupCount")==1);return Task.CompletedTask;
    });
    foreach(var (frequency,label) in new[]{(630000,"range"),(641025,"DATY coordination grid"),(645000,"cochannel"),(646000,"GROUP order")})
        await Test("Manual rejects "+label,()=>Throws(()=>{var map=new Dictionary<string,int>(desired){["test_ch1"]=frequency};CoordinationEngine.ValidateManualPlan(devices,options,Json("[]"),map,default);return Task.CompletedTask;}));
    await Test("Manual respects true lock exclusion occupancy and scan coverage",async()=>{
        foreach(var opt in new[]{ChangedOptions("lockedAssignments",new[]{new{deviceId="test_ch1",frequencyKHz=640000}}),ChangedOptions("excludedRanges",new[]{new{startKHz=641000,endKHz=642000,reason="fixture"}}),ChangedOptions("knownCarriers",new[]{new{frequencyKHz=641000,guardKHz=250,reason="fixture"}}),ChangedOptions("scanPoints",new[]{new{frequencyKHz=640000,levelDbm=-100},new{frequencyKHz=640025,levelDbm=-100}})})
            await Throws(()=>{CoordinationEngine.ValidateManualPlan(devices,opt,Json("[]"),desired,default);return Task.CompletedTask;});
    });
    await Test("Manual rejects missing or unrelated channel identity",async()=>{
        foreach(var map in new[]{new Dictionary<string,int>{{"test_ch1",641000}},new Dictionary<string,int>{{"wrong",641000},{"fixture_ch2",645000}}})await Throws(()=>{CoordinationEngine.ValidateManualPlan(devices,options,Json("[]"),map,default);return Task.CompletedTask;});
    });
}

foreach(var test in OfflineBundleCases.All()) await Test(test.Name,test.Run);
foreach(var test in ScanFileCases.All()) await Test(test.Name,test.Run);
foreach(var test in ScanExchangeCases.All()) await Test(test.Name,test.Run);

if (args.Length > 0) await File.WriteAllTextAsync(args[0], JsonSerializer.Serialize(new { passed = failed == 0, tests = results.Count, failures = failed, network = "in-memory HTTP and own ephemeral loopback TLS fixtures only", productionWrites = 0, results }, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine($"RESULT {results.Count - failed}/{results.Count}; failures={failed}");
Environment.ExitCode = failed == 0 ? 0 : 1;

sealed class FixtureHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> call) : HttpMessageHandler
{ protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => call(request, cancellationToken); }
