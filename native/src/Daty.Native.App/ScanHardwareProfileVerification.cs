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
    internal FrameworkElement ScanHardwareProfileDialogFixture(DeviceSnapshot snapshot)
    {
        if(!verification)throw new InvalidOperationException("Isolated fixture required");
        SetVerificationSnapshot(snapshot);ShowScanHardwareProfiles();
        return verificationDialogs["DATY RF PRO · 扫描频段"];
    }
}

internal static partial class UiVerification
{
    private static void VerifyScanHardwareProfileDialog(string directory)
    {
        var checks=new List<string>();
        void Check(bool valid,string name){if(!valid)throw new Exception(name);checks.Add(name);}
        var devices=Enumerable.Range(1,2).Select(n=>new {id="label-ch"+n,receiver_id="label-rx"+n,receiver_ip="192.0.2."+n,
            receiver_mac=$"00:0E:DD:00:00:{n:00}",brand="Shure",model="ULXD4",channel_number=1,_online=true,_source="shure-scp",status="online",freq=632700,
            capabilities=new{scan=false,scan_unavailable_reason="SCAN_HARDWARE_PROFILE_REQUIRED"},shure=new{schema="daty-shure-telemetry-v1",stale_fields=Array.Empty<string>()}});
        var snapshot=DeviceSnapshot.Parse(JsonSerializer.SerializeToElement(new{success=true,devices}));
        foreach(var width in new[]{400,600})
        {
            var window=new MainWindow(true);
            var body=window.ScanHardwareProfileDialogFixture(snapshot);
            body.Measure(new(width,310));body.Arrange(new(0,0,width,310));body.UpdateLayout();
            var save=Descendants<Button>(body).Single(b=>Equals(b.Content,"保存"));
            var confirm=Descendants<CheckBox>(body).Single();
            var picker=Descendants<ComboBox>(body).Single();
            Check(picker.Items.Count==2&&!save.IsEnabled,"Label dialog starts unconfirmed for two actual chassis "+width);
            confirm.IsChecked=true;Check(save.IsEnabled,"Explicit label confirmation enables save "+width);
            picker.SelectedIndex=1;Check(confirm.IsChecked==false&&!save.IsEnabled,"Changing chassis clears confirmation "+width);
            body.Measure(new(width,310));body.Arrange(new(0,0,width,310));body.UpdateLayout();
            foreach(var control in Descendants<FrameworkElement>(body).Where(e=>e is Button or ComboBox or CheckBox))
            {
                var point=control.TranslatePoint(new Point(),body);
                Check(point.X>=-.5&&point.Y>=-.5&&point.X+control.ActualWidth<=width+.5&&point.Y+control.ActualHeight<=310.5,
                    "Label dialog control inside viewport "+width+" "+control.GetType().Name);
            }
            var bitmap=new RenderTargetBitmap(width,310,96,96,PixelFormats.Pbgra32);bitmap.Render(body);
            var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using(var file=File.Create(Path.Combine(directory,"scan-hardware-profile-"+width+".png")))encoder.Save(file);
            window.Close();
        }
        File.WriteAllText(Path.Combine(directory,"scan-hardware-profile-verification.json"),JsonSerializer.Serialize(new{passed=true,checks,networkRequests=0,deviceCommands=0},new JsonSerializerOptions{WriteIndented=true}));
    }
}
