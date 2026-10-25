/* Real alert archive repository. No DOM, cache writes, clocks or device control.
 * A timer may start a NEW lifecycle update only after the last transaction is
 * known. Unknown outcomes are reconciled by GET; no POST is replayed here. */
(function(root,build){const api=build();if(typeof module==='object'&&module.exports)module.exports=api;else root.DatyAlertDatabaseFactory=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const copy=value=>JSON.parse(JSON.stringify(value));
  const same=(a,b)=>a===b||!!a&&!!b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)
    &&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
  function create({client,batchClient}){
    if(!client||!batchClient)throw TypeError('Alert database needs explicit resource and atomic batch ports');
    let busy=false,generation=0,cache=[],readSerial=0,listEpoch=null,lastAsOf=null;const knownHeads=new Map();
    const failure=(code,message,status='error')=>({success:false,status,code,error:message});
    function validate(record){
      if(!record||typeof record.archiveId!=='string'||!record.archiveId||!['active','ended'].includes(record.archiveState)
        ||!Number.isSafeInteger(record.firstSeen)||!Number.isSafeInteger(record.lastSeen)||record.firstSeen<0||record.lastSeen<record.firstSeen
        ||record.archiveState==='ended'&&(!Number.isSafeInteger(record.endedAt)||record.endedAt<record.firstSeen))throw Error('告警生命周期不完整，原记录保留');
      return copy(record);
    }
    function merge(previous,incoming){
      if(!previous)return incoming;
      if(previous.firstSeen!==incoming.firstSeen||previous.deviceId!==incoming.deviceId||previous.metric!==incoming.metric)throw Error('告警 ID 的接收机或生命周期冲突');
      if(previous.archiveState==='ended'&&incoming.archiveState==='active')return previous;
      if((previous.endedAt||previous.lastSeen)>(incoming.endedAt||incoming.lastSeen))return previous;
      return {...previous,...incoming,lastSeen:Math.max(previous.lastSeen,incoming.lastSeen)};
    }
    async function list(){
      const ticket=generation,serial=++readSerial,since=lastAsOf;
      const rows=new Map(since===null?[]:cache.map(row=>[row.archiveId,row])),heads=new Map(since===null?[]:knownHeads),seen=new Set(),cursors=new Set();
      let cursor=null,epoch=null,asOf=null;
      for(let page=0;page<1000;page++){
        const result=await client.list('alerts',{limit:200,cursor,...(since===null?{}:{since,sinceEpoch:listEpoch})});
        if(ticket!==generation||serial!==readSerial)return failure('SCOPE_CHANGED','服务器或读取批次已切换','invalidated');
        if(result.status!=='ready'){
          if(['EPOCH_CHANGED','DATABASE_EPOCH_CHANGED'].includes(result.code)){lastAsOf=null;listEpoch=null;cache=[];knownHeads.clear();}
          return failure(result.code||result.status,result.message||'告警数据库未读取',result.status);
        }
        if(since!==null&&(result.epoch!==listEpoch||result.asOf<since)){
          lastAsOf=null;listEpoch=null;cache=[];knownHeads.clear();return failure('EPOCH_CHANGED','告警数据库已变化，请重新读取');
        }
        if(epoch!==null&&(epoch!==result.epoch||asOf!==result.asOf))return failure('SNAPSHOT_CHANGED','告警列表快照已变化');
        epoch=result.epoch;asOf=result.asOf;
        for(const row of result.resources){if(seen.has(row.id))return failure('DUPLICATE_ALERT','告警列表重复');seen.add(row.id);heads.set(row.id,row.revision);if(row.deleted)rows.delete(row.id);else{const value=validate(row.value);if(value.archiveId!==row.id)return failure('INVALID_ALERT_ID','告警身份不一致');rows.set(row.id,value);}}
        if(result.cursor===null){cache=[...rows.values()].sort((a,b)=>b.firstSeen-a.firstSeen||a.archiveId.localeCompare(b.archiveId));listEpoch=epoch;lastAsOf=asOf;knownHeads.clear();for(const [id,revision]of heads)knownHeads.set(id,revision);return {success:true,records:copy(cache),epoch};}
        if(cursors.has(result.cursor))return failure('INVALID_CURSOR','告警分页游标重复');cursors.add(result.cursor);cursor=result.cursor;
      }
      return failure('ARCHIVE_PAGE_LIMIT','告警记录过多，需要服务端分页视图；未采用部分结果');
    }
    async function flush(input){
      if(busy)return failure('ALERT_ARCHIVE_BUSY','上一笔告警归档仍在处理中','busy');
      if(batchClient.snapshot?.().unknown)return failure('ALERT_RECONCILE_REQUIRED','上一笔告警事务尚未核对回执；待存记录保留','unknown');
      busy=true;const ticket=generation;
      try{
        if(!Array.isArray(input)||input.length>200)return failure('ALERT_BATCH_LIMIT','每笔归档最多 200 个生命周期');
        const records=input.map(validate),ids=new Set(),writes=[],confirmed=[];
        for(const record of records){
          if(ids.has(record.archiveId))return failure('DUPLICATE_ALERT','告警批次出现重复 ID');ids.add(record.archiveId);
          const ready=await client.load('alerts',record.archiveId);
          if(ticket!==generation)return failure('SCOPE_CHANGED','服务器已变化','invalidated');
          if(ready.status!=='ready')return failure(ready.code||ready.status,ready.message||'告警基线未读取',ready.status);
          // Explicit user deletion is a tombstone. A stale browser cannot revive
          // that lifecycle; a genuinely NEW alert has its own new archive ID.
          if(ready.resource?.deleted){confirmed.push({id:record.archiveId,snapshot:record,superseded:true});continue;}
          const value=merge(ready.resource?.value,record);
          confirmed.push({id:record.archiveId,snapshot:record,superseded:!same(value,record)});
          if(!same(value,ready.resource?.value))writes.push({kind:'alerts',id:record.archiveId,value});
        }
        if(writes.length){
          const result=await batchClient.save(writes);
          if(result.status!=='saved')return failure(result.code||result.status,result.message||'数据库尚未确认告警归档；待存保留',result.status);
          readSerial++;for(const row of result.resources)knownHeads.set(row.id,row.revision);
        }
        if(ticket!==generation)return failure('SCOPE_CHANGED','旧服务器可能已保存，请先核对','invalidated');
        return {success:true,changed:writes.length,confirmed};
      }catch(error){return failure(error.code||'ALERT_ARCHIVE_FAILED',error.message);}
      finally{busy=false;}
    }
    function captureClear(){return {epoch:listEpoch,targets:cache.map(item=>({id:item.archiveId,revision:knownHeads.get(item.archiveId)}))};}
    async function clear(ids,snapshot=null){
      if(busy)return failure('ALERT_ARCHIVE_BUSY','归档正在进行','busy');
      if(batchClient.snapshot?.().unknown)return failure('ALERT_RECONCILE_REQUIRED','上一笔告警事务尚未核对，不能清空','unknown');
      busy=true;const ticket=generation;
      try{
        if(!Array.isArray(ids)||ids.length>200||!ids.length)return failure('ALERT_DELETE_LIMIT','一次明确删除 1 至 200 条历史');
        const writes=[];
        for(const id of new Set(ids)){
          const baseline=snapshot?snapshot.targets.find(item=>item.id===id)?.revision:knownHeads.get(id);
          if(snapshot&&baseline===undefined)return failure('ALERT_DELETE_CONFLICT','告警不在本次确认范围内，未删除','conflict');
          const result=await client.load('alerts',id);
          if(ticket!==generation)return failure('SCOPE_CHANGED','服务器已切换','invalidated');
          if(result.status!=='ready')return failure(result.code||result.status,'告警删除基线未读取',result.status);
          if(snapshot&&result.epoch!==snapshot.epoch)return failure('ALERT_DELETE_CONFLICT','服务器数据库已变化，请重新核对清理范围','conflict');
          if(baseline!==undefined&&baseline!==(result.resource?.revision||0))return failure('ALERT_DELETE_CONFLICT','告警在确认后已有新版本，未删除','conflict');
          if(result.resource&&!result.resource.deleted)writes.push({kind:'alerts',id,value:null,deleted:true});
        }
        if(!writes.length)return {success:true,changed:0};
        const result=await batchClient.save(writes);
        if(result.status!=='saved')return failure(result.code||result.status,result.message||'数据库未确认删除（'+(result.code||result.status)+'）',result.status);
        if(ticket!==generation)return failure('SCOPE_CHANGED','旧服务器删除可能已完成，请先核对','invalidated');
        readSerial++;for(const row of result.resources)knownHeads.set(row.id,row.revision);
        return {success:true,changed:writes.length};
      }catch(error){return failure(error.code||'ALERT_DELETE_FAILED',error.message||'告警删除结果未确认');}
      finally{busy=false;}
    }
    function invalidate(){generation++;readSerial++;cache=[];listEpoch=null;lastAsOf=null;knownHeads.clear();client.invalidate();batchClient.invalidate();}
    return Object.freeze({list,flush,clear,captureClear,invalidate,records:()=>copy(cache),reconcile:()=>batchClient.reconcile(),get busy(){return busy;}});
  }
  return Object.freeze({create});
});
