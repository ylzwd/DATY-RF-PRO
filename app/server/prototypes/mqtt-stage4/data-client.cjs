/* Native-ready data transport; existing business/UI confirmation stays above this port.
 * No DOM, browser persistence, HTTP fallback, offline command queue or auto replay.
 */
'use strict';
const SCHEMA='daty-mqtt-data-v1', SERVER='stage4-server';
const REQUEST='daty/v2/stage4-server/data/request', REPLY='daty/v2/stage4-server/data/reply';
const copy=x=>JSON.parse(JSON.stringify(x));

class DataClient {
  constructor({connect,url,uuid=()=>crypto.randomUUID().replaceAll('-',''),
    wall=()=>Date.now(),timers=globalThis,timeoutMs=8000}) {
    const address=new URL(url);
    if(address.protocol!=='wss:'||address.username||address.password||address.search||address.hash||address.pathname!=='/mqtt-data') throw Error('Exact WSS data endpoint required');
    if(typeof connect!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>30000) throw Error('Network and bounded timeout required');
    Object.assign(this,{connect,url,uuid,wall,timers,timeoutMs});
    this.generation=0;this.pending=new Map();this.intents=new Map();this.ready=false;
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
        if(ack.sessionPresent||!/^dat-[a-f0-9]{32}$/.test(sid||''))return this.disconnect('INVALID_SESSION');
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
    if(this.pending.size>=32)return Promise.reject(Error('REQUEST_LIMIT'));
    const request_id=this.uuid(),request={schema:SCHEMA,server_id:SERVER,boot_id:this.boot,
      client_session_id:this.sid,request_id,method,deadline_at_ms:this.wall()+this.offset+deadlineMs,body:copy(body)};
    if(new TextEncoder().encode(JSON.stringify(request)).length>768*1024)return Promise.reject(Error('MESSAGE_TOO_LARGE_USE_M5'));
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
  call(method,body={}) { return this.rpc(method,body); }
  async query(operation_id) {
    const result=await this.rpc('operations.get',{operation_id});
    if(result.status===200&&result.body?.operation?.operation_id!==operation_id)throw Error('WRONG_OPERATION_REPLY');
    return result;
  }
  write(method,body) {
    const fixed=copy(body), key=JSON.stringify({method,body:fixed});
    const old=this.intents.get(fixed.operation_id);
    if(old){if(old.key!==key)return Promise.reject(Error('OPERATION_ID_CONFLICT'));return old.promise;}
    const promise=this.rpc(method,fixed).then(result=>{
      if(!result||!Number.isInteger(result.status)||!result.body)throw Error('INVALID_DATA_REPLY');
      if(result.status>=200&&result.status<300&&(result.operation_id??result.body.operation_id)!==fixed.operation_id)throw Error('WRONG_OPERATION_REPLY');
      return result;
    });
    this.intents.set(fixed.operation_id,{key,promise});return promise;
  }
}
module.exports={DataClient,SCHEMA,SERVER,REQUEST,REPLY};
