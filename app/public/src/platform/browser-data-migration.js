/* daty-browser-business-backup-v1. Pure storage contract, no network/auth/device
 * controls. Browser view is mounted explicitly; native hosts can reuse snapshot,
 * parse, prepare and apply with their own storage and confirmation UI. */
(function(root, build) {
  const factory = build();
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.DatyBusinessMigration = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const FORMAT = 'daty-browser-business-backup-v1', MAX_CHARS = 10 * 1024 * 1024;
  const TYPES = Object.freeze({daty_devices:'array',daty_alerts:'array',daty_db_alerts:'array',daty_pending_alerts_v1:'array',
    daty_alert_archive_meta_v1:'object',daty_equipment_profiles_v1:'array',daty_equipment_profiles_v2:'array',
    daty_planning_history_v1:'object',daty_planner_constraints_v1:'object',daty_alert_thresholds_v1:'object',
    daty_receiver_group_numbers_v1:'object',daty_alert_sound_v1:'object',daty_auto_frequency_v1:'object',specStartFreq:'frequency',specEndFreq:'frequency'});
  const KEYS = Object.freeze(Object.keys(TYPES));
  const sensitive = /password|passwd|secret|token|authorization|credential|private.?key|pairing.?code|access.?key|session/i;
  const unsafe = key => sensitive.test(key) || ['__proto__','constructor','prototype'].includes(key);
  function clean(value, rejectSecrets, depth=0) {
    if (depth>50) throw new Error('业务数据嵌套过深');
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item=>clean(item,rejectSecrets,depth+1));
    const result=Object.create(null);
    for (const [key,item] of Object.entries(value)) {
      if (unsafe(key)) { if (rejectSecrets) throw new Error('备份包含禁止迁移的凭据或对象字段'); continue; }
      result[key]=clean(item,rejectSecrets,depth+1);
    }
    return result;
  }
  function checkedValue(key,raw,rejectSecrets=true) {
    if (!Object.hasOwn(TYPES,key) || typeof raw!=='string' || raw.length>MAX_CHARS) throw new Error('未知业务键、非字符串或数据过大');
    if (TYPES[key]==='frequency') {
      if (!/^\d+(?:\.\d+)?$/.test(raw) || Number(raw)<=0 || Number(raw)>3000) throw new Error('频谱范围数据无效');
      return raw;
    }
    let value;try { value=JSON.parse(raw); } catch (_) { throw new Error('业务数据不是有效 JSON：'+key); }
    if (TYPES[key]==='array' ? !Array.isArray(value) : !value || typeof value!=='object' || Array.isArray(value)) throw new Error('业务数据类型无效：'+key);
    return JSON.stringify(clean(value,rejectSecrets));
  }
  function snapshot(storage,sourceOrigin) {
    const origin=new URL(sourceOrigin);
    if (!['http:','https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('请在原服务器 HTTP 或 HTTPS 页面导出');
    const values=Object.create(null);
    for (const key of KEYS) { const raw=storage.getItem(key);if(raw!==null)values[key]=checkedValue(key,raw,false); }
    const result={format:FORMAT,version:1,sourceOrigin:origin.origin,createdAt:new Date().toISOString(),values};
    if (JSON.stringify(result).length>MAX_CHARS) throw new Error('备份超过大小限制，请先整理告警历史');
    return result;
  }
  function parse(text) {
    if (typeof text!=='string' || text.length>MAX_CHARS) throw new Error('备份超过大小限制');
    const body=JSON.parse(text);
    if (!body || body.format!==FORMAT || body.version!==1 || !body.values || typeof body.values!=='object' || Array.isArray(body.values)) throw new Error('不是 DATY 浏览器业务备份');
    const values=Object.create(null);
    for (const [key,raw] of Object.entries(body.values)) values[key]=checkedValue(key,raw,true);
    return Object.freeze({format:FORMAT,version:1,sourceOrigin:String(body.sourceOrigin||'未知来源'),values:Object.freeze(values)});
  }
  function prepare(storage,body,{overwrite=false}={}) {
    const checked=parse(JSON.stringify(body));
    const writes=[],kept=[];
    for (const [key,value] of Object.entries(checked.values)) {
      const previous=storage.getItem(key);
      if (previous!==null && !overwrite) kept.push(key);
      else writes.push(Object.freeze({key,value,previous}));
    }
    return Object.freeze({writes:Object.freeze(writes),kept:Object.freeze(kept),overwrite:!!overwrite});
  }
  function apply(storage,plan,{confirmed=false}={}) {
    if (confirmed!==true) throw new Error('尚未人工确认导入');
    for (const item of plan.writes) {
      checkedValue(item.key,item.value);
      if (storage.getItem(item.key)!==item.previous) throw new Error('当前业务数据已变化，请关闭其他服务器页面后重新预览');
      if (item.previous!==null && plan.overwrite!==true) throw new Error('未确认覆盖已有业务数据');
    }
    const done=[];
    try { for(const item of plan.writes){storage.setItem(item.key,item.value);done.push(item);} }
    catch(error) {
      const failed=[];
      for(const item of done.reverse())try {if(item.previous===null)storage.removeItem(item.key);else storage.setItem(item.key,item.previous);}catch(_){failed.push(item.key);}
      if(failed.length)throw new Error('写入失败且部分回退未完成，请使用导入前备份恢复：'+failed.join('、'));
      throw new Error('导入失败，已回退本次写入；原数据保留。'+error.message);
    }
    return Object.freeze({written:done.length,kept:plan.kept.length});
  }
  function mount(browser) {
    const doc=browser.document,get=id=>doc.getElementById(id),storage=browser.localStorage;
    const message=get('migrationMessage'),dialog=get('migrationConfirm');let selected=null,pending=null;
    let selectionId=0,pendingSelectionId=-1,disposed=false;
    const secure=browser.location.protocol==='https:';
    get('migrationOrigin').textContent=browser.location.origin;
    get('migrationFile').disabled=!secure;get('migrationPreview').disabled=true;
    get('migrationMode').textContent=secure?'HTTPS：可导出当前备份，并预览导入旧地址数据。':'HTTP：仅导出旧地址数据；切换 HTTPS 后再导入。';
    const report=error=>{message.textContent=error.message||String(error);};
    function download(body,prefix){
      const url=browser.URL.createObjectURL(new browser.Blob([JSON.stringify(body,null,2)],{type:'application/json'}));
      const link=doc.createElement('a');link.href=url;link.download=prefix+'-'+Date.now()+'.json';doc.body.appendChild(link);
      try{link.click();}finally{link.remove();browser.setTimeout(()=>browser.URL.revokeObjectURL(url),1000);}
    }
    get('migrationExport').addEventListener('click',()=>{
      try{const data=snapshot(storage,browser.location.origin);download(data,'DATY-business-backup');message.textContent='已发起下载：'+Object.keys(data.values).length+' 项业务数据。请确认文件已保存；未修改当前数据。';}catch(error){report(error);}
    });
    get('migrationFile').addEventListener('change',async event=>{
      const current=++selectionId;
      selected=null;pending=null;pendingSelectionId=-1;get('migrationPreview').disabled=true;
      try{
        const file=event.target.files[0];if(!file)return;if(file.size>MAX_CHARS*2)throw new Error('备份文件过大');
        const text=await file.text();
        if(disposed||current!==selectionId)return;
        selected=parse(text);get('migrationPreview').disabled=false;
        message.textContent='已读取 '+Object.keys(selected.values).length+' 项，来源：'+selected.sourceOrigin+'。尚未写入。';
      }catch(error){if(!disposed&&current===selectionId)report(error);}
    });
    get('migrationPreview').addEventListener('click',()=>{
      try{
        if(disposed||!secure||!selected)throw new Error('请在 HTTPS 地址选择有效备份');
        pending=prepare(storage,selected,{overwrite:get('migrationOverwrite').checked});
        pendingSelectionId=selectionId;
        get('migrationSummary').textContent='将导入 '+pending.writes.length+' 项；保留现有 '+pending.kept.length+' 项。'+(pending.overwrite?'已选择覆盖同名业务数据。':'现有数据不会被覆盖。')+' 确认后先下载当前数据备份，再写入。';
        dialog.showModal();
      }catch(error){report(error);}
    });
    get('migrationCancel').addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>{pending=null;pendingSelectionId=-1;});
    get('migrationApply').addEventListener('click',()=>{
      try{
        if(disposed||!secure||!pending||pendingSelectionId!==selectionId)throw new Error('没有已预览的 HTTPS 导入');
        download(snapshot(storage,browser.location.origin),'DATY-before-import');
        const result=apply(storage,pending,{confirmed:true});dialog.close();
        message.textContent='导入完成：'+result.written+' 项，保留 '+result.kept+' 项。请确认导入前备份已保存，再重新打开 HTTPS 服务器页面。设备在线状态由实时连接重新确认。';
      }catch(error){dialog.close();report(error);}
    });
    if(typeof browser.addEventListener==='function'){
      browser.addEventListener('pagehide',()=>{disposed=true;selectionId++;selected=null;pending=null;pendingSelectionId=-1;get('migrationPreview').disabled=true;});
      browser.addEventListener('pageshow',()=>{disposed=false;});
    }
  }
  return Object.freeze({FORMAT,KEYS,MAX_CHARS,snapshot,parse,prepare,apply,mount});
});
