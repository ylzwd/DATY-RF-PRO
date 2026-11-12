using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace Daty.Native.App;

public partial class StartupWindow : Window
{
    private readonly Stopwatch elapsed=Stopwatch.StartNew();
    private readonly DispatcherTimer timer=new(){Interval=TimeSpan.FromSeconds(1)};
    public bool MotionEnabled { get; }=SystemParameters.ClientAreaAnimation&&!SystemParameters.HighContrast;
    public StartupWindow()
    {
        InitializeComponent();VersionLabel.Text=App.DisplayVersion;
        var icon=Path.Combine(AppContext.BaseDirectory,"assets","DATY-RF-PRO.ico");
        if(File.Exists(icon)){Icon=BitmapFrame.Create(new Uri(icon));ProductIcon.Source=Icon;}
        Width=Math.Min(720,SystemParameters.WorkArea.Width-32);Height=Math.Min(430,SystemParameters.WorkArea.Height-32);
        Loaded+=(_,_)=>{
            if(MotionEnabled)
            {
                Sweep.BeginAnimation(TranslateTransform.XProperty,new DoubleAnimation(-120,650,TimeSpan.FromSeconds(2.2)){RepeatBehavior=RepeatBehavior.Forever});
                SignalPulse.BeginAnimation(OpacityProperty,new DoubleAnimation(.3,1,TimeSpan.FromSeconds(.8)){AutoReverse=true,RepeatBehavior=RepeatBehavior.Forever});
            }
            timer.Start();
        };
        timer.Tick+=(_,_)=>ElapsedLabel.Text=elapsed.Elapsed.TotalSeconds<10?"":"已等待 "+(int)elapsed.Elapsed.TotalSeconds+" 秒";
        Closed+=(_,_)=>{timer.Stop();Sweep.BeginAnimation(TranslateTransform.XProperty,null);SignalPulse.BeginAnimation(OpacityProperty,null);};
    }
    public void SetStage(string stage)
    {
        var (index,text)=stage switch {
            "checking"=>(0,"正在检查程序"),"workspace"=>(1,"正在载入工作空间"),
            "services"=>(2,"正在连接本机服务"),"opening"=>(3,"正在打开射频工作台"),
            _=>(0,"正在准备启动")};
        StatusLabel.Text=text;
        var steps=new[]{Step0,Step1,Step2,Step3};
        for(var i=0;i<steps.Length;i++)steps[i].Background=new SolidColorBrush((Color)ColorConverter.ConvertFromString(i<=index?"#8183ff":"#28314a"));
        StageLabel.Text=stage=="waiting"?"等待启动任务":"检查 / 载入 / 连接 / 工作台";
    }
    public void ShowFailure(string message)
    {
        Title="DATY RF PRO · 启动未完成";StatusLabel.Text="启动未完成";StatusLabel.Foreground=Brushes.LightCoral;
        DetailLabel.Text=message;DetailLabel.ToolTip=message;StageLabel.Text="请关闭后重试";
        CloseButton.ToolTip="关闭";timer.Stop();Sweep.BeginAnimation(TranslateTransform.XProperty,null);SignalPulse.BeginAnimation(OpacityProperty,null);
    }
    private void DragWindow(object sender,MouseButtonEventArgs e){if(e.LeftButton==MouseButtonState.Pressed&&e.OriginalSource is not System.Windows.Controls.Button)try{DragMove();}catch(InvalidOperationException){}}
    private void CloseStartup(object sender,RoutedEventArgs e)=>Close();
    internal static async Task VerifyAsync(string directory)
    {
        Directory.CreateDirectory(directory);var window=new StartupWindow();window.Show();
        try
        {
            void Capture(string name){window.UpdateLayout();var bitmap=new RenderTargetBitmap((int)window.ActualWidth,(int)window.ActualHeight,96,96,PixelFormats.Pbgra32);bitmap.Render(window);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using var file=File.Create(Path.Combine(directory,name+".png"));encoder.Save(file);}
            await window.Dispatcher.InvokeAsync(()=>{},DispatcherPriority.ContextIdle);Capture("startup-01");
            await Task.Delay(650);Capture("startup-02");
            var changed=!SHA256.HashData(File.ReadAllBytes(Path.Combine(directory,"startup-01.png"))).SequenceEqual(SHA256.HashData(File.ReadAllBytes(Path.Combine(directory,"startup-02.png"))));
            if(window.MotionEnabled&&!changed)throw new InvalidDataException("Startup animation did not advance");
            foreach(var stage in new[]{"checking","workspace","services","opening"}){window.SetStage(stage);Capture(stage);}
            window.ShowFailure("程序文件与当前版本不一致，请使用完整程序目录后重试。");Capture("failure");
            File.WriteAllText(Path.Combine(directory,"result.json"),JsonSerializer.Serialize(new{ok=true,animated=changed,motionEnabled=window.MotionEnabled,statuses=4,errorVisible=true,minimumDelayMs=0,networkRequests=0,physicalCommands=0}));
        }
        finally{window.Close();}
    }
}
