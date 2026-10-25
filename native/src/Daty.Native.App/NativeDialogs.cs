using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Globalization;
using System.IO;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private void ShowFrequencyDialog(Channel channel){ShowPage("planner");Message("请在频率规划中调整 "+channel.Group+" · "+channel.ChannelLabel+" 的频率");}

    private bool Confirm(string title,string message,string confirm="确认",bool danger=false,IEnumerable<(string Label,string Value)>? details=null,string? note=null)
    {
        var p=new StackPanel();Paragraph(p,message);if(details is not null)foreach(var(key,value) in details)p.Children.Add(KeyValue(key,value));
        Window? dialog=null;var cancel=ActionButton("取消",()=>dialog!.DialogResult=false);cancel.IsCancel=true;var ok=ActionButton(confirm,()=>dialog!.DialogResult=true,danger?"DangerButton":"PrimaryButton");
        dialog=CreateSurfaceDialog(title,p,details is null?840:640,Math.Clamp(250+(details?.Count()??0)*34,320,680),"DATY RF PRO · 操作确认",danger?"⚠":"↑",note??"确认前请核对操作内容",[cancel,ok],danger);dialog.Loaded+=(_,_)=>cancel.Focus();return PresentDialog(dialog)==true;
    }
}
