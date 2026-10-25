const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function context(){
  const c=vm.createContext({getDeviceChannelNumberSafe:d=>d.channel_number??null});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules/device-management.js'),'utf8'),c);return c;
}
test('device management has fixed 50-channel pages, CH numeric order and no source mutations',()=>{
  const c=context();
  for(const count of [0,1,49,50,51,100,101,205]){
    const data=Array.from({length:count},(_,i)=>({id:`rx_ch${count-i}`,channel_number:count-i}));
    const before=JSON.stringify(data),seen=[];
    const pages=c.getManagedDevicePage(data).pageCount;
    for(let p=1;p<=pages;p++){
      const result=c.getManagedDevicePage(data,p);seen.push(...result.devices.map(d=>d.channel_number));
      assert.equal(result.devices.length,p<pages?50:count-(p-1)*50);
    }
    assert.deepEqual(seen,Array.from({length:count},(_,i)=>i+1));assert.equal(JSON.stringify(data),before);
  }
});
test('equal CH on distinct receivers is retained, unknown CH last, shrinking data clamps pages',()=>{
  const c=context(),data=[{id:'a_ch10',channel_number:10},{id:'a_ch1',channel_number:1},
    {id:'b_ch1',channel_number:1},{id:'unknown'}];
  assert.deepEqual(Array.from(c.getManagedDevicePage(data,99).devices,d=>d.id),['a_ch1','b_ch1','a_ch10','unknown']);
  assert.equal(c.getManagedDevicePage(data,-10).page,1);assert.equal(c.getManagedDevicePage(data,Infinity).page,1);
});
