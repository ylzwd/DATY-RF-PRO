using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private bool scanProfileSaving;
    private IReadOnlyList<Channel> UnconfirmedScanReceivers()=>ViewChannels.Where(ShureScanProfiles.NeedsConfirmation).DistinctBy(c=>c.DisplayReceiverKey).ToArray();
    private void ShowScanHardwareProfiles()
    {
        if(LiveScanActive||liveScanSubmitting||scanProfileSaving)return;
        var targets=UnconfirmedScanReceivers();
        if(targets.Count==0){Message("没有待确认频段的在线 ULXD4 接收机",true);return;}
        var panel=new StackPanel();panel.Children.Add(Text("接收机",12,"#7c8db5"));
        var picker=Select(targets.Select(c=>$"{c.Model} · {c.Ip} · {ShureScanProfiles.ReceiverMac(c)}").ToArray());
        picker.Margin=new(0,6,0,12);panel.Children.Add(picker);
        var confirm=new CheckBox{Content="已核对该接收机的机身标签为 L51",Margin=new(0,0,0,10),FontSize=13,Foreground=B("#e2e8f0")};
        confirm.ToolTip="旧固件未上报频段时，按机身 MAC 保存确认资料；不会按当前频率或 IP 推断。其他频段暂不支持此扫描。";
        panel.Children.Add(confirm);
        var status=Text("扫描范围 632.125–695.875 MHz · 25 kHz",12,"#7c8db5");panel.Children.Add(status);
        Window? dialog=null;var cancel=ActionButton("取消",()=>dialog!.Close());
        var save=ActionButton("保存",()=>{},"PrimaryButton");save.IsEnabled=false;
        confirm.Checked+=(_,_)=>save.IsEnabled=!scanProfileSaving;
        confirm.Unchecked+=(_,_)=>save.IsEnabled=false;
        picker.SelectionChanged+=(_,_)=>confirm.IsChecked=false;
        save.Click+=async(_,_)=>{
            if(scanProfileSaving||confirm.IsChecked!=true)return;
            var target=targets[picker.SelectedIndex];
            scanProfileSaving=true;save.IsEnabled=false;picker.IsEnabled=false;confirm.IsEnabled=false;cancel.IsEnabled=false;spectrumToolbarRefresh?.Invoke();
            try {
                await SaveScanHardwareProfileAsync(target,true);
                scanProfileSaving=false;dialog!.Close();Message("机身频段已保存，可点击开始扫描");
            } catch(Exception error){status.Text="未确认保存："+SafeError(error);status.Foreground=B("#f87171");}
            finally{scanProfileSaving=false;picker.IsEnabled=true;confirm.IsEnabled=true;cancel.IsEnabled=true;save.IsEnabled=confirm.IsChecked==true;spectrumToolbarRefresh?.Invoke();}
        };
        dialog=CreateSurfaceDialog("扫描频段",panel,600,310,buttons:[cancel,save]);
        dialog.Closing+=(_,e)=>{if(scanProfileSaving)e.Cancel=true;};
        PresentDialog(dialog);
    }
    private async Task SaveScanHardwareProfileAsync(Channel selected,bool confirmed)
    {
        var current=ViewChannels.FirstOrDefault(c=>c.Id==selected.Id);
        if(current is null||current.ReceiverId!=selected.ReceiverId||ShureScanProfiles.ReceiverMac(current)!=ShureScanProfiles.ReceiverMac(selected))
            throw new InvalidDataException("接收机身份已变化，请重新选择机身");
        JsonElement baseline=default;
        try{baseline=(await ReadRpcAsync("database.resources.get",new{kind="settings",id=ShureScanProfiles.DocumentId})).Field("resource");}
        catch(R19RpcException error)when(error.Code=="RESOURCE_NOT_FOUND"){}
        current=ViewChannels.FirstOrDefault(c=>c.Id==selected.Id);
        if(current is null||!current.Online||current.ReceiverId!=selected.ReceiverId||ShureScanProfiles.ReceiverMac(current)!=ShureScanProfiles.ReceiverMac(selected))
            throw new InvalidDataException("接收机身份已变化，请重新选择机身");
        var revision=(int)(baseline.Number("revision")??0);
        var value=ShureScanProfiles.ConfirmLabel(baseline.Field("deleted").True()?default:baseline.Field("value"),current,confirmed,"chassis-label:"+Guid.NewGuid().ToString("N"));
        var saved=(await WriteBusinessAsync("database.write",new(){{"kind","settings"},{"id",ShureScanProfiles.DocumentId},{"expected_revision",revision},{"value",value}})).Field("resource");
        ShureScanProfiles.VerifySaved(saved,value,revision+1);
        var readback=(await ReadRpcAsync("database.resources.get",new{kind="settings",id=ShureScanProfiles.DocumentId})).Field("resource");
        ShureScanProfiles.VerifySaved(readback,value,revision+1);
        resources["settings:"+ShureScanProfiles.DocumentId]=readback.Clone();
        ApplyPluginStatus(await ReadRpcAsync("plugins.status"));await RefreshAsync();
    }
}
