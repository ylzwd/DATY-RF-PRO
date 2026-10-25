using System.IO;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private void EditOnlineDevice(string id)
    {
        var channel=ViewChannels.SingleOrDefault(c=>c.Id==id);
        if(channel is null){Message("通道已不在当前列表，请等待最新状态",true);return;}
        ShowDeviceForm(channel);
    }

    private void ShowOnlineDeviceEditor(Channel channel)
    {
        (int Frequency,string Note)? original=locks.TryGetValue(channel.Id,out var existing)?existing:null;
        var panel=new StackPanel();
        foreach(var field in new[]{("通道",channel.Group+" · "+channel.ChannelLabel),("品牌 / 型号",channel.Brand+" "+channel.Model),("IP 地址",channel.Ip),("当前频率",channel.Frequency+" MHz"),("连接状态",channel.OnlineLabel)})panel.Children.Add(KeyValue(field.Item1,field.Item2));
        panel.Children.Add(Hint("以上信息来自接收机。调频请在频率规划表输入并下发。使用分类与频率锁定一起保存到服务器数据库。"));
        var locked=new CheckBox{Content=original.HasValue?"保留锁定频率 "+Wire.Format(original.Value.Frequency/1000d,"0.000")+" MHz":"锁定当前频率 "+channel.Frequency+" MHz 并设置使用分类",IsChecked=original.HasValue,Foreground=B("#e2e8f0"),Margin=new(0,14,0,8),IsEnabled=channel.Online&&(planningSettingsReady||verification)};
        var note=Input(original?.Note??"");note.MaxLength=80;note.IsEnabled=locked.IsChecked==true;note.ToolTip="例如：主唱、主持人";
        locked.Checked+=(_,_)=>{note.IsEnabled=true;note.Focus();};locked.Unchecked+=(_,_)=>note.IsEnabled=false;
        panel.Children.Add(locked);panel.Children.Add(Labeled("使用分类",note));
        panel.Children.Add(Hint(original.HasValue?"取消勾选并保存，会解除该通道锁定及使用分类。":"先勾选锁定，再填写使用分类；不会向接收机发送调频指令。"));
        var error=Text("",11,"#fb7185",new(0,8,0,0));panel.Children.Add(error);Window? dialog=null;
        var save=ActionButton("保存修改",()=>{},"PrimaryButton");save.IsEnabled=channel.Online&&(planningSettingsReady||verification);
        save.Click+=async(_,_)=>{save.IsEnabled=false;locked.IsEnabled=note.IsEnabled=false;try{
            await SaveOnlineUsageAsync(channel,original,locked.IsChecked==true,note.Text);
            dialog!.Close();liveRefresh?.Invoke();Message("使用分类与锁定已获数据库保存确认");
        }catch(Exception e){error.Text=SafeError(e);}finally{save.IsEnabled=true;locked.IsEnabled=true;note.IsEnabled=locked.IsChecked==true;}};
        dialog=CreateSurfaceDialog("编辑设备",panel,540,520,buttons:[ActionButton("取消",()=>dialog!.Close()),save]);PresentDialog(dialog);
    }

    private async Task SaveOnlineUsageAsync(Channel opened,(int Frequency,string Note)? original,bool keepLock,string note)
    {
        if(!planningSettingsReady)throw new InvalidDataException("规划设置尚未从数据库读取完成");
        var current=ViewChannels.SingleOrDefault(c=>c.Id==opened.Id);
        if(current is null||!current.Online||current.ReceiverId!=opened.ReceiverId||current.Number!=opened.Number||current.Ip!=opened.Ip)throw new InvalidDataException("接收机身份或在线状态已变化，请重新打开编辑");
        (int Frequency,string Note)? actual=locks.TryGetValue(opened.Id,out var value)?value:null;
        var desired=keepLock?(original?.Frequency??opened.FrequencyKHz,note.Trim()):((int?)null,"");
        if(actual!=original&&!((!keepLock&&actual is null)||(keepLock&&actual?.Frequency==desired.Item1&&actual?.Note==desired.Item2)))throw new InvalidDataException("锁定信息已被其他操作修改，请重新打开编辑");
        if(keepLock){if(desired.Item1 is not int frequency||(!original.HasValue&&current.FrequencyKHz!=opened.FrequencyKHz))throw new InvalidDataException("当前频率已变化，请重新打开编辑后锁定");locks[opened.Id]=(frequency,desired.Item2);}
        else {if(!original.HasValue)throw new InvalidDataException("请勾选锁定当前频率后设置使用分类");locks.Remove(opened.Id);}
        InvalidatePlan();if(!await SavePlannerDraftAsync())throw new InvalidDataException("数据库尚未确认保存，请核对保存状态后重试");
    }
}
