const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function context(){
 const controls={filterBrandChannels:{value:'all'},filterStatusChannels:{value:'all'},sortChannels:{value:'ch'}};
 const c=vm.createContext({getPlannerReceiverGroupNumber:()=>null,DEVICES:[],document:{getElementById:id=>controls[id]||null},
  getDeviceChannelNumberSafe:d=>d.channel_number??null,getDeviceDisplayStatus:d=>d.status});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules/device-views.js'),'utf8'),c);return {c,controls};
}
test('device views paginate 20/50 across empty, exact, partial and large lists without mutation',()=>{
 const {c}=context();for(const size of [20,50])for(const count of [0,1,19,20,21,49,50,51,100,101,205]){
  const data=Array.from({length:count},(_,i)=>({id:i})),before=JSON.stringify(data),all=[];
  const pages=c.deviceViewPage(data,size).pageCount;
  for(let p=1;p<=pages;p++){const view=c.deviceViewPage(data,size,p);all.push(...view.devices);assert.equal(view.devices.length,Math.min(size,count-(p-1)*size));}
  assert.equal(JSON.stringify(all),before);assert.equal(JSON.stringify(data),before);
  assert.equal(c.deviceViewPage(data,size,Infinity).page,pages);assert.equal(c.deviceViewPage(data,size,-99).page,1);
 }
});
test('display sort is numeric, stable for receiver same-CH, unknown values last',()=>{
 const {c}=context(),data=[{id:'a10',channel_number:10},{id:'a1',channel_number:1},{id:'b1',channel_number:1},{id:'x',rf:null}];
 assert.deepEqual(Array.from(c.sortDeviceView(data),d=>d.id),['a1','b1','a10','x']);
 assert.deepEqual(Array.from(c.sortDeviceView([{rf:-90},{rf:null},{rf:-30}], 'rf'),d=>d.rf),[-30,-90,null]);
 assert.deepEqual(data.map(d=>d.id),['a10','a1','b1','x']);
});
test('realtime filtering preserves page; filter or sort change resets it and keeps both filters',()=>{
 const {c,controls}=context();c.DEVICES=Array.from({length:101},(_,i)=>({id:i,channel_number:i+1,brand:i%2?'DATYaudio':'Shure',status:'online',freq:640000+i*25}));
 c.getFilteredChannelView();vm.runInContext('channelCardsView.page=2',c);
 assert.equal(c.getFilteredChannelView().length,101);assert.equal(vm.runInContext('channelCardsView.page',c),2);
 controls.filterBrandChannels.value='DATYaudio';assert.equal(c.getFilteredChannelView().length,50);assert.equal(vm.runInContext('channelCardsView.page',c),1);
 controls.sortChannels.value='freq';assert.equal(c.getFilteredChannelView().length,50);
 controls.filterStatusChannels.value='offline';assert.equal(c.getFilteredChannelView().length,0);
});
test('page clamps after removal without deleting remaining devices',()=>{
 const {c}=context();vm.runInContext('channelCardsView.page=5',c);
 const devices=Array.from({length:51},(_,i)=>({id:i}));assert.equal(c.getVisibleChannelPage(devices).length,1);
 assert.equal(vm.runInContext('channelCardsView.page',c),2);assert.equal(devices.length,51);
});
