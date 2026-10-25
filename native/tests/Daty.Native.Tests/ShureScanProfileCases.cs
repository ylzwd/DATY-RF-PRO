using System.Text.Json;
using System.Text.Json.Nodes;
using Daty.Native.Core;

internal static class ShureScanProfileCases
{
    private static Channel Make(string mac="00:0e:dd:ad:31:a3",string? band=null,bool online=true,string model="ULXD4",string[]? stale=null,string source="shure-scp") => Channel.Parse(JsonSerializer.SerializeToElement(new {
        id="fixture_ch1",receiver_id="fixture",receiver_ip="192.0.2.1",receiver_mac=mac,model,brand="Shure",channel_number=1,
        _online=online,status=online?"online":"offline",_source=source,freq=633790,
        shure=new{schema="daty-shure-telemetry-v1",settings=new{receiver_mac=mac,rf_band=band},stale_fields=stale??[]},
        capabilities=new{scan=false,scan_unavailable_reason="SCAN_HARDWARE_PROFILE_REQUIRED"}
    }));
    private static void Check(bool value){if(!value)throw new Exception("Scan profile assertion failed");}
    private static void Reject(Action action){try{action();}catch(InvalidDataException){return;}throw new Exception("Expected rejection");}
    private static JsonElement Resource(JsonElement value,int revision=1,bool deleted=false,string id="shure_scan_profiles") => JsonSerializer.SerializeToElement(new{kind="settings",id,revision,deleted,value});
    public static IEnumerable<(string Name,Action Run)> All()
    {
        yield return ("Scan profile requires an explicit current ULXD4 chassis label",()=>{
            var receiver=Make();Check(ShureScanProfiles.NeedsConfirmation(receiver));
            Reject(()=>ShureScanProfiles.ConfirmLabel(default,receiver,false,"fixture"));
            foreach(var invalid in new[]{Make(mac:"bad"),Make(online:false),Make(model:"ULXD4D"),Make(band:"G50"),Make(source:"fashe-mqtt"),Make(stale:["settings.receiver_mac"]),Make(stale:["settings.rf_band"])}) {
                Check(!ShureScanProfiles.NeedsConfirmation(invalid));Reject(()=>ShureScanProfiles.ConfirmLabel(default,invalid,true,"fixture"));
            }
        });
        yield return ("Scan profile binds MAC and exact verified range without IP or RF inference",()=>{
            var value=ShureScanProfiles.ConfirmLabel(default,Make(),true,"fixture:1");var row=value.Field("receivers")[0];
            Check(value.Text("schema")==ShureScanProfiles.Schema&&row.Text("receiver_mac")=="00:0E:DD:AD:31:A3"&&row.Text("model")=="ULXD4"&&row.Text("band")=="L51");
            Check(row.Text("source")=="user-confirmed-chassis-label"&&row.Text("evidence_id")=="fixture:1"&&row.Field("receiver_ip").ValueKind==JsonValueKind.Undefined);
            Check(row.Field("scan_range_khz").Number("start_khz")==632125&&row.Field("scan_range_khz").Number("end_khz")==695875&&row.Field("scan_range_khz").Number("step_khz")==25);
            Reject(()=>ShureScanProfiles.ConfirmLabel(default,Make(),true,""));
        });
        yield return ("Scan profile replaces only matching MAC and preserves other chassis across reconnect",()=>{
            var first=ShureScanProfiles.ConfirmLabel(default,Make(),true,"first");var original=first.GetRawText();
            var other=ShureScanProfiles.ConfirmLabel(first,Make(mac:"00:0E:DD:AD:31:A4"),true,"second");
            var updated=ShureScanProfiles.ConfirmLabel(other,Make(),true,"replacement");var rows=updated.Field("receivers").EnumerateArray().ToArray();
            Check(first.GetRawText()==original&&rows.Length==2&&rows.Count(r=>r.Text("receiver_mac")=="00:0E:DD:AD:31:A3")==1&&rows.Single(r=>r.Text("receiver_mac")=="00:0E:DD:AD:31:A4").Text("evidence_id")=="second");
        });
        yield return ("Scan profile rejects malformed prior records without destructive replacement",()=>{
            var bad=JsonSerializer.SerializeToElement(new{schema="wrong",receivers=Array.Empty<object>()});var original=bad.GetRawText();
            Reject(()=>ShureScanProfiles.ConfirmLabel(bad,Make(),true,"fixture"));Check(original==bad.GetRawText());
        });
        yield return ("Scan profile verifies exact committed revision and independent readback",()=>{
            var value=ShureScanProfiles.ConfirmLabel(default,Make(),true,"fixture");ShureScanProfiles.VerifySaved(Resource(value),value,1);
            var changed=ShureScanProfiles.ConfirmLabel(value,Make(),true,"changed");
            foreach(var wrong in new[]{Resource(value,2),Resource(value,deleted:true),Resource(value,id:"other"),Resource(changed)})Reject(()=>ShureScanProfiles.VerifySaved(wrong,value,1));
        });
    }
}
