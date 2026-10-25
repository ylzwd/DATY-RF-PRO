const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const platform=require('../src/platform/browser-platform.js');
const code=fs.readFileSync(path.join(__dirname,'../src/modules/fashe.js'),'utf8');
function harness(saved){
  const listeners={},changes={},input={value:'https://127.0.0.1:8802',addEventListener:(n,f)=>changes[n]=f};
  const storage=new Map(saved===undefined?[]:[['daty_fashe_api_url',saved]]);
  const c=vm.createContext({URL,performance,DatyPlatformFactory:platform,console:{log(){},warn(){},error(){}},setTimeout(){return 1;},
    document:{getElementById:()=>input,addEventListener:(n,f)=>listeners[n]=f},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}});
  vm.runInContext(code,c);return {c,listeners,input,changes,storage};
}
test('local Bridge default and saved localhost select direct IPv4 before SSE or commands start',()=>{
  const {c,listeners,input,storage}=harness('http://localhost:8802/');
  listeners.DOMContentLoaded();
  assert.equal(vm.runInContext('_fasheApiUrl',c),'https://127.0.0.1:8802');
  assert.equal(input.value,'https://127.0.0.1:8802');assert.equal(storage.get('daty_fashe_api_url'),input.value);
  assert.equal(vm.runInContext('_fasheApiUrl',harness().c),'https://127.0.0.1:8802');
});
test('remote HTTP8802 migrates scheme only, secure custom endpoints retain host and port',()=>{
  for (const [url,expected] of [['http://192.0.2.16:8802','https://192.0.2.16:8802'],
    ['https://localhost:8802','https://127.0.0.1:8802'],
    ['https://bridge.local:9443','https://bridge.local:9443'],
    ['http://[::1]:8802','https://[::1]:8802']]) {
    const {c,listeners,input}=harness(url);listeners.DOMContentLoaded();
    assert.equal(vm.runInContext('_fasheApiUrl',c),expected);assert.equal(input.value,expected);
  }
});
test('editing old localhost URL normalizes the saved setting; invalid values are not guessed',()=>{
  const {c,listeners,input,changes,storage}=harness();listeners.DOMContentLoaded();
  input.value=' HTTP://LOCALHOST:8802 ';changes.change();
  assert.equal(input.value,'https://127.0.0.1:8802');assert.equal(storage.get('daty_fashe_api_url'),input.value);
  assert.throws(()=>c.normalizeFasheApiUrl('not a URL'));
});
