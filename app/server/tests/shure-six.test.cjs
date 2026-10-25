'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const base=process.env.DATY_TEST_ASSET_ROOT || path.join(__dirname,'..');
function harness(){
 const c=vm.createContext({DEVICES:[],ALERTS:[],console,Date,performance,setTimeout,clearTimeout,
 document:{readyState:'loading',addEventListener(){},getElementById(){return null}},localStorage:{getItem:()=>null,setItem(){}},
 DatyFrequency:{frequencyFromPayload:(d,prev=null)=>d.freq??prev,formatFrequencyMHz:v=>(v/1000).toFixed(3)}});
 c.window=c;c.addEventListener=()=>{};c.setInterval=()=>1;c.clearInterval=()=>{};
 for(const m of ['dashboard','render','fashe','discovery'])vm.runInContext(fs.readFileSync(path.join(base,'src/modules',m+'.js'),'utf8'),c);
 c._fasheUpdateUI=()=>{};c.renderAlerts=()=>{};c.updateDashboardStats=()=>{};c.saveDataToStorage=()=>{};
 c.archived=[];c.queueAlertForArchive=(a,state)=>c.archived.push({...a,archiveState:state||'active'});
 c.getAlerts=()=>vm.runInContext('ALERTS',c);return c;
}
const raw=(s={})=>({id:'Shure-ULXD4-192.0.2.5_ch1',receiver_id:'Shure-ULXD4-192.0.2.5',receiver_ip:'192.0.2.5',
 brand:'Shure',model:'ULXD4',_source:'shure-scp',_online:true,status:'online',channel_number:1,
 group_number:2,group_source:'server-fifo-v1',freq:677450,rf:-40,af_dbfs:-20,batt:null,muted:false,
 shure:{schema:'daty-shure-telemetry-v1',audio_dbfs:-20,meter_state:'live',battery_bars:4,battery_percent:null,
 battery_runtime_status:'known',transmitter_type:'ULXD2',transmitter_muted:false,receiver_muted:false,
 interference:'NONE',encryption_warning:'OFF',stale_fields:[],...s}});

test('low bars are independently configurable, zero is valid, measured percent takes precedence',()=>{
 const c=harness(),d=c._fasheNormalizeDevice(raw({battery_bars:0}));
 for(const b of [0,1,2,5]){d.shure.battery_bars=b;const issues=c.getDeviceThresholdIssues(d);
  assert.equal(issues.some(x=>x.metric==='battery_bars'),b<=1);assert.equal(c.getBatteryMeter(d).label,`${b}/5格`);}
 c.setAlertThresholdSettings({batteryLowBars:3});d.shure.battery_bars=2;assert(c.getDeviceThresholdIssues(d).some(x=>x.metric==='battery_bars'));
 d.batt=80;assert.equal(c.getDeviceThresholdIssues(d).some(x=>x.metric==='battery_bars'),false);
 d.batt=0;assert(c.getDeviceThresholdIssues(d).some(x=>x.metric==='battery'));assert.equal(c.getBatteryMeter(d).label,'0%');
});
test('three receiver fault types become separate issues; unknown/calculating are not invented faults',()=>{
 const c=harness(),d=c._fasheNormalizeDevice(raw({battery_runtime_status:'error',interference:'CRITICAL',encryption_warning:'ON'}));
 assert.deepEqual(Array.from(c.getDeviceThresholdIssues(d),x=>x.metric).sort(),['battery_error','encryption_mismatch','rf_interference']);
 Object.assign(d.shure,{battery_runtime_status:'calculating',interference:null,encryption_warning:null});assert.equal(c.getDeviceThresholdIssues(d).length,0);
});
test('abnormal, unchanged, unknown, recovery and retrigger preserve separate lifecycle edges',()=>{
 const c=harness(),d=c._fasheNormalizeDevice(raw());
 const update=(value,stale=[])=>{d.shure={...d.shure,interference:value,stale_fields:stale};return c.evaluateRealtimeAlerts([d],{changedDevices:[d],recommendationRefresh:false});};
 assert.equal(update('CRITICAL').added,1);const first=c.getAlerts()[0].firstSeen;
 assert.equal(update('CRITICAL').added,0);assert.equal(c.getAlerts()[0].firstSeen,first);
 assert.equal(update(null).removed,0);assert.match(c.getAlerts()[0].msg,/状态待确认/);
 assert.equal(update('NONE',['interference']).removed,0);
 assert.equal(update('NONE').removed,1);assert.equal(update('CRITICAL').added,1);
 assert.equal(c.archived.filter(x=>x.archiveState==='ended').length,1);
});
test('meter stale does not discard fresh battery; expired metadata does not present a current measurement',()=>{
 const c=harness(),d=c._fasheNormalizeDevice(raw({field_times:{battery_bars:1000},meter_state:'stale'}));
 assert.equal(c.getAfMeter(d).available,false);assert.equal(c.getBatteryMeter(d).label,'4/5格');
 d.shure.stale_fields=['battery_bars','battery_percent','battery_minutes','transmitter_type','transmitter_muted'];
 assert.equal(c.getBatteryMeter(d).label,'已过期');assert.match(c.getShureMuteLabel(d),/已过期/);
 assert.match(c.getBatteryMeter(d).title,/更新时间/);
});
test('AD4 primary and secondary RF branches, muted transmitter and AF scale survive frontend mapping',()=>{
 const c=harness(),r=raw({audio_dbfs:-101,audio_peak_dbfs:-90,transmitter_muted:true,antenna_status:'BR',
 rf_antennas_dbm:{1:-40,2:-50},rf_branches:{1:{antenna_status:'BR',rf_antennas_dbm:{1:-40,2:-50}},2:{antenna_status:'BB',rf_antennas_dbm:{1:-41,2:-51}}}});r.model='AD4D';
 const d=c._fasheNormalizeDevice(r);assert.equal(c.getAfMeter(d).dbfs,-101);assert.equal(d.shure.rf_branches['2'].antenna_status,'BB');
 assert.match(c.getShureStatusText(d),/天线1 -40 dBm/);assert.match(c.getShureMuteLabel(d),/已静音/);
});
test('special-character names remain text in channel, mic and equipment markup',()=>{
 const c=harness(),r=raw();r.name='A<>&"B';const d=c._fasheNormalizeDevice(r);
 const grid={innerHTML:''};c.DEVICES.push(d);c.document.getElementById=id=>id==='monitorGrid'?grid:null;
 c.renderMonitorGrid();assert(!grid.innerHTML.includes('A<>&"B'));assert(grid.innerHTML.includes('A&lt;&gt;&amp;&quot;B'));
});
