using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace Daty.Native.Core;

public sealed record RuntimeHealth(bool Installed,bool Ready,string Message);

/// <summary>Data-driven local prerequisite check. No brand-specific service is loaded
/// by the host until the user selects a trusted bundle and the server approves its plugin.</summary>
public static class LocalRuntimeDependency
{
    public static bool IsLocalServer(Uri origin)=>IPAddress.TryParse(origin.Host,out var ip)&&(IPAddress.IsLoopback(ip)||NetworkInterface.GetAllNetworkInterfaces().SelectMany(n=>n.GetIPProperties().UnicastAddresses).Any(a=>a.Address.Equals(ip)));
    public static void ValidateProbe(RuntimeProbe probe)
    {
        if(!Uri.TryCreate(probe.Uri,UriKind.Absolute,out var uri)||uri.Scheme!="https"||!IPAddress.TryParse(uri.Host,out var ip)||!IPAddress.IsLoopback(ip)||uri.UserInfo!=""||uri.Fragment!=""||probe.Header!="x-api-key")throw new InvalidDataException("依赖健康检查必须使用本机 HTTPS");
        foreach(var path in new[]{probe.Certificate,probe.CredentialFile})if(!Path.IsPathFullyQualified(path)||!Path.GetFullPath(path).StartsWith(Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData))+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("依赖凭据位置不合法");
    }
    public static async Task<RuntimeHealth> CheckAsync(RuntimeProbe probe,CancellationToken token)
    {
        ValidateProbe(probe);
        bool cert=File.Exists(probe.Certificate),credential=File.Exists(probe.CredentialFile);
        if(!cert&&!credential)return new(false,false,"依赖尚未安装");
        if(!cert||!credential)return new(true,false,"依赖已存在，但本机证书或认证配置不完整");
        try
        {
            using var root=X509CertificateLoader.LoadCertificate(await LocalFiles.ReadBoundedAsync(probe.Certificate,65536,token));
            var key=System.Text.Encoding.UTF8.GetString(await LocalFiles.ReadBoundedAsync(probe.CredentialFile,8192,token)).Trim('\uFEFF',' ','\r','\n','\t');
            if(key.Length is <1 or >4096||key.Contains('\r')||key.Contains('\n'))return new(true,false,"依赖认证配置无效");
            using var handler=new HttpClientHandler{UseProxy=false,AllowAutoRedirect=false};
            handler.ServerCertificateCustomValidationCallback=(_,certificate,_,errors)=>
            {
                if(certificate is null||(errors&~SslPolicyErrors.RemoteCertificateChainErrors)!=SslPolicyErrors.None)return false;
                using var chain=new X509Chain();chain.ChainPolicy.TrustMode=X509ChainTrustMode.CustomRootTrust;chain.ChainPolicy.CustomTrustStore.Add(root);chain.ChainPolicy.RevocationMode=X509RevocationMode.NoCheck;
                return chain.Build(certificate);
            };
            using var deadline=CancellationTokenSource.CreateLinkedTokenSource(token);deadline.CancelAfter(TimeSpan.FromSeconds(4));var requestToken=deadline.Token;
            using var client=new HttpClient(handler){Timeout=TimeSpan.FromSeconds(4)};
            using var request=new HttpRequestMessage(HttpMethod.Get,probe.Uri);request.Headers.Add(probe.Header,key);
            using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,requestToken);
            if(response.StatusCode!=HttpStatusCode.OK)return new(true,false,"依赖接口未就绪（HTTP "+(int)response.StatusCode+"）");
            await using var input=await response.Content.ReadAsStreamAsync(requestToken);using var body=new MemoryStream();var buffer=new byte[4096];
            for(int n;(n=await input.ReadAsync(buffer,requestToken))!=0;){if(body.Length+n>1048576)return new(true,false,"依赖响应过大");body.Write(buffer,0,n);}
            using var json=JsonDocument.Parse(body.ToArray());
            return json.RootElement.ValueKind==JsonValueKind.Object?new(true,true,"依赖已连接"):new(true,false,"依赖响应无效");
        }
        catch(OperationCanceledException) when(token.IsCancellationRequested){throw;}
        catch{return new(true,false,"依赖服务未连接，或本机 TLS／认证核验失败");}
    }
}
