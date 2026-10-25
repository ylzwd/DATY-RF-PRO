/* Candidate domain repository. Explicit async database commits, synchronous UI
 * caches kept by the caller. No device commands, localStorage or DOM access. */
(function(root,build){const factory=build();if(typeof module==='object'&&module.exports)module.exports=factory;else root.DatyBusinessRepositoryFactory=factory;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const PROTOCOL='daty-business-db-v1', copy=value=>JSON.parse(JSON.stringify(value));
  const key=(kind,id)=>JSON.stringify([kind,id]);
  const failure=(code,message)=>({status:'error',code,message});
  const MAPPING=Object.freeze({
    dashboard:{settings:'settings/alert_thresholds',range:'preferences/<public-view-scope>',live:'unified_live server snapshots; never hydrate online from history',alerts:'alerts/<archiveId>; persisted transitions and server-confirmed archives'},
    channels:{alias:'device_overrides/<receiverId+CH>',live:'unified_live server snapshots',view:'preferences/<public-view-scope>; display pages only'},
    spectrum:{scan:'scan_current/<projectId> -> scans/<immutable-import-id>',original:'scan.original {name,text}',range:'preferences/<public-view-scope>',simulation:'simulation_settings/<projectId>; never real scan points'},
    planner:{profiles:'profiles/<id>',history:'planning_records/<id>; immutable history',current:'planning_current/<projectId>; atomic project selection',run:'planning_runs/<id>; saved input evidence and result'},
    devices:{alias:'device_overrides/<receiverId+CH>',manual:'manual_devices/<typed-display-id>; offline configured values, never live receiver identity',plugins:'plugins: development metadata only; install unsupported'},
    settings:{thresholds:'settings/alert_thresholds',sound:'settings/alert_sound',recommendation:'settings/auto_frequency',network:'host connection preferences excluded; never restore credentials or retarget receivers'}
  });
  function create(ports){
    if(!ports?.client||!['load','save','list','snapshot','invalidate'].every(name=>typeof ports.client[name]==='function')
      ||typeof ports.readContext!=='function')throw TypeError('Business repository requires an explicit database client and project/view context');
    const cache=new Map(),listedKinds=new Set();let generation=0,writing=false;
    const context=()=>{const c=ports.readContext();if(!c||typeof c.projectId!=='string'||!c.projectId||typeof c.preferenceId!=='string'||!c.preferenceId)throw Error('Missing project/view context');return {projectId:c.projectId,preferenceId:c.preferenceId};};
    const current=(ticket,selected)=>ticket===generation&&JSON.stringify(context())===JSON.stringify(selected);
    function remember(kind,id,result){if(result.status==='ready')cache.set(key(kind,id),result.resource===null?null:copy(result.resource));return result;}
    async function load(kind,id){const selected=context(),ticket=generation,result=await ports.client.load(kind,id);if(!current(ticket,selected))return failure('CONTEXT_CHANGED','项目或视图已变化');return remember(kind,id,result);}
    async function listAll(kind){
      const selected=context(),ticket=generation,resources=[],seen=new Set(),cursors=new Set();let cursor=null,epoch=null,asOf=null;
      for(let page=0;page<100;page++){
        const result=await ports.client.list(kind,{limit:200,cursor});
        if(!current(ticket,selected))return failure('CONTEXT_CHANGED','项目或视图已变化');
        if(result.status!=='ready')return result;
        if(epoch!==null&&(epoch!==result.epoch||asOf!==result.asOf))return failure('SNAPSHOT_CHANGED','数据库列表版本变化，未采用部分结果');
        epoch=result.epoch;asOf=result.asOf;
        for(const item of result.resources){if(seen.has(item.id))return failure('DUPLICATE_RESOURCE','数据库列表包含重复项目');seen.add(item.id);resources.push(copy(item));}
        cursor=result.cursor;
        if(cursor===null){
          for(const stored of [...cache.keys()])if(JSON.parse(stored)[0]===kind)cache.delete(stored);
          for(const item of resources)cache.set(key(kind,item.id),copy(item));listedKinds.add(kind);
          return {status:'ready',resources,epoch,asOf};
        }
        if(cursors.has(cursor))return failure('INVALID_CURSOR','数据库分页游标重复');cursors.add(cursor);
      }
      return failure('LIST_LIMIT','数据库列表超过本轮读取上限，未采用部分数据');
    }
    async function commit(kind,id,value,options){
      if(writing)return {status:'busy',code:'BUSINESS_WRITE_BUSY'};writing=true;
      const ticket=generation,selected=context();
      try{
        const result=await ports.client.save(kind,id,value,options);
        if(!current(ticket,selected))return {status:'invalidated',code:'CONTEXT_CHANGED',databaseOutcome:result.status};
        if(result.status==='saved')cache.set(key(kind,id),copy(result.resource));
        return result;
      }finally{writing=false;}
    }
    function thresholds(value){
      const ranges={rfWeakDbm:[-90,-30],batteryLowPercent:[5,50],afOverloadDbfs:[-40,0]};
      if(value?.batteryLowBars!==undefined)ranges.batteryLowBars=[0,5];
      const result={};for(const [name,[min,max]]of Object.entries(ranges)){
        const number=typeof value?.[name]==='string'&&value[name].trim()?Number(value[name]):value?.[name];
        if(!Number.isInteger(number)||number<min||number>max)throw Error(name+' 超出有效范围');result[name]=number;
      }return result;
    }
    async function saveThresholds(value){try{return await commit('settings','alert_thresholds',thresholds(value));}catch(error){return failure('INVALID_THRESHOLDS',error.message);}}
    async function saveBoolean(id,enabled){if(!['alert_sound','auto_frequency'].includes(id)||typeof enabled!=='boolean')return failure('INVALID_SETTING','设置必须为布尔值');return commit('settings',id,{enabled});}
    async function saveSpectrumRange(start,end){
      if(!/^\d+(?:\.\d{1,3})?$/.test(String(start))||!/^\d+(?:\.\d{1,3})?$/.test(String(end))||+start<30||+end>3000||+start>=+end)return failure('INVALID_RANGE','频率范围须为递增的 30～3000 MHz');
      const {preferenceId}=context(),old=cache.get(key('preferences',preferenceId));
      return commit('preferences',preferenceId,{...(old?.deleted?{}:old?.value||{}),specStartFreq:String(start),specEndFreq:String(end)});
    }
    async function savePage(name,page){
      if(!['channelPage','devicePage','historyPage','alertPage','timelinePage'].includes(name)||!Number.isSafeInteger(page)||page<1)return failure('INVALID_PAGE','分页必须为正整数');
      const {preferenceId}=context(),old=cache.get(key('preferences',preferenceId));
      return commit('preferences',preferenceId,{...(old?.deleted?{}:old?.value||{}),[name]:page});
    }
    async function saveSimulation(options){
      try{
        if(typeof ports.validateSimulation!=='function')throw Error('仿真校验器未接入');ports.validateSimulation(options);
        return await commit('simulation_settings',context().projectId,{projectId:context().projectId,sourceKind:'simulation',options:copy(options)});
      }catch(error){return failure('INVALID_SIMULATION',error.message);}
    }
    function manualId(id){
      if((typeof id!=='string'||!id.trim())&&(!Number.isSafeInteger(id)||id<1))throw Error('手工设备显示 ID 无效');
      return JSON.stringify([typeof id,id]);
    }
    async function saveManual(value,{deleted=false}={}){
      try{
        const id=value?.id;
        if(typeof id!=='string'||!id)throw Error('手工登记 ID 缺失');
        if(!deleted){
          if(value.source!=='manual'||typeof value.brand!=='string'||!value.brand.trim())throw Error('必须是手工登记来源');
          const allowed=['id','source','brand','model','name','configuredFrequencyKHz','configuredChannelNumber','configuredIp','notes','provenance'];
          if(Object.keys(value).some(key=>!allowed.includes(key)))throw Error('手工登记不得包含真实遥测或控制状态');
          if(!Number.isSafeInteger(value.configuredFrequencyKHz)||value.configuredFrequencyKHz<30000||value.configuredFrequencyKHz>3000000)throw Error('手工频率须为整数 kHz');
          if(!Number.isSafeInteger(value.configuredChannelNumber)||value.configuredChannelNumber<1||value.configuredChannelNumber>10000)throw Error('手工 CH 须为明确正整数');
        }
        const ready=await freshBaseline('manual_devices',id);if(ready.status!=='ready')return ready;
        return await commit('manual_devices',id,deleted?null:copy(value),{deleted});
      }catch(error){return failure('INVALID_MANUAL_DEVICE',error.message);}
    }
    function scanId(){const pointer=cache.get(key('scan_current',context().projectId));return pointer?.deleted?null:pointer?.value?.scanId||'current:'+context().projectId;}
    async function loadCurrentScan(){
      const {projectId}=context(),pointer=await load('scan_current',projectId);if(pointer.status!=='ready')return pointer;
      if(pointer.resource?.deleted)return {status:'ready',resource:null,epoch:pointer.epoch,cleared:true};
      if(pointer.resource&&!pointer.resource.deleted&&(pointer.resource.value.projectId!==projectId||typeof pointer.resource.value.scanId!=='string'))return failure('INVALID_SCAN_POINTER','扫描指针的项目或 ID 不匹配');
      // Read-only compatibility for existing candidate records. A subsequent
      // import creates a new immutable scan and pointer; it never rewrites this.
      const result=await load('scans',scanId());
      if(pointer.resource&&!pointer.resource.deleted&&result.status==='ready'&&(!result.resource||result.resource.deleted))return failure('INVALID_SCAN_SOURCE','当前扫描指针指向不存在或已删除的扫描，未采用不完整数据');
      if(result.status==='ready'&&result.resource&&!result.resource.deleted&&(result.resource.value.projectId!==projectId||result.resource.value.sourceKind==='simulation'))return failure('INVALID_SCAN_SOURCE','当前扫描不是本项目的真实扫描');
      return result;
    }
    async function clearCurrentScan(){
      const {projectId}=context(),ready=await freshBaseline('scan_current',projectId);if(ready.status!=='ready')return ready;
      return commit('scan_current',projectId,null,{deleted:true});
    }
    async function saveScan(file){
      if(writing)return {status:'busy',code:'BUSINESS_WRITE_BUSY'};
      if(!ports.scanBatchClient)return failure('BATCH_UNAVAILABLE','扫描与当前指针的原子保存接口未接入');
      const pending=ports.scanBatchClient.snapshot();if(pending.status==='unknown'||pending.pending)return pending;
      const ticket=generation,selected=context();writing=true;
      try{
        if(typeof ports.parseScanCsv!=='function'||typeof file?.name!=='string'||!file.name||typeof file.text!=='string')throw Error('缺少真实扫描原文件');
        const parsed=ports.parseScanCsv(file.text),points=parsed.points;
        if(!Array.isArray(points)||points.length<2)throw Error('缺少有效实测扫描点');
        const value={projectId:selected.projectId,name:file.name,sourceKind:'imported_csv',frequencyUnit:'kHz',levelUnit:'dBm',points:copy(points),original:{name:file.name,text:file.text}};
        const pointer=await freshBaseline('scan_current',selected.projectId);if(pointer.status!=='ready')return pointer;
        if(typeof ports.newScanId!=='function')throw Error('宿主没有提供唯一扫描 ID 接口');
        const id=ports.newScanId();if(typeof id!=='string'||!/^[A-Za-z0-9_-]{16,120}$/.test(id))throw Error('唯一扫描 ID 无效');
        const baseline=await load('scans',id);if(baseline.status!=='ready')return baseline;if(baseline.resource)return failure('SCAN_ID_EXISTS','扫描 ID 已存在，不能覆盖原文件或扫描点');
        if(!current(ticket,selected)||typeof file.isCurrent==='function'&&!file.isCurrent())return failure('CONTEXT_CHANGED','扫描项目或文件选择已变化');
        const result=await ports.scanBatchClient.save([{kind:'scans',id,value},{kind:'scan_current',id:selected.projectId,value:{projectId:selected.projectId,scanId:id}}]);
        if(!current(ticket,selected))return {status:'invalidated',code:'CONTEXT_CHANGED',databaseOutcome:result.status};
        if(result.status==='saved'){for(const resource of result.resources)cache.set(key(resource.kind,resource.id),copy(resource));return {...result,resource:result.resources[0]};}
        return result;
      }catch(error){return failure('INVALID_SCAN',error.message);}finally{writing=false;}
    }
    function aliasTarget(receiverId,channelNumber){
      if(typeof receiverId!=='string'||!receiverId.trim()||!Number.isInteger(channelNumber)||channelNumber<1||channelNumber>10000)throw Error('接收机身份与 CH 必须明确');
      return {id:JSON.stringify([receiverId,channelNumber]),value:{receiverId,channelNumber}};
    }
    async function freshBaseline(kind,id){
      const stored=cache.get(key(kind,id)),known=stored===undefined&&listedKinds.has(kind)?null:stored,result=await load(kind,id);
      if(result.status!=='ready')return result;
      if(known!==undefined&&((known?.revision||0)!==(result.resource?.revision||0))){
        // Merely retrying Save is not explicit adoption of the changed record.
        // Preserve the view revision until a deliberate load/list hydration.
        cache.set(key(kind,id),known===null?null:copy(known));
        return {status:'conflict',code:'RESOURCE_CHANGED_SINCE_VIEW',resource:result.resource};
      }
      return result;
    }
    async function saveAlias(receiverId,channelNumber,alias){
      try{
        if(typeof alias!=='string'||!alias.trim()||alias.trim().length>256)throw Error('名称须为 1～256 个字符');
        const target=aliasTarget(receiverId,channelNumber),ready=await freshBaseline('device_overrides',target.id);
        if(ready.status!=='ready')return ready;
        return await commit('device_overrides',target.id,{...target.value,alias:alias.trim()});
      }catch(error){return failure('INVALID_ALIAS',error.message);}
    }
    async function saveProfiles(imported){
      if(writing)return {status:'busy',code:'BUSINESS_WRITE_BUSY'};
      if(!ports.batchClient)return failure('BATCH_UNAVAILABLE','Profile 原子批量保存接口未接入');
      const ticket=generation,selected=context();writing=true;
      try{
        if(!Array.isArray(imported)||!imported.length||imported.length>200)throw Error('一次导入须包含 1～200 个 Profile');
        const ids=new Set(),writes=[];
        for(const profile of imported){
          if(profile?.source==='planning-snapshot'||String(profile?.id||'').startsWith('run-profile:'))throw Error('规划使用的 Profile 快照不可通过自定义 Profile 导入覆盖');
          if(typeof ports.validateProfile!=='function')throw Error('Profile 校验器未加载');
          const errors=ports.validateProfile(profile);if(errors.length)throw Error(errors.join('；'));
          if(ids.has(profile.id))throw Error('重复 Profile ID');ids.add(profile.id);
          const ready=await freshBaseline('profiles',profile.id);if(ready.status!=='ready')return ready;
          if(!current(ticket,selected))return failure('CONTEXT_CHANGED','项目已变化');
          writes.push({kind:'profiles',id:profile.id,value:{...copy(profile),source:'custom'}});
        }
        const result=await ports.batchClient.save(writes);
        if(!current(ticket,selected))return {status:'invalidated',code:'CONTEXT_CHANGED',databaseOutcome:result.status};
        if(result.status==='saved')for(const resource of result.resources)cache.set(key(resource.kind,resource.id),copy(resource));
        return result;
      }catch(error){return failure('INVALID_PROFILE',error.message);}finally{writing=false;}
    }
    function values(kind){return [...cache.values()].filter(item=>item?.kind===kind&&!item.deleted&&(kind!=='profiles'||item.value?.source!=='planning-snapshot')).map(item=>copy(item.value));}
    function cached(kind,id){const value=cache.get(key(kind,id));return value===undefined?undefined:value===null?null:copy(value);}
    function invalidate(){generation++;cache.clear();listedKinds.clear();ports.client.invalidate();ports.batchClient?.invalidate();ports.scanBatchClient?.invalidate();}
    return Object.freeze({load,listAll,saveThresholds,saveBoolean,saveSpectrumRange,savePage,saveSimulation,saveManual,manualId,saveScan,loadCurrentScan,clearCurrentScan,saveAlias,saveProfiles,values,cached,scanId,aliasTarget,invalidate,
      reconcile:(kind,id)=>ports.client.reconcile(kind,id),reconcileBatch:()=>ports.batchClient?.reconcile(),
      reconcileScan:()=>ports.scanBatchClient?.reconcile(),
      get busy(){return writing;},MAPPING});
  }
  return Object.freeze({PROTOCOL,MAPPING,create});
});
