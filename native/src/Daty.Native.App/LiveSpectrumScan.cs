using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private string? liveScanOperation,liveScanDevice,liveScanBoot,liveScanEpoch;
    private string liveScanSummary="",liveScanState="unknown";
    private bool liveScanSubmitting,liveScanPolling;
    private bool liveScanFinalized;
    private DateTime liveScanNextPoll;
    private bool LiveScanActive=>liveScanOperation is not null&&!(ScanExchange.Terminal(liveScanState)&&liveScanFinalized);
    private IReadOnlyList<Channel> ScanReceivers()=>ViewChannels.Where(c=>c.Online&&c.Brand.Equals("Shure",StringComparison.OrdinalIgnoreCase)&&c.Model.Contains("ULXD4",StringComparison.OrdinalIgnoreCase)&&c.Raw.Field("capabilities").Field("scan").True()).DistinctBy(c=>c.DisplayReceiverKey).ToArray();

    private async Task ToggleLiveScanAsync()
    {
        if(liveScanSubmitting||scanProfileSaving)return;
        if(LiveScanActive){await StopLiveScanAsync();return;}
        var receivers=ScanReceivers();if(receivers.Count==0){if(UnconfirmedScanReceivers().Count>0)ShowScanHardwareProfiles();else Message("没有支持直接扫描的在线接收机",true);return;}
        if(receivers.Count==1){await StartLiveScanAsync(receivers[0]);return;}
        var panel=new StackPanel();panel.Children.Add(Text("选择扫描接收机",13));
        var picker=Select(receivers.Select(c=>$"{c.Brand} {c.Model} · {c.Ip}").ToArray());picker.Margin=new(0,10,0,0);panel.Children.Add(picker);
        Window? dialog=null;
        dialog=CreateSurfaceDialog("开始频谱扫描",panel,480,240,buttons:[ActionButton("取消",()=>dialog!.Close()),ActionButton("开始扫描",()=>{var selected=receivers[picker.SelectedIndex];dialog!.Close();_=StartLiveScanAsync(selected);},"PrimaryButton")]);
        PresentDialog(dialog);
    }
    private async Task StartLiveScanAsync(Channel target)
    {
        if(liveScanSubmitting||LiveScanActive)return;liveScanSubmitting=true;scanRequest++;scanReading.Cancel();spectrumToolbarRefresh?.Invoke();
        try {
            var status=await ReadRpcAsync("database.status");var operation=Guid.NewGuid().ToString("N");
            liveScanOperation=operation;liveScanDevice=target.Id;liveScanBoot=bridge?.BootId;liveScanEpoch=status.Text("epoch");
            liveScanState="starting";liveScanFinalized=false;liveScanSummary="正在建立扫描连接";liveScanNextPoll=DateTime.UtcNow.AddSeconds(1);
            var reply=await ReadRpcAsync("plugins.scan.start",new{plugin_id="shure-scp",operation_id=operation,epoch=liveScanEpoch,device_id=target.Id,
                options=new{start_khz=632125,end_khz=695875,step_khz=25}},liveScanBoot);
            ApplyLiveScanReply(reply);Message(liveScanSummary);
        } catch(R19RpcException error) when(error.Status is >=400 and <500) {
            liveScanState="failed";liveScanFinalized=true;Message("扫描未开始："+SafeError(error),true);
        } catch(Exception error) {
            // A lost start reply is never retried. Query the same operation on reconnect.
            Message("扫描状态待确认："+SafeError(error),true);
        } finally{liveScanSubmitting=false;spectrumToolbarRefresh?.Invoke();}
    }
    private async Task StopLiveScanAsync()
    {
        if(liveScanOperation is null)return;liveScanSubmitting=true;spectrumToolbarRefresh?.Invoke();
        try {
            var status=await ReadRpcAsync("database.status");
            var cancelId=Guid.NewGuid().ToString("N");
            var result=await ReadRpcAsync("plugins.scan.cancel",new{plugin_id="shure-scp",operation_id=cancelId,epoch=status.Text("epoch"),scan_operation_id=liveScanOperation},liveScanBoot);
            if(result.Text("operation_id")!=cancelId||result.Text("scan_operation_id")!=liveScanOperation||!result.Field("accepted").True())throw new InvalidDataException("停止扫描回执不匹配");
            Message("已请求停止扫描，等待接收机状态确认");
        } catch(Exception error){Message("停止扫描尚未确认："+SafeError(error),true);}
        finally{liveScanSubmitting=false;spectrumToolbarRefresh?.Invoke();}
    }
    private void PollLiveScan()
    {
        if(verification||shutdownStarted||!LiveScanActive||liveScanSubmitting||liveScanPolling||DateTime.UtcNow<liveScanNextPoll)return;
        liveScanNextPoll=DateTime.UtcNow.AddSeconds(1);_=ReadLiveScanAsync();
    }
    private async Task ReadLiveScanAsync()
    {
        liveScanPolling=true;var operation=liveScanOperation;
        try {
            var result=await ReadRpcAsync("plugins.scan.status",new{plugin_id="shure-scp",operation_id=operation},liveScanBoot);
            if(operation!=liveScanOperation)return;ApplyLiveScanReply(result);
            if(!LiveScanActive)Message(liveScanSummary,liveScanState is "failed" or "interrupted" or "unknown");
        } catch(Exception error) {
            liveScanSummary="扫描连接中断，正在查询原操作："+SafeError(error);
            if(error is R19RpcException rpc&&rpc.Code is "SERVER_BOOT_CHANGED" or "SCAN_OPERATION_NOT_FOUND" or "OPERATION_NOT_FOUND") {liveScanState="unknown";liveScanFinalized=true;Message("扫描结果未知；不会自动重新扫描",true);}
        } finally{liveScanPolling=false;spectrumToolbarRefresh?.Invoke();}
    }
    private void ApplyLiveScanReply(JsonElement reply)
    {
        if(reply.Text("schema")!="daty-live-scan-v1"||reply.Text("operation_id")!=liveScanOperation||reply.Field("target").Text("device_id")!=liveScanDevice)
            throw new InvalidDataException("扫描回执与当前接收机不匹配");
        var state=reply.Text("state")??"unknown";
        if(reply.Number("received_points") is >0&&reply.Field("points").ValueKind==JsonValueKind.Array&&reply.Field("points").GetArrayLength()>0)
        {
            var document=ScanExchange.FromLive(reply,liveScanOperation!,liveScanDevice!,lifetime.Token);
            var first=scan?.Raw.Text("operation_id")!=liveScanOperation;
            scanRecords=[document];scan=document;InvalidatePlan();
            if(first&&document.GridStartKHz is int a&&document.GridEndKHz is int b)settings=settings with{StartMHz=a/1000d,EndMHz=b/1000d};
        }
        liveScanState=state;liveScanFinalized=reply.Field("finalized").True();liveScanSummary=ScanExchange.StateLabel(state)+$" · {reply.Number("received_points")??0:N0} 点";
        if(state=="starting"&&LiveScanSessionLabel(reply.Text("handshake_state")) is string sessionLabel)liveScanSummary=sessionLabel;
        if(reply.Number("progress") is double progress)liveScanSummary+=$" · {progress:0}%";
        if(reply.Text("error") is string error)liveScanSummary+=" · "+LiveScanError(error);
        scanRefresh?.Invoke();spectrumToolbarRefresh?.Invoke();
    }
    private static string LiveScanError(string code)=>code switch {
        "SCAN_CANCELLED_BEFORE_START"=>"已取消，未向接收机发送开始扫描指令",
        "SCAN_ID_TIMEOUT"=>"接收机未返回本次扫描资源，扫描未开始",
        "SCAN_ID_INVALID"=>"接收机返回的扫描资源标识无效",
        "SCAN_ID_UNSUPPORTED"=>"当前分配的扫描资源暂不支持，扫描未开始",
        "SCAN_PROPERTY_REJECTED_0200090f"=>"接收机未能分配扫描资源",
        "SCAN_CONNECTION_CLEANUP_UNCONFIRMED" or "SCAN_RELEASE_NOT_CONFIRMED"=>"扫描资源清理尚未确认",
        "SCAN_SESSION_PARAMETERS_TIMEOUT"=>"接收机会话参数读取超时，扫描未开始",
        "SCAN_SESSION_KEY_STATUS_TIMEOUT"=>"接收机未确认扫描会话，扫描未开始",
        "SCAN_SESSION_PARAMETERS_UNSUPPORTED"=>"该接收机的扫描会话参数暂不支持",
        "SCAN_SESSION_PARAMETER_ENCODING" or "SCAN_SESSION_STATUS_INVALID"=>"接收机返回的扫描会话信息无效",
        var value when value.StartsWith("SCAN_SESSION_PROPERTY_REJECTED_",StringComparison.Ordinal)=>"接收机拒绝扫描会话初始化，扫描未开始",
        var value when value.StartsWith("SCAN_SESSION_",StringComparison.Ordinal)=>"扫描会话初始化失败（"+value+"）",
        "SCAN_START_NOT_CONFIRMED"=>"接收机未确认开始扫描，未获得扫描点",
        "SCAN_ARRAY_SUBSCRIBE_TIMEOUT"=>"未取得扫描数据订阅确认",
        "SCAN_OUTCOME_TIMEOUT" or "SCAN_COMPLETION_TIMEOUT"=>"未取得接收机的扫描结束确认",
        "SCAN_TERMINAL_WITH_MISSING_POINTS"=>"接收机已结束，仍有未解码或缺失的采样位置",
        "SCAN_HARDWARE_PROFILE_REQUIRED"=>"该机身频段尚未核实，请点击扫描频段保存机身标签",
        "SCAN_HARDWARE_BAND_UNSUPPORTED"=>"接收机上报的频段与已验证的 L51 扫描范围不一致",
        "SCAN_HARDWARE_IDENTITY_STALE"=>"接收机频段资料已过期，等待重新读取",
        "SCAN_RECEIVER_IDENTITY_UNAVAILABLE"=>"接收机机身身份尚未读取完成，等待重新读取",
        "SCAN_ENDPOINT_ANNOUNCEMENT_TIMEOUT"=>"未收到接收机的扫描端点公告",
        "SCAN_RECEIVER_BUSY"=>"接收机正在执行其他扫描",
        "SCAN_RECEIPT_UNCONFIRMED"=>"扫描结果尚未确认保存",
        _=>"接收机扫描未确认（"+code+"）"
    };
    private static string? LiveScanSessionLabel(string? state)=>state switch {
        "reading_parameters"=>"正在读取扫描会话参数",
        "exchanging"=>"正在建立扫描会话",
        "confirming"=>"正在等待接收机确认扫描会话",
        "ready"=>"扫描会话已建立，等待接收机开始扫描",
        _=>null
    };
    private async Task StopOwnedLiveScanOnCloseAsync()
    {
        if(!LiveScanActive||bridge is not { } client)return;
        try {
            using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await client.CallAsync("plugins.scan.cancel",new{plugin_id="shure-scp",operation_id=Guid.NewGuid().ToString("N"),epoch=liveScanEpoch,scan_operation_id=liveScanOperation},timeout.Token,liveScanBoot);
        } catch(Exception error){System.Diagnostics.Trace.TraceWarning("Scan close cleanup unconfirmed: {0}",error.GetType().Name);}
    }
}
