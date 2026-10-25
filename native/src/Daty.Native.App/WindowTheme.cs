using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace Daty.Native.App;

/// <summary>Theme the native caption; preserve Windows resize, snapping and close behavior.</summary>
internal static class WindowTheme
{
    [DllImport("dwmapi.dll",ExactSpelling=true)]
    private static extern int DwmSetWindowAttribute(IntPtr window,int attribute,ref int value,int size);

    internal static void Attach(Window window)
    {
        void Apply(object? sender,EventArgs e)
        {
            var handle=new WindowInteropHelper(window).Handle;
            if(handle==IntPtr.Zero || !OperatingSystem.IsWindowsVersionAtLeast(10,0,22000))return;
            void Set(int attribute,int value)
            {
                var result=DwmSetWindowAttribute(handle,attribute,ref value,sizeof(int));
                if(result<0)Trace.TraceWarning("Window caption attribute {0}: {1:X8}",attribute,result);
            }
            var highContrast=SystemParameters.HighContrast;
            Set(20,highContrast?0:1); // DWMWA_USE_IMMERSIVE_DARK_MODE
            Set(34,highContrast?-1:0x00422c24); // Border #242c42; COLORREF uses BGR.
            Set(35,highContrast?-1:0x00201511); // Caption #111520.
            Set(36,highContrast?-1:window.IsActive?0x00f0e8e2:0x00b58d7c);
        }
        window.SourceInitialized+=Apply;
        window.Activated+=Apply;
        window.Deactivated+=Apply;
    }
}
