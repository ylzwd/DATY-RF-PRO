/* Candidate projection of normalized business documents to the existing C2
 * planning adapter. No DOM, receiver commands, algorithm replacement or startup
 * writes. Every project save is one journaled atomic batch; its editing baseline
 * is established by load(), never replaced by save()'s latest GET. */
(function(root,build){
  const factory=build();
  if(typeof module==='object'&&module.exports)module.exports=factory;else root.DatyUnifiedProjectSyncFactory=factory;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const VERSION='daty-unified-project-sync-v1',PROTOCOL='daty-business-db-v1',JOURNAL_ID='planning';
  const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
  const equal=(a,b)=>a===b||!!a&&!!b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)
    &&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>own(b,k)&&equal(a[k],b[k]));
  // Immutable history is an ID-keyed collection. SQL page order and receipt
  // insertion order may differ without any edit. Normalize only that collection
  // for baseline comparison; displayed history and every other array stay intact.
  const sameProject=(a,b)=>{
    const comparable=value=>value&&({...value,data:{...value.data,planningHistory:[...(value.data?.planningHistory||[])].sort((x,y)=>x.id<y.id?-1:x.id>y.id?1:0)}});
    return equal(comparable(a),comparable(b));
  };
  const atomicKeys=['constraints','constraintFields','last_coordination_at'];
  const reserved=new Set([...atomicKeys,'planningHistory','deletedRecordIds','currentPlanningRecordId']);
  const fail=(code,message,status='error')=>Object.assign(Error(message),{code,status});
  const runSources=new WeakMap();
  const jsonClone=value=>JSON.parse(JSON.stringify(value));
  function captureRunSources(applied){
    try{return applied?jsonClone(applied):null;}catch(_){return null;}
  }
  function rememberRunSources(result,captured){
    if(!result||typeof result!=='object')return;
    try{runSources.set(result,{captured:captureRunSources(captured),input:jsonClone({options:result.options,profileSnapshots:result.profileSnapshots,engineVersion:result.engineVersion})});}catch(_){}
  }
  function readRunSources(result){
    const known=result&&runSources.get(result);
    if(!known)return null;
    try{return equal(known.input,jsonClone({options:result.options,profileSnapshots:result.profileSnapshots,engineVersion:result.engineVersion}))?captureRunSources(known.captured):null;}catch(_){return null;}
  }
  function create(ports){
    const scalarFactory=ports?.databaseFactory||(typeof module==='object'&&module.exports?require('./database-client.js'):globalThis.DatyDatabaseClientFactory);
    const batchFactory=ports?.batchFactory||(typeof module==='object'&&module.exports?require('./database-batch-client.js'):globalThis.DatyDatabaseBatchFactory);
    if(!scalarFactory||!batchFactory||!ports?.concurrency||typeof ports.concurrency.mergeProject!=='function')throw TypeError('Unified project sync requires database, batch and pure merge factories');
    const copy=scalarFactory.copyBusinessValue;
    let scope=null,baseline,baselineBundle=null,generation=0,active=null,status='unloaded';
    function readScope(){
      const input=ports.readScope(),principal=input.principalId??ports.readPrincipal?.()?.id;
      if(typeof principal!=='string'||!principal.trim())throw fail('UNAUTHORIZED','项目数据库需要已确认的服务器连接来源','unauthorized');
      if(typeof input.projectId!=='string'||!input.projectId.trim())throw fail('INVALID_SCOPE','项目 ID 无效');
      const url=new URL(input.baseUrl);
      if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw fail('INVALID_SCOPE','项目数据库仅允许 HTTPS 服务根地址');
      if(url.hostname==='localhost'&&url.port==='8802')url.hostname='127.0.0.1';
      return {baseUrl:url.origin,projectId:input.projectId,accessRevision:input.accessRevision,principalId:principal};
    }
    const host={...ports,readScope,request:(...args)=>ports.request(...args),schedule:(...args)=>ports.schedule(...args),cancel:(...args)=>ports.cancel(...args)};
    const resources=scalarFactory.create(host),batch=batchFactory.create({...host,factory:scalarFactory,resourceClient:resources,journalId:JOURNAL_ID});
    function invalidate(){generation++;baseline=undefined;baselineBundle=null;scope=null;status='unloaded';resources.invalidate();batch.invalidate();active?.interrupt?.();active=null;}
    function synchronize(){const next=readScope();if(!equal(scope,next)){invalidate();scope=next;}return scope;}
    function current(ticket){try{return !!ticket&&active===ticket&&ticket.generation===generation&&equal(ticket.scope,readScope());}catch(_){return false;}}
    function guard(ticket){if(!current(ticket))throw fail('SCOPE_CHANGED','服务器、项目或连接已变化','invalidated');}
    function pending(){
      const state=batch.snapshot();
      if(!state.unknown&&state.status!=='unknown'&&state.code!=='JOURNAL_INVALID')return null;
      let writes;
      try{
        const selected=readScope(),key=scalarFactory.JOURNAL_PREFIX+encodeURIComponent(JSON.stringify([selected.baseUrl,selected.principalId,'batch_journal',JOURNAL_ID]));
        writes=JSON.parse(ports.storage.getItem(key))?.body?.value?.writes;
      }catch(_){}
      const metadata=Array.isArray(writes)?writes.find(item=>item.kind==='project_metadata'):null;
      return {phase:'project',expectedRevision:metadata?.expected_revision??0,projectSaved:false,
        projectId:metadata?.id??null,operationId:state.unknown?.operationId,code:state.code||state.unknown?.code||'PREVIOUS_POST_UNCONFIRMED'};
    }
    function result(value,ticket){if(ticket)guard(ticket);status=value.status;return {...value,scope:scope&&copy(scope)};}
    function mapped(value){
      if(value.status==='ready')return value;
      const statusMap={rejected:'error',unloaded:'error'};
      throw fail(value.code||'DATABASE_READ_FAILED',value.message||'项目数据库读取未确认',statusMap[value.status]||value.status||'error');
    }
    async function loadResource(ticket,kind,id,epoch){
      guard(ticket);const value=mapped(await resources.load(kind,id));guard(ticket);
      if(epoch!==undefined&&value.epoch!==epoch)throw fail('EPOCH_CHANGED','数据库代次已变化，请重新读取基线','conflict');
      return value;
    }
    function legacyRead(ticket){
      // Compatibility probe only; never imports, edits or writes the old API.
      return new Promise((resolve,reject)=>{
        const controller=new AbortController();let timer,done=false;
        const finish=(error,value)=>{if(done)return;done=true;if(ticket.interrupt===interrupt)ticket.interrupt=null;
          try{if(timer!==undefined)ports.cancel(timer);}catch(problem){error=error||problem;}error?reject(error):resolve(value);};
        const interrupt=()=>{controller.abort();finish(fail('SCOPE_CHANGED','旧项目只读核对已失效','invalidated'));};ticket.interrupt=interrupt;
        try{timer=ports.schedule(()=>{controller.abort();finish(fail('REQUEST_TIMEOUT','旧项目只读核对超时'));},5000);
          if(timer===undefined||timer===null||typeof timer?.then==='function'){
            if(typeof timer?.then==='function')Promise.resolve(timer).catch(()=>{});
            throw fail('INVALID_TIMER','宿主计时器必须同步返回句柄');
          }
        }catch(error){finish(error);return;}
        Promise.resolve().then(()=>{if(done)return;guard(ticket);return ports.request(ticket.scope.baseUrl+'/api/projects/'+encodeURIComponent(ticket.scope.projectId),
          {cache:'no-store',redirect:'error',signal:controller.signal});}).then(async response=>{
          if(done)return;guard(ticket);
          if(response?.status===401||response?.status===403)throw fail('UNAUTHORIZED','旧项目核对权限未确认','unauthorized');
          const body=await response.json();if(done)return;guard(ticket);
          if(response.status===404&&body?.success===false){finish(null,null);return;}
          const project=body?.project;
          if(response.status!==200||body?.success!==true||project?.id!==ticket.scope.projectId||!project.data||Array.isArray(project.data)||!Array.isArray(project.devices))throw fail('LEGACY_PROJECT_UNCONFIRMED','旧项目状态未确认，不能创建新项目');
          finish(null,copy(project));
        }).catch(error=>finish(error));
      });
    }
    function assemble(metadata,currentResource,records){
      const metadataValue=metadata.value,currentValue=currentResource?.value||{};
      if(metadata.deleted||metadataValue?.id!==metadata.id||typeof metadataValue.name!=='string'
        ||!metadataValue.data||typeof metadataValue.data!=='object'||Array.isArray(metadataValue.data)
        ||currentResource?.deleted||currentResource&&currentValue.projectId!==metadata.id)throw fail('INVALID_PROJECT_RESOURCES','项目规范化资源不一致','conflict');
      const data=copy(metadataValue.data||{}),deleted=copy(currentValue.deletedRecordIds||[]);
      if(!Array.isArray(deleted)||deleted.some(id=>typeof id!=='string'))throw fail('INVALID_PROJECT_RESOURCES','项目删除记录无效');
      const dead=new Set(deleted);
      data.planningHistory=records.filter(item=>!item.deleted&&item.value?.projectId===metadata.id&&!dead.has(item.id)).map(item=>{
        if(item.value.id!==item.id)throw fail('INVALID_PROJECT_RESOURCES','历史记录 ID 不一致');return copy(item.value);
      });
      data.deletedRecordIds=deleted;data.currentPlanningRecordId=currentValue.currentRecordId??null;
      for(const key of atomicKeys)if(own(currentValue,key))data[key]=copy(currentValue[key]);else delete data[key];
      const project={id:metadata.id,name:metadataValue.name,data,devices:copy(currentValue.devices??[]),revision:metadata.revision,revision_protocol:PROTOCOL};
      const checked=ports.concurrency.mergeProject({base:project,desired:project,remote:project});
      if(checked.status!=='ready')throw fail('INVALID_PROJECT_RESOURCES','项目当前选择、历史或删除记录不一致','conflict');
      return project;
    }
    async function readBundle(ticket){
      const id=ticket.scope.projectId,meta=await loadResource(ticket,'project_metadata',id),epoch=meta.epoch;
      const selected=await loadResource(ticket,'planning_current',id,epoch),records=[],seen=new Set(),cursors=new Set();
      let cursor=null,asOf=null;
      do{
        const page=mapped(await resources.list('planning_records',{limit:200,cursor,projectId:id}));guard(ticket);
        if(page.epoch!==epoch||asOf!==null&&page.asOf!==asOf)throw fail('EPOCH_CHANGED','项目历史读取代次已变化','conflict');
        asOf=page.asOf;
        for(const item of page.resources){if(seen.has(item.id))throw fail('INVALID_PROJECT_RESOURCES','重复规划历史');seen.add(item.id);records.push(item);}
        cursor=page.cursor;if(cursor&&cursors.has(cursor))throw fail('INVALID_PROJECT_RESOURCES','历史分页游标循环');if(cursor)cursors.add(cursor);
      }while(cursor);
      // Prevent a project batch committing across our independent HTTP reads
      // from turning the aggregate into a mixture of two editing baselines.
      const again=await loadResource(ticket,'project_metadata',id,epoch),currentAgain=await loadResource(ticket,'planning_current',id,epoch);
      if(!equal(meta.resource,again.resource)||!equal(selected.resource,currentAgain.resource))throw fail('PROJECT_READ_CHANGED','项目在读取过程中变化，请重新核对','conflict');
      if(meta.resource===null){
        const legacy=await legacyRead(ticket);guard(ticket);
        if(selected.resource!==null||records.some(item=>item.value?.projectId===id)
          ||legacy&&(Object.keys(legacy.data).length||legacy.devices.length||legacy.id!=='default'||legacy.name!=='默认项目')){
          throw fail('MIGRATION_REQUIRED','旧项目尚未显式导入统一数据库；本机与旧服务器数据保留，请先预览并确认导入','unsupported');
        }
        return {epoch,project:null,metadata:null,current:null,records,legacyEmpty:true};
      }
      return {epoch,project:assemble(meta.resource,selected.resource,records),metadata:meta.resource,current:selected.resource,records};
    }
    async function execute(kind,operation){
      let ticket;
      try{
        synchronize();if(active)return {status:'busy',code:'PROJECT_SYNC_BUSY',scope:copy(scope)};
        const uncertain=pending();if(uncertain&&kind!=='reconcile')return result({status:'unknown',code:uncertain.code,projectSaved:false});
        ticket={kind,scope:copy(scope),generation,interrupt:null};active=ticket;
        return await operation(ticket);
      }catch(error){return current(ticket)?result({status:error.status||'error',code:error.code||'PROJECT_DATABASE_FAILED',message:error.message},ticket)
        :{status:error.status==='unauthorized'?'unauthorized':ticket?'invalidated':'error',code:error.code||'SCOPE_CHANGED',message:error.message};}
      finally{if(active===ticket)active=null;}
    }
    function load(){return execute('load',async ticket=>{
      const bundle=await readBundle(ticket);guard(ticket);baselineBundle=bundle;baseline=copy(bundle.project);
      return result({status:'loaded',project:copy(baseline)},ticket);
    });}
    async function writeInput(ticket,kind,id,value,remote,epoch){
      const loaded=await loadResource(ticket,kind,id,epoch);
      if(kind==='planning_records'||kind==='planning_runs'||kind==='profiles'&&id.startsWith('run-profile:')){
        if(loaded.resource){
          if(loaded.resource.deleted||!equal(loaded.resource.value,value)||kind==='profiles'&&loaded.resource.revision!==1)throw fail('HISTORY_ID_CONTENT_CONFLICT','不可变历史 ID 已存在不同正文或已被删除','conflict');
          return null;
        }
      }else if(!equal(loaded.resource,remote))throw fail('PROJECT_RESOURCE_CHANGED','项目资源在准备期间变化','conflict');
      return {kind,id,value:copy(value),deleted:false};
    }
    function save(desired,options={}){
      let captured,run,provenance;try{captured=copy(desired);run=options.run===undefined||options.run===null?null:copy(options.run);
        provenance=options.provenance?copy(options.provenance):null;}catch(error){return Promise.resolve({status:'error',code:error.code||'INVALID_PROJECT',message:error.message});}
      return execute('save',async ticket=>{
        if(baseline===undefined)return result({status:'error',code:'BASELINE_REQUIRED'},ticket);
        if(captured.id!==ticket.scope.projectId)return result({status:'error',code:'PROJECT_ID_MISMATCH'},ticket);
        const remote=await readBundle(ticket);guard(ticket);
        if(remote.epoch!==baselineBundle.epoch)throw fail('EPOCH_CHANGED','数据库已恢复或更换，旧编辑基线不能继续写入','conflict');
        if(baseline&&remote.project&&(remote.project.revision<baseline.revision
          ||remote.project.revision===baseline.revision&&!sameProject(remote.project,baseline)))throw fail('PROJECT_REVISION_CONFLICT','项目版本或内容已变化，请显式核对','conflict');
        // Resource CAS is kept in addition to the metadata revision. A direct
        // current-resource edit cannot be hidden by an unchanged metadata row.
        if(baselineBundle.current&&remote.current&&remote.current.revision<baselineBundle.current.revision)throw fail('PROJECT_REVISION_CONFLICT','当前规划版本倒退','conflict');
        const merged=ports.concurrency.mergeProject({base:baseline,desired:captured,remote:remote.project});
        if(merged.status!=='ready')return result({status:'conflict',conflicts:copy(merged.conflicts||[])},ticket);
        const project=merged.project,unknownData={};
        for(const key of Object.keys(project.data))if(!reserved.has(key))Object.defineProperty(unknownData,key,{value:copy(project.data[key]),enumerable:true,configurable:true,writable:true});
        const metadata={...(remote.metadata?copy(remote.metadata.value):{}),id:project.id,name:project.name,data:unknownData};
        const currentValue={...(remote.current?copy(remote.current.value):{}),projectId:project.id,
          currentRecordId:project.data.currentPlanningRecordId??null,deletedRecordIds:copy(project.data.deletedRecordIds||[]),devices:copy(project.devices)};
        for(const key of atomicKeys)if(own(project.data,key))currentValue[key]=copy(project.data[key]);else delete currentValue[key];
        const writes=[await writeInput(ticket,'project_metadata',project.id,metadata,remote.metadata,remote.epoch)];
        const known=new Map(remote.records.map(item=>[item.id,item]));
        for(const record of project.data.planningHistory||[]){
          if(record.projectId!==project.id)throw fail('HISTORY_PROJECT_REQUIRED','历史记录必须明确标识所属项目；旧记录请先显式导入','conflict');
          const previous=known.get(record.id);
          if(previous){if(previous.deleted||!equal(previous.value,record))throw fail('HISTORY_ID_CONTENT_CONFLICT','历史 ID 正文冲突','conflict');continue;}
          const input=await writeInput(ticket,'planning_records',record.id,record,null,remote.epoch);if(input)writes.push(input);
        }
        writes.push(await writeInput(ticket,'planning_current',project.id,currentValue,remote.current,remote.epoch));
        if(run){
          if(!currentValue.currentRecordId||run.project_id!==undefined&&run.project_id!==project.id
            ||run.projectId!==undefined&&run.projectId!==project.id)throw fail('INVALID_RUN','运行记录必须属于当前已选规划');
          const value={...run,projectId:project.id,purpose:run.purpose||'coordination-history'};delete value.project_id;
          // Never accept caller-invented references or fill old input from the
          // current scan/registry. Result snapshots are the computed inputs.
          delete value.scanId;value.profileRefs=[];
          const missing=[],profileBindings=[],snapshots=run.result?.profileSnapshots;
          if(typeof run.result?.engineVersion==='string'&&run.result.engineVersion)value.engineVersion=run.result.engineVersion;
          else{delete value.engineVersion;missing.push('ENGINE_VERSION_MISSING');}
          const distinct=new Map();
          if(!Array.isArray(snapshots))missing.push('PROFILE_SNAPSHOTS_MISSING');
          else for(const item of snapshots){
            const profile=item?.profile;
            if(!profile||typeof profile.id!=='string'||!profile.id||item.deviceId===undefined){missing.push('INVALID_PROFILE_SNAPSHOT');continue;}
            const previous=distinct.get(profile.id);
            if(previous&&!equal(previous.profile,profile))throw fail('PROFILE_SNAPSHOT_CONFLICT','同一规划中同一 Profile ID 出现不同正文','conflict');
            if(!previous)distinct.set(profile.id,{profile,devices:[]});distinct.get(profile.id).devices.push(copy(item.deviceId));
          }
          const usedDevices=run.input?.devices;
          if(!Array.isArray(usedDevices))missing.push('PROFILE_DEVICE_INPUT_MISSING');
          else if(!Array.isArray(snapshots)||usedDevices.some(device=>!snapshots.some(item=>equal(item.deviceId,device.id)))
            ||snapshots.some(item=>!usedDevices.some(device=>equal(device.id,item.deviceId))))missing.push('PROFILE_SNAPSHOT_COVERAGE_MISSING');
          for(const [originalId,entry]of distinct){
            const profileId='run-profile:'+currentValue.currentRecordId+':'+profileBindings.length;
            const snapshotValue={...copy(entry.profile),id:profileId,source:'planning-snapshot',originalProfileId:originalId,
              originalSource:own(entry.profile,'source')?copy(entry.profile.source):null};
            const input=await writeInput(ticket,'profiles',profileId,snapshotValue,null,remote.epoch);
            if(input)writes.push(input);
            value.profileRefs.push({id:profileId,revision:1});
            profileBindings.push({originalProfileId:originalId,resourceId:profileId,revision:1,deviceIds:entry.devices});
          }
          const points=run.result?.options?.scanPoints,scan=provenance?.scan;
          let scanProof=null;
          if(!Array.isArray(points))missing.push('SCAN_INPUT_MISSING');
          else if(points.length){
            const evidenceScope=provenance?.scope;
            if(!scan||provenance.epoch!==remote.epoch||!equal(evidenceScope,ticket.scope)
              ||scan.kind!=='scans'||scan.deleted||!Number.isSafeInteger(scan.revision)||scan.revision<1
              ||scan.value?.projectId!==project.id||!['imported_csv','instrument'].includes(scan.value?.sourceKind)
              ||!equal(scan.value.points,points))missing.push('SCAN_COMPUTATION_SOURCE_UNCONFIRMED');
            else{
              const verified=await loadResource(ticket,'scans',scan.id,remote.epoch);
              if(!equal(verified.resource,scan))missing.push('SCAN_SOURCE_CHANGED_OR_MISSING');
              else{value.scanId=scan.id;scanProof={id:scan.id,revision:scan.revision,epoch:remote.epoch};}
            }
          }
          value.inputEvidence={protocol:'daty-planning-input-evidence-v1',profileBindings,scan:scanProof,
            scanUse:Array.isArray(points)?points.length?'used':'none':'unknown',missing};
          value.inputVerification=missing.length?'unverified':'computed-inputs-linked';
          const input=await writeInput(ticket,'planning_runs',currentValue.currentRecordId,value,null,remote.epoch);if(input)writes.push(input);
        }
        guard(ticket);
        if(writes.length>200)throw fail('PROJECT_BATCH_TOO_LARGE','本次新增历史超过单笔原子事务上限；请使用显式导入流程，未拆分或部分写入');
        const saved=await batch.save(writes);guard(ticket);
        if(saved.status!=='saved')return result({...saved,status:saved.status==='rejected'?'error':saved.status},ticket);
        const metadataReceipt=saved.resources.find(item=>item.kind==='project_metadata'),currentReceipt=saved.resources.find(item=>item.kind==='planning_current');
        const recordMap=new Map(remote.records.map(item=>[item.id,item]));
        for(const item of saved.resources)if(item.kind==='planning_records')recordMap.set(item.id,item);
        const confirmed=assemble(metadataReceipt,currentReceipt,[...recordMap.values()]);
        baseline=confirmed;baselineBundle={epoch:saved.epoch,project:confirmed,metadata:metadataReceipt,current:currentReceipt,records:[...recordMap.values()]};
        return result({status:'saved',project:copy(confirmed),revision:confirmed.revision,projectSaved:true,
          operationId:saved.operationId,...(run?{runStatus:'saved',runId:currentValue.currentRecordId}:{})},ticket);
      });
    }
    function reconcile(){return execute('reconcile',async ticket=>{
      const uncertain=pending();if(!uncertain)return result({status:'error',code:'NO_UNKNOWN_WRITE'},ticket);
      if(uncertain.projectId!==ticket.scope.projectId)return result({status:'unknown',code:'PENDING_OTHER_PROJECT',message:'请切回原项目核对上一笔事务'},ticket);
      const checked=await batch.reconcile();guard(ticket);
      if(checked.status!=='reconciled')return result({...checked,status:checked.status==='ready'?'unknown':checked.status},ticket);
      const proof=checked.resources.find(item=>item.kind==='project_metadata'),run=checked.resources.find(item=>item.kind==='planning_runs');
      // Receipt proves the historical transaction, not that its revision is
      // still current. Refresh is GET-only and never automatically posts again.
      baseline=undefined;baselineBundle=null;let project;
      try{const loaded=await readBundle(ticket);guard(ticket);baseline=loaded.project;baselineBundle=loaded;project=loaded.project;}catch(error){guard(ticket);}
      return result({status:'saved',project:project===undefined?undefined:copy(project),revision:proof.revision,
        projectSaved:true,reconciled:true,operationId:checked.operationId,reloadRequired:project===undefined,
        ...(run?{runStatus:'saved',runId:run.id}:{})},ticket);
    });}
    function snapshot(){
      try{synchronize();const unknown=pending();return {VERSION,scope:copy(scope),project:baseline===undefined?undefined:copy(baseline),
        loaded:baseline!==undefined,pending:active?.kind||null,unknown,status:unknown?'unknown':status};}
      catch(error){return {VERSION,scope:null,loaded:false,pending:null,unknown:null,status:error.status||'error',code:error.code};}
    }
    return Object.freeze({VERSION,load,save,reconcile,invalidate,snapshot});
  }
  return Object.freeze({VERSION,PROTOCOL,create,captureRunSources,rememberRunSources,readRunSources});
});
