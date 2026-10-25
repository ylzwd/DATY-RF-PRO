using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;
public partial class MainWindow
{
    private UIElement DiscoveryPage()
    {
        var content=new StackPanel();var title=Text("",12,"#7c8db5",new(0,0,0,8));content.Children.Add(title);var list=new StackPanel();content.Children.Add(list);
        liveRefresh=()=>
        {
            var groups=ViewChannels.GroupBy(c=>c.DisplayReceiverKey).ToArray();title.Text=$"本机发现 · {groups.Length} 台接收机";
            list.Children.Clear();foreach(var group in groups)
            {
                var c=group.First();var body=new StackPanel();var header=Columns(new(22),Star(),GridLength.Auto);At(header,Text("●",18,c.Online?"#22d3ee":"#ef4444"));var info=new StackPanel();var enabled=c.Raw.Field("capabilities");var control=enabled.Field("write_frequency").True()?"可调频与输出静音":enabled.Field("mute").True()?"可控制输出静音":"仅监测";
                var name=new WrapPanel();name.Children.Add(Heading(c.Brand+" "+c.Model+(c.Brand=="Shure"?" · "+control:""),13));name.Children.Add(Text("  "+c.Ip+"  "+group.Count()+" 通道",10,"#7c8db5"));if(!c.Online)name.Children.Add(Text("  离线 · 上次数据",10,"#fb7185"));info.Children.Add(name);
                info.Children.Add(Text((c.Brand=="Shure"?"最后读取: "+Wire.LocalTime(c.Raw.Number("ts")):"接收机实时连接")+" · "+(c.Brand=="Shure"?"下发须通过硬件能力校验":"消息数: "+(c.Raw.Text("message_count")??"—")),10,"#7c8db5",new(0,3,0,0)));At(header,info,0,1);At(header,ActionButton("查看通道",()=>ShowPage("channels"),"PrimaryButton"),0,2);body.Children.Add(header);
                var channels=new StackPanel{Margin=new(0,8,0,0)};channels.Children.Add(Text($"通道卡片 ({group.Count()})",11,"#7c8db5",new(0,8,0,6)));var tiles=new WrapPanel();
                foreach(var ch in group)
                {
                    var tile=new StackPanel();tile.Children.Add(Text("● "+ch.Name+"   "+ch.Brand+(ch.Muted==true?"   🔇 已静音":""),12,ch.Brand=="Shure"?"#a5b4fc":"#6ee7b7"));tile.Children.Add(Text($"{ch.ChannelLabel}  |  {ch.Frequency} MHz  |  RF {ch.Rf}  |  {ch.BatteryLabel}"+(ch.Brand=="Shure"?$"  AF {ch.Af}":""),10,"#7c8db5",new(0,3,0,0)));var box=Panel(tile,8,new(0,0,6,6));box.Width=310;box.CornerRadius=new(6);box.Background=B(ch.Brand=="Shure"?"#202036":"#132a27");box.BorderBrush=B(ch.Brand=="Shure"?"#383655":"#235344");tiles.Children.Add(box);
                }
                channels.Children.Add(tiles);body.Children.Add(new Border{Child=channels,BorderBrush=B("#242c42"),BorderThickness=new(0,1,0,0)});var card=Panel(body,14,new(0,0,0,8));card.CornerRadius=new(8);card.Background=B("#171c2b");list.Children.Add(card);
            }
            if(groups.Length==0){var empty=new StackPanel{Margin=new(40)};empty.Children.Add(Empty("🎤"));empty.Children.Add(Empty("未发现接收机"));empty.Children.Add(Empty("请确认接收机已开机，并与本机处于同一局域网\n其他品牌需先在系统设置中导入对应插件"));var retry=ActionButton("重新扫描",()=>_=ScanReceiversAsync());retry.HorizontalAlignment=HorizontalAlignment.Center;retry.Margin=new(0,16,0,0);empty.Children.Add(retry);list.Children.Add(empty);}
        };return Scroll(content);
    }
}
