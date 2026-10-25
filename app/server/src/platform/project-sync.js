/* C2 candidate, not loaded by the production page. Host-owned HTTP only.
 * The editing baseline is established by load(), never by save()'s latest GET.
 * One operation at a time; POST is never retried or replayed by this controller.
 */
(function(root,makeFactory){
  'use strict';
  const factory=makeFactory();
  if(typeof module==='object' && module.exports)module.exports=factory;
  else root.DatyProjectSyncFactory=factory;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const VERSION='daty-project-sync-v1',PROTOCOL='daty-project-revision-v1',TIMEOUT_MS=5000;
  const KNOWN_UNSENT=Symbol('synchronous-host-refusal');
  const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  const same=(left,right)=>{
    if(left===right)return true;
    if(!left || !right || typeof left!=='object' || typeof right!=='object'
      || Array.isArray(left)!==Array.isArray(right))return false;
    const keys=Object.keys(left);
    return keys.length===Object.keys(right).length && keys.every(key=>own(right,key)&&same(left[key],right[key]));
  };
  function failure(code,message,extra={}){return Object.assign(new Error(message),{code,...extra});}
  function scopeValue(value){
    if(!value || typeof value!=='object' || typeof value.baseUrl!=='string'
      || typeof value.projectId!=='string' || !value.projectId.trim()
      || !(Number.isSafeInteger(value.accessRevision)&&value.accessRevision>=0
        || typeof value.accessRevision==='string'&&value.accessRevision.length>0)){
      throw failure('INVALID_SCOPE','项目同步需要服务器、项目和权限代次');
    }
    let url;try{url=new URL(value.baseUrl);}catch(_){throw failure('INVALID_SCOPE','项目服务器地址无效');}
    if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash){
      throw failure('INVALID_SCOPE','项目同步仅允许不含凭据和路径的 HTTPS 服务根地址');
    }
    if(url.hostname==='localhost'&&url.port==='8802')url.hostname='127.0.0.1';
    return {baseUrl:url.origin,projectId:value.projectId,accessRevision:value.accessRevision};
  }
  const scopeKey=scope=>JSON.stringify([scope.baseUrl,scope.projectId]);
  const sameScope=(a,b)=>!!a&&!!b&&a.baseUrl===b.baseUrl&&a.projectId===b.projectId&&a.accessRevision===b.accessRevision;
  function create(ports){
    if(!ports || ['request','readScope','schedule','cancel'].some(name=>typeof ports[name]!=='function')
      || !ports.concurrency || typeof ports.concurrency.prepareSave!=='function'
      || typeof ports.concurrency.mergeProject!=='function' || ports.concurrency.PROTOCOL!==PROTOCOL){
      throw new TypeError('DatyProjectSync: request/readScope/schedule/cancel/concurrency ports are required');
    }
    const concurrency=ports.concurrency;
    let scope=null,baseline,active=null,generation=0,status='unloaded';
    // An unknown POST cannot be forgotten by reload, invalidate, reauthorization
    // or switching away and back to a project inside this controller instance.
    const uncertain=new Map();
    function readScope(){return scopeValue(ports.readScope());}
    function current(ticket){
      if(active!==ticket || ticket.generation!==generation)return false;
      try{return sameScope(ticket.scope,readScope());}catch(_){return false;}
    }
    function assertCurrent(ticket){if(!current(ticket))throw failure('SCOPE_CHANGED','项目或权限已改变，旧操作已失效');}
    function invalidate(){
      generation++;baseline=undefined;scope=null;status='unloaded';
      const previous=active;active=null;
      previous?.interrupt?.(failure('SCOPE_CHANGED','项目同步操作已取消'));
    }
    function synchronizeScope(){
      const next=readScope();
      if(!sameScope(scope,next)){invalidate();scope=next;}
      return scope;
    }
    function unknownResult(record){
      return {status:'unknown',code:'PREVIOUS_POST_UNCONFIRMED',phase:record.phase,
        scope:clone(scope),expectedRevision:record.body.expected_revision,
        projectSaved:record.phase==='run',runStatus:record.phase==='run'?'unknown':'not-sent'};
    }
    function snapshot(){
      try{synchronizeScope();}catch(_){invalidate();}
      const record=scope?uncertain.get(scopeKey(scope)):null;
      return {VERSION,status:record?'unknown':status,scope:clone(scope),project:clone(baseline),
        loaded:baseline!==undefined,pending:active?.kind||null,
        unknown:record?{phase:record.phase,expectedRevision:record.body.expected_revision,
          projectSaved:record.phase==='run'}:null};
    }
    function projectCopy(value){
      if(value===null)return null;
      // Reuse the strict JSON/accessor/identity/history validation before cloning.
      const checked=concurrency.mergeProject({base:null,desired:value,remote:null});
      if(checked.status!=='ready')throw failure('INVALID_PROJECT','项目快照无效');
      const result=clone(value);
      // SQLite GET orders rows by device_id. Normalize only this identity set;
      // history/other arrays retain their original, meaningful display order.
      result.devices.sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);
      return result;
    }
    function publicProject(value,expectedId){
      if(!value || value.id!==expectedId || !Number.isSafeInteger(value.revision) || value.revision<1){
        throw failure('INVALID_SERVER_PROJECT','服务器项目 ID 或 revision 无效');
      }
      if(value.revision_protocol!==undefined && value.revision_protocol!==PROTOCOL){
        throw failure('PROJECT_REVISION_UNSUPPORTED','服务器项目版本协议不匹配');
      }
      return {...projectCopy(value),revision_protocol:PROTOCOL};
    }
    function requestJson(ticket,url,options={},onSend=()=>{},onRefusal=()=>{}){
      assertCurrent(ticket);
      const controller=new AbortController(),cancelTimer=ports.cancel;
      let timer,finished=false,httpStatus;
      return new Promise((resolve,reject)=>{
        const finish=(error,value)=>{
          if(finished)return;finished=true;
          if(ticket.interrupt===interrupt)ticket.interrupt=null;
          try{if(timer!==undefined)cancelTimer.call(ports,timer);}catch(cancelError){error=error||cancelError;}
          if(error)reject(error);else resolve(value);
        };
        const interrupt=error=>{controller.abort();finish(error);};
        ticket.interrupt=interrupt;
        try{
          timer=ports.schedule(()=>interrupt(failure('REQUEST_TIMEOUT','项目请求超过 5 秒，结果未确认',{httpStatus})),TIMEOUT_MS);
          if(timer===undefined || timer===null || typeof timer?.then==='function'){
            if(typeof timer?.then==='function')Promise.resolve(timer).catch(()=>{});
            throw failure('INVALID_TIMER','宿主计时器必须同步返回可取消句柄');
          }
        }catch(error){finish(error);return;}
        Promise.resolve().then(()=>{
          if(finished)throw failure('REQUEST_TIMEOUT','请求在发送前已超时');
          assertCurrent(ticket);onSend();
          try{return ports.request(url,{...options,redirect:'error',signal:controller.signal});}
          catch(error){
            if(error?.knownUnsent===true){
              onRefusal('known-unsent');
              throw failure('REQUEST_NOT_SENT',error.message||'宿主确认请求未发送',{[KNOWN_UNSENT]:true});
            }
            throw error;
          }
        }).then(response=>{
          // DatyAccess may revoke its own generation before returning this 401.
          // Its status is still proof that THIS request was refused, even after
          // our scope/timer was invalidated. Only its private write record may
          // be released; never alter a newer scope, baseline or access session.
          if(response && (response.status===401 || response.status===403)){
            onRefusal(response.status);
            if(finished)return;
            throw failure('UNAUTHORIZED','项目同步权限已失效',{httpStatus:response.status});
          }
          if(finished)return;
          assertCurrent(ticket);
          if(!response || !Number.isInteger(response.status) || typeof response.json!=='function'){
            throw failure('INVALID_RESPONSE','项目响应格式无效');
          }
          httpStatus=response.status;
          return Promise.resolve(response.json()).then(body=>({response,body}));
        }).then(value=>{
          if(finished)return;
          assertCurrent(ticket);finish(null,value);
        }).catch(error=>{
          if(error && error.httpStatus===undefined && httpStatus!==undefined)error.httpStatus=httpStatus;
          finish(error);
        });
      });
    }
    async function readRemote(ticket){
      const {response,body}=await requestJson(ticket,
        `${ticket.scope.baseUrl}/api/projects/${encodeURIComponent(ticket.scope.projectId)}`,{cache:'no-store'});
      assertCurrent(ticket);
      const protocol=body?.revision_protocol??body?.project?.revision_protocol;
      if(protocol!==PROTOCOL)return {status:'unsupported',code:'PROJECT_REVISION_UNSUPPORTED'};
      if(response.status===404){
        if(body?.revision_protocol!==PROTOCOL || body?.success!==false){
          throw failure('INVALID_SERVER_PROJECT','项目不存在的响应未提供有效版本协议');
        }
        return {status:'ready',project:null,protocol};
      }
      if(!response.ok || body?.success!==true)throw failure('PROJECT_READ_FAILED','服务器项目读取失败',{httpStatus:response.status});
      return {status:'ready',project:publicProject(body.project,ticket.scope.projectId),protocol};
    }
    function outcome(ticket,value){
      assertCurrent(ticket);status=value.status;return {...value,scope:clone(ticket.scope)};
    }
    function confirmedProject(body,responseBody){
      if(responseBody?.success!==true || responseBody.revision_protocol!==PROTOCOL
        || responseBody.project_id!==body.id || responseBody.revision!==body.expected_revision+1){
        throw failure('UNCONFIRMED_PROJECT_WRITE','服务器未确认匹配项目及预期 revision');
      }
      const {expected_revision,...value}=body;
      return {...projectCopy(value),revision:responseBody.revision,revision_protocol:PROTOCOL};
    }
    function errorResult(ticket,error){
      if(!current(ticket))return {status:'invalidated',code:'SCOPE_CHANGED',scope:clone(ticket.scope)};
      if(error?.code==='UNAUTHORIZED'){
        baseline=undefined;status='unauthorized';
        return {status,code:error.code,httpStatus:error.httpStatus,scope:clone(ticket.scope),projectSaved:false};
      }
      status='error';return {status,code:error?.code||'PROJECT_SYNC_FAILED',message:error?.message||String(error),scope:clone(ticket.scope)};
    }
    async function execute(kind,operation){
      let next;
      try{next=synchronizeScope();}catch(error){return {status:'error',code:error.code||'INVALID_SCOPE',message:error.message};}
      if(active)return {status:'busy',code:'PROJECT_SYNC_BUSY',scope:clone(next)};
      const record=uncertain.get(scopeKey(next));
      if(record&&kind!=='reconcile')return unknownResult(record);
      const ticket={kind,scope:clone(next),generation,interrupt:null};active=ticket;
      try{return await operation(ticket);}catch(error){return errorResult(ticket,error);}
      finally{if(active===ticket)active=null;}
    }
    function load(){return execute('load',async ticket=>{
      const remote=await readRemote(ticket);
      assertCurrent(ticket);
      if(remote.status!=='ready')return outcome(ticket,remote);
      baseline=remote.project;return outcome(ticket,{status:'loaded',project:clone(baseline),protocol:PROTOCOL});
    });}
    function save(desired,options={}){
      // Capture before the first await. Later UI edits cannot change this operation.
      let desiredCopy,run;
      try{
        desiredCopy=projectCopy(desired);
        if(!desiredCopy)throw failure('INVALID_PROJECT','保存项目不能为空');
        if(options.run!==undefined && options.run!==null){
          // Validate arbitrary run JSON using the same strict ordinary-data path.
          projectCopy({id:desiredCopy.id,name:desiredCopy.name,devices:[],data:{run:options.run}});
          run=clone(options.run);
          if(!run || typeof run!=='object' || Array.isArray(run))throw failure('INVALID_RUN','运行记录必须是完整对象');
          if(run.project_id!==undefined && run.project_id!==desiredCopy.id)throw failure('PROJECT_ID_MISMATCH','不能保存其他项目运行记录');
          run.project_id=desiredCopy.id;
        }
      }catch(error){return Promise.resolve({status:'error',code:error.code||'INVALID_PROJECT',message:error.message});}
      return execute('save',async ticket=>{
        if(baseline===undefined)return outcome(ticket,{status:'error',code:'BASELINE_REQUIRED',message:'编辑前必须先读取服务器项目基线'});
        if(desiredCopy.id!==ticket.scope.projectId)return outcome(ticket,{status:'error',code:'PROJECT_ID_MISMATCH'});
        const original=baseline,remote=await readRemote(ticket);
        if(remote.status!=='ready')return outcome(ticket,remote);
        const prepared=concurrency.prepareSave({base:original,desired:desiredCopy,remote:remote.project,protocol:remote.protocol});
        if(prepared.status!=='ready')return outcome(ticket,prepared);
        const body=clone(prepared.body),key=scopeKey(ticket.scope);
        const record={phase:'project',body,run,scope:clone(ticket.scope)};
        const refusal=phase=>httpStatus=>{
          if(uncertain.get(key)===record && record.phase===phase){
            record.refused=httpStatus;uncertain.delete(key);
          }
        };
        let sent=false,project;
        try{
          const {response,body:reply}=await requestJson(ticket,`${ticket.scope.baseUrl}/api/projects`,{
            method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
          },()=>{sent=true;uncertain.set(key,record);},refusal('project'));
          assertCurrent(ticket);
          if(!response.ok){
            if([400,404,409,422,428].includes(response.status)){
              uncertain.delete(key);
              return outcome(ticket,{status:response.status===409?'conflict':response.status===428?'unsupported':'error',
                code:reply?.code||'PROJECT_WRITE_REJECTED',httpStatus:response.status,projectSaved:false});
            }
            throw failure('UNCONFIRMED_PROJECT_WRITE','项目写入结果未确认',{httpStatus:response.status});
          }
          project=confirmedProject(body,reply);
          assertCurrent(ticket);
          baseline=project;uncertain.delete(key);
        }catch(error){
          if(error[KNOWN_UNSENT]){
            if(!current(ticket))return {status:'invalidated',code:'REQUEST_NOT_SENT',scope:clone(ticket.scope),knownUnsent:true,projectSaved:false};
            return outcome(ticket,{status:'error',code:'REQUEST_NOT_SENT',knownUnsent:true,projectSaved:false});
          }
          if(!current(ticket))return {status:'invalidated',code:error.code==='UNAUTHORIZED'?'UNAUTHORIZED':'SCOPE_CHANGED',
            scope:clone(ticket.scope),...(error.code==='UNAUTHORIZED'?{httpStatus:error.httpStatus,projectSaved:false,writeRejected:true}:{})};
          if(error.code==='UNAUTHORIZED'){
            if(sent && uncertain.get(key)===record)uncertain.delete(key);
            return errorResult(ticket,error);
          }
          if(sent)return outcome(ticket,{...unknownResult(record),code:error.code||'UNCONFIRMED_PROJECT_WRITE'});
          throw error;
        }
        if(run===undefined)return outcome(ticket,{status:'saved',project:clone(project),revision:project.revision,projectSaved:true});
        // The project transaction is already confirmed. A run is a separate POST
        // and never makes a partially saved operation look wholly successful.
        record.phase='run';let runSent=false;
        try{
          const {response,body:reply}=await requestJson(ticket,`${ticket.scope.baseUrl}/api/coordination-runs`,{
            method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(run)
          },()=>{runSent=true;uncertain.set(key,record);},refusal('run'));
          assertCurrent(ticket);
          if(!response.ok || reply?.success!==true){
            if(response.status>=500)throw failure('UNCONFIRMED_RUN_WRITE','运行记录结果未确认');
            uncertain.delete(key);
            return outcome(ticket,{status:'partial',project:clone(project),revision:project.revision,projectSaved:true,runStatus:'failed'});
          }
          if(typeof reply.run_id!=='string' || !reply.run_id.trim()
            || reply.project_id!==undefined && reply.project_id!==ticket.scope.projectId){
            throw failure('UNCONFIRMED_RUN_WRITE','服务器未确认运行记录标识');
          }
          uncertain.delete(key);
          return outcome(ticket,{status:'saved',project:clone(project),revision:project.revision,
            projectSaved:true,runStatus:'saved',runId:reply.run_id});
        }catch(error){
          if(error[KNOWN_UNSENT]){
            if(!current(ticket))return {status:'invalidated',code:'REQUEST_NOT_SENT',scope:clone(ticket.scope),knownUnsent:true,projectSaved:true,runStatus:'not-sent'};
            return outcome(ticket,{status:'partial',code:'REQUEST_NOT_SENT',project:clone(project),revision:project.revision,
              knownUnsent:true,projectSaved:true,runStatus:'not-sent'});
          }
          if(!current(ticket))return {status:'invalidated',code:'SCOPE_CHANGED',scope:clone(ticket.scope),
            projectSaved:true,runStatus:runSent?'unknown':'not-sent'};
          if(error.code==='UNAUTHORIZED'){
            if(uncertain.get(key)===record)uncertain.delete(key);baseline=undefined;
            return outcome(ticket,{status:'partial',code:'UNAUTHORIZED',project:clone(project),revision:project.revision,
              projectSaved:true,runStatus:'failed',httpStatus:error.httpStatus});
          }
          return outcome(ticket,{status:'partial',code:error.code||'RUN_WRITE_FAILED',project:clone(project),revision:project.revision,
            projectSaved:true,runStatus:runSent?'unknown':'not-sent',blocked:runSent});
        }
      });
    }
    function reconcile(){return execute('reconcile',async ticket=>{
      const key=scopeKey(ticket.scope),record=uncertain.get(key);
      if(!record)return outcome(ticket,{status:'error',code:'NO_UNKNOWN_WRITE',message:'当前没有待核对的未知写入'});
      const remote=await readRemote(ticket);
      assertCurrent(ticket);
      if(uncertain.get(key)!==record)return outcome(ticket,{status:'error',code:'POST_REJECTED',
        httpStatus:record.refused,projectSaved:record.phase==='run'});
      if(remote.status!=='ready' || !remote.project){
        return outcome(ticket,{...unknownResult(record),code:'RECONCILIATION_UNPROVEN'});
      }
      const expected=record.body,observed=remote.project;
      const exact=observed.revision===expected.expected_revision+1
        && same(observed.id,expected.id)&&same(observed.name,expected.name)
        && same(observed.data,expected.data)&&same(observed.devices,expected.devices);
      if(!exact)return outcome(ticket,{...unknownResult(record),code:'RECONCILIATION_UNPROVEN'});
      if(record.phase==='run')return outcome(ticket,{status:'partial',code:'RUN_RECONCILIATION_UNAVAILABLE',
        projectSaved:true,runStatus:'unknown',blocked:true,project:clone(observed)});
      baseline=observed;uncertain.delete(key);
      return outcome(ticket,{status:record.run===undefined?'saved':'partial',project:clone(observed),revision:observed.revision,
        projectSaved:true,reconciled:true,...(record.run===undefined?{}:{runStatus:'not-sent'})});
    });}
    return Object.freeze({VERSION,load,save,reconcile,invalidate,snapshot});
  }
  return Object.freeze({VERSION,PROTOCOL,TIMEOUT_MS,create});
});
