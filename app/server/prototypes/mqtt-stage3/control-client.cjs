/* Native-ready candidate. Explicit confirmation; one publish, query-only recovery.
 * No DOM, browser persistence, HTTP fallback, offline command queue or auto replay.
 */
'use strict';
const SCHEMA='daty-command-rpc-v1', SERVER='stage3-server';
const REQUEST='daty/v2/stage3-server/commands/request', REPLY='daty/v2/stage3-server/commands/reply';
const TERMINAL=new Set(['acknowledged','rejected','not_sent','timeout','unknown']);
const copy=x=>JSON.parse(JSON.stringify(x));
const equal=(a,b)=>JSON.stringify(Object.keys(a).sort().map(k=>[k,a[k]]))===JSON.stringify(Object.keys(b).sort().map(k=>[k,b[k]]));

class ControlClient {
  constructor({connect,url,confirm,uuid=()=>crypto.randomUUID().replaceAll('-',''),
    wall=()=>Date.now(),timers=globalThis,timeoutMs=8000,onRecord=()=>{}}) {
    const address=new URL(url);
    if(address.protocol!=='wss:'||address.username||address.password||address.search||address.hash||address.pathname!=='/mqtt-control') throw Error('Exact WSS control endpoint required');
    if(typeof confirm!=='function'||timeoutMs<100||timeoutMs>30000) throw Error('Confirmation and bounded timeout required');
    Object.assign(this,{connect,url,confirm,uuid,wall,timers,timeoutMs,onRecord});
    this.generation=0;this.pending=new Map();this.intents=new Map();this.operations=new Map();this.ready=false;
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
        if(ack.sessionPresent||!/^ctl-[a-f0-9]{32}$/.test(sid||''))return this.disconnect('INVALID_SESSION');
        this.sid=sid;
        client.subscribe(REPLY,{qos:1},(error,granted)=>{
          if(current()&&(error||granted?.length!==1||granted[0].topic!==REPLY||![0,1].includes(granted[0].qos)))this.disconnect('SUBSCRIBE_FAILED');
        });
      });
      client.on('message',(topic,bytes,packet)=>{
        if(!current())return;
        try {
          const message=JSON.parse(bytes.toString());
          if(topic!==REPLY||packet?.retain||message.schema!==SCHEMA||message.server_id!==SERVER||
             message.client_session_id!==this.sid||!/^([a-f0-9]{32})$/.test(message.boot_id))throw Error('WRONG_REPLY_SOURCE');
          if(message.kind==='hello') {
            if(this.ready||message.active_entry!=='mqtt'||!Number.isSafeInteger(message.server_time_ms))throw Error('CONTROL_ENTRY_DISABLED');
            this.boot=message.boot_id;this.offset=message.server_time_ms-this.wall();this.ready=true;
            this.timers.clearTimeout(this.startTimer);this.startResolve();this.starting=null;return;
          }
          if(!this.ready||message.boot_id!==this.boot)throw Error('SERVER_BOOT_CHANGED');
          if(message.kind==='command_update')return this.record(message.result);
          if(message.kind!=='reply')throw Error('INVALID_REPLY');
          const pending=this.pending.get(message.request_id);
          if(!pending)return;
          if(message.method!==pending.method)throw Error('WRONG_REPLY_METHOD');
          this.pending.delete(message.request_id);this.timers.clearTimeout(pending.timer);
          if(message.ok===true)pending.resolve(message.result);
          else pending.reject(Error(message.error||'OUTCOME_UNKNOWN_QUERY_ONLY'));
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
    for(const operation of this.operations.values())if(!operation.done)this.finish(operation,{state:'unknown',
      operation_id:operation.intent.operation_id,error:reason,query_only:true});
  }
  stop(){this.disconnect('STOPPED');}
  rpc(method,body,deadlineMs=this.timeoutMs) {
    if(!this.ready||!this.client?.connected)return Promise.reject(Error('NOT_CONNECTED_QUERY_ONLY'));
    if(this.pending.size>=32)return Promise.reject(Error('REQUEST_LIMIT'));
    const request_id=this.uuid(),request={schema:SCHEMA,server_id:SERVER,boot_id:this.boot,
      client_session_id:this.sid,request_id,method,deadline_at_ms:this.wall()+this.offset+deadlineMs,body:copy(body)};
    return new Promise((resolve,reject)=>{
      const timer=this.timers.setTimeout(()=>{this.pending.delete(request_id);reject(Error('RPC_TIMEOUT_QUERY_ONLY'));},deadlineMs);
      this.pending.set(request_id,{resolve,reject,timer,method});
      try {
        this.client.publish(REQUEST,JSON.stringify(request),{qos:1,retain:false},error=>{
          // PUBACK may only fail transport. Success cannot resolve execution.
          if(error&&this.pending.has(request_id)){this.pending.delete(request_id);this.timers.clearTimeout(timer);reject(Error('PUBACK_UNKNOWN_QUERY_ONLY'));}
        });
      }catch(error){this.pending.delete(request_id);this.timers.clearTimeout(timer);reject(error);}
    });
  }
  targets(){return this.rpc('commands.targets',{});}
  async query(operation_id) {
    const result=await this.rpc('commands.get',{operation_id});
    if(result.operation_id!==operation_id)throw Error('WRONG_OPERATION_REPLY');
    this.record(result);return result;
  }
  execute(intent) {
    const fixed=copy(intent),key=JSON.stringify(fixed),prior=this.intents.get(fixed.operation_id);
    if(prior){if(prior.key!==key)return Promise.reject(Error('OPERATION_ID_CONFLICT'));return prior.promise;}
    const promise=this.executeOnce(fixed);
    this.intents.set(fixed.operation_id,{key,promise});return promise;
  }
  async executeOnce(intent) {
    if(!this.ready) return {operation_id:intent.operation_id,state:'not_sent',error:'NOT_CONNECTED'};
    const generation=this.generation;
    // This callback must be the existing review/confirmation flow, not a new UI.
    if(!await this.confirm(copy(intent)))return {operation_id:intent.operation_id,state:'cancelled'};
    if(!this.ready||generation!==this.generation)return {operation_id:intent.operation_id,state:'not_sent',error:'CONNECTION_CHANGED_DURING_CONFIRMATION'};
    // Re-query trusted target/session immediately after the human decision.
    const live=await this.targets();
    if(live.active_entry!=='mqtt'||!live.targets.some(item=>equal(item.target,intent.target)))
      return {operation_id:intent.operation_id,state:'not_sent',error:'TARGET_BINDING_CHANGED'};
    return new Promise(resolve=>{
      const operation={intent,resolve,revision:0,command_id:null,done:false,boot:this.boot};
      this.operations.set(intent.operation_id,operation);
      operation.timer=this.timers.setTimeout(()=>this.finish(operation,{operation_id:intent.operation_id,
        state:'unknown',error:'EXECUTION_TIMEOUT_QUERY_ONLY',query_only:true}),this.timeoutMs);
      this.rpc('commands.request',intent).then(record=>this.record(record)).catch(error=>this.finish(operation,
        {operation_id:intent.operation_id,state:'unknown',error:error.message,query_only:true}));
    });
  }
  record(record) {
    const operation=this.operations.get(record?.operation_id);
    if(!operation)return; // Unsolicited operation cannot become a UI success.
    const expected=operation.intent;
    if(record.entry!=='mqtt'||record.server_id!==SERVER||record.boot_id!==operation.boot||
       !['reserved','dispatching','published',...TERMINAL].includes(record.state)||
       !equal(record.target||{},expected.target)||record.command!==expected.command||
       record.expected_value!==expected.expected_value||!Number.isSafeInteger(record.revision)||record.revision<1||
       !/^[a-f0-9]{32}$/.test(record.command_id)||
       (operation.command_id&&operation.command_id!==record.command_id))throw Error('EXECUTION_TARGET_MISMATCH');
    if(record.revision<=operation.revision)return;
    if(record.state==='acknowledged') {
      const e=record.execution_evidence,t=expected.target;
      if(record.actual_value!==expected.expected_value||!e||e.source!=='paired-receiver-status'||
         e.command_id!==record.command_id||e.receiver_session_id!==t.receiver_session_id||
         e.receiver_id!==t.receiver_id||e.device_id!==t.device_id||e.channel_number!==t.channel_number||e.brand!==t.expected_brand)
        throw Error('EXECUTION_EVIDENCE_MISMATCH');
    }
    operation.command_id=record.command_id;operation.revision=record.revision;
    this.onRecord(copy(record));
    if(TERMINAL.has(record.state))this.finish(operation,copy(record));
  }
  finish(operation,result) {
    if(operation.done)return;
    operation.done=true;this.timers.clearTimeout(operation.timer);operation.resolve(result);
  }
}
module.exports={ControlClient,SCHEMA,SERVER,REQUEST,REPLY};
