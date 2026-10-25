using System.Text.Json;
using Daty.Native.Core;

static class MonitoringPlanningCases
{
    static void Check(bool value,string message){if(!value)throw new Exception(message);}
    static void Reject(Action action,string expected){try{action();}catch(Exception e){Check(e.Message.Contains(expected),"unexpected rejection: "+e.Message);return;}throw new Exception("expected rejection: "+expected);}
    static JsonElement Json(object value)=>JsonSerializer.SerializeToElement(value);
    static JsonElement Profiles=>Json(Array.Empty<object>());
    static Dictionary<string,object?> Device(string id,int group,int? frequency,bool controlled=true)=>new(){
        ["id"]=id,["receiver_id"]=id,["receiver_mac"]="fixture-"+id,["receiver_ip"]="192.0.2."+group,["channel_number"]=1,
        ["group_number"]=group,["group_source"]="server-fifo-v1",["_online"]=true,["_source"]="fixture-"+id,["status"]="online",
        ["brand"]=controlled?"DATYaudio":"Shure",["model"]=controlled?"RF PRO":"QLXD4",["freq"]=frequency,
        ["capabilities"]=controlled?new{adapter="fashe-mqtt",write_frequency=true,read_only=false,
            frequency_control=new{scope="fashe-protocol",min_khz=400000,max_khz=900000,step_khz=1,origin_khz=0,ack_mode="command-id",brand_binding="expected-brand-v1"}}:null};
    static Dictionary<string,object?> Options()=>new(){["rangeStartKHz"]=638000,["rangeEndKHz"]=665000,["stepKHz"]=25,["backupCount"]=0,
        ["compatibilityLevel"]="standard",["imdProducts"]=new[]{"2T3O"},["preserveCurrent"]=false,["allocationOrder"]="receiver-group-ascending",
        ["frequencyDistribution"]="spread-range",["lockMonitoringOnly"]=true,["protectCurrentFrequencies"]=false};
    static JsonElement Row(JsonElement result,string id)=>result.GetProperty("assignments").EnumerateArray().Single(row=>row.GetProperty("deviceId").GetString()==id);
    static JsonElement Mixed()=>Json(new[]{Device("managed",1,640000),Device("monitor",2,650000,false)});

    public static IEnumerable<(string Name,Action Run)> All()
    {
        yield return ("Native planning fixes monitored channels at actual frequency without changing user input",()=>{
            var devices=Mixed();var options=Json(Options());var before=options.GetRawText();var result=CoordinationEngine.Plan(devices,options,Profiles,default);
            Check(result.GetProperty("search").GetProperty("complete").GetBoolean(),"mixed plan complete");
            var monitor=result.GetProperty("monitoringOnlyChannels")[0];Check(monitor.GetProperty("frequencyKHz").GetInt32()==650000&&monitor.GetProperty("fixedMonitoringOnly").GetBoolean(),"monitor retains real frequency");
            Check(result.GetProperty("assignments").GetArrayLength()==1&&result.GetProperty("profileSnapshots").GetArrayLength()==1,"monitor is background, not a tuning assignment");
            Check(result.GetProperty("options").GetProperty("knownCarriers").EnumerateArray().Any(x=>x.GetProperty("ownerDeviceId").GetString()=="monitor"),"effective options record fixed occupancy");
            Check(options.GetRawText()==before&&!options.TryGetProperty("lockedAssignments",out _),"source draft stays unchanged");
        });
        yield return ("Native fixed monitoring requires real frequency and rejects contradictory explicit locks",()=>{
            Reject(()=>CoordinationEngine.Plan(Json(new[]{Device("unknown",1,null,false)}),Json(Options()),Profiles,default),"缺少真实当前频率");
            var options=Options();options["lockedAssignments"]=new[]{new{deviceId="monitor",frequencyKHz=651000}};
            Reject(()=>CoordinationEngine.Plan(Mixed(),Json(options),Profiles,default),"人工锁定不能改频");
            options["lockedAssignments"]=new[]{new{deviceId="monitor",frequencyKHz=650000,reason="user lock"}};
            var result=CoordinationEngine.Plan(Mixed(),Json(options),Profiles,default);
            Check(result.GetProperty("options").GetProperty("lockedAssignments").GetArrayLength()==0,"matching background lock removed from target locks");
            Check(result.GetProperty("options").GetProperty("knownCarriers").GetArrayLength()==1,"matching background occupancy recorded once");
        });
        yield return ("Manual plans cannot move monitored channels and retain automatic background locks",()=>{
            var options=Json(Options());var devices=Mixed();
            Reject(()=>CoordinationEngine.ValidateManualPlan(devices,options,Profiles,new Dictionary<string,int>{{"managed",641000},{"monitor",651000}},default),"只能保留当前频率");
            var result=CoordinationEngine.ValidateManualPlan(devices,options,Profiles,new Dictionary<string,int>{{"managed",641000},{"monitor",650000}},default);
            Check(result.GetProperty("monitoringOnlyChannels")[0].GetProperty("fixedMonitoringOnly").GetBoolean(),"manual result fixed marker");
            Check(result.GetProperty("options").GetProperty("knownCarriers").EnumerateArray().Any(x=>x.GetProperty("ownerDeviceId").GetString()=="monitor"),"manual result keeps background occupancy");
        });
        yield return ("Native deployment excludes fixed monitors from both all and single command lists",()=>{
            var devices=Mixed();var options=Json(Options());var result=CoordinationEngine.Plan(devices,options,Profiles,default);
            var all=CoordinationEngine.ValidateDeployment(result,devices,devices,options,Profiles,null,default);
            Check(all.GetArrayLength()==1&&all[0].GetProperty("deviceId").GetString()=="managed","only actual controller returned");
            var single=CoordinationEngine.ValidateDeployment(result,devices,devices,options,Profiles,"monitor",default);
            Check(single.GetArrayLength()==0,"monitor click is unchanged, no target needed");
            var sequence=CoordinationEngine.ValidateDeploymentSequence(result,devices,options,Profiles,default);
            Check(sequence.GetArrayLength()==1,"preflight sequence excludes monitor");
        });
        yield return ("Fixed monitoring deployment detects current frequency drift and capability changes",()=>{
            var devices=Mixed();var options=Json(Options());var result=CoordinationEngine.Plan(devices,options,Profiles,default);
            var moved=Json(new[]{Device("managed",1,640000),Device("monitor",2,650025,false)});
            Reject(()=>CoordinationEngine.ValidateDeployment(result,devices,moved,options,Profiles,null,default),"频率、Profile 或控制能力已变化");
            var lost=Device("managed",1,640000);lost["capabilities"]=null;
            var active=Json(new[]{lost,Device("monitor",2,650000,false)});
            Reject(()=>CoordinationEngine.ValidateDeployment(result,devices,active,options,Profiles,null,default),"方案未完整通过");
        });
        yield return ("Monitored background outside planning range and under a scan peak does not block available targets",()=>{
            var devices=Json(new[]{Device("managed",2,640000),Device("monitor",1,650000,false)});
            var options=Options();options["rangeStartKHz"]=638000;options["rangeEndKHz"]=642000;
            options["scanPoints"]=Enumerable.Range(0,601).Select(i=>new{frequencyKHz=637000+i*25,levelDbm=i is >=510 and <=530?-30:-110}).ToArray();options["maxScanGapKHz"]=25;
            var result=CoordinationEngine.Plan(devices,Json(options),Profiles,default);
            Check(result.GetProperty("search").GetProperty("complete").GetBoolean()&&result.GetProperty("assignments").GetArrayLength()==1,"outside-range background and its measured peak do not become target constraints");
            Check(result.GetProperty("monitoringOnlyChannels")[0].GetProperty("frequencyKHz").GetInt32()==650000,"background remains actual occupied frequency");
            Check(CoordinationEngine.ValidateDeploymentSequence(result,devices,Json(options),Profiles,default).GetArrayLength()==1,"same background works through sequence preflight");
        });
        yield return ("Monitoring background excludes a nearby candidate and preserves reverse IMD protection",()=>{
            var devices=Mixed();var options=Options();options["imdProducts"]=Array.Empty<string>();
            Reject(()=>CoordinationEngine.ValidateManualPlan(devices,Json(options),Profiles,new Dictionary<string,int>{{"managed",650250},{"monitor",650000}},default),"仅监测通道");
            var three=Json(new[]{Device("a",1,640000),Device("b",2,641000),Device("monitor",3,642000,false)});
            options=Options();
            Reject(()=>CoordinationEngine.ValidateManualPlan(three,Json(options),Profiles,new Dictionary<string,int>{{"a",640000},{"b",641000},{"monitor",642000}},default),"2T3O");
        });
        yield return ("Native all-channel sequence rejects an unsafe intermediate collision before any SET",()=>{
            var devices=Json(new[]{Device("first",1,640000),Device("second",2,645000)});var options=Json(Options());
            var result=CoordinationEngine.ValidateManualPlan(devices,options,Profiles,new Dictionary<string,int>{{"first",645000},{"second",650000}},default);
            Check(CoordinationEngine.ValidateDeployment(result,devices,devices,options,Profiles,null,default).GetArrayLength()==2,"final plan alone is compatible");
            Reject(()=>CoordinationEngine.ValidateDeploymentSequence(result,devices,options,Profiles,default),"顺序预检失败");
            Check(devices[0].GetProperty("freq").GetInt32()==640000&&devices[1].GetProperty("freq").GetInt32()==645000,"pure preflight does not change snapshot");
        });
        yield return ("Native all-channel sequence uses GROUP order and advances only its simulated baseline",()=>{
            var devices=Json(new[]{Device("second",2,650000),Device("first",1,640000)});var options=Json(Options());
            var result=CoordinationEngine.ValidateManualPlan(devices,options,Profiles,new Dictionary<string,int>{{"first",641000},{"second",651000}},default);
            var rows=CoordinationEngine.ValidateDeploymentSequence(result,devices,options,Profiles,default);
            Check(rows.GetArrayLength()==2&&rows[0].GetProperty("deviceId").GetString()=="first"&&rows[1].GetProperty("deviceId").GetString()=="second","group order preflight");
            Check(devices[0].GetProperty("freq").GetInt32()==650000,"no source mutation");
        });
        yield return ("Native monitoring lock is opt-in so independent mathematical fixtures keep their contract",()=>{
            var options=Options();options.Remove("lockMonitoringOnly");var devices=Json(new[]{Device("pure-math",1,null,false)});
            var result=CoordinationEngine.Plan(devices,Json(options),Profiles,default);
            Check(result.GetProperty("assignments").GetArrayLength()==1&&!Row(result,"pure-math").TryGetProperty("fixedMonitoringOnly",out _),"legacy pure math stays available");
        });
        yield return ("An all-monitoring scene returns background only with an empty device-command sequence",()=>{
            var devices=Json(new[]{Device("monitor",1,690000,false)});var options=Json(Options());
            var result=CoordinationEngine.Plan(devices,options,Profiles,default);
            Check(result.GetProperty("assignments").GetArrayLength()==0&&result.GetProperty("monitoringOnlyChannels").GetArrayLength()==1,"no invented controllable receiver");
            Check(CoordinationEngine.ValidateDeploymentSequence(result,devices,options,Profiles,default).GetArrayLength()==0,"zero SET targets");
        });
        yield return ("Verified Shure and DATY retain separate deployable profiles within the mixed plan",()=>{
            var shure=Device("shure",2,650000,false);shure["model"]="ULXD4";
            shure["capabilities"]=new{adapter="shure-scp",write_frequency=true,read_only=false,
                hardware_band=new{band="L51",source="chassis-label-confirmed",verified=true},
                frequency_control=new{scope="shure-scp",min_khz=632000,max_khz=696000,step_khz=25,origin_khz=0,ack_mode="readback",brand_binding="expected-brand-v1"}};
            var devices=Json(new[]{Device("daty",1,640000),shure});var options=Json(Options());var result=CoordinationEngine.Plan(devices,options,Profiles,default);
            Check(result.GetProperty("monitoringOnlyChannels").GetArrayLength()==0,"verified brands remain controlled");
            var rows=CoordinationEngine.ValidateDeploymentSequence(result,devices,options,Profiles,default);
            Check(rows.GetArrayLength()==2&&Row(result,"shure").GetProperty("profileBandId").GetString()=="L51","hardware band preserved");
            Check(Row(result,"shure").GetProperty("frequencyKHz").GetInt32()%25==0&&Row(result,"daty").GetProperty("frequencyKHz").GetInt32()%250==0,"brand grids preserved");
        });
        yield return ("Batch preflight retains original occupied carriers after its simulated earlier move",()=>{
            var devices=Json(new[]{Device("first",1,640000),Device("second",2,650000)});var values=Options();values["protectCurrentFrequencies"]=true;var options=Json(values);
            var result=CoordinationEngine.ValidateManualPlan(devices,options,Profiles,new Dictionary<string,int>{{"first",641000},{"second",653000}},default);
            Check(result.GetProperty("protectedCurrentCarriers").GetArrayLength()==2,"original on-air frequencies captured");
            Check(CoordinationEngine.ValidateDeploymentSequence(result,devices,options,Profiles,default).GetArrayLength()==2,"entire sequence retains captured occupancy");
            var advanced=Json(new[]{Device("first",1,641000),Device("second",2,650000)});
            Check(CoordinationEngine.ValidateDeployment(result,advanced,advanced,options,Profiles,"second",default).GetArrayLength()==1,"subsequent live preflight accepts only compatible second move");
            Check(result.GetProperty("protectedCurrentCarriers").EnumerateArray().Any(c=>c.GetProperty("frequencyKHz").GetInt32()==640000),"first old frequency not released by baseline advancement");
        });
    }
}
