'use strict';
// Run existing control/layout regressions against reviewed C2 candidate bytes.
// Existing test assertions and FAshe VM handlers are unchanged. No candidate is
// deployed; all browser HTTP is fulfilled/aborted and WebSockets are blocked.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const playwright=require('playwright');
const candidate=require('../scripts/c2-candidate.cjs').prepare();
const suites=['integrated-local-deploy','planning-deploy','realtime-control','device-views'];
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
function candidateFile(value){
  if(typeof value!=='string')return null;
  const name=path.relative(candidate.root,path.resolve(value)).split(path.sep).join('/');
  return candidate.files.has(name)?{name,bytes:candidate.files.get(name)}:null;
}
function proxy(target,overrides){return new Proxy(target,{get(object,key){
  if(Object.prototype.hasOwnProperty.call(overrides,key))return overrides[key];
  const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;
}});}
async function runSuite(name){
  const filename=path.join(__dirname,name+'.browser.cjs'),originalRequire=createRequire(filename);
  const served=new Set(),browsers=new Set(),denied=[];
  const fixtureProcess={env:process.env,platform:process.platform,exitCode:0};
  const fixtureFS=proxy(fs,{readFileSync(file,options){
    const selected=candidateFile(file);
    if(!selected)return fs.readFileSync(file,options);
    const encoding=typeof options==='string'?options:options?.encoding;
    return encoding?selected.bytes.toString(encoding):Buffer.from(selected.bytes);
  }});
  const fixturePlaywright={...playwright,chromium:proxy(playwright.chromium,{async launch(options){
    const browser=await playwright.chromium.launch(options);browsers.add(browser);
    return proxy(browser,{async newContext(options={}){
      const context=await browser.newContext({...options,serviceWorkers:'block'});
      // Original suites install their own catch-all mock after this deny route.
      // New unhandled request paths cannot accidentally reach any real server.
      await context.route('**/*',route=>{denied.push(route.request().url());return route.abort('blockedbyclient');});
      if(typeof context.routeWebSocket==='function')await context.routeWebSocket('**/*',socket=>socket.close());
      return proxy(context,{route(pattern,handler,options){
        return context.route(pattern,async(route,request)=>handler(proxy(route,{fulfill(options={}){
          const selected=candidateFile(options.path);
          if(!selected)return route.fulfill(options);
          served.add(selected.name);
          const {path:ignored,...rest}=options;
          return route.fulfill({...rest,body:Buffer.from(selected.bytes),
            contentType:rest.contentType||mime[path.extname(selected.name)]||'application/octet-stream'});
        },continue(){throw Error('Candidate regression cannot continue a real request');}}),request),options);
      }});
    },async close(){try{return await browser.close();}finally{browsers.delete(browser);}}});
  }})};
  function fixtureRequire(specifier){
      if(specifier==='node:fs'||specifier==='fs')return fixtureFS;
      if(specifier==='playwright')return fixturePlaywright;
      return originalRequire(specifier);
  }
  try{
    // Expose only the original top-level IIFE's Promise; all assertions remain
    // byte-identical. Compile in the same realm as Playwright's JSON results so
    // deepStrictEqual is not confused by cross-VM Array/Object prototypes.
    const source=fs.readFileSync(filename,'utf8');
    const entries=[...source.matchAll(/^\(async\s*\(\s*\)\s*=>\s*\{/gm)];
    assert.equal(entries.length,1,'Expected one original top-level async entry point');
    const executable=source.slice(0,entries[0].index)+'return '+source.slice(entries[0].index);
    const run=vm.compileFunction(executable,['require','__dirname','__filename','process','console'],{filename});
    const pending=run(fixtureRequire,__dirname,filename,fixtureProcess,console);
    assert.ok(pending&&typeof pending.then==='function','Expected unchanged async regression entry point');
    await pending;
    assert.equal(fixtureProcess.exitCode,0,name+' reported a failed original assertion');
    assert.deepEqual(denied,[],name+' had an unhandled request (blocked, never sent)');
    for(const file of ['unirf-app.html','src/platform/project-concurrency.js','src/platform/project-sync.js',
      'src/modules/planning-project-storage.js','src/modules/navigation.js','src/modules/fashe.js']){
      assert.ok(served.has(file),name+' must actually load candidate resource: '+file);
    }
    return {suite:name,candidateAssets:served.size,status:'passed',unhandledNetworkRequests:denied.length};
  }finally{
    for(const browser of browsers){try{await browser.close();}catch(_){/* ensure isolated test processes close */}}
  }
}
(async()=>{
  const results=[];
  for(const suite of suites)results.push(await runSuite(suite));
  console.log('PASS: reviewed C2 candidate HTML/resources preserve existing local/Bearer single/all deployment, unmodified FAshe VM ACK, mute/unmute, early ACK/POST cancellation, receiver isolation and five-size device layouts. All HTTP mocked/aborted; no live services or receivers.');
  console.log(JSON.stringify({status:'candidate-control-regressions-passed',results,candidateFiles:candidate.files.size,
    deployed:false,liveControlWrites:0}));
})().catch(error=>{console.error(error);process.exitCode=1;});
