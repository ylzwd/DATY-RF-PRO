/* Real MQTT.js browser bundle + verified test CA; isolated receiver fixtures only. */
'use strict';
process.on('uncaughtException',error=>{console.error(error.message);process.exit(1);});
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {ControlClient}=require('./control-client.cjs');
const [url,caPath,bundlePath,wsBundlePath]=process.argv.slice(2);
const {ws:WebSocket}=require(wsBundlePath),ca=fs.readFileSync(caPath);
const context=vm.createContext({console,URL,WebSocket,TextEncoder,TextDecoder,AbortController,AbortSignal,Blob,
  navigator:{language:'en-US',userAgent:'stage3-isolated'},document:{},performance,
  setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate,queueMicrotask});
context.window=context;context.self=context;vm.runInContext(fs.readFileSync(bundlePath,'utf8'),context);
const records=[];let confirmations=0;
const client=new ControlClient({url,timeoutMs:5000,confirm:async()=>{confirmations++;return true;},
  onRecord:r=>records.push(r),connect:(address,options)=>context.mqtt.connect(address,{...options,
    forceNativeWebSocket:true,timerVariant:'native',createWebsocket:(target,protocols)=>new WebSocket(target,protocols,
      {ca,rejectUnauthorized:true,origin:'https://127.0.0.1:8080'})})});
(async()=>{
  try{
    await client.start();const targets=await client.targets();
    const target=targets.targets.find(x=>x.target.receiver_ip==='127.0.0.2'&&x.target.channel_number===1).target;
    const intent={operation_id:'live-mqttjs-'+crypto.randomUUID().replaceAll('-',''),target,command:'set_freq',expected_value:650250};
    const first=client.execute(intent),duplicate=client.execute(intent);assert.equal(first,duplicate);
    const result=await first;assert.equal(result.state,'acknowledged');assert.equal(result.actual_value,650250);
    const restored=await client.query(intent.operation_id);assert.equal(restored.command_id,result.command_id);
    assert.equal(restored.state,'acknowledged');assert.equal(confirmations,1);
    console.log(JSON.stringify({ok:true,state:result.state,actual_khz:result.actual_value,confirmations,
      operation_id:intent.operation_id,command_id:result.command_id,observed_phases:records.map(r=>r.state),
      protocol:'MQTT5/WSS with verified temporary CA',library:'MQTT.js 5.10.4 browser bundle'}));
  }finally{client.stop();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
