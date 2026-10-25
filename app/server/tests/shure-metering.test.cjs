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

test('changing meter frames reach channel state, meter widths and markup without smoothing or old AF fallback',()=>{
 const c=harness(),d=c._fasheNormalizeDevice(raw());c.DEVICES.push(d);
 for(let seq=1;seq<=50;seq++){
  const dbfs=-50+seq;
  c._fasheHandleDeviceUpdate([{...raw(),af_dbfs:dbfs>=-40?dbfs:null,
   shure:{...raw().shure,audio_dbfs:dbfs,meter_state:'live',meter_seq:seq,meter_stream_id:'test',meter_received_at_ms:Date.now()}}]);
  assert.equal(c.getAfMeter(d).dbfs,dbfs);assert.ok(Math.abs(c.getAfMeter(d).percent-seq*2)<1e-9);
  assert.ok(c.createChannelCardHTML(d).includes(dbfs.toFixed(1)+' dBFS'));
 }
 for(const state of ['connecting','stale','disconnected']){
  c._fasheHandleDeviceUpdate([{id:raw().id,shure:{...d.shure,meter_state:state}}]);
  assert.equal(c.getAfMeter(d).available,false);assert.equal(c.getAfMeter(d).percent,0);
 }
 d.shure.meter_state='live';d._online=false;assert.equal(c.getAfMeter(d).available,false);
});
