'use strict';
// Independent read-only release audit. No build, fixture server, DB or network.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const candidate=require('../scripts/c2-candidate.cjs');
const lf=value=>value.replace(/\r\n/g,'\n');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const source=name=>fs.readFileSync(path.join(candidate.ROOT,name),'utf8');
const assets=text=>[...text.match(/PUBLIC_ASSETS = frozenset\(\{([\s\S]*?)\}\)/)[1]
  .matchAll(/"([^"]+)"/g)].map(item=>item[1]).sort();

test('independent audit: prepare performs no filesystem writes or process launches',t=>{
  const forbidden=()=>{throw Error('read-only candidate audit attempted a mutation');};
  for(const name of ['writeFileSync','mkdirSync','appendFileSync','copyFileSync','renameSync','rmSync','unlinkSync']) {
    t.mock.method(fs,name,forbidden);
  }
  const child=require('node:child_process');
  for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])t.mock.method(child,name,forbidden);
  const result=candidate.prepare();
  assert.ok(result.files.size>0);
  assert.throws(()=>candidate.build(candidate.ROOT),/NEW direct/,'workspace rejected before any writes');
});

test('independent audit: web release adds exactly three JS assets without changing request confinement',()=>{
  const result=candidate.prepare(),original=lf(source('web-service.py'));
  const built=result.files.get('web-service.py').toString('utf8');
  const prior=assets(original),next=assets(built);
  const added=next.filter(name=>!prior.includes(name));
  assert.deepEqual(added,[
    'src/modules/planning-project-storage.js',
    'src/platform/project-concurrency.js',
    'src/platform/project-sync.js'
  ]);
  assert.deepEqual(prior.filter(name=>!next.includes(name)),[]);
  const strip=text=>text.replace(/PUBLIC_ASSETS = frozenset\(\{[\s\S]*?\}\)/,'PUBLIC_ASSETS = <reviewed-manifest>');
  assert.equal(strip(built),strip(original),'GET/HEAD, path confinement, MIME and TLS handling stay byte-identical modulo LF');
  for(const privateName of ['daty-rf.sqlite3','daty-rf.sqlite3-wal','daty-rf.sqlite3-shm',
    'mqtt-config.json','local-ip.json','access-control.json','receiver-pairings.json',
    'tls-config.json','project_api.py','project_store.py','mqtt-bridge.py']) {
    assert.equal(next.includes(privateName),false,privateName+' must not become a web asset');
  }
});

test('independent audit: candidate contains no business data, security materials, config or logs',()=>{
  const result=candidate.prepare();
  for(const name of result.files.keys()) {
    assert.match(name,/\.(?:py|js|html|css|png)$/i,'only explicit source/public asset types');
    assert.doesNotMatch(name,/(?:^|\/)(?:data|security|logs|FAshe|归档)(?:\/|$)/i);
    assert.doesNotMatch(name,/\.(?:json|sqlite3?|db|pem|key|pfx|p12|cer|crt|log)$|-(?:wal|shm)$/i);
  }
  for(const name of candidate.BACKEND)assert.ok(result.files.has(name),'explicit backend source '+name);
});

test('independent audit: project hooks install after storage and before planning, start after access',()=>{
  const html=candidate.prepare().files.get('unirf-app.html').toString('utf8');
  const at=value=>{const index=html.indexOf(value);assert.ok(index>=0,value);return index;};
  const storage=at('src/modules/storage.js?'),platform=at('src/platform/browser-platform.js?');
  const concurrency=at('src/platform/project-concurrency.js?'),sync=at('src/platform/project-sync.js?');
  const adapter=at('src/modules/planning-project-storage.js?'),mount=at('DatyPlanningProjectStorageFactory.mount(globalThis)');
  const planning=at('src/modules/planning-ui.js?'),dialogs=at('src/modules/dialogs.js?');
  const access=at('  DatyAccessFactory.mountBrowserUI(globalThis, {');
  const start=at('  void DatyPlanningProjectStorage.start()');
  assert.ok(platform<storage&&storage<concurrency&&concurrency<sync&&sync<adapter&&adapter<mount&&mount<planning);
  assert.ok(dialogs<access&&access<start);
  assert.equal((html.match(/DatyPlanningProjectStorageFactory\.mount\(globalThis\)/g)||[]).length,1);
  assert.equal((html.match(/DatyPlanningProjectStorage\.start\(/g)||[]).length,1);
  assert.ok(html.lastIndexOf("document.addEventListener('DOMContentLoaded'",start)>dialogs);
  for(const match of html.matchAll(/<script\b[^>]*src="src\/(?:platform\/project-(?:concurrency|sync)|modules\/planning-project-storage)\.js[^>]*>/g)) {
    assert.doesNotMatch(match[0],/\b(?:async|defer|type=['"]module['"])/i,'classic ordered global bindings are preserved');
  }
});

test('independent audit: protected control, FAshe client, algorithms, layout and original storage are unchanged',()=>{
  const result=candidate.prepare();
  for(const name of ['src/modules/storage.js','src/modules/navigation.js','src/modules/fashe.js',
    'src/modules/planning-deploy.js','src/modules/deploy-progress.js','src/modules/frequency.js',
    'src/modules/coordination.js','src/modules/equipment-profiles.js','src/modules/device-views.js',
    'src/styles/main.css','src/styles/deploy-progress.css','src/styles/access.css','access_control.py',
    'receiver_pairing.py','receiver_enrollment.py','tls_support.py']) {
    assert.equal(digest(result.files.get(name)),digest(fs.readFileSync(path.join(candidate.ROOT,name))),name);
  }
  const setter=source('src/modules/storage.js').match(/function setPlanningSaveStatus\([\s\S]*?\n\}/)[0];
  assert.match(setter,/element\.textContent = message/);
  assert.doesNotMatch(setter,/innerHTML|outerHTML|insertAdjacentHTML/);
  for(const file of ['c2-planning-status.json','c2-history-status.json']) {
    const spec=JSON.parse(source('patches/'+file));
    for(const change of spec.changes) {
      assert.match(change.after,/setPlanningSaveStatus\(/);
      assert.doesNotMatch(change.after,/\b(?:fetch|request|eval|Function|sendTrackedDeviceCommand)\s*\(|(?:innerHTML|outerHTML)\s*=/);
    }
  }
});

test('independent audit: UTF-8 BOM and non-ASCII source survive candidate LF normalization',()=>{
  const original=Buffer.from('\ufeff标题\r\nanchor\r\n正文🎤\r\n');
  const spec={schemaVersion:1,stage:'c2-integration',normalization:'lf',source:'mqtt-bridge.py',
    sourceSha256:digest(original),changes:[{id:'replace',before:'anchor\r\n',after:'replacement\r\n'}]};
  const built=candidate.applyPatch(original,spec);
  assert.deepEqual([...built.subarray(0,3)],[0xef,0xbb,0xbf]);
  assert.equal(built.toString('utf8'),'\ufeff标题\nreplacement\n正文🎤\n');
  assert.equal(original.toString('utf8'),'\ufeff标题\r\nanchor\r\n正文🎤\r\n');
});
