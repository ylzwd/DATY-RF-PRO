using System.IO;
using System.Reflection;
using System.Windows;
namespace Daty.Native.App;
public partial class App : Application
{
    public static string DisplayVersion { get; } = "V" + typeof(App).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>().Single(a=>a.Key=="PlatformVersion").Value + "-" + typeof(App).Assembly.GetName().Version!.ToString(3);
    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        if(e.Args.Length==2 && e.Args[0]=="--verify-close")
        {
            ShutdownMode=ShutdownMode.OnExplicitShutdown;
            try { await Daty.Native.App.MainWindow.VerifyCloseAsync(e.Args[1]); Shutdown(0); }
            catch(Exception error) { Directory.CreateDirectory(e.Args[1]);File.WriteAllText(Path.Combine(e.Args[1],"close-failure.txt"),error.ToString());Shutdown(1); }
            return;
        }
        if(e.Args.Length==2&&e.Args[0]=="--verify-r19-fixture")
        {
            ShutdownMode=ShutdownMode.OnExplicitShutdown;
            try{await new MainWindow(true).VerifyFixtureActionsAsync(e.Args[1]);Shutdown(0);}
            catch(Exception error){File.WriteAllText(e.Args[1]+".failure.txt",error.ToString());Shutdown(1);}
            return;
        }
        if (e.Args.Length == 2 && e.Args[0] == "--verify-ui")
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            try { await UiVerification.RunAsync(e.Args[1]); Shutdown(0); }
            catch (Exception error) { Directory.CreateDirectory(e.Args[1]); File.WriteAllText(Path.Combine(e.Args[1], "ui-failure.txt"), error.ToString()); Shutdown(1); }
            return;
        }
        try {
            if(typeof(App).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>().Any(a=>a.Key=="IndependentProject"&&a.Value=="true") && Daty.Native.Core.ProjectEnvironment.Current is null)
                throw new InvalidDataException("请在完整的 DATY RF PRO 项目目录中运行，不能单独移动此 EXE。");
            if(StartProjectDesktopHost()){Shutdown(0);return;}
            var window = new MainWindow(); MainWindow = window; window.Show();
        }
        catch(Exception error) { MessageBox.Show(error.Message,"DATY RF PRO 启动失败",MessageBoxButton.OK,MessageBoxImage.Error);Shutdown(1); }
    }
}
