using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Daty.Native.Core;

namespace Daty.Native.App;
public partial class MainWindow
{
    internal void SetSurfaceFixtures()
    {
        if(!verification)throw new InvalidOperationException("Fixtures require the isolated test constructor.");
        StatusToast.Visibility=Visibility.Collapsed;databaseEpoch="isolated-ui-fixture";
        pluginState=JsonSerializer.SerializeToElement(new{builtin=new[]{new{id="fashe-mqtt",brand="DATYaudio",name="DATYaudio MQTT"}},plugins=new[]{new{id="shure-scp",brand="Shure",name="Shure SCP",active=true}}});
        discoveryState=JsonSerializer.SerializeToElement(new{enabled=true,scanning=false,generation=1,health=new{provider="daty-scp",state="ready",receivers_online=1,monitoring=new{total=1,active=1,recovering=0,stale=0},last_error=(string?)null},scopes=new[]{new{scan_network="192.0.2.0/24"}},scanned=253,targets=253,completed_at=1789296000,receivers=new[]{new{ip="192.0.2.107",model="ULXD4"}}});
        verificationRead=(method,body)=>
        {
            var args=JsonSerializer.SerializeToElement(body);var kind=args.Text("kind")??"settings";var now=1789296000000L;
            var document=JsonSerializer.SerializeToElement(new{enabled=true,rfWeakDbm=-90,batteryLowPercent=20,batteryLowBars=1,afOverloadDbfs=-3,projectId="default",name="演出 A · 人声频率规划",timestamp=now,channels=4,algorithm="确定性全局规划",metric="rf",level="warn",deviceId="fixture-rx-ch1",receiverBrand="DATYaudio",receiverIP="192.0.2.16",msg="RF 弱信号",firstSeen=now-60000,lastSeen=now,archiveState="active",options=new{backupCount=1,lockedAssignments=new[]{new{deviceId="fixture-rx-ch1",frequencyKHz=641000,reason="主唱"}},excludedRanges=System.Array.Empty<object>()},coordination=new{analysis=new{minImdMarginKHz=250,conflicts=System.Array.Empty<object>()}}});
            object Resource(int n)=>new{kind,id=kind=="settings"?(n==1?"alert_thresholds":"alert_sound"):"fixture-"+kind+"-"+n,revision=1,deleted=false,saved_at_ms=now,project_id=kind is "settings" or "manual_devices"?null:"default",digest=new string('a',64),summary=new{name=kind=="scans"?"演出扫描 2026-09-23.csv":kind=="settings"?"声音告警":"主唱 · CH"+n,receiver_id="fixture-rx",channel_number=n,source_kind="imported_csv",point_count=12000,min_khz=640000,max_khz=690000,enabled=1,rf_weak_dbm=-90,battery_low_percent=20,af_overload_dbfs=-3},value=document};
            return method switch
            {
                "database.catalog"=>JsonSerializer.SerializeToElement(new{success=true,items=Enumerable.Range(1,3).Select(Resource),next_cursor=(string?)null}),
                "database.resources.list"=>JsonSerializer.SerializeToElement(new{success=true,resources=Enumerable.Range(1,3).Select(Resource),next_cursor=(string?)null}),
                "database.resources.get"=>JsonSerializer.SerializeToElement(new{success=true,resource=Resource(1)}),
                "database.activity.list"=>JsonSerializer.SerializeToElement(new{success=true,activity_protocol="daty-activity-v1",source=args.Text("source"),as_of=4,items=Enumerable.Range(1,4).Select(n=>new{source=args.Text("source"),id=n,time_ms=now-n*1000,kind=args.Text("source")=="operations"?"settings":"command.result",target="fixture-rx · CH1",summary=n==1?"输出静音 → 取消静音":"告警阈值已提交 · v"+n,outcome=n==1?"readback_confirmed":n==2?"unknown":"committed"}),next_cursor=(string?)null}),
                "storage.status"=>JsonSerializer.SerializeToElement(new{databaseBytes=32100000,diskFreeBytes=80000000000L}),
                "archives.list" or "exports.list"=>JsonSerializer.SerializeToElement(new{items=Enumerable.Range(1,method=="archives.list"?21:2).Select(n=>new{id="fixture-file-"+n,fileName="DATY演出存档-"+n+(method=="archives.list"?".zip":".json"),status="saved",createdAtMs=now-n*1000,bytes=1048576,sha256=new string('b',64)})}),
                "discovery.status"=>discoveryState!.Value,
                _=>throw new InvalidOperationException("Unregistered fixture RPC: "+method)
            };
        };
    }
    internal void LoadSurfaceFixtures()
    {
        if(!verification||verificationRead is null)return;
        // Offscreen RenderTargetBitmap does not attach controls to a presentation source.
        // Raise only the read-only Loaded handlers of the current test tree.
        var elements=new List<FrameworkElement>();void Walk(DependencyObject node){if(node is FrameworkElement e)elements.Add(e);for(var i=0;i<VisualTreeHelper.GetChildrenCount(node);i++)Walk(VisualTreeHelper.GetChild(node,i));}Walk(PageContent);
        foreach(var e in elements)e.RaiseEvent(new RoutedEventArgs(FrameworkElement.LoadedEvent,e));
    }
    internal IReadOnlyDictionary<string,FrameworkElement> BuildSurfaceDialogFixtures()
    {
        if(!verification)throw new InvalidOperationException();
        ShowSafetySettings();ShowPlanDetails();
        var devices=CoordinationEngine.CalculationDevices(ViewChannels.Where(c=>c.Online).Take(2));var options=JsonSerializer.SerializeToElement(new{rangeStartKHz=630000,rangeEndKHz=690000,stepKHz=25,backupCount=1,compatibilityLevel="standard",solver="global",allocationOrder="receiver-group-ascending",frequencyDistribution="spread-range"});
        planResult=CoordinationEngine.Plan(devices,options,customProfiles,default);ShowNativeDialog("规划详情（已计算）",BuildPlanDetails(),760,650);var summary=new StackPanel();BuildPlanSummary(summary,planResult.Value);ShowNativeDialog("规划摘要（已计算）",summary,760,510);ShowDeviceForm();ShowConnectionDialog();
        ShowAlertRecordDetail(JsonSerializer.SerializeToElement(new{id="fixture-alert",value=new{archiveId="fixture-alert",deviceId="fixture-rx-ch1",receiverIP="192.0.2.16",metric="rf",archiveState="ended",firstSeen=1789296000000L,lastSeen=1789296060000L,endedAt=1789296065000L,value=-95,threshold=-90}}));
        Confirm("导入品牌插件","确认将此配接插件安装到当前服务器。","确认导入",details:[("品牌","Shure"),("版本","3aee959ed650"),("文件","DATY-shure-scp-source.zip"),("校验状态","包身份与内容摘要已通过服务器校验")]);
        Confirm("删除服务器文件","删除选中的服务器文件，完成后不能再次下载此文件。","确认删除",true,[("删除范围","DATY演出存档.zip"),("文件大小","1.0 MB")],"文件删除无法撤销；需要保留的文件请先下载。");
        var item=JsonSerializer.SerializeToElement(new{source="operations",id=1,kind="settings",target="alert_thresholds",outcome="committed",time_ms=1789296000000L});
        var detail=JsonSerializer.SerializeToElement(new{record=new{operation_id="isolated-test-operation",revision=2,actor=new{ip="192.0.2.16"},before=new{fields=new{rfWeakDbm=-90,batteryLowPercent=20}},after=new{fields=new{rfWeakDbm=-85,batteryLowPercent=25}}}});
        ShowNativeDialog("记录详情",BuildActivityDetail(item,detail),780,650);
        var catalog=verificationRead!("database.catalog",new{kind="settings"});var resource=verificationRead("database.resources.get",new{kind="settings"}).Field("resource");ShowNativeDialog("资料版本详情",BuildCatalogDetail(Array(catalog,"items")[0],resource),780,610);
        return verificationDialogs;
    }
}
