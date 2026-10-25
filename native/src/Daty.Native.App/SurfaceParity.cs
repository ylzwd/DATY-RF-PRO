using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private static IEnumerable<T> Descendants<T>(DependencyObject root) where T:DependencyObject
    {
        foreach(var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>()){if(child is T t)yield return t;foreach(var nested in Descendants<T>(child))yield return nested;}
    }
    private static FrameworkElement Segmented((string Key,string Label)[] items,string selected,Action<string> choose,UIElement content)
    {
        var root=Rows(GridLength.Auto,Star());var buttons=new WrapPanel();foreach(var(key,label)in items){var button=ActionButton(label,()=>choose(key));button.Background=B(key==selected?"#1e243a":"#111520");button.BorderBrush=B(key==selected?"#343765":"#111520");button.Foreground=B(key==selected?"#c7d2fe":"#7c8db5");button.FontSize=12;button.Padding=new(18,5,18,5);button.Margin=new(2,0,2,0);buttons.Children.Add(button);}Put(root,new Border{Child=buttons,Padding=new(4),CornerRadius=new(9),BorderBrush=B("#242c42"),BorderThickness=new(1),Background=B("#111520"),HorizontalAlignment=HorizontalAlignment.Left,Margin=new(0,0,0,12)},0);Put(root,content,1);return root;
    }
    private static FrameworkElement TableSurface(DataGrid table,string message)
    {
        var root=new Grid();root.Children.Add(table);var empty=Text(message,12,"#7c8db5",new(12,50,12,12));empty.HorizontalAlignment=HorizontalAlignment.Center;empty.VerticalAlignment=VerticalAlignment.Top;empty.TextAlignment=TextAlignment.Center;empty.IsHitTestVisible=false;root.Children.Add(empty);
        void Update()=>empty.Visibility=table.Items.Count==0?Visibility.Visible:Visibility.Collapsed;
        ((System.Collections.Specialized.INotifyCollectionChanged)table.Items).CollectionChanged+=(_,_)=>Update();Update();return root;
    }
    private static void StretchTableColumns(DataGrid table)
    {
        // Give every visible column the same share, including action/template columns.
        // A common minimum keeps narrow windows usable through horizontal scrolling.
        table.CanUserResizeColumns=false;
        table.LayoutUpdated+=(_,_)=>{
            var columns=table.Columns.Where(c=>c.Visibility==Visibility.Visible).ToArray();
            if(columns.Length==0||table.ActualWidth<=4)return;
            var hasVertical=VisualScrollbars(table).Any(s=>s.Orientation==Orientation.Vertical&&s.Visibility==Visibility.Visible&&s.ActualWidth>0);
            var available=table.ActualWidth-(hasVertical?SystemParameters.VerticalScrollBarWidth:0)-4;
            var width=Math.Max(columns.Max(c=>Math.Max(80,c.MinWidth)),available/columns.Length);
            foreach(var column in columns)if(!column.Width.IsAbsolute||Math.Abs(column.Width.Value-width)>.5)column.Width=new DataGridLength(width);
        };
    }
    private static IEnumerable<System.Windows.Controls.Primitives.ScrollBar> VisualScrollbars(DependencyObject root)
    {
        for(var i=0;i<System.Windows.Media.VisualTreeHelper.GetChildrenCount(root);i++){var child=System.Windows.Media.VisualTreeHelper.GetChild(root,i);if(child is System.Windows.Controls.Primitives.ScrollBar bar)yield return bar;foreach(var nested in VisualScrollbars(child))yield return nested;}
    }
    // All surfaces are WPF controls; measurements come from the shipped main.css.
    private static FrameworkElement FilterField(string label, FrameworkElement input)
    {
        input.Margin=new(6,0,0,0);input.VerticalAlignment=VerticalAlignment.Center;
        var p=Horizontal(Text(label,12,"#7c8db5"),input);p.Margin=new(0,0,12,6);return p;
    }
    private static FrameworkElement FilterBar(params UIElement[] controls)
    {
        var p=new WrapPanel();foreach(var c in controls)p.Children.Add(c);
        return new Border{Child=p,Background=B("#171c2b"),CornerRadius=new(7),Padding=new(10,9,10,3),Margin=new(0,0,0,10)};
    }
    private static Expander Details(string title,UIElement content)=>new(){Header=title,Content=content,Margin=new(0,0,0,10)};
    private static Border Badge(string text,string color="#818cf8")=>new(){Background=B("#252440"),CornerRadius=new(5),Padding=new(8,2,8,2),HorizontalAlignment=HorizontalAlignment.Left,Child=Text(text,10,color)};
    private UIElement FileCards((string Icon,string Title,string Description,string Extension,Action Action)[] entries)
    {
        var row=new Grid();for(var i=0;i<3;i++)row.ColumnDefinitions.Add(new(){Width=Star()});
        for(var i=0;i<entries.Length;i++)
        {
            var item=entries[i];var g=Columns(new(48),Star());g.RowDefinitions.Add(new(){Height=GridLength.Auto});g.RowDefinitions.Add(new(){Height=Star()});g.RowDefinitions.Add(new(){Height=GridLength.Auto});g.MinHeight=112;
            FrameworkElement icon=Text(item.Icon,32);icon.VerticalAlignment=VerticalAlignment.Top;
            if(item.Icon=="DATY")icon=new Image{Source=new System.Windows.Media.Imaging.BitmapImage(new Uri(System.IO.Path.Combine(AppContext.BaseDirectory,"assets","ui","daty-audio-logo.png"))),Width=48,Height=48,VerticalAlignment=VerticalAlignment.Top};
            At(g,icon);Grid.SetRowSpan(icon,3);
            var title=Heading(item.Title,13);title.Margin=new(14,0,0,8);At(g,title,0,1);
            var description=Text(item.Description,12,"#7c8db5",new(14,0,0,8));description.LineHeight=19;description.VerticalAlignment=VerticalAlignment.Top;At(g,description,1,1);
            var badge=Badge(item.Extension);badge.Margin=new(14,0,0,0);At(g,badge,2,1);
            var button=ActionButton("",item.Action);button.Content=g;button.Padding=new(18);button.HorizontalContentAlignment=HorizontalAlignment.Stretch;button.VerticalAlignment=VerticalAlignment.Stretch;button.Margin=new(i==0?0:6,0,i==2?0:6,0);button.BorderBrush=B("#2e3a56");button.Background=B("#171c2b");At(row,button,0,i);
        }
        return row;
    }

    private Window CreateSurfaceDialog(string title,UIElement body,double width=760,double height=560,string? eyebrow=null,string symbol="📋",string footnote="",IEnumerable<Button>? buttons=null,bool danger=false)
    {
        var dialog=new Window{Owner=verification?null:this,Title="DATY RF PRO · "+title,Width=Math.Min(width,Math.Max(400,(ActualWidth>0?ActualWidth:Width)-32)),Height=Math.Min(height,Math.Max(260,(ActualHeight>0?ActualHeight:Height)-32)),MinWidth=360,MinHeight=220,WindowStyle=WindowStyle.None,ResizeMode=ResizeMode.NoResize,ShowInTaskbar=false,AllowsTransparency=true,Background=Brushes.Transparent,FontFamily=FontFamily,WindowStartupLocation=WindowStartupLocation.CenterOwner};
        var shell=Rows(GridLength.Auto,Star(),GridLength.Auto);
        var header=Columns(new(44),Star(),GridLength.Auto);var icon=Badge(symbol,danger?"#fb7185":"#a5b4fc");icon.Width=36;icon.Height=36;((TextBlock)icon.Child).FontSize=22;At(header,icon);
        var heading=new StackPanel();heading.Children.Add(Text(eyebrow??"DATY RF PRO",10,"#7c8db5",new(0,0,0,3)));heading.Children.Add(Heading(title,18));At(header,heading,0,1);
        var close=ActionButton("×",()=>dialog.Close());close.FontSize=22;close.Padding=new(8,0,8,0);close.Background=Brushes.Transparent;close.BorderThickness=new(0);close.Margin=new();close.ToolTip="关闭";At(header,close,0,2);
        Put(shell,new Border{Child=header,Padding=new(18,14,18,14),BorderBrush=B("#242c42"),BorderThickness=new(0,0,0,1)},0);
        Put(shell,new Border{Child=Scroll(body),Padding=new(18,16,18,16)},1);
        var footer=Columns(Star(),GridLength.Auto);At(footer,Text(footnote,11,"#7c8db5"));var actions=Horizontal();foreach(var b in buttons??[ActionButton("关闭",()=>dialog.Close(),"PrimaryButton")]){b.MinWidth=84;b.Padding=new(14,7,14,7);b.Margin=new(8,0,0,0);actions.Children.Add(b);}At(footer,actions,0,1);
        Put(shell,new Border{Child=footer,Padding=new(18,12,18,12),Background=B("#171c2b"),BorderBrush=B("#242c42"),BorderThickness=new(0,1,0,0)},2);
        dialog.Content=new Border{Child=shell,Background=B("#111520"),BorderBrush=B("#2e3a56"),BorderThickness=new(1),CornerRadius=new(13),ClipToBounds=true};
        dialog.PreviewKeyDown+=(_,e)=>{if(e.Key==Key.Escape){dialog.Close();e.Handled=true;}};
        return dialog;
    }
    private readonly Dictionary<string,FrameworkElement> verificationDialogs=[];
    private bool? PresentDialog(Window dialog)
    {
        if(verification){verificationDialogs[dialog.Title]=(FrameworkElement)dialog.Content;return false;}
        var shade=new Border{Background=B("#BD060914"),IsHitTestVisible=true};Grid.SetColumnSpan(shade,99);Grid.SetRowSpan(shade,99);System.Windows.Controls.Panel.SetZIndex(shade,1000);Shell.Children.Add(shade);
        var opener=Keyboard.FocusedElement;
        try{return dialog.ShowDialog();}finally{Shell.Children.Remove(shade);if(opener is IInputElement element)Keyboard.Focus(element);}
    }
    private static FrameworkElement RawDetails(object value)
    {
        var json=JsonSerializer.Serialize(value,new JsonSerializerOptions{WriteIndented=true});
        return Details("查看原始 JSON",new TextBox{Text=json.Length>60000?json[..60000]+"\n…预览已截断，导出包含完整记录。":json,IsReadOnly=true,AcceptsReturn=true,TextWrapping=TextWrapping.Wrap,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,MaxHeight=300,FontFamily=new FontFamily("Consolas"),FontSize=11,Margin=new(0,10,0,0)});
    }
    private static void Paragraph(StackPanel parent,string text,string color="#e2e8f0")
    {
        var p=Text(text,13,color,new(0,0,0,10));p.LineHeight=23;parent.Children.Add(p);
    }
}
