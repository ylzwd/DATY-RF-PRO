const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.DATY_TEST_ASSET_ROOT || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root,'unirf-app.html'),'utf8');
const css = fs.readFileSync(path.join(root,'src/styles/main.css'),'utf8');
const vm = require('node:vm');
const discovery = fs.readFileSync(path.join(root,'src/modules/discovery.js'),'utf8');
const cards = [...html.matchAll(/<div class="plugin-card"[^>]*>([\s\S]*?)<\/span>\s*<\/div>/g)].map(match=>match[1]);

test('installed adapter cards are initially hidden until server capabilities confirm them', () => {
  assert.equal(cards.length,2);
  assert.match(html, /data-plugin-adapter="fashe-mqtt" hidden/);
  assert.match(html, /data-plugin-adapter="shure-scp" hidden/);
  const names = ['DATYaudio MQTT','Shure SCP'];
  cards.forEach((card,index) => {
    assert.ok(card.includes(names[index]));
    for (const name of ['plugin-info','plugin-name','plugin-models','badge b-g plugin-status']) assert.ok(card.includes(`class="${name}"`));
    assert.match(card,/plugin-status">(?:内置|已导入)/);
    assert.doesNotMatch(card,/style=|opacity|已启用/);
    assert.equal((card.match(/title="/g)||[]).length,2);
  });
});

test('shared styles keep equal height, aligned badges and the fixed one-window settings layout', () => {
  assert.match(css,/#panel-settings \.plugin-card\{[^}]*grid-template-columns:minmax\(0,1fr\) 64px;[^}]*height:40px;/);
  assert.match(css,/#panel-settings \.plugin-status\{[^}]*width:64px;height:22px;/);
  assert.match(css,/@media \(max-height:800px\)\{[\s\S]*\.plugin-card\{height:34px;/);
  assert.match(css,/#panel-settings\.active\{height:100%;min-height:0;overflow:hidden;\}/);
  assert.match(css,/\.content\.settings-view\{overflow-y:hidden;\}/);
  assert.match(css,/text-overflow:ellipsis;white-space:nowrap;/);
});

function pluginHarness() {
  const notices=[],modalHtml=[],calls=[];
  const context=vm.createContext({notify:(...args)=>notices.push(args),
    document:{createElement(){throw Error('No installer: must not request an executable');},
      body:{insertAdjacentHTML:(_,value)=>modalHtml.push(value)},getElementById:()=>({remove:()=>calls.push('close')})},
    setTimeout(){throw Error('No simulated completion timer');},fetch(){throw Error('No unimplemented download');}});
  vm.runInContext(discovery.slice(discovery.indexOf('function importPlugin()')),context);
  return {context,notices,modalHtml,calls};
}

test('external plugin button delegates to the verified installer without local success',()=>{
  const h=pluginHarness();h.context.DatyPluginImport={start:()=>h.calls.push('installer')};
  assert.doesNotThrow(()=>h.context.importPlugin());assert.deepEqual(h.calls,['installer']);assert.equal(h.notices.length,0);
});

test('plugin download returns truthful unavailable result without timer, network, install or success',()=>{
  const h=pluginHarness();assert.doesNotThrow(()=>h.context.downloadPlugin('Rode Wireless Protocol'));
  assert.deepEqual(h.calls,['close']);assert.equal(h.notices.length,1);
  assert.match(h.notices[0][1],/尚未接入/);assert.match(h.notices[0][2],/未下载/);
});

test('cloud entry hides unimplemented brands and truthfully reports no catalogue',()=>{
  const h=pluginHarness();h.context.importPluginCloud();
  assert.equal(h.modalHtml.length,0);assert.equal(h.notices.length,1);
  assert.match(h.notices[0][1],/暂无可导入/);
  assert.match(h.notices[0][2],/尚未接入/);
  assert.match(h.notices[0][2],/仅显示当前服务器已集成/);
  for(const name of ['Rode Wireless Protocol','Mipro ACT Protocol','Lectrosonics Protocol','Sony UWP Protocol','Behringer ULTRALINK'])assert.ok(!discovery.includes(name));
});

// Exercise async lifecycle and actual registered plugin metadata with no network/devices.
function installedHarness() {
  const pluginCards=[...html.matchAll(/<div class="plugin-card"([^>]*)>/g)].map(m=>({hidden:true,dataset:{
    pluginAdapter:m[1].match(/data-plugin-adapter="([^"]+)"/)?.[1],
    pluginBrand:m[1].match(/data-plugin-brand="([^"]+)"/)?.[1]}}));
  const filter={value:'all',options:[{value:'all',textContent:'全部品牌'}],replacements:0,
    replaceChildren(...options){this.options=options;this.value=options[0]?.value||'';this.replacements++;}};
  const state={},requests=[],timers=new Map(),events={};let timerId=0,active='channels',repaints=0;
  const context=vm.createContext({AbortController,DEVICES:[],_fasheApiUrl:'https://server-a:8080',_serverGeneration:1,
    document:{hidden:false,getElementById:id=>id==='brandPluginList'?{appendChild:card=>pluginCards.push(card)}:id==='filterBrandChannels'?filter:id==='brandPluginState'?state:
      ['panel-channels','panel-settings'].includes(id)?{classList:{contains:()=>id==='panel-'+active}}:null,
      querySelectorAll:()=>pluginCards,createElement:tag=>({dataset:{},children:[],appendChild(child){this.children.push(child);}}),
      addEventListener:(name,fn)=>{events[name]=fn;}},
    addEventListener:(name,fn)=>{events[name]=fn;},filterDevicesChannels:()=>{repaints++;},
    _discoveryRuntime:(method,...args)=>{if(method==='clearTimeout')return timers.delete(args[0]);
      assert.equal(method,'setTimeout');const id=++timerId;timers.set(id,{fn:args[0],delay:args[1]});return id;},
    _discoveryRequest:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))});
  vm.runInContext(discovery.slice(discovery.indexOf('globalThis.DatyBrandPlugins =')),context);
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  return {context,filter,state,requests,timers,events,pluginCards,
    values:()=>filter.options.map(o=>o.value),repaints:()=>repaints,
    activate(name){active=name;context.DatyBrandPlugins.syncVisibility();},
    async reply(index,adapters){requests[index].resolve({ok:true,json:async()=>({success:true,adapters})});await flush();},
    async badReply(index,data){requests[index].resolve({ok:true,json:async()=>data});await flush();},
    async fail(index){requests[index].reject(Error('connection lost'));await flush();},
    poll(){const [id,timer]=timers.entries().next().value||[];assert.ok(timer);timers.delete(id);timer.fn();},flush};
}

test('channel filter starts with all only; channel page reads installed plugins even with no live devices',async()=>{
  const select=html.match(/<select id="filterBrandChannels"[\s\S]*?<\/select>/)[0];
  assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map(m=>m[1]),['all']);
  const h=installedHarness();h.activate('channels');assert.deepEqual(h.values(),['all']);
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].options.method,'GET');
  await h.reply(0,{'fashe-mqtt':{},'shure-scp':{},'unknown-readonly':{}});
  assert.deepEqual(h.values(),['all','DATYaudio','Shure']);assert.ok(h.pluginCards.every(c=>!c.hidden));
  assert.equal(h.context.DEVICES.length,0);assert.equal(h.repaints(),0);
});

test('periodic refresh and settings navigation preserve a valid brand without rebuilding options',async()=>{
  const h=installedHarness();h.activate('channels');await h.reply(0,{'fashe-mqtt':{},'shure-scp':{}});
  h.filter.value='Shure';const writes=h.filter.replacements;h.poll();await h.reply(1,{'shure-scp':{},'fashe-mqtt':{}});
  assert.equal(h.filter.value,'Shure');assert.equal(h.filter.replacements,writes);
  h.activate('settings');assert.equal(h.filter.value,'Shure');await h.reply(2,{'fashe-mqtt':{},'shure-scp':{}});
  h.activate('channels');assert.equal(h.filter.value,'Shure');await h.reply(3,{'fashe-mqtt':{},'shure-scp':{}});
  assert.equal(h.repaints(),0);assert.equal(h.filter.replacements,writes);
});

test('removed plugins clear an invalid selection and additions use the same registration as plugin cards',async()=>{
  const h=installedHarness();h.activate('channels');await h.reply(0,{'fashe-mqtt':{},'shure-scp':{}});h.filter.value='Shure';
  h.pluginCards.push({hidden:true,dataset:{pluginAdapter:'fixture-brand',pluginBrand:'FixtureBrand'}});
  h.poll();await h.reply(1,{'fashe-mqtt':{},'fixture-brand':{}});
  assert.deepEqual(h.values(),['all','DATYaudio','FixtureBrand']);assert.equal(h.filter.value,'all');assert.equal(h.repaints(),1);
  assert.equal(h.pluginCards.find(c=>c.dataset.pluginAdapter==='shure-scp').hidden,true);
  assert.equal(h.pluginCards.at(-1).hidden,false);
});

test('unavailable or malformed capabilities hide unconfirmed brands; connection recovery repopulates them',async()=>{
  const h=installedHarness();h.activate('channels');await h.reply(0,{'fashe-mqtt':{},'shure-scp':{}});h.filter.value='Shure';
  h.poll();await h.fail(1);assert.deepEqual(h.values(),['all']);assert.equal(h.filter.value,'all');assert.ok(h.pluginCards.every(c=>c.hidden));
  h.poll();await h.badReply(2,{success:true,adapters:[]});assert.deepEqual(h.values(),['all']);
  h.poll();await h.reply(3,{'shure-scp':{}});assert.deepEqual(h.values(),['all','Shure']);
  assert.equal(h.repaints(),1);assert.equal(h.state.hidden,true);
});

test('late responses from an old server generation cannot repopulate the current filter',async()=>{
  const h=installedHarness();h.activate('channels');await h.reply(0,{'fashe-mqtt':{},'shure-scp':{}});h.filter.value='Shure';
  h.poll();h.context._fasheApiUrl='https://server-b:8080';h.context._serverGeneration++;h.activate('channels');
  assert.deepEqual(h.values(),['all']);assert.equal(h.requests[1].options.signal.aborted,true);
  await h.reply(1,{'fashe-mqtt':{},'shure-scp':{}});assert.deepEqual(h.values(),['all']);
  await h.reply(2,{'fashe-mqtt':{}});assert.deepEqual(h.values(),['all','DATYaudio']);
  assert.equal(h.requests[2].url,'https://server-b:8080/api/capabilities');
});

test('hidden pages cancel reads and timers, and ignore stale completion',async()=>{
  const h=installedHarness();h.activate('channels');h.context.document.hidden=true;h.events.visibilitychange();
  assert.equal(h.requests[0].options.signal.aborted,true);
  await h.reply(0,{'shure-scp':{}});assert.deepEqual(h.values(),['all']);assert.equal(h.timers.size,0);
  h.context.document.hidden=false;h.activate('dashboard');assert.equal(h.requests.length,1);
  h.activate('channels');await h.reply(1,{'shure-scp':{}});assert.deepEqual(h.values(),['all','Shure']);
});

test('invalid adapter entries and inherited entries never produce installed brand choices',async()=>{
  const h=installedHarness();h.activate('channels');
  await h.reply(0,Object.assign(Object.create({'fashe-mqtt':{}}),{'shure-scp':[]}));
  assert.deepEqual(h.values(),['all']);assert.ok(h.pluginCards.every(c=>c.hidden));
});

test('new imported brands create their own card and filter without an HTML registration',async()=>{
  const h=installedHarness();h.activate('settings');
  await h.reply(0,{'fashe-mqtt':{},'future-protocol':{plugin_id:'future',brand:'Future Brand',version:'1'}});
  assert.deepEqual(h.values(),['all','DATYaudio','Future Brand']);assert.equal(h.pluginCards.length,3);
  const card=h.pluginCards.find(c=>c.dataset.pluginBrand==='Future Brand');assert.equal(card.hidden,false);
  h.poll();await h.reply(1,{'fashe-mqtt':{},'future-protocol':{plugin_id:'future',brand:'Future Brand',version:'1'}});
  assert.equal(h.pluginCards.length,3);h.poll();await h.reply(2,{'fashe-mqtt':{}});assert.equal(card.hidden,true);
});

