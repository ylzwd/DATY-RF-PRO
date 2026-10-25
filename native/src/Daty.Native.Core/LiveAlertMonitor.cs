using System.Text.Json;

namespace Daty.Native.Core;

public sealed record AlertEpisode(string ArchiveId,LiveIssue Issue,Channel Channel,long FirstSeen,long LastSeen,long ChangedAt,long? EndedAt=null,bool Pending=false)
{
    public JsonElement Document=>JsonSerializer.SerializeToElement(new{archiveId=ArchiveId,id=Issue.Key,key=Issue.Key,source="threshold-monitor",deviceId=Channel.Id,channelId=Channel.Id,receiverId=Channel.ReceiverId,receiverIP=Channel.Ip,receiverMAC=Channel.Raw.Text("receiver_mac"),channel=Channel.ChannelLabel,groupNumber=Channel.ActualGroupNumber,receiverBrand=Channel.Brand,receiverModel=Channel.Model,metric=Issue.Metric,level=Issue.Level,msg=Issue.Message,value=Issue.Value,threshold=Issue.Threshold,firstSeen=FirstSeen,lastSeen=LastSeen,ts=ChangedAt,archiveState=EndedAt.HasValue?"ended":"active",endedAt=EndedAt});
}

// UI rendering may be coalesced; incoming lifecycle edges must never be.
// Only acknowledged database writes remove queued archive versions.
public sealed class LiveAlertMonitor
{
    private readonly bool archiveEnabled;
    public LiveAlertMonitor(bool archiveEnabled=true,MonitoringRules? rules=null){this.archiveEnabled=archiveEnabled;Rules=rules;}
    public MonitoringRules? Rules { get; set; }
    public int ClearDisplay(IEnumerable<AlertEpisode> selected){int count=0;foreach(var item in selected)if(active.TryGetValue(item.Issue.Key,out var current)&&current==item){active.Remove(item.Issue.Key);archive.Remove(item.ArchiveId);count++;}if(count>0)Revision++;return count;}
    private readonly Dictionary<string,AlertEpisode> active=[];
    private readonly Dictionary<string,AlertEpisode> archive=[];
    public long Revision { get; private set; }
    public IReadOnlyList<AlertEpisode> Active=>active.Values.ToArray();
    public IReadOnlyList<AlertEpisode> PendingArchives=>archive.Values.ToArray();
    public void Reset(){active.Clear();archive.Clear();Revision++;}
    public string Serialize()=>JsonSerializer.Serialize(new{version=1,active=Active,pending=PendingArchives});
    public void Restore(string json)
    {
        using var document=JsonDocument.Parse(json);var root=document.RootElement;
        if(root.Number("version")!=1)throw new InvalidDataException("未知告警本地存储格式");
        var restoredActive=root.GetProperty("active").Deserialize<AlertEpisode[]>()??[];
        var restoredPending=root.GetProperty("pending").Deserialize<AlertEpisode[]>()??[];
        if(restoredActive.Length+restoredPending.Length>200000)throw new InvalidDataException("告警本地记录超过上限");
        foreach(var r in restoredActive.Concat(restoredPending))if(string.IsNullOrEmpty(r.ArchiveId)||r.LastSeen<r.FirstSeen||r.Channel.Raw.ValueKind!=JsonValueKind.Object)throw new InvalidDataException("告警本地记录损坏");
        Reset();foreach(var r in restoredActive)active.Add(r.Issue.Key,r);foreach(var r in restoredPending)archive.Add(r.ArchiveId,r);
    }
    public int Observe(IReadOnlyList<Channel> channels,AlertThresholds thresholds,long timestamp)
    {
        if(Rules is null)return 0;
        var before=archive.Values.ToArray();
        var expected=new Dictionary<string,(LiveIssue Issue,Channel Channel,bool Pending)>();
        foreach(var c in channels){foreach(var issue in LiveIssues.Evaluate(c,thresholds,Rules))expected[issue.Key]=(issue,c,false);
            foreach(var old in active.Values.Where(a=>a.Channel.Id==c.Id))if(!Rules.SuppressOfflineAlert(c,old.Issue.Metric)&&!expected.ContainsKey(old.Issue.Key)&&(old.Issue.Metric=="transmitter_offline" ? TransmitterReception.CurrentRf(c) is null : DisplayRules.IsShure(c.Raw)&&UnknownVendor(c,old.Issue.Metric)))expected[old.Issue.Key]=(old.Issue with{Message=old.Issue.Message.Replace(Rules.Text("alerts","pendingText"),"")+Rules.Text("alerts","pendingText")},c,true);
        }
        foreach(var old in active.Values.Where(a=>!expected.ContainsKey(a.Issue.Key)).ToArray()){var ended=old with{LastSeen=Math.Max(timestamp,old.LastSeen),EndedAt=Math.Max(timestamp,old.FirstSeen)};archive[old.ArchiveId]=ended;active.Remove(old.Issue.Key);}
        int added=0;foreach(var (key,value) in expected){if(active.TryGetValue(key,out var old)){var changed=old.Issue!=value.Issue||old.Channel.Group!=value.Channel.Group||old.Channel.Ip!=value.Channel.Ip;var next=old with{Issue=value.Issue,Channel=value.Channel,LastSeen=Math.Max(old.LastSeen,timestamp),ChangedAt=changed?timestamp:old.ChangedAt,Pending=value.Pending};active[key]=next;if(changed)archive[next.ArchiveId]=next;}
            else{var next=new AlertEpisode("native-"+Guid.NewGuid().ToString("N"),value.Issue,value.Channel,timestamp,timestamp,timestamp,Pending:value.Pending);active[key]=next;archive[next.ArchiveId]=next;if(!value.Pending)added++;}}
        if(added>0||!before.SequenceEqual(archive.Values))Revision++;
        if(!archiveEnabled)archive.Clear();
        return added;
    }
    private static bool UnknownVendor(Channel c,string metric)
    {
        var s=c.Raw.Field("shure");bool Fresh(string key)=>c.Online&&DisplayRules.Fresh(c.Raw,key);
        var percent=Fresh("battery_percent")&&c.Battery.HasValue;var bars=Fresh("battery_bars")&&s.Number("battery_bars") is double b&&Math.Truncate(b)==b&&b>=0&&b<=5;
        if(metric=="battery")return !percent&&!bars;if(metric=="battery_bars")return !percent&&!bars;
        var field=metric switch{"battery_error"=>"battery_runtime_status","rf_interference"=>"interference","rf_interference_secondary"=>"interference_secondary","encryption_mismatch"=>"encryption_warning","unregistered_transmitter"=>"unregistered_transmitter",_=>null};if(field is null)return false;
        var known=metric switch{"battery_error"=>new[]{"error","known","calculating"},"rf_interference"=>["CRITICAL","DETECTED","NONE"],"rf_interference_secondary"=>["DETECTED","NONE"],"encryption_mismatch"=>["ON","ERROR","OFF","OK"],_=>["ERROR","OK"]};return !Fresh(field)||!known.Contains(s.Text(field));
    }
    public void QueueCurrent(IEnumerable<AlertEpisode> records){foreach(var record in records)archive[record.ArchiveId]=record;Revision++;}
    public void Acknowledge(AlertEpisode saved){if(archive.TryGetValue(saved.ArchiveId,out var pending)&&pending==saved){archive.Remove(saved.ArchiveId);Revision++;}}
    public int ClearConfirmed(IEnumerable<AlertEpisode> selected){int count=0;foreach(var record in selected)if(active.TryGetValue(record.Issue.Key,out var now)&&now==record&&!archive.ContainsKey(record.ArchiveId)){active.Remove(record.Issue.Key);count++;}if(count>0)Revision++;return count;}
}
