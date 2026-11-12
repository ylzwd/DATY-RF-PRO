using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Daty.Native.Core;

public sealed record ProductIdentity(string Product, string Version, string BuildId, string ContractSchema, int DatabaseSchema)
{
    public static ProductIdentity FromAssembly(Assembly assembly)
    {
        var values=assembly.GetCustomAttributes<AssemblyMetadataAttribute>().ToDictionary(a=>a.Key,a=>a.Value);
        return new("DATY RF PRO",values["ProductVersion"]!,values["ProductBuildId"]!,values["ProductContract"]!,int.Parse(values["ProductDatabaseSchema"]!));
    }
    public void RequireMatch(JsonElement actual)
    {
        if (!Regex.IsMatch(BuildId,"^[a-f0-9]{64}$") || actual.Text("product")!=Product || actual.Text("version")!=Version
            || actual.Text("buildId")!=BuildId || actual.Text("contractSchema")!=ContractSchema || actual.Number("databaseSchema")!=DatabaseSchema)
            throw new InvalidDataException("界面与后台版本或构建批次不一致，请关闭旧窗口后使用同一完整发布包。");
    }
    public void VerifyInstallation(string root)
    {
        using var doc=JsonDocument.Parse(File.ReadAllBytes(Path.Combine(root,"config","product-build.local.json")));
        RequireMatch(doc.RootElement);
    }
}
