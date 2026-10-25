namespace Daty.Native.App;
public partial class MainWindow
{
    // Real-time alerts are memory-only. Never restore or overwrite an old archive cache.
    private void RestoreAlertState()=>alertMonitor.Reset();
    private Task PersistAlertsAsync(bool force=false)=>Task.CompletedTask;
}
