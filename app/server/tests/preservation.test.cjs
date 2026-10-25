'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const gate=require('../scripts/check-preservation.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const html='<script src="src/a.js?v=before"></script>\n<div>CH1</div>';
function fixture(){return {schemaVersion:1,files:[{path:'FAshe/index.html',sha256:hash('receiver')}],
  ui:{path:'fuwuqi1.0.3/unirf-app.html',normalization:'lf-and-script-cache-query-v1',sha256:hash(gate.normalizeUI(html))}};}
test('protected production/runtime and UI match the user-confirmed scan baseline',()=>assert.deepEqual(gate.check().changed,[]));
test('a receiver change is rejected, never auto-baselined',()=>{
 const manifest=fixture(),before=JSON.stringify(manifest);
 assert.deepEqual(gate.validate(manifest,name=>Buffer.from(name.startsWith('FAshe')?'changed':html)).changed,['FAshe/index.html']);
 assert.equal(JSON.stringify(manifest),before);
});
test('only cache query/line ending edits pass the UI gate, not layout or script swaps',()=>{
 assert.equal(gate.normalizeUI(html.replace('before','after').replaceAll('\n','\r\n')),gate.normalizeUI(html));
 for(const modified of [html.replace('CH1','CH2'),html.replace('a.js','b.js'),html+'<style>body{color:red}</style>']){
  assert.deepEqual(gate.validate(fixture(),name=>Buffer.from(name.startsWith('FAshe')?'receiver':modified)).changed,['fuwuqi1.0.3/unirf-app.html']);
 }
});
test('missing files, invalid manifests and escape paths cannot pass',()=>{
 assert.equal(gate.validate(fixture(),()=>{throw Error('missing');}).changed.length,2);
 for(const target of ['FAshe/../secret','FAshe//index.html','C:/secret','FAshe/a\\b']){
  const manifest=fixture();manifest.files[0].path=target;assert.throws(()=>gate.validate(manifest,()=>{throw Error('must not read');}),/Invalid/);
 }
});
