using System.Text.Json;
using Daty.Native.Core;

static class ProductIdentityCases
{
    public static IEnumerable<(string Name,Action Run)> All()
    {
        var expected=new ProductIdentity("DATY RF PRO","1.1.0",new string('a',64),"daty-mqtt6-app-v1",3);
        Dictionary<string,object> Values()=>new(){["product"]=expected.Product,["version"]=expected.Version,["buildId"]=expected.BuildId,["contractSchema"]=expected.ContractSchema,["databaseSchema"]=expected.DatabaseSchema};
        yield return ("Product accepts same version and immutable build",()=>expected.RequireMatch(JsonSerializer.SerializeToElement(Values())));
        foreach(var field in Values().Keys)
            yield return ("Product rejects mixed "+field,()=>{
                var values=Values();values[field]="different";
                try { expected.RequireMatch(JsonSerializer.SerializeToElement(values)); }
                catch(InvalidDataException){return;}
                throw new Exception("Mixed product accepted: "+field);
            });
        yield return ("Product rejects old backend without identity",()=>{
            try{expected.RequireMatch(default);}
            catch(InvalidDataException){return;}
            throw new Exception("Missing product identity accepted");
        });
    }
}
