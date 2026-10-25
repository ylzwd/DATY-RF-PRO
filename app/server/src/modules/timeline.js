(function (global) {
  'use strict';
  // Read-only snapshot of the current database's latest audit events. Archive
  // save/delete never targets this table. Native hosts supply the same ports.
  let timelineEvents=[],timelinePage=1,timelineRequest=0,databasePreferredPage=null;
  let active=null,connectionOwner=null,unsubscribe=null;
  let state={loading:false,error:false,message:'待读取'};
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const runtime=(name,...args)=>global.DatyHostFactory?global.DatyHostFactory.invokeRuntime(global,name,...args):global[name](...args);
  function scope(connection){const value=connection.snapshot();if(!value.source?.id)throw Error('服务器数据库尚未连接');return {origin:value.origin,key:JSON.stringify([value.origin,value.revision,value.source.id,value.status?.epoch])};}
  function controls(){const button=document.getElementById('logTimelineView');button?.setAttribute('aria-busy',String(state.loading));
    const badge=document.getElementById('logStorageCount');if(badge&&alertLogView==='timeline')badge.textContent='🕒 服务器审计（'+(state.loading?'读取中':state.error?'未确认':timelineEvents.length+' 条')+'）';
    global.updateAlertLogControls?.();global.updateAlertArchiveStatus?.();}
  function cancelRead(){timelineRequest++;if(active){active.controller.abort();active=null;}state={...state,loading:false};controls();}
  function showMessage(title,message,symbol='🕒'){
    if(alertLogView!=='timeline')return;
    renderAlertLogPagination(0);const count=document.getElementById('logCount');if(count)count.textContent='—';
    const body=document.getElementById('logBody');if(body)body.innerHTML=alertLogEmptyMarkup(title,message,symbol);
  }
  function bindConnection(connection){
    if(connectionOwner===connection)return;
    unsubscribe?.();connectionOwner=connection;
    unsubscribe=connection.subscribe?.(()=>{
      cancelRead();timelineEvents=[];state={loading:false,error:true,message:'服务器连接已变化，请重新读取'};
      showMessage('Timeline 需要重新读取','服务器连接已变化，旧服务器事件已隐藏。','⚠️');controls();
    });
  }
  function renderServerTimeline(){
    if(alertLogView!=='timeline'||state.loading||state.error)return;
    const body=document.getElementById('logBody');if(!body)return;
    if(timelineEvents.length&&databasePreferredPage){timelinePage=databasePreferredPage;databasePreferredPage=null;}
    timelinePage=renderAlertLogPagination(timelineEvents.length,timelinePage);
    const count=document.getElementById('logCount');if(count)count.textContent=String(timelineEvents.length);
    body.innerHTML=timelineEvents.length?timelineEvents.slice((timelinePage-1)*ALERT_LOG_PAGE_SIZE,timelinePage*ALERT_LOG_PAGE_SIZE).map(event=>{
      const details=Object.keys(event.details||{}).length?JSON.stringify(event.details):'—';
      const time=new Date(event.ts*1000).toLocaleString('zh-CN'),target=event.device_id||event.project_id||'—';
      return `<tr><td class="mono" title="${escapeHtml(time)}">${escapeHtml(time)}</td><td title="${escapeHtml(event.event_type)}"><span class="badge b-v">${escapeHtml(event.event_type)}</span></td><td title="${escapeHtml(target)}">${escapeHtml(target)}</td><td title="${escapeHtml(event.summary)}">${escapeHtml(event.summary)}</td><td title="${escapeHtml(details)}">${escapeHtml(details.length>60?details.slice(0,60)+'…':details)}</td></tr>`;
    }).join(''):alertLogEmptyMarkup('Timeline 暂无事件','当前服务器最近事件为空；再次点击 Timeline 可重新查询。','🕒');
    controls();
  }
  async function loadServerTimeline(){
    if(!document.getElementById('logBody'))return false;
    if(typeof global.selectAlertLogView==='function')global.selectAlertLogView('timeline');else{cancelRead();alertLogView='timeline';}
    const request=++timelineRequest,controller=new AbortController(),operation={controller};active=operation;
    timelineEvents=[];timelinePage=1;databasePreferredPage=null;
    state={loading:true,error:false,message:'正在读取当前服务器数据库'};
    for(const [id,text]of [['logCountUnit','条审计事件'],['logTimeHeader','时间'],['logLevelHeader','类型'],['logDeviceHeader','设备 / 项目'],['logStateHeader','详情']]){
      const label=document.getElementById(id);if(label)label.textContent=text;
    }
    showMessage('正在读取服务端 Timeline…','查询当前服务器最近 200 条操作与设备事件。');controls();
    let timer;
    const current=()=>request===timelineRequest&&alertLogView==='timeline';
    try{
      const connection=global.DatyDatabaseConnection;if(!connection)throw Error('服务器数据库尚未连接');
      const captured=scope(connection);bindConnection(connection);
      const cancelled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('Timeline 读取已取消或超时')),{once:true}));
      timer=runtime('setTimeout',()=>controller.abort(),10000);
      const fetchResult=(async()=>{const response=await connection.request(captured.origin+'/api/timeline?limit=200',{cache:'no-store',signal:controller.signal});return {response,result:await response.json()};})();
      const {response,result}=await Promise.race([fetchResult,cancelled]);
      if(!current())return false;
      if(global.DatyDatabaseConnection!==connection||scope(connection).key!==captured.key)throw Error('服务器连接已变化，请重新读取 Timeline');
      if(!response.ok||result.success!==true)throw Error(result.error||`HTTP ${response.status}`);
      if(!Array.isArray(result.events)||result.events.length>200||result.events.some(event=>!event||typeof event!=='object'||Array.isArray(event)
        ||!Number.isFinite(event.ts)||event.ts<0||typeof event.event_type!=='string'
        ||event.summary!=null&&typeof event.summary!=='string'||event.details!=null&&(typeof event.details!=='object'||Array.isArray(event.details))))throw Error('Timeline 返回的事件列表格式错误');
      timelineEvents=result.events;state={loading:false,error:false,message:`已读取 ${timelineEvents.length} 条；完整历史可在服务器存档导出`};
      renderServerTimeline();return true;
    }catch(error){
      if(!current())return false;
      timelineEvents=[];state={loading:false,error:true,message:error.message||String(error)};
      showMessage('Timeline 读取失败',state.message+'；点击“服务端 Timeline”重试，数据库未改动。','⚠️');return false;
    }finally{if(timer!==undefined)runtime('clearTimeout',timer);if(active===operation)active=null;if(current()){state.loading=false;controls();}}
  }
  global.loadServerTimeline=loadServerTimeline;
  global.cancelServerTimelineRead=cancelRead;
  global.getServerTimelineState=()=>({...state});
  global.changeServerTimelinePage=delta=>{if(state.loading||state.error||alertLogView!=='timeline')return;databasePreferredPage=null;timelinePage+=delta;renderServerTimeline();void global.DatyBusinessDatabase?.savePage('timelinePage',timelinePage);};
  global.DatyApplyTimelinePagePreference=value=>{if(Number.isSafeInteger(value.timelinePage)&&value.timelinePage>0)databasePreferredPage=value.timelinePage;};
  global.addEventListener?.('pagehide',()=>{cancelRead();unsubscribe?.();},{once:true});
})(window);
