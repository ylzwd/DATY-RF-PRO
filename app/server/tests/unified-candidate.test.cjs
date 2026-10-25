'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const builder=require('../scripts/unified-candidate.cjs');
test('candidate contains reviewed source and explicit assets, never business or security materials',()=>{
  const candidate=builder.prepare();
  for(const name of candidate.files.keys())assert.ok(!/\.(sqlite3?|db|log|pem|key|pfx|p12|crt)$|-wal$|-shm$|(?:^|\/)security\//i.test(name),name);
  assert.equal(candidate.files.has('unified_database.py'),true);assert.equal(candidate.files.has('unified_api.py'),true);
  assert.equal(candidate.files.has('src/app/business-database.js'),true);
});
test('every new JS is valid and static-only UI/control baselines are preserved',()=>{
  const candidate=builder.prepare();
  for(const [name,bytes]of candidate.files)if(name.endsWith('.js'))new vm.Script(bytes.toString('utf8'),{filename:name});
  for(const name of ['src/modules/fashe.js','src/platform/browser-platform.js'])assert.deepEqual(candidate.files.get(name),fs.readFileSync(path.join(candidate.root,name)),name);
  for(const [name,bytes]of candidate.files)if(/\.(css|svg|png)$/.test(name))assert.deepEqual(bytes,fs.readFileSync(path.join(candidate.root,name)),name);
});
test('database primitives and unified project factory load once before planning mount',()=>{
  const html=builder.prepare().files.get('unirf-app.html').toString('utf8');
  for(const name of ['database-client','database-batch-client','unified-project-sync']){
    const needle='src/platform/'+name+'.js';assert.equal(html.split(needle).length,2,name);
    assert.ok(html.indexOf(needle)<html.indexOf('DatyPlanningProjectStorageFactory.mount(globalThis)'));
  }
  assert.ok(html.indexOf('DatyBusinessDatabaseFactory.mount(globalThis)')>html.indexOf('DatyAccessFactory.mountBrowserUI(globalThis'));
});
test('all new UI dependencies are on exact static whitelist, backend modules are not',()=>{
  const candidate=builder.prepare();
  for(const name of ['src/platform/database-client.js','src/platform/database-batch-client.js','src/platform/unified-project-sync.js','src/platform/alert-database.js','src/app/alert-database.js'])assert.ok(candidate.assets.includes(name),name);
  for(const name of builder.BACKEND)assert.ok(!candidate.assets.includes(name),name);
});
test('unknown stages, sources, duplicate and missing anchors fail closed',()=>{
  const patch={schemaVersion:1,stage:'unified-database',source:'mqtt-bridge.py',sourceSha256:'a'.repeat(64),normalization:'lf',changes:[{id:'one',before:'old',after:'new'}]};
  assert.equal(builder.applyChanges(Buffer.from('old'),patch).toString(),'new');
  for(const invalid of [{...patch,stage:'unreviewed'}, {...patch,source:'data.sqlite3'}, {...patch,changes:[]}, {...patch,changes:[patch.changes[0],patch.changes[0]]}])assert.throws(()=>builder.applyChanges(Buffer.from('old'),invalid));
  assert.throws(()=>builder.applyChanges(Buffer.from('old old'),patch));assert.throws(()=>builder.applyChanges(Buffer.from('absent'),patch));
});
test('candidate core routes after the existing origin gate, never inside receiver enrollment',()=>{
  const bridge=builder.prepare().files.get('mqtt-bridge.py').toString('utf8');
  const post=bridge.slice(bridge.indexOf('    def do_POST(self):'));
  assert.ok(post.indexOf("if not self._check_origin():")<post.indexOf("business_api.handle(self, 'POST'"));
  assert.ok(post.indexOf("business_api.handle(self, 'POST'")<post.indexOf('request_body = self._read_access_json()'));
  assert.match(bridge,/business_bootstrap\.initialize\(connection, int\(now \* 1000\)\)/);
  const init=bridge.slice(bridge.indexOf('def _init_database():'),bridge.indexOf('def _json_text'));
  assert.ok(!init.includes('connection.executescript('),'No implicit DDL before strict bootstrap');
  assert.ok(init.indexOf('business_bootstrap.initialize')<init.indexOf('business_bootstrap.enable_wal'));
});
