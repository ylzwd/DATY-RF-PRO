(function(global){
  'use strict';
  const config=global.__DATY_MQTT6_CONFIG||{},ports=new Map(),browser=global.DatyPlatform;
  const uuid=()=>global.crypto.randomUUID().replaceAll('-','');
  const hash=async raw=>Array.from(new Uint8Array(await global.crypto.subtle.digest('SHA-256',raw)),b=>b.toString(16).padStart(2,'0')).join('');
  const encode64=raw=>{let text='';for(let o=0;o<raw.length;o+=8192)text+=String.fromCharCode(...raw.subarray(o,o+8192));return btoa(text);};
  const decode64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  const audit=[];global.DatyMqttAudit=audit;
  const totals={routes:0,forbidden:0};global.DatyMqttAuditTotals=totals;
  const readVerification=new Map();
  const streamTiming={events:0,max_event_age_ms:0,last_event_age_ms:0};
  function verifyEnvelope(raw,event){
    let state=readVerification.get(event.stream_id);
    if(!state){state={hash:new global.DatyMQTT6.Sha256(),seq:0};readVerification.set(event.stream_id,state);
      if(readVerification.size>2)readVerification.delete(readVerification.keys().next().value);}
    state.hash.update(raw);state.seq=event.seq;
    // Fixture pages share the server machine's wall clock. This measures that
    // isolated pipeline only, never substitutes for the actual receiver RTT.
    const now=Date.now();
    for(const item of event.kind==='event_batch'?event.payload.events:[event]){
      const at=item.payload?.server_time_ms;
      if(Number.isSafeInteger(at)){const age=now-at;streamTiming.events++;
        streamTiming.last_event_age_ms=age;streamTiming.max_event_age_ms=Math.max(streamTiming.max_event_age_ms,age);}
    }
  }
  global.DatyMqttReadTiming=()=>({...streamTiming});
  global.DatyMqttReadVerification=()=>Array.from(readVerification,([stream,state])=>({stream,seq:state.seq,sha256:state.hash.copy().digest()}));
  function record(entry){totals[entry.type==='forbidden'?'forbidden':'routes']++;audit.push({at:Date.now(),...entry});if(audit.length>256)audit.shift();}
  // Only the pending-count label is coalesced. The original archive queue,
  // lifecycle edges, checkpoints and explicit save/clear UI remain synchronous.
  let archiveStatusPending=false;
  global.DatyMqttScheduleArchiveStatus=render=>{
    if(archiveStatusPending)return;archiveStatusPending=true;
    (global.FasheNetworkTimers||global).setTimeout(()=>{archiveStatusPending=false;render();},50);
  };
  async function saveFile(info,signal){
    if(global.DatyBinaryFiles)return global.DatyBinaryFiles.createVerifiedDestination(info,signal);
    if(global.navigator.storage?.getDirectory){
      const root=await global.navigator.storage.getDirectory(),name='daty-mqtt-transfer-'+uuid();
      const file=await root.getFileHandle(name,{create:true}),writer=await file.createWritable();
      const digest=new global.DatyMQTT6.Sha256();let length=0,closed=false;
      const remove=()=>root.removeEntry(name).catch(()=>{});
      return {delivery:'download-started',size:async()=>length,sha256:async()=>digest.digest(),
        write:async(offset,raw)=>{if(offset!==length)throw Error('下载位置不连续');
          await writer.write({type:'write',position:offset,data:raw});digest.update(raw);length+=raw.length;},
        suspend:async()=>{if(!closed){closed=true;await writer.abort();}await remove();},
        commit:async()=>{if(signal?.aborted)throw Error('下载已取消');await writer.close();closed=true;
          const saved=await file.getFile();if(saved.size!==info.bytes){await remove();throw Error('临时下载文件长度不匹配');}
          const url=URL.createObjectURL(saved),link=document.createElement('a');link.href=url;link.download=info.fileName;document.body.appendChild(link);
          try{link.click();}finally{link.remove();setTimeout(()=>{URL.revokeObjectURL(url);void remove();},60000);}}};
    }
    // Explicit browser host budget; no claim that invoking download proves an
    // OS save. Native hosts inject a streaming, atomically committed sink.
    if(info.bytes>64*1024*1024)throw Error('此浏览器文件宿主暂限 64 MiB；大文件需要原生流式保存宿主');
    const raw=new Uint8Array(info.bytes);
    return {delivery:'download-started',size:async()=>raw.length,sha256:()=>hash(raw),write:async(o,p)=>raw.set(p,o),
      commit:async()=>{if(signal?.aborted)throw Error('下载已取消');
        const url=URL.createObjectURL(new Blob([raw],{type:info.mimeType||'application/octet-stream'}));
        const link=document.createElement('a');link.href=url;link.download=info.fileName;document.body.appendChild(link);
        try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}}};
  }
  function portFor(input){
    const u=new URL(input,global.location.href),base='https://'+u.hostname+':'+(u.port==='8802'||['8080','8765'].includes(u.port)?'8802':u.port);
    if(!ports.has(base)){
      const wss=config.wssOrigin||'wss://'+u.hostname+':8083';
      if(new URL(wss).hostname!==u.hostname)throw Error('MQTT 服务器来源不匹配');
      const connect=(url,options)=>global.mqtt.connect(url,{...options,timerVariant:'native'});
      const timers=global.FasheNetworkTimers||global;
      const client=new global.DatyMQTT6.M6Client({url:wss+'/mqtt-app',mode:'app',connect,uuid,timeoutMs:10000,timers});
      const port=global.DatyMQTT6.applicationPort({client,baseUrl:base,connect,uuid,sha256:hash,encode64,decode64,
        normalizeBrand:b=>global.DatyEquipmentProfiles.normalizeBrand(b),toKHz:(n,u)=>global.DatyFrequency.toFrequencyKHz(n,u),
        onCommand:r=>global.receiveCommandAcknowledgement?.(r),saveFile,timers,reviewUncertain:reviewCommand,
        onStreamState:state=>record({type:'mqtt-stream',...state}),onStreamEnvelope:config.verifyReadStream?verifyEnvelope:undefined});
      ports.set(base,port);
    }
    return ports.get(base);
  }
  global.DatyPlatform=global.DatyPlatformFactory.create({...browser,
    request:async(url,options)=>{
      const path=new URL(url,global.location.href).pathname;record({type:'mqtt-route',path});
      try{return await portFor(url).request(url,options);}
      catch(error){record({type:'mqtt-failure',path,error:error.code||error.message});throw error;}
    },
    openEventStream:url=>portFor(url).openEventStream(url)});
  global.DatyMqttDownload=(base,category,record,signal)=>portFor(base).download(category,record,signal);
  global.DatyPluginRpc=async(base,method,body={},signal)=>{
    if(!['plugins.status','plugins.preview','plugins.install','plugins.operation'].includes(method))throw Error('INVALID_PLUGIN_METHOD');
    const port=portFor(base);await port.client.start();return port.serial.call(method,body,signal);
  };
  global.DatyMqttControl={
    async uncertain(base){const port=portFor(base);await port.client.start();return port.serial.call('commands.uncertain');},
    async review(base,body){const port=portFor(base);await port.client.start();return port.serial.call('commands.review',body);}
  };
  async function reviewCommand(base,deviceId,intent){
    const port=portFor(base),generation=port.client.generation;
    const direct=!!intent;
    const current=()=>{
      if(intent?.signal?.aborted)throw Error('本次操作已取消，未继续下发');
      if(port.client.generation!==generation)throw Error('连接已变化，请重新操作');
    };
    current();
    const {operations}=await global.DatyMqttControl.uncertain(base);
    current();
    const item=operations.find(x=>x.target.device_id===deviceId);
    if(!item?.current_observation)throw Error('该接收机当前状态不可核对，原指令仍保持待确认');
    const seen=item.current_observation,target=seen.target;
    if(direct){
      if(!['mute','unmute'].includes(intent.command)||typeof intent.expected_value!=='boolean'
          ||intent.expected_value!==(intent.command==='mute'))throw Error('无效的静音操作');
      if(!['mute','unmute'].includes(item.command))throw Error('上次调频结果未确认，请先在频率规划中复核；本次静音未下发');
      if(item.operation_id===intent.operation_id||!['unknown','timeout'].includes(item.state)||item.review)
        throw Error('原指令不能重发，请重新点击静音按钮');
      if(typeof seen.muted!=='boolean'||!target||!intent.target
          ||['device_id','receiver_id','receiver_ip','receiver_mac','receiver_session_id','channel_number','expected_brand'].some(k=>target[k]!==intent.target[k]))
        throw Error('接收机身份或当前静音状态未确认，本次未下发');
      current();
      const reviewed=await port.serial.call('commands.review',{operation_id:item.operation_id,expected_revision:item.revision,confirmed:true,
        note:`用户新点击${intent.expected_value?'静音':'取消静音'}（新操作 ${intent.operation_id}）；应用已读取当前状态，按本次明确操作解除旧静音限制。旧结果仍未确认，不重发旧指令，不声称人工现场复核。`,observation:seen},intent.signal);
      current();
      if(reviewed.operation_id!==item.operation_id||reviewed.revision!==item.revision+1||reviewed.state!==item.state
          ||reviewed.review?.meaning!=='release-target-no-execution-claim')throw Error('旧指令限制解除尚未确认，本次未下发');
      return true;
    }
    const accepted=await global.DatyDialogs.confirm({title:'复核结果未确认的指令',symbol:'?',
      message:'请核对接收机当前状态。此次确认仅解除后续操作限制，原指令仍保留未确认结果。',
      details:[{label:'接收机',value:target.receiver_ip+' · '+target.expected_brand+' · CH'+target.channel_number},
        {label:'当前频率',value:seen.frequency_khz==null?'未知':(seen.frequency_khz/1000)+' MHz'},
        {label:'当前静音',value:seen.muted==null?'未知':seen.muted?'静音':'未静音'},
        {label:'原操作',value:item.command+' · '+item.state}],
      warnings:['本次不会重新下发，也不会将原结果改为执行成功。'],confirmLabel:'已核对，解除限制'});
    if(!accepted)return false;
    if(port.client.generation!==generation)throw Error('连接已变化，请重新核对');
    await port.serial.call('commands.review',{operation_id:item.operation_id,expected_revision:item.revision,confirmed:true,
      note:'用户在应用内核对当前接收机状态，确认解除后续操作限制；原操作结果保持未确认。',observation:seen});
    return true;
  }
  global.DatyMqttMutationIntent=base=>{
    const scope=global.DatyDatabaseConnection?.snapshot();
    if(scope?.origin!==base||!scope.status?.epoch)throw Error('服务器数据库连接或代次已变化');
    return {operation_id:uuid(),epoch:scope.status.epoch};
  };
  global.DatyMqttDiscoveryIntent=async(base,action)=>{
    const intent=global.DatyMqttMutationIntent(base),port=portFor(base);await port.client.start();
    const result=await port.serial.call('discovery.status');
    if(result.status!==200||!Number.isInteger(result.body.generation))throw Error('扫描状态不可确认');
    if(action==='scan'&&result.body.active_operation_id){
      const pending=await port.serial.call('discovery.uncertain');const previous=pending.body?.operation;
      if(previous){
        const generation=port.client.generation;
        const accepted=await global.DatyDialogs.confirm({title:'复核结果未知的扫描',symbol:'?',
          message:'上次扫描在中断后无法确认最终结果。请确认解除限制，原扫描结果将继续保留为未知。',
          details:[{label:'扫描编号',value:previous.operation_id},{label:'当前扫描',value:pending.body.discovery.scanning?'进行中':'已停止'}],
          confirmLabel:'确认解除限制',warnings:['本次不会自动重新扫描。']});
        if(accepted){
          if(generation!==port.client.generation)throw Error('连接已变化，请重新复核');
          global.DatyMqttMutationIntent(base);
          const reviewed=await port.serial.call('discovery.review',{...intent,scan_operation_id:previous.operation_id,
            expected_revision:previous.receipt_revision,expected_generation:pending.body.discovery.generation,
            confirmed:true,note:'用户在应用内确认解除扫描限制，保留原扫描未知结果。'});
          if(reviewed.status!==200)throw Error(reviewed.body.error||'复核未完成');
        }
        throw Error(accepted?'已复核原扫描，请手动重新扫描':'已取消复核，原扫描仍待确认');
      }
    }
    return {...intent,expected_generation:result.body.generation,
      ...(action==='cancel'?{scan_operation_id:result.body.active_operation_id}:{})};
  };
  global.addEventListener('pagehide',()=>{for(const port of ports.values())port.client.stop();},{once:true});
  const denied=type=>function(){record({type:'forbidden',transport:type});throw Error('旧业务传输已停用：'+type);};
  global.fetch=denied('fetch');global.EventSource=denied('EventSource');global.XMLHttpRequest=denied('XMLHttpRequest');
  if(global.navigator)global.navigator.sendBeacon=denied('beacon');
})(globalThis);
