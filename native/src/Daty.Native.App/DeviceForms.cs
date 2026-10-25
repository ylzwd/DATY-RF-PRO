using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private Channel[] manualChannels=[];
    private readonly ConfirmedMuteView confirmedMute = new();
    private IReadOnlyList<Channel> ViewChannels=>ChannelOrder.Sort(live.DisplayChannels.Concat(manualChannels).DistinctBy(c=>c.Id).Select(c=>confirmedMute.Apply(c,Environment.TickCount64)));
    private async Task LoadManualChannelsAsync()
    {
        var records=await ReadAllResourcesAsync("manual_devices");manualChannels=records.Select(r=>{
            var v=r.Field("value");return Channel.Parse(JsonSerializer.SerializeToElement(new{id="manual:"+r.Text("id"),receiver_id="manual:"+r.Text("id"),brand=v.Text("brand"),model=v.Text("model"),name=v.Text("name"),ip=v.Text("configuredIp"),channel_number=v.Number("configuredChannelNumber"),freq=v.Number("configuredFrequencyKHz"),_source="manual",_online=false,status="offline"}));
        }).ToArray();liveRefresh?.Invoke();
    }
    private void ShowDeviceForm(Channel? channel=null)
    {
        var editing=channel is not null;var manual=channel?.Raw.Text("_source")=="manual";
        if(editing&&!manual){ShowOnlineDeviceEditor(channel!);return;}
        var panel=new StackPanel();
        var name=Input(editing?(manual?channel!.Name:Usage(channel!)):"");name.MaxLength=80;var brand=Select(InstalledBrandNames().Skip(1).ToArray());if(editing)brand.SelectedItem=channel!.Brand;var model=Input(channel?.Model??"");var ch=Input(channel?.Number?.ToString()??"1");var ip=Input(channel?.Ip??"");var freq=Input(channel?.Frequency??"");
        var fields=Columns(Star(),Star());fields.RowDefinitions.Add(new(){Height=GridLength.Auto});fields.RowDefinitions.Add(new(){Height=GridLength.Auto});fields.RowDefinitions.Add(new(){Height=GridLength.Auto});fields.RowDefinitions.Add(new(){Height=GridLength.Auto});
        var title=Labeled(editing?"使用分类":"设备名称",name);Grid.SetColumnSpan(title,2);At(fields,title);At(fields,Labeled("品牌",brand),1,0);At(fields,Labeled("型号",model),1,1);At(fields,Labeled("通道",ch),2,0);At(fields,Labeled("IP 地址",ip),2,1);var frequency=Labeled("频率 (MHz)",freq);Grid.SetColumnSpan(frequency,2);At(fields,frequency,3,0);
        foreach(var field in fields.Children.OfType<FrameworkElement>())field.Margin=new(0,10,8,0);panel.Children.Add(fields);
        panel.Children.Add(Text("快捷选频（点击填入）",10,"#4a5578",new(0,12,0,5)));var quick=new WrapPanel();foreach(var point in scan?.Points.Take(12)??[])quick.Children.Add(ActionButton((point.FrequencyKHz/1000d).ToString("0.000"),()=>freq.Text=(point.FrequencyKHz/1000d).ToString("0.000",CultureInfo.InvariantCulture)));if(quick.Children.Count==0)quick.Children.Add(Text("暂无已导入扫描频点；请输入设备实测频率",10,"#7c8db5"));panel.Children.Add(quick);
        if(editing&&!manual){foreach(var input in new FrameworkElement[]{brand,model,ch,ip,freq})input.IsEnabled=false;name.IsEnabled=locks.ContainsKey(channel!.Id);if(!name.IsEnabled)panel.Children.Add(Hint("请先在频率规划中锁定此通道，再编辑使用分类。"));}
        var error=Text("",11,"#fb7185",new(0,8,0,8));panel.Children.Add(error);Window? dialog=null;
        var save=ActionButton(editing?"保存修改":"添加设备",()=>{},"PrimaryButton");save.Click+=async(_,_)=>{save.IsEnabled=false;try{
            if(editing&&!manual){if(!locks.TryGetValue(channel!.Id,out var locked))throw new InvalidDataException("当前通道未锁定");locks[channel.Id]=(locked.Frequency,name.Text.Trim());InvalidatePlan();if(!await SavePlannerDraftAsync())return;dialog!.Close();liveRefresh?.Invoke();return;}
            if(string.IsNullOrWhiteSpace(name.Text)||string.IsNullOrWhiteSpace(model.Text)||brand.SelectedItem is null)throw new InvalidDataException("请填写设备名称、型号和品牌");
            var number=int.Parse(ch.Text.Replace("CH-","",StringComparison.OrdinalIgnoreCase).Replace("CH","",StringComparison.OrdinalIgnoreCase),CultureInfo.InvariantCulture);if(number is <1 or >10000)throw new InvalidDataException("通道号范围为 1–10000");var khz=decimal.Parse(freq.Text,CultureInfo.InvariantCulture)*1000;if(khz!=decimal.Truncate(khz)||khz is <30000 or >3000000)throw new InvalidDataException("请输入有效的 MHz 频率，最多 3 位小数");if(ip.Text.Length>0&&!System.Net.IPAddress.TryParse(ip.Text,out _))throw new InvalidDataException("IP 地址无效");
            var id=manual?channel!.Id["manual:".Length..]:JsonSerializer.Serialize(new[]{"string","native-manual-"+Guid.NewGuid().ToString("N")});await SaveResourceAsync("manual_devices",id,new{id,source="manual",brand=brand.SelectedItem.ToString(),model=model.Text.Trim(),name=name.Text.Trim(),configuredFrequencyKHz=(int)khz,configuredChannelNumber=number,configuredIp=ip.Text.Trim()});await LoadManualChannelsAsync();dialog!.Close();Message("手工设备资料已保存；在线状态等待真实接收机连接");
        }catch(Exception e){error.Text=SafeError(e);}finally{save.IsEnabled=true;}};
        dialog=CreateSurfaceDialog(editing?"编辑设备":"添加设备",panel,420,600,buttons:[ActionButton("取消",()=>dialog!.Close()),save]);PresentDialog(dialog);
    }

    private Task SaveScanImportAsync(ScanDocument document,byte[] original)
    {
        scanRecords=[document];scan=document;InvalidatePlan();return Task.CompletedTask;
    }
    private Task ClearCurrentScanAsync()
    {
        if(LiveScanActive){Message("请先停止当前扫描",true);return Task.CompletedTask;}
        scanRequest++;scanReading.Cancel();scanRecords=[];scan=null;InvalidatePlan();liveRefresh?.Invoke();Message("当前会话扫描已清除");return Task.CompletedTask;
    }

}
