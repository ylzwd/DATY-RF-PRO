'use strict';
// Per-event differential replay against the unchanged production implementation.
// No networking, real receivers or production storage. Fixed clock and UUIDs.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const [source,candidate]=process.argv.slice(2);
const harnessSource=fs.readFileSync(path.join(source,'tests/alert-history.test.cjs'),'utf8').split("test('one 30-second timer")[0];
const pendingKey='daty_pending_alerts_v1';
function make(root,count=12){
  let uuid=0;const mod={exports:{}};
  vm.runInNewContext(harnessSource+'\nmodule.exports={harness};',{module:mod,AbortController,
    __dirname:path.join(root,'tests'),require:name=>name==='node:crypto'?{randomUUID:()=>String(++uuid).padStart(32,'0')}:require(name)});
  const h=mod.exports.harness();h.context.performance={now:h.now};
  h.context.DatyMqttScheduleArchiveStatus=()=>{};
  h.sound=[];h.context.DatyAlertSound={observe:items=>h.sound.push(JSON.stringify(items))};
  h.context.DatyAutoFrequency={requestRefresh(){},getSummary:()=>null};
  vm.runInContext(fs.readFileSync(path.join(root,'src/modules/fashe.js'),'utf8'),h.context);
  h.evaluate(Array.from({length:count},(_,n)=>({...h.device,id:'rx_ch'+(n+1),
    _fasheId:'FAshe-MAC-020000000001_ch'+(n+1),receiver_mac:'02:00:00:00:00:01',
    channel_number:n+1,ch:'CH'+(n+1),group:4,group_number:4,group_source:'server-fifo-v1',
    brand:'DATYaudio',model:'RF PRO',rf:-35,batt:100,afDbfs:0,freq:641000+n*250,
    _source:'fixture:mqtt:session',_thresholdStatusManaged:true})));
  h.state=()=>h.read('JSON.stringify({devices:DEVICES,alerts:ALERTS,pending:[..._pendingAlertArchive.values()]})');
  h.delta=(ch,fields)=>h.context._fasheHandleDeviceUpdate([{id:'FAshe-MAC-020000000001_ch'+ch,
    receiver_id:'rx',receiver_ip:h.device.receiver_ip,receiver_mac:'02:00:00:00:00:01',channel_number:ch,channel:ch,...fields}]);
  return h;
}
function pair(n){return [make(source,n),make(candidate,n)];}
function same(hs,label){
  assert.equal(hs[1].state(),hs[0].state(),label);
  assert.deepEqual(hs[1].sound,hs[0].sound,label+' sound edges');
  // Maps are created inside separate VM realms; compare stored bytes and order.
  assert.equal(JSON.stringify([...hs[1].values]),JSON.stringify([...hs[0].values]),label+' checkpoints');
}
function action(hs,label,fn){for(const h of hs)fn(h);same(hs,label);}
function count(h,key){const original=h.context[key];let calls=0;h.context[key]=function(...args){calls++;return original.apply(this,args);};return ()=>calls;}

test('100 active channels: unchanged peers retain timestamps while projection/merges are incremental',()=>{
  const hs=pair(100),h=hs[1];
  const issues=count(h,'getDeviceThresholdIssues'),merges=count(h,'_mergeAlertRecord');
  action(hs,'prime',x=>x.delta(1,{af_dbfs:0}));
  const before=[issues(),merges()];
  for(let n=0;n<100;n++)action(hs,'unchanged peer '+n,x=>{x.advance(1);x.delta(n%100+1,{af_dbfs:0});});
  assert(issues()-before[0]<=100,'Threshold computation must not scan every peer');
  assert(merges()-before[1]<=200,'Unchanged pending records must not be repeatedly merged');
});

test('randomized AF/RF/battery edges, invalid values, identity/group/threshold edits and reorder compare after every event',()=>{
  const hs=pair(24);let seed=32145;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
  const af=[0,-20,null,undefined,'',false,10,-45,'-5'];
  for(let n=0;n<450;n++){
    const ch=random()%24+1,v=af[random()%af.length],delta={af_dbfs:v,rf:random()%2?-95:-35,battery:random()%2?2:100};
    action(hs,'sample '+n,h=>{h.advance(n%17===0?-1:11);h.delta(ch,delta);});
    if(n%29===0)action(hs,'threshold '+n,h=>{h.read('ALERT_THRESHOLDS.afOverloadDbfs=-10;');h.delta(ch,{af_dbfs:-9});});
    if(n%43===0)action(hs,'out of band edit '+n,h=>{h.read("DEVICES[0].group_number=11;DEVICES[0].model='DATY-X2';DEVICES[0].name='鼓手';");h.delta(ch,{rf:-90});});
    if(n%71===0)action(hs,'reorder '+n,h=>{h.read('DEVICES.reverse()');h.delta(ch,{af_dbfs:0});});
    if(n%83===0)action(hs,'explicit full '+n,h=>h.context.evaluateRealtimeAlerts());
  }
});

test('same-tick overload/recovery/retrigger and AF own-property deletion retain every occurrence',()=>{
  const hs=pair(3);
  for(const value of [-20,0,-20,0,null,0])action(hs,'same tick '+value,h=>h.delta(1,{af_dbfs:value}));
  action(hs,'AF alias guard',h=>{h.read('delete DEVICES[1].afDbfs;DEVICES[1].af_dbfs=0');h.delta(1,{af_dbfs:0});});
  action(hs,'AF explicit unknown',h=>{h.read('DEVICES[1].afDbfs=undefined');h.delta(1,{af_dbfs:0});});
  action(hs,'clear current',h=>{h.read('ALERTS.splice(0,ALERTS.length)');h.delta(1,{af_dbfs:0});});
  action(hs,'offline',h=>h.delta(2,{_online:false,status:'offline'}));
  action(hs,'reconnect',h=>h.delta(2,{_online:true,status:'online',af_dbfs:0}));
});

test('full replacement/removal and duplicate legacy keys preserve first alert / last projection behavior',()=>{
  const hs=pair(4);
  action(hs,'same size replacement',h=>{h.read('DEVICES[1]={...DEVICES[1],afDbfs:-20}');h.delta(1,{af_dbfs:0});});
  action(hs,'remove',h=>{h.read('DEVICES.splice(2,1)');h.delta(1,{af_dbfs:0});});
  action(hs,'duplicate key',h=>{h.read('DEVICES.push({...DEVICES[0],afDbfs:-1})');h.delta(2,{af_dbfs:0});});
  action(hs,'empty full',h=>{h.read('DEVICES.length=0');h.context.evaluateRealtimeAlerts();});
});

test('cross-page ended/future records, backward clock and failed checkpoint fall back without loss',()=>{
  const hs=pair(3);
  action(hs,'prime',h=>h.delta(1,{af_dbfs:0}));
  action(hs,'foreign ended',h=>{
    const pending=JSON.parse(h.read('JSON.stringify([..._pendingAlertArchive.values()])'));
    pending[0].archiveState='ended';pending[0].endedAt=h.now()+5000;
    pending[1].lastSeen=h.now()+5000;pending[1].msg='other page';
    h.values.set(pendingKey,JSON.stringify(pending));h.context._loadPendingAlertRecords();
    h.advance(10);h.delta(1,{af_dbfs:0});
  });
  action(hs,'clock backwards',h=>{h.advance(-10000);h.delta(1,{af_dbfs:0});});
  action(hs,'checkpoint failure',h=>{h.fail.add(pendingKey);h.advance(20000);h.delta(2,{af_dbfs:0});});
  action(hs,'checkpoint retry',h=>{h.fail.clear();h.advance(1200);h.delta(3,{af_dbfs:0});});
  action(hs,'custom field',h=>{h.read("ALERTS[0].fixtureExtra='keep';");h.delta(3,{af_dbfs:0});});
});

test('in-flight save captures remain immutable and newer pending state survives the receipt',async()=>{
  const hs=pair(3),flights=[],releases=[],captured=[];
  for(const h of hs){
    h.advance(10);h.delta(1,{af_dbfs:0});
    const original=h.context.DatyAlertDatabase.flush;
    h.context.DatyAlertDatabase.flush=items=>{
      const frozen=JSON.stringify(items);captured.push(frozen);
      return new Promise(resolve=>releases.push(async()=>{assert.equal(JSON.stringify(items),frozen);resolve(await original(items));}));
    };
    flights.push(h.context.flushAlertArchive());
  }
  const before=JSON.stringify(captured);
  action(hs,'during flight',h=>{h.advance(20);h.delta(2,{af_dbfs:-20});h.delta(3,{af_dbfs:-1});});
  assert.equal(JSON.stringify(captured),before);
  await Promise.all(releases.map(fn=>fn()));await Promise.all(flights);
  same(hs,'save receipts');
  assert(hs[1].read('_pendingAlertArchive.size')>0);
});

test('generic pending records without timestamps and changing optional fields keep original normalization',()=>{
  const hs=pair(1);
  action(hs,'manual initial',h=>h.read("globalThis.manual={id:'manual',msg:'test'};queueAlertForArchive(manual)"));
  action(hs,'manual missing dates',h=>{h.advance(5);h.read('queueAlertForArchive(manual)');});
  action(hs,'manual fields',h=>{h.read("manual.ts=Date.now();manual.detail='keep';queueAlertForArchive(manual)");});
  action(hs,'manual field removed',h=>{h.advance(3);h.read('delete manual.detail;manual.lastSeen=Date.now();queueAlertForArchive(manual)');});
  action(hs,'manual ended',h=>h.read("queueAlertForArchive(manual,'ended')"));
  action(hs,'manual stale cannot reopen',h=>{h.advance(7);h.read('queueAlertForArchive(manual)');});
});

test('every alert origin field is repaired after an external edit on an unchanged peer',()=>{
  const hs=pair(3);
  for(const field of ['deviceId','receiverId','receiverIP','receiverMAC','channel','groupNumber',
      'receiverBrand','receiverModel','channelId']){
    action(hs,'edited origin '+field,h=>{
      h.read(`ALERTS[1][${JSON.stringify(field)}]='external edit'`);
      h.advance(2);h.delta(1,{af_dbfs:0});
    });
  }
});

test('non-scalar dependencies are never cached across mutations and may return to scalar inputs',()=>{
  const hs=pair(3);
  action(hs,'mutable name',h=>{
    h.read("globalThis.mutableName={label:'first',toString(){return this.label}};DEVICES[1].name=mutableName");
    h.advance(2);h.delta(1,{af_dbfs:0});
  });
  action(hs,'same name identity, new label',h=>{
    h.read("mutableName.label='second'");h.advance(2);h.delta(1,{af_dbfs:0});
  });
  action(hs,'name returns to scalar',h=>{
    h.read("DEVICES[1].name='third'");h.advance(2);h.delta(1,{af_dbfs:0});
  });
  action(hs,'mutable offline flag',h=>{
    h.read("globalThis.mutableOnline={label:'true',toString(){return this.label}};DEVICES[1]._online=mutableOnline");
    h.advance(2);h.delta(1,{af_dbfs:0});
  });
  action(hs,'same flag identity, now offline',h=>{
    h.read("mutableOnline.label='false'");h.advance(2);h.delta(1,{af_dbfs:0});
  });
  action(hs,'online flag returns to scalar',h=>{
    h.read("DEVICES[1]._online=true;DEVICES[1].status='online'");h.advance(2);h.delta(1,{af_dbfs:0});
  });
});

test('value-only deltas preserve projection order through multi-metric recovery and retrigger',()=>{
  const hs=pair(6);
  action(hs,'three metrics per channel',h=>{
    h.read('for(const d of DEVICES){d.rf=-95;d.batt=5;d.afDbfs=0}');
    h.context.evaluateRealtimeAlerts();
  });
  for(let i=0;i<40;i++)action(hs,'same metric keys '+i,h=>{
    h.advance(3);h.delta(i%6+1,{rf:-95-i%3,battery:5+i%2,af_dbfs:-i%2});
  });
  action(hs,'one metric recovers in the middle',h=>h.delta(3,{rf:-35}));
  action(hs,'same-sized metric set changes',h=>h.delta(3,{rf:-96,af_dbfs:-20}));
  action(hs,'all recover then retrigger same tick',h=>{
    h.delta(4,{rf:-35,battery:100,af_dbfs:-20});
    h.delta(4,{rf:-99,battery:1,af_dbfs:0});
  });
  action(hs,'peer order changes without key changes',h=>{
    h.read('DEVICES.reverse()');h.delta(2,{rf:-97});
  });
});

test('duplicate legacy keys retain last-device projection when only the earlier duplicate changes',()=>{
  const hs=pair(4);
  action(hs,'later duplicate',h=>{
    h.read('DEVICES.push({...DEVICES[0],afDbfs:-1})');h.context.evaluateRealtimeAlerts();
  });
  action(hs,'earlier value change',h=>{h.advance(4);h.delta(1,{af_dbfs:-2});});
  action(hs,'later value change',h=>{
    h.read('DEVICES[4].afDbfs=0');h.advance(4);h.delta(2,{af_dbfs:-1});
  });
  action(hs,'duplicate removed',h=>{h.read('DEVICES.pop()');h.delta(2,{af_dbfs:0});});
  action(hs,'sole owner now changes',h=>{h.advance(4);h.delta(1,{af_dbfs:0});});
});

test('pending key guards retain own-field, inherited-field and enumerable-field semantics',()=>{
  const hs=pair(1);
  action(hs,'manual with inherited fields',h=>h.read(`
    globalThis.manualProto={inherited:'not archived',firstSeen:Date.now()};
    globalThis.ownManual=Object.assign(Object.create(manualProto),{2:'numeric',msg:'own',lastSeen:Date.now()});
    queueAlertForArchive(ownManual);
  `));
  action(hs,'unchanged own fields',h=>{h.advance(3);h.read('ownManual.lastSeen=Date.now();queueAlertForArchive(ownManual)');});
  action(hs,'own addition',h=>h.read("ownManual.extra='added';queueAlertForArchive(ownManual)"));
  action(hs,'inherited mutation',h=>h.read("manualProto.inherited='changed';queueAlertForArchive(ownManual)"));
  action(hs,'own field becomes non-enumerable',h=>h.read("Object.defineProperty(ownManual,'extra',{enumerable:false});queueAlertForArchive(ownManual)"));
  action(hs,'same keys in new order',h=>h.read("delete ownManual.msg;ownManual.msg='own';queueAlertForArchive(ownManual)"));
  action(hs,'inherited time changes',h=>{h.advance(2);h.read('manualProto.firstSeen=Date.now();queueAlertForArchive(ownManual)');});
});

test('lost save receipt retains recovery and retrigger until a later confirmed save',async()=>{
  const hs=pair(3),flights=[],release=[],originals=[];
  for(const h of hs){
    originals.push(h.context.DatyAlertDatabase.flush);
    h.context.DatyAlertDatabase.flush=items=>{
      const captured=JSON.stringify(items);
      return new Promise(resolve=>release.push(()=>{
        assert.equal(JSON.stringify(items),captured);
        resolve({success:false,error:'receipt unavailable'});
      }));
    };
    flights.push(h.context.flushAlertArchive());
  }
  action(hs,'unchanged while saving',h=>{h.advance(5);h.delta(1,{af_dbfs:0});});
  action(hs,'recovery then new occurrence',h=>{h.delta(2,{af_dbfs:-20});h.delta(2,{af_dbfs:0});});
  release.forEach(fn=>fn());
  const receipts=await Promise.all(flights);
  assert(receipts.every(r=>r.success===false));same(hs,'failed receipts');
  assert(hs[1].read('_pendingAlertArchive.size')>=4);
  for(let i=0;i<hs.length;i++){
    hs[i].context.DatyAlertDatabase.flush=originals[i];
    assert.equal((await hs[i].context.flushAlertArchive()).success,true);
  }
  same(hs,'later real receipt');
});

test('a failed projection pass cannot leave earlier channel caches ahead of the index on retry',()=>{
  const hs=pair(3);
  for(const h of hs){
    const original=h.context.getDeviceThresholdIssues;
    h.context.getDeviceThresholdIssues=function(device,...args){
      if(h.context.failProjection&&device.channel_number===2){
        h.context.failProjection=false;throw new Error('injected projection failure');
      }
      return original(device,...args);
    };
    h.context.evaluateRealtimeAlerts();
    h.advance(5);h.read('DEVICES[0].afDbfs=-1;DEVICES[1].afDbfs=-2');
    h.context.failProjection=true;
    assert.throws(()=>h.read('evaluateRealtimeAlerts(DEVICES,{changedDevices:[DEVICES[0],DEVICES[1]]})'),
      /injected projection failure/);
  }
  same(hs,'after interrupted pass');
  action(hs,'retry with already-applied channel values',h=>{
    h.advance(2);h.read('evaluateRealtimeAlerts(DEVICES,{changedDevices:[]})');
  });
  action(hs,'later normal delta',h=>{h.advance(3);h.delta(3,{af_dbfs:-1});});
});

{
  // Original assertions are unchanged. Supply only the existing candidate
  // status scheduler host port and register tests at the top level.
  const text=fs.readFileSync(path.join(source,'tests/alert-history.test.cjs'),'utf8')
    .replace('  context.window = context;', '  context.window = context;context.DatyMqttScheduleArchiveStatus=render=>render();');
  new Function('require','__dirname',text)(require,path.join(candidate,'tests'));
}
