using System.IO;
using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;
public partial class MainWindow
{
    internal void CheckPluginStateOrderingFixture()
    {
        if(!verification)throw new InvalidOperationException("Isolated fixture required");
        JsonElement Status(int revision,bool installed)=>JsonSerializer.SerializeToElement(new{revision,plugins=installed?new[]{new{id="shure-scp",active=true}}:[]});
        JsonElement Receipt(int revision)=>JsonSerializer.SerializeToElement(new{revision,id="shure-scp",state="installed",activation="active"});
        ApplyPluginStatus(Status(1,false));ShowInstallReceipt(Receipt(2));
        ApplyPluginStatus(Status(1,false));
        if(pluginState!.Value.Number("revision")!=2||pluginState.Value.Field("plugins").GetArrayLength()!=1)throw new Exception("Delayed status overwrote completed installation");
        ApplyPluginStatus(Status(3,false));ShowInstallReceipt(Receipt(2));
        if(pluginState!.Value.Number("revision")!=3||pluginState.Value.Field("plugins").GetArrayLength()!=0)throw new Exception("Historical receipt revived a removed plugin");
        ShowInstallReceipt(Receipt(4));ApplyPluginStatus(Status(4,true));
        if(pluginState!.Value.Number("revision")!=4||pluginState.Value.Field("plugins").GetArrayLength()!=1)throw new Exception("Current installation did not refresh");
    }
}
internal static partial class UiVerification
{
    private static void VerifyPluginStateOrdering(string directory)
    {
        var window=new MainWindow(true);window.CheckPluginStateOrderingFixture();window.Close();
        File.WriteAllText(Path.Combine(directory,"plugin-state-ordering.json"),JsonSerializer.Serialize(new{passed=true,checks=3,networkRequests=0,deviceCommands=0}));
    }
}
