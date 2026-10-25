(function(root){"use strict";const modules={"mqtt-stage6/browser-exports.cjs":function(module,exports,require){
'use strict';
module.exports={...require("mqtt-stage6/m6-client.cjs"),...require("mqtt-stage6/application-port.cjs"),...require("mqtt-stage6/sha256.cjs"),
  ...require("mqtt-stage5/enrollment-port.cjs")};

},"mqtt-stage6/m6-client.cjs":function(module,exports,require){
/* Native-ready data transport; existing business/UI confirmation stays above this port.
 * No DOM, browser persistence, HTTP fallback, offline command queue or auto replay.
 */
'use strict';
const SERVER='daty-rf-pro';
const copy=x=>JSON.parse(JSON.stringify(x));

class M6Client {
  constructor({connect,url,uuid=()=>crypto.randomUUID().replaceAll('-',''),
    wall=()=>Date.now(),timers=globalThis,timeoutMs=8000,mode='app'}) {
    if(!['app','enrollment'].includes(mode))throw Error('Invalid mode');
    this.mode=mode;this.schema='daty-mqtt6-'+mode+'-v1';this.requestTopic='daty/v2/'+SERVER+'/'+mode+'/request';this.replyTopic='daty/v2/'+SERVER+'/'+mode+'/reply';
    const address=new URL(url);
    if(address.protocol!=='wss:'||address.username||address.password||address.search||address.hash||address.pathname!=='/mqtt-'+mode) throw Error('Exact WSS data endpoint required');
    if(typeof connect!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>30000) throw Error('Network and bounded timeout required');
    Object.assign(this,{connect,url,uuid,wall,timers,timeoutMs});
    this.generation=0;this.pending=new Map();this.ready=false;
  }
  async start() {
    if(this.ready)return;
    if(this.starting)return this.starting;
    const generation=++this.generation;
    this.starting=new Promise((resolve,reject)=>{
      this.startResolve=resolve;this.startReject=reject;
      this.startTimer=this.timers.setTimeout(()=>this.disconnect('CONNECT_TIMEOUT'),5000);
    });
    const starting=this.starting;
    const current=()=>generation===this.generation;
    try {
      const client=this.connect(this.url,{protocolVersion:5,clean:true,clientId:'',keepalive:10,
        reconnectPeriod:0,resubscribe:false,queueQoSZero:false,connectTimeout:5000,
        properties:{sessionExpiryInterval:0,maximumPacketSize:1048576}});
      this.client=client;
      client.on('connect',ack=>{
        if(!current())return;
        const sid=ack?.properties?.assignedClientIdentifier;
        if(ack.sessionPresent||!new RegExp('^'+(this.mode==='app'?'m6a-':'m6e-')+'[a-f0-9]{32}$').test(sid||''))return this.disconnect('INVALID_SESSION');
        this.sid=sid;
        client.subscribe(this.replyTopic,{qos:1},(error,granted)=>{
          if(current()&&(error||granted?.length!==1||granted[0].topic!==this.replyTopic||![0,1].includes(granted[0].qos)))this.disconnect('SUBSCRIBE_FAILED');
        });
      });
      client.on('message',(topic,bytes,packet)=>{
        if(!current())return;
        try {
          const message=JSON.parse(bytes.toString());
          if(topic!==this.replyTopic||packet?.retain||message.schema!==this.schema||message.server_id!==SERVER||
             message.client_session_id!==this.sid||!/^([a-f0-9]{32})$/.test(message.boot_id))throw Error('WRONG_REPLY_SOURCE');
          if(message.kind==='hello') {
            if(this.ready||message.active_entry!=='mqtt'||!Number.isSafeInteger(message.server_time_ms))throw Error('CONTROL_ENTRY_DISABLED');
            this.boot=message.boot_id;this.offset=message.server_time_ms-this.wall();this.ready=true;
            this.timers.clearTimeout(this.startTimer);this.startResolve();this.starting=null;return;
          }
          if(!this.ready||message.boot_id!==this.boot)throw Error('SERVER_BOOT_CHANGED');
          if(message.kind!=='reply')throw Error('INVALID_REPLY');
          const pending=this.pending.get(message.request_id);
          if(!pending)return;
          if(message.method!==pending.method)throw Error('WRONG_REPLY_METHOD');
          this.pending.delete(message.request_id);this.timers.clearTimeout(pending.timer);
          if(message.ok===true)pending.resolve(message.result);
          else pending.reject(Object.assign(Error(message.error||'OUTCOME_UNKNOWN_QUERY_ONLY'),{code:message.error,status:message.status}));
        }catch(error){this.disconnect(error.message);}
      });
      for(const event of ['close','error','offline'])client.on(event,()=>{if(current())this.disconnect('TRANSPORT_LOST');});
    }catch(error){this.disconnect(error.message);}
    return starting;
  }
  disconnect(reason='STOPPED') {
    ++this.generation;this.ready=false;this.timers.clearTimeout(this.startTimer);
    this.startReject?.(Error(reason));this.startResolve=null;this.startReject=null;this.starting=null;
    const client=this.client;this.client=null;try{client?.end(true);}catch{}
    for(const pending of this.pending.values()){this.timers.clearTimeout(pending.timer);pending.reject(Error(reason));}
    this.pending.clear();

  }
  stop(){this.disconnect('STOPPED');}
  rpc(method,body,deadlineMs=this.timeoutMs) {
    if(!this.ready||!this.client?.connected)return Promise.reject(Error('NOT_CONNECTED_QUERY_ONLY'));
    if(this.pending.size>=1)return Promise.reject(Error('REQUEST_LIMIT'));
    const request_id=this.uuid(),request={schema:this.schema,server_id:SERVER,boot_id:this.boot,
      client_session_id:this.sid,request_id,method,deadline_at_ms:this.wall()+this.offset+deadlineMs,body:copy(body)};
    if(new TextEncoder().encode(JSON.stringify(request)).length>(this.mode==='enrollment'?16384:256*1024))return Promise.reject(Error('MESSAGE_TOO_LARGE'));
    return new Promise((resolve,reject)=>{
      const timer=this.timers.setTimeout(()=>{this.pending.delete(request_id);reject(Error('RPC_TIMEOUT_QUERY_ONLY'));},deadlineMs);
      this.pending.set(request_id,{resolve,reject,timer,method});
      try {
        this.client.publish(this.requestTopic,JSON.stringify(request),{qos:1,retain:false},error=>{
          // PUBACK may only fail transport. Success cannot resolve execution.
          if(error&&this.pending.has(request_id)){this.pending.delete(request_id);this.timers.clearTimeout(timer);reject(Error('PUBACK_UNKNOWN_QUERY_ONLY'));}
        });
      }catch(error){this.pending.delete(request_id);this.timers.clearTimeout(timer);reject(error);}
    });
  }
  call(method,body={}) { return this.rpc(method,body); }
  async query(operation_id) { return this.rpc('file.operations.get',{operation_id}); }
}
module.exports={M6Client};

},"mqtt-stage6/application-port.cjs":function(module,exports,require){
'use strict';
// Logical legacy DTO adapter. No fetch/EventSource/HTTP request occurs here.
// The host must carry the displayed receiver generation and brand into control.
const {route}=require("mqtt-stage4/database-port.cjs");
const {storagePort}=require("mqtt-stage6/storage-port.cjs");
const {FilePort}=require("mqtt-stage6/m6-file-port.cjs");
const {ReadonlyDeviceStream}=require("mqtt-stage6/m6-readonly.cjs");
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

},"mqtt-stage4/database-port.cjs":function(module,exports,require){
/* Inject into existing repositories: same response DTO, MQTT-only network.
 * Host owns existing confirmations, recovery storage and connection generations.
 */
'use strict';
const copy=x=>JSON.parse(JSON.stringify(x));
function route(url,verb) {
  const query={};
  for(const [key,value] of url.searchParams){if(Object.hasOwn(query,key))throw Error('DUPLICATE_QUERY');query[key]=value;}
  if(query.limit!==undefined){if(!/^\d{1,3}$/.test(query.limit))throw Error('INVALID_LIMIT');query.limit=Number(query.limit);}
  if(query.since!==undefined){if(!/^\d{1,16}$/.test(query.since)||!Number.isSafeInteger(Number(query.since)))throw Error('INVALID_SINCE');query.since=Number(query.since);}
  for(const key of ['from_ms','to_ms'])if(query[key]!==undefined){if(!/^\d{1,16}$/.test(query[key])||!Number.isSafeInteger(Number(query[key])))throw Error('INVALID_TIME');query[key]=Number(query[key]);}
  const p=url.pathname;
  const gets={
    '/api/database/activity':'database.activity.list',
    '/api/database/catalog':'database.catalog',
    '/api/database/status':'database.status','/api/database/resources':'database.resources.list',
    '/api/database/channels':'database.channels','/api/database/overview':'database.overview',
    '/api/database/draft':'database.draft.get','/api/database/business-snapshot':'database.business_snapshot',
    '/api/projects':'projects.list','/api/timeline':'timeline.list','/api/discovery/shure/status':'discovery.status',
    '/health':'state.health','/api/stats':'state.stats','/api/capabilities':'state.capabilities','/api/clock':'state.clock'};
  if(verb==='GET') {
    if(gets[p])return {method:gets[p],body:query};
    if(Object.keys(query).length)throw Error('INVALID_QUERY');
    let match=p.match(/^\/api\/database\/activity\/(operations|timeline|live)\/(\d{1,16})$/);
    if(match){if(!Number.isSafeInteger(Number(match[2])))throw Error('INVALID_ID');return {method:'database.activity.get',body:{source:match[1],id:Number(match[2])}};}
    match=p.match(/^\/api\/database\/resources\/([^/]+)\/([^/]+)$/);
    if(match)return {method:'database.resources.get',body:{kind:decodeURIComponent(match[1]),id:decodeURIComponent(match[2])}};
    match=p.match(/^\/api\/database\/operations\/([A-Za-z0-9_-]{16,80})$/);
    if(match)return {method:'database.operations.get',body:{operation_id:match[1]}};
    match=p.match(/^\/api\/mqtt-data\/operations\/([A-Za-z0-9_-]{16,80})$/);
    if(match)return {method:'operations.get',body:{operation_id:match[1]}};
    match=p.match(/^\/api\/projects\/([^/]+)$/);
    if(match)return {method:'projects.get',body:{id:decodeURIComponent(match[1])}};
  }
  const posts={'/api/database/write':'database.write','/api/database/batch':'database.batch',
    '/api/database/draft':'database.draft.save','/api/database/browser-import/preview':'database.import.preview',
    '/api/database/browser-import/commit':'database.import.commit','/api/projects':'projects.save',
    '/api/coordination-runs':'planning.run.create','/api/timeline/events':'timeline.append',
    '/api/discovery/shure/scan':'discovery.scan','/api/discovery/shure/cancel':'discovery.cancel'};
  if(verb==='POST'&&posts[p]&&!Object.keys(query).length)return {method:posts[p]};
  throw Error('ROUTE_OUTSIDE_M4');
}
function createRequestPort({client,baseUrl}) {
  const base=new URL(baseUrl);
  if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('INVALID_ORIGIN');
  return function request(input,options={}) {
    const address=new URL(input);
    if(address.origin!==base.origin||address.username||address.password||address.hash)throw Error('SERVER_CHANGED');
    const verb=options.method||'GET', mapped=route(address,verb);
    if(verb==='POST')mapped.body=JSON.parse(options.body);
    const write=verb==='POST'&&mapped.method!=='database.import.preview';
    if(write&&(!mapped.body?.operation_id||!mapped.body?.epoch))throw Error('OPERATION_AND_EPOCH_REQUIRED');
    if(options.signal?.aborted)return Promise.reject(Error('ABORTED_QUERY_ONLY'));
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(error,result)=>{if(done)return;done=true;options.signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
      const abort=()=>finish(Error('ABORTED_QUERY_ONLY'));
      options.signal?.addEventListener('abort',abort,{once:true});
      const pending=write?client.write(mapped.method,mapped.body):client.call(mapped.method,mapped.body);
      pending.then(result=>{
        if(!result||!Number.isInteger(result.status)||!result.body||typeof result.body!=='object')return finish(Error('INVALID_DATA_REPLY'));
        const value=copy(result.body);finish(null,{status:result.status,ok:result.status>=200&&result.status<300,
          json:async()=>copy(value),text:async()=>JSON.stringify(value)});
      },error=>{
        if(error.status&&error.status<500)finish(null,{status:error.status,ok:false,json:async()=>({success:false,code:error.code}),text:async()=>JSON.stringify({success:false,code:error.code})});
        else finish(error);
      });
    });
  };
}
module.exports={createRequestPort,route};

},"mqtt-stage6/storage-port.cjs":function(module,exports,require){
'use strict';
const {route}=require("mqtt-stage4/database-port.cjs");
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

},"mqtt-stage6/m6-file-port.cjs":function(module,exports,require){
'use strict';
const {FilePort:BasePort,CHUNK}=require("mqtt-stage5/file-port.cjs");
class FilePort extends BasePort {
  async upload(options){
    try{return await super.upload(options);}
    catch(error){
      // Only an export recipe may reuse consumed temporary bytes, to query its
      // SAME durable operation. Server exports.create compares the full intent
      // before returning an existing receipt; a missing operation cannot run
      // from a closed upload. No new upload or alternate operation is created.
      if(!options.allowConsumed||error.message!=='UPLOAD_NOT_WRITABLE')throw error;
      if(options.signal?.aborted)throw Error('TRANSFER_CANCELLED');
      const record=await this.client.call('uploads.status',{id:options.id});
      if(record.state!=='closed'||record.id!==options.id||record.bytes!==options.source.size||
          record.sha256!==await options.source.sha256())throw error;
      return record;
    }
  }
}
module.exports={FilePort,CHUNK};

},"mqtt-stage5/file-port.cjs":function(module,exports,require){
'use strict';
const CHUNK=128*1024;
// Inject file IO/hash/base64. Native hosts stream into a temporary destination
// and publish to the user's destination only after the complete SHA256 matches.
class FilePort {
  constructor({client,sha256,encode64,decode64,uuid}) {Object.assign(this,{client,sha256,encode64,decode64,uuid});}
  async upload({id,source,mediaType='text/plain',resume=false,signal}) {
    const check=()=>{if(signal?.aborted)throw Error('TRANSFER_CANCELLED');};
    check();const bytes=source.size,sha=await source.sha256();
    let record=resume?await this.client.call('uploads.status',{id}):await this.client.call('uploads.begin',{
      operation_id:id,bytes,sha256:sha,media_type:mediaType});
    if(record.id!==id||record.bytes!==bytes||record.sha256!==sha)throw Error('UPLOAD_IDENTITY_MISMATCH');
    if(record.state==='ready')return record;
    if(record.state!=='uploading')throw Error('UPLOAD_NOT_WRITABLE');
    if(!Number.isSafeInteger(record.offset)||record.offset<0||record.offset>bytes||(record.offset%CHUNK&&record.offset!==bytes))throw Error('INVALID_RESUME_OFFSET');
    for(let offset=record.offset;offset<bytes;offset+=CHUNK) {
      check();const chunk=await source.read(offset,Math.min(CHUNK,bytes-offset));
      if(chunk.length!==Math.min(CHUNK,bytes-offset))throw Error('SOURCE_CHANGED');
      const result=await this.client.call('uploads.chunk',{upload_id:id,offset,sha256:await this.sha256(chunk),data:this.encode64(chunk)});
      if(result.id!==id||result.sha256!==sha||result.offset!==offset+chunk.length)throw Error('UPLOAD_ACK_MISMATCH');
    }
    check();record=await this.client.call('uploads.finish',{upload_id:id,sha256:sha});
    if(record.id!==id||record.bytes!==bytes||record.state!=='ready'||record.sha256!==sha)throw Error('UPLOAD_NOT_VERIFIED');
    return record;
  }
  async download({descriptor,sink,signal,resume=false}) {
    const id=descriptor.id,sha=descriptor.sha256;
    let offset=resume?await sink.resume({id,bytes:descriptor.bytes,sha256:sha}):0;
    if(!Number.isSafeInteger(offset)||offset<0||offset>descriptor.bytes||(offset%CHUNK&&offset!==descriptor.bytes))throw Error('INVALID_RESUME_OFFSET');
    try {
      while(offset<descriptor.bytes) {
        if(signal?.aborted)throw Error('TRANSFER_CANCELLED');
        const part=await this.client.call('downloads.chunk',{download_id:id,offset,sha256:sha}),raw=this.decode64(part.data);
        if(part.download_id!==id||part.file_sha256!==sha||part.offset!==offset||part.bytes!==raw.length||
           raw.length!==Math.min(CHUNK,descriptor.bytes-offset)||await this.sha256(raw)!==part.sha256||part.eof!==(offset+raw.length===descriptor.bytes))throw Error('DOWNLOAD_CHUNK_MISMATCH');
        await sink.write(offset,raw);offset+=raw.length;
      }
      if(signal?.aborted)throw Error('TRANSFER_CANCELLED');
      if(await sink.sha256()!==sha||await sink.size()!==descriptor.bytes)throw Error('DOWNLOAD_DIGEST_MISMATCH');
      await sink.commit({id,sha256:sha,bytes:descriptor.bytes});
      return {id,sha256:sha,bytes:descriptor.bytes,state:'saved'};
    } catch(error) {await sink.suspend?.();throw error;}
  }
}
module.exports={FilePort,CHUNK};

},"mqtt-stage6/m6-readonly.cjs":function(module,exports,require){
/* Injectable MQTT5 transport. No DOM, storage, RPC, publish or control API. */
'use strict';
const TOPIC = 'daty/v2/daty-rf-pro/devices/read';
const SCHEMA = 'daty-device-mqtt6-v1';

class ReadonlyDeviceStream {
  constructor({connect, url, handlers, now = () => performance.now(),
    timers = globalThis, idleMs = 5000, retryMs = 1000}) {
    const u = new URL(url);
    if (u.protocol !== 'wss:' || u.username || u.password || u.search || u.hash || u.pathname !== '/mqtt-readonly') {
      throw Error('Exact WSS read-only endpoint required');
    }
    if (!(idleMs >= 2000) || !(retryMs >= 100)) throw Error('Invalid timer bounds');
    this.connect = connect; this.url = url; this.handlers = handlers;
    this.now = now; this.timers = timers; this.idleMs = idleMs; this.retryMs = retryMs;
    this.generation = 0; this.stopped = true; this.client = null;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }
  open() {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.seq = 0; this.stream = null; this.boot = null; this.last = this.now();
    const current = () => !this.stopped && generation === this.generation;
    try {
      const client = this.connect(this.url, {protocolVersion: 5, clean: true, clientId: '',
        keepalive: 10, reconnectPeriod: 0, connectTimeout: 5000, resubscribe: false,
        queueQoSZero: false, properties: {sessionExpiryInterval: 0, maximumPacketSize: 1048576}});
      this.client = client;
      client.on('connect', ack => {
        if (!current()) return;
        const id = ack?.properties?.assignedClientIdentifier;
        if (ack.sessionPresent || typeof id !== 'string' || !/^view-[a-f0-9]{32}$/.test(id)) return this.fail('invalid-session');
        this.stream = id;
        client.subscribe(TOPIC, {qos: 1}, (error, granted) => {
          if (!current()) return;
          if (error || !granted || granted.length !== 1 || granted[0].topic !== TOPIC || ![0,1].includes(granted[0].qos)) this.fail('subscription-failed');
        });
      });
      client.on('message', (topic, bytes, packet) => {
        if (!current()) return;
        try {
          if (topic !== TOPIC || packet?.retain || bytes.length > 900 * 1024) throw Error('invalid-publication');
          const event = JSON.parse(bytes.toString());
          if (event.schema !== SCHEMA || event.server_id !== 'daty-rf-pro' || !this.stream || event.stream_id !== this.stream ||
              typeof event.boot_id !== 'string' || !/^[a-f0-9]{32}$/.test(event.boot_id) ||
              !Number.isSafeInteger(event.seq) || event.seq < 1) throw Error('invalid-envelope');
          if (this.boot && event.boot_id !== this.boot) throw Error('changed-boot');
          if (event.seq <= this.seq) return; // QoS duplicate cannot refresh liveness.
          if (event.seq !== this.seq + 1 || (!this.seq && event.kind !== 'device_list')) throw Error('snapshot-required');
          const events=event.kind==='event_batch'?event.payload?.events:[event];
          if(!Array.isArray(events)||events.length<1||events.length>128)throw Error('invalid-event-batch');
          for(const item of events){
            if (!['device_list','device_update','heartbeat','mute_command','command_update','client_disconnect'].includes(item.kind)) throw Error('invalid-kind');
            if (['device_list','device_update'].includes(item.kind) && (!item.payload || !Array.isArray(item.payload.devices))) throw Error('invalid-payload');
            if (item.kind === 'heartbeat' && item.payload !== null) throw Error('invalid-heartbeat');
          }
          for(const item of events){
            if(!current())return;
            if(item.kind==='device_list')this.handlers.snapshot(item.payload.devices,item.payload);
            else if(item.kind==='device_update')this.handlers.delta(item.payload.devices,item.payload);
            else if(item.kind!=='heartbeat')this.handlers.event?.(item.kind,item.payload);
          }
          if (!current()) return; // A host callback may stop/switch the connection.
          this.handlers.envelope?.(bytes,event);
          this.boot = event.boot_id; this.seq = event.seq; this.last = this.now();
          if (event.seq === 1) this.handlers.online?.();
        } catch (error) { this.fail(error.message); }
      });
      for (const name of ['close', 'offline', 'error']) client.on(name, () => { if (current()) this.fail(name); });
      this.watchdog = this.timers.setInterval(() => {
        if (current() && this.now() - this.last >= this.idleMs) this.fail('source-idle');
      }, Math.min(1000, this.idleMs / 2));
    } catch (error) { if (current()) this.fail(error.message); }
  }
  fail(reason) {
    ++this.generation; // Invalidate all old callbacks before force-closing transport.
    this.timers.clearInterval(this.watchdog);
    const client = this.client; this.client = null;
    try { client?.end(true); } finally {
      try { this.handlers.offline(reason); } finally {
        if (!this.stopped) this.retry = this.timers.setTimeout(() => this.open(), this.retryMs);
      }
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.timers.clearTimeout(this.retry);
    this.fail('stopped');
  }
}
module.exports = {ReadonlyDeviceStream, TOPIC, SCHEMA};

},"mqtt-stage6/sha256.cjs":function(module,exports,require){
'use strict';
// Incremental FIPS 180-4 SHA-256 for bounded browser file verification.
// This is a content checksum, not credential/key handling. Cross-checked against
// native Node SHA-256 at block/padding boundaries and randomized chunk sizes.
const K=new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const r=(x,n)=>(x>>>n)|(x<<(32-n));
class Sha256{
  constructor(){this.h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.buffer=new Uint8Array(64);this.words=new Uint32Array(64);this.used=0;this.bytes=0;this.result=null;}
  block(raw,offset){
    const w=this.words;
    for(let i=0;i<16;i++){const j=offset+i*4;w[i]=(raw[j]<<24)|(raw[j+1]<<16)|(raw[j+2]<<8)|raw[j+3];}
    for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(r(a,7)^r(a,18)^(a>>>3))+w[i-7]+(r(b,17)^r(b,19)^(b>>>10)))>>>0;}
    let [a,b,c,d,e,f,g,h]=this.h;
    for(let i=0;i<64;i++){
      const t1=(h+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0;
      const t2=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    const value=[a,b,c,d,e,f,g,h];for(let i=0;i<8;i++)this.h[i]=(this.h[i]+value[i])>>>0;
  }
  update(raw){
    if(this.result!==null)throw Error('SHA256_ALREADY_FINAL');
    if(!(raw instanceof Uint8Array)||this.bytes+raw.length>Number.MAX_SAFE_INTEGER/8)throw Error('INVALID_SHA256_INPUT');
    this.bytes+=raw.length;let offset=0;
    if(this.used){const n=Math.min(64-this.used,raw.length);this.buffer.set(raw.subarray(0,n),this.used);this.used+=n;offset=n;
      if(this.used===64){this.block(this.buffer,0);this.used=0;}}
    while(offset+64<=raw.length){this.block(raw,offset);offset+=64;}
    if(offset<raw.length){this.buffer.set(raw.subarray(offset));this.used=raw.length-offset;}
    return this;
  }
  digest(){
    if(this.result!==null)return this.result;
    const tail=new Uint8Array(this.used<56?64:128);tail.set(this.buffer.subarray(0,this.used));tail[this.used]=128;
    const view=new DataView(tail.buffer);view.setUint32(tail.length-8,Math.floor(this.bytes/0x20000000));view.setUint32(tail.length-4,(this.bytes*8)>>>0);
    for(let o=0;o<tail.length;o+=64)this.block(tail,o);
    this.result=Array.from(this.h,x=>x.toString(16).padStart(8,'0')).join('');return this.result;
  }
  copy(){
    const cloned=new Sha256();cloned.h.set(this.h);cloned.buffer.set(this.buffer);
    cloned.used=this.used;cloned.bytes=this.bytes;cloned.result=this.result;return cloned;
  }
}
module.exports={Sha256};

},"mqtt-stage5/enrollment-port.cjs":function(module,exports,require){
'use strict';
// Inject into ORIGINAL DatyAutoPair.create({request:...}). The HTTPS URL stays
// the private-key namespace and signed server identity; no HTTP request occurs.
function enrollmentPort({client,origin}) {
  const server=new URL(origin);
  if(server.protocol!=='https:'||server.port!=='8802'||server.pathname!=='/'||server.search||server.hash||server.username||server.password)throw Error('Invalid identity origin');
  return async function request(url,options={}) {
    const parsed=new URL(url), methods={'/api/receivers/challenge':'receivers.challenge','/api/receivers/enroll':'receivers.enroll'};
    if(parsed.origin!==server.origin||parsed.search||parsed.hash||parsed.username||parsed.password||!methods[parsed.pathname]||options.method!=='POST')throw Error('Enrollment route rejected');
    if(client.mode!=='enrollment')throw Error('Enrollment transport required');
    if(new URL(client.url).hostname!==server.hostname)throw Error('Enrollment server changed');
    if(options.signal?.aborted)throw Error('Enrollment cancelled');
    const abort=()=>client.stop();options.signal?.addEventListener('abort',abort,{once:true});
    try {
      if(parsed.pathname==='/api/receivers/challenge')await client.start();
      if(options.signal?.aborted)throw Error('Enrollment cancelled');
      const result=await client.call(methods[parsed.pathname],JSON.parse(options.body));
      if(options.signal?.aborted)throw Error('Enrollment cancelled');
      // Deliberately no durable or promise cache of the returned secret.
      return {ok:true,status:200,text:async()=>JSON.stringify(result)};
    } finally {options.signal?.removeEventListener('abort',abort);}
  };
}
module.exports={enrollmentPort};

}};const cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}root.DatyMQTT6=require("mqtt-stage6/browser-exports.cjs");})(globalThis);
