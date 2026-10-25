using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private string deviceTab="online";
    private UIElement Devices() => Tabbed([("online",$"在线设备 ({ViewChannels.Count})"),("scan","扫描发现"),("protocol","协议状态")],deviceTab,key=>{deviceTab=key;ShowPage("devices");},deviceTab switch{"scan"=>DiscoveryPage(),"protocol"=>ProtocolPage(),_=>OnlineDevices()});
    private UIElement OnlineDevices()
    {
        var grid=Rows(GridLength.Auto,Star(),GridLength.Auto);var hint=HeaderRow("",ActionButton("🗑️ 清除缓存设备",()=>{live.ClearCached();UpdateLive();Message("本机设备显示缓存已清除；后续真实上报会重新显示，服务器记录保持");}));hint.Children.Insert(0,Text("💡 设备来自接收机实时连接、主动发现或手动导入，品牌与型号以接收机上报信息为准",11,"#7c8db5"));Put(grid,hint,0);
        var table=Table(("编组","Group",75),("通道","ChannelLabel",65),("使用分类","Usage",110),("品牌 / 型号","BrandModel",0),("IP 地址","Ip",124),("协议","Protocol",85),("频率 MHz","Frequency",105),("连接状态","OnlineLabel",90));Put(grid,table,1);
        var info=Text("",11,"#7c8db5");int pages=1;
        var first=ActionButton("首页",()=>{devicePage=1;liveRefresh?.Invoke();});var prev=ActionButton("上一页",()=>{devicePage--;liveRefresh?.Invoke();});var next=ActionButton("下一页",()=>{devicePage++;liveRefresh?.Invoke();});var last=ActionButton("末页",()=>{devicePage=pages;liveRefresh?.Invoke();});
        var pager=Columns(Star(),GridLength.Auto);pager.Margin=new(0,10,0,0);At(pager,info);At(pager,Horizontal(first,prev,next,last),0,1);Put(grid,pager,2);
        // Keep the actual Channel as DataContext for identity and verification.
        ((DataGridTextColumn)table.Columns[2]).Binding=new System.Windows.Data.Binding("Raw"){Converter=new UsageConverter(this)};
        ((DataGridTextColumn)table.Columns[3]).Binding=new System.Windows.Data.MultiBinding{StringFormat="{0} {1}",Bindings={new System.Windows.Data.Binding("Brand"),new System.Windows.Data.Binding("Model")}};
        ((DataGridTextColumn)table.Columns[5]).Binding=new System.Windows.Data.Binding("Brand"){Converter=new ProtocolConverter()};
        string? rowSignature=null;
        liveRefresh=()=>{var rows=ViewChannels;pages=Math.Max(1,(rows.Count+19)/20);devicePage=Math.Clamp(devicePage,1,pages);
            var shown=rows.Skip((devicePage-1)*20).Take(20).ToArray();
            var signature=JsonSerializer.Serialize(shown.Select(c=>new{c.Id,c.Group,c.ChannelLabel,Usage=Usage(c),c.Brand,c.Model,c.Ip,c.Frequency,c.OnlineLabel}));
            if(signature!=rowSignature&&!(table.IsMouseOver&&System.Windows.Input.Mouse.LeftButton==System.Windows.Input.MouseButtonState.Pressed)){rowSignature=signature;table.ItemsSource=shown;}
            info.Text=$"第 {devicePage} / {pages} 页 · 共 {rows.Count} 条 · 每页 20 条";first.IsEnabled=prev.IsEnabled=devicePage>1;next.IsEnabled=last.IsEnabled=devicePage<pages;};return grid;
    }
    private sealed class UsageConverter(MainWindow owner):System.Windows.Data.IValueConverter { public object Convert(object v,Type t,object p,System.Globalization.CultureInfo c)=>v is JsonElement e?owner.Usage(Channel.Parse(e)):"—";public object ConvertBack(object v,Type t,object p,System.Globalization.CultureInfo c)=>throw new NotSupportedException(); }
    private sealed class ProtocolConverter:System.Windows.Data.IValueConverter {public object Convert(object v,Type t,object p,System.Globalization.CultureInfo c)=>v?.ToString()=="Shure"?"SCP":"MQTT";public object ConvertBack(object v,Type t,object p,System.Globalization.CultureInfo c)=>throw new NotSupportedException();}
    private static void AddActionColumn(DataGrid table,string title,string label,Action<object> action)
    {
        var factory=new FrameworkElementFactory(typeof(Button));factory.SetValue(ContentControl.ContentProperty,label);factory.SetValue(Control.FontSizeProperty,11d);factory.SetValue(Control.PaddingProperty,new Thickness(8,2,8,2));factory.SetValue(FrameworkElement.MarginProperty,new Thickness(4,0,4,0));factory.AddHandler(System.Windows.Controls.Button.ClickEvent,new RoutedEventHandler((sender,_)=>{if(sender is Button{DataContext: { } row})action(row);}));table.Columns.Add(new DataGridTemplateColumn{Header=title,CellTemplate=new DataTemplate{VisualTree=factory},Width=90});
    }
    private UIElement ProtocolPage()
    {
        var cards=new WrapPanel();var parent=Scroll(cards);var views=new Dictionary<string,ProtocolCardView>();
        void ResizeCards()
        {
            var available=Math.Max(150,parent.ActualWidth-12);
            var columns=Math.Clamp((int)Math.Floor(available/274),1,6);
            var width=Math.Max(140,Math.Floor(available/columns)-12);
            foreach(var view in views.Values){view.Card.Width=width;view.Card.Height=560;}
        }
        liveRefresh=()=>{
            var groups=ViewChannels.Where(c=>c.Online).GroupBy(c=>c.Brand).ToArray();
            var brands=groups.Select(g=>g.Key).ToHashSet();
            foreach(var brand in views.Keys.Where(b=>!brands.Contains(b)).ToArray()){cards.Children.Remove(views[brand].Card);views.Remove(brand);}
            foreach(var empty in cards.Children.OfType<FrameworkElement>().Where(e=>Equals(e.Tag,"protocol-empty")).ToArray())cards.Children.Remove(empty);
            foreach(var group in groups)
            {
                if(!views.TryGetValue(group.Key,out var view)){view=new ProtocolCardView(this,group.Key);views.Add(group.Key,view);cards.Children.Add(view.Card);}
                view.Update(group.ToArray(),discoveryState??default);
            }
            for(var i=0;i<groups.Length;i++){var card=views[groups[i].Key].Card;if(cards.Children.IndexOf(card)!=i){cards.Children.Remove(card);cards.Children.Insert(i,card);}}
            if(groups.Length==0){var empty=Empty("暂无在线品牌，设备上线后自动显示。可在「扫描发现」中查找设备。");empty.Tag="protocol-empty";cards.Children.Add(empty);}ResizeCards();
        };parent.SizeChanged+=(_,_)=>ResizeCards();parent.Loaded+=(_,_)=>PollPluginHealth();return parent;
    }
    // One native template for every brand; protocol-specific values and actions stay separate.
    private sealed class ProtocolCardView
    {
        public Border Card {get;}
        private readonly string brand;
        private readonly MainWindow owner;
        private readonly ComboBox selectedChannel=Select([]);
        private readonly List<TextBlock> reportValues=[];
        private Channel[] channels=[];
        private bool changingSelection;
        private sealed record ChannelChoice(string Id,string Label){public override string ToString()=>Label;}
        private readonly TextBlock count=Text("",23,"#a5b4fc");
        private readonly List<TextBlock> values=[];
        public ProtocolCardView(MainWindow owner,string brand)
        {
            this.owner=owner;this.brand=brand;var shure=brand=="Shure";var daty=brand=="DATYaudio";
            var layout=Rows(GridLength.Auto,Star(),GridLength.Auto);var top=new StackPanel();Put(layout,top,0);
            var header=Columns(Star(),GridLength.Auto);header.Height=24;
            var name=Heading(brand,16);name.TextWrapping=TextWrapping.NoWrap;name.TextTrimming=TextTrimming.CharacterEllipsis;name.ToolTip=brand;
            At(header,name);At(header,Text("已连接",10,"#34d399"),0,1);top.Children.Add(header);
            Hint(name,shure?"SCP · 发现、监测与受控下发。由服务器发现和监测；下发须确认目标及硬件能力。":daty?"MQTT · 配对接入、监测与受控下发。已配对接收机自动接入，状态以实时上报为准。":"接收与控制能力由已导入插件提供；当前未接入地址扫描。");
            TextBlock AddRow(string label,string? tag=null)
            {
                var row=Columns(new(82),Star());row.Height=28;row.Background=System.Windows.Media.Brushes.Transparent;var caption=Text(label,11,"#7c8db5");caption.TextWrapping=TextWrapping.NoWrap;caption.TextTrimming=TextTrimming.CharacterEllipsis;At(row,caption);
                var value=Text("—",11);value.Tag=tag;value.TextAlignment=TextAlignment.Right;value.TextWrapping=TextWrapping.NoWrap;value.TextTrimming=TextTrimming.CharacterEllipsis;At(row,value,0,1);
                row.SetBinding(FrameworkElement.ToolTipProperty,new System.Windows.Data.Binding(nameof(value.ToolTip)){Source=value});ToolTipService.SetShowDuration(row,60000);top.Children.Add(row);return value;
            }
            var online=Text("在线设备",12,"#7c8db5");online.Height=24;top.Children.Add(online);count.Height=42;count.TextWrapping=TextWrapping.NoWrap;count.TextTrimming=TextTrimming.CharacterEllipsis;top.Children.Add(count);
            selectedChannel.Style=(Style)Application.Current.FindResource("ProtocolChannelPicker");selectedChannel.Tag="protocol-report-channel";selectedChannel.DisplayMemberPath="Label";selectedChannel.SelectedValuePath="Id";selectedChannel.Height=26;selectedChannel.Margin=new(0,3,0,3);top.Children.Add(selectedChannel);
            selectedChannel.SelectionChanged+=(_,_)=>{if(!changingSelection)UpdateReport();};
            selectedChannel.PreviewMouseLeftButtonDown+=(_,e)=>{if(selectedChannel.Items.Count<2)e.Handled=true;};
            foreach(var label in new[]{"协议类型","心跳延迟",shure?"发现服务":"接入方式","扫描范围","扫描情况","最近完成"})values.Add(AddRow(label));
            foreach(var label in ProtocolReport.Labels)reportValues.Add(AddRow(label,"protocol-report:"+label));
            Put(layout,new Border{Height=4,Background=B("#a5b4fc"),CornerRadius=new(2),Margin=new(0,10,0,0)},2);
            Card=Panel(layout,12,new(0,0,12,12));Card.Tag="protocol-card:"+brand;Card.Width=262;Card.Height=560;
        }
        public void Update(Channel[] channels,JsonElement discovery)
        {
            this.channels=channels;
            var choices=channels.Select(c=>new ChannelChoice(c.Id,(owner.monitoringRules?.Identity(c)??c.Group+" · "+c.ChannelLabel)+" · "+c.Ip)).ToArray();
            if(!selectedChannel.Items.Cast<ChannelChoice>().SequenceEqual(choices))
            {
                var previous=selectedChannel.SelectedValue as string;changingSelection=true;
                try{selectedChannel.ItemsSource=choices;selectedChannel.SelectedValue=choices.Any(c=>c.Id==previous)?previous:choices.FirstOrDefault()?.Id;}
                finally{changingSelection=false;}
            }
            selectedChannel.Focusable=channels.Length>1;
            UpdateReport();
            var receivers=channels.DistinctBy(c=>c.DisplayReceiverKey).ToArray();count.Text=receivers.Length+" 台 · "+channels.Length+" 通道";
            Hint(count,"在线接收机："+receivers.Length+" 台\n在线通道："+channels.Length+" 条\n"+string.Join("\n",receivers.Select(c=>c.Ip+" · "+c.Model)));
            var measured=channels.Where(c=>c.RttState=="measured"&&c.RttMs.HasValue).Select(c=>c.RttMs!.Value).ToArray();
            void Value(int index,string value,string? hint=null){values[index].Text=value;Hint(values[index],hint??(value=="—"?"当前未提供有效值":value));}
            Value(0,brand=="Shure"?"TCP :2202":brand=="DATYaudio"?"MQTT / TLS":string.Join(" / ",channels.Select(c=>c.Raw.Text("control_protocol")).Where(v=>!string.IsNullOrWhiteSpace(v)).Distinct()) is string protocol&&protocol.Length>0?protocol:"—");
            Value(1,measured.Length>0?Wire.Format(measured.Average(),"0.00"," ms"):"—");
            if(brand=="Shure")
            {
                var discoveryLabel=discovery.ValueKind==JsonValueKind.Object?(discovery.Field("scanning").True()?"扫描中":discovery.Field("enabled").True()?"已就绪":"未启用"):"等待状态";
                var health=discovery.Field("health");var sessions=health.Field("monitoring");
                var healthState=health.Text("state") switch{"ready"=>"监测正常","recovering"=>"正在恢复","idle"=>"等待接收机","stopped"=>"已停止","disabled"=>"未启用",_=>"监测状态尚未读取"};
                string SessionCount(string key)=>sessions.Number(key) is double n?n.ToString("0"):"—";
                var detail="DATY 自有 SCP 接入 · "+healthState+"\n设备发现："+discoveryLabel+
                    "\n有效监测会话："+SessionCount("active")+" / "+SessionCount("total")+
                    "\n恢复中："+SessionCount("recovering")+" · 数据过期："+SessionCount("stale")+
                    (health.Text("last_error") is string lastError?"\n最近异常："+lastError:"")+
                    "\n调频与静音以接收机独立回读为准。完整 RF 扫描接口尚未核实。";
                Value(2,discoveryLabel+" · 直接接入",detail);
                var range=string.Join(", ",Array(discovery,"scopes").Select(r=>r.Text("scan_network")));Value(3,range.Length>0?range:"—");
                var found=Array(discovery,"receivers");var result=found.Length>0?string.Join("\n",found.Select(r=>r.Text("ip")+" · "+r.Text("model"))):"暂无发现结果";
                var progress=discovery.Number("scanned") is double done&&discovery.Number("targets") is double total?$"{done}/{total}":"—";
                var hasResults=discovery.Field("receivers").ValueKind==JsonValueKind.Array;
                Value(4,progress+(hasResults?" · "+found.Length+" 台":""),"扫描地址："+progress+"\n"+(hasResults?"发现结果："+found.Length+" 台\n"+result:"发现结果尚未读取"));
                var completed=Wire.LocalTime(discovery.Number("completed_at"));Value(5,completed.Length>=19?completed[11..]:completed,"最近扫描完成："+completed+"（本机时间）");
            }
            else
            {
                Value(2,brand=="DATYaudio"?"MQTT 配对接入":"品牌插件接入");for(var i=3;i<6;i++)Value(i,"—",brand=="DATYaudio"?"已配对接收机自动连接，不使用地址扫描。":"当前品牌未接入地址扫描状态。不能沿用其他品牌的扫描结果。");
            }
        }
        private void UpdateReport()
        {
            var channel=channels.FirstOrDefault(c=>c.Id==selectedChannel.SelectedValue as string);if(channel is null)return;
            Hint(selectedChannel,(selectedChannel.SelectedItem as ChannelChoice)?.Label??"当前通道未提供");
            var rows=ProtocolReport.Read(channel,owner.monitoringRules);
            for(var i=0;i<rows.Length;i++)
            {
                var value=reportValues[i];value.Text=rows[i].Value;
                Hint(value,rows[i].Detail);
            }
        }
        private static void Hint(FrameworkElement value,string detail)
        {
            if(value.ToolTip is ToolTip{Content:TextBlock text}){if(text.Text!=detail)text.Text=detail;}
            else value.ToolTip=new ToolTip{Content=new TextBlock{Text=detail,FontSize=12,TextWrapping=TextWrapping.Wrap,MaxWidth=420},Background=B("#171c2b"),Foreground=B("#e2e8f0"),BorderBrush=B("#313b55"),BorderThickness=new(1),Padding=new(10,7,10,7),Placement=System.Windows.Controls.Primitives.PlacementMode.Mouse};
            ToolTipService.SetShowDuration(value,60000);
        }
    }
    private void ShowDeviceDetails(Channel c)
    {
        var list=new StackPanel();list.Children.Add(HeaderRow(c.Brand+" "+c.Model+" · "+c.Group+" · "+c.ChannelLabel));
        foreach(var (k,v) in new[]{("接收机 IP",c.Ip),("接收机身份",c.ReceiverId),("频率",c.Frequency+" MHz"),("使用分类",Usage(c)),("话筒",c.Transmitter),("RF",c.Rf),("AF",c.Af),("电池",c.BatteryLabel),("接收机输出",c.MuteLabel),("RTT",c.Rtt)})list.Children.Add(KeyValue(k,v));
        list.Children.Add(new Expander{Header="接收机完整上报信息",Content=new TextBox{Text=JsonSerializer.Serialize(c.Raw,new JsonSerializerOptions{WriteIndented=true}),IsReadOnly=true,TextWrapping=TextWrapping.Wrap,AcceptsReturn=true,MaxHeight=280,VerticalScrollBarVisibility=ScrollBarVisibility.Auto}});ShowNativeDialog("设备详情",list,660,610);
    }
    private static UIElement KeyValue(string key,string value){var row=Columns(new(145),Star());row.Margin=new(0,0,0,8);At(row,Text(key,12,"#7c8db5"));At(row,Text(value,12),0,1);return row;}
    private void ShowNativeDialog(string title,UIElement content,double width=680,double height=480) => PresentDialog(CreateSurfaceDialog(title,content,width,height));
}
