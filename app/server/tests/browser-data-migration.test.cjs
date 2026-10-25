'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const migration=require('../src/platform/browser-data-migration.js');
function storage(initial={}){
  const data=new Map(Object.entries(initial));let writes=0,failAt=0;
  return {data,getItem:key=>data.get(key)??null,setItem(key,value){if(++writes===failAt)throw new Error('quota');data.set(key,value);},
    removeItem:key=>data.delete(key),failAfter(count){failAt=writes+count;}};
}
function backup(values){return {format:migration.FORMAT,version:1,sourceOrigin:'http://localhost:8080',values};}
test('migration module load has no I/O and exports a native-reusable pure contract',()=>{
  const c={URL};for(const name of ['fetch','document','localStorage','sessionStorage'])Object.defineProperty(c,name,{get(){throw new Error('unexpected '+name);}});
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/platform/browser-data-migration.js'),'utf8'),c);
  assert.equal(c.DatyBusinessMigration.FORMAT,migration.FORMAT);
});
test('export allowlists business keys, strips recognized nested credentials, never reads unrelated secrets or mutates source',()=>{
  const original={daty_devices:'[{"ch":"CH1","password":"secret","nested":{"access_token":"secret","name":"performer"}}]',
    daty_planning_history_v1:'{"records":[]}',daty_fashe_api_url:'https://127.0.0.1:8802',daty_operator_token:'secret',specStartFreq:'640.000'};
  const source=storage(original),seen=[],port={getItem(key){seen.push(key);return source.getItem(key);}};
  const result=migration.snapshot(port,'http://localhost:8080/unirf-app.html');
  assert.ok(seen.every(key=>migration.KEYS.includes(key)));assert.equal(result.sourceOrigin,'http://localhost:8080');
  assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!Object.hasOwn(result.values,'daty_fashe_api_url'));
  assert.deepEqual(JSON.parse(result.values.daty_devices),[{ch:'CH1',nested:{name:'performer'}}]);
  assert.deepEqual(Object.fromEntries(source.data),original);
});
test('input rejects secret/unknown keys, malformed business types, poison keys, oversize and invalid ranges before writes',()=>{
  for(const values of [{daty_operator_token:'x'},{daty_devices:'{}'},{daty_planning_history_v1:'[]'},
    {daty_devices:'[{"credentials":"x"}]'},{daty_alerts:'[{"__proto__":{"x":1}}]'},{specStartFreq:'Infinity'},{specEndFreq:'9001'}]){
    assert.throws(()=>migration.parse(JSON.stringify(backup(values))));
  }
  assert.throws(()=>migration.parse(' '.repeat(migration.MAX_CHARS+1)));
  assert.throws(()=>migration.parse('{"format":"other","values":{}}'));
});
test('default import preserves current HTTPS data and requires explicit confirmation for missing keys too',()=>{
  const target=storage({daty_alerts:'[{"message":"new"}]'}),data=backup({daty_alerts:'[{"message":"old"}]',specStartFreq:'640'});
  const plan=migration.prepare(target,data);assert.equal(plan.kept.length,1);assert.equal(plan.writes.length,1);
  assert.throws(()=>migration.apply(target,plan),/确认/);assert.equal(target.getItem('specStartFreq'),null);
  assert.deepEqual(migration.apply(target,plan,{confirmed:true}),{written:1,kept:1});
  assert.equal(target.getItem('daty_alerts'),'[{"message":"new"}]');assert.equal(target.getItem('specStartFreq'),'640');
});
test('overwrite is explicit, pre-import snapshot remains recoverable, and changed data aborts the entire plan',()=>{
  const target=storage({specStartFreq:'470'}),before=migration.snapshot(target,'https://localhost:8080');
  const plan=migration.prepare(target,backup({specStartFreq:'640'}),{overwrite:true});
  target.setItem('specStartFreq','500');assert.throws(()=>migration.apply(target,plan,{confirmed:true}),/已变化/);
  assert.equal(target.getItem('specStartFreq'),'500');
  migration.apply(target,migration.prepare(target,backup({specStartFreq:'640'}),{overwrite:true}),{confirmed:true});
  assert.equal(target.getItem('specStartFreq'),'640');
  migration.apply(target,migration.prepare(target,before,{overwrite:true}),{confirmed:true});assert.equal(target.getItem('specStartFreq'),'470');
});
test('quota failure rolls completed writes back without deleting unrelated existing data',()=>{
  const target=storage({specStartFreq:'470',unrelated:'keep'});
  const before=Object.fromEntries(target.data),plan=migration.prepare(target,backup({specStartFreq:'640',specEndFreq:'690'}),{overwrite:true});
  target.failAfter(2);assert.throws(()=>migration.apply(target,plan,{confirmed:true}),/已回退/);
  assert.deepEqual(Object.fromEntries(target.data),before);
});
test('migration page has explicit overwrite and dialog confirmation, loads no application runtime or external scripts',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../browser-data-migration.html'),'utf8');
  assert.match(html,/<dialog id="migrationConfirm"/);assert.match(html,/id="migrationOverwrite" type="checkbox"/);
  assert.doesNotMatch(html,/src=["'](?:https?:)?\/\//i);assert.doesNotMatch(html,/src\/modules\//);
  const source=fs.readFileSync(path.join(__dirname,'../src/platform/browser-data-migration.js'),'utf8');
  assert.doesNotMatch(source,/\b(?:fetch|WebSocket|EventSource)\s*\(/);
  assert.match(source,/const secure=browser\.location\.protocol==='https:'/);
});
test('old allowlisted probe path embeds exactly the maintained migration core and suppresses autoconnect in export mode',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../ws-probe.html'),'utf8').replace(/\r\n/g,'\n');
  const source=fs.readFileSync(path.join(__dirname,'../src/platform/browser-data-migration.js'),'utf8').replace(/\r\n/g,'\n').trimEnd();
  const start='// BEGIN GENERATED BUSINESS MIGRATION CORE (source: src/platform/browser-data-migration.js)\n';
  const end='\n// END GENERATED BUSINESS MIGRATION CORE';
  assert.equal(html.split(start)[1].split(end)[0],source);
  assert.match(html,/business-migration/);
  assert.match(html,/DOMContentLoaded[\s\S]*?if \(globalThis\.DATY_MIGRATION_ONLY\) return/);
});
