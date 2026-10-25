(function(global){
  'use strict';
  const config=global.__FASHE_MQTT6_CONFIG||{},clients=new Map();
  const connect=(url,options)=>global.mqtt.connect(url,{...options,timerVariant:'native'});
  function endpoint(origin){
    const host=new URL(origin).hostname,server=config.wssOrigin||'wss://'+host+':8083';
    if(new URL(server).hostname!==host)throw Error('登记服务器来源不匹配');
    return server+'/mqtt-enrollment';
  }
  function make(origin){return new global.DatyMQTT6.M6Client({url:endpoint(origin),mode:'enrollment',connect,
    timers:global.FasheNetworkTimers||global,timeoutMs:8000});}
  async function request(url,options){
    const origin=new URL(url).origin;
    if(!clients.has(origin)){
      const client=make(origin),port=global.DatyMQTT6.enrollmentPort({client,origin});
      clients.set(origin,{client,port});
    }
    return clients.get(origin).port(url,options);
  }
  async function probe(info){
    const broker=new URL(info.broker_url),origin='https://'+broker.hostname+':8802',client=make(origin),start=performance.now();
    try{await client.start();return {ok:true,ms:Math.round(performance.now()-start),broker_url:info.broker_url,protocol:'mqtt5'};}
    catch(_){return {ok:false,ms:Math.round(performance.now()-start),broker_url:info.broker_url,protocol:'mqtt5'};}
    finally{client.stop();}
  }
  global.FasheMqttEnrollment={request,probe,version:'mqtt6-candidate-1'};
  global.addEventListener('pagehide',()=>{for(const value of clients.values())value.client.stop();},{once:true});
})(globalThis);
