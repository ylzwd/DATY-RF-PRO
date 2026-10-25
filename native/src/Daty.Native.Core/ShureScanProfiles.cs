using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Daty.Native.Core;

// Explicit chassis-label evidence. Never infer a hardware band from IP or tuned RF.
public static class ShureScanProfiles
{
    public const string DocumentId = "shure_scan_profiles";
    public const string Schema = "daty-shure-scan-profiles-v1";
    public static string? ReceiverMac(Channel receiver)
    {
        if(!DisplayRules.Fresh(receiver.Raw,"settings.receiver_mac"))return null;
        var value=receiver.Raw.Text("receiver_mac")??receiver.Raw.Field("shure").Field("settings").Text("receiver_mac");
        return value is not null&&Regex.IsMatch(value,@"\A(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\z")?value.ToUpperInvariant():null;
    }
    public static bool NeedsConfirmation(Channel receiver) => receiver.Online&&DisplayRules.IsShure(receiver.Raw)
        &&receiver.Model=="ULXD4"&&ReceiverMac(receiver) is not null&&DisplayRules.Fresh(receiver.Raw,"settings.rf_band")
        &&receiver.Raw.Field("shure").Field("settings").Text("rf_band") is null or "" or "L51"
        &&receiver.Raw.Field("capabilities").Text("scan_unavailable_reason")=="SCAN_HARDWARE_PROFILE_REQUIRED";
    public static JsonElement ConfirmLabel(JsonElement previous,Channel receiver,bool confirmed,string evidenceId)
    {
        if(!confirmed)throw new InvalidDataException("请先核对该接收机的机身频段标签");
        var mac=ReceiverMac(receiver);
        if(!receiver.Online||!DisplayRules.IsShure(receiver.Raw)||receiver.Model!="ULXD4"||mac is null)
            throw new InvalidDataException("没有可绑定的在线 ULXD4 机身身份");
        var reported=receiver.Raw.Field("shure").Field("settings").Text("rf_band");
        if(!DisplayRules.Fresh(receiver.Raw,"settings.rf_band"))throw new InvalidDataException("接收机频段资料已过期，请等待重新读取");
        if(!string.IsNullOrEmpty(reported)&&reported!="L51")throw new InvalidDataException("接收机报告的频段与 L51 不一致");
        if(!Regex.IsMatch(evidenceId,@"\A[A-Za-z0-9_.:-]{1,160}\z"))throw new InvalidDataException("频段确认记录标识无效");
        JsonObject document;
        if(previous.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
            document=new JsonObject{["schema"]=Schema,["receivers"]=new JsonArray()};
        else {
            if(previous.Text("schema")!=Schema||previous.Field("receivers").ValueKind!=JsonValueKind.Array)
                throw new InvalidDataException("服务器已有扫描频段资料无效，未覆盖原记录");
            document=JsonNode.Parse(previous.GetRawText())!.AsObject();
        }
        var rows=document["receivers"]!.AsArray();
        for(var i=rows.Count-1;i>=0;i--)
            if(rows[i]?["receiver_mac"]?.GetValue<string>()==mac)rows.RemoveAt(i);
        rows.Add(JsonSerializer.SerializeToNode(new{receiver_mac=mac,model="ULXD4",band="L51",source="user-confirmed-chassis-label",
            scan_range_khz=new{start_khz=632125,end_khz=695875,step_khz=25},evidence_id=evidenceId}));
        if(rows.Count>128)throw new InvalidDataException("机身扫描频段资料最多保存 128 台");
        return JsonSerializer.SerializeToElement(document);
    }
    public static void VerifySaved(JsonElement resource,JsonElement expected,int expectedRevision)
    {
        if(resource.Text("kind")!="settings"||resource.Text("id")!=DocumentId||resource.Field("deleted").True()
            ||resource.Number("revision")!=expectedRevision||!JsonElement.DeepEquals(resource.Field("value"),expected))
            throw new InvalidDataException("扫描频段保存回执或数据库读回不匹配");
    }
}
