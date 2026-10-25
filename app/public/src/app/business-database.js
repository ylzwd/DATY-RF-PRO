/* Candidate original-page adapter. Explicit mount after DatyDatabaseConnection; no automatic
 * origin migration, startup writes, device commands, authentication bypass or UI
 * redesign. The original synchronous cache is never replaced with a Promise. */
(function(root,build){const factory=build();if(typeof module==='object'&&module.exports)module.exports=factory;else root.DatyBusinessDatabaseFactory=factory;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function mount(global,options={}){
    if(global.DatyBusinessDatabase)return global.DatyBusinessDatabase;
    global.DatySystemSettingsFactory?.mount(global);
    const storage=global.DatyPlatform?.storage;
    if(!storage||!global.DatyDatabaseConnection)throw Error('数据库页面适配需要现有平台存储及 DatyDatabaseConnection');
    const element=id=>global.document.getElementById(id),copy=value=>JSON.parse(JSON.stringify(value));
    const readScope=()=>{const state=global.DatyDatabaseConnection.snapshot();if(!state.source?.id)throw Error('服务器数据库尚未连接');return {baseUrl:state.origin,accessRevision:state.revision,principalId:state.source.id};};
    const context=()=>({projectId:global.getCurrentPlanningProject?.().id||'default',preferenceId:options.preferenceId||'view:'+readScope().principalId});
    const runtime=(method,...args)=>{
      if(global.DatyHostFactory)return global.DatyHostFactory.invokeRuntime(global,method,...args);
      if(global.DatyPlatform.kind!=='browser')throw Error('原生数据库计时接口未提供');return global[method](...args);
    };
    const ports={request:(url,init)=>global.DatyDatabaseConnection.request(url,init),readScope,storage,
      schedule:(fn,ms)=>runtime('setTimeout',fn,ms),cancel:id=>runtime('clearTimeout',id),
      ...(options.newOperationId?{newOperationId:options.newOperationId}:{})};
    const client=options.client||global.DatyDatabaseClientFactory.create(ports);
    const batchClient=options.batchClient||global.DatyDatabaseBatchFactory.create({...ports,resourceClient:client,factory:global.DatyDatabaseClientFactory,journalId:'profiles'});
    const scanBatchClient=options.scanBatchClient||global.DatyDatabaseBatchFactory.create({...ports,resourceClient:client,factory:global.DatyDatabaseClientFactory,journalId:'scan'});
    const validateProfile=profile=>{
      const errors=global.DatyEquipmentProfiles.validateEquipmentProfile(profile).slice();
      if(profile?.source==='planning-snapshot'||String(profile?.id||'').startsWith('run-profile:'))errors.push('规划使用的 Profile 快照不能作为可编辑自定义 Profile 导入');
      if(global.DatyEquipmentProfiles.BUILT_IN_EQUIPMENT_PROFILES.some(item=>item.id===profile?.id))errors.push('自定义 Profile 不得覆盖内置 ID');return errors;
    };
    const repository=options.repository||global.DatyBusinessRepositoryFactory.create({client,batchClient,scanBatchClient,readContext:context,
      validateProfile,parseScanCsv:text=>global.DatyScanCsv.parseScanCsv(text),
      newScanId:options.newScanId||(()=>global.crypto.randomUUID()),
      validateSimulation:value=>global.DatyRfSimulation.build([],{startMHz:400,endMHz:900},value)});
    const dirty=new Map(),clean=new Map(),preferenceStates=new Map(),takeovers=new Map(),adopted=new Map();let disposed=false,hydrating=0,scopeKey=null,hydration=null,hydrationEpoch=0;
    let soundRefresh=null,soundTimer=null;
    let appliedScan=null;const appliedProfiles=new Map();
    const revision=name=>dirty.get(name)||0;
    const changed=name=>dirty.set(name,revision(name)+1);
    const unsaved=name=>revision(name)!==(clean.get(name)||0);
    const notify=(icon,title,message)=>global.notify?.(icon,title,message);
    function describe(result){
      if(result.status==='unknown')return '数据库写入结果尚未确认，已保留待核对记录；请只读核对回执，不要反复保存';
      if(result.status==='conflict')return '数据库已有更新，未覆盖其他页面的数据；请重新读取后核对';
      if(result.status==='unloaded')return '尚未读取服务器数据库，请等待连接就绪或重新读取';
      if(result.status==='busy')return '上一笔数据库提交仍在处理中，本次没有排队重发';
      return result.message||'服务器数据库未确认保存（'+(result.code||result.status)+'）';
    }
    function stored(result,label){
      if(result.status!=='saved'){notify('⚠️',label+(result.status==='unknown'?'保存待核对':'未保存到数据库'),describe(result));return false;}return true;
    }
    function apply(fn){hydrating++;try{return fn();}finally{hydrating--;}}
    function sameScope(captured){try{return captured===JSON.stringify([readScope(),context()]);}catch(_){return false;}}
    function capture(){return JSON.stringify([readScope(),context()]);}
    function captureOrNotify(){try{return capture();}catch(error){notify('⚠️','数据库尚未就绪',error.message);return null;}}
    const same=(a,b)=>a===b||!!a&&!!b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)
      &&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.prototype.hasOwnProperty.call(b,key)&&same(a[key],b[key]));
    function legacyValue(feature){
      const keys={thresholds:'daty_alert_thresholds_v1',alert_sound:'daty_alert_sound_v1',auto_frequency:'daty_auto_frequency_v1',profiles:'daty_equipment_profiles_v2'};
      if(feature==='scan'){const points=global.getCurrentScanPoints?.()||[];return points.length?{points}:null;}
      if(feature==='range'){
        const start=storage.getItem('specStartFreq'),end=storage.getItem('specEndFreq');return start!==null||end!==null?{specStartFreq:start,specEndFreq:end}:null;
      }
      if(feature==='simulation'||feature==='paging')return null;
      if(feature==='manual'){
        const values=(global.DATY_STATE?.devices||global.DEVICES||[]).filter(isManualDevice).map(manualValue);
        return values.length?values:null;
      }
      const raw=storage.getItem(keys[feature])||(feature==='profiles'?storage.getItem('daty_equipment_profiles_v1'):null);
      if(raw===null)return null;
      try{const value=JSON.parse(raw);return feature==='profiles'&&Array.isArray(value)&&!value.length?null:value;}catch(_){return {unreadableLegacyData:true};}
    }
    function inspectTakeover(feature,value,epoch,local=legacyValue(feature)){
      if(global.DatyServerStorage?.legacyArchived){adopted.set(feature,epoch);takeovers.delete(feature);return true;}
      if(adopted.get(feature)===epoch)return true;
      const comparable=feature==='scan'?(value?{points:value.points}:null):feature==='range'?(value?{specStartFreq:value.specStartFreq??null,specEndFreq:value.specEndFreq??null}:null):value;
      const normalized=item=>['manual','profiles'].includes(feature)&&Array.isArray(item)?item.slice().sort((a,b)=>String(a?.id).localeCompare(String(b?.id))):item;
      if(local===null||same(normalized(local),normalized(comparable))){adopted.set(feature,epoch);takeovers.delete(feature);return true;}
      takeovers.set(feature,{status:'migration-conflict',epoch});
      notify('⚠️','本地数据与数据库不同','保留现有 '+feature+' 数据；本页尚未采用数据库版本。请先导出旧数据，保存前需明确确认。');return false;
    }
    async function ensureTakeover(feature){
      const pending=takeovers.get(feature);if(!pending)return true;
      const captured=captureOrNotify();if(!captured)return false;
      if(!global.DatyDialogs?.confirm){notify('⚠️','数据库接管待确认','本地数据与数据库不同，当前宿主未提供确认接口；未发送请求');return false;}
      const accepted=await global.DatyDialogs.confirm({title:'数据库数据接管确认',
        message:'本地缓存与服务器数据库不同。请先导出需要保留的旧数据；确认后，本次操作将使用服务器版本作为基线，提交当前选择并更新页面缓存。',
        rows:[],warnings:['不会自动合并未导出的旧数据，也不会发送静音或调频指令。','取消后保留本页数据，不发送数据库写入。'],confirmLabel:'确认本次保存',cancelLabel:'取消'});
      if(accepted!==true||!sameScope(captured)||takeovers.get(feature)!==pending)return false;
      adopted.set(feature,pending.epoch);takeovers.delete(feature);return true;
    }
    let reviewing=false;
    async function reviewBeforeSave(...args){
      if(reviewing){notify('⚠️','数据库正在核对','本次没有发送或排队保存');return true;}
      reviewing=true;
      try{return await performReviewBeforeSave(...args);}
      catch(error){notify('⚠️','数据库核对失败',error.message||String(error));return true;}
      finally{reviewing=false;}
    }
    async function performReviewBeforeSave(kind,id,label,{batch=false}={}){
      const state=batch?(batch==='scan'?scanBatchClient:batchClient).snapshot():client.snapshot(kind,id),cached=batch?undefined:repository.cached(kind,id);
      if(state.pending){notify('⚠️',label+'仍在处理中','本次没有排队重发；请等待当前读取或提交完成');return true;}
      const conflict=['conflict','rejected','error'].includes(state.status)||state.status==='unloaded'&&state.epoch!==null||!batch&&state.loaded&&cached!==undefined&&(cached?.revision||0)<(state.resource?.revision||0);
      if(state.status!=='unknown'&&!conflict)return false;
      const captured=captureOrNotify();if(!captured)return true;
      if(!global.DatyDialogs?.confirm){notify('⚠️','数据库核对未开始','当前宿主没有确认接口，未发送请求');return true;}
      const accepted=await global.DatyDialogs.confirm({title:state.status==='unknown'?'核对上次数据库提交':'重新读取数据库版本',
        message:label+' 上次提交结果未确认或数据库版本已变化。本次仅查询操作回执和最新数据库版本，不重新发送保存。',
        rows:[],warnings:['保留当前尚未提交的编辑；核对完成后，请确认内容并再次主动保存。','不会发送静音、调频指令，也不会把历史回执当作最新版本。'],confirmLabel:'只读核对',cancelLabel:'取消'});
      if(accepted!==true||!sameScope(captured))return true;
      let result;
      if(state.status==='unknown'){
        result=batch?(batch==='scan'?await repository.reconcileScan():await repository.reconcileBatch()):await repository.reconcile(kind,id);
        if(!sameScope(captured))return true;
        if(result.status!=='reconciled'){notify('⚠️',label+'仍待核对',describe(result));return true;}
      }
      // Reload the authoritative current revision, never adopt a historical
      // receipt as a write baseline or replay the original POST.
      let targets=batch?(result?.resources||[]).map(resource=>[resource.kind,resource.id]):[[kind,id]];
      if(batch&&!targets.length){
        if(batch==='scan')targets=[['scan_current',context().projectId]];
        else{
          const listed=await repository.listAll('profiles');if(!sameScope(captured))return true;
          if(listed.status!=='ready'){notify('⚠️','Profile仍待核对',describe(listed));return true;}
          targets=listed.resources.filter(resource=>resource.value?.source!=='planning-snapshot').map(resource=>[resource.kind,resource.id]);
        }
      }
      let ready=true;
      for(const [nextKind,nextId]of targets){const loaded=await repository.load(nextKind,nextId);if(!sameScope(captured))return true;if(loaded.status!=='ready'){ready=false;break;}}
      notify(ready?'✓':'⚠️',ready?'数据库核对完成':'提交已确认，最新版本未读取',ready?'本次仅完成只读核对，没有发送保存；保留当前草稿，请核对内容后再次主动保存。':'本次没有重新保存；请先恢复数据库读取再提交。');return true;
    }
    function identity(device){
      const receiverId=device?.receiver_id||device?.receiverId;
      const channelNumber=global.getDeviceChannelNumberSafe?.(device,null)??device?.channel_number??device?.channel;
      if(typeof receiverId!=='string'||!receiverId||!Number.isInteger(channelNumber)||channelNumber<1)return null;
      return {receiverId,channelNumber};
    }
    function deviceDisplayName(device){
      const target=identity(device);if(!target)return device?.name||'';
      const match=repository.values('device_overrides').find(item=>item.receiverId===target.receiverId&&item.channelNumber===target.channelNumber);
      return match?.alias||device.name||'';
    }
    async function saveDeviceAlias(id,alias){
      const device=(global.DATY_STATE?.devices||global.DEVICES||[]).find(item=>item.id===id);
      if(isManualDevice(device))return saveManualValue({...manualValue(device),name:String(alias).trim()},device);
      const target=identity(device);
      if(!target){notify('⚠️','名称未保存','缺少明确接收机身份与 CH；手工设备登记域尚未接入');return false;}
      if(await reviewBeforeSave('device_overrides',repository.aliasTarget(target.receiverId,target.channelNumber).id,'名称'))return false;
      changed('aliases');const ticket=revision('aliases'),captured=captureOrNotify();if(!captured)return false;const result=await repository.saveAlias(target.receiverId,target.channelNumber,String(alias).trim());
      if(!sameScope(captured))return false;
      if(!stored(result,'名称'))return false;
      clean.set('aliases',ticket);
      // Only a display override. Never change reported name, IP, GROUP, CH,
      // frequency, mute, online state, capabilities or ACK identity.
      global.renderDevTable?.();notify('✏️','名称已修改','名称已保存到服务器数据库');return true;
    }
    function isManualDevice(device){return !!device&&!device._fasheId&&!device._serverManaged&&!device.receiver_id&&!device.receiverId&&(!device._source||device._source==='manual');}
    function manualValue(device){
      return {...copy(device._databaseManualValue||{}),id:repository.manualId(device.id),source:'manual',brand:device.brand,model:device.model||'未填写型号',name:device.name,
        configuredFrequencyKHz:device.freq,configuredChannelNumber:global.getDeviceChannelNumberSafe(device,null),configuredIp:device.ip||''};
    }
    function manualDevice(value){
      let tuple;try{tuple=JSON.parse(value.id);}catch(_){throw Error('手工设备显示 ID 格式未知，保留数据库记录但不猜测通道身份');}
      if(!Array.isArray(tuple)||tuple.length!==2||tuple[0]!==typeof tuple[1]||repository.manualId(tuple[1])!==value.id)throw Error('手工设备显示 ID 格式不匹配');
      return {id:tuple[1],_databaseManualId:value.id,_databaseManualValue:copy(value),_source:'manual',name:value.name,brand:value.brand,model:value.model,
        ch:'CH'+value.configuredChannelNumber,channel:value.configuredChannelNumber,channel_number:value.configuredChannelNumber,channel_key:'CH'+value.configuredChannelNumber,
        ip:value.configuredIp||'',freq:value.configuredFrequencyKHz,planned:value.configuredFrequencyKHz,
        rf:null,af:null,afDbfs:null,af_dbfs:null,afUnit:'dBFS',batt:null,muted:null,status:'offline',online:false,_online:false,_thresholdStatusManaged:false};
    }
    function applyManual(value,existing){
      const devices=global.DATY_STATE?.devices||global.DEVICES,next=manualDevice(value),index=devices.findIndex(item=>item.id===next.id);
      if(index>=0&&(!isManualDevice(devices[index])||(existing&&devices[index]!==existing)))throw Error('显示 ID 已被其他设备占用，数据库登记已保存但没有替换当前设备');
      if(index>=0)devices[index]=next;else devices.push(next);
      global.saveDataToStorage?.();global.forceRefreshAllPanels?.();global.renderDevTable?.();
    }
    async function saveManualValue(value,existing,isCurrent=()=>true){
      if(await reviewBeforeSave('manual_devices',value.id,'手工设备'))return false;
      changed('manual');const ticket=revision('manual'),captured=captureOrNotify();if(!captured||!await ensureTakeover('manual'))return false;
      const result=await repository.saveManual(value);if(!sameScope(captured)||!stored(result,'手工设备'))return false;
      clean.set('manual',ticket);
      if(!isCurrent()){notify('💾','手工设备已保存','数据库已提交，保留当前的新编辑；请重新读取列表');return false;}
      try{applyManual(result.resource.value,existing);}catch(error){notify('⚠️','登记已保存，页面更新失败',error.message);return false;}
      notify('✓','设备已保存','手工登记已保存到服务器数据库；未连接接收机，遥测保持未知');return true;
    }
    async function saveManualForm(id,isEdit){
      const modal=element('addDeviceModal');if(!modal)return false;
      const fields=['name','brand','model','ch','ip','freq'],read=()=>Object.fromEntries(fields.map(name=>[name,isEdit&&name==='name'?String((global.DATY_STATE?.devices||global.DEVICES).find(item=>item.id===id)?.name||''):element('addDev_'+name)?.value.trim()||'']));
      const form=read(),devices=global.DATY_STATE?.devices||global.DEVICES,existing=isEdit?devices.find(item=>item.id===id):null;
      if(isEdit&&(!existing||!isManualDevice(existing))){notify('⚠️','实时设备信息只读','此表单仅保存手工登记；接收机身份、CH 与调频仍使用原控制入口，显示名称请在设备表中编辑');return false;}
      try{
        if(!form.name)throw Error('请填写设备名称');
        const channel=global.getDeviceChannelNumber({channel:form.ch});if(!Number.isSafeInteger(channel)||channel<1||channel>10000)throw Error('请输入 1、CH1 或 CH-1 这类明确通道号');
        const freq=global.DatyFrequency.toFrequencyKHz(form.freq,'MHz');if(freq<470000||freq>960000)throw Error('请输入 470~960 MHz 范围内的频率');
        if(devices.some(item=>item!==existing&&(item.id===id||(global.getDeviceChannelNumber(item)===channel&&String(item.receiver_ip||item.receiverId||item.receiver_id||item.ip||'').trim()===form.ip))))throw Error('显示 ID 或同一 IP 的 CH 已被占用');
        const value={...(existing?copy(existing._databaseManualValue||{}):{}),id:repository.manualId(id),source:'manual',brand:form.brand,model:form.model||'未填写型号',name:form.name,configuredChannelNumber:channel,configuredIp:form.ip,configuredFrequencyKHz:freq};
        const current=()=>modal.isConnected&&same(form,read());
        const saved=await saveManualValue(value,existing,current);if(saved&&current())modal.remove();return saved;
      }catch(error){notify('⚠️','手工设备未保存',error.message);return false;}
    }
    async function deleteManualDevice(id){
      const devices=global.DATY_STATE?.devices||global.DEVICES,device=devices.find(item=>item.id===id);if(!isManualDevice(device)){notify('⚠️','未删除','仅支持删除手工登记，不改变真实接收机');return false;}
      if(await reviewBeforeSave('manual_devices',repository.manualId(id),'删除手工设备'))return false;
      const captured=captureOrNotify();if(!captured||!await ensureTakeover('manual'))return false;
      const accepted=await global.DatyDialogs.confirm({title:'删除手工登记',message:'删除 '+device.name+' 的手工登记？保留数据库版本历史，不发送设备指令。',rows:[],warnings:[],confirmLabel:'确认删除',cancelLabel:'取消'});
      if(accepted!==true||!sameScope(captured)||!devices.includes(device))return false;
      changed('manual');const ticket=revision('manual'),result=await repository.saveManual({id:repository.manualId(id)},{deleted:true});
      if(!sameScope(captured)||!stored(result,'删除手工设备'))return false;
      const index=devices.indexOf(device);if(index>=0)devices.splice(index,1);clean.set('manual',ticket);
      global.saveDataToStorage?.();global.forceRefreshAllPanels?.();global.renderDevTable?.();notify('✓','手工登记已删除','数据库已确认删除；历史版本保留');return true;
    }
    async function saveSimulation(options,isCurrent=()=>true){
      if(global.DatyDataRetention?.history===false)return isCurrent();
      if(!captureOrNotify())return false;
      if(await reviewBeforeSave('simulation_settings',context().projectId,'仿真设置'))return false;
      changed('simulation');const ticket=revision('simulation'),captured=captureOrNotify();if(!captured)return false;
      const result=await repository.saveSimulation(options);if(!sameScope(captured)||!stored(result,'仿真设置'))return false;
      clean.set('simulation',ticket);return isCurrent();
    }
    async function savePage(name,page){
      if(hydrating)return true;
      if(!captureOrNotify())return false;
      // Paging remains a non-blocking navigation action even when the database
      // is unavailable. Unknown preferences are reported, never opened as a
      // modal over receiver controls and never automatically replayed.
      if(hydrating)return true;changed('paging');const ticket=revision('paging'),captured=captureOrNotify();if(!captured)return false;
      const result=await repository.savePage(name,page);if(!sameScope(captured))return false;
      if(result.status==='saved')clean.set('paging',ticket);return stored(result,'显示页码');
    }
    async function saveThresholdSettings(){return global.DatySystemSettings?.saveThresholds()??false;}
    function preferenceMessage(id,fallback){
      const state=global.DatySystemSettings?.snapshot(id);if(!state)return '数据库设置尚未就绪';
      return state.dirty?(state.status==='saving'?'正在保存到服务器数据库…':'设置未保存 / 待核对，请重试'):fallback;
    }
    async function setBooleanPreference(id,value,applyValue,unlock){
      if(!global.DatySystemSettings||!['alert_sound','auto_frequency'].includes(id)||typeof value!=='boolean')return false;
      if(id==='alert_sound'&&!value)global.DatyAlertSound?.setEnabled(false);
      if(value&&unlock)void unlock();
      return global.DatySystemSettings.submit(id,{enabled:value});
    }
    function adoptSoundPreference(result){
      if(result.status!=='ready')return false;
      const resource=result.resource;
      if(resource&&!resource.deleted){
        if(typeof resource.value?.enabled!=='boolean')return false;
        adopted.set('alert_sound',result.epoch);takeovers.delete('alert_sound');
        const state=global.DatyAlertSound?.getState();
        if(state&&(!state.preferenceReady||state.enabled!==resource.value.enabled))global.DatyAlertSound.setEnabled(resource.value.enabled);
      }else{
        // No saved preference: keep the existing default/cache without creating
        // a server write. A stored boolean always wins over stale page caches.
        const state=global.DatyAlertSound?.getState();
        if(state&&!state.preferenceReady)global.DatyAlertSound.setEnabled(state.enabled);
      }
      return true;
    }
    async function refreshSoundPreference(){return global.DatySystemSettings?.refresh()??false;}
    function scheduleSoundRefresh(){
      if(disposed||soundTimer!==null)return;
      // A single read-only key over the existing MQTT adapter, including pages
      // in other browsers. Never rehydrate drafts or replay uncertain writes.
      soundTimer=runtime('setTimeout',async()=>{soundTimer=null;await refreshSoundPreference();scheduleSoundRefresh();},1000);
    }
    const refreshSoundOnFocus=()=>{void refreshSoundPreference();};
    async function saveSpectrumRange(start,end){
      if(hydrating)return true;
      if(!captureOrNotify())return false;
      if(await reviewBeforeSave('preferences',context().preferenceId,'频率显示范围'))return false;
      if(hydrating)return true;changed('range');const ticket=revision('range'),captured=captureOrNotify();if(!captured)return false;if(!await ensureTakeover('range'))return false;const result=await repository.saveSpectrumRange(start,end);
      if(!sameScope(captured))return false;if(result.status==='saved')clean.set('range',ticket);return stored(result,'频率显示范围');
    }
    async function saveImportedScan(file){
      if(global.DatyDataRetention?.history===false){
        if(typeof file.isCurrent==='function'&&!file.isCurrent())return false;
        if(global.DatyPlanningDeployment?.isBusy())return false;
        const parsed=global.DatyScanCsv.parseScanCsv(file.text);global.setImportedScanPoints(parsed.points,file.name);return true;
      }
      const initial=captureOrNotify();if(!initial)return false;
      const current=()=>sameScope(initial)&&(typeof file.isCurrent!=='function'||file.isCurrent())&&!global.DatyPlanningDeployment?.isBusy();
      if(!current())return false;
      if(await reviewBeforeSave(null,null,'真实扫描',{batch:'scan'}))return false;
      if(!current()||await reviewBeforeSave('scan_current',context().projectId,'当前扫描')||!current())return false;
      changed('scan');const ticket=revision('scan'),captured=captureOrNotify();if(!captured)return false;if(!await ensureTakeover('scan')||!current())return false;const result=await repository.saveScan({...file,isCurrent:current});
      if(!sameScope(captured))return false;if(!stored(result,'真实扫描'))return false;
      if(!current())return false;
      try{apply(()=>global.setImportedScanPoints(result.resource.value.points,file.name));}
      catch(error){notify('⚠️','扫描已保存，页面更新失败','数据库原文与扫描点已保存；'+error.message);return false;}
      appliedScan={captured,epoch:result.epoch,resource:copy(result.resource)};
      clean.set('scan',ticket);
      return true;
    }
    async function clearCurrentScan(){
      if(global.DatyDataRetention?.history===false){global.clearImportedScan();return true;}
      if(!captureOrNotify())return false;
      if(await reviewBeforeSave(null,null,'真实扫描',{batch:'scan'}))return false;
      if(await reviewBeforeSave('scan_current',context().projectId,'清除当前扫描'))return false;
      changed('scan');const ticket=revision('scan'),captured=captureOrNotify();if(!captured||!await ensureTakeover('scan'))return false;
      const result=await repository.clearCurrentScan();if(!sameScope(captured)||!stored(result,'清除当前扫描'))return false;
      if(ticket!==revision('scan')){notify('✓','当前扫描已清除','数据库已确认；保留当前尚未提交的新选择');return false;}
      apply(()=>global.clearImportedScan());appliedScan=null;clean.set('scan',ticket);return true;
    }
    async function saveImportedProfiles(imported){
      if(await reviewBeforeSave(null,null,'Profile',{batch:true}))return false;
      if(Array.isArray(imported))for(const profile of imported)if(await reviewBeforeSave('profiles',profile?.id,'Profile'))return false;
      changed('profiles');const ticket=revision('profiles'),captured=captureOrNotify();if(!captured)return false;if(!await ensureTakeover('profiles'))return false;const result=await repository.saveProfiles(imported);
      if(!sameScope(captured))return false;if(!stored(result,'Profile'))return false;
      try{storage.setItem('daty_equipment_profiles_v2',JSON.stringify(repository.values('profiles')));}
      catch(error){notify('⚠️','Profile 已保存，缓存更新失败','服务器数据库已提交；'+error.message);return false;}
      for(const resource of result.resources)appliedProfiles.set(resource.id,{captured,epoch:result.epoch,resource:copy(resource)});
      clean.set('profiles',ticket);
      return true;
    }
    function inputChanged(event){
      if(['rfThreshInput','battThreshInput','battBarsThreshInput','afThreshInput'].includes(event.target?.id))changed('thresholds');
      if(['specStart','specEnd'].includes(event.target?.id))changed('range');
      if(event.target?.id?.startsWith('sim'))changed('simulation');
      if(event.target?.id?.startsWith('addDev_'))changed('manual');
      if(event.target?.classList?.contains('edit-name-input')){
        const key=event.target.closest('tr[data-device-key]')?.dataset.deviceKey;
        const device=(global.DATY_STATE?.devices||global.DEVICES||[]).find(item=>global.getChannelCardKey?.(item)===key);
        changed(isManualDevice(device)?'manual':'aliases');
      }
    }
    async function hydrate(){
      if(disposed)return {status:'disposed'};
      let captured;try{captured=capture();}catch(error){return {status:'unauthorized',message:error.message};}
      if(hydration&&scopeKey===captured)return hydration;
      if(scopeKey!==captured){repository.invalidate();scopeKey=captured;hydrationEpoch++;preferenceStates.clear();takeovers.clear();adopted.clear();appliedScan=null;appliedProfiles.clear();}
      const epoch=hydrationEpoch;
      const jobs=[
        ['range',()=>unsaved('paging')?{status:'dirty-preserved'}:repository.load('preferences',context().preferenceId),resource=>{
          const value=resource.value;if(value.specStartFreq!==undefined&&value.specEndFreq!==undefined){element('specStart').value=value.specStartFreq;element('specEnd').value=value.specEndFreq;global.updateRangeDisplay(false);}
          global.DatyApplyDevicePagePreferences?.(value);global.DatyApplyHistoryPagePreference?.(value);global.DatyApplyAlertPagePreference?.(value);global.DatyApplyTimelinePagePreference?.(value);
        }],
        ['simulation',()=>repository.load('simulation_settings',context().projectId),resource=>{
          if(resource.value.projectId!==context().projectId||resource.value.sourceKind!=='simulation')throw Error('仿真参数项目或来源不匹配');
          global.DatyRfSimulationView.adoptDatabaseOptions(resource.value.options);
        }],
        ['scan',()=>repository.loadCurrentScan(),resource=>{
          const value=resource.value;if(value.sourceKind!=='imported_csv'||value.frequencyUnit!=='kHz'||value.levelUnit!=='dBm'||value.projectId!==context().projectId)return;
          if(!value.original?.text)throw Error('数据库扫描缺少可核验原文件');
          const parsed=global.DatyScanCsv.parseScanCsv(value.original.text);
          if(JSON.stringify(parsed.points)!==JSON.stringify(value.points))throw Error('数据库扫描点与原文件不一致');
          global.setImportedScanPoints(value.points,value.name);
          appliedScan={captured,epoch:client.snapshot('scans',resource.id).epoch,resource:copy(resource)};
        }],
      ];
      hydration=(async()=>{
        const loaded=await Promise.all(jobs.filter(job=>global.DatyDataRetention?.history!==false||!['scan','simulation'].includes(job[0])).map(async([name,read,update])=>{const ticket=revision(name),legacy=legacyValue(name);
          return {name,update,ticket,legacy,result:unsaved(name)?{status:'dirty-preserved'}:await read()};}));
        // The explicitly saved manual range wins over CSV's automatic bounds,
        // independent of HTTP response ordering.
        loaded.sort((a,b)=>a.name==='range'?1:b.name==='range'?-1:0);
        const results=loaded.map(({name,update,ticket,legacy,result})=>{
          if(disposed||epoch!==hydrationEpoch||!sameScope(captured)||ticket!==revision(name))return {feature:name,status:'skipped'};
          if(name==='alert_sound'&&adoptSoundPreference(result))return {feature:name,status:'hydrated'};
          if(result.status==='ready'&&!inspectTakeover(name,result.resource&&!result.resource.deleted?result.resource.value:null,result.epoch,legacy))return {feature:name,status:'migration-conflict'};
          if(result.status==='ready'&&result.resource&&!result.resource.deleted){
            try{apply(()=>update(copy(result.resource)));return {feature:name,status:'hydrated'};}catch(error){return {feature:name,status:'cache-error',message:error.message};}
          }
          if(name==='scan'&&result.status==='ready'&&result.cleared){apply(()=>global.clearImportedScan());appliedScan=null;return {feature:name,status:'hydrated-empty'};}
          return {feature:name,status:result.status==='ready'?'migration-required':result.status,code:result.code};
        });
        for(const [kind,name]of [['profiles','profiles'],['device_overrides','aliases'],['manual_devices','manual']]){
          if(unsaved(name)){results.push({feature:name,status:'dirty-preserved'});continue;}
          const ticket=revision(name),result=await repository.listAll(kind);
          if(disposed||epoch!==hydrationEpoch||!sameScope(captured)||ticket!==revision(name))continue;
          if(result.status==='ready'&&kind==='profiles'){
            const profileResources=result.resources.filter(item=>!item.deleted&&item.value?.source!=='planning-snapshot'),profiles=profileResources.map(item=>item.value);
            const invalid=profiles.flatMap(validateProfile);
            if(invalid.length){results.push({feature:name,status:'invalid',message:invalid.join('；')});continue;}
            if(!inspectTakeover('profiles',profiles,result.epoch)){results.push({feature:name,status:'migration-conflict'});continue;}
            // Missing DB data is not permission to erase or silently migrate the
            // user's existing origin cache. Explicit migration is separate.
            if(profiles.length)try{storage.setItem('daty_equipment_profiles_v2',JSON.stringify(profiles));global.DatyAutoFrequency?.invalidate();}catch(error){results.push({feature:name,status:'cache-error',message:error.message});continue;}
            appliedProfiles.clear();for(const resource of profileResources)appliedProfiles.set(resource.id,{captured,epoch:result.epoch,resource:copy(resource)});
          }
          if(result.status==='ready'&&kind==='manual_devices'){
            const records=result.resources.filter(item=>!item.deleted).map(item=>item.value);
            if(!inspectTakeover('manual',records,result.epoch)){results.push({feature:name,status:'migration-conflict'});continue;}
            try{
              const next=records.map(manualDevice),devices=global.DATY_STATE?.devices||global.DEVICES;
              if(next.some(item=>devices.some(existing=>existing.id===item.id&&!isManualDevice(existing))))throw Error('手工登记显示 ID 与实时设备冲突，未覆盖任何设备');
              const tracked=new Set(result.resources.map(item=>item.id));
              for(let i=devices.length-1;i>=0;i--)if(isManualDevice(devices[i])&&tracked.has(repository.manualId(devices[i].id)))devices.splice(i,1);
              devices.push(...next);
            }catch(error){results.push({feature:name,status:'cache-error',message:error.message});continue;}
          }
          results.push({feature:name,status:result.status});
        }
        if(sameScope(captured)){global.forceRefreshAllPanels?.();global.renderDevTable?.();}
        return {status:'completed',results};
      })().finally(()=>{if(epoch===hydrationEpoch)hydration=null;});
      return hydration;
    }
    function appliedSources(){
      let scope,captured;try{scope={...readScope(),projectId:context().projectId};captured=capture();}catch(_){return {scope:null,epoch:null,scan:null,profiles:[]};}
      let installed=[];try{installed=JSON.parse(storage.getItem('daty_equipment_profiles_v2')||'[]');}catch(_){}
      const profiles=[...appliedProfiles.values()].filter(item=>item.captured===captured&&installed.some(value=>value.id===item.resource.id&&same(value,item.resource.value)));
      const scan=appliedScan?.captured===captured&&same(global.getCurrentScanPoints?.()||[],appliedScan.resource.value.points)?appliedScan:null;
      const epochs=new Set([scan?.epoch,...profiles.map(item=>item.epoch)].filter(Boolean));
      if(epochs.size>1)return {scope:{...scope},epoch:null,scan:null,profiles:[]};
      return {scope:{...scope},epoch:[...epochs][0]||null,scan:scan?copy(scan.resource):null,profiles:profiles.map(item=>copy(item.resource))};
    }
    const api=Object.freeze({repository,client,batchClient,scanBatchClient,hydrate,saveThresholdSettings,setBooleanPreference,preferenceMessage,refreshSoundPreference,appliedSources,
      saveSpectrumRange,saveImportedScan,clearCurrentScan,saveImportedProfiles,saveDeviceAlias,deviceDisplayName,
      saveManualForm,deleteManualDevice,isManualDevice,saveSimulation,savePage,
      takeoverState:()=>Object.fromEntries([...takeovers].map(([name,value])=>[name,{...value}])),
      get hydrating(){return hydrating>0;},
      dispose(){disposed=true;hydrationEpoch++;repository.invalidate();global.document.removeEventListener('input',inputChanged);unsubscribe?.();
        if(soundTimer!==null)runtime('clearTimeout',soundTimer);soundTimer=null;global.removeEventListener?.('focus',refreshSoundOnFocus);}
    });
    global.DatyBusinessDatabase=api;global.document.addEventListener('input',inputChanged);
    if(typeof global.deleteDev!=='function')global.deleteDev=deleteManualDevice;
    const unsubscribe=global.DatyDatabaseConnection.subscribe?.(()=>{void hydrate().catch(error=>notify('⚠️','数据库读取失败',error.message));});
    global.addEventListener?.('focus',refreshSoundOnFocus);scheduleSoundRefresh();
    if(options.autoHydrate!==false)void hydrate().catch(error=>notify('⚠️','数据库读取失败',error.message));
    return api;
  }
  return Object.freeze({mount});
});
