const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const fs=require('node:fs'),path=require('node:path');
const base=process.env.DATY_TEST_ASSET_ROOT || path.join(__dirname,'..');
function harness(){
 const c=vm.createContext({DEVICES:[],console,Date,performance,setTimeout,clearTimeout,
  document:{readyState:'loading',addEventListener(){},getElementById(){return null}},
  localStorage:{getItem:()=>null,setItem(){}},
  DatyFrequency:{frequencyFromPayload:(d,prev=null)=>d.freq??prev,formatFrequencyMHz:v=>(v/1000).toFixed(3)}});
 c.window=c;c.addEventListener=()=>{};c.setInterval=()=>1;c.clearInterval=()=>{};
 for(const module of ['dashboard','render','fashe','discovery'])vm.runInContext(fs.readFileSync(path.join(base,'src/modules',module+'.js'),'utf8'),c);
 c._fasheUpdateUI=()=>{};return c;
}
const raw=(extra={})=>({id:'Shure-ULXD4-192.0.2.5_ch1',receiver_id:'Shure-ULXD4-192.0.2.5',receiver_ip:'192.0.2.5',
 brand:'Shure',model:'ULXD4',_source:'shure-scp',_online:true,status:'online',channel_number:1,channel:1,
 group_number:2,group_source:'server-fifo-v1',freq:677450,rf:-40,af_dbfs:null,batt:null,muted:false,
 capabilities:{read_only:true,mute:false,write_frequency:false},shure:{schema:'daty-shure-telemetry-v1',
 audio_dbfs:-50,audio_floor_dbfs:-50,battery_bars:4,battery_percent:null,battery_minutes:null,battery_runtime_status:'unknown',
 battery_type:'LITH',receiver_muted:false,transmitter_muted:false,transmitter_type:'ULXD2'},...extra});

test('real ULXD floor and four bars survive frontend mapping without inventing canonical percentages',()=>{
 const c=harness(),d=c._fasheNormalizeDevice(raw());
 assert.equal(d.batt,null);assert.equal(d.afDbfs,null);assert.equal(c.getAfMeter(d).dbfs,-50);
 assert.equal(c.getAfMeter(d).available,true);assert.equal(c.getBatteryMeter(d).label,'4/5格');
 assert.match(c.getBatteryMeter(d).title,/百分比未知/);assert.equal(c.getPlannerReceiverGroupNumber(d),2);
 const html=c.createChannelCardHTML(d);assert.match(html,/-50\.0 dBFS/);assert.match(html,/4\/5格/);
 assert.match(html,/话筒 ULXD2 · 输出未静音 · 发射端未静音/);
 assert.doesNotMatch(html,/onclick="(?:muteDevice|unmuteDevice|editFreq)/);
});
test('explicit unknown clears old values and partial updates preserve vendor telemetry',()=>{
 const c=harness(),d=c._fasheNormalizeDevice(raw());c.DEVICES.push(d);
 c._fasheHandleDeviceUpdate([{id:raw().id,rf:-45}]);assert.equal(c.getBatteryMeter(d).label,'4/5格');
 c._fasheHandleDeviceUpdate([{id:raw().id,shure:{...raw().shure,audio_dbfs:null,battery_bars:null,transmitter_muted:null}}]);
 assert.equal(c.getAfMeter(d).available,false);assert.equal(c.getBatteryMeter(d).label,'—');
 assert.match(c.getShureStatusText(d),/发射端未知/);
});
test('measured percentage and time states are distinct from bars, no false battery alerts',()=>{
 const c=harness(),d=c._fasheNormalizeDevice(raw());
 assert.equal(c.getDeviceThresholdIssues(d).some(x=>x.metric==='battery'),false);
 for(const [state,label] of [['calculating','计算中'],['error','通讯错误'],['unknown','未知']]){
  d.shure.battery_runtime_status=state;assert.ok(c.getBatteryMeter(d).title.includes(label));
 }
 d.batt=17;d.shure.battery_minutes=125;assert.equal(c.getBatteryMeter(d).label,'17%');
 assert.match(c.getBatteryMeter(d).title,/2 小时 5 分钟/);
 assert.equal(c.getDeviceThresholdIssues(d).some(x=>x.metric==='battery'),true);
});
test('output and transmitter mute are independent, explicit unknown is not unmuted',()=>{
 const c=harness(),d=c._fasheNormalizeDevice(raw());
 d.shure.transmitter_muted=true;assert.equal(c.getChannelCardState(d).isMuted,true);
 assert.equal(c.getMuteControlState(d).label,'输出未静音');
 d.shure.receiver_muted=null;assert.equal(c.getMuteControlState(d).label,'输出静音未知');
 assert.match(c.getShureStatusText(d),/发射端静音/);
});
test('DATY validation remains minus40 to zero, Axient uses its own minus120 scale, forged vendor data ignored',()=>{
 const c=harness();assert.equal(c.getAfMeter({afDbfs:-50,brand:'DATYaudio'}).available,false);
 assert.equal(c.getAfMeter({afDbfs:-20,brand:'DATYaudio'}).percent,50);
 assert.equal(c.getAfMeter(raw({model:'AD4D',shure:{...raw().shure,audio_dbfs:-100}})).available,true);
 for(const value of [null,undefined,'-50',NaN,1,-51])assert.equal(c.getAfMeter(raw({shure:{...raw().shure,audio_dbfs:value}})).available,false);
 assert.equal(c.getAfMeter(raw({_source:'fake'})).available,false);
});
test('server receiver cards show actual Shure audio, battery and separate mute labels',()=>{
 const c=harness(),elements={receiverList:{innerHTML:''},receiverCount:{textContent:''}};
 c.document.getElementById=id=>elements[id]||null;
 c._renderReceiverList([{ip:'192.0.2.5',server_ip:'192.0.2.1',http_base:'https://192.0.2.1:8080',
  brand:'Shure',model:'ULXD4',discovered_via:'shure-scp',channels:[raw()]}]);
 assert.match(elements.receiverList.innerHTML,/AF -50\.0 dBFS/);
 assert.match(elements.receiverList.innerHTML,/4\/5格/);
 assert.match(elements.receiverList.innerHTML,/话筒 ULXD2 · 输出未静音 · 发射端未静音/);
});
