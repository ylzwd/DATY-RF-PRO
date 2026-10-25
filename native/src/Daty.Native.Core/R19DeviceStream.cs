using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Daty.Native.Contracts;
using MQTTnet;
using MQTTnet.Protocol;

namespace Daty.Native.Core;

/// <summary>Snapshot then ordered deltas; duplicates never refresh liveness. A gap requires a new snapshot.</summary>
public sealed class R19DeviceReducer
{
    private readonly string stream;
    private Dictionary<string, JsonObject> devices = new(StringComparer.Ordinal);
    private Dictionary<string, Channel> parsed = new(StringComparer.Ordinal);
    public long Sequence { get; private set; }
    public string? BootId { get; private set; }
    public R19DeviceReducer(string streamId) { if (!Regex.IsMatch(streamId,"^view-[a-f0-9]{32}$")) throw new InvalidDataException("INVALID_STREAM_ID"); stream=streamId; }
    public (bool Accepted, DeviceSnapshot? Snapshot) Apply(JsonElement e)
    {
        if (e.Text("schema") != "daty-device-mqtt6-v1" || e.Text("server_id") != "daty-rf-pro" || e.Text("stream_id") != stream || !R19MqttClient.HexId(e.Text("boot_id"))) throw new InvalidDataException("INVALID_STREAM_SOURCE");
        if (BootId is not null && BootId != e.Text("boot_id")) throw new InvalidDataException("STREAM_BOOT_CHANGED");
        if (!e.Field("seq").TryGetInt64(out var seq) || seq < 1 || seq > 9007199254740991L) throw new InvalidDataException("INVALID_SEQUENCE");
        if (seq <= Sequence) return (false,null);
        if (seq != Sequence + 1 || Sequence == 0 && e.Text("kind") != "device_list") throw new InvalidDataException("SNAPSHOT_REQUIRED");
        var events=e.Text("kind") == "event_batch" ? e.GetProperty("payload").GetProperty("events").EnumerateArray().ToArray() : [e];
        if (events.Length is < 1 or > 128) throw new InvalidDataException("INVALID_BATCH");
        bool changed=false; double? time=null;
        // Heartbeats need no device copy. A publication owns only the devices it
        // changes; committed nodes stay immutable until the whole batch validates.
        Dictionary<string, JsonObject>? next=null;
        HashSet<string>? owned=null;
        foreach (var item in events)
        {
            var kind=item.Text("kind");var payload=item.Field("payload");
            if (kind is "device_list" or "device_update")
            {
                if (payload.Field("devices").ValueKind != JsonValueKind.Array) throw new InvalidDataException("INVALID_DEVICES");
                if (kind == "device_list") { next=new(StringComparer.Ordinal);owned=new(StringComparer.Ordinal); }
                else { next??=new(devices,StringComparer.Ordinal);owned??=new(StringComparer.Ordinal); }
                var seen=new HashSet<string>(StringComparer.Ordinal);
                foreach (var raw in payload.GetProperty("devices").EnumerateArray())
                {
                    var id=raw.Text("id");if (string.IsNullOrEmpty(id) || !seen.Add(id)) throw new InvalidDataException("INVALID_DEVICE_ID");
                    var incoming=JsonNode.Parse(raw.GetRawText())!.AsObject();
                    if (!next.TryGetValue(id,out var prior)) { next[id]=incoming;owned.Add(id); }
                    else
                    {
                        if(owned.Add(id)) next[id]=prior=(JsonObject)prior.DeepClone();
                        foreach(var field in incoming) prior[field.Key]=field.Value?.DeepClone();
                    }
                }
                if (next.Count>10000) throw new InvalidDataException("DEVICE_LIMIT");
                changed=true;time=payload.Number("server_time_ms");
            }
            else if (kind=="heartbeat") { if (payload.ValueKind!=JsonValueKind.Null) throw new InvalidDataException("INVALID_HEARTBEAT"); }
            else if (kind is not ("mute_command" or "command_update" or "client_disconnect")) throw new InvalidDataException("INVALID_EVENT_KIND");
        }
        // Nothing is emitted until all items in this publication have validated.
        DeviceSnapshot? snapshot=null;
        if(changed)
        {
            var raw=JsonSerializer.SerializeToElement(new {success=true,server_time_ms=time,devices=next!.Values});
            var nextParsed=new Dictionary<string,Channel>(next.Count,StringComparer.Ordinal);
            foreach(var item in raw.GetProperty("devices").EnumerateArray())
            {
                var id=item.Text("id")!;
                // Channel.Parse is a pure interpretation of this record. Reuse
                // unchanged immutable channels, while keeping the full raw export.
                nextParsed.Add(id,owned!.Contains(id)?Channel.Parse(item):parsed[id]);
            }
            snapshot=new(nextParsed.Values.ToArray(),DateTimeOffset.UtcNow,time,raw);
            devices=next;parsed=nextParsed;
        }
        BootId=e.Text("boot_id");Sequence=seq;return (true,snapshot);
    }
}

public sealed class R19DeviceStream : IDisposable, IAsyncDisposable
{
    private const string Topic="daty/v2/daty-rf-pro/devices/read";
    private readonly R19Endpoints endpoints;
    private readonly R19Tls tls;
    private readonly CancellationTokenSource lifetime=new();
    private Task? worker;
    private readonly object lifecycle=new();
    private Task? disposal;
    public event Action<DeviceSnapshot>? SnapshotReceived;
    public event Action<string>? Offline;
    public R19DeviceStream(string origin,string caPath,int mqttPort=8083) { endpoints=R19Endpoints.FromWebOrigin(origin,mqttPort);tls=new(caPath); }
    public void Start() { lock(lifecycle){ObjectDisposedException.ThrowIf(disposal is not null,this);worker??=Task.Run(RunAsync);} }
    private async Task RunAsync()
    {
        try
        {
            while(!lifetime.IsCancellationRequested)
            {
                using var client=new MqttClientFactory().CreateMqttClient();
                var ended=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                R19DeviceReducer? reducer=null;long last=Stopwatch.GetTimestamp();
                client.DisconnectedAsync+=_=>{ended.TrySetException(new IOException("STREAM_DISCONNECTED"));return Task.CompletedTask;};
                client.ApplicationMessageReceivedAsync+=e=>
                {
                    try
                    {
                        if(ended.Task.IsCompleted || lifetime.IsCancellationRequested)return Task.CompletedTask;
                        if(e.ApplicationMessage.Topic!=Topic || e.ApplicationMessage.Retain || e.ApplicationMessage.Payload.Length>900*1024 || reducer is null)throw new InvalidDataException("INVALID_STREAM_PUBLICATION");
                        using var doc=JsonDocument.Parse(e.ApplicationMessage.Payload);
                        var result=reducer.Apply(doc.RootElement);
                        if(result.Accepted)Interlocked.Exchange(ref last,Stopwatch.GetTimestamp());
                        if(result.Snapshot is not null)SnapshotReceived?.Invoke(result.Snapshot);
                    }
                    catch(Exception error){ended.TrySetException(error);}
                    return Task.CompletedTask;
                };
                try
                {
                    using var start=CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);start.CancelAfter(TimeSpan.FromSeconds(6));
                    var ack=await client.ConnectAsync(tls.Options(endpoints.Live,endpoints.Web),start.Token).ConfigureAwait(false);
                    if(ack.IsSessionPresent || ack.ResultCode!=MqttClientConnectResultCode.Success)throw new InvalidDataException("INVALID_STREAM_SESSION");
                    reducer=new(ack.AssignedClientIdentifier??"");
                    var sub=await client.SubscribeAsync(new MqttClientSubscribeOptionsBuilder().WithTopicFilter(Topic,MqttQualityOfServiceLevel.AtLeastOnce).Build(),start.Token).ConfigureAwait(false);
                    if(sub.Items.Count!=1 || (int)sub.Items.Single().ResultCode is not (0 or 1))throw new InvalidDataException("STREAM_SUBSCRIBE_FAILED");
                    while(!ended.Task.IsCompleted)
                    {
                        await Task.WhenAny(ended.Task,Task.Delay(500,lifetime.Token)).ConfigureAwait(false);
                        lifetime.Token.ThrowIfCancellationRequested();
                        if(Stopwatch.GetElapsedTime(Interlocked.Read(ref last))>TimeSpan.FromSeconds(5))throw new IOException("STREAM_IDLE");
                    }
                    await ended.Task.ConfigureAwait(false);
                }
                catch(Exception error) { if(!lifetime.IsCancellationRequested) Offline?.Invoke(error.Message); }
                client.Dispose();
                await Task.Delay(1000,lifetime.Token).ConfigureAwait(false); // A new connection always starts with a full snapshot.
            }
        }
        catch(OperationCanceledException) { }
        finally { tls.Dispose(); }
    }
    public ValueTask DisposeAsync()
    {
        lock(lifecycle)
        {
            disposal??=Task.Run(async()=>{await lifetime.CancelAsync().ConfigureAwait(false);if(worker is not null)await worker.ConfigureAwait(false);else tls.Dispose();});
            return new(disposal);
        }
    }
    public void Dispose()
    {
        var task=DisposeAsync().AsTask();
        _=task.ContinueWith(t=>System.Diagnostics.Trace.TraceWarning("Live stream cleanup: {0}",t.Exception?.GetBaseException().GetType().Name),CancellationToken.None,TaskContinuationOptions.OnlyOnFaulted,TaskScheduler.Default);
    }
}
