/* Server project adapter using normalized transactional storage.
 * Explicit UI adapter for the existing global planning state, not a new store.
 * mount() replaces only the two project HTTP hooks; start() must be invoked AFTER
 * DatyDatabaseConnection is mounted. initDatabase/receiver/control/ACK paths stay untouched.
 */
(function(root){
  'use strict';
  const VERSION='daty-planning-project-storage-v1';
  const copy=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
  const same=(a,b)=>a===b||!!a&&!!b&&typeof a==='object'&&typeof b==='object'
    &&Array.isArray(a)===Array.isArray(b)&&Object.keys(a).length===Object.keys(b).length
    &&Object.keys(a).every(key=>own(b,key)&&same(a[key],b[key]));
  const atomicFields=['constraints','constraintFields','currentPlanningRecordId','last_coordination_at'];
  function error(message,syncStatus='error',code='PROJECT_STORAGE_FAILED',extra={}){
    return Object.assign(new Error(message),{syncStatus,code,...extra});
  }
  function mount(global){
    if(global.DatyDataRetention?.history===false){
      const disabled=async()=>({status:'disabled',persisted:false});
      global.persistPlanningProject=disabled;global.restorePlanningProjectFromServer=disabled;
      return global.DatyPlanningProjectStorage=Object.freeze({VERSION,start:disabled,loadBaseline:disabled,reconcile:disabled,invalidate:()=>{},snapshot:()=>({status:'disabled',started:true})});
    }
    if(global!==root)throw new TypeError('Planning storage must mount in the original application realm');
    if(global.DatyPlanningProjectStorage?.VERSION===VERSION)return global.DatyPlanningProjectStorage;
    if(!global.DatyUnifiedProjectSyncFactory || !global.DatyProjectConcurrencyFactory || !global.DatyPlatform
      ||typeof global.DatyPlatform.request!=='function'||!global.DatyPlatform.storage){
      throw new TypeError('Planning storage candidate requires project-sync, concurrency and complete platform ports');
    }
    let started=false,disposed=false,busy=false,flight=null,reviewRequired=false,startWaiters=[],unsubscribe=null;
    let observedScope=null,loadSerial=0;
    const timers={schedule:(fn,delay)=>global.DatyHostFactory.invokeRuntime(global,'setTimeout',fn,delay),
      cancel:handle=>global.DatyHostFactory.invokeRuntime(global,'clearTimeout',handle)};
    const normalize=value=>global.DatyPlatformFactory.normalizeBridgeUrl(value);
    function scope(){
      const auth=global.DatyDatabaseConnection?.snapshot?.();
      if(!auth || !Number.isSafeInteger(auth.revision)||auth.revision<0||!auth.origin){
        throw error('服务器连接尚未就绪；本机历史保留，尚未发送','unloaded','ACCESS_NOT_READY');
      }
      const baseUrl=normalize(global.planningProjectApiBase()),active=normalize(auth.origin);
      if(baseUrl!==active)throw error('项目地址与当前已确认服务器不同，请先连接并确认目标；本次未发送','invalidated','PROJECT_TARGET_MISMATCH');
      return {baseUrl,projectId:global.getCurrentPlanningProject().id,accessRevision:auth.revision,principalId:auth.source?.id??null};
    }
    const sync=global.DatyUnifiedProjectSyncFactory.create({
      request:(url,init)=>global.DatyPlatform.request(url,init),readScope:scope,
      storage:global.DatyPlatform.storage,readPrincipal:()=>global.DatyDatabaseConnection?.snapshot?.()?.source,
      schedule:timers.schedule,cancel:timers.cancel,concurrency:global.DatyProjectConcurrencyFactory.create()
    });
    function fields(){return copy(global.DatyPlanningConstraints?.captureConstraintFields?.()||{});}
    function localCapture(){return {project:copy(global.getCurrentPlanningProject()),record:copy(global.getCurrentPlanningRecord()),
      history:copy(HISTORY.filter(item=>(item.projectId||'default')===global.getCurrentPlanningProject().id)),
      deletedRecordIds:[...planningHistoryDeletedIds],revision:planningHistoryRevision,fields:fields()};}
    function atomic(project){
      if(!project)return null;
      const value={name:project.name,devices:copy(project.devices||[])};
      value.devices.sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);
      for(const key of atomicFields)if(own(project.data||{},key))value[key]=copy(project.data[key]);
      return value;
    }
    function desiredFrom(local,baseline,run){
      const data=copy(baseline?.data||{}),record=local.record;
      const deleted=new Set([...(data.deletedRecordIds||[]),...local.deletedRecordIds]);
      const ids=new Set(local.history.map(item=>item.id));
      data.planningHistory=[...copy(local.history),...(Array.isArray(data.planningHistory)?data.planningHistory:[])
        .filter(item=>item?.id&&!ids.has(item.id))].filter(item=>!deleted.has(item.id));
      data.deletedRecordIds=[...deleted];data.currentPlanningRecordId=record?.id||null;
      if(record){
        data.constraints=copy(record.options||record.constraints||{});
        if(record.constraintFields!==undefined)data.constraintFields=copy(record.constraintFields);else delete data.constraintFields;
        if(run)data.last_coordination_at=new Date(record.timestamp).toISOString();
      }else{delete data.constraints;delete data.constraintFields;}
      return {id:local.project.id,name:local.project.name,data,devices:copy(record?record.devices:baseline?.devices||[])};
    }
    function resultError(result){
      const state=result?.status||'error';
      const messages={busy:'上一笔项目同步尚未结束；本次本机历史已保留，请稍后明确保存',
        conflict:'服务器项目存在版本或内容冲突；本机历史已保留，请核对最新项目后重新确认',
        unsupported:'服务器尚未提供项目版本保护；本机历史已保留，本次没有写入服务器',
        unauthorized:'项目写入连接已失效；本机历史已保留，请重新确认连接',
        invalidated:'服务器、项目或连接已变化；旧同步已停止，已发送请求的结果请先核对，不会自动重发',
        unknown:'项目写入结果尚未确认；本机历史已保留，不会自动重发，请先只读核对',
        partial:result?.runStatus==='unknown'?'项目已保存，但运行记录结果未确认；不会自动重发，请先核对'
          :'项目已保存，但运行记录尚未保存；不会自动重发，请保留本机规划'};
      return error((result?.code==='MIGRATION_REQUIRED'?result.message:null)||messages[state]||result?.message||'服务器项目未同步；本机历史已保留',state,result?.code||'PROJECT_SYNC_FAILED',
        {projectSaved:result?.projectSaved===true,runStatus:result?.runStatus,details:copy(result?.conflicts||[])});
    }
    function isScope(expected){try{return !disposed&&same(expected,scope());}catch(_){return false;}}
    function invalidate(){loadSerial++;reviewRequired=true;sync.invalidate();}
    async function loadBaseline(){
      if(disposed)throw error('页面已退出，项目同步已停止','invalidated');
      if(!started)throw error('项目基线尚未启动，请等待服务器连接初始化','unloaded','BASELINE_REQUIRED');
      if(flight)return flight;
      const operation=(async()=>{
        // GET-only retry when initial automatic local authorization changes its
        // generation. Never repeat a POST, unknown write or arbitrary failure.
        for(let attempt=0;attempt<3;attempt++){
          const expected=scope(),before=localCapture(),serial=loadSerial;
          const result=await sync.load();
          if(result.status==='invalidated'&&!disposed&&!isScope(expected))continue;
          if(result.status!=='loaded')throw resultError(result);
          if(serial!==loadSerial||!isScope(expected))continue;
          const now=localCapture();observedScope=copy(expected);
          reviewRequired=!!result.project&&((before.record&&!same(atomic(desiredFrom(before,result.project)),atomic(result.project)))
            ||before.revision!==now.revision||!same(before.fields,now.fields));
          return result;
        }
        throw error('服务器或连接持续变化，项目基线尚未确认；本机历史保留','invalidated','BASELINE_REQUIRED');
      })();
      flight=operation;
      try{return await operation;}finally{if(flight===operation)flight=null;}
    }
    function waitStarted(){
      if(started)return Promise.resolve();
      if(disposed)return Promise.reject(error('页面已退出','invalidated'));
      return new Promise((resolve,reject)=>{
        const waiter={resolve,reject,timer:null};
        waiter.timer=timers.schedule(()=>{startWaiters=startWaiters.filter(item=>item!==waiter);
          reject(error('项目同步初始化未完成；实时设备不受影响，本机历史保留','unloaded','BOOTSTRAP_REQUIRED'));},5000);
        startWaiters.push(waiter);
      });
    }
    async function start(){
      if(disposed)throw error('页面已退出','invalidated');
      if(!started){
        if(!global.DatyDatabaseConnection||typeof global.DatyDatabaseConnection.subscribe!=='function')throw error('服务器连接初始化未完成，不能启动项目同步','unloaded','ACCESS_NOT_READY');
        started=true;
        unsubscribe=global.DatyDatabaseConnection.subscribe(()=>{
          let next;try{next=scope();}catch(_){invalidate();return;}
          if(observedScope&&!same(next,observedScope)){
            invalidate();observedScope=copy(next);
            // Public read only. Saving after changed access always requires a
            // valid newly loaded baseline; no queued command is replayed.
            if(!busy&&!flight)loadBaseline().catch(()=>{});
          }
        });
        for(const waiter of startWaiters){timers.cancel(waiter.timer);waiter.resolve();}startWaiters=[];
      }
      observedScope=copy(scope());
      if(sync.snapshot().loaded&&!flight)return sync.snapshot();
      return loadBaseline();
    }
    function waitPublicPrincipal(){
      const expected=scope();if(expected.principalId)return Promise.resolve();
      return new Promise((resolve,reject)=>{
        let unsubscribe=null,timer=null,finished=false;
        const finish=failure=>{if(finished)return;finished=true;unsubscribe?.();if(timer!==null)timers.cancel(timer);failure?reject(failure):resolve();};
        const check=()=>{try{
          const next=scope();
          if(disposed||next.baseUrl!==expected.baseUrl||next.projectId!==expected.projectId)throw error('初始数据库恢复目标已变化','invalidated');
          if(next.principalId)finish();
        }catch(failure){finish(failure);}};
        unsubscribe=global.DatyDatabaseConnection.subscribe(check);
        timer=timers.schedule(()=>finish(error('数据库尚未确认连接来源；本机输入保留','unloaded','SOURCE_REQUIRED')),5000);
        check();
      });
    }
    async function restore(canRestore=()=>true){
      if(global.DATY_DISABLE_SERVER_PERSISTENCE===true)return false;
      const revision=planningHistoryRevision,project=global.getCurrentPlanningProject(),hadCurrent=!!global.getCurrentPlanningRecord(),originalFields=fields();
      try{
        await waitStarted();
        await waitPublicPrincipal();
        const existing=sync.snapshot();
        const loaded=existing.loaded?{project:existing.project,scope:existing.scope}:await loadBaseline();
        if((hadCurrent||global.getCurrentPlanningRecord())&&!global.DatyServerStorage?.legacyArchived)return false;
        if(!canRestore()||revision!==planningHistoryRevision||!same(originalFields,fields())||project.id!==global.getCurrentPlanningProject().id||!isScope(loaded.scope)){
          reviewRequired=!!loaded.project;return false;
        }
        const server=loaded.project;if(!server)return false;
        const data=server.data||{},nextProject={id:project.id,name:server.name||project.name};
        if(Array.isArray(data.planningHistory)||(!data.constraints&&!data.constraintFields)){
          const deleted=new Set([...planningHistoryDeletedIds,...(data.deletedRecordIds||[])]);
          const remote=(Array.isArray(data.planningHistory)?data.planningHistory:[]).filter(item=>{try{global.validatePlanningRecord(item);return item.id&&!deleted.has(item.id)&&(item.projectId||'default')===project.id;}catch(_){return false;}});
          const current=HISTORY.filter(item=>!deleted.has(item.id)),ids=new Set(current.map(item=>item.id));
          const records=global.DatyServerStorage?.legacyArchived?remote:[...remote.filter(item=>!ids.has(item.id)),...current];
          const selected=data.currentPlanningRecordId===null||deleted.has(data.currentPlanningRecordId)?null
            :remote.find(item=>item.id===data.currentPlanningRecordId)?.id||remote[0]?.id||null;
          global.DatyPlatform.storage.setItem(PLANNING_HISTORY_STORAGE_KEY,JSON.stringify({project:nextProject,currentRecordId:selected,records,deletedRecordIds:[...deleted]}));
          currentPlanningProject=nextProject;currentPlanningRecordId=selected;
          HISTORY.splice(0,HISTORY.length,...records);planningHistoryDeletedIds.clear();for(const id of deleted)planningHistoryDeletedIds.add(id);planningHistoryRevision++;
        }else if(data.constraints||data.constraintFields){
          const previous=currentPlanningProject;currentPlanningProject=nextProject;
          try{global.savePlanningResult(server.devices||[],null,data.constraints||{},data.constraintFields||null);}catch(failure){currentPlanningProject=previous;throw failure;}
        }
        const current=global.getCurrentPlanningRecord();
        if(current)global.DatyPlanningConstraints?.restoreSnapshot(current);
        else if(data.currentPlanningRecordId===null&&(own(data,'constraints')||own(data,'constraintFields')))
          global.DatyPlanningConstraints?.restoreSnapshot({constraints:copy(data.constraints??{}),constraintFields:copy(data.constraintFields),devices:copy(server.devices||[])});
        global.renderHistory?.();reviewRequired=false;
        global.setPlanningSaveStatus(current?'已从服务器恢复当前项目及规划历史':'当前项目暂无规划历史');
        return true;
      }catch(failure){
        if(canRestore()&&revision===planningHistoryRevision)global.setPlanningSaveStatus(failure.message||'项目基线未读取，本机历史已保留');
        return false;
      }
    }
    function persist(record=global.getCurrentPlanningRecord(),run=null){
      if(global.DATY_DISABLE_SERVER_PERSISTENCE===true)return Promise.reject(error('服务器项目同步已禁用，仅保存到本机','disabled'));
      if(busy)return Promise.reject(resultError({status:'busy'}));
      let captured,expected;
      try{expected=scope();captured={...localCapture(),record:copy(record),run:copy(run),provenance:run?global.DatyUnifiedProjectSyncFactory.readRunSources(run):null};}catch(failure){return Promise.reject(failure);}
      busy=true;
      const operation=(async()=>{
        await waitStarted();
        let current=sync.snapshot();
        if(current.unknown){
          if(typeof global.DatyDialogs?.confirm!=='function')throw error('上一笔同步结果未确认，需要应用内确认后进行只读核对；没有发送新写入','unknown','RECONCILE_CONFIRM_REQUIRED');
          const accepted=await global.DatyDialogs.confirm({title:'只读核对上一笔项目同步',
            message:current.unknown.projectSaved?'上一笔项目已保存，但运行记录尚未确认。是否只读查询服务器？':'上一笔项目写入结果未确认。是否只读查询服务器，核对项目内容与版本？',
            warnings:['本次只发送查询，不重发项目或运行记录，也不操作接收机。',
              '即使核对成功，本次本机规划也不会继续自动保存；需要您再次主动保存。'],
            confirmLabel:'确认只读核对',footnote:'取消不发送查询，未知结果继续保持保护'});
          if(accepted!==true)throw error('已取消只读核对；没有发送新的项目请求，上一笔未知结果继续保持保护','cancelled','PROJECT_RECONCILE_CANCELLED');
          if(!isScope(expected))throw resultError({status:'invalidated'});
          const checked=await sync.reconcile();
          if(checked.status==='saved'||checked.status==='partial'&&checked.projectSaved&&checked.runStatus==='not-sent'){
            reviewRequired=!!checked.project&&!same(atomic(desiredFrom(localCapture(),checked.project)),atomic(checked.project));
            throw error('上一笔项目已只读核对成功'+(checked.runStatus==='not-sent'?'；其运行记录未发送':'')+
              '。本次本机规划尚未同步，请再次主动保存；本次没有发送项目或运行记录写入',
              'reconciled','PREVIOUS_PROJECT_RECONCILED',{projectSaved:true,runStatus:checked.runStatus,reconciled:true});
          }
          if(checked.status==='partial'&&checked.blocked)throw error('上一笔项目已保存，但运行记录仍无法只读确认；保护继续生效，本次未发送新写入',
            'unknown',checked.code,{projectSaved:true,runStatus:checked.runStatus});
          throw resultError(checked);
        }
        if(current.status==='conflict'){
          if(typeof global.DatyDialogs?.confirm!=='function')throw error('项目存在冲突，需要应用内确认后重新读取基线；没有发送新写入','conflict','CONFLICT_CONFIRM_REQUIRED');
          const accepted=await global.DatyDialogs.confirm({title:'只读核对项目冲突',
            message:'本机与另一客户端同时修改了项目。是否先只读获取最新服务器项目，保留本机历史和当前输入？',
            warnings:['本次只重新读取基线，不写入项目，也不覆盖当前输入。',
              '读取成功后请再次主动保存，再明确确认采用本次本机规划；仍执行版本条件校验。'],
            confirmLabel:'确认读取最新基线',footnote:'取消不发送请求，保留当前冲突状态'});
          if(accepted!==true)throw error('已取消冲突核对；没有发送新请求，本机历史与冲突状态均保留','cancelled','PROJECT_CONFLICT_REVIEW_CANCELLED');
          if(!isScope(expected))throw resultError({status:'invalidated'});
          await loadBaseline();reviewRequired=true;
          throw error('已只读获取最新项目基线，本机输入与历史未改；本次没有写入。请再次主动保存并确认采用本次本机规划',
            'reloaded','PROJECT_BASELINE_RELOADED');
        }
        if(!current.loaded){await loadBaseline();current=sync.snapshot();}
        if(!isScope(expected))throw resultError({status:'invalidated'});
        global.DatyDatabaseConnection.assertConnected();
        if(reviewRequired){
          if(typeof global.DatyDialogs?.confirm!=='function')throw error('本机规划与服务器基线不同，需要应用内确认能力；本次未发送','conflict','BASELINE_REVIEW_REQUIRED');
          const accepted=await global.DatyDialogs.confirm({title:'确认项目同步基准',
            message:'本机当前规划与服务器已保存项目不同。是否以本次本机规划作为当前规划保存？',
            warnings:['本机和服务器历史均保留；有正文冲突或被删除记录仍会停止保存。','确认后仍读取最新版本并执行条件写入，不修改或下发接收机。'],
            confirmLabel:'确认保存本次规划',footnote:'取消只保留本机历史，不写入服务器'});
          if(accepted!==true)throw error('已取消服务器同步，本机历史已保留；没有发送项目写入','cancelled','PROJECT_SAVE_CANCELLED');
          if(!isScope(expected)||captured.revision!==planningHistoryRevision||!same(captured.fields,fields()))throw resultError({status:'invalidated'});
        }
        if(!isScope(expected)||captured.revision!==planningHistoryRevision||!same(captured.fields,fields()))throw resultError({status:'invalidated'});
        global.DatyDatabaseConnection.assertConnected();
        const desired=desiredFrom(captured,current.project,captured.run);
        const options=captured.run?{run:{project_id:captured.project.id,input:{devices:copy(captured.record.devices),options:copy(captured.record.options)},result:captured.run},provenance:captured.provenance}:{};
        const result=await sync.save(desired,options);
        if(result.status!=='saved')throw resultError(result);
        reviewRequired=false;
        return result;
      })();
      const pending=operation.finally(()=>{busy=false;});planningProjectSaveQueue=pending;
      return pending;
    }
    async function reconcile(){
      await waitStarted();
      if(busy)throw resultError({status:'busy'});
      const result=await sync.reconcile();
      if(result.status==='saved'&&result.project){
        reviewRequired=!same(atomic(desiredFrom(localCapture(),result.project)),atomic(result.project));
      }
      return result;
    }
    const controller=Object.freeze({VERSION,start,loadBaseline,reconcile,invalidate,snapshot:()=>({...sync.snapshot(),reviewRequired,busy,started})});
    global.persistPlanningProject=persist;global.restorePlanningProjectFromServer=restore;global.DatyPlanningProjectStorage=controller;
    global.addEventListener?.('pagehide',()=>{
      disposed=true;unsubscribe?.();invalidate();
      for(const waiter of startWaiters){timers.cancel(waiter.timer);waiter.reject(error('页面已退出，项目同步停止','invalidated'));}startWaiters=[];
    });
    return controller;
  }
  root.DatyPlanningProjectStorageFactory=Object.freeze({VERSION,mount});
})(typeof globalThis!=='undefined'?globalThis:this);
