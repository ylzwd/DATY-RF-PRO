using System.Text.Json;
using System.Windows.Controls;
using Daty.Native.Core;

namespace Daty.Native.App;

public partial class MainWindow
{
    private bool suggestionBusy;
    private long suggestionAt;
    private JsonElement? suggestion;
    private async Task GenerateFrequencySuggestionsAsync(bool explicitRequest)
    {
        if(suggestionBusy||(!explicitRequest&&Environment.TickCount64-suggestionAt<10000))return;
        suggestionBusy=true;suggestionAt=Environment.TickCount64;var epoch=generation;
        try
        {
            var devices=CoordinationEngine.CalculationDevices(ViewChannels.Where(c=>c.Online));
            if(devices.GetArrayLength()==0){suggestion=null;return;}
            var options=PlanningOptions();var profiles=customProfiles;
            var result=await Task.Run(()=>CoordinationEngine.Plan(devices,options,profiles,connection.Token),connection.Token);
            if(epoch!=generation)return;suggestion=result;
            if(!explicitRequest)Message("已重新计算频率建议，可在系统设置查看；设备当前频率保持。");
        }
        catch(Exception e){suggestion=null;Message("频率建议未生成："+SafeError(e),true);}
        finally{suggestionBusy=false;}
    }
    private async Task ShowFrequencySuggestionsAsync()
    {
        await GenerateFrequencySuggestionsAsync(true);var panel=new StackPanel();panel.Children.Add(Heading("自动变频推荐",18));
        panel.Children.Add(Hint("建议使用当前真实通道、硬件 Profile、锁定和扫描约束计算。请在频率规划复核、确认后下发。"));
        if(suggestion is JsonElement result)
        {
            var table=Table(("通道","Device",0),("当前 MHz","Current",105),("建议 MHz","Suggested",105),("原因","Reason",0));table.Height=270;
            table.ItemsSource=Array(result,"assignments").Select(a=>{var c=ViewChannels.FirstOrDefault(c=>c.Id==a.Text("deviceId"));return new{Device=c is null?a.Text("deviceId"):c.Group+" · "+c.ChannelLabel,Current=c?.Frequency??"—",Suggested=Wire.Format(a.Number("frequencyKHz")/1000,"0.000"),Reason=a.Text("changeReason")};}).ToArray();panel.Children.Add(table);
            foreach(var error in Array(result,"errors"))panel.Children.Add(Text(error.Text()??"",12,"#fb7185"));
        }
        else panel.Children.Add(Text("暂无可用建议，请连接设备并检查规划输入。",12));
        panel.Children.Add(ActionButton("打开频率规划",()=>ShowPage("planner")));ShowNativeDialog("频率建议",panel,820,490);
    }
}
