'use strict';
// Logical legacy DTO adapter. No fetch/EventSource/HTTP request occurs here.
// The host must carry the displayed receiver generation and brand into control.
const {route}=require('../mqtt-stage4/database-port.cjs');
const {storagePort}=require('./storage-port.cjs');
const {FilePort}=require('./m6-file-port.cjs');
const {ReadonlyDeviceStream}=require('./m6-readonly.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
const response=(body,status=200)=>({status,ok:status>=200&&status<300,json:async()=>copy(body),text:async()=>JSON.stringify(body)});
function commandView(record){
  return {command_id:record.command_id,client_request_id:record.operation_id,operation_id:record.operation_id,
    ...record.target,brand:record.target.expected_brand,command:record.command,status:({unknown:'timeout',not_sent:'failed',rejected:'failed'})[record.state]||record.state,
    outcome:record.state,error:record.error,expected_value:record.command==='set_freq'?record.expected_value/1000:record.expected_value,
    actual_value:record.command==='set_freq'&&record.actual_value!==null?record.actual_value/1000:record.actual_value,
    execution_evidence:record.execution_evidence,revision:record.revision,review:record.review,
    ack_round_trip_ms:record.state==='acknowledged'?record.updated_at_ms-record.created_at_ms:null};
}
function serializedClient(client){
  let queue=Promise.resolve(),queued=0;
  return {get generation(){return client.generation;},get ready(){return client.ready;},mode:'files',
    call(method,body={},signal){
      if(queued>=128)return Promise.reject(Error('APPLICATION_QUEUE_FULL'));
      const generation=client.generation,started=performance.now(),budget=client.timeoutMs||8000;queued++;
      const result=queue.then(()=>{
        if(signal?.aborted)throw Error('ABORTED_QUERY_ONLY');
        if(client.generation!==generation||!client.ready)throw Error('CONNECTION_CHANGED_QUERY_ONLY');
        const remaining=Math.floor(budget-(performance.now()-started));
        if(remaining<1)throw Error('QUEUED_REQUEST_EXPIRED_QUERY_ONLY');
        return client.rpc(method,body,remaining);
      });
      queue=result.catch(()=>{});return result.finally(()=>queued--);
    }};
}
function applicationPort({client,baseUrl,connect,sha256,encode64,decode64,uuid,normalizeBrand,toKHz,onCommand=()=>{},
    saveFile,sourceDevices=()=>[],timers=globalThis,reviewUncertain,onStreamState=()=>{},onStreamEnvelope}){
  const base=new URL(baseUrl);
  if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('INVALID_SERVER');
  const serial=serializedClient(client),files=new FilePort({client:serial,sha256,encode64,decode64,uuid});
  const storage=storagePort({client:serial,files,sha256,uuid,baseUrl});
  const encoder=new TextEncoder();
  async function resolve(value,signal){
    if(value?.status!=='download_required')return value;
    if(value.encoding!=='json-utf8'||!Number.isSafeInteger(value.transfer?.bytes)||value.transfer.bytes>64*1024*1024)throw Error('INVALID_LARGE_REPLY');
    const raw=new Uint8Array(value.transfer.bytes);let verified=false;
    await files.download({descriptor:value.transfer,signal,sink:{write:async(o,part)=>raw.set(part,o),size:async()=>raw.length,
      sha256:()=>sha256(raw),commit:async()=>{verified=true;}}});
    if(!verified)throw Error('LARGE_REPLY_NOT_VERIFIED');
    await serial.call('downloads.close',{download_id:value.transfer.id});
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  }
  function check(options){if(options.signal?.aborted)throw Error('ABORTED_QUERY_ONLY');}
  async function request(input,options={}){
    const address=new URL(input,base),verb=options.method||'GET',path=address.pathname;
    if(address.username||address.password||address.hash||address.hostname!==base.hostname||
        !['https:'].includes(address.protocol)||!['8080','8765',base.port].includes(address.port))throw Error('SERVER_CHANGED');
    check(options);await client.start();check(options);
    try{
      if(verb==='GET'&&path==='/api/devices'&&!address.search)return response(await serial.call('devices.snapshot',{},options.signal));
      if(verb==='GET'&&['/api/ip','/local-ip.json'].includes(path)&&!address.search){
        const value=await serial.call('network.status',{},options.signal);
        // This original API describes server NICs; the socket peer stays a
        // separate field and must never replace the server's actual address.
        return response(value);
      }
      const query=path.match(/^\/api\/commands\/([A-Za-z0-9_-]{16,80})$/);
      if(verb==='GET'&&query&&!address.search){
        const record=await serial.call('commands.by_id',{command_id:query[1]},options.signal),view=commandView(record);
        onCommand(view);return response({success:true,command:view});
      }
      if(verb==='POST'&&path==='/api/command'&&!address.search){
        const command=JSON.parse(options.body);
        if(!/^[A-Za-z0-9_-]{16,80}$/.test(command.client_request_id||''))throw Error('STABLE_COMMAND_ID_REQUIRED');
        if(!command.receiver_session_id||!command.expected_brand)throw Error('DISPLAYED_RECEIVER_BINDING_REQUIRED');
        const generation=client.generation;
        const current=(await serial.call('commands.targets',{},options.signal)).targets;
        const matches=current.filter(x=>x.target.device_id===command.device_id);
        if(matches.length!==1)throw Error('TARGET_OFFLINE_OR_AMBIGUOUS');
        const target=matches[0].target;
        for(const key of ['receiver_id','receiver_ip','receiver_mac','receiver_session_id','channel_number']){
          if(command[key]!==target[key])throw Error('DISPLAYED_RECEIVER_BINDING_CHANGED');
        }
        if(normalizeBrand(command.expected_brand)!==normalizeBrand(target.expected_brand))throw Error('TARGET_BRAND_CHANGED');
        let value;
        if(command.command==='set_freq')value=toKHz(command.value,'MHz');
        else if(['mute','unmute'].includes(command.command)&&typeof command.value==='boolean'&&command.value===(command.command==='mute'))value=command.value;
        else throw Error('INVALID_COMMAND');
        check(options);
        const intent={operation_id:command.client_request_id,target,command:command.command,expected_value:value};
        let record;
        try{record=await serial.call('commands.request',intent,options.signal);}
        catch(error){
          if(error.code!=='TARGET_PENDING_OR_UNCERTAIN'||typeof reviewUncertain!=='function')throw error;
          // This explicit rejection is before reservation/dispatch. Only the
          // user's NEW mute intent may proceed once; never replay an old intent
          // or retry a lost reply, timeout, accepted command or unknown result.
          const direct=['mute','unmute'].includes(command.command);
          const reviewed=await reviewUncertain(base.href.replace(/\/$/,''),command.device_id,
            direct?{...copy(intent),signal:options.signal}:undefined);
          if(!direct||reviewed!==true)return response({success:false,accepted:false,code:error.code,
            error:'上次指令结果未确认；复核后请重新核对并手动操作，本次未下发。'},409);
          check(options);
          if(client.generation!==generation||!client.ready)throw Error('CONNECTION_CHANGED_QUERY_ONLY');
          const latest=(await serial.call('commands.targets',{},options.signal)).targets.filter(x=>x.target.device_id===command.device_id);
          if(latest.length!==1||Object.keys(target).some(k=>latest[0].target[k]!==target[k]))throw Error('DISPLAYED_RECEIVER_BINDING_CHANGED');
          check(options);
          if(client.generation!==generation)throw Error('CONNECTION_CHANGED_QUERY_ONLY');
          record=await serial.call('commands.request',intent,options.signal);
        }
        const view=commandView(record);
        onCommand(view);
        return response({success:true,accepted:record.attempts>0,command_id:record.command_id,command_record:view});
      }
      if(path==='/api/database/storage-status'||/^\/api\/database\/(archives|exports|archive-cleanups)(\/|$)/.test(path)){
        return await storage(new URL(path+address.search,base).href,options);
      }
      const mapped=route(address,verb),body=verb==='POST'?JSON.parse(options.body):mapped.body;
      if(verb==='POST'&&mapped.method!=='database.import.preview'&&(!body.operation_id||!body.epoch))throw Error('OPERATION_AND_EPOCH_REQUIRED');
      // Small reads and writes use inline RPC, avoiding a staging file for each
      // poll. Large documents reuse verified M5 transfer/domain transactions.
      if(encoder.encode(JSON.stringify(body)).length>240*1024)return storage(new URL(path+address.search,base).href,options);
      const result=await resolve(await serial.call(mapped.method,body,options.signal),options.signal);check(options);
      if(!Number.isInteger(result.status)||!result.body)throw Error('INVALID_DOMAIN_REPLY');
      if(mapped.method.startsWith('discovery.')&&result.body.discovery){
        return response({...result.body.discovery,success:result.body.success,operation_id:result.body.operation_id,
          operation_state:result.body.state},result.status);
      }
      return response(result.body,result.status);
    }catch(error){
      if(error.status&&error.status<500)return response({success:false,accepted:false,code:error.code,error:error.message},error.status);
      throw error;
    }
  }
  function openEventStream(input){
    const u=new URL(input);
    if(u.origin!==base.origin||u.pathname!=='/api/updates'||u.search||u.hash)throw Error('EVENT_SOURCE_CHANGED');
    const listeners=new Map(),view={readyState:0,onopen:null,onerror:null,
      addEventListener(kind,fn){if(!listeners.has(kind))listeners.set(kind,new Set());listeners.get(kind).add(fn);},
      removeEventListener(kind,fn){listeners.get(kind)?.delete(fn);},
      close(){view.readyState=2;stream.stop();}};
    const emit=(kind,payload)=>{for(const fn of listeners.get(kind)||[])fn({type:kind,data:JSON.stringify(payload)});};
    const stream=new ReadonlyDeviceStream({connect,url:new URL('/mqtt-readonly',client.url).href,timers,
      handlers:{snapshot:(devices,payload)=>emit('device_list',payload),delta:(devices,payload)=>emit('device_update',payload),
        event:emit,envelope:onStreamEnvelope,online:()=>{view.readyState=1;onStreamState({state:'online'});view.onopen?.();},offline:reason=>{
          onStreamState({state:'offline',reason});
          if(view.readyState===2)return;view.readyState=0;view.onerror?.({reason});}}});
    // Give the unchanged host a chance to attach its listeners first.
    timers.setTimeout(()=>{if(view.readyState!==2)stream.start();},0);return view;
  }
  async function download(category,record,signal){
    if(typeof saveFile!=='function')throw Error('FILE_HOST_REQUIRED');
    await client.start();
    const id=uuid(),generation=client.generation;
    let result=await serial.call('downloads.open',{operation_id:id,category,id:record.id,sha256:record.sha256},signal);
    while(result.state==='preparing'){
      if(signal?.aborted){await serial.call('downloads.close',{download_id:id}).catch(()=>{});throw Error('TRANSFER_CANCELLED');}
      await new Promise(resolve=>timers.setTimeout(resolve,250));
      if(client.generation!==generation)throw Error('CONNECTION_CHANGED_QUERY_ONLY');
      result=await serial.call('file.operations.get',{operation_id:id},signal);
    }
    if(result.state!=='completed'||!result.result)throw Error('DOWNLOAD_OUTCOME_UNKNOWN');
    const descriptor=result.result,sink=await saveFile({...record,...descriptor},signal);
    if(!sink){await serial.call('downloads.close',{download_id:descriptor.id});return {status:'cancelled'};}
    await files.download({descriptor,sink,signal});
    await serial.call('downloads.close',{download_id:descriptor.id});return {status:sink.delivery||'saved',sha256:descriptor.sha256};
  }
  return {request,openEventStream,download,serial,files,client,commandView};
}
module.exports={applicationPort,commandView,serializedClient};
