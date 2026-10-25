// Real browser HTTP connection pool + all production timers. Isolated loopback only.
const assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..');
(async()=>{
  const devices=Array.from({length:50},(_,i)=>({id:`receiver-a_ch${i+1}`,receiver_id:'receiver-a',
    receiver_mac:'02:00:00:00:00:01',ip:'127.0.0.2',channel_number:i+1,channel:i+1,group:9,
    brand:'DATYaudio',model:'RF PRO',freq:641000+i*250,rf:-50,af_dbfs:0,batt:90,muted:false,_online:true,status:'online'}));
  devices.push({...devices[0],id:'receiver-b_ch1',receiver_id:'receiver-b',ip:'127.0.0.3',receiver_mac:'02:00:00:00:00:02'});
  const streams=new Set(),commands=[],timers=new Set(),records=new Map();let snapshotCount=0,liveSnapshots=0,maxSnapshots=0;
  const send=(event,payload)=>{for(const r of streams)r.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);};
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://isolated');
    const json=data=>{if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}};
    if(url.pathname==='/unirf-app.html'||/^\/src\/(modules|styles)\/[\w.-]+\.(js|css)$/.test(url.pathname)){
      res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':url.pathname.endsWith('.css')?'text/css':'text/html');
      return res.end(fs.readFileSync(path.join(root,url.pathname)));
    }
    if(url.pathname==='/api/updates'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.flushHeaders();streams.add(res);
      res.write(`event: device_list\ndata: ${JSON.stringify({devices})}\n\n`);res.on('close',()=>streams.delete(res));return;
    }
    if(url.pathname==='/api/devices'){
      snapshotCount++;liveSnapshots++;maxSnapshots=Math.max(maxSnapshots,liveSnapshots);
      const timer=setTimeout(()=>{timers.delete(timer);liveSnapshots--;json({success:true,devices});},200);
      timers.add(timer);return;
    }
    if(url.pathname==='/api/command'){
      let body='';req.on('data',b=>body+=b);req.on('end',()=>{
        const cmd=JSON.parse(body),device=devices.find(d=>d.id===cmd.device_id);
        assert.ok(device);assert.equal(cmd.channel_number,device.channel_number);commands.push(cmd);
        const id=`fixture-${commands.length}`,record={command_id:id,client_request_id:cmd.client_request_id,
          command:cmd.command,device_id:device.id,status:'acknowledged',actual_value:cmd.command==='mute'};
        device.muted=record.actual_value;records.set(id,record);
        send('device_update',{devices:[device]});send('command_update',{data:record});
        json({success:true,command_id:id,command_record:record});
      });return;
    }
    if(url.pathname.startsWith('/api/commands/'))return json({success:true,command:records.get(url.pathname.split('/').pop())});
    json({status:'ok',success:true,devices:[],events:[],project:{id:'default'},ip:'127.0.0.1'});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  const ticker=setInterval(()=>send('device_update',{devices:[devices[0]]}),250);
  const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
  try{
    const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await context.addInitScript(origin=>{
      localStorage.setItem('daty_fashe_api_url',origin);
      window.WebSocket=class extends EventTarget {close(){} send(){throw Error('Live sockets are forbidden');}};
    },origin);
    await page.goto(origin+'/unirf-app.html');await page.waitForFunction(()=>DEVICES.length===51);
    await page.evaluate(()=>switchPanel('channels'));
    // Unlike the earlier test, keep real background timers running long enough to expose per-CH polling.
    await page.waitForTimeout(6500);
    assert.ok(snapshotCount<=3,`background GET flood: ${snapshotCount}`);
    const latency=[];
    for(const label of ['取消静音','静音']){
      const button=page.locator('#deviceGridChannels .device-card').first().locator('[data-role="mute-button"]');
      const started=performance.now();await button.click();
      await page.waitForFunction(()=>!window.__DATY_MUTE_COMMANDS_IN_FLIGHT?.size);
      latency.push(performance.now()-started);assert.match(await button.textContent(),new RegExp(label));
      assert.equal(await button.isDisabled(),false);assert.equal(devices.at(-1).muted,false);
    }
    assert.deepEqual(commands.map(c=>c.command),['mute','unmute']);
    assert.ok(latency.every(ms=>ms<1000),`command delayed by background requests: ${latency}`);
    const controlTrace=await page.evaluate(()=>getMuteControlDiagnostics());
    assert.equal(controlTrace.length,2);
    for(const item of controlTrace){
      assert.equal(item.state,'acknowledged');assert.ok(item.ui_updated_ms>=item.ack_received_ms);
      assert.ok(item.ack_received_ms>=item.request_start_ms);assert.ok(item.ui_updated_ms<1000);
    }
    // Force unavailable SSE data: all channels and discovery must still share a bounded fallback.
    await page.evaluate(()=>{window.getFasheServiceSnapshot=()=>null;});
    const before=snapshotCount;await page.waitForTimeout(3500);
    assert.ok(snapshotCount-before<=4,`fallback scales with CH count: ${snapshotCount-before}`);
    assert.ok(maxSnapshots<=1,`overlapping background requests: ${maxSnapshots}`);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({pass:true,channels:51,snapshotCount,maxSnapshots,muteUnmuteMs:latency,controlTrace,liveControlsSent:0}));
  }finally{
    await browser.close();clearInterval(ticker);for(const timer of timers)clearTimeout(timer);
    for(const stream of streams)stream.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
