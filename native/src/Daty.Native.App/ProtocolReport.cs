using System.Text.Json;
using Daty.Native.Core;

namespace Daty.Native.App;

// Read-only projection of the selected channel's existing MQTT DTO. Raw SCP
// capture statistics are not part of that DTO; a stream sequence is not a count.
internal sealed record ProtocolReportRow(string Label,string Value,string Detail);
internal static class ProtocolReport
{
    internal static readonly string[] Labels=["接收 / 发射","频率 / RF / AF","电池","输出静音","采集窗口","原始数据量","报告字段数","数据新鲜度"];
    internal static ProtocolReportRow[] Read(Channel c,MonitoringRules? rules)
    {
        var shure=DisplayRules.IsShure(c.Raw);var s=c.Raw.Field("shure");
        var unknown=rules?.Text("signals","unknownText")??"等待数据库规则";
        var stale=rules?.Text("signals","staleText")??"等待数据库规则";
        var status=TransmitterDisplay.For(c,rules);
        var txModel=s.Text("transmitter_type")?.Trim();
        var txCurrent=shure&&rules is not null&&!string.IsNullOrWhiteSpace(txModel)&&status.Label==rules.Text("transmitter","modelPrefix")+txModel;
        string Field(string key,string? value,bool tx=false)=>!c.Online||tx&&!txCurrent?"当前不可用":!DisplayRules.Fresh(c.Raw,key)?stale:string.IsNullOrWhiteSpace(value)?"未上报":value;
        string Metric(string key,string unit,double min,double max)=>Field(key,Wire.Format(s.Metric(key,min,max),"0.#",unit) is string text&&text!="—"?text:null,true);
        string Format(double? n,string category,string decimals,string unit)=>rules?.Format(n,category,decimals,unit)??unknown;
        var rxFirmware=Field("receiver_firmware",shure?s.Text("receiver_firmware"):c.Raw.Text("receiver_firmware"));
        var tx=shure?(txCurrent?txModel!:string.IsNullOrWhiteSpace(status.Label)?unknown:status.Label):"未上报";
        var txFirmware=shure?Field("transmitter_firmware",s.Text("transmitter_firmware"),true):"未上报";
        var identity=$"接收机：{c.Brand} {c.Model}\n接收机固件：{rxFirmware}\n发射机：{tx}\n发射机固件：{txFirmware}\n接收机标签：{c.Raw.Text("receiver_name")??"未上报"}\nIP：{c.Ip}\n通道：{rules?.Identity(c)??c.Group+" · "+c.ChannelLabel}";
        if(shure)identity+="\n发射机标签："+Field("transmitter_name",s.Text("transmitter_name"),true)+"\n发射机静音："+Field("transmitter_muted",s.Field("transmitter_muted").ValueKind switch{JsonValueKind.True=>"已静音",JsonValueKind.False=>"未静音",_=>null},true);
        var frequency=DisplayRules.Fresh(c.Raw,"frequency_khz")?Format(c.FrequencyKHz/1000d,"frequency","decimals","unit"):stale;
        var rf=Format(TransmitterReception.CardRf(c,rules),"signals","rfDecimals","rfUnit");
        var af=Format(c.Online&&!TransmitterReception.IsOffline(c,rules)&&DisplayRules.Fresh(c.Raw,"audio_dbfs")?c.AfDbfs:null,"signals","afDecimals","afUnit");
        var levels=$"频率：{frequency}\nRF：{rf}\nAF：{af}";
        if(shure)levels+=$"\n电平流状态：{s.Text("meter_state")??"未提供"}\n采样周期：{Wire.Format(s.Metric("meter_interval_ms",1,60000),"0"," ms")}\n最新电平：{Wire.LocalTime(s.Number("meter_received_at_ms")/1000d)}（本机时间）";
        var battery=rules is null?unknown:shure&&!txCurrent?"当前不可用":rules.Battery(c);
        var batteryDetails=shure?string.Join("\n",new[]{"格数："+Metric("battery_bars","/5 格",0,5),"百分比："+Metric("battery_percent","%",0,100),"剩余时间："+Metric("battery_minutes"," 分钟",0,65532),"时间状态："+Field("battery_runtime_status",s.Text("battery_runtime_status"),true),"健康度："+Metric("battery_health_percent","%",0,100),"循环次数："+Metric("battery_cycles"," 次",0,65534),"温度："+Metric("battery_temperature_c"," °C",-100,200)}):"百分比："+battery+"\n格数、剩余时间、健康度、循环次数、温度：当前接口未提供";
        // Canonical muted can be a transmitter/channel mute for other brands.
        // Only the explicitly mapped receiver output field establishes this row.
        var muteField=shure?s.Field("receiver_muted"):c.Raw.Field("receiver_muted");
        var output=!c.Online?"当前不可用":!DisplayRules.Fresh(c.Raw,"muted")?stale:muteField.ValueKind switch{JsonValueKind.True=>"已静音",JsonValueKind.False=>"未静音",_=>"未提供输出状态"};
        var outputDetails="接收机输出："+output+"\n与发射机静音独立，不能根据 AF 电平判断。"+(shure?"\nAUDIO_MUTE："+(muteField.ValueKind==JsonValueKind.True?"ON":muteField.ValueKind==JsonValueKind.False?"OFF":"未知")+(DisplayRules.Fresh(c.Raw,"muted")?"":"（已过期）"):"\n当前通道静音："+c.MuteLabel);
        var fields=s.Field("stale_fields");var hasFreshness=shure&&fields.ValueKind==JsonValueKind.Array;
        var old=hasFreshness?fields.EnumerateArray().Select(e=>e.Text()).Where(t=>!string.IsNullOrWhiteSpace(t)).ToArray():[];
        var check=hasFreshness?(old.Length==0?"无陈旧字段":old.Length+" 项陈旧"):"未提供字段状态";
        var cross=$"服务器连接状态：{c.OnlineLabel}\n服务器时间：{Wire.LocalTime(c.Raw.Number("server_time_ms")/1000d)}（本机时间）\n上报年龄：{Wire.Format(c.Raw.Metric("_age_s",0,double.MaxValue),"0.#"," 秒")}\n陈旧字段：{(hasFreshness?old.Length==0?"无":string.Join("、",old):"未提供")}\n当前界面读取统一 MQTT 数据，不是独立原始 SCP 抓包核对；快照次数未统计。";
        string NumberOnly(string text,string category,string key){var unit=rules?.Text(category,key);var suffix=" "+unit;return !string.IsNullOrEmpty(unit)&&text.EndsWith(suffix,StringComparison.Ordinal)?text[..^suffix.Length]:text;}
        var compactLevels=NumberOnly(frequency,"frequency","unit")+" / "+NumberOnly(rf,"signals","rfUnit")+" / "+NumberOnly(af,"signals","afUnit");
        return [new(Labels[0],c.Model+" / "+tx,identity),new(Labels[1],compactLevels,levels),new(Labels[2],battery,batteryDetails),new(Labels[3],output=="未提供输出状态"?"未提供":output,outputDetails),new(Labels[4],"未提供","当前为连续遥测，没有本次抓包起止时间或持续时长。\n"+levels),new(Labels[5],"未提供","当前 MQTT 接口没有原始 REP、SAMPLE 帧数和字节量；meter_seq 是流内序号，不能当作抓包总帧数。"),new(Labels[6],"未提供","当前接口未提供原始 REP 名称去重统计；标准化 DTO 属性数不能替代协议报告字段数。"),new(Labels[7],check=="未提供字段状态"?"未提供":check,cross)];
    }
}
