'use strict';
const {route}=require('../mqtt-stage4/database-port.cjs');
// Same request/response shape for original server-storage and data repositories.
// The HTTPS URL is only a logical route: all network calls below are MQTT.
// Host still owns scope/epoch, confirmations, pending-operation storage and file UI.
function storagePort({client,files,sha256,uuid,baseUrl}) {
  const base=new URL(baseUrl),encoder=new TextEncoder();let queue=Promise.resolve();
  if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash||client.mode!=='files')throw Error('Invalid file server');
  const source=raw=>({size:raw.length,sha256:()=>sha256(raw),read:async(o,n)=>raw.subarray(o,o+n)});
  const response=(body,status=200)=>({status,ok:status>=200&&status<300,json:async()=>body,text:async()=>JSON.stringify(body)});
  async function resolve(result,signal){
    if(result?.status!=='download_required')return result;
    if(result.encoding!=='json-utf8'||result.transfer.bytes>64*1024*1024)throw Error('Invalid large response');
    const bytes=new Uint8Array(result.transfer.bytes);let committed=false;
    await files.download({descriptor:result.transfer,signal,sink:{write:async(o,raw)=>bytes.set(raw,o),sha256:()=>sha256(bytes),
      size:async()=>bytes.length,commit:async()=>{committed=true;}}});
    if(!committed)throw Error('Large response not verified');
    // Explicitly release this internal response snapshot after verified use.
    await client.call('downloads.close',{download_id:result.transfer.id});
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }
  async function run(input,options,check){
    check();const url=new URL(input),verb=options.method||'GET',signal=options.signal;
    if(url.origin!==base.origin||url.username||url.password||url.hash)throw Error('SERVER_CHANGED');
    const path=url.pathname,body=verb==='POST'?JSON.parse(options.body):null;
    let result,method,args;
    const match=path.match(/^\/api\/database\/(archives|exports|archive-cleanups)(?:\/([A-Za-z0-9_-]{16,80}))?(?:\/(commit))?$/);
    if(path==='/api/database/storage-status'&&verb==='GET'&&!url.search)result=await client.call('storage.status',{});
    else if(match&&!url.search){
      const [,category,id,commit]=match,key=category==='archive-cleanups'?'cleanups':category;
      if(verb==='GET'&&!commit){method=key+'.'+(id?'get':'list');args=id?{id}:{};}
      else if(verb==='POST'&&key==='exports'&&!id){
        if(Object.keys(body).some(k=>!['operation_id','text','fileName','mimeType','source'].includes(k)))throw Error('Invalid export fields');
        if(typeof body.text!=='string'||!body.operation_id)throw Error('Export intent required');
        const raw=encoder.encode(body.text),uploadId='m5upload_'+await sha256(encoder.encode(body.operation_id));
        const uploaded=await files.upload({id:uploadId,source:source(raw),signal,allowConsumed:true});check();
        method='exports.create';args={operation_id:body.operation_id,upload_id:uploadId,sha256:uploaded.sha256,
          fileName:body.fileName,mimeType:body.mimeType,source:body.source||'application-export'};
      } else if(verb==='POST'&&key==='archives'&&!id){method='archives.create';args=body;}
      else if(verb==='POST'&&key==='cleanups'&&!id){method='cleanups.prepare';args=body;}
      else if(verb==='POST'&&key==='cleanups'&&id&&commit){
        method='cleanups.commit';args={operation_id:'m5cleanup_'+await sha256(encoder.encode(id)),cleanup_id:id,...body};
      }else throw Error('FILE_ROUTE_NOT_SUPPORTED');
      check();result=await resolve(await client.call(method,args),signal);check();
      if(method.endsWith('.create')||method==='cleanups.prepare'||method==='cleanups.commit'){
        if(result.state!=='completed'||!result.result)throw Error('OUTCOME_UNKNOWN_QUERY_ONLY');
        if(method==='exports.create')await client.call('uploads.release',{upload_id:args.upload_id,sha256:args.sha256,consumed:true}).catch(()=>{});
        result=result.result;
      }
      result=method.endsWith('.list')?result:{record:result};
    } else {
      const mapped=route(url,verb),value=verb==='POST'?body:mapped.body;
      if(verb==='POST'&&mapped.method!=='database.import.preview'&&(!value?.operation_id||!value?.epoch))throw Error('OPERATION_AND_EPOCH_REQUIRED');
      const raw=encoder.encode(JSON.stringify({method:mapped.method,body:value})),id=uuid();
      const uploaded=await files.upload({id,source:source(raw),mediaType:'application/json',signal});check();
      const domain=await resolve(await client.call('data.invoke',{upload_id:id,sha256:uploaded.sha256}),signal);check();
      if(!Number.isInteger(domain.status)||!domain.body)throw Error('INVALID_DATA_REPLY');
      // Domain outcome has been received and fully verified; release only this recipe's temporary bytes.
      if(domain.status<500)await client.call('uploads.release',{upload_id:id,sha256:uploaded.sha256,consumed:true}).catch(()=>{});
      return response(domain.body,domain.status);
    }
    check();return response({success:true,protocol:method?.startsWith('cleanups.')?'daty-archive-cleanup-v1':'daty-server-archive-v1',...result},
      ['queued','running'].includes(result?.record?.status)?202:200);
  }
  return function request(input,options={}) {
    const generation=client.generation;
    const check=()=>{if(options.signal?.aborted)throw Error('ABORTED_QUERY_ONLY');if(client.generation!==generation||!client.ready)throw Error('CONNECTION_CHANGED_QUERY_ONLY');};
    // Serialize active-session recipes because original refresh performs parallel
    // reads. A disconnect invalidates queued work; this is not an offline queue.
    const result=queue.then(()=>run(input,options,check));queue=result.catch(()=>{});
    return result.catch(error=>{if(error.status&&error.status<500)return response({success:false,code:error.code,error:error.message},error.status);throw error;});
  };
}
module.exports={storagePort};
