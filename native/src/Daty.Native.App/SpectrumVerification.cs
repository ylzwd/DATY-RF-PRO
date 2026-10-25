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
    internal void SetSpectrumFixture(DeviceSnapshot snapshot)
    {
        if(!verification)throw new InvalidOperationException("Isolated fixture required");
        SetVerificationSnapshot(snapshot);SetVerificationRange(630,700);
        SetSpectrumSettingsFixture();
        scan=new ScanDocument("isolated-spectrum.csv",new string('0',64),[new(630000,-88),new(650000,-85),new(650001,-42),new(650002,-86),new(700000,-88)],0,default);
    }
    internal void SetScanRecordsFixture(IReadOnlyList<ScanDocument> records)
    {
        if(!verification)throw new InvalidOperationException("Isolated fixture required");
        scanRecords=records;SetSpectrumSettingsFixture();SelectScanRecord(records[0]);
    }
    internal JsonElement ScanPlanningFixture()
    {
        if(!verification)throw new InvalidOperationException("Isolated fixture required");
        return PlanningOptions();
    }
    internal string ApplyLiveScanFixture(JsonElement reply)
    {
        if(!verification)throw new InvalidOperationException("Isolated fixture required");
        liveScanOperation=reply.Text("operation_id");liveScanDevice=reply.Field("target").Text("device_id");
        ApplyLiveScanReply(reply);return liveScanSummary;
    }

}

internal static partial class UiVerification
{
    private static void VerifySpectrum(string directory)
    {
        var checks=new List<string>();
        void Check(bool value,string description){if(!value)throw new Exception(description);checks.Add(description);}
        using var rulesDocument=JsonDocument.Parse(File.ReadAllText(Environment.GetEnvironmentVariable("DATY_MONITORING_RULES_FIXTURE")??throw new Exception("Monitoring fixture required")));
        var rules=MonitoringRules.Parse(rulesDocument.RootElement);
        Channel Device(string id,int freq,double? rf,bool online=true)=>Channel.Parse(JsonSerializer.SerializeToElement(new{id,receiver_id=id,receiver_ip="192.0.2.16",channel_number=1,brand="DATYaudio",model="RF PRO",freq,rf,_online=online,status=online?"online":"offline"}));
        var first=Device("one",640000,-45);var second=Device("two",690000,-55);var duplicate=Device("three",640000,-65);var unknown=Device("unknown",660000,null);var offline=Device("off",670000,-50,false);
        Check(SpectrumPresentation.Fit([first,second]) is (615,715),"Two-frequency fit matches HTML 615–715 MHz");
        Check(SpectrumPresentation.Fit([second]) is (689,691),"Single-frequency fit has 2 MHz span");
        Check(SpectrumPresentation.Fit([first,duplicate]) is (639,641),"Same-frequency channels do not change padding");
        Check(SpectrumPresentation.Fit([offline]) is null,"Offline receiver excluded from fit");
        Check(SpectrumPresentation.Count([first,second,duplicate,offline],630,700)==2,"Distinct online frequency count");
        Check(SpectrumPresentation.Count([first,second,duplicate],680,700)==1,"Count excludes frequencies outside view");
        Check(SpectrumPresentation.Count([first,unknown],630,700)==2,"Known frequency remains counted when RF unknown");
        var dense=Enumerable.Range(0,70001).Select(i=>new ScanPoint(630000+i,i==10001?-32:-88)).ToArray();
        var reduced=SpectrumPresentation.Reduce(dense,630,700,400);
        Check(reduced.Count<=1600&&reduced.Contains(dense[10001])&&reduced[0]==dense[0]&&reduced[^1]==dense[^1],"Pixel reduction preserves isolated narrow peak and both ends");
        foreach(var width in new[]{1024,1366,1920})
        {
            var plot=new SpectrumPlot{Width=width-270,Height=450,StartMHz=630,EndMHz=700,MonitoringRules=rules,Channels=[first,second,duplicate,unknown,offline],
                ScanPeakThresholdDbm=-60,ScanExclusionThresholdDbm=-85,
                Points=[new(644975,-95),new(645000,-60),new(645025,-95)]};
            plot.Measure(new(plot.Width,450));plot.Arrange(new(0,0,plot.Width,450));plot.UpdateLayout();
            var bmp=new RenderTargetBitmap((int)plot.Width,450,96,96,PixelFormats.Pbgra32);bmp.Render(plot);
            Check(plot.SpectrumHover(new(plot.SpectrumX(640),plot.SpectrumY(-45)))?.Contains("-45 dBm")==true,"Actual circle wins over same-frequency stem "+width);
            Check(plot.SpectrumHover(new(plot.SpectrumX(640),plot.SpectrumY(-70)))?.Contains("640.000 MHz")==true,"Stem reports actual channel frequency "+width);
            Check(plot.SpectrumHover(new(plot.SpectrumX(660),plot.SpectrumArea.Bottom-4))?.Contains("RF 未知")==true,"Unknown RF marker remains inspectable at the plot floor "+width);
            Check(plot.SpectrumHover(new(plot.SpectrumX(660),plot.SpectrumY(-90))) is null,"Unknown RF has no invented -90 dBm height "+width);
            var peakHover=plot.SpectrumHover(new(plot.SpectrumX(645),plot.SpectrumY(-60)));
            Check(peakHover?.Contains("645.000")==true&&!peakHover.Contains("仿真"),"Peak hover reports a real scan frequency "+width);
            Check(plot.SpectrumHover(new(plot.SpectrumX(655),plot.SpectrumY(-45))) is null&&plot.SpectrumHover(new(0,0)) is null,"Empty plot and outside axis have no tooltip "+width);

            var window=new MainWindow(true){Width=width,Height=768};
            window.SetSpectrumFixture(new DeviceSnapshot([first,second,duplicate,unknown,offline],DateTimeOffset.UtcNow,null,default));
            window.ShowPage("spectrum");var root=(FrameworkElement)window.Content;root.Measure(new(width,768));root.Arrange(new(0,0,width,768));root.UpdateLayout();
            var rendered=Descendants<SpectrumPlot>(root).Single();
            Check(rendered.MonitoringRules is not null,"Spectrum receives the current database monitoring rules "+width);
            var scanStart=Descendants<Button>(root).Single(b=>System.Windows.Automation.AutomationProperties.GetAutomationId(b)=="SpectrumScanStart");
            var scanExport=Descendants<Button>(root).Single(b=>System.Windows.Automation.AutomationProperties.GetAutomationId(b)=="SpectrumScanExport");
            Check(Equals(scanStart.Content,"开始扫描")&&Equals(scanExport.Content,"导出文件")&&scanStart.Height==30&&scanExport.Height==30,"Scan and export toolbar uses uniform control height "+width);
            Check(!scanStart.IsEnabled,"Isolated fixture does not enable hardware scan "+width);
            foreach(var control in Descendants<Button>(root).Where(b=>System.Windows.Automation.AutomationProperties.GetAutomationId(b).StartsWith("Spectrum"))) {
                var edge=control.TranslatePoint(new Point(control.ActualWidth,control.ActualHeight),root);
                Check(edge.X<=width&&edge.Y<=768,"Spectrum toolbar wraps within window "+width);
            }
            Check(rendered.ScanPeakThresholdDbm==-60&&rendered.ScanExclusionThresholdDbm==-85,"Scene shows distinct peak and exclusion thresholds "+width);
            Check(typeof(SpectrumPlot).GetProperty("Simulation") is null,"Spectrum has no simulation rendering input "+width);
            Check(!Descendants<CheckBox>(root).Any(c=>Equals(c.Content,"━ 计算曲线"))&&!Descendants<Button>(root).Any(b=>b.Content?.ToString() is "仿真设置" or "范围明细")&&!Descendants<TextBlock>(root).Any(t=>t.Text.StartsWith("设备频点:")||t.Text.StartsWith("● 设备实时频点")||t.Text.StartsWith("可用:")),"Spectrum footer controls and status row are removed "+width);
            var output=new RenderTargetBitmap(width,768,96,96,PixelFormats.Pbgra32);output.Render(root);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(output));using(var stream=File.Create(Path.Combine(directory,$"spectrum-parity-{width}.png")))encoder.Save(stream);
            var originalPoints=rendered.Points;
            var peakInput=Descendants<TextBox>(root).Single(t=>System.Windows.Automation.AutomationProperties.GetAutomationId(t)=="ScanPeakThreshold");
            var excludeInput=Descendants<TextBox>(root).Single(t=>System.Windows.Automation.AutomationProperties.GetAutomationId(t)=="ScanExclusionThreshold");
            Check(peakInput.Text=="-60"&&excludeInput.Text=="-85","Threshold editors show database fixture values "+width);
            peakInput.Text="-61";excludeInput.Text="-86";
            Check(rendered.ScanPeakThresholdDbm==-61&&rendered.ScanExclusionThresholdDbm==-86&&ReferenceEquals(rendered.Points,originalPoints),"Editing thresholds updates references without rewriting measured samples "+width);
            Check(window.ScanPlanningFixture().Number("scanThresholdDbm")==-86,"Exclusion threshold participates in scan planning "+width);
            var planningInput=window.ScanPlanningFixture();
            Check(planningInput.Field("autoExpandRange").True(),"Native planning enables automatic range expansion "+width);
            var sources=planningInput.GetProperty("scanPeakCarriers").EnumerateArray().ToArray();
            Check(sources.Length==1&&sources[0].Number("frequencyKHz")==650001&&sources[0].Number("levelDbm")==-42,"Native planning receives the exact displayed above-threshold peak "+width);
            excludeInput.Text="NaN";
            Check(rendered.ScanExclusionThresholdDbm==-86,"Invalid threshold cannot replace confirmed value "+width);
            excludeInput.Text="-85";
            Descendants<Button>(root).Single(b=>Equals(b.Content,"⤢ 适配设备")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
            Check(rendered.StartMHz==627.5&&rendered.EndMHz==702.5,"Actual fit button uses distinct frequency spacing "+width);
            Check(ReferenceEquals(rendered.Points,originalPoints),"Fitting view preserves real scan samples "+width);
            window.Close();
        }
        VerifySpectrumReception(directory,rules,Check);
        VerifyWwbRecords(directory,Check);
        File.WriteAllText(Path.Combine(directory,"spectrum-verification.json"),JsonSerializer.Serialize(new{passed=true,checks,networkRequests=0,deviceCommands=0},new JsonSerializerOptions{WriteIndented=true}));
    }

    private static void VerifySpectrumReception(string directory,MonitoringRules rules,Action<bool,string> check)
    {
        Channel Device(double? rf,string? antenna="XX",string meter="live",string[]? stale=null,bool online=true)=>Channel.Parse(JsonSerializer.SerializeToElement(new {
            id="rf-floor",receiver_id="rx-floor",receiver_ip="192.0.2.16",channel_number=1,brand="Shure",model="ULXD4",
            freq=640000,rf,_source="shure-scp",_online=online,status=online?"online":"offline",
            shure=new{schema="daty-shure-telemetry-v1",rf_antenna=antenna,meter_state=meter,stale_fields=stale??[]}
        }));
        foreach(var width in new[]{1024,1366,1920})
        {
            IReadOnlyList<ScanPoint> samples=[new(639975,-102),new(640000,-100),new(640025,-102)];
            var sourceValues=samples.ToArray();
            var plot=new SpectrumPlot{Width=width-270,Height=450,StartMHz=630,EndMHz=700,MonitoringRules=rules,Points=samples};
            (RenderTargetBitmap Bitmap,byte[] Pixels) Render(Channel channel)
            {
                plot.Channels=[channel];plot.InvalidateVisual();
                plot.Measure(new(plot.Width,plot.Height));plot.Arrange(new(0,0,plot.Width,plot.Height));plot.UpdateLayout();
                var bitmap=new RenderTargetBitmap((int)plot.Width,(int)plot.Height,96,96,PixelFormats.Pbgra32);bitmap.Render(plot);
                var pixels=new byte[bitmap.PixelWidth*bitmap.PixelHeight*4];bitmap.CopyPixels(pixels,bitmap.PixelWidth*4,0);
                return(bitmap,pixels);
            }
            bool Green(byte[] pixels)=>Enumerable.Range(0,pixels.Length/4).Any(i=>pixels[i*4+1]>100&&pixels[i*4+1]>pixels[i*4+2]*1.4&&pixels[i*4+1]>pixels[i*4]*1.2);
            bool GrayAtFloor(byte[] pixels)
            {
                var x=(int)plot.SpectrumX(640);var bottom=(int)plot.SpectrumArea.Bottom;
                return Enumerable.Range(x-2,5).Any(px=>Enumerable.Range(bottom-6,4).Any(py=>{
                    var i=(py*(int)plot.Width+px)*4;
                    return Math.Abs(pixels[i]-181)<16&&Math.Abs(pixels[i+1]-141)<16&&Math.Abs(pixels[i+2]-124)<16;
                }));
            }
            void Save(RenderTargetBitmap bitmap,string name)
            {
                var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));
                using var stream=File.Create(Path.Combine(directory,$"spectrum-rf-{name}-{width}.png"));encoder.Save(stream);
            }
            byte[]? offPixels=null;
            foreach(var rf in new[]{-100d,-85,-60,-40,-100,-60})
            {
                var channel=Device(rf);var raw=channel.Raw.GetRawText();var frame=Render(channel);
                check(!Green(frame.Pixels)&&GrayAtFloor(frame.Pixels),$"ULXD XX noise {rf} renders only a gray floor marker {width}");
                check(offPixels is null||offPixels.SequenceEqual(frame.Pixels),$"Changing XX noise {rf} cannot move the marker or alter the scan trace {width}");
                offPixels??=frame.Pixels;
                var hover=plot.SpectrumHover(new(plot.SpectrumX(640),plot.SpectrumArea.Bottom-4));
                check(hover?.Contains("话筒离线")==true&&!hover.Contains("dBm"),$"Offline floor hover does not claim a measured RF value {rf} {width}");
                if(rf!=-100)check(plot.SpectrumHover(new(plot.SpectrumX(640),plot.SpectrumY(rf))) is null,$"Old raw RF height has no invisible stem hit {rf} {width}");
                check(plot.SpectrumHover(new(plot.SpectrumX(640),plot.SpectrumY(-100)))?.Contains("历史文件采样")==true,$"Offline marker does not hide the measured scan noise tooltip {rf} {width}");
                check(channel.RfDbm==rf&&channel.Raw.GetRawText()==raw&&ReferenceEquals(plot.Points,samples)&&plot.Points.SequenceEqual(sourceValues),$"Rendering preserves original RF and scan samples {rf} {width}");
                check(SpectrumPresentation.Count([channel],630,700)==1&&SpectrumPresentation.Fit([channel]) is (639,641),$"Offline transmitter frequency remains counted and fitted {rf} {width}");
                if(rf==-40)Save(frame.Bitmap,"offline");
            }
            foreach(var antenna in new[]{"AX","XB"})
            {
                var frame=Render(Device(-60,antenna));
                check(Green(frame.Pixels),$"Fresh {antenna} restores the actual green RF height {width}");
                check(plot.SpectrumHover(new(plot.SpectrumX(640)+2,plot.SpectrumY(-60)+2))?.Contains("-60 dBm")==true,$"Fresh {antenna} marker hover reports actual RF {width}");
                if(antenna=="XB")Save(frame.Bitmap,"recovered");
            }
            // A real marker keeps priority over a same-frequency stem and scan peak.
            plot.Points=[new(640000,-60)];plot.ScanPeakThresholdDbm=-70;
            var live=Device(-60,"AX");Render(live);
            plot.Channels=[live,Device(-75,"XB") with{Id="same-frequency"}];plot.InvalidateVisual();plot.UpdateLayout();
            var sameFrequency=plot.SpectrumHover(new(plot.SpectrumX(640)+2,plot.SpectrumY(-60)+2));
            check(sameFrequency?.Contains("Shure")==true&&sameFrequency.Contains("-60 dBm"),"Actual marker wins over same-frequency stem and scan peak "+width);
            plot.Points=samples;plot.ScanPeakThresholdDbm=null;
            foreach(var channel in new[]{Device(-40,"AX",stale:["rf_dbm"]),Device(-40,"XX",meter:"stale"),Device(-40,"XX",stale:["rf_antenna"]),Device(null,"AX"),Device(-40,null)})
            {
                var frame=Render(channel);var hover=plot.SpectrumHover(new(plot.SpectrumX(640),plot.SpectrumArea.Bottom-4));
                check(!Green(frame.Pixels)&&GrayAtFloor(frame.Pixels)&&hover?.Contains("RF 未知")==true&&!hover.Contains("dBm"),"Unknown telemetry stays at the gray floor without a fabricated RF value "+width);
                check(plot.SpectrumHover(new(plot.SpectrumX(640),plot.SpectrumY(-40))) is null,"Unknown telemetry cannot hit the previous RF height "+width);
            }
            plot.MonitoringRules=null;var unloaded=Render(Device(-40,"AX"));
            check(!Green(unloaded.Pixels)&&GrayAtFloor(unloaded.Pixels)&&plot.SpectrumHover(new(plot.SpectrumX(640),plot.SpectrumArea.Bottom-4))?.Contains("数据库显示规则尚未读取")==true,"Missing rules cannot create live RF with a local default "+width);
            plot.MonitoringRules=rules;var disconnected=Render(Device(-40,"AX",online:false));
            check(!Green(disconnected.Pixels)&&!GrayAtFloor(disconnected.Pixels)&&plot.SpectrumHover(new(plot.SpectrumX(640),plot.SpectrumArea.Bottom-4)) is null,"Disconnected receiver has no frequency marker or device hover "+width);
            check(SpectrumPresentation.Count(plot.Channels,630,700)==0&&SpectrumPresentation.Fit(plot.Channels) is null,"Disconnected receiver remains excluded from count and fit "+width);
            var custom=System.Text.Json.Nodes.JsonNode.Parse(rules.Document.GetRawText())!;custom["transmitter"]!["offlineBelowDbm"]=-100;
            plot.MonitoringRules=MonitoringRules.Parse(JsonSerializer.SerializeToElement(custom));
            var dbChanged=Render(Device(-95,"AX"));
            check(Green(dbChanged.Pixels)&&plot.SpectrumHover(new(plot.SpectrumX(640),plot.SpectrumY(-95)))?.Contains("-95 dBm")==true,"Changed database threshold controls the real rendered RF height "+width);
            plot.MonitoringRules=rules;var offAgain=Render(Device(-95,"AX"));
            check(!Green(offAgain.Pixels)&&GrayAtFloor(offAgain.Pixels)&&offAgain.Pixels.SequenceEqual(offPixels!),"Restoring database threshold returns to the stable floor marker "+width);
            check(ReferenceEquals(plot.Points,samples)&&plot.Points.SequenceEqual(sourceValues),"All reception transitions preserve the original imported scan samples "+width);
        }
    }

    private static void VerifyWwbRecords(string directory,Action<bool,string> check)
    {
        ScanDocument Record(int id,double peak)
        {
            IReadOnlyList<ScanPoint>[] segments=[[new(640000,-97),new(640025,peak)],[new(640075,-75),new(640100,-70)]];
            return new("isolated-missing-point.sdb3",new string('0',64),segments.SelectMany(s=>s).ToArray(),0,default)
                {SourceLabel="WWB 文件",RecordLabel="记录 "+id,MissingPoints=3,SampleStepKHz=25,GridStartKHz=639975,GridEndKHz=640125,TraceSegments=segments};
        }
        var records=new[]{Record(1,-14),Record(0,-55)};
        var window=new MainWindow(true){Width=1366,Height=768};window.SetScanRecordsFixture(records);window.ShowPage("spectrum");
        var root=(FrameworkElement)window.Content;root.Measure(new(1366,768));root.Arrange(new(0,0,1366,768));root.UpdateLayout();
        var plot=Descendants<SpectrumPlot>(root).Single();
        var bitmap=new RenderTargetBitmap((int)plot.ActualWidth,(int)plot.ActualHeight,96,96,PixelFormats.Pbgra32);bitmap.Render(plot);
        check(plot.PointSegments?.Count==2&&plot.Points.Count==4,"WWB renderer receives two valid runs and no invented fifth point");
        check(plot.StartMHz==639.975&&plot.EndMHz==640.125,"WWB full grid keeps missing first and last slots visible");
        var planning=window.ScanPlanningFixture();
        check(planning.Number("maxScanGapKHz")==25&&planning.Field("scanPoints").GetArrayLength()==4,"WWB planning preserves strict grid gap and only measured points");
        check(Math.Abs(plot.SpectrumY(-20)-plot.SpectrumArea.Top)<.01&&Math.Abs(plot.SpectrumY(-110)-plot.SpectrumArea.Bottom)<.01,"Spectrum axis is fixed from -20 to -110 dBm");
        check(Math.Abs((plot.SpectrumY(-30)-plot.SpectrumY(-20))-(plot.SpectrumY(-110)-plot.SpectrumY(-100)))<.01,"Ten dB grid intervals use the same linear spacing");
        check(plot.Points[1].LevelDbm==-14&&plot.SpectrumY(-14)<plot.SpectrumArea.Top&&plot.SpectrumY(-120)>plot.SpectrumArea.Bottom,"Out-of-range measurements retain their values and clip without clamping");
        var hover=plot.SpectrumHover(new(plot.SpectrumX(640),plot.SpectrumY(-97)));
        check(hover?.Contains("WWB 文件 · 记录 1")==true&&hover.Contains("640.000 MHz · -97 dBm"),"WWB hover reports exact frequency, level, source and selected record");
        check(plot.SpectrumHover(new(plot.SpectrumX(640.025),plot.SpectrumY(-14))) is null,"Clipped out-of-range scan point has no invented edge reading");
        check(plot.SpectrumHover(new(plot.SpectrumX(640.05),plot.SpectrumY(-45))) is null,"Missing WWB slot has no invented tooltip value");
        var pixels=new byte[bitmap.PixelWidth*bitmap.PixelHeight*4];bitmap.CopyPixels(pixels,bitmap.PixelWidth*4,0);
        bool PurpleAt(int x,int y){var i=(y*bitmap.PixelWidth+x)*4;return pixels[i]>150&&pixels[i]-pixels[i+2]>80&&pixels[i]-pixels[i+1]>70;}
        var gap=(int)plot.SpectrumX(640.05);
        check(!Enumerable.Range(Math.Max(0,gap-2),5).Any(x=>Enumerable.Range((int)plot.SpectrumArea.Top,(int)plot.SpectrumArea.Height).Any(y=>PurpleAt(x,y))),"Rendered WWB line and fill do not bridge a missing frequency slot");
        var full=new RenderTargetBitmap(1366,768,96,96,PixelFormats.Pbgra32);full.Render(root);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(full));using(var output=File.Create(Path.Combine(directory,"spectrum-wwb-missing-1366.png")))encoder.Save(output);
        var selector=Descendants<ComboBox>(root).Single(c=>System.Windows.Automation.AutomationProperties.GetAutomationId(c)=="ScanRecordSelector");
        check(selector.Visibility==Visibility.Visible&&selector.Items.Count==2,"WWB multiple records can be selected");
        check(Descendants<TextBlock>(selector).Any(t=>t.Text=="记录 1"),"WWB selected record displays its label instead of a raw object");selector.SelectedIndex=1;
        check(plot.Points[1].LevelDbm==-55&&ReferenceEquals(plot.PointSegments,records[1].TraceSegments),"Selecting a record replaces only the current file trace");
        JsonElement LiveReply(string state,double? level,bool finalized,string handshake,string? error=null)=>JsonSerializer.SerializeToElement(new {
            schema="daty-live-scan-v1",operation_id="isolated-live-scan",target=new{device_id="isolated-receiver"},state,finalized,
            actual_range=new{start_khz=640000,end_khz=640050,step_khz=25},
            points=new double?[][]{[640000,null],[640025,level],[640050,null]},received_points=level is null?0:1,missing_points=level is null?3:2,
            device_ended=state=="partial",coverage_complete=false,complete=false,start_sent=level is not null,device_started=level is not null,
            handshake_state=handshake,handshake_complete=handshake=="ready",error
        });
        var importedPoints=plot.Points;var importedSegments=plot.PointSegments;
        var summary=window.ApplyLiveScanFixture(LiveReply("starting",null,false,"confirming"));
        check(ReferenceEquals(plot.Points,importedPoints)&&ReferenceEquals(plot.PointSegments,importedSegments),"Handshake with an all-missing grid preserves the selected imported curve");
        check(summary.Contains("正在等待接收机确认扫描会话"),"Handshake status explains the pending receiver confirmation");
        summary=window.ApplyLiveScanFixture(LiveReply("failed",null,true,"failed","SCAN_SESSION_KEY_STATUS_TIMEOUT"));
        check(ReferenceEquals(plot.Points,importedPoints)&&summary.Contains("接收机未确认扫描会话，扫描未开始"),"Failed handshake preserves existing samples and reports the real failure");
        window.ApplyLiveScanFixture(LiveReply("partial",-52,true,"ready"));
        check(!ReferenceEquals(plot.Points,importedPoints)&&plot.Points.Count==1&&plot.Points[0].FrequencyKHz==640025&&plot.Points[0].LevelDbm==-52&&plot.PointSegments?.Count==1,"Strictly validated live data replaces the imported curve without inventing missing samples");
        check(plot.StartMHz==640&&plot.EndMHz==640.05,"First valid live data uses its confirmed grid range");
        Descendants<Button>(root).Single(b=>Equals(b.Content,"🧹 清除扫描")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
        check(plot.Points.Count==0&&plot.PointSegments is null&&selector.Visibility==Visibility.Collapsed,"Clearing current session removes all file records and missing runs");
        window.Close();
    }
}
