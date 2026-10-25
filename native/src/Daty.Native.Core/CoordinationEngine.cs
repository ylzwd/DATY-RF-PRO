using System.Text.Json;
using Jint;

namespace Daty.Native.Core;

// Pure business mathematics shared byte-for-byte with r19. The desktop UI is
// WPF; this runtime has no DOM, browser, filesystem, network or CLR access.
public static class CoordinationEngine
{
    public static JsonElement CalculationDevices(IEnumerable<Channel> channels)=>JsonSerializer.SerializeToElement(channels.Select(c=>{
        var value=c.Raw.Deserialize<Dictionary<string,JsonElement>>()!;
        value["_fasheId"]=JsonSerializer.SerializeToElement(c.Id);value["_online"]=JsonSerializer.SerializeToElement(c.Online);
        if(!c.Online)value["status"]=JsonSerializer.SerializeToElement("offline");
        return value;
    }));

    public static void ValidateProfiles(JsonElement profiles,CancellationToken token)
    {
        var engine=Create(token);engine.SetValue("input",profiles.GetRawText());
        engine.Execute("const values=JSON.parse(input);if(!Array.isArray(values)||values.length>1000)throw Error('Profile 必须为数组且不超过1000项');const ids=new Set();for(const p of values){const errors=DatyEquipmentProfiles.validateEquipmentProfile(p);if(errors.length)throw Error(errors.join('；'));if(ids.has(p.id))throw Error('Profile 标识重复');ids.add(p.id);}");
    }

    public static JsonElement ValidateDeployment(JsonElement result,JsonElement saved,JsonElement active,JsonElement options,JsonElement profiles,string? target,CancellationToken token)
    {
        var engine=Create(token);engine.SetValue("profileJson",profiles.GetRawText());engine.SetValue("resultJson",result.GetRawText());engine.SetValue("savedJson",saved.GetRawText());engine.SetValue("activeJson",active.GetRawText());engine.SetValue("optionsJson",options.GetRawText());engine.SetValue("targetId",target);
        engine.Execute("profileValues['daty_equipment_profiles_v2']=profileJson;");
        var json=engine.Evaluate("JSON.stringify(nativeValidateDeployment(JSON.parse(resultJson),JSON.parse(savedJson),JSON.parse(activeJson),JSON.parse(optionsJson),targetId))").AsString();
        using var document=JsonDocument.Parse(json);return document.RootElement.Clone();
    }

    // Preflight the entire existing GROUP/CH sequence before any device SET.
    // The returned order is a pure simulation; each actual send still revalidates
    // live bindings and waits for the brand's execution ACK / independent readback.
    public static JsonElement ValidateDeploymentSequence(JsonElement result,JsonElement saved,JsonElement options,JsonElement profiles,CancellationToken token)
    {
        var engine=Create(token);engine.SetValue("profileJson",profiles.GetRawText());engine.SetValue("resultJson",result.GetRawText());engine.SetValue("savedJson",saved.GetRawText());engine.SetValue("optionsJson",options.GetRawText());
        engine.Execute("profileValues['daty_equipment_profiles_v2']=profileJson;");
        var json=engine.Evaluate("""
        (()=>{
          const result=JSON.parse(resultJson),baseline=JSON.parse(savedJson),options=JSON.parse(optionsJson);
          const rows=nativeValidateDeployment(result,baseline,baseline,options,null);
          const positions=new Map(baseline.map((d,index)=>[String(d.id),{...DatyCoordination.getDevicePlanningPosition(d),index}]));
          rows.sort((a,b)=>{const x=positions.get(String(a.deviceId)),y=positions.get(String(b.deviceId));return (x.groupNumber??Infinity)-(y.groupNumber??Infinity)||(x.channelNumber??Infinity)-(y.channelNumber??Infinity)||x.index-y.index;});
          for(const row of rows){
            const device=baseline.find(d=>String(d.id)===String(row.deviceId));
            if(device.freq===row.frequencyKHz)continue;
            try{nativeValidateDeployment(result,baseline,baseline,options,String(row.deviceId));}
            catch(error){throw Error('全部下发顺序预检失败，尚未发送：'+row.deviceId+' · '+error.message);}
            device.freq=row.frequencyKHz;
          }
          return JSON.stringify(rows);
        })()
        """).AsString();using var document=JsonDocument.Parse(json);return document.RootElement.Clone();
    }
    public static JsonElement Plan(JsonElement devices,JsonElement options,JsonElement profiles,CancellationToken token)
    {
        var engine=Create(token);engine.SetValue("devicesJson",devices.GetRawText());engine.SetValue("optionsJson",options.GetRawText());engine.SetValue("profilesJson",profiles.GetRawText());
        engine.Execute("profileValues['daty_equipment_profiles_v2']=profilesJson;");
        var json=engine.Evaluate("(()=>{const state=nativePlanningInputs(JSON.parse(devicesJson),JSON.parse(optionsJson));return JSON.stringify(nativeMarkMonitoring(DatyCoordination.coordinateFrequencies(state.devices,state.options),state));})()").AsString();
        using var document=JsonDocument.Parse(json);return document.RootElement.Clone();
    }
    public static int ParseManualFrequency(string text)
    {
        if(!System.Text.RegularExpressions.Regex.IsMatch(text.Trim(),@"^\d+(?:\.\d{1,3})?$")||
           !decimal.TryParse(text,System.Globalization.NumberStyles.AllowDecimalPoint|System.Globalization.NumberStyles.AllowLeadingWhite|System.Globalization.NumberStyles.AllowTrailingWhite,System.Globalization.CultureInfo.InvariantCulture,out var mhz)||mhz is <30 or >3000)
            throw new InvalidDataException("规划频率请输入 30～3000 MHz，最多 3 位小数");
        return (int)(mhz*1000);
    }

    public static JsonElement ValidateManualPlan(JsonElement devices,JsonElement options,JsonElement profiles,IReadOnlyDictionary<string,int> frequencies,CancellationToken token)
    {
        var engine=Create(token);engine.SetValue("devicesJson",devices.GetRawText());engine.SetValue("optionsJson",options.GetRawText());engine.SetValue("profilesJson",profiles.GetRawText());engine.SetValue("frequenciesJson",JsonSerializer.Serialize(frequencies));
        engine.Execute("profileValues['daty_equipment_profiles_v2']=profilesJson;");
        var json=engine.Evaluate("""
        (()=>{
          const devices=JSON.parse(devicesJson),state=nativePlanningInputs(devices,JSON.parse(optionsJson)),options=state.options,entries=Object.entries(JSON.parse(frequenciesJson)),map=new Map(entries);
          if(!devices.length||new Set(devices.map(d=>String(d.id))).size!==devices.length||map.size!==devices.length||devices.some(d=>!map.has(String(d.id))||!Number.isInteger(map.get(String(d.id)))))throw Error('手动规划必须对应全部唯一在线通道');
          for(const monitor of state.monitoringOnlyChannels)if(map.get(String(monitor.deviceId))!==monitor.frequencyKHz)throw Error('仅监测通道只能保留当前频率：'+monitor.deviceId);
          const managedIds=new Set(state.devices.map(device=>String(device.id))),managedEntries=entries.filter(([id])=>managedIds.has(String(id))),managedMap=new Map(managedEntries);
          const analysis=DatyCoordination.analyzeFrequencyPlan(state.devices,managedMap,options);
          if(analysis.conflicts.length)throw Error('手动频率校验失败：'+[...new Set(analysis.conflicts.map(c=>c.reason))].slice(0,4).join('；'));
          // Pin the intended frequencies for calculation only. Never mutate persisted locks
          // or let the solver silently move a manually requested frequency.
          const result=DatyCoordination.coordinateFrequencies(state.devices,{...options,lockedAssignments:managedEntries.map(([deviceId,frequencyKHz])=>({deviceId,frequencyKHz})),backupCount:0});
          if(result.errors.length||!result.search.complete||result.assignments.length!==state.devices.length||result.assignments.some(a=>managedMap.get(String(a.deviceId))!==a.frequencyKHz))throw Error('手动频率校验失败：'+(result.errors.join('；')||'频点未完整通过'));
          result.options.lockedAssignments=options.lockedAssignments||[];result.options.backupCount=options.backupCount||0;
          result.analysis=analysis;result.manualValidation=true;
          for(const assignment of result.assignments){
            assignment.locked=(options.lockedAssignments||[]).some(l=>String(l.deviceId)===String(assignment.deviceId));
            assignment.protectedOriginal=false;assignment.backupFrequenciesKHz=[];
            assignment.changeReason=assignment.retainedOriginal?'当前频率经手动方案校核保留':'手动指定频率已通过设备与规划约束校核';
          }
          result.retention.protectedDeviceIds=[];
          if(options.backupCount>0)result.warnings.push('手动修改后未生成备用频率；需要备用时请重新进行全局规划');
          return JSON.stringify(nativeMarkMonitoring(result,state));
        })()
        """).AsString();using var document=JsonDocument.Parse(json);return document.RootElement.Clone();
    }

    public static JsonElement Simulate(JsonElement devices,JsonElement options,double start,double end,CancellationToken token,JsonElement? profiles=null)
    {
        var engine=Create(token);if(profiles is JsonElement values){engine.SetValue("profilesJson",values.GetRawText());engine.Execute("profileValues['daty_equipment_profiles_v2']=profilesJson;");}engine.SetValue("devicesJson",devices.GetRawText());engine.SetValue("optionsJson",options.GetRawText());engine.SetValue("startKHz",(int)Math.Round(start*1000));engine.SetValue("endKHz",(int)Math.Round(end*1000));
        var json=engine.Evaluate("JSON.stringify(DatyRfSimulation.build(JSON.parse(devicesJson),{startMHz:startKHz/1000,endMHz:endKHz/1000},JSON.parse(optionsJson)))").AsString();using var d=JsonDocument.Parse(json);return d.RootElement.Clone();
    }
    private static Engine Create(CancellationToken token)
    {
        var engine=new Engine(o=>o.TimeoutInterval(TimeSpan.FromSeconds(30)).CancellationToken(token).LimitMemory(256*1024*1024));engine.Execute("var window=globalThis,profileValues={};var DatyPlatform={storage:{getItem:k=>profileValues[k]??null,setItem:()=>{throw Error('native calculation is read-only')},removeItem:()=>{throw Error('native calculation is read-only')}}};");
        var assembly=typeof(CoordinationEngine).Assembly;foreach(var name in new[]{"frequency.js","equipment-profiles.js","coordination.js","rf-simulation.js"}){using var stream=assembly.GetManifestResourceStream(assembly.GetManifestResourceNames().Single(n=>n.EndsWith("."+name,StringComparison.Ordinal)))!;using var reader=new StreamReader(stream);engine.Execute(reader.ReadToEnd());}engine.Execute(NativePlanningHelpers);return engine;
    }

    private const string NativePlanningHelpers="""
    function nativeCanDeploy(device,profile){
      return DatyEquipmentProfiles.canDeployProfileToFashe(profile,device)
        && DatyEquipmentProfiles.isProfileDeploymentEligible(profile,device.equipmentBandId)
        && device.capabilities?.frequency_control?.brand_binding==='expected-brand-v1';
    }
    function nativePlanningInputs(devices,input){
      const options={...input,lockedAssignments:(input.lockedAssignments||[]).map(lock=>({...lock})),knownCarriers:(input.knownCarriers||[]).map(carrier=>({...carrier}))};
      const fixed=new Set(),managed=[],monitoringOnlyChannels=[],monitoringSnapshots=[];
      if(input.lockMonitoringOnly!==true)return {options,fixed,devices,monitoringOnlyChannels,monitoringSnapshots};
      for(const device of devices){
        const profile=DatyEquipmentProfiles.resolveEquipmentProfile(device);
        if(nativeCanDeploy(device,profile)){managed.push(device);continue;}
        if(!Number.isSafeInteger(device.freq)||device.freq<30000||device.freq>3000000)throw Error('仅监测通道缺少真实当前频率，不能规划：'+device.id);
        const errors=DatyEquipmentProfiles.validateEquipmentProfile(profile);if(errors.length)throw Error('仅监测通道 Profile 无效：'+device.id+' · '+errors.join('；'));
        const existing=options.lockedAssignments.filter(lock=>String(lock.deviceId)===String(device.id));
        if(existing.some(lock=>lock.frequencyKHz!==device.freq))throw Error('仅监测通道只能保留当前频率，人工锁定不能改频：'+device.id);
        options.lockedAssignments=options.lockedAssignments.filter(lock=>String(lock.deviceId)!==String(device.id));
        const limits=DatyEquipmentProfiles.getPlanningCompatibilitySettings(profile,options.compatibilityLevel||'standard',device.equipmentModeId);
        const guardKHz=Math.max(1,limits.channelSpacingKHz,DatyEquipmentProfiles.getMinimumChannelSpacingKHz(profile,device),options.minChannelSpacingKHz??0,limits.intermodSpacingKHz,options.minImdSpacingKHz??0);
        const carrier={id:'monitoring:'+String(device.id),ownerDeviceId:String(device.id),frequencyKHz:device.freq,guardKHz,intermodSource:profile.intermodSource!==false,reason:'仅监测通道，保留真实在用频率'};
        const present=options.knownCarriers.find(item=>String(item.ownerDeviceId)===String(device.id)&&item.frequencyKHz===device.freq);
        if(present){present.guardKHz=Math.max(present.guardKHz,guardKHz);present.intermodSource=present.intermodSource!==false||carrier.intermodSource;}
        else options.knownCarriers.push(carrier);
        monitoringOnlyChannels.push({deviceId:device.id,frequencyKHz:device.freq,brand:device.brand,profileId:profile.id,fixedMonitoringOnly:true,guardKHz,changeReason:'仅监测通道：保留在用频率，参与联合协调，不下发'});
        monitoringSnapshots.push({deviceId:device.id,frequencyKHz:device.freq,brandKey:DatyEquipmentProfiles.normalizeBrand(device.brand),profile,capabilities:device.capabilities??null});
        fixed.add(String(device.id));
      }
      return {options,fixed,devices:managed,monitoringOnlyChannels,monitoringSnapshots};
    }
    function nativeMarkMonitoring(result,state){
      if(state.options.lockMonitoringOnly===true){
        result.monitoringOnlyChannels=state.monitoringOnlyChannels;result.monitoringSnapshots=state.monitoringSnapshots;
      }
      if(state.options.protectCurrentFrequencies===true)result.protectedCurrentCarriers=(result.options.knownCarriers||[]).filter(carrier=>state.devices.some(device=>carrier.id==='current:'+String(device.id)&&String(carrier.ownerDeviceId)===String(device.id)));
      return result;
    }
    function nativeValidateDeployment(r,saved,active,input,targetId){
      const state=nativePlanningInputs(active,input),options=state.options;
      if(r.engineVersion!==DatyCoordination.ENGINE_VERSION||r.errors.length||r.analysis.conflicts.length||r.unassignedDeviceIds.length||!r.search.complete||r.assignments.length!==state.devices.length)throw Error('方案未完整通过，不能下发');
      if(active.length!==saved.length)throw Error('在线通道数量变化，请重新规划');
      const assignments=new Map(r.assignments.map(a=>[String(a.deviceId),a])),snapshots=new Map(r.profileSnapshots.map(p=>[String(p.deviceId),p])),rows=[];
      if(options.lockMonitoringOnly===true){
        if(JSON.stringify(r.monitoringSnapshots)!==JSON.stringify(state.monitoringSnapshots))throw Error('仅监测通道的频率、Profile 或控制能力已变化，请重新规划');
        if((r.monitoringOnlyChannels||[]).some(channel=>!state.fixed.has(String(channel.deviceId))))throw Error('仅监测背景已变化，请重新规划');
      }
      if(options.protectCurrentFrequencies===true){
        if(!Array.isArray(r.protectedCurrentCarriers))throw Error('原占用快照缺失，请重新规划');
        for(const carrier of r.protectedCurrentCarriers)if(!options.knownCarriers.some(item=>String(item.ownerDeviceId)===String(carrier.ownerDeviceId)&&item.frequencyKHz===carrier.frequencyKHz))options.knownCarriers.push({...carrier});
      }
      let fixedTarget=false;
      for(const original of saved){
        const matches=active.filter(d=>String(d.id)===String(original.id));if(matches.length!==1)throw Error('接收机通道不能唯一定位');const d=matches[0],a=assignments.get(String(d.id));
        for(const field of ['id','receiver_id','receiver_ip','receiver_mac','channel_number','_source','group_number','group_source','freq','equipmentProfileId','equipmentBandId','equipmentModeId'])if(JSON.stringify(d[field])!==JSON.stringify(original[field]))throw Error('身份、会话、编组或频率已变化：'+d.id);
        if(!d._online||DatyEquipmentProfiles.normalizeBrand(d.brand)!==DatyEquipmentProfiles.normalizeBrand(original.brand))throw Error('设备离线或品牌不匹配');
        if(state.fixed.has(String(d.id))){
          if(a)throw Error('仅监测通道不能进入下发清单：'+d.id);
          if(targetId!=null&&String(d.id)===String(targetId))fixedTarget=true;
          continue;
        }
        if(!a||a.brandKey!==DatyEquipmentProfiles.normalizeBrand(d.brand))throw Error('规划目标缺失或品牌不匹配');
        const profile=DatyEquipmentProfiles.resolveEquipmentProfile(d),controllable=nativeCanDeploy(d,profile);
        if(JSON.stringify(profile)!==JSON.stringify(snapshots.get(String(d.id))?.profile)||(d.equipmentBandId||profile.defaultBandId)!==a.profileBandId||(d.equipmentModeId||options.compatibilityLevel)!==a.profileModeId)throw Error('Profile、频段或模式已变化');
        if(targetId==null||String(d.id)===String(targetId)){
          if(!controllable)throw Error('缺少已验证 Profile 或硬件控制能力：'+d.id);
          const range=DatyEquipmentProfiles.getProfileTuningRange(profile,d.equipmentBandId),grid=DatyEquipmentProfiles.getProfileFrequencyGrid(profile,d.equipmentBandId);
          if(a.frequencyKHz<range[0]||a.frequencyKHz>range[1]||(a.frequencyKHz-grid.originKHz)%grid.stepKHz)throw Error('频率超出硬件范围或栅格');
          rows.push(a);
        }
      }
      if(DatyCoordination.analyzeFrequencyPlan(state.devices,new Map(r.assignments.map(a=>[a.deviceId,a.frequencyKHz])),options).conflicts.length)throw Error('完整方案数学复核失败');
      if(targetId!=null&&!fixedTarget){
        if(rows.length!==1)throw Error('单通道目标不唯一');
        const hybrid=new Map(state.devices.map(d=>[d.id,String(d.id)===String(targetId)?rows[0].frequencyKHz:d.freq]));
        const hybridOptions={...options,lockedAssignments:options.lockedAssignments.filter(l=>String(l.deviceId)===String(targetId)||hybrid.get(l.deviceId)===l.frequencyKHz)};
        const conflicts=DatyCoordination.analyzeFrequencyPlan(state.devices,hybrid,hybridOptions).conflicts.filter(i=>String(i.victimDeviceId)===String(targetId)||i.sourceDeviceIds?.some(id=>String(id)===String(targetId)));
        if(conflicts.length)throw Error('此频点与其他通道当前实频冲突，单通道下发被阻止');
      }
      return rows;
    }
    """;
}
