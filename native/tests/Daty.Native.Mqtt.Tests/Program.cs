using System.Text.Json;
using Daty.Native.Core;

static void Check(bool value,string message) { if(!value)throw new Exception(message); }
static JsonElement Json(object value)=>JsonSerializer.SerializeToElement(value);
var config=JsonDocument.Parse(File.ReadAllBytes(args[0])).RootElement;
var origin=config.GetProperty("origin").GetString()!;var ca=config.GetProperty("ca").GetString()!;var port=config.GetProperty("port").GetInt32();
var mode=config.GetProperty("mode").GetString();
using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(120));var token=timeout.Token;
using var client=new R19MqttClient(origin,ca,port);
if(mode=="project-startup")
{
    var initial=await client.SnapshotAsync(token);Check(initial.Channels.Count==0,"Independent development must start empty");
    var plugins=await client.CallAsync("plugins.status",token:token);
    Check(plugins.GetProperty("builtin").EnumerateArray().Any(p=>p.Text("brand")=="DATYaudio"),"DATY builtin required");
    Check(!plugins.GetProperty("plugins").EnumerateArray().Any(),"External plugins must not be inherited");
    int count=0;await using var stream=new R19DeviceStream(origin,ca,port);
    stream.SnapshotReceived+=snapshot=>{Check(snapshot.Channels.Count==0,"Unexpected copied devices");Interlocked.Increment(ref count);};
    stream.Start();while(Volatile.Read(ref count)==0)await Task.Delay(50,token);
    Console.WriteLine(JsonSerializer.Serialize(new {ok=true,mode,channels=0,externalPlugins=0,streamUpdates=count,boot=client.BootId,realMqttTls=true}));return;
}
if(mode is "offline-plugin" or "offline-plugin-readonly" or "export-remove")
{
    var trusted=PluginOfflineBundle.Catalog(File.ReadAllBytes(config.GetProperty("catalog").GetString()!));
    await using var bundle=await PluginOfflineBundle.OpenAsync(config.GetProperty("bundle").GetString()!,trusted,token);
    var bytes=await bundle.PluginAsync(token);
    var importer=new PluginImportService(client,Path.Combine(config.GetProperty("root").GetString()!,"pending-offline-install.json"));
    var before=await client.CallAsync("plugins.status",token:token);
    var offlinePrepared=await importer.PrepareAsync(bytes,token);
    RuntimeHealth? dependency=null;
    if(mode=="offline-plugin-readonly")
    {
        Check(offlinePrepared.AlreadyActive,"Live package is already active; read-only check cannot install");
        Check(bundle.Manifest.Runtimes.Length==0,"Current DATY source bundle has no vendor runtime dependencies");

    }
    else
    {
        Check(!offlinePrepared.AlreadyActive&&!before.GetProperty("plugins").EnumerateArray().Any(p=>p.Text("id")==offlinePrepared.Id),"Fresh isolated platform must not have external brand installed");
        var receipt=await importer.InstallAsync(offlinePrepared,token);Check(receipt.Text("activation")=="active","Inner trusted plugin activates through real server installer");
        Check((await importer.PrepareAsync(bytes,token)).AlreadyActive,"Duplicate import queries installed package instead of executing again");
    }
    var exported=Path.Combine(config.GetProperty("root").GetString()!,"full-export.zip");await bundle.ExportAsync(exported,token);
    var trust=trusted.Single(p=>p.Id==offlinePrepared.Id);await PluginOfflineBundle.VerifyFileAsync(exported,trust.Sha256,trust.Bytes,token);
    await using(var restored=await PluginOfflineBundle.OpenAsync(exported,trusted,token))Check((await restored.PluginAsync(token)).SequenceEqual(bytes),"Export is reimportable with identical inner package");
    if(mode=="export-remove")
    {
        var remover=new PluginExportRemovalService(client,Path.Combine(config.GetProperty("root").GetString()!,"pending-removal.json"));
        var original=await client.CallAsync("plugins.status",token:token);var removalBoot=client.BootId!;
        try {await remover.RemoveVerifiedExportAsync(exported,offlinePrepared.Id,offlinePrepared.Sha256,(int)original.Number("revision")!,removalBoot,new string('0',64),trust.Bytes,token);throw new Exception("bad export accepted");}
        catch(InvalidDataException) {Check(remover.Pending is null,"Bad export must not create a removal intent");}
        Check((await client.CallAsync("plugins.status",token:token)).Number("revision")==original.Number("revision"),"Hash failure preserves installed plugin");
        using(var cancelled=new CancellationTokenSource())
        {
            cancelled.Cancel();
            try {await remover.RemoveVerifiedExportAsync(exported,offlinePrepared.Id,offlinePrepared.Sha256,(int)original.Number("revision")!,removalBoot,trust.Sha256,trust.Bytes,cancelled.Token);throw new Exception("cancel ignored");}
            catch(OperationCanceledException) {Check(remover.Pending is null,"Cancelled export must not create removal intent");}
        }
        var removal=await remover.RemoveVerifiedExportAsync(exported,offlinePrepared.Id,offlinePrepared.Sha256,(int)original.Number("revision")!,removalBoot,trust.Sha256,trust.Bytes,token);
        while(remover.Pending is not null){await Task.Delay(150,token);removal=await remover.QueryAsync(token);}
        Check(removal.Text("state")=="removed","Verified export must finish automatic removal");
        Check(!(await client.CallAsync("plugins.status",token:token)).GetProperty("plugins").EnumerateArray().Any(),"Platform has only builtin DATY after export");
        await using var reimported=await PluginOfflineBundle.OpenAsync(exported,trusted,token);
        var preparedAgain=await importer.PrepareAsync(await reimported.PluginAsync(token),token);
        Check(!preparedAgain.AlreadyActive,"Exported package genuinely uninstalled");
        Check((await importer.InstallAsync(preparedAgain,token)).Text("activation")=="active","The exact exported ZIP reimports successfully");
    }
    var after=await client.CallAsync("plugins.status",token:token);
    if(mode=="offline-plugin-readonly")Check(before.Number("revision")==after.Number("revision"),"Live read-only validation never changes installation revision");
    Check(importer.Pending is null,"No pending duplicate operation");
    var result=new{ok=true,mode,sha=offlinePrepared.Sha256,bundleSha=trust.Sha256,bundleBytes=trust.Bytes,dependency,revision=after.Number("revision"),installs=mode=="export-remove"?2:mode=="offline-plugin"?1:0,deviceCommands=0};
    await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(result),token);Console.WriteLine(JsonSerializer.Serialize(result));return;
}
if(mode=="transport-recovery")
{
    var recoverySettings=await client.CallAsync("database.resources.list",new{kind="settings",limit=50},token);
    var recoveryBoot=client.BootId;int recoveryUpdates=0,recoveryOffline=0;DeviceSnapshot? recoveryLatest=null;
    await using var recoveryStream=new R19DeviceStream(origin,ca,port);
    recoveryStream.SnapshotReceived+=snapshot=>{Interlocked.Exchange(ref recoveryLatest,snapshot);Interlocked.Increment(ref recoveryUpdates);};
    recoveryStream.Offline+=_=>Interlocked.Increment(ref recoveryOffline);
    recoveryStream.Start();
    while(Volatile.Read(ref recoveryUpdates)==0)await Task.Delay(50,token);
    await File.WriteAllTextAsync(config.GetProperty("ready").GetString()!,"ready",token);
    while(Volatile.Read(ref recoveryOffline)==0)await Task.Delay(50,token);
    var recoveryBoundary=Volatile.Read(ref recoveryUpdates);
    while(Volatile.Read(ref recoveryUpdates)<=recoveryBoundary || Volatile.Read(ref recoveryLatest)?.Channels.Count!=4)await Task.Delay(100,token);
    var recoverySnapshot=await client.SnapshotAsync(token);
    var recoverySettingsAfter=await client.CallAsync("database.resources.list",new{kind="settings",limit=50},token);
    Check(recoverySnapshot.Channels.Count==4,"same native RPC client reconnects to all fresh receivers");
    Check(client.BootId==recoveryBoot,"transport recovery preserves runtime boot");
    Check(recoverySettings.GetRawText()==recoverySettingsAfter.GetRawText(),"native settings read remains unchanged");
    await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,recoveryOffline,recoveryUpdates,boot=recoveryBoot,channels=4,deviceCommands=0,writes=0,sameNativeClient=true}),token);
    return;
}
if(mode=="parity-read"){
    var methods=new (string Method,object Body)[]{("devices.snapshot",new{}),("database.status",new{}),("database.resources.list",new{kind="settings",limit=50}),("database.resources.list",new{kind="preferences",limit=100}),("database.draft.get",new{project_id="default"}),("database.catalog",new{kind="device_overrides",limit=20}),("database.resources.list",new{kind="planning_records",project_id="default",limit=20}),("database.resources.list",new{kind="alerts",limit=20}),("database.activity.list",new{source="operations",limit=20}),("storage.status",new{}),("archives.list",new{}),("exports.list",new{}),("plugins.status",new{}),("state.capabilities",new{}),("commands.targets",new{})};
    var reads=new List<object>();foreach(var entry in methods){var value=await client.CallAsync(entry.Method,entry.Body,token);reads.Add(new{method=entry.Method,body=entry.Body,result=value});if(value.Number("status") is >=400)throw new Exception("Read failed: "+entry.Method+value.GetRawText());}await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,boot=client.BootId,reads,deviceCommands=0,writes=0},new JsonSerializerOptions{WriteIndented=true}),token);Console.WriteLine(JsonSerializer.Serialize(new{ok=true,reads=reads.Count,boot=client.BootId,deviceCommands=0,writes=0}));return;
}
if(mode=="tls_failure")
{
    try { await client.SnapshotAsync(token);throw new Exception("WRONG_TLS_ACCEPTED"); }
    catch(Exception error) when(error.Message!="WRONG_TLS_ACCEPTED") { Console.WriteLine(JsonSerializer.Serialize(new {ok=true,wrongTlsRejected=true,error=error.GetType().Name}));return; }
}
// Deterministic stream boundaries are checked independently of the network fixture.
var streamId="view-"+new string('1',32);var boot=new string('2',32);var reducer=new R19DeviceReducer(streamId);
JsonElement Event(long seq,string kind,object payload,string? otherBoot=null,string? otherStream=null)=>Json(new {schema="daty-device-mqtt6-v1",server_id="daty-rf-pro",stream_id=otherStream??streamId,boot_id=otherBoot??boot,seq,kind,payload});
var device=new {id="fixture-ch1",receiver_id="fixture",channel_number=1,group_number=2,group_source="server-fifo-v1",brand="Shure",model="ULXD4",freq=640000,af_dbfs=-50,_source="shure-scp",_online=true,shure=new {schema="daty-shure-telemetry-v1",meter_state="live",audio_dbfs=-50,battery_bars=4,transmitter_type="ULXD2"}};
var first=reducer.Apply(Event(1,"device_list",new {devices=new[]{device}}));Check(first.Snapshot?.Channels.Single().AfDbfs==-50,"Real Shure -50 dBFS must remain visible");
Check(first.Snapshot?.Channels.Single().BatteryLabel=="4/5 格","Bars must not be invented percentage");
Check(!reducer.Apply(Event(1,"device_list",new {devices=new[]{device}})).Accepted,"Duplicate cannot refresh liveness");
var delta=reducer.Apply(Event(2,"device_update",new {devices=new[]{new {id="fixture-ch1",af_dbfs=-17,shure=new{schema="daty-shure-telemetry-v1",meter_state="live",audio_dbfs=-17,battery_bars=4,transmitter_type="ULXD2"}}}}));
Check(delta.Snapshot?.Channels.Single().FrequencyKHz==640000&&delta.Snapshot.Channels.Single().AfDbfs==-17,"Delta preserves identity and current frequency");
foreach(var bad in new[]{Event(4,"heartbeat",null!),Event(3,"heartbeat",null!,new string('3',32)),Event(3,"heartbeat",null!,otherStream:"view-"+new string('4',32))})
{try{reducer.Apply(bad);throw new Exception("BAD_EVENT_ACCEPTED");}catch(InvalidDataException){}}
var snapshots=await Task.WhenAll(Enumerable.Range(0,4).Select(_=>client.SnapshotAsync(token)));
Check(snapshots.All(x=>x.Channels.Count>0),"Actual devices must be returned");
var state=await client.CallAsync("plugins.status",token:token);
Check(state.GetProperty("builtin").EnumerateArray().Any(x=>x.Text("brand")=="DATYaudio"),"DATYaudio built in");
int updates=0;DeviceSnapshot? latest=null;
using(var stream=new R19DeviceStream(origin,ca,port))
{
    stream.SnapshotReceived+=snapshot=>{Interlocked.Exchange(ref latest,snapshot);Interlocked.Increment(ref updates);};
    stream.Start();
    var until=DateTime.UtcNow.AddSeconds(8);
    while(Volatile.Read(ref updates)<3&&DateTime.UtcNow<until)await Task.Delay(100,token);
    Check(updates>=3&&latest!.Channels.Count>0,"Continuous MQTT stream must deliver real updates");
}
var zip=await File.ReadAllBytesAsync(config.GetProperty("zip").GetString()!,token);
var pendingPath=config.GetProperty("pending").GetString()!;
var imports=new PluginImportService(client,pendingPath);
try{await imports.PrepareAsync(zip.Concat(new byte[]{1}).ToArray(),token);throw new Exception("TAMPER_ACCEPTED");}catch(R19RpcException e){Check(e.Code=="PLUGIN_PACKAGE_NOT_TRUSTED","Tampered ZIP rejected by server");}
var prepared=await imports.PrepareAsync(zip,token);string? operation=null;
if(mode=="fixture")
{
    Check(!prepared.AlreadyActive,"Fresh fixture must require installation");
    Check((await client.CallAsync("plugins.status",token:token)).Number("revision")==0,"Preview/cancel cannot install");
    try{await imports.InstallAsync(prepared with {Boot=new string('0',32)},token);throw new Exception("STALE_BOOT_ACCEPTED");}catch(R19RpcException e){Check(e.Code=="SERVER_BOOT_CHANGED","Stale confirmation rejected");}
    Check(imports.Pending is null&&!File.Exists(pendingPath),"Definite pre-send rejection clears intent");
    var receipt=await imports.InstallAsync(prepared,token);operation=receipt.Text("operation_id");
    Check(receipt.Text("activation")=="active"&&receipt.Text("state")=="installed","Durable active install required");
    Check(!File.Exists(pendingPath),"Confirmed receipt clears pending file");
    // Restore the exact query intent after a simulated application interruption, never resend installation.
    await LocalFiles.WriteAtomicAsync(pendingPath,JsonSerializer.Serialize(new PendingPlugin(client.BaseUri.GetLeftPart(UriPartial.Authority),operation!,prepared.Id,prepared.Brand,prepared.Version,prepared.Sha256)),token);
    var recovered=new PluginImportService(client,pendingPath);
    Check((await recovered.QueryAsync(token)).Text("operation_id")==operation,"Recovered local intent queries same server receipt");
    Check(recovered.Pending is null&&!File.Exists(pendingPath),"Confirmed recovery clears pending");
    prepared=await imports.PrepareAsync(zip,token);Check(prepared.AlreadyActive,"Duplicate does not send installation");
}
else Check(prepared.AlreadyActive,"Formal Shure must already be installed; test performs no install");
var final=await client.CallAsync("plugins.status",token:token);
if(mode!="fixture")Check(final.GetRawText()==state.GetRawText(),"Formal install state must remain identical");
using(var cancelled=new CancellationTokenSource()) { cancelled.Cancel();try{await client.SnapshotAsync(cancelled.Token);throw new Exception("CANCEL_IGNORED");}catch(OperationCanceledException){} }
// Same client remains usable after a request cancelled before publish.
Check((await client.SnapshotAsync(token)).Channels.Count>0,"Cancellation recovery");
Console.WriteLine(JsonSerializer.Serialize(new {ok=true,mode,channels=snapshots[0].Channels.Count,streamUpdates=updates,boot=client.BootId,revision=final.Number("revision"),operation,plugin=prepared.Id,
 devices=snapshots[0].Channels.Select(c=>new{c.Id,c.Brand,c.Group,c.ChannelLabel,c.FrequencyKHz,c.AfDbfs,c.BatteryLabel}),
 realMqttTls=true,deviceCommands=0,installationSent=mode=="fixture",browserUsed=false,reducerBoundaryChecks=7}));
