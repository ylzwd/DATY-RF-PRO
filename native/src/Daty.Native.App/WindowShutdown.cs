using System.ComponentModel;
using System.Diagnostics;
using System.Windows.Threading;

namespace Daty.Native.App;

public partial class MainWindow
{
    private volatile bool shutdownStarted;
    private bool shutdownComplete;
    private Task? shutdownTask;
    private string? shutdownWarning;
    private void OnWindowClosing(object? sender,CancelEventArgs e)
    {
        if(shutdownComplete)return;
        e.Cancel=true;
        if(shutdownStarted)return;
        // Keep the connection usable so an unconfirmed database edit can be reconciled.
        if(PlanningUnconfirmed){ShowPage("planner");Message("规划设置尚未确认入库，请等待或点击上方保存状态核对后再关闭",true);return;}
        if(spectrumInputInvalid){ShowPage("spectrum");Message("频谱阈值输入尚未完成，请修正数值并确认保存后关闭",true);return;}
        if(SpectrumUnconfirmed){ShowPage("spectrum");Message("频谱阈值尚未确认入库，请等待或点击保存状态重试后再关闭",true);return;}
        if(systemSettingsSavingAll || systemSettingsWriter?.HasUnsaved==true || settingOperations.Count>0)
        {
            ShowPage("settings");
            Message("系统设置尚未取得数据库确认，请点击保存并确认后关闭。",true);
            return;
        }
        shutdownStarted=true;
        renderTimer.Stop();archiveTimer.Stop();sharedSettingsTimer.Stop();toastTimer.Stop();
        Shell.IsEnabled=false;
        Message("正在关闭 DATY RF PRO…");toastTimer.Stop();
        incomingSnapshots.Clear();
        shutdownTask=FinishWindowCloseAsync();
    }
    private async Task FinishWindowCloseAsync()
    {
        // Always leave the current Closing event, even when cleanup completes synchronously.
        await Dispatcher.Yield(DispatcherPriority.Background);
        await StopOwnedLiveScanOnCloseAsync();
        var cleanup=Task.Run(async()=>
        {
            await Task.WhenAll(lifetime.CancelAsync(),connection.CancelAsync(),scanReading.CancelAsync(),
                deviceStream?.DisposeAsync().AsTask()??Task.CompletedTask,
                bridge?.DisposeAsync().AsTask()??Task.CompletedTask,
                verification ? closeVerificationCleanup?.Invoke()??Task.CompletedTask : Task.CompletedTask).ConfigureAwait(false);
        });
        try { await cleanup.WaitAsync(TimeSpan.FromSeconds(3)); }
        catch(Exception error)
        {
            // This limit only concerns local transport cleanup, never a database save receipt.
            shutdownWarning=error is TimeoutException?"transport cleanup exceeded 3 seconds":error.GetType().Name;
            Trace.TraceWarning("Native window close: {0}",shutdownWarning);
            _=cleanup.ContinueWith(t=>Trace.TraceWarning("Late transport cleanup: {0}",t.Exception?.GetBaseException().GetType().Name),
                CancellationToken.None,TaskContinuationOptions.OnlyOnFaulted,TaskScheduler.Default);
        }
        incomingSnapshots.Clear();shutdownComplete=true;Close();
    }
}
