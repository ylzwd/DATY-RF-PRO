/* Original alert UI adapter. Its snapshot is server-confirmed history only;
 * live ALERTS is still owned by the existing real-time alarm engine. */
(function(root){'use strict';
  function mount(global){
    if(global.DatyAlertDatabase)return global.DatyAlertDatabase;
    const copy=value=>JSON.parse(JSON.stringify(value)),storage=global.DatyPlatform.storage;
    const readScope=()=>{const state=global.DatyDatabaseConnection.snapshot();return {baseUrl:state.origin,principalId:state.source?.id,accessRevision:state.revision};};
    const scopeKey=()=>JSON.stringify(readScope());
    const ports={readScope,storage,request:(...args)=>global.DatyDatabaseConnection.request(...args),
      schedule:(fn,ms)=>global.DatyHostFactory.invokeRuntime(global,'setTimeout',fn,ms),cancel:id=>global.DatyHostFactory.invokeRuntime(global,'clearTimeout',id)};
    const client=global.DatyDatabaseClientFactory.create(ports);
    const batch=global.DatyDatabaseBatchFactory.create({...ports,resourceClient:client,journalId:'alerts'});
    const repository=global.DatyAlertDatabaseFactory.create({client,batchClient:batch});
    let loaded=false,flight=null,flushFlight=null,clearSession=null,observedScope=scopeKey(),adoptionError='',legacyError='',readError='',disposed=false;
    function same(a,b){return a===b||!!a&&!!b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)
      &&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.hasOwn(b,key)&&same(a[key],b[key]));}
    function legacyRecords(){
      try{const raw=storage.getItem('daty_db_alerts');
        // Only the exact cache saved with a verified receipt on THIS connection
        // may yield to server history. A generic legacyArchived flag is not proof.
        if(global.DatyServerStorage?.isCacheArchived?.('daty_db_alerts',raw)===true){legacyError='';return [];}
        const value=JSON.parse(raw==null?'[]':raw);
        if(!Array.isArray(value)||value.some(item=>!item||typeof item!=='object'||Array.isArray(item)))throw Error('invalid legacy archive');
        legacyError='';return value;
      }catch(_){legacyError='本机旧告警格式异常，原内容保留；请先预览修复迁移源';return [];}
    }
    async function load({fresh=false}={}){
      const key=scopeKey();
      if(flight){if(!fresh)return flight;await flight;if(key!==scopeKey())return {success:false,error:'服务器已切换'};}
      const operation=(async()=>{
        let result;try{result=await repository.list();}catch(error){result={success:false,error:error.message||String(error)};}
        if(disposed||key!==scopeKey())return {success:false,error:'服务器已切换'};
        if(!result.success){readError=result.error||'服务器告警读取失败';global.renderLog?.();global.updateAlertArchiveStatus?.();return result;}
        readError='';
        const legacy=legacyRecords(),remote=new Map(result.records.map(item=>[item.archiveId,item]));
        const unresolved=legacy.filter(item=>!item.archiveId||!same(remote.get(item.archiveId),item));
        adoptionError=legacyError||(unresolved.length?'本机仍有 '+unresolved.length+' 条旧告警尚未迁移；服务器查询不覆盖旧存储':'');
        loaded=true;global.renderLog?.();global.updateAlertArchiveStatus?.();return {...result,migrationRequired:unresolved.length>0};
      })().finally(()=>{if(flight===operation)flight=null;});flight=operation;return operation;
    }
    function records(){
      if(!loaded)return legacyRecords();
      // Preserve yet-unmigrated local records visibly without pretending they
      // came from the database. The existing status label identifies this mode.
      const map=new Map(repository.records().map(item=>[item.archiveId,item]));
      if(adoptionError)for(const [index,item]of legacyRecords().entries())if(!same(map.get(item.archiveId),item))map.set(item.archiveId||'legacy:'+index,item);
      return [...map.values()].map(copy);
    }
    async function flush(records){
      if(clearSession||flushFlight)return {success:false,status:'busy',code:'ALERT_ARCHIVE_BUSY',error:'正在核对或清空告警；待存记录保留'};
      const operation=(async()=>{
        const result=await repository.flush(records);if(!result.success)return result;
        const loadedResult=await load({fresh:true});
        return {...result,count:repository.records().length,readBackConfirmed:loadedResult.success===true};
      })();flushFlight=operation;
      try{return await operation;}finally{if(flushFlight===operation)flushFlight=null;}
    }
    async function prepareClear(){
      if(clearSession)throw Error('已有告警清理正在核对');
      const session={key:scopeKey(),token:null,snapshot:null,local:null};clearSession=session;
      try{
        if(flushFlight)await flushFlight;
        if(disposed||session.key!==scopeKey())throw Error('服务器已切换，请重新核对清理范围');
        if(batch.snapshot().unknown)throw Error('上一笔告警事务尚未核对回执，不能清空');
        const result=await load({fresh:true});if(!result.success)throw Error(result.error||'服务器告警尚未读取');
        if(disposed||session.key!==scopeKey())throw Error('服务器已切换，请重新核对清理范围');
        if(legacyError||adoptionError)throw Error(legacyError||'旧告警尚未迁移，不能把本机清空当作数据库清空；请先完成迁移');
        session.snapshot=repository.captureClear();session.local=storage.getItem('daty_db_alerts');
        session.token=Object.freeze({count:session.snapshot.targets.length});return session.token;
      }catch(error){if(clearSession===session)clearSession=null;throw error;}
    }
    function cancelClear(token){if(clearSession?.token===token)clearSession=null;}
    async function clearAll(token){
      const session=clearSession;
      if((token!==undefined&&(!session||session.token!==token))||(session&&(session.token!==token||session.used)))throw Error('告警清理确认已失效，请重新打开');
      if(session&&(disposed||session.key!==scopeKey()||session.local!==storage.getItem('daty_db_alerts')))throw Error('服务器或告警存储已更新，请重新核对清理范围');
      if(session)session.used=true;
      if(batch.snapshot().unknown)throw Error('上一笔告警事务尚未核对回执，不能清空');
      legacyRecords();if(legacyError)throw Error(legacyError);
      const key=scopeKey();
      const originalLocal=storage.getItem('daty_db_alerts');
      if(!loaded){const result=await load();if(!result.success)throw Error(result.error);}
      if(adoptionError)throw Error('旧告警尚未迁移，不能把本机清空当作数据库清空；请先完成迁移');
      const ids=session?session.snapshot.targets.map(item=>item.id):repository.records().map(item=>item.archiveId);let changed=0;
      for(let index=0;index<ids.length;index+=200){
        const result=await repository.clear(ids.slice(index,index+200),session?.snapshot);
        if(key!==scopeKey())throw Error('服务器已切换；旧服务器删除结果需核对，未改新服务器缓存');
        if(!result.success){await load();throw Error('已标记删除 '+changed+' 条；其余未确认：'+result.error);}
        changed+=result.changed;
      }
      // The local mirror is refreshed only AFTER every database tombstone was
      // confirmed. Immutable database audit/source data is never deleted here.
      const result=await load({fresh:true});
      if(key!==scopeKey()||!result.success)throw Error('数据库删除已提交 '+changed+' 条，但列表未确认；原本机存储保留');
      if(storage.getItem('daty_db_alerts')!==originalLocal)throw Error('数据库删除已提交，但本机旧记录另有变化；未覆盖本机存储');
      storage.setItem('daty_db_alerts',JSON.stringify(repository.records()));
      adoptionError='';
      return changed;
    }
    async function reviewPending(){
      if(!batch.snapshot().unknown)return {status:'not-needed'};
      const key=scopeKey();
      if(typeof global.DatyDialogs?.confirm!=='function')return {status:'error',message:'缺少应用内核对确认能力'};
      const confirmed=await global.DatyDialogs.confirm({title:'只读核对上一笔告警事务',
        message:'上一笔告警保存或清理的数据库回复未确认。是否查询该笔操作的持久回执？',
        warnings:['本次只查询，不重发保存或清空、不清除待存记录、不操作接收机。','核对后重新读取当前版本；新的保存或清理需另行发起。'],
        confirmLabel:'确认只读核对',footnote:'取消保留未知事务保护'});
      if(confirmed!==true)return {status:'cancelled'};
      if(key!==scopeKey())return {status:'invalidated',message:'服务器或权限已变化'};
      const result=await repository.reconcile();
      if(key!==scopeKey())return {status:'invalidated',message:'旧服务器核对结果未应用'};
      if(result.status==='reconciled'){
        const current=await load({fresh:true});
        if(key!==scopeKey()||disposed)return {status:'invalidated',message:'旧服务器核对结果未应用'};
        if(!current.success)return {status:'error',message:'回执已核对，当前告警列表尚未确认：'+(current.error||'读取失败')};
      }
      return result;
    }
    function invalidate(){observedScope=scopeKey();repository.invalidate();flight=null;loaded=false;adoptionError='';readError='';global.renderLog?.();global.updateAlertArchiveStatus?.();}
    const unsubscribe=global.DatyDatabaseConnection.subscribe(()=>{if(scopeKey()!==observedScope){invalidate();void load().catch(()=>{});}});
    const api=Object.freeze({records,flush,load,prepareClear,cancelClear,clearAll,reviewPending,reconcile:()=>repository.reconcile(),
      status(){const state=batch.snapshot();return {loaded,readError,refreshing:!!flight,warning:legacyError||adoptionError,pending:state.pending||state.unknown};},
      dispose(){disposed=true;unsubscribe?.();repository.invalidate();}});
    global.DatyAlertDatabase=api;void load().catch(()=>{});return api;
  }
  root.DatyAlertDatabaseUI=Object.freeze({mount});
})(typeof globalThis!=='undefined'?globalThis:this);
