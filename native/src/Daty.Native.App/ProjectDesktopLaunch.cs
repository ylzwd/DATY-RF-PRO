using System.Diagnostics;
using System.IO;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class App
{
    // Direct EXE launches use the same owner as the VBS entry. Verification modes bypass this.
    private static bool StartProjectDesktopHost()
    {
        if (ProjectEnvironment.Current is not { } project) return false;
        var boot = Environment.GetEnvironmentVariable("DATY_PROJECT_DESKTOP_BOOT");
        if (boot is not null)
        {
            if (boot.Length != 32 || !boot.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'))
                throw new InvalidDataException("独立项目窗口启动身份无效");
            return false;
        }
        var info = new ProcessStartInfo(Path.Combine(project.Root, "app/tools/python/pythonw.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = project.Root
        };
        foreach (var argument in new[] { "-X", "utf8", "-B", Path.Combine(project.Root, "scripts/project-local.py"), "launch" }) info.ArgumentList.Add(argument);
        using var host = Process.Start(info) ?? throw new IOException("独立项目启动器无法打开");
        return true;
    }
}
