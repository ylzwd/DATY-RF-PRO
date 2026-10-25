using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Daty.Native.Core;

namespace Daty.Native.App;

internal static partial class UiVerification
{
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T : DependencyObject
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++) { var child = VisualTreeHelper.GetChild(root, i); if (child is T typed) yield return typed; foreach (var item in Descendants<T>(child)) yield return item; }
    }
    private static Rect[] VerifyPlannerLayout(MainWindow window,int width,int height,string view,string directory)
    {
        var page=(Grid)window.PageContent.Content;
        var top=page.Children.OfType<Grid>().Single(g=>Grid.GetRow(g)==0);
        var left=top.Children.OfType<Border>().Single(b=>Grid.GetColumn(b)==0);
        var right=top.Children.OfType<Border>().Single(b=>Grid.GetColumn(b)==1);
        Rect Bounds(FrameworkElement element,UIElement ancestor)=>new(element.TranslatePoint(new Point(),ancestor),element.RenderSize);
        var l=Bounds(left,page);var r=Bounds(right,page);
        if(l.Width<=r.Width || Math.Abs(l.Top-r.Top)>.5 || Math.Abs(l.Bottom-r.Bottom)>.5)
            throw new Exception("Planner cards must be wider on left and aligned: "+view+" "+width);
        if(Descendants<ScrollViewer>(left).Any(s=>s.ComputedVerticalScrollBarVisibility==Visibility.Visible))
            throw new Exception("Planner editor still has a vertical scrollbar");
        foreach(var element in Descendants<FrameworkElement>(left).Where(e=>e is TextBox or ComboBox or Button)) {
            if(element.ActualWidth<=0||element.ActualHeight<=0)continue;
            var b=Bounds(element,left);
            if(b.Left<-.5||b.Top<-.5||b.Right>left.ActualWidth+.5||b.Bottom>left.ActualHeight+.5)
                throw new Exception("Planner control clipped: "+view+" "+width+" "+element.GetType().Name);
        }
        var fields=Descendants<FrameworkElement>(left).Where(e=>Equals(e.Tag,"planner-field")).ToArray();
        if(fields.Length!=10||fields.Max(e=>e.ActualWidth)-fields.Min(e=>e.ActualWidth)>1)throw new Exception("Planner field widths differ: "+view+" "+width+" "+string.Join(",",fields.Select(e=>e.ActualWidth)));
        var rules=Descendants<CheckBox>(left).Where(c=>System.Windows.Automation.AutomationProperties.GetAutomationId(c).StartsWith("PlannerImd",StringComparison.Ordinal)).ToArray();
        if(rules.Length!=5||!rules.Select(c=>c.Content?.ToString()).SequenceEqual(new[]{"2T30","2T50","2T70","2T90","3T30"}))throw new Exception("Planner must expose five independent IMD rules");
        if(Descendants<Button>(left).Any(b=>b.Content?.ToString() is "重试保存" or "重试读取"))throw new Exception("Planner retry button must be removed");
        var table=Descendants<DataGrid>(page).Single();var tableBounds=Bounds(table,page);
        var lower=page.Children.OfType<Border>().Single(b=>Grid.GetRow(b)==1);
        var pager=((Grid)lower.Child).Children.OfType<Grid>().Single(g=>Grid.GetRow(g)==2);
        if(tableBounds.Top<l.Bottom||tableBounds.Height<70||tableBounds.Bottom>Bounds(pager,page).Top+.5||tableBounds.Bottom>page.ActualHeight+.5)
            throw new Exception($"Frequency table must remain reachable: {view} {width}; table={tableBounds}; pager={Bounds(pager,page)}; page={page.RenderSize}");
        if(width is 1024 or 1920) {
            var root=(FrameworkElement)window.Content;var bitmap=new RenderTargetBitmap(width,height,96,96,PixelFormats.Pbgra32);bitmap.Render(root);
            var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using var output=File.Create(Path.Combine(directory,view.Replace(':','-')+"-"+width+".png"));encoder.Save(output);
        }
        var run=Descendants<Button>(left).Single(button=>button.Content?.ToString()?.Contains("一键全局规划")==true);
        return [l,r,Bounds(run,page),tableBounds];
    }
    public static async Task RunAsync(string directory)
    {
        Directory.CreateDirectory(directory);
        await VerifyProtocolsAsync(directory);
        VerifyTransmitter(directory);
        VerifySpectrum(directory);
        VerifyScanHardwareProfileDialog(directory);
        VerifyPluginStateOrdering(directory);
        var raw = JsonSerializer.SerializeToElement(new { success = true, server_time_ms = 1789296000000L,
            devices = Enumerable.Range(1, 64).Reverse().Select(n => new { id = "fixture-rx-ch" + n, receiver_id = "fixture-rx-" + (4-(n-1)%4), receiver_ip = "192.0.2.16", channel_number = (n-1)/4+1, group_number = new[]{1,2,10,20}[(n-1)%4], group_source = "server-fifo-v1", brand = "DATYaudio", model = "RF PRO", name = "隔离样例 CH" + n, freq = 641000 + (n - 1) * 250, rf = -50 - n % 30, af_dbfs = n % 2 == 0 ? (double?)null : -20, batt = 87, muted = false, _online = true, status = "online", heartbeat = new { status = "measured", rtt_ms = 1.23, age_ms = 10, max_age_ms = 5000 } }).ToArray() });
        var snapshot = DeviceSnapshot.Parse(raw);
        var expected = ChannelOrder.Sort(snapshot.Channels).Select(c => c.Id).ToArray();
        var results = new List<object>();var plannerSwitches=new List<object>();
        foreach (var (width, height) in new[] { (1024, 700), (1280, 720), (1366, 768), (1440, 900), (1920, 1080) })
        {
            var window = new MainWindow(true) { Width = width, Height = height };
            window.SetVerificationSnapshot(snapshot);window.SetSurfaceFixtures();
            Rect[]? plannerBaseline=null;
            foreach(var tab in new[]{"basic","constraints","basic"}) {
                if(plannerBaseline is null)window.ShowVerificationView("planner:basic");
                else Descendants<Button>((DependencyObject)window.PageContent.Content).Single(button=>Equals(button.Content,tab=="basic"?"基本设置":"规划约束")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                var plannerRoot=(FrameworkElement)window.Content;
                void Layout(){plannerRoot.Measure(new Size(width,height));plannerRoot.Arrange(new Rect(0,0,width,height));plannerRoot.UpdateLayout();}
                Layout();await window.Dispatcher.InvokeAsync(()=>{},DispatcherPriority.Render);
                var bounds=VerifyPlannerLayout(window,width,height,"planner:"+tab,directory);
                if(plannerBaseline is not null&&!bounds.SequenceEqual(plannerBaseline))throw new Exception("Planner tab switch moved card, summary, action or table: "+width);
                plannerBaseline??=bounds;
                var status=Descendants<TextBlock>((DependencyObject)window.PageContent.Content).Single(t=>System.Windows.Automation.AutomationProperties.GetAutomationId(t)=="PlannerSaveStatus");status.Text="未保存：其他窗口已更新规划设置 · 点击核对并保存";Layout();
                if(!VerifyPlannerLayout(window,width,height,"planner:"+tab,directory).SequenceEqual(plannerBaseline))throw new Exception("Planner save status resized card: "+width);
                plannerSwitches.Add(new{width,height,tab,controlHeight=bounds[0].Height,summaryHeight=bounds[1].Height,runTop=bounds[2].Top,tableTop=bounds[3].Top,stable=true});
            }
            foreach (var (key, _) in MainWindow.Pages)
            {
                window.ShowPage(key);
                var root = (FrameworkElement)window.Content;
                root.Measure(new Size(width, height)); root.Arrange(new Rect(0, 0, width, height)); root.UpdateLayout();window.LoadSurfaceFixtures();root.UpdateLayout();
                await window.Dispatcher.InvokeAsync(() => { }, DispatcherPriority.Render);
                if (!double.IsFinite(root.ActualWidth) || root.ActualWidth <= 0 || root.ActualHeight <= 0) throw new Exception("Invalid layout: " + key);
                if (Descendants<TextBlock>(root).Any(x => x.Text.Contains("NaN"))) throw new Exception("NaN in view: " + key);
                if (key == "devices" && Descendants<DataGrid>(root).Single().Items.Count != 20) throw new Exception("Device pagination must be 20");
                if (key == "devices" && !Descendants<DataGrid>(root).Single().Items.Cast<Channel>().Select(c => c.Id).SequenceEqual(expected.Take(20))) throw new Exception("Device GROUP/CH order must precede pagination");
                foreach(var table in Descendants<DataGrid>(root)){
                    var widths=table.Columns.Where(c=>c.Visibility==Visibility.Visible).Select(c=>c.ActualWidth).ToArray();
                    if(widths.Length>0&&widths.Max()-widths.Min()>1)throw new Exception("Table columns must distribute evenly: "+key);
                }
                if (key == "channels")
                {
                    var cards = Descendants<Border>(root).Count(b => b.Tag is string id && id.StartsWith("fixture-rx-ch"));
                    if (cards != 50) throw new Exception("Channel pagination must be 50, got " + cards);
                    if (!Descendants<Border>(root).Select(b => b.Tag).OfType<string>().Where(id => id.StartsWith("fixture-rx-ch")).SequenceEqual(expected.Take(50))) throw new Exception("Channel GROUP/CH order must precede pagination");
                    var cardViews=Descendants<Border>(root).Where(b=>b.Tag is string id&&id.StartsWith("fixture-rx-ch")).ToArray();
                    var area=(FrameworkElement)window.PageContent.Content;
                    var rectangles=cardViews.Select(b=>b.TransformToAncestor(area).TransformBounds(new Rect(b.RenderSize))).ToArray();
                    var headerBottom=((Grid)area).Children.Cast<UIElement>().Where(e=>Grid.GetRow(e)==0).OfType<FrameworkElement>().Max(e=>e.TranslatePoint(new Point(0,e.ActualHeight),area).Y);
                    var pagerTop=((Grid)area).Children.Cast<UIElement>().Where(e=>Grid.GetRow(e)==2).OfType<FrameworkElement>().Min(e=>e.TranslatePoint(new Point(),area).Y);
                    if(rectangles.Any(r=>r.Width<=0||r.Height<=0||r.Left<-.1||r.Right>area.ActualWidth+.1||r.Top<headerBottom-.1||r.Bottom>pagerTop+.1))throw new Exception("All 50 channel cards must fit between header and pager: "+width);
                    for(int i=0;i<rectangles.Length;i++)for(int j=i+1;j<rectangles.Length;j++)if(Rect.Intersect(rectangles[i],rectangles[j]) is var overlap&&!overlap.IsEmpty&&overlap.Width>.1&&overlap.Height>.1)throw new Exception("Channel cards overlap");
                    if(width is 1366 or 1920){var firstBitmap=new RenderTargetBitmap(width,height,96,96,PixelFormats.Pbgra32);firstBitmap.Render(root);var firstEncoder=new PngBitmapEncoder();firstEncoder.Frames.Add(BitmapFrame.Create(firstBitmap));using var firstOutput=File.Create(Path.Combine(directory,$"channels-50-{width}.png"));firstEncoder.Save(firstOutput);}
                    var next = Descendants<Button>(root).Single(b => Equals(b.Content, "下一页")); next.RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
                    root.Measure(new Size(width, height)); root.Arrange(new Rect(0, 0, width, height)); root.UpdateLayout();
                    cards = Descendants<Border>(root).Count(b => b.Tag is string id && id.StartsWith("fixture-rx-ch"));
                    if (cards != 14) throw new Exception("Remaining channels must all be reachable");
                    if (!Descendants<Border>(root).Select(b => b.Tag).OfType<string>().Where(id => id.StartsWith("fixture-rx-ch")).SequenceEqual(expected.Skip(50))) throw new Exception("Second channel page changed GROUP/CH order");
                }
                if(key=="planner")VerifyPlannerLayout(window,width,height,key,directory);
                if (width == 1366)
                {
                    var bitmap = new RenderTargetBitmap((int)root.ActualWidth, (int)root.ActualHeight, 96, 96, PixelFormats.Pbgra32); bitmap.Render(root);
                    var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap)); using var output = File.Create(Path.Combine(directory, key + "-1366.png")); encoder.Save(output);
                }
                results.Add(new { width, height, page = key, rendered = true });
            }
            foreach(var view in new[]{"devices:scan","devices:protocol","planner:constraints","data:config"}) {
                window.ShowVerificationView(view);var root=(FrameworkElement)window.Content;root.Measure(new Size(width,height));root.Arrange(new Rect(0,0,width,height));root.UpdateLayout();window.LoadSurfaceFixtures();root.UpdateLayout();await window.Dispatcher.InvokeAsync(()=>{},DispatcherPriority.Render);
                if(Descendants<TextBlock>(root).Any(t=>t.Text.Contains("NaN")))throw new Exception("NaN in "+view);
                if(view=="planner:constraints")VerifyPlannerLayout(window,width,height,view,directory);
                if(width==1366){var bitmap=new RenderTargetBitmap(width,height,96,96,PixelFormats.Pbgra32);bitmap.Render(root);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using var output=File.Create(Path.Combine(directory,view.Replace(':','-')+"-1366.png"));encoder.Save(output);}
                results.Add(new {width,height,page=view,rendered=true});
            }
            foreach(var (title,dialogRoot) in window.BuildSurfaceDialogFixtures()) {
                var dw=Math.Min(740,width-40);var dh=Math.Min(610,height-40);dialogRoot.Measure(new Size(dw,dh));dialogRoot.Arrange(new Rect(0,0,dw,dh));dialogRoot.UpdateLayout();await window.Dispatcher.InvokeAsync(()=>{},DispatcherPriority.Render);
                if(Descendants<TextBlock>(dialogRoot).Any(t=>t.Text.Contains("NaN")))throw new Exception("NaN in modal "+title);
                if(width==1366){var bmp=new RenderTargetBitmap(dw,dh,96,96,PixelFormats.Pbgra32);bmp.Render(dialogRoot);var enc=new PngBitmapEncoder();enc.Frames.Add(BitmapFrame.Create(bmp));using var output=File.Create(Path.Combine(directory,"dialog-"+string.Concat(title.Select(c=>Path.GetInvalidFileNameChars().Contains(c)?'_':c))+".png"));enc.Save(output);}
                results.Add(new{width,height,page=title,rendered=true});
            }
            window.SetVerificationSnapshot(snapshot, false); window.ShowVerificationView("devices:online");
            var finalRoot = (FrameworkElement)window.Content;
            finalRoot.Measure(new Size(width, height)); finalRoot.Arrange(new Rect(0, 0, width, height)); finalRoot.UpdateLayout();
            var deviceTable = Descendants<DataGrid>(window.Content as DependencyObject ?? window).Single();
            if (deviceTable.Items.Cast<Channel>().Any(c => c.Online || c.Rtt != "—")) throw new Exception("Disconnect must clear online and RTT");
            window.Close();
        }
        File.WriteAllText(Path.Combine(directory,"planner-switch-verification.json"),JsonSerializer.Serialize(new{passed=true,scenes=plannerSwitches.Count,networkRequests=0,deviceCommands=0,results=plannerSwitches}));
        var reference=new MainWindow(true){Width=1913,Height=950};reference.SetVerificationRange(630,700);reference.SetVerificationSnapshot(DeviceSnapshot.Parse(JsonSerializer.SerializeToElement(new{success=true,devices=new[]{new{id="ref1",receiver_id="ref1",channel_number=1,group_number=1,group_source="server-fifo-v1",brand="DATYaudio",model="RF PRO",freq=640000,rf=-30,afDbfs=-20,batt=90,_online=true,status="online"},new{id="ref2",receiver_id="ref2",channel_number=1,group_number=2,group_source="server-fifo-v1",brand="Shure",model="ULXD4",freq=690000,rf=-30,afDbfs=-20,batt=90,_online=true,status="online"}}})));reference.ShowPage("dashboard");var referenceRoot=(FrameworkElement)reference.Content;referenceRoot.Measure(new Size(1913,950));referenceRoot.Arrange(new Rect(0,0,1913,950));referenceRoot.UpdateLayout();var referenceBitmap=new RenderTargetBitmap(1913,950,96,96,PixelFormats.Pbgra32);referenceBitmap.Render(referenceRoot);var referenceEncoder=new PngBitmapEncoder();referenceEncoder.Frames.Add(BitmapFrame.Create(referenceBitmap));using(var output=File.Create(Path.Combine(directory,"reference-dashboard-1913.png")))referenceEncoder.Save(output);reference.Close();
        File.WriteAllText(Path.Combine(directory, "ui-verification.json"), JsonSerializer.Serialize(new { passed = true, renderedPages = results.Count, viewports = 5, devicePageSize = 20, channelPageSize = 50, all64ChannelsReachable = true, disconnectChecked = true, networkRequests = 0, deviceCommands = 0, source = "isolated fixtures, not live server", results }, new JsonSerializerOptions { WriteIndented = true }));
    }
}
