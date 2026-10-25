using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Daty.Native.Core;

internal static class TlsFixture
{
    public static async Task<bool> RequestAsync(string scenario)
    {
        using var rootKey = RSA.Create(2048);
        var caRequest = new CertificateRequest("CN=DATY Native Isolated Test Root", rootKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        caRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        caRequest.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
        using var root = caRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-3), DateTimeOffset.UtcNow.AddDays(3));
        using var key = RSA.Create(2048);
        var leafRequest = new CertificateRequest("CN=DATY Native Fixture", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        leafRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        var san = new SubjectAlternativeNameBuilder();
        san.AddIpAddress(scenario == "wrong-host" ? IPAddress.Parse("127.0.0.2") : IPAddress.Loopback);
        leafRequest.CertificateExtensions.Add(san.Build());
        leafRequest.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1") }, true));
        using var publicLeaf = leafRequest.Create(root, DateTimeOffset.UtcNow.AddDays(-2), scenario == "expired" ? DateTimeOffset.UtcNow.AddDays(-1) : DateTimeOffset.UtcNow.AddDays(1), RandomNumberGenerator.GetBytes(16));
        using var ephemeralCertificate = publicLeaf.CopyWithPrivateKey(key);
        // Windows Schannel requires a provider-backed key for this isolated server.
        // No certificate is installed into a trust store; the temporary key is released on dispose.
        using var certificate = X509CertificateLoader.LoadPkcs12(ephemeralCertificate.Export(X509ContentType.Pfx), null, X509KeyStorageFlags.DefaultKeySet);
        using var otherKey = RSA.Create(2048);
        var otherRequest = new CertificateRequest("CN=Unrelated Isolated Test Root", otherKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        otherRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        using var other = otherRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        var directory = Path.Combine(Path.GetTempPath(), "daty-native-tls-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
        var caPath = Path.Combine(directory, "fixture-public-ca.pem");
        File.WriteAllText(caPath, (scenario == "wrong-ca" ? other : root).ExportCertificatePem());
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        using var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var serve = Task.Run(async () =>
        {
            try
            {
                using var connection = await listener.AcceptTcpClientAsync(cancellation.Token);
                using var tls = new SslStream(connection.GetStream());
                await tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = certificate, ClientCertificateRequired = false }, cancellation.Token);
                var buffer = new byte[8192]; var read = await tls.ReadAsync(buffer, cancellation.Token);
                if (read == 0) return;
                var request = Encoding.ASCII.GetString(buffer, 0, read);
                if (!request.StartsWith("GET /health HTTP/1.1", StringComparison.Ordinal)) throw new InvalidOperationException("Unexpected method or route");
                const string body = "{\"success\":true,\"fixture\":true}";
                var response = $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n{body}";
                await tls.WriteAsync(Encoding.ASCII.GetBytes(response), cancellation.Token);
            }
            catch (Exception error) when (error is IOException or System.Security.Authentication.AuthenticationException or OperationCanceledException) { if (scenario == "valid") Console.WriteLine("Fixture server: " + error); }
        });
        bool accepted;
        try
        {
            using var client = new BridgeClient($"https://127.0.0.1:{port}", caPath);
            var result = await client.GetAsync("/health", cancellation.Token);
            accepted = result.Field("fixture").True();
        }
        catch (Exception error) when (error is System.Net.Http.HttpRequestException or OperationCanceledException) { if (scenario == "valid") Console.WriteLine("Fixture client: " + error); accepted = false; }
        cancellation.Cancel(); listener.Stop(); await serve;
        return accepted;
    }
}
