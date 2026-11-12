using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    internal async Task VerifyScanBackupsAsync(string directory)
    {
        if(!verification)throw new InvalidOperationException("Isolated verification required");
        Directory.CreateDirectory(directory);
        var checks=new List<string>();
        void Check(bool value,string message){if(!value)throw new Exception(message);checks.Add(message);}
        scanBackupStore=new(Path.Combine(directory,"scan-files"));ApplyScanBackupSetting(new ScanBackupOptions().ToJson());
        var raw=JsonSerializer.SerializeToElement(new{
            schema="daty-live-scan-v1",operation_id=Guid.NewGuid().ToString("N"),target=new{device_id="fixture"},state="partial",
            actual_range=new{start_khz=640000,end_khz=640100,step_khz=25},
            points=new object?[][]{[640000,-95.1],[640025,-40.2],[640050,null],[640075,-99.3],[640100,null]},
            received_points=3,missing_points=2,coverage_complete=false,device_ended=true,complete=false});
        var measured=ScanExchange.FromLive(raw,raw.Text("operation_id")!,"fixture",default);
        QueueScanBackup(measured,true);await scanBackupTask;
        var entries=await scanBackupStore.ListAsync(default);
        Check(entries.Count==1&&entries[0].Missing==2,"UI autosave uses the real backup writer and preserves missing slots");
        var restored=new MainWindow(true){Width=1366,Height=768,scanBackupStore=new(scanBackupStore.DirectoryPath)};
        restored.SetSpectrumSettingsFixture();restored.ApplyScanBackupSetting(new ScanBackupOptions().ToJson());
        await restored.RestoreScanBackupAsync(entries[0]);
        Check(restored.scan!.Points.SequenceEqual(measured.Points)&&restored.scan.MissingPoints==2,"New window restores exact working-file values");
        Check(restored.scan.SourceLabel=="历史备份"&&!restored.scanUseForPlanning,"Restored data is explicitly historical and view-only");
        Check(restored.PlanningOptions().Field("scanPoints").GetArrayLength()==0,"View-only backup is excluded from all planning samples");
        foreach(var width in new[]{1024,1366,1920})
        {
            restored.StatusToast.Visibility=Visibility.Collapsed;
            restored.Width=width;restored.ShowPage("spectrum");
            var root=(FrameworkElement)restored.Content;root.Measure(new(width,768));root.Arrange(new(0,0,width,768));root.UpdateLayout();
            var button=ScanBackupDescendants<Button>(root).Single(b=>System.Windows.Automation.AutomationProperties.GetAutomationId(b)=="SpectrumScanBackupPlanning");
            Check(button.Visibility==Visibility.Visible&&Equals(button.Content,"历史扫描 · 用于规划"),"Historical planning action is visible at "+width);
            foreach(var control in ScanBackupDescendants<Button>(root).Where(b=>System.Windows.Automation.AutomationProperties.GetAutomationId(b).StartsWith("Spectrum")))
            {var edge=control.TranslatePoint(new(control.ActualWidth,control.ActualHeight),root);Check(edge.X<=width&&edge.Y<=768,"Toolbar stays reachable at "+width);}
            Save(root,width,768,Path.Combine(directory,"backup-restored-"+width+".png"));
        }
        restored.ToggleHistoricalScanPlanning();
        Check(!restored.scanUseForPlanning&&restored.verificationDialogs.Keys.Any(k=>k.Contains("历史扫描用于规划")),"Planning action requests explicit confirmation and cancel keeps view-only");
        restored.scanUseForPlanning=true;restored.InvalidatePlan();
        Check(restored.PlanningOptions().Field("scanPoints").GetArrayLength()==3,"Approved historical samples use only the three measured points");
        restored.ToggleHistoricalScanPlanning();
        Check(restored.PlanningOptions().Field("scanPoints").GetArrayLength()==0,"Exit-planning action removes historical input again");
        await restored.ShowScanBackupsAsync();
        var dialog=restored.verificationDialogs.Single(k=>k.Key.StartsWith("DATY RF PRO · 扫描备份（")).Value;
        dialog.Measure(new(900,640));dialog.Arrange(new(0,0,900,640));dialog.UpdateLayout();
        Check(ScanBackupDescendants<DataGrid>(dialog).Single().Items.Count==1,"Backup dialog lists persisted records");
        Save(dialog,900,640,Path.Combine(directory,"backup-dialog.png"));
        var before=(await restored.scanBackupStore.ListAsync(default)).Count;
        restored.ApplyScanBackupSetting(new ScanBackupOptions(false).ToJson());restored.QueueScanBackup(measured,true);await restored.scanBackupTask;
        Check((await restored.scanBackupStore.ListAsync(default)).Count==before,"Disabled preference prevents automatic writes");
        await restored.ClearCurrentScanAsync();Check(restored.scan is null&&(await restored.scanBackupStore.ListAsync(default)).Count==1,"Clear current scan retains the saved backup");
        restored.Close();
        await File.WriteAllTextAsync(Path.Combine(directory,"result.json"),JsonSerializer.Serialize(new{ok=true,checks,physicalCommands=0}));
    }
    private static IEnumerable<T> ScanBackupDescendants<T>(DependencyObject root)where T:DependencyObject
    {
        for(var i=0;i<VisualTreeHelper.GetChildrenCount(root);i++){var child=VisualTreeHelper.GetChild(root,i);if(child is T t)yield return t;foreach(var item in ScanBackupDescendants<T>(child))yield return item;}
    }
    private static void Save(FrameworkElement root,int width,int height,string path)
    {
        var bitmap=new RenderTargetBitmap(width,height,96,96,PixelFormats.Pbgra32);bitmap.Render(root);
        var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using var output=File.Create(path);encoder.Save(output);
    }
}
