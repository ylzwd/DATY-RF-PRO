// 规划部署事务：完整预检 + 服务器目标绑定 -> 人工确认 -> 再核验 -> 接收机 + CH -> request/command ACK。
// 只控制已识别的 FAshe；不把发布成功、无冲突数学结果或缓存当作设备执行成功。
(function(global){
  'use strict';
  const copy=v=>JSON.parse(JSON.stringify(v));
  const key=d=>String(d._fasheId || d.id);
  const mhz=v=>global.DatyFrequency.formatFrequencyMHz(v);
  const brand=v=>global.DatyEquipmentProfiles.normalizeBrand(v || '');
  let plan=null,busy=false,confirming=false,stopRequested=false,generation=0,summary='未规划 · 下发须通过完整校验和设备确认';
  const rowStates=new Map();
  let updateActiveProgress=null;
  let refreshTimer=null;
  const diagnostics=[];
  function runtime(method,...args){
    if(global.DatyHostFactory)return global.DatyHostFactory.invokeRuntime(global,method,...args);
    if(global.DatyPlatform && global.DatyPlatform.kind!=='browser')throw new Error('原生运行时组件未加载');
    if(method==='nowMonotonicMs')return global.performance.now();
    return global[method](...args);
  }
  function cancelRefresh(){if(refreshTimer!==null){runtime('clearTimeout',refreshTimer);refreshTimer=null;}}
  function scheduleRefresh(){
    if(refreshTimer!==null)return;
    try{refreshTimer=runtime('setTimeout',()=>{refreshTimer=null;refreshTable();},100);}
    catch(error){global.console?.error?.('下发视图调度失败',error);}
  }
  async function saveDiagnostic(record,endpoint){
    if(global.DatyDataRetention?.history===false){record.audit='disabled';return;}
    let timer;
    const controller=new AbortController();
    try{
      timer=runtime('setTimeout',()=>controller.abort(),3000);
      const request=global.DatyPlatform?.request || ((!global.DatyPlatform || global.DatyPlatform.kind==='browser') && global.fetch);
      if(typeof request!=='function')throw new Error('宿主网络组件不可用');
      const response=await request(`${endpoint}/api/timeline/events`,{
        method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
        body:JSON.stringify({...global.DatyMqttMutationIntent(endpoint),event_type:'planning.deployment',summary:`频率下发：设备 ACK ${record.acknowledged-(record.readbackConfirmed||0)} · 回读确认 ${record.readbackConfirmed||0} · 原频一致 ${record.skipped} · 失败 ${record.failed} · 未发送 ${record.remaining}`,details:copy(record)})});
      const result=await response.json();
      if(!result.success)throw new Error('服务器未确认保存');
      record.audit='saved';
    }catch(error){
      record.audit='unconfirmed';
      global.console?.error?.('下发诊断记录保存未确认',error);
      try{global.notify?.('⚠️','下发记录保存未确认','设备确认 结果保持；本次耗时明细未确认存入服务器，不自动重试。');}catch(_){}
    }finally{try{if(timer!==undefined)runtime('clearTimeout',timer);}catch(_){} }
  }
  function devices(){return global.DATY_STATE?.devices || global.DEVICES || [];}
  function product(d){return typeof global.formatBrandModelDisplay==='function' ? global.formatBrandModelDisplay(d) : `${d.brand || '未知品牌'} ${d.model || '未知型号'}`;}
  function label(d){return `${product(d)} · ${global.formatChannelDisplay(d)} · ${d.receiver_ip || d.ip || d.receiver_mac || d.receiver_id || key(d)}`;}
  function current(saved){return global.findPlanningDevice(saved);}
  function setSummary(text){summary=text;refreshStatus();}
  function refreshTable(){try{global.renderFreqTable?.(true);}catch(error){global.console?.error?.('下发表格刷新异常',error);}refreshControls();}
  function setRow(d,state,text){rowStates.set(key(d),{state,text});if(busy)scheduleRefresh();else refreshTable();}

  function refreshStatus(){
    try{
      const status=document.getElementById('plannerDeployStatus');if(status){status.textContent=summary;status.title=summary;}
      const stop=document.getElementById('plannerStopDeployment');if(stop){stop.hidden=!busy;stop.disabled=stopRequested;}
      const all=document.getElementById('plannerPushAll');if(all)all.disabled=busy || confirming;
    }catch(error){global.console?.error?.('下发状态显示异常',error);}
  }
  function refreshControls(){
    refreshStatus();
    try{renderControls();}catch(error){global.console?.error?.('下发控件显示异常',error);}
  }
  function renderControls(){
    const targets=global.DatyPlanningConstraints.getPlanningDevices();
    const select=document.getElementById('targetChannelSelect');
    const receivers=new Set(targets.map(d=>global.getCanonicalReceiverKey?.(d) || d.receiver_ip || d.ip || key(d)));
    if(select){
      const html=`<option value="${targets.length}">${targets.length} 个实际通道 · ${receivers.size} 台接收机</option>`;
      if(select.innerHTML!==html)select.innerHTML=html;
      select.disabled=true;
    }
    const hint=document.getElementById('targetChannelHint');
    if(hint){hint.textContent=`离线缓存不计入 · 全局校验 ${targets.length} 个实际通道`;hint.title=hint.textContent;}
    const rule=document.getElementById('currentRule');
    if(rule){
      const supported=targets.filter(d=>{try{const p=global.DatyEquipmentProfiles.resolveEquipmentProfile(d);return global.DatyEquipmentProfiles.canDeployProfileToFashe(p,d) && global.DatyEquipmentProfiles.isProfileDeploymentEligible(p,d.equipmentBandId);}catch(_){return false;}}).length;
      rule.textContent=`DATYaudio ≥250 kHz / 候选步进250 · 多品牌联合 IMD · 可写接收机 ${supported}/${targets.length}`;
      rule.title='DATY 候选如 641.000/641.250/641.500 MHz，IMD 冲突会跳过；跨品牌通道间隔取双方较大值，互调保护距离取参与者较大值。结果只下发到原品牌/接收机/CH。其他品牌未验证 Profile 不开放下发。';
    }
  }

  function setPlan(result,items,options,fields){
    generation++;rowStates.clear();
    plan={reference:result,result:copy(result),devices:copy(items),options:copy(options),fields:copy(fields),generation,
      actual:new Map(items.map(d=>[String(d.id),d.freq]))};
    plan.assignments=new Map(plan.result.assignments.map(a=>[String(a.deviceId),a]));
    plan.profiles=new Map(plan.result.profileSnapshots.map(a=>[String(a.deviceId),a]));
    for(const a of result.assignments){const d=items.find(d=>d.id===a.deviceId);if(d)rowStates.set(key(d),{state:'ready',text:'未下发'});}
    setSummary(result.errors.length || result.analysis.conflicts.length || result.unassignedDeviceIds.length
      ? '方案未完整通过 · 不允许下发，请查看详情'
      : `方案已生成 ${result.assignments.length} 通道 · 下发前核对在线身份/频段/当前频率`);
  }
  function invalidate(reason){generation++;plan=null;if(!busy)rowStates.clear();setSummary(`待重新规划 · ${reason}`);}
  function preflight(targetId,validation){
    const p=plan;
    if(!p || p.reference!==global.DATY_LAST_COORDINATION)throw new Error('没有有效的本次规划，请先一键全局规划');
    const r=p.result;
    if(r.engineVersion!==global.DatyCoordination.ENGINE_VERSION)throw new Error('规划算法规则已更新，请重新全局规划');
    if(r.errors.length || r.analysis.conflicts.length || r.unassignedDeviceIds.length || r.assignments.length!==p.devices.length || !r.search.complete)throw new Error('方案不完整或有冲突，不能下发部分规划冒充完整方案');
    if(JSON.stringify(p.fields)!==JSON.stringify(global.DatyPlanningConstraints.captureConstraintFields()) || JSON.stringify(p.options)!==JSON.stringify(global.DatyPlanningConstraints.getOptions()))throw new Error('规划输入/扫描已变化，请重新全局规划');
    const active=global.DatyPlanningConstraints.getPlanningDevices();
    if(active.length!==p.devices.length)throw new Error('通道数量或在线状态已变化，请重新规划');
    const activeSet=new Set(active),seen=new Set(),resolved=[];
    for(const saved of p.devices){
      const d=current(saved),a=p.assignments.get(String(saved.id));
      if(!d || !activeSet.has(d) || seen.has(d))throw new Error(`原接收机通道 ${label(saved)} 已离线、重复或无法唯一定位`);
      seen.add(d);
      if(!a || !a.brandKey || a.brandKey!==brand(saved.brand) || a.brandKey!==brand(d.brand))throw new Error(`${label(d)} 品牌与本次规划绑定不一致，禁止跨品牌下发`);
      if(!global._deviceConnectionIsOnline(d))throw new Error(`${label(d)} 已离线`);
      if(saved._source && d._source!==saved._source)throw new Error(`${label(d)} 连接会话已变化，请重新规划`);
      if(p.options.allocationOrder==='receiver-group-ascending' && JSON.stringify(global.DatyCoordination.getDevicePlanningPosition(d))!==JSON.stringify(global.DatyCoordination.getDevicePlanningPosition(saved)))throw new Error(`${label(d)} 的 GROUP / CH 已变化，请重新规划`);
      if(d.freq!==p.actual.get(String(saved.id)))throw new Error(`${label(d)} 当前频率已在设备侧变化，请重新规划`);
      if(d.planned!==a.frequencyKHz)throw new Error(`${label(d)} 的规划频率已修改但未重新校验`);
      const input=document.getElementById('fi_'+d.id);
      if(input && global.DatyFrequency.toFrequencyKHz(input.value,'MHz')!==a.frequencyKHz)throw new Error(`${label(d)} 有未校验的手动频率，请重新规划`);
      const profile=global.DatyEquipmentProfiles.resolveEquipmentProfile(d);
      const original=p.profiles.get(String(saved.id));
      if(JSON.stringify(profile)!==JSON.stringify(original?.profile) || (d.equipmentBandId || profile.defaultBandId)!==a.profileBandId || (d.equipmentModeId || p.options.compatibilityLevel)!==a.profileModeId)throw new Error(`${label(d)} 的 Profile/频段/模式已变化`);
      const willSend=targetId===undefined || String(d.id)===String(targetId);
      if(willSend && brand(profile.manufacturer)!==a.brandKey)throw new Error(`${label(d)} 不能下发其他品牌或通用 Profile 的结果`);
      if(willSend && !global.DatyEquipmentProfiles.canDeployProfileToFashe(profile,d))throw new Error(`${label(d)} 缺少同品牌已核实间隔/可写接收机协议/设备确认能力；未验证品牌及硬件保持只读`);
      if(willSend && d.capabilities?.frequency_control?.brand_binding!=='expected-brand-v1')throw new Error('Bridge 尚未启用调频品牌核验，请重启新版 Bridge 后刷新服务器页面');
      if(willSend && !global.DatyEquipmentProfiles.isProfileDeploymentEligible(profile,d.equipmentBandId))throw new Error(`${label(d)} Profile/精确频段尚未验证`);
      const range=global.DatyEquipmentProfiles.getProfileTuningRange(profile,d.equipmentBandId),grid=global.DatyEquipmentProfiles.getProfileFrequencyGrid(profile,d.equipmentBandId);
      if(a.frequencyKHz<range[0] || a.frequencyKHz>range[1] || (a.frequencyKHz-grid.originKHz)%grid.stepKHz)throw new Error(`${label(d)} 不在设备频段/调谐栅格内`);
      const command=global.buildTargetedDeviceCommand(d,'set_freq',global.DatyFrequency.frequencyKHzToMHz(a.frequencyKHz));
      command.expected_brand=a.brandKey;
      const savedCommand=global.buildTargetedDeviceCommand(saved,'set_freq',command.value);
      for(const field of ['device_id','receiver_id','receiver_ip','receiver_mac','channel_number'])if(command[field]!==savedCommand[field])throw new Error(`${label(d)} 接收机身份/IP/MAC/CH 已变化，请重新规划`);
      if(willSend && (!d._fasheId || !command.receiver_id || !command.receiver_ip || !command.channel_number || command.channel_number!==global.getDeviceChannelNumberSafe(d)))throw new Error(`${label(d)} 缺少稳定接收机身份/IP/CH`);
      resolved.push({saved,d,a,command});
    }
    // Only the private, immutable mathematical inputs may reuse a successful
    // analysis within this confirmed batch. ALL live guards above still run
    // before every command; a new confirmation/engine gets a new validation.
    if(!validation || validation.plan!==p || validation.engine!==global.DatyCoordination){
      const analysis=global.DatyCoordination.analyzeFrequencyPlan(p.devices,new Map(r.assignments.map(a=>[a.deviceId,a.frequencyKHz])),p.options);
      if(analysis.conflicts.length)throw new Error(`下发预检发现 ${analysis.conflicts.length} 项约束冲突`);
      if(validation){validation.plan=p;validation.engine=global.DatyCoordination;}
    }
    if(targetId!==undefined){
      const target=resolved.find(row=>String(row.d.id)===String(targetId));
      if(!target)throw new Error('没有找到唯一的单通道下发目标');
      // 单发还要检查其他通道的当前实频，不能把尚未下发的规划值当作已执行。
      const hybrid=new Map(resolved.map(row=>[row.saved.id,row===target?row.a.frequencyKHz:row.d.freq]));
      const options={...p.options,lockedAssignments:p.options.lockedAssignments.filter(lock=>String(lock.deviceId)===String(target.saved.id) || hybrid.get(lock.deviceId)===lock.frequencyKHz)};
      const step=global.DatyCoordination.analyzeFrequencyPlan(p.devices,hybrid,options);
      const related=step.conflicts.filter(issue=>String(issue.victimDeviceId)===String(target.saved.id) || issue.sourceDeviceIds?.some(id=>String(id)===String(target.saved.id)));
      if(related.length)throw new Error(`${label(target.d)} 与其他通道当前实频存在冲突，请先处理关联通道或在允许改频时使用全部下发`);
    }
    return resolved.sort((a,b)=>a.command.channel_number-b.command.channel_number || a.command.device_id.localeCompare(b.command.device_id));
  }

  function deploymentEndpoint(expected){
    const endpoint=typeof _fasheApiUrl==='string'?_fasheApiUrl:'';
    if(!endpoint)throw new Error('尚未连接服务器，请连接后再下发');
    if(expected!==undefined && endpoint!==expected)throw Object.assign(new Error('服务器地址已变化，请重新核对下发目标'),{notSent:true});
    return endpoint;
  }
  function reportPreparationFailure(error){
    setSummary('未下发 · '+error.message);
    global.notify?.('❌','下发未执行',error.message);
  }

  async function deploy(id){
    if(busy || confirming){global.notify?.('⚠️',confirming?'等待操作确认':'正在下发',confirming?'请先确认或取消当前下发操作':'上一笔频率操作正在等待设备确认，请勿重复点击');return {ok:false,error:'busy'};}
    const opener=document.activeElement;
    let list,p,progressView,endpoint,started;
    const validation={};
    try{
      list=preflight(id);p=plan;
      if(id!==undefined){list=list.filter(item=>String(item.d.id)===String(id));if(list.length!==1)throw new Error('未在当前完整方案中找到唯一目标通道');}
    }catch(error){setSummary('预检未通过 · '+error.message);global.notify?.('❌','下发预检未通过',error.message);return {ok:false,error:error.message};}
    const warning=p.options.scanPoints.length ? '已使用导入扫描；仍须核对现场环境。' : '未导入真实扫描：仅通过数学约束，不能确认现场无干扰。';
    const unchanged=list.filter(({d,a})=>d.freq===a.frequencyKHz).length;
    confirming=true;refreshControls();
    try{
      endpoint=deploymentEndpoint();
      if(typeof global.DatyDialogs?.confirm!=='function')throw new Error('应用内确认组件未加载，请刷新服务器页面；本次没有发送');
      const accepted=await global.DatyDialogs.confirm({
        title:id===undefined?'确认全部下发':'确认单通道下发',
        message:id===undefined?`本次核对 ${list.length} 个通道 · ${list.length-unchanged} 个待调整 · ${unchanged} 个原频一致（将跳过）`
          :`请核对接收机和通道。${unchanged?'当前频率与规划一致，本次将重新发送并等待设备确认。':'确认后将发送该通道的规划频率。'}`,
        rows:list.map(({d,a})=>({brand:d.brand,receiver:d.receiver_ip || d.ip || d.receiver_mac || d.receiver_id,
          channel:global.formatChannelDisplay(d),currentFrequency:`${mhz(d.freq)} MHz`,plannedFrequency:`${mhz(a.frequencyKHz)} MHz`,
          note:d.freq===a.frequencyKHz?(id===undefined?'原频一致 · 无需发送':'原频一致 · 重新确认'):''})),
        warnings:[warning,'按 CH 依次发送并等待确认（DATY 设备 ACK / 舒尔回读），不是同时切换，过渡期间可能有瞬时干扰。','失败停止后续；已执行的频率不自动回退。请在允许改频时操作。'],
        footnote:'仅对清单中的品牌、接收机与通道生效',confirmLabel:id===undefined?'确认全部下发':'确认下发',cancelLabel:'取消'
      });
      if(!accepted)return {ok:false,cancelled:true};
      deploymentEndpoint(endpoint);
      // 应用内对话框不阻塞遥测：确认期间的离线/重连/改频/方案变化必须再次检查。
      if(plan!==p || p.generation!==generation)throw new Error('确认期间规划已变化，请重新规划并核对下发内容');
      preflight(id,validation);
      started=runtime('nowMonotonicMs');
      if(typeof global.DatyDeployProgress?.open!=='function')throw new Error('下发进度组件未加载，请刷新服务器页面；本次没有发送');
      progressView=global.DatyDeployProgress.open({title:id===undefined?'全部下发进度':'单通道下发进度',
        rows:list.map(({saved,d,a})=>({id:key(saved),brand:saved.brand,receiver:saved.receiver_ip || saved.ip || saved.receiver_mac || saved.receiver_id,
          channel:global.formatChannelDisplay(saved),frequency:`${mhz(a.frequencyKHz)} MHz`})),onStop:()=>global.DatyPlanningDeployment.stop()});
      if(typeof progressView?.update!=='function')throw new Error('下发进度组件不可用，本次没有发送');
      progressView.update({phase:'running',total:list.length,acknowledged:0,skipped:0,failed:0,remaining:list.length,currentLabel:'',
        message:'准备下发 · 尚未收到接收机确认',rows:list.map(({saved})=>({id:key(saved),state:'queued',text:'排队待发送'}))});
    }catch(error){try{progressView?.failBeforeSend?.(error.message);}catch(viewError){global.console?.error?.('下发准备异常显示失败',viewError);}reportPreparationFailure(error);return {ok:false,error:error.message,code:error.code};}
    finally{
      confirming=false;refreshControls();
      // The asynchronous confirmation may temporarily blur its disabled opener.
      if(opener?.isConnected && !opener.disabled && typeof opener.focus==='function'
          && (!document.activeElement || document.activeElement===document.body))opener.focus({preventScroll:true});
    }
    busy=true;stopRequested=false;refreshStatus();let acknowledged=0,readbackConfirmed=0,skipped=0,failed=0,sent=0;
    const elapsed=()=>{try{return Math.round(runtime('nowMonotonicMs')-started);}catch(_){return null;}};
    const diagnostic={version:'daty-deployment-diagnostic-v1',at:new Date().toISOString(),total:list.length,steps:[],state:'running'};
    diagnostics.push(diagnostic);if(diagnostics.length>10)diagnostics.shift();
    let currentTarget='',requestStopped='',watchdog=null,waitingSince=null;
    const updateProgress=(phase='running',message=summary)=>{
      const snapshot={phase,total:list.length,readbackConfirmed,acknowledged,skipped,failed,remaining:list.length-acknowledged-skipped-failed,currentLabel:currentTarget,message,
        rows:list.map(({saved,d})=>({id:key(saved),...(rowStates.get(key(d)) || {state:'queued',text:'排队待发送'})}))};
      // 视图异常不能丢掉在途 ACK 或中断已经开始的事务收尾。
      try{progressView.update(snapshot);}catch(error){global.console?.error?.('下发进度显示异常',error);}
    };
    updateActiveProgress=updateProgress;
    for(const item of list)rowStates.set(key(item.d),{state:'queued',text:'排队待发送'});
    try{
      refreshTable();
      try{watchdog=runtime('setInterval',()=>{
        if(waitingSince!==null){const seconds=Math.max(0,Math.floor((elapsed()-waitingSince)/1000));
          updateProgress('running',`${stopRequested?'已请求停止后续；':''}等待接收机确认 · ${seconds} 秒 · 超时将停止后续，未确认不计成功`);}
      },1000);}catch(error){global.console?.error?.('下发等待显示不可用',error);}
      for(const item of list){
        if(stopRequested || plan!==p || p.generation!==generation)break;
        let attempted=false;
        const step={device_id:key(item.saved),channel:global.getDeviceChannelNumberSafe(item.saved),state:'checking',
          receiver_id:item.saved.receiver_id,receiver_ip:item.saved.receiver_ip || item.saved.ip,
          group_number:global.getPlannerReceiverGroupNumber?.(item.saved) ?? null,frequency_khz:item.a.frequencyKHz,
          started_ms:elapsed()};
        diagnostic.steps.push(step);
        try{
          // 确认弹窗、前一笔 ACK 期间可能发生离线/外部调频，每一笔都再次预检。
          const live=preflight(id,validation).find(row=>String(row.saved.id)===String(item.saved.id));
          step.preflight_finished_ms=elapsed();
          if(!live)throw new Error('目标通道已变化');
          deploymentEndpoint(endpoint);
          if(id===undefined && live.d.freq===live.a.frequencyKHz){skipped++;step.state='unchanged';setRow(live.d,'unchanged','原频一致 · 无需发送');updateProgress('running','原频一致已跳过；跳过不代表设备确认');continue;}
          setRow(live.d,'sending','等待设备确认…');setSummary(`下发中 · 设备 ACK ${acknowledged-readbackConfirmed} · 回读确认 ${readbackConfirmed} · 原频一致 ${skipped} · ${label(live.d)}`);sent++;attempted=true;
          currentTarget=`${label(live.d)} · ${mhz(live.a.frequencyKHz)} MHz`;updateProgress('running',`等待 ${product(live.d)} 确认正确频率…`);
          waitingSince=elapsed();
          const record=await global.sendTrackedDeviceCommand(live.command,10000,{record:step,
            mark:stage=>{step[stage]=elapsed();}});
          waitingSince=null;
          if(!['acknowledged','readback_confirmed'].includes(record?.status))throw new Error('接收机尚未确认命令，不能判定下发成功');
          const now=current(live.saved);
          if(!now || !global._deviceConnectionIsOnline(now) || (live.saved._source && now._source!==live.saved._source))throw new Error('已收到确认，但原设备离线或会话已更换；请核对真实状态');
          if(brand(now.brand)!==live.a.brandKey || brand(record.expected_brand)!==live.a.brandKey || brand(record.brand)!==live.a.brandKey)throw new Error('确认品牌与原规划/当前接收机不一致，禁止写入通道卡');
          const actual=global.DatyFrequency.toFrequencyKHz(record.actual_value,'MHz');
          if(actual!==live.a.frequencyKHz || String(record.device_id)!==String(live.command.device_id) || record.command!=='set_freq')throw new Error('确认的目标/频率/命令不匹配');
          // 只在验证状态确认 后更新对应的当前频率，未 ACK 时绝不乐观改值。
          now.freq=actual;p.actual.set(String(live.saved.id),actual);acknowledged++;
          step.state=record.status;step.execution_evidence=copy(record.execution_evidence||null);if(record.status==='readback_confirmed')readbackConfirmed++;step.verified_ms=elapsed();
          setRow(now,record.status,`${record.status==='readback_confirmed'?'回读确认':'已确认'} ${mhz(actual)}`);
          updateProgress('running',`已收到接收机状态确认 · ${currentTarget}`);
          // Telemetry continues refreshing the visible panel. Do not rebuild
          // every hidden panel between this ACK and the next device command.
        }catch(error){
          waitingSince=null;
          step.state=error.notSent===true?'not-sent':'failed';step.error=error.message;
          if(error.notSent===true){
            if(attempted)sent--;
            requestStopped=error.message;
            setRow(item.d,'not-sent','未发送 · '+error.message);
            setSummary('下发已停止 · 服务器未接受请求 · '+error.message);
          }else{failed++;setRow(item.d,'failed','失败 · '+error.message);setSummary('下发停止 · '+error.message);}
          updateProgress('running',error.message);break;
        }
      }
    }finally{
      try{cancelRefresh();}catch(error){global.console?.error?.('下发视图取消失败',error);}
      try{if(watchdog!==null)runtime('clearInterval',watchdog);}catch(error){global.console?.error?.('下发等待显示取消失败',error);}
      for(const item of list)if(rowStates.get(key(item.d))?.state==='queued')rowStates.set(key(item.d),{state:'not-sent',text:'未发送 · 队列已停止'});
      busy=false;const remaining=list.length-acknowledged-skipped-failed;
      Object.assign(diagnostic,{readbackConfirmed,acknowledged,skipped,failed,sent,remaining,elapsed_ms:elapsed()});
      const details=[requestStopped && '服务器未接受请求 · '+requestStopped,...list.map(item=>rowStates.get(key(item.d))).filter(s=>s?.state==='failed').map(s=>s.text)].filter(Boolean).join('；');
      setSummary(`设备 ACK ${acknowledged-readbackConfirmed} · 回读确认 ${readbackConfirmed} · 原频一致 ${skipped} · 失败 ${failed} · 未发送 ${remaining}${details?'；'+details:''}`);
      refreshTable();
      const phase=failed?'failed':remaining?'stopped':acknowledged?'success':'unchanged';
      diagnostic.state=phase;
      const title=phase==='success'?'下发成功':phase==='unchanged'?'无需下发':phase==='stopped'?'下发已停止':'下发未全部完成';
      const message=phase==='success'?`接收机已正确确认 ${acknowledged} 个通道的品牌、目标与频率。${skipped?`另有 ${skipped} 个原频一致，未重复发送。`:''}`
        :phase==='unchanged'?`全部 ${skipped} 个通道原频一致，没有发送指令，也没有产生新的设备确认。`
        :`${summary}。已执行频率不会自动回退；未确认通道不能视为成功。`;
      updateProgress(phase,message);updateActiveProgress=null;
      try{global.forceRefreshAllPanels?.({realtime:true});}catch(error){global.console?.error?.('下发结束页面刷新异常',error);}
      global.notify?.(failed||remaining?'⚠️':acknowledged?'✅':'ℹ️',title,message);
      // Audit I/O must never delay the next receiver command or invent an ACK.
      void saveDiagnostic(diagnostic,endpoint);
    }
    return {ok:failed===0 && acknowledged+skipped===list.length,readbackConfirmed,acknowledged,skipped,failed,sent};
  }
  global.DatyPlanningDeployment=Object.freeze({setPlan,invalidate,preflight:id=>preflight(id),refreshControls,isBusy:()=>busy || confirming,
    getDiagnostics:()=>copy(diagnostics),
    getRowState:d=>rowStates.get(key(d)) || null,pushOne:id=>deploy(id),pushAll:()=>deploy(),
    stop(){if(busy && !stopRequested){stopRequested=true;setSummary('停止后续已请求 · 当前命令仍等待状态确认，不自动回退已执行频率');updateActiveProgress?.('running',summary);}}});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',refreshControls,{once:true});else refreshControls();
})(window);
