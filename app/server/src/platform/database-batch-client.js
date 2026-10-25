/* Candidate atomic batch adapter. The private scalar client is only a durable
 * transaction journal state machine; it never represents a business resource.
 * No synthetic business value escapes as a database result. */
(function(root, build) {
  const factory=build();
  if(typeof module==='object'&&module.exports)module.exports=factory;else root.DatyDatabaseBatchFactory=factory;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const PROTOCOL='daty-business-db-v1', PRIVATE_KIND='batch_journal', PRIVATE_ID='pending-batch';
  const copy=value=>JSON.parse(JSON.stringify(value));
  const same=(a,b)=>a===b||!!a&&!!b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)
    &&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.prototype.hasOwnProperty.call(b,key)&&same(a[key],b[key]));
  function create(ports){
    const scalarFactory=ports?.factory||(typeof module==='object'&&module.exports?require('./database-client.js'):globalThis.DatyDatabaseClientFactory);
    if(!scalarFactory||!ports?.resourceClient||typeof ports.request!=='function')throw TypeError('Batch client requires scalar factory, resourceClient and host ports');
    const privateId=ports.journalId??PRIVATE_ID;
    if(typeof privateId!=='string'||!privateId.trim()||privateId.length>128||/[\u0000-\u001f\u007f]/.test(privateId))throw TypeError('Batch journalId must be stable non-secret text');
    let active=false;
    function syntheticResource(writes){return {kind:PRIVATE_KIND,id:privateId,revision:1,value:{writes},deleted:false};}
    function serverOrigin(scope){const url=new URL(scope.baseUrl);if(url.hostname==='localhost'&&url.port==='8802')url.hostname='127.0.0.1';return url.origin;}
    function verifiedResources(resources,writes){
      return Array.isArray(resources)&&resources.length===writes.length&&resources.every((item,index)=>{
        const expected=writes[index];return item?.kind===expected.kind&&item.id===expected.id&&item.revision===expected.expected_revision+1
          &&item.deleted===expected.deleted&&same(item.value,expected.value);
      });
    }
    function pendingWrites(){
      const scope=ports.readScope(),url=new URL(scope.baseUrl);if(url.hostname==='localhost'&&url.port==='8802')url.hostname='127.0.0.1';
      const key=scalarFactory.JOURNAL_PREFIX+encodeURIComponent(JSON.stringify([url.origin,scope.principalId,PRIVATE_KIND,privateId]));
      const value=JSON.parse(ports.storage.getItem(key)||'null');return value?.body?.value?.writes;
    }
    const wrapped={...ports,request(url,options){
      const parsed=new URL(url),path=parsed.pathname;
      if(path===`/api/database/resources/${PRIVATE_KIND}/${encodeURIComponent(privateId)}`){
        // Only the journal's empty coordination slot is synthetic. Epoch was
        // obtained from the real authorized status request just before this.
        return Promise.resolve({status:404,json:async()=>({success:false,protocol:PROTOCOL,epoch:statusEpoch})});
      }
      let writes, forwarded=options;
      if(path==='/api/database/write'){
        const body=JSON.parse(options.body);writes=body.value.writes;
        parsed.pathname='/api/database/batch';forwarded={...options,body:JSON.stringify({operation_id:body.operation_id,epoch:body.epoch,writes})};
      }else if(path.startsWith('/api/database/operations/'))writes=pendingWrites();
      const response=ports.request(url===parsed.href?url:parsed.href,forwarded);
      return Promise.resolve(response).then(reply=>({status:reply.status,ok:reply.ok,json:async()=>{
        const body=await reply.json();
        if(path==='/api/database/status'&&body?.success===true&&body.protocol===PROTOCOL)statusEpoch=body.epoch;
        if(!writes||body?.success!==true)return body;
        const items=path==='/api/database/write'?body.resources:body.operation?.resources;
        if(!verifiedResources(items,writes))throw Object.assign(Error('Atomic batch receipt differs from the exact ordered writes'),{code:'BATCH_RECEIPT_MISMATCH'});
        return path==='/api/database/write'?{...body,resource:syntheticResource(writes)}
          :{...body,operation:{...body.operation,resource:syntheticResource(writes)}};
      }}));
    }};
    // Preserve host ownership rather than borrowing methods with wrapped this.
    for(const name of ['readScope','schedule','cancel','newOperationId'])if(typeof ports[name]==='function')wrapped[name]=(...args)=>ports[name](...args);
    let statusEpoch=null;const journal=scalarFactory.create(wrapped);
    async function save(inputs){
      if(active)return {status:'busy',code:'BATCH_BUSY'};
      active=true;
      try{
        if(!Array.isArray(inputs)||!inputs.length||inputs.length>200)return {status:'error',code:'INVALID_BATCH'};
        const scope=ports.readScope(),seen=new Set(),writes=[];
        for(const item of inputs){
          const key=JSON.stringify([item?.kind,item?.id]);if(seen.has(key))return {status:'error',code:'DUPLICATE_BATCH_TARGET'};seen.add(key);
          const state=ports.resourceClient.snapshot(item.kind,item.id);
          if(!state.loaded||state.pending||state.scope?.baseUrl!==serverOrigin(scope)||state.scope?.principalId!==scope.principalId||state.scope?.accessRevision!==scope.accessRevision)return {status:'unloaded',code:'BATCH_LOAD_REQUIRED'};
          if(item.deleted!==undefined&&typeof item.deleted!=='boolean')return {status:'error',code:'INVALID_BATCH'};
          writes.push({kind:item.kind,id:item.id,expected_revision:state.resource?.revision||0,value:scalarFactory.copyBusinessValue(item.value),deleted:item.deleted===true});
        }
        const ready=await journal.load(PRIVATE_KIND,privateId);if(ready.status!=='ready')return ready;
        // Baselines must belong to the exact status epoch returned for this batch.
        if(inputs.some((item,index)=>{const state=ports.resourceClient.snapshot(item.kind,item.id);return !state.loaded||state.pending||state.epoch!==ready.epoch
          ||state.scope?.baseUrl!==serverOrigin(scope)||state.scope?.principalId!==scope.principalId||state.scope?.accessRevision!==scope.accessRevision
          ||(state.resource?.revision||0)!==writes[index].expected_revision;}))return {status:'conflict',code:'BATCH_BASELINE_CHANGED'};
        const result=await journal.save(PRIVATE_KIND,privateId,{writes});
        if(result.status==='saved'){
          const confirmed=result.resource.value.writes;
          return {status:'saved',epoch:result.epoch,operationId:result.operationId,
            resources:confirmed.map(item=>({kind:item.kind,id:item.id,revision:item.expected_revision+1,value:copy(item.value),deleted:item.deleted})),reloadRequired:true};
        }
        return result;
      }catch(error){return {status:'error',code:error.code||'BATCH_FAILED',message:error.message};}
      finally{active=false;}
    }
    async function reconcile(){
      if(active)return {status:'busy',code:'BATCH_BUSY'};active=true;
      try{
        const result=await journal.reconcile(PRIVATE_KIND,privateId);
        if(result.status!=='reconciled')return result;
        return {status:'reconciled',epoch:result.epoch,operationId:result.operationId,reloadRequired:true,
          resources:result.resource.value.writes.map(item=>({kind:item.kind,id:item.id,revision:item.expected_revision+1,value:copy(item.value),deleted:item.deleted}))};
      }finally{active=false;}
    }
    return Object.freeze({save,reconcile,snapshot:()=>journal.snapshot(PRIVATE_KIND,privateId),invalidate:()=>journal.invalidate()});
  }
  return Object.freeze({PROTOCOL,create});
});
