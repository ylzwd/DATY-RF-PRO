using System.Text.Json;
using Daty.Native.Core;

internal static class RfOfflineCases
{
    private static Channel Make(object? rf=null, bool shure=true, bool online=true, string meter="live", string[]? stale=null)
        => Channel.Parse(JsonSerializer.SerializeToElement(new {
            id="rf-test",receiver_id="rx",channel_number=1,brand=shure?"Shure":"DATYaudio",model=shure?"ULXD4":"RF PRO",
            rf,_source=shure?"shure-scp":"fashe-mqtt",_online=online,status=online?"online":"offline",
            shure=new{schema="daty-shure-telemetry-v1",meter_state=meter,rf_antenna="AX",transmitter_type="ULXD2",stale_fields=stale??[]}
        }));
    private static void Check(bool b){if(!b)throw new Exception("RF offline rule failed");}
    public static IEnumerable<(string Name,Action Run)> All()
    {
        yield return ("Database display precision preserves original midpoint rounding",()=>{
            var rules=TestMonitoringRules.Value;
            Check(rules.Battery(Make(-60,false) with{Battery=74.5})=="75%");
            Check(rules.Format(-60.5,"signals","rfDecimals","rfUnit")=="-61 dBm");
            Check(rules.Format(640,"frequency","decimals","unit")=="640.000 MHz");
        });
        yield return ("Strict RF boundary applies across brands and preserves raw measurements",()=>{
            foreach(var shure in new[]{true,false}) foreach(var rf in new[]{-150d,-100,-90.001,-90,-89.99,-30}) {
                var c=Make(rf,shure);var raw=c.Raw.GetRawText();bool off=rf < -90;
                Check(TestMonitoringRules.Offline(c)==off);
                Check(TestMonitoringRules.CardRf(c)==(off?null:rf));
                Check(c.RfDbm==rf&&c.Online&&raw==c.Raw.GetRawText());
                var issues=TestMonitoringRules.Issues(c,new(Rf:-55));
                Check(issues.All(i=>i.Metric!="transmitter_offline"));
                Check(!off||issues.All(i=>i.Metric!="rf"));
            }
        });
        yield return ("Missing invalid stale or disconnected RF cannot infer offline or recovery",()=>{
            foreach(var shure in new[]{true,false})foreach(var rf in new object?[]{null,"bad","NaN","Infinity",-151,21,true}) {
                var c=Make(rf,shure);Check(TransmitterReception.CurrentRf(c) is null&&!TestMonitoringRules.Offline(c));
            }
            foreach(var c in new[]{Make(-95,online:false),Make(-95,meter:"stale"),Make(-95,stale:["rf_dbm"]),Make(-95) with{Online=false}})
                Check(TransmitterReception.CurrentRf(c) is null&&!TestMonitoringRules.Offline(c));
        });
        yield return ("Offline is silent while real weak-signal recovery and retrigger stay distinct",()=>{
            foreach(var shure in new[]{true,false}) {
                var m=new LiveAlertMonitor(rules:TestMonitoringRules.Value);var t=new AlertThresholds(Rf:-60);
                Check(m.Observe([Make(-75,shure)],t,1000)==1);var first=m.Active.Single();m.Acknowledge(first);
                Check(m.Observe([Make(-75,shure)],t,1100)==0);
                Check(m.Active.Single().ArchiveId==first.ArchiveId&&m.Active.Single().ChangedAt==1000&&m.Active.Single().LastSeen==1100&&m.PendingArchives.Count==0);
                m.Observe([Make(-95,shure)],t,1200);Check(m.Active.Count==0&&m.PendingArchives.Single().EndedAt==1200);
                Check(m.Observe([Make(-110,shure)],t,1250)==0&&m.Active.Count==0);
                Check(m.Observe([Make(-75,shure)],t,1300)==1&&m.Active.Single().ArchiveId!=first.ArchiveId&&m.PendingArchives.Count==2);
            }
        });
        yield return ("Offline and unknown samples do not synthesize alarm episodes",()=>{
            foreach(var shure in new[]{true,false}) {
                var m=new LiveAlertMonitor(archiveEnabled:false,rules:TestMonitoringRules.Value);var t=new AlertThresholds();Check(m.Observe([Make(-95,shure)],t,1000)==0);
                foreach(var c in new[]{Make(null,shure),Make(-95,shure,online:false)}) {
                    Check(m.Observe([c],t,1100)==0&&m.Active.Count==0);
                }
                Check(m.Observe([Make(-96,shure)],t,1200)==0&&m.Active.Count==0);
                m.Observe([Make(-89,shure)],t,1300);Check(m.Active.Count==0&&m.PendingArchives.Count==0);
            }
        });
        yield return ("Shure stale RF cannot restore a cached transmitter model",()=>{
            foreach(var c in new[]{Make(-30,meter:"stale"),Make(-30,stale:["rf_dbm"])})Check(TestMonitoringRules.Display(c).Label=="话筒状态未知"&&TestMonitoringRules.CardRf(c) is null);
        });
    }
}
