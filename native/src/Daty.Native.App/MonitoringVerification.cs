using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;
public partial class MainWindow
{
    private async Task VerifyMonitoringDatabaseAsync(JsonElement config)
    {
        var checks=new List<string>();
        void Check(bool ok,string text){if(!ok)throw new InvalidDataException(text);checks.Add(text);}
        Check(monitoringRules is not null&&monitoringRevision>0,"Rules came from committed server database");
        if(config.Text("mode")=="monitoring-write")
        {
            var value=JsonNode.Parse(monitoringRules!.Document.GetRawText())!;
            value["overview"]!["labels"]![0]="数据库接收机统计";
            value["identity"]!["groupPrefix"]="DB";value["identity"]!["pageSize"]=1;
            value["frequency"]!["decimals"]=2;
            value["signals"]!["rfDecimals"]=1;
            value["transmitter"]!["offlineBelowDbm"]=-100;value["transmitter"]!["offlineText"]="数据库离线";
            value["alerts"]!["labels"]!["transmitter_offline"]="数据库离线告警";
            await WriteSystemSettingAsync(MonitoringRules.DocumentId,JsonSerializer.SerializeToElement(value));
            var actual=(await ReadRpcAsync("database.resources.get",new{kind="settings",id=MonitoringRules.DocumentId})).Field("resource");
            ApplyMonitoringResource(actual);Check(JsonElement.DeepEquals(actual.Field("value"),monitoringRules!.Document),"Read after actual commit matches rules");
        }
        Check(monitoringRules!.OfflineBelowDbm==-100&&monitoringRules.PageSize==1&&monitoringRules.OverviewLabels[0]=="数据库接收机统计","Database values survive an independent client process");
        var c=Channel.Parse(JsonSerializer.SerializeToElement(new{id="rule-fixture",receiver_id="test",group_number=2,group_source="server-fifo-v1",channel_number=1,brand="DATYaudio",model="test",_source="fashe-mqtt",_online=true,status="online",rf=-95,freq=640000,muted=false}));
        Check(!TransmitterReception.IsOffline(c,monitoringRules),"Database -100 threshold overrides prior -90 source constant");
        var (card,update)=ChannelCard();update(c);card.Measure(new Size(280,300));card.Arrange(new Rect(0,0,280,300));card.UpdateLayout();
        var texts=Descendants<TextBlock>(card).Select(t=>t.Text).ToArray();
        Check(texts.Contains("DB2 · CH1")&&texts.Contains("640.00 MHz")&&texts.Contains("-95.0 dBm"),"Identity and frequency/RF formatting render database rules");
        update(c with{RfDbm=-110});texts=Descendants<TextBlock>(card).Select(t=>t.Text).ToArray();
        Check(texts.Contains("数据库离线")&&!texts.Any(t=>t.EndsWith("dBm"))&&card.ToolTip is null,"Offline label, hidden RF and suppressed alarm use committed categories");
        var saved=resources["settings:"+MonitoringRules.DocumentId];
        try{ApplyMonitoringResource(default);throw new Exception("Missing rules accepted");}catch(InvalidDataException){}
        Check(monitoringRules is null&&alertMonitor.Rules is null,"Missing DB rules have no client fallback");
        ApplyMonitoringResource(saved);
        var reread=(await ReadRpcAsync("database.resources.get",new{kind="settings",id=MonitoringRules.DocumentId})).Field("resource");
        Check(reread.Number("revision")==monitoringRevision,"Reading rules does not create a new revision");
        await File.WriteAllTextAsync(config.GetProperty("output").GetString()!,JsonSerializer.Serialize(new{ok=true,checks,revision=monitoringRevision,value=monitoringRules!.Document,physicalCommands=0,loopbackOnly=true}));
    }
}
