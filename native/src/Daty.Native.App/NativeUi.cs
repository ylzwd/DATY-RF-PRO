using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Threading;

namespace Daty.Native.App;

public partial class MainWindow
{
    private readonly DispatcherTimer toastTimer = new() { Interval=TimeSpan.FromSeconds(8) };
    private readonly DispatcherTimer archiveTimer=new(){Interval=TimeSpan.FromSeconds(30)};
    private static Grid Columns(params GridLength[] lengths) { var g=new Grid(); foreach(var v in lengths)g.ColumnDefinitions.Add(new(){Width=v}); return g; }
    private static void At(Grid parent, UIElement child,int row=0,int col=0) { Grid.SetRow(child,row);Grid.SetColumn(child,col);parent.Children.Add(child); }
    private static GridLength Star(double n=1)=>new(n,GridUnitType.Star);
    private static Border Panel(UIElement child, double padding=18, Thickness? margin=null) => new(){ Background=B("#111520"),BorderBrush=B("#242c42"),BorderThickness=new(1),CornerRadius=new(10),Padding=new(padding),Margin=margin??new(),Child=child };
    private static TextBlock Heading(string text,int size=14) {var t=Text(text,size);t.FontWeight=FontWeights.Bold;SetHeadingText(t,text);return t;}
    private static void SetHeadingText(TextBlock block,string text) {
        var icon=text.StartsWith("📊")?"dashboard":text.StartsWith("📡")?"channels":text.StartsWith("📈")?"spectrum":text.StartsWith("🧮")?"planner":text.StartsWith("🔌")?"devices":text.StartsWith("💾")?"data":text.StartsWith("⚙")?"settings":null;
        block.Text=text;if(icon is null)return;var path=System.IO.Path.Combine(AppContext.BaseDirectory,"assets","ui",icon+".png");if(!System.IO.File.Exists(path))return;block.Inlines.Clear();block.Inlines.Add(new System.Windows.Documents.InlineUIContainer(new Image{Source=new System.Windows.Media.Imaging.BitmapImage(new Uri(path)),Width=16,Height=16,Margin=new(0,0,5,0)}){BaselineAlignment=BaselineAlignment.Center});block.Inlines.Add(new System.Windows.Documents.Run(text[(text.IndexOf(' ')+1)..]));
    }
    private static Button ActionButton(string title,Action action,string style="") {var b=Button(title,action);if(style.Length>0)b.SetResourceReference(StyleProperty,style);return b;}
    private static Button UnavailableButton(string title,string reason,string style="") {var b=ActionButton(title,()=>{},style);b.IsEnabled=false;b.ToolTip=reason;ToolTipService.SetShowOnDisabled(b,true);return b;}
    private static Grid HeaderRow(string title,params UIElement[] buttons) { var grid=Columns(Star(),GridLength.Auto);At(grid,Heading(title));var actions=Horizontal(buttons);actions.HorizontalAlignment=HorizontalAlignment.Right;At(grid,actions,0,1);grid.Margin=new(0,0,0,14);return grid; }
    private static ScrollViewer Scroll(UIElement content)=>new(){Style=(Style)Application.Current.FindResource("CompactScrollViewer"),Content=content,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,HorizontalScrollBarVisibility=ScrollBarVisibility.Disabled};
    private static ComboBox Select(string[] values,int selected=0,double minWidth=110) {var c=new ComboBox {MinWidth=minWidth,ItemsSource=values,SelectedIndex=selected,Margin=new(0,0,8,0)};return c;}
    private static TextBox Input(string text="",double width=double.NaN) => new(){Text=text,Width=width,MinWidth=40};
    private static UIElement Labeled(string label,UIElement input,string? hint=null) {var p=new StackPanel();p.Children.Add(Text(label,11,"#7c8db5",new(0,0,0,4)));p.Children.Add(input);if(hint is not null)p.Children.Add(Text(hint,10,"#7c8db5",new(0,3,0,0)));return p;}
    private static Border Hint(string text,string color="#7c8db5")=>new(){Child=Text(text,11,color),Padding=new(10,8,10,8),CornerRadius=new(6),Background=B("#15192c"),BorderBrush=B("#313155"),BorderThickness=new(1)};
    private static FrameworkElement Empty(string text) {var t=Text(text,13,"#7c8db5");t.TextAlignment=TextAlignment.Center;t.HorizontalAlignment=HorizontalAlignment.Center;t.VerticalAlignment=VerticalAlignment.Center;return t;}
    private static FrameworkElement Tabbed((string Key,string Label)[] items,string selected,Action<string> choose,UIElement content) {
        var grid=Rows(GridLength.Auto,Star());var line=new WrapPanel();
        foreach(var (key,label) in items){var b=ActionButton(label,()=>choose(key),"TabButton");b.Foreground=B(key==selected?"#6366f1":"#7c8db5");b.BorderBrush=B(key==selected?"#6366f1":"Transparent");line.Children.Add(b);}
        Put(grid,new Border{BorderBrush=B("#242c42"),BorderThickness=new(0,0,0,1),Child=line,Margin=new(0,0,0,16)},0);Put(grid,content,1);return grid;
    }
    private void InitializeParityShell() {
        sharedSettingsTimer.Tick+=async(_,_)=>await PollSharedSettingsAsync();Loaded+=(_,_)=>{if(!verification)sharedSettingsTimer.Start();};Activated+=async(_,_)=>await PollSharedSettingsAsync();Closed+=(_,_)=>sharedSettingsTimer.Stop();
        toastTimer.Tick+=(_,_)=>{StatusToast.Visibility=Visibility.Collapsed;toastTimer.Stop();};
        // Retired archive timer: real-time alert observation and sound continue.
        Closing += OnWindowClosing;
        SizeChanged+=(_,_)=>ApplyPageSpacing();Closed+=(_,_)=>{toastTimer.Stop();archiveTimer.Stop();};
    }
    private void ApplyPageSpacing() {var height=Shell.ActualHeight>0?Shell.ActualHeight:Height;PageContent.Margin=currentPage=="planner"?new Thickness(16,12,16,12):new Thickness(20,height<=800?12:20,20,height<=800?12:20);}
    private void ConnectionSettings_Click(object sender,RoutedEventArgs e)=>ShowConnectionDialog();
    private void AddDevice_Click(object sender,RoutedEventArgs e)=>ShowDeviceForm();
    private void ShowConnectionDialog() {
        if(Daty.Native.Core.ProjectEnvironment.Current is not null)return;
        var panel=new StackPanel();var address=Input(settings.Server);panel.Children.Add(Labeled("服务器地址",address));Paragraph(panel,"使用当前服务器地址，保留原有证书验证和接收机配对。","#7c8db5");Window? dialog=null;
        dialog=CreateSurfaceDialog("连接设置",panel,520,260,"DATY RF PRO · 网络设置","🌐",buttons:[ActionButton("取消",()=>dialog!.Close()),ActionButton("连接",()=>{dialog!.Close();_=SaveSettingsAsync(address.Text,settings.PollSeconds.ToString(CultureInfo.InvariantCulture));},"PrimaryButton")]);PresentDialog(dialog);
    }
}
