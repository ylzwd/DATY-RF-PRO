'use strict';
// Read-only candidate/patch verification. No build, server, DB or socket here.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const candidate=require('../scripts/c2-candidate.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const original=Buffer.from('first\r\nanchor\r\nlast\r\n');
const patch=()=>({schemaVersion:1,stage:'c2-integration',normalization:'lf',source:'mqtt-bridge.py',
  sourceSha256:hash(original),changes:[{id:'single',before:'anchor\n',after:'replacement\n'}]});
test('candidate patch checks original raw digest then normalizes only candidate line endings',()=>{
  assert.equal(candidate.applyPatch(original,patch()).toString(),'first\nreplacement\nlast\n');
  assert.equal(original.toString(),'first\r\nanchor\r\nlast\r\n');
  assert.throws(()=>candidate.applyPatch(Buffer.from('changed'),patch()),/source changed/);
  assert.throws(()=>candidate.applyPatch(candidate.applyPatch(original,patch()),patch()),/source changed/);
});
test('candidate patch cannot silently apply missing/duplicate anchors or unexpected targets',()=>{
  const missing=patch();missing.changes[0].before='missing';assert.throws(()=>candidate.applyPatch(original,missing),/not unique/);
  const duplicate=patch();duplicate.changes[0].before='r';assert.throws(()=>candidate.applyPatch(original,duplicate),/not unique/);
  for(const source of ['../FAshe/index.html','daty-rf.sqlite3','access_control.py']) {
    assert.throws(()=>candidate.applyPatch(original,{...patch(),source}),/Invalid/);
  }
  const ids=patch();ids.changes.push({...ids.changes[0]});assert.throws(()=>candidate.applyPatch(original,ids),/Invalid/);
  const noop=patch();noop.changes[0].after='anchor\r\n';assert.throws(()=>candidate.applyPatch(original,noop),/must not be empty/);
});
test('candidate output cannot be a workspace, archive, existing directory or arbitrary temp target',()=>{
  for(const directory of [candidate.ROOT,path.dirname(candidate.ROOT),os.tmpdir(),
    path.join(os.tmpdir(),'another-task'),path.join(candidate.ROOT,'daty-c2-candidate-unsafe')]) {
    assert.throws(()=>candidate.validateDestination(directory),/NEW direct/);
  }
});
test('reviewed release includes exact public assets and source only, never business data or secrets',()=>{
  const result=candidate.prepare();
  for(const name of result.files.keys()) {
    assert.doesNotMatch(name,/\.sqlite|\.db$|-wal$|-shm$|\.pem$|\.key$|\.pfx$|access.*json$|\.log$|FAshe\//i);
  }
  for(const name of ['src/platform/project-sync.js','src/platform/project-concurrency.js',
    'src/modules/planning-project-storage.js','project_api.py','mqtt-bridge.py']) assert.ok(result.files.has(name));
  for(const entry of result.changes) {
    assert.equal(hash(fs.readFileSync(path.join(candidate.ROOT,entry.source))),entry.sourceSha256,'Production source stays unchanged');
    assert.equal(hash(result.files.get(entry.source)),entry.candidateSha256);
  }
});
test('candidate HTML only adds project scripts/bootstrap and cache queries, never changes UI',()=>{
  const html=candidate.prepare().files.get('unirf-app.html').toString('utf8');
  const normalize=source=>source.replace(/\r\n/g,'\n').replace(/(<script\b[^>]*\bsrc=["'][^"'?]+)\?[^"']*(?=["'])/gi,'$1');
  const reduced=html
    .replace(/<script src="src\/platform\/project-(?:concurrency|sync)\.js\?[^"\n]+"><\/script>\n/g,'')
    .replace(/<script src="src\/modules\/planning-project-storage\.js\?[^"\n]+"><\/script>\n/g,'')
    .replace('<script>DatyPlanningProjectStorageFactory.mount(globalThis);</script>\n','')
    .replace("  void DatyPlanningProjectStorage.start().catch(error => console.warn('[项目同步初始化]', error));\n",'');
  assert.equal(normalize(reduced),normalize(fs.readFileSync(path.join(candidate.ROOT,'unirf-app.html'),'utf8')));
});
