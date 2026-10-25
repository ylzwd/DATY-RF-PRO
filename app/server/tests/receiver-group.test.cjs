// Read-only source loading with in-memory device/storage fixtures. No network.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const fs=require('node:fs'),path=require('node:path');
const source=name=>fs.readFileSync(path.join(__dirname,'../src/modules',name+'.js'),'utf8');
function harness(){
 const stored={'mac:02:00:00:00:00:01':99};
 const c=vm.createContext({DEVICES:[],console,Date,performance,
  document:{readyState:'loading',addEventListener(){},getElementById(){return null}},
  localStorage:{getItem:()=>JSON.stringify(stored),setItem(){throw Error('server assignments must not write legacy map')}},
  DatyFrequency:{frequencyFromPayload:(d,prev=null)=>d.freq??prev}});
 c.window=c;
 for(const module of ['dashboard','render','fashe'])vm.runInContext(source(module),c);
 c._fasheUpdateUI=()=>{};return c;
}
const device=(mac='02:00:00:00:00:01',group=1,ch=1)=>({id:mac+'_ch'+ch,receiver_mac:mac,receiver_ip:'192.0.2.102',
 channel_number:ch,channel:ch,brand:'DATYaudio',group:999,group_number:group,group_source:'server-fifo-v1',_online:true});
test('server GROUP wins over browser local map and self-reported group',()=>{
 const c=harness();assert.equal(c.getReceiverGroupNumber(device()),1);
 assert.equal(c.getReceiverGroupNumber(device('02:00:00:00:00:01',1,8)),1);
 assert.equal(c.getReceiverGroupNumber(device('02:00:00:00:00:02',2)),2);
 assert.equal(c.getReceiverGroupNumber({...device(),group_number:0}),null);
});
test('normalization retains authoritative assignment and never derives CH from GROUP',()=>{
 const c=harness();const d=c._fasheNormalizeDevice(device('02:00:00:00:00:01',19,8));
 assert.equal(d.group_number,19);assert.equal(d.group_source,'server-fifo-v1');assert.equal(d.channel_number,8);
 assert.equal(c.formatGroupChannelDisplay(d),'GUP19 · CH8');
});
test('SSE delta updates GROUP on exact receiver and preserves it when fields are absent',()=>{
 const c=harness(),first=device(),second=device('02:00:00:00:00:02',2);
 c.DEVICES.push(c._fasheNormalizeDevice(first),c._fasheNormalizeDevice(second));
 c._fasheHandleDeviceUpdate([{...first,group_number:7}]);
 assert.equal(c.DEVICES[0].group_number,7);assert.equal(c.DEVICES[1].group_number,2);
 c._fasheHandleDeviceUpdate([{id:first.id,muted:true}]);
 assert.equal(c.DEVICES[0].group_number,7);assert.equal(c.DEVICES[0].muted,true);
 assert.equal(c.DEVICES[0].channel_number,1);
});
test('discovery and service snapshots keep the same server-assigned fields',()=>{
 for(const module of ['init','discovery']) {
  assert.match(source(module),/group_number:\s*d\.group_number/);
  assert.match(source(module),/group_source:\s*d\.group_source/);
 }
});

test('product display uses reported brand/model and never infers them from FAshe IDs or channel names',()=>{
 const c=harness();
 assert.equal(c.formatBrandModelDisplay({brand:'DATYaudio',model:'RF PRO',id:'FAshe-1',name:'Drummer'}),'DATYaudio RF PRO');
 assert.equal(c.formatBrandModelDisplay({brand:'Shure',model:'AD4D'}),'Shure AD4D');
 assert.equal(c.formatBrandModelDisplay({id:'FAshe-1',name:'Shure CH1'}),'未知品牌 未知型号');
 assert.equal(c.formatBrandModelDisplay({brand:' ',model:'--'}),'未知品牌 未知型号');
 const d=c._fasheNormalizeDevice({...device(),brand:null,model:null});
 assert.equal(d.brand,'未知品牌');assert.equal(d.model,'未知型号');
});

test('product summaries deduplicate channels, keep different models and bound only the display',()=>{
 const c=harness(),input=[{brand:'Shure',model:'AD4D'},{brand:'Shure',model:'AD4D'},{brand:'Shure',model:'ULXD4Q'},
  {brand:'DATYaudio',model:'RF PRO'}],before=JSON.stringify(input);
 assert.equal(c.formatReceiverProductSummary(input),'Shure AD4D / Shure ULXD4Q 等3种接收机');
 assert.equal(c.formatReceiverProductSummary(input,Infinity),'Shure AD4D / Shure ULXD4Q / DATYaudio RF PRO');
 assert.equal(c.formatReceiverProductSummary([]),'接收机');assert.equal(JSON.stringify(input),before);
});

test('product deltas refresh the exact receiver; omissions preserve and explicit null clears without rerouting',()=>{
 const c=harness(),a={...device(),model:'RF PRO'},b={...device('02:00:00:00:00:02',2),model:'DATY-X2'};
 c.DEVICES.push(c._fasheNormalizeDevice(a),c._fasheNormalizeDevice(b));
 const first=c.DEVICES[0],route=JSON.stringify([first.id,first._fasheId,first.group_number,first.channel_number]);
 c._fasheHandleDeviceUpdate([{id:a.id,brand:'AMSaudio',model:'GT6000'}]);
 assert.equal(first.brand,'AMSaudio');assert.equal(first.model,'GT6000');assert.equal(c.DEVICES[1].model,'DATY-X2');
 c._fasheHandleDeviceUpdate([{id:a.id,muted:true}]);assert.equal(first.model,'GT6000');
 c._fasheHandleDeviceUpdate([{id:a.id,model:null,brand:null}]);assert.equal(c.formatBrandModelDisplay(first),'未知品牌 未知型号');
 assert.equal(JSON.stringify([first.id,first._fasheId,first.group_number,first.channel_number]),route);
});
