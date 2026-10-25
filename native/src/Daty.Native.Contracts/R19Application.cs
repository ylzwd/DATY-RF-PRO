using System.Text.Json;
using System.Text.Json.Serialization;
using System.Collections.Frozen;

namespace Daty.Native.Contracts;

/// <summary>Deployment endpoints only. No network, certificate overrides or fallback.</summary>
public sealed record R19Endpoints(Uri Web, Uri Application, Uri Live)
{
    public static R19Endpoints FromWebOrigin(string origin, int mqttPort = 8083)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || uri.Scheme != "https" ||
            string.IsNullOrEmpty(uri.Host) || uri.UserInfo.Length != 0 || uri.Query.Length != 0 ||
            uri.Fragment.Length != 0 || uri.AbsolutePath != "/" || origin.Contains('\\') || mqttPort is < 1 or > 65535)
            throw new ArgumentException("Use an HTTPS server origin and a valid MQTT TLS port.");
        Uri Socket(string path) => new UriBuilder(uri) { Scheme = "wss", Port = mqttPort, Path = path }.Uri;
        return new(uri, Socket("/mqtt-app"), Socket("/mqtt-readonly"));
    }
}

/// <summary>Names match the r19 wire envelope. Epoch belongs to business DTOs.</summary>
public sealed record R19Request(
    [property: JsonPropertyName("schema")] string Schema,
    [property: JsonPropertyName("server_id")] string ServerId,
    [property: JsonPropertyName("boot_id")] string BootId,
    [property: JsonPropertyName("client_session_id")] string ClientSessionId,
    [property: JsonPropertyName("request_id")] string RequestId,
    [property: JsonPropertyName("method")] string Method,
    [property: JsonPropertyName("deadline_at_ms")] long DeadlineAtMs,
    [property: JsonPropertyName("body")] JsonElement Body);

/// <summary>Implementation is a future isolated MQTT adapter, not the legacy HTTP client.
/// A response must still be checked for scope, actual commit/ACK and unknown outcomes.
/// Implementations must not automatically replay commands or unknown business writes.</summary>
public interface IR19ApplicationTransport : IAsyncDisposable
{
    Task<JsonElement> SendAsync(R19Request request, CancellationToken cancellationToken);
}

public static class R19Contract
{
    private static readonly JsonElement Reference=LoadReference();
    private static readonly FrozenSet<string> Methods=Reference.GetProperty("methods").EnumerateArray()
        .Select(x=>x.GetString()??throw new InvalidDataException("Invalid reviewed method")).ToFrozenSet(StringComparer.Ordinal);
    // Embedded deployment contract is immutable for this process; do not reopen
    // and parse it for every settings read, command or transfer chunk.
    public static JsonElement ReadReference()=>Reference;
    public static bool SupportsMethod(string method)=>Methods.Contains(method);
    private static JsonElement LoadReference()
    {
        using var stream = typeof(R19Contract).Assembly.GetManifestResourceStream("Daty.Native.Contracts.r19-mqtt-app.json")
            ?? throw new InvalidOperationException("Reviewed server contract is missing.");
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.Clone();
    }
}
