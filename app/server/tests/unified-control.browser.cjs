'use strict';
// Full unified candidate bytes, existing assertions and unmodified FAshe VM
// handlers. A deliberately unavailable BUSINESS database must not break control.
// All HTTP is fulfilled/aborted; no listener, live receiver or browser profile.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),playwright=require('playwright');
const candidate=require('../scripts/unified-candidate.cjs').prepare();
// The old device-views suite expects immediate DEVICES.name mutation on Enter.
// That contradicts the new confirmed SQLite alias contract, not control fidelity;
// alias/focus/layout checks belong to the dedicated business UI regressions.
const suites=['integrated-local-deploy','planning-deploy','realtime-control'];
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
  const served=new Set(),browsers=new Set(),denied=[],databaseReads=[],databaseWrites=[];
  const fixtureProcess={env:process.env,platform:process.platform,exitCode:0};
  const fixtureFS=proxy(fs,{readFileSync(file,options){
    const selected=candidateFile(file);if(!selected)return fs.readFileSync(file,options);
    const encoding=typeof options==='string'?options:options?.encoding;
    return encoding?selected.bytes.toString(encoding):Buffer.from(selected.bytes);
  }});
  const fixturePlaywright={...playwright,chromium:proxy(playwright.chromium,{async launch(options){
    const browser=await playwright.chromium.launch(options);browsers.add(browser);
    return proxy(browser,{async newContext(options={}){
      const context=await browser.newContext({...options,serviceWorkers:'block'});
      await context.route('**/*',route=>{denied.push(route.request().url());return route.abort('blockedbyclient');});
      if(typeof context.routeWebSocket==='function')await context.routeWebSocket('**/*',socket=>socket.close());
      return proxy(context,{route(pattern,handler,options){
        return context.route(pattern,async(route,request)=>{
          if(new URL(request.url()).pathname.startsWith('/api/database/')){
            if(request.method()!=='GET'){databaseWrites.push(request.url());return route.abort('blockedbyclient');}
            databaseReads.push(request.url());return route.fulfill({status:503,json:{success:false,code:'DATABASE_FIXTURE_UNAVAILABLE'}});
          }
          return handler(proxy(route,{fulfill(options={}){
            const selected=candidateFile(options.path);if(!selected)return route.fulfill(options);
            served.add(selected.name);const {path:ignored,...rest}=options;
            return route.fulfill({...rest,body:Buffer.from(selected.bytes),contentType:rest.contentType||mime[path.extname(selected.name)]||'application/octet-stream'});
          },continue(){throw Error('Unified regression cannot continue a real request');}}),request);
        },options);
      }});
    },async close(){try{return await browser.close();}finally{browsers.delete(browser);}}});
  }})};
  function fixtureRequire(specifier){
    if(specifier==='node:fs'||specifier==='fs')return fixtureFS;
    if(specifier==='playwright')return fixturePlaywright;
    return originalRequire(specifier);
  }
  try{
    const source=fs.readFileSync(filename,'utf8'),entries=[...source.matchAll(/^\(async\s*\(\s*\)\s*=>\s*\{/gm)];
    assert.equal(entries.length,1,'One original async entry point required');
    const executable=source.slice(0,entries[0].index)+'return '+source.slice(entries[0].index);
    const run=vm.compileFunction(executable,['require','__dirname','__filename','process','console'],{filename});
    const pending=run(fixtureRequire,__dirname,filename,fixtureProcess,console);assert(pending&&typeof pending.then==='function');await pending;
    assert.equal(fixtureProcess.exitCode,0,name+' original assertions failed');assert.deepEqual(denied,[]);assert.deepEqual(databaseWrites,[]);
    for(const file of ['unirf-app.html','src/platform/database-client.js','src/platform/database-batch-client.js',
      'src/platform/unified-project-sync.js','src/modules/planning-project-storage.js','src/app/business-database.js',
      'src/modules/navigation.js','src/modules/fashe.js'])assert(served.has(file),name+' did not load unified candidate '+file);
    return {suite:name,status:'passed',candidateAssets:served.size,businessDatabase503Reads:databaseReads.length,unhandledNetworkRequests:denied.length};
  }finally{for(const browser of browsers)try{await browser.close();}catch(_){}}
}
(async()=>{
  const results=[];for(const suite of suites)results.push(await runSuite(suite));
  assert(results.some(item=>item.businessDatabase503Reads>0),'Exercise real candidate database failure handling');
  console.log('PASS: unified candidate with unavailable business DB preserves original control assertions and unmodified FAshe VM ACK behavior.');
  console.log(JSON.stringify({status:'unified-control-regressions-passed',results,candidateFiles:candidate.files.size,deployed:false,liveControlWrites:0}));
})().catch(error=>{console.error(error);process.exitCode=1;});
