/* Existing MQTT.js browser distribution over an actual CA-verified WSS socket.
 * A Node WebSocket adapter supplies the test CA; no global certificate bypass.
 */
'use strict';
process.on('uncaughtException', error=>{console.error(error.message);process.exit(1);});
const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict');
const {ReadonlyDeviceStream}=require('./readonly-client.cjs');
const {harness,handlers,view}=require('./frontend-harness.cjs');
const [url,caPath,bundlePath,wsBundlePath] = process.argv.slice(2);
const {ws:WebSocket}=require(wsBundlePath);
const c=vm.createContext({console, URL, WebSocket, TextEncoder,TextDecoder,AbortController,AbortSignal,Blob,
  navigator:{language:'en-US',userAgent:'stage2-fixture'}, document:{}, performance,
  setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,clearImmediate,queueMicrotask});
c.window=c;c.self=c;
vm.runInContext(fs.readFileSync(bundlePath,'utf8'),c);
const context=harness(), base=handlers(context), ca=fs.readFileSync(caPath);
let ready=false,finished=false;
const timeout=setTimeout(()=>finish(Error('Live MQTT.js timeout')),12000);
function finish(error) {
  if(finished)return;finished=true;clearTimeout(timeout);stream.stop();
  if(error){console.error(error.stack);process.exitCode=1;}
  else console.log(JSON.stringify({ok:true,channels:context.DEVICES.length,sortedFirst:view(context).sorted[0].group_number,
    mqttjs:'5.10.4',tls:'verified temporary CA',frontend:'existing production normalization'}));
}
const stream=new ReadonlyDeviceStream({url,
  connect:(address,options)=>c.mqtt.connect(address,{...options,forceNativeWebSocket:true,timerVariant:'native',
    createWebsocket:(target,protocols)=>new WebSocket(target,protocols,{ca,rejectUnauthorized:true,
      origin:'https://127.0.0.1:8080'})}),
  handlers:{snapshot(devices){try{base.snapshot(devices);assert.equal(devices.length,100);
      assert.equal(view(context).sorted[0].group_number,4);ready=true;console.log('READY');}catch(e){finish(e);}},
    delta(devices){try{base.delta(devices);assert.equal(devices.length,2);
      assert.equal(context.DEVICES.find(d=>d._fasheId===devices[0].id).afDbfs,null);
      assert.equal(context.DEVICES.find(d=>d._fasheId===devices[1].id).afDbfs,0);finish();}catch(e){finish(e);}},
    offline(reason){if(!finished)finish(Error('Unexpected offline: '+reason+(ready?' after snapshot':'')));}}});
stream.start();
