using System.IO;
using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private async Task<JsonElement?> OptionalResourceAsync(string kind,string id)
    {
        try
        {
            var resource=(await ReadRpcAsync("database.resources.get",new{kind,id})).Field("resource");
            resources[kind+":"+id]=resource;
            return resource.Field("deleted").True()?null:resource;
        }
        catch(R19RpcException e)when(e.Code=="RESOURCE_NOT_FOUND"){return null;}
    }

    private async Task LoadCalculationResourcesAsync()
    {
        var profileRecords=await ReadAllResourcesAsync("profiles");
        var values=JsonSerializer.SerializeToElement(profileRecords.Where(r=>r.Field("value").Text("source")!="planning-snapshot").Select(r=>r.Field("value")));
        CoordinationEngine.ValidateProfiles(values,connection.Token);customProfiles=values;
        foreach(var record in profileRecords)resources["profiles:"+record.Text("id")]=record;
    }

    private async Task SaveProfilesAsync(JsonElement values)
    {
        CoordinationEngine.ValidateProfiles(values,connection.Token);
        var writes=new List<object>();
        foreach(var value in values.EnumerateArray())
        {
            var id=value.GetProperty("id").GetString()!;
            var existing=await OptionalResourceAsync("profiles",id);
            writes.Add(new{kind="profiles",id,expected_revision=(int)(existing?.Number("revision")??0),value});
        }
        if(writes.Count==0)throw new InvalidDataException("Profile 文件没有可导入的条目");
        var result=await WriteBusinessAsync("database.batch",new(){{"writes",writes}});
        if(Array(result,"resources").Length!=writes.Count)throw new InvalidDataException("Profile 保存回执数量不匹配");
        await LoadCalculationResourcesAsync();
    }
}
