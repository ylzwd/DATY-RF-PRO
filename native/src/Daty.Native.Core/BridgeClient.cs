using System.Net;
using System.Net.Http;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace Daty.Native.Core;

public sealed class BridgeClient : IDisposable
{
    private readonly HttpClient client;
    private readonly X509Certificate2? root;
    public Uri BaseUri { get; }
    private static readonly HashSet<string> Routes = ["/health", "/api/devices", "/api/clock", "/api/projects", "/api/timeline", "/api/capabilities", "/api/auth/status"];

    public static Uri ValidateOrigin(string address)
    {
        if (!Uri.TryCreate(address.Trim(), UriKind.Absolute, out var uri) || uri.Scheme != "https" || string.IsNullOrWhiteSpace(uri.Host) ||
            uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.AbsolutePath != "/" || address.Contains('\\'))
            throw new ArgumentException("服务器地址必须为 HTTPS 主机和端口，例如 https://192.0.2.16:8802");
        return new Uri(uri.GetLeftPart(UriPartial.Authority) + "/");
    }

    public BridgeClient(string address, string caPath)
    {
        BaseUri = ValidateOrigin(address);
        var bytes = File.ReadAllBytes(caPath);
        if (bytes.Length > 131072) throw new InvalidDataException("CA 文件超过大小限制");
        root = System.Text.Encoding.ASCII.GetString(bytes).Contains("-----BEGIN CERTIFICATE-----")
            ? X509Certificate2.CreateFromPem(System.Text.Encoding.ASCII.GetString(bytes)) : X509CertificateLoader.LoadCertificate(bytes);
        if (!root.Extensions.OfType<X509BasicConstraintsExtension>().Any(x => x.CertificateAuthority)) throw new InvalidDataException("信任文件必须是本项目公开 CA 证书");
        var handler = new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false, AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate };
        handler.ServerCertificateCustomValidationCallback = (request, certificate, _, errors) =>
        {
            if (request.RequestUri?.Host != BaseUri.Host || certificate == null || (errors & (SslPolicyErrors.RemoteCertificateNameMismatch | SslPolicyErrors.RemoteCertificateNotAvailable)) != 0) return false;
            using var chain = new X509Chain();
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(root);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck; // Private local CA has no public CRL service.
            chain.ChainPolicy.ApplicationPolicy.Add(new("1.3.6.1.5.5.7.3.1"));
            return chain.Build(certificate); // Still validates signatures, chain, validity and server EKU.
        };
        client = Create(handler);
    }

    public BridgeClient(string address, HttpMessageHandler fixtureTransport) { BaseUri = ValidateOrigin(address); client = Create(fixtureTransport); }
    private HttpClient Create(HttpMessageHandler handler)
    {
        var value = new HttpClient(handler) { BaseAddress = BaseUri, Timeout = TimeSpan.FromSeconds(5), MaxResponseContentBufferSize = 8 * 1024 * 1024 };
        value.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        value.DefaultRequestHeaders.UserAgent.ParseAdd("DATY-Native-Readonly/0.1.0");
        return value;
    }

    public async Task<JsonElement> GetAsync(string route, CancellationToken cancellationToken)
    {
        var path = route.Split('?', 2)[0];
        var projectRoute = path.StartsWith("/api/projects/", StringComparison.Ordinal) && !path[14..].Contains('/') && path.Length > 14;
        if ((!Routes.Contains(path) && !projectRoute) || route.Contains("..") || route.Contains('\\') || route.Contains('#')) throw new InvalidOperationException("此版本仅允许明确的只读 Bridge 接口");
        var uri = new Uri(BaseUri, route);
        if (uri.GetLeftPart(UriPartial.Authority) != BaseUri.GetLeftPart(UriPartial.Authority)) throw new InvalidOperationException("已阻止跨服务器请求");
        using var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        if ((int)response.StatusCode is >= 300 and < 400) throw new InvalidDataException("服务器返回重定向，已停止连接");
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"服务器返回 HTTP {(int)response.StatusCode}", null, response.StatusCode);
        if (response.Content.Headers.ContentLength > 8 * 1024 * 1024) throw new InvalidDataException("服务器响应过大");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        await using var input = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
        using var output = new MemoryStream();
        var buffer = new byte[16384];
        while (true)
        {
            var read = await input.ReadAsync(buffer, timeout.Token).ConfigureAwait(false);
            if (read == 0) break;
            if (output.Length + read > 8 * 1024 * 1024) throw new InvalidDataException("服务器响应过大");
            output.Write(buffer, 0, read);
        }
        using var doc = JsonDocument.Parse(output.ToArray(), new JsonDocumentOptions { MaxDepth = 64 });
        if (doc.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException("服务器响应必须是 JSON 对象");
        return doc.RootElement.Clone();
    }

    public async Task<DeviceSnapshot> SnapshotAsync(CancellationToken token) => DeviceSnapshot.Parse(await GetAsync("/api/devices", token));
    public void Dispose() { client.Dispose(); root?.Dispose(); }
}
