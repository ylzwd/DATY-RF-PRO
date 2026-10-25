using System.Net.Security;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.RegularExpressions;
using Daty.Native.Contracts;
using MQTTnet;
using MQTTnet.Protocol;

namespace Daty.Native.Core;

public sealed class R19RpcException(string code, int? status = null) : IOException(code)
{
    public string Code { get; } = code;
    public int? Status { get; } = status;
}

/// <summary>Strict, app-local trust. No system trust-store edits or plaintext fallback.</summary>
public sealed class R19Tls : IDisposable
{
    private readonly X509Certificate2 root;
    public R19Tls(string path)
    {
        var bytes = File.ReadAllBytes(path);
        if (bytes.Length > 131072) throw new InvalidDataException("CA 文件过大");
        var text = System.Text.Encoding.ASCII.GetString(bytes);
        root = text.Contains("-----BEGIN CERTIFICATE-----") ? X509Certificate2.CreateFromPem(text) : X509CertificateLoader.LoadCertificate(bytes);
        if (!root.Extensions.OfType<X509BasicConstraintsExtension>().Any(x => x.CertificateAuthority)) throw new InvalidDataException("信任文件不是 CA 证书");
    }
    public bool Validate(X509Certificate? certificate, SslPolicyErrors errors)
    {
        if (certificate is null || (errors & (SslPolicyErrors.RemoteCertificateNameMismatch | SslPolicyErrors.RemoteCertificateNotAvailable)) != 0) return false;
        using var leaf = X509CertificateLoader.LoadCertificate(certificate.GetRawCertData());
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(root);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck; // Private CA has no CRL service.
        chain.ChainPolicy.ApplicationPolicy.Add(new("1.3.6.1.5.5.7.3.1"));
        return chain.Build(leaf);
    }
    public MqttClientOptions Options(Uri endpoint, Uri web) => new MqttClientOptionsBuilder()
        .WithProtocolVersion(MQTTnet.Formatter.MqttProtocolVersion.V500).WithClientId("").WithCleanSession()
        .WithSessionExpiryInterval(0).WithKeepAlivePeriod(TimeSpan.FromSeconds(10)).WithTimeout(TimeSpan.FromSeconds(5))
        .WithMaximumPacketSize(1048576)
        .WithWebSocketServer(o => o.WithUri(endpoint.AbsoluteUri).WithSubProtocols(["mqtt"])
            .WithRequestHeaders(new Dictionary<string, string> { ["Origin"] = web.GetLeftPart(UriPartial.Authority) }))
        .WithTlsOptions(o => o.WithSslProtocols(SslProtocols.Tls12 | SslProtocols.Tls13)
            .WithCertificateValidationHandler(e => Validate(e.Certificate, e.SslPolicyErrors))).Build();
    public void Dispose() => root.Dispose();
}

/// <summary>One request at a time. PUBACK never counts as a business receipt; unknown writes are never replayed.</summary>
public sealed class R19MqttClient : IDisposable, IAsyncDisposable
{
    private const string Schema = "daty-mqtt6-app-v1", Server = "daty-rf-pro";
    private const string Reply = "daty/v2/daty-rf-pro/app/reply", Request = "daty/v2/daty-rf-pro/app/request";
    private readonly SemaphoreSlim serial = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly R19Tls tls;
    private Session? session;
    private volatile bool disposed;
    private readonly object disposeGate=new();
    private Task? disposeTask;
    public R19Endpoints Endpoints { get; }
    public Uri BaseUri => Endpoints.Web;
    public string? BootId => session?.Boot;
    public R19MqttClient(string origin, string caPath, int mqttPort = 8083)
    { Endpoints = R19Endpoints.FromWebOrigin(origin, mqttPort); tls = new(caPath); }
    internal static bool HexId(string? value) => value is not null && Regex.IsMatch(value, "^[a-f0-9]{32}$", RegexOptions.CultureInvariant);
    private sealed class Session : IDisposable
    {
        public readonly IMqttClient Client = new MqttClientFactory().CreateMqttClient();
        public readonly TaskCompletionSource Hello = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly object Gate = new();
        public string? Id, Boot, PendingId, Method;
        public long Offset;
        public bool Failed;
        private int disposed;
        public TaskCompletionSource<JsonElement>? Pending;
        public void Fail(Exception error)
        { lock (Gate) { Failed = true; Hello.TrySetException(error); Pending?.TrySetException(error); } }
        public void Dispose() { if(Interlocked.Exchange(ref disposed,1)!=0)return;Fail(new R19RpcException("TRANSPORT_CLOSED_QUERY_ONLY")); Client.Dispose(); }
    }
    private async Task<Session> ConnectAsync(CancellationToken token)
    {
        if (session is { Failed: false } ready && ready.Client.IsConnected && ready.Hello.Task.IsCompletedSuccessfully) return ready;
        session?.Dispose();
        var s = new Session(); session = s;
        s.Client.DisconnectedAsync += e => { s.Fail(new R19RpcException("TRANSPORT_LOST_QUERY_ONLY")); return Task.CompletedTask; };
        s.Client.ApplicationMessageReceivedAsync += e =>
        {
            try
            {
                if (e.ApplicationMessage.Topic != Reply || e.ApplicationMessage.Retain || e.ApplicationMessage.Payload.Length > 1024 * 1024) throw new InvalidDataException("INVALID_PUBLICATION");
                using var doc = JsonDocument.Parse(e.ApplicationMessage.Payload);
                var m = doc.RootElement;
                lock (s.Gate)
                {
                    if (s.Failed) return Task.CompletedTask;
                    if (m.Text("schema") != Schema || m.Text("server_id") != Server || m.Text("client_session_id") != s.Id || !HexId(m.Text("boot_id"))) throw new InvalidDataException("WRONG_REPLY_SOURCE");
                    if (m.Text("kind") == "hello")
                    {
                        if (s.Boot is not null || m.Text("active_entry") != "mqtt" || !m.Field("server_time_ms").TryGetInt64(out var now)) throw new InvalidDataException("INVALID_HELLO");
                        s.Boot = m.Text("boot_id"); s.Offset = now - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); s.Hello.TrySetResult();
                    }
                    else
                    {
                        if (s.Boot is null || m.Text("boot_id") != s.Boot || m.Text("kind") != "reply") throw new InvalidDataException("SERVER_BOOT_CHANGED");
                        if (m.Text("request_id") != s.PendingId) return Task.CompletedTask; // Late reply cannot resolve a newer request.
                        if (m.Text("method") != s.Method) throw new InvalidDataException("WRONG_REPLY_METHOD");
                        if (m.Field("ok").ValueKind == JsonValueKind.True) s.Pending?.TrySetResult(m.GetProperty("result").Clone());
                        else s.Pending?.TrySetException(new R19RpcException(m.Text("error") ?? "OUTCOME_UNKNOWN_QUERY_ONLY", (int?)m.Number("status")));
                    }
                }
            }
            catch (Exception error) { s.Fail(error); }
            return Task.CompletedTask;
        };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(6));
        try
        {
            var ack = await s.Client.ConnectAsync(tls.Options(Endpoints.Application, Endpoints.Web), timeout.Token).ConfigureAwait(false);
            if (ack.IsSessionPresent || ack.ResultCode != MqttClientConnectResultCode.Success || !Regex.IsMatch(ack.AssignedClientIdentifier ?? "", "^m6a-[a-f0-9]{32}$")) throw new InvalidDataException("INVALID_SESSION");
            s.Id = ack.AssignedClientIdentifier;
            var sub = await s.Client.SubscribeAsync(new MqttClientSubscribeOptionsBuilder().WithTopicFilter(Reply, MqttQualityOfServiceLevel.AtLeastOnce).Build(), timeout.Token).ConfigureAwait(false);
            if (sub.Items.Count != 1 || (int)sub.Items.Single().ResultCode is not (0 or 1)) throw new InvalidDataException("SUBSCRIBE_FAILED");
            await s.Hello.Task.WaitAsync(timeout.Token).ConfigureAwait(false); return s;
        }
        catch { s.Dispose(); session = null; throw; }
    }
    public async Task<JsonElement> CallAsync(string method, object? body = null, CancellationToken token = default, string? expectedBoot = null)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (!R19Contract.SupportsMethod(method)) throw new ArgumentException("Unsupported r19 method");
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, lifetime.Token);
        await serial.WaitAsync(linked.Token).ConfigureAwait(false);
        Session? s = null;
        try
        {
            ObjectDisposedException.ThrowIf(disposed,this);
            linked.Token.ThrowIfCancellationRequested(); s = await ConnectAsync(linked.Token).ConfigureAwait(false);
            if (expectedBoot is not null && s.Boot != expectedBoot) throw new R19RpcException("SERVER_BOOT_CHANGED");
            var id = Guid.NewGuid().ToString("N");
            var request = new R19Request(Schema, Server, s.Boot!, s.Id!, id, method,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + s.Offset + 10000, JsonSerializer.SerializeToElement(body ?? new { }));
            var bytes = JsonSerializer.SerializeToUtf8Bytes(request);
            if (bytes.Length > 256 * 1024) throw new InvalidDataException("MESSAGE_TOO_LARGE");
            var pending = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (s.Gate) { s.Pending = pending; s.PendingId = id; s.Method = method; }
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(linked.Token); timeout.CancelAfter(TimeSpan.FromSeconds(10));
            await s.Client.PublishAsync(new MqttApplicationMessageBuilder().WithTopic(Request).WithPayload(bytes).WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce).Build(), timeout.Token).ConfigureAwait(false);
            return await pending.Task.WaitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (R19RpcException) { throw; }
        catch { s?.Dispose(); if (ReferenceEquals(session, s)) session = null; throw; }
        finally { if (s is not null) lock (s.Gate) { s.Pending = null; s.PendingId = null; s.Method = null; } serial.Release(); }
    }
    public async Task<DeviceSnapshot> SnapshotAsync(CancellationToken token) => DeviceSnapshot.Parse(await CallAsync("devices.snapshot", token: token));
    public ValueTask DisposeAsync()
    {
        lock(disposeGate)
        {
            disposed=true;
            disposeTask??=Task.Run(async()=>
            {
                await lifetime.CancelAsync().ConfigureAwait(false);
                // Drain the current RPC before releasing its session and certificate.
                await serial.WaitAsync().ConfigureAwait(false);
                try { try{session?.Dispose();}finally{session=null;tls.Dispose();} }
                finally { serial.Release(); }
            });
            return new(disposeTask);
        }
    }
    public void Dispose()
    {
        // Existing retarget/disconnect callers also stay off the UI thread.
        var task=DisposeAsync().AsTask();
        _=task.ContinueWith(t=>System.Diagnostics.Trace.TraceWarning("MQTT cleanup: {0}",t.Exception?.GetBaseException().GetType().Name),CancellationToken.None,TaskContinuationOptions.OnlyOnFaulted,TaskScheduler.Default);
    }
}
