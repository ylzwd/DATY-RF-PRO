using System.Text.Json;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32;

namespace Daty.Native.Core;

// Connection bootstrap only. Business settings remain authoritative in SQLite.
public sealed record ProjectEnvironment(string Root, int WebPort, int MqttPort)
{
    public string InstanceRoot => InstanceDirectory(Root,HostId());
    public string SettingsPath => Path.Combine(InstanceRoot,"config","native.local.json");
    public string CertificatePath => Path.Combine(InstanceRoot,"data","security","root-ca.pem");
    public static string HostId()
    {
        if(!OperatingSystem.IsWindows())throw new PlatformNotSupportedException("Windows 本机身份不可用");
        using var registry=RegistryKey.OpenBaseKey(RegistryHive.LocalMachine,RegistryView.Registry64);
        using var key=registry.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
        var guid=(key?.GetValue("MachineGuid") as string)?.Trim().ToLowerInvariant();
        using var identity=WindowsIdentity.GetCurrent();var sid=identity.User?.Value.ToUpperInvariant();
        if(string.IsNullOrEmpty(guid)||string.IsNullOrEmpty(sid))throw new InvalidDataException("无法确认本机开发身份");
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(guid+"|"+sid))).ToLowerInvariant()[..32];
    }
    public static string InstanceDirectory(string root,string currentHost)
    {
        static bool Valid(string? s)=>s?.Length==32&&s.All(c=>c is >= '0' and <= '9' or >= 'a' and <= 'f');
        if(!Valid(currentHost))throw new InvalidDataException("本机身份无效");
        var file=Path.Combine(root,"config","project-instance.local.json");
        if(File.Exists(file))
        {
            if(new FileInfo(file).Length>4096)throw new InvalidDataException("实例记录过大");
            using var doc=JsonDocument.Parse(File.ReadAllText(file));
            var owner=doc.RootElement.TryGetProperty("host_id",out var value)?value.GetString():null;
            if(!Valid(owner))throw new InvalidDataException("旧实例缺少电脑归属，请使用完整的干净源码开发包");
            if(owner!=currentHost)root=Path.Combine(root,".local-instances",currentHost);
        }
        for(var d=new DirectoryInfo(root);d is not null;d=d.Parent)
            if(d.Exists&&(d.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidDataException("实例路径不能使用目录链接");
        return root;
    }
    public NativeSettings Defaults => new(Server:$"https://127.0.0.1:{WebPort}",MqttPort:MqttPort);
    public static ProjectEnvironment? Current => Discover(AppContext.BaseDirectory,Environment.GetEnvironmentVariable("DATY_PROJECT_ROOT"));
    public static ProjectEnvironment? Discover(string baseDirectory,string? explicitRoot=null)
    {
        var root=explicitRoot;
        if(root is null)
            for(var d=new DirectoryInfo(baseDirectory);d is not null;d=d.Parent)
                if(File.Exists(Path.Combine(d.FullName,"config","project-development.json"))){root=d.FullName;break;}
        if(root is null)return null;
        if(!Path.IsPathFullyQualified(root))throw new InvalidDataException("独立项目根目录必须是绝对路径");
        root=Path.GetFullPath(root);
        for(var d=new DirectoryInfo(root);d is not null;d=d.Parent)
            if(d.Exists && (d.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidDataException("独立项目路径不能使用目录链接");
        var file=Path.Combine(root,"config","project-development.json");
        if(!File.Exists(file)||new FileInfo(file).Length>4096)throw new InvalidDataException("独立项目配置缺失或过大");
        using var doc=JsonDocument.Parse(File.ReadAllText(file));var c=doc.RootElement;
        if(c.GetProperty("schema").GetString()!="daty-standalone-project-v1")throw new InvalidDataException("独立项目配置版本不支持");
        var web=c.GetProperty("web_port").GetInt32();var mqtt=c.GetProperty("mqtt_port").GetInt32();
        if(web is <1024 or >65535 || mqtt is <1024 or >65535 || web==mqtt)throw new InvalidDataException("独立项目端口无效");
        return new(root,web,mqtt);
    }
}
