/* Database-authoritative settings. Only in-flight edits live in memory; no browser/file cache. */
(function(root,build){const factory=build();if(typeof module==='object'&&module.exports)module.exports=factory;else root.DatySystemSettingsFactory=factory;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const copy=v=>JSON.parse(JSON.stringify(v));
  const equal=(a,b)=>a===b||!!a&&!!b&&typeof a==='object'&&typeof b==='object'&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));
  const defaults=Object.freeze({alert_thresholds:{rfWeakDbm:-90,batteryLowPercent:20,batteryLowBars:1,afOverloadDbfs:-3},alert_sound:{enabled:false},auto_frequency:{enabled:false},network_connection:{localIp:'',heartbeatSeconds:30,reconnectStrategy:'exponential',shureExclusive:true,pcom1Enabled:false}});
  function create({client,onChange=()=>{}}){
    let generation=0,ready=false,initializing=null,refreshing=null;const entries=new Map();
    const entry=id=>{if(!Object.hasOwn(defaults,id))throw Error('Unknown setting');if(!entries.has(id))entries.set(id,{status:'loading',value:null,desired:null,version:0,dirty:false,work:null});return entries.get(id);};
    const emit=id=>onChange(id,snapshot(id));
    const snapshot=id=>{const e=entry(id);return {ready,status:e.status,value:e.value&&copy(e.value),dirty:e.dirty,message:e.message||''};};
    async function initialize(){
      if(initializing)return initializing;const epoch=generation;ready=false;
      initializing=(async()=>{
        for(const id of Object.keys(defaults)){
          const e=entry(id);if(e.dirty)continue;
          let r=await client.load('settings',id);if(epoch!==generation)return false;
          if(r.status==='unknown'){
            const receipt=await client.reconcile('settings',id);if(epoch!==generation)return false;
            if(receipt.status==='reconciled')r=await client.load('settings',id);
          }
          if(r.status==='ready'&&(!r.resource||r.resource.deleted))r=await client.save('settings',id,copy(defaults[id]));
          if(epoch!==generation)return false;
          if(!['ready','saved'].includes(r.status)||!r.resource||r.resource.deleted){e.status=r.status;e.message=r.message||r.code||'数据库未确认';emit(id);return false;}
          e.value=copy(r.resource.value);e.status='saved';emit(id);
        }
        ready=true;for(const id of Object.keys(defaults))emit(id);return true;
      })().catch(error=>{if(epoch===generation){const id=Object.keys(defaults).find(id=>entry(id).status!=='saved')||'network_connection';entry(id).status='error';entry(id).message=error.message;emit(id);}return false;}).finally(()=>{if(epoch===generation)initializing=null;});return initializing;
    }
    async function drain(id,e,epoch){
      try{
        while(e.dirty&&epoch===generation){
          // A read-only cross-client refresh may already be in flight. Queue this edit
          // behind it instead of letting the repository reject it as BUSY.
          if(e.readWork)await e.readWork;if(epoch!==generation)return false;
          const ticket=e.version,value=copy(e.desired);const r=await client.save('settings',id,value);
          if(epoch!==generation)return false;
          if(r.status!=='saved'){e.status=r.status;e.message=r.message||r.code||'数据库尚未确认保存';emit(id);return false;}
          e.value=copy(r.resource.value);
          if(ticket===e.version){e.dirty=false;e.status='saved';e.message='';emit(id);}
        }
        return true;
      }catch(error){if(epoch===generation){e.status='error';e.message=error.message;emit(id);}return false;}
      finally{e.work=null;}
    }
    function submit(id,value){
      if(!ready)return Promise.resolve(false);
      const e=entry(id);e.desired=copy(value);e.version++;e.dirty=true;
      if(e.status==='unknown'||e.status==='conflict'||e.status==='rejected'||e.status==='error'){emit(id);return Promise.resolve(false);}
      e.status='saving';emit(id);if(!e.work)e.work=drain(id,e,generation);return e.work;
    }
    async function retry(){
      if(!ready)return initialize();let ok=true;
      for(const [id,e]of entries){
        if(!e.dirty||e.work)continue;
        if(client.snapshot('settings',id).status==='unknown'){
          const reconciled=await client.reconcile('settings',id);if(reconciled.status!=='reconciled'){e.status='unknown';emit(id);ok=false;continue;}
        }
        const r=await client.load('settings',id);if(r.status!=='ready'){e.status=r.status;emit(id);ok=false;continue;}
        if(r.resource&&!r.resource.deleted&&equal(r.resource.value,e.desired)){e.value=copy(r.resource.value);e.dirty=false;e.status='saved';e.message='';emit(id);continue;}
        e.status='saved';ok=(await submit(id,e.desired))&&ok;
      }
      return ok;
    }
    async function readLatest(){
      if(!ready)return initialize();const epoch=generation;
      for(const id of Object.keys(defaults)){
        const e=entry(id);if(e.dirty||e.work)continue;
        e.readWork=client.load('settings',id);let r;try{r=await e.readWork;}finally{e.readWork=null;}if(epoch!==generation)return;
        if(r.status==='ready'&&r.resource&&!r.resource.deleted&&!e.dirty&&!e.work){e.value=copy(r.resource.value);e.status='saved';emit(id);}
      }
    }
    function refresh(){if(refreshing)return refreshing;const epoch=generation;refreshing=readLatest().finally(()=>{if(epoch===generation)refreshing=null;});return refreshing;}
    function invalidate(){generation++;ready=false;initializing=null;refreshing=null;entries.clear();client.invalidate();}
    return Object.freeze({initialize,submit,retry,refresh,snapshot,invalidate,get dirty(){return [...entries.values()].some(e=>e.dirty||e.status==='unknown');},get ready(){return ready;}});
  }
  function mount(global){
    if(global.DatySystemSettings)return global.DatySystemSettings;
    const journals=new Map(),memory={getItem:k=>journals.get(k)??null,setItem:(k,v)=>journals.set(k,String(v)),removeItem:k=>journals.delete(k)};
    const connection=global.DatyDatabaseConnection,el=id=>global.document.getElementById(id);
    const scope=()=>{const s=connection.snapshot();if(!s.source?.id)throw Error('数据库未连接');return {baseUrl:s.origin,accessRevision:s.revision,principalId:s.source.id};};
    const client=global.DatyDatabaseClientFactory.create({storage:memory,readScope:scope,request:(url,init)=>connection.request(url,init),schedule:(fn,ms)=>global.setTimeout(fn,ms),cancel:id=>global.clearTimeout(id)});
    let applying=false,scopeKey='';
    const fields=['rfThreshInput','battThreshInput','battBarsThreshInput','afThreshInput','soundAlertEnabled','autoFrequencyEnabled','systemLocalIp','systemHeartbeat','systemReconnect','systemShureExclusive','systemPcom1'];
    const statusText=()=>{
      const states=Object.keys(defaults).map(id=>controller.snapshot(id));
      if(!controller.ready){const failed=states.find(s=>!['loading','saved','saving'].includes(s.status));return failed?'数据库设置尚未就绪：'+(failed.message||failed.status)+'；请重试':'正在读取 / 初始化服务器数据库设置…';}
      if(states.some(s=>s.status==='saving'))return '正在保存到服务器数据库…';
      const failed=states.find(s=>s.dirty);return failed?'尚未保存 / 待核对：'+failed.message:'已从数据库读取；修改后立即保存';
    };
    function changed(id,state){
      for(const name of fields){const input=el(name);if(input)input.disabled=!controller.ready;}
      const label=el('systemSettingsSaveState');if(label)label.textContent=statusText();
      if(!state.value||state.dirty)return;
      applying=true;
      try{
        if(id==='alert_thresholds'){global.setAlertThresholdSettings?.(state.value);global.evaluateRealtimeAlerts?.(global.DATY_STATE?.devices||global.DEVICES||[]);global.forceRefreshAllPanels?.();}
        if(id==='alert_sound')global.DatyAlertSound?.setEnabled(state.value.enabled);
        if(id==='auto_frequency')global.DatyAutoFrequency?.setEnabled(state.value.enabled);
        if(id==='network_connection')for(const [name,key]of [['systemLocalIp','localIp'],['systemHeartbeat','heartbeatSeconds'],['systemReconnect','reconnectStrategy'],['systemShureExclusive','shureExclusive'],['systemPcom1','pcom1Enabled']]){const input=el(name);if(input){if(input.type==='checkbox')input.checked=state.value[key];else input.value=String(state.value[key]);}}
      }finally{applying=false;}
    }
    const controller=create({client,onChange:changed});
    const thresholds=()=>({rfWeakDbm:+el('rfThreshInput').value,batteryLowPercent:+el('battThreshInput').value,batteryLowBars:+el('battBarsThreshInput').value,afOverloadDbfs:+el('afThreshInput').value});
    const network=()=>({localIp:el('systemLocalIp').value.trim(),heartbeatSeconds:+el('systemHeartbeat').value,reconnectStrategy:el('systemReconnect').value,shureExclusive:el('systemShureExclusive').checked,pcom1Enabled:el('systemPcom1').checked});
    for(const id of fields.slice(0,4))el(id)?.addEventListener('input',()=>{if(!applying)void controller.submit('alert_thresholds',thresholds());});
    function saveNetwork(){
      if(applying)return;const value=network(),ip=value.localIp;
      // Complete IPv4/CIDR only in this display-preference field; validation is repeated on the server.
      const [address,prefix,...extra]=ip.split('/'),octets=address.split('.');
      if(ip&&(extra.length||octets.length!==4||octets.some(x=>!/^\d{1,3}$/.test(x)||+x>255||String(+x)!==x)||(prefix!==undefined&&(!/^\d{1,2}$/.test(prefix)||+prefix>32)))){if(el('systemSettingsSaveState'))el('systemSettingsSaveState').textContent='IP / 网段格式不完整，尚未保存';return;}
      void controller.submit('network_connection',value);
    }
    for(const id of fields.slice(6))el(id)?.addEventListener(id==='systemLocalIp'?'input':'change',saveNetwork);
    const api=Object.freeze({...controller,submit:(...args)=>controller.submit(...args),saveThresholds:()=>controller.submit('alert_thresholds',thresholds()),get dirty(){return controller.dirty;},get ready(){return controller.ready;}});
    global.DatySystemSettings=api;
    connection.subscribe(()=>{let next;try{next=JSON.stringify(scope());}catch(_){return;}if(next!==scopeKey){scopeKey=next;controller.invalidate();}void controller.initialize();});
    global.addEventListener?.('beforeunload',e=>{if(controller.dirty){e.preventDefault();e.returnValue='';}});
    for(const name of fields)if(el(name))el(name).disabled=true;
    void controller.initialize().catch(error=>{if(el('systemSettingsSaveState'))el('systemSettingsSaveState').textContent='设置尚未读取：'+error.message;});
    return api;
  }
  return Object.freeze({create,mount,defaults});
});
