/* Activity presentation: saved revisions, event observations and alarms retain
 * their original identities. Read-only injected queries; no execution/replay. */
(function(root,build){const api=build();if(typeof module==='object'&&module.exports)module.exports=api;else{root.DatyActivityFactory=api;api.mount(root);}})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const TYPES={settings:'系统设置',device_overrides:'通道名称',manual_devices:'手动设备',scans:'扫描资料',scan_current:'当前扫描引用',simulation_settings:'模拟参数',planning_records:'规划历史',planning_current:'当前方案引用',planning_runs:'规划运行',profiles:'兼容参数版本',project_metadata:'项目信息',preferences:'视图偏好',plugins:'协议资料'};
  const EVENTS={'device.discovered':'设备上线','device.state_changed':'设备状态变化','receiver.discovered':'发现接收机','channel.observed':'首次观测通道','channel.changed':'通道状态变化','channel.offline':'通道离线','channel.removed':'通道移出快照','server.boot':'服务器启动','planning.deployment':'方案下发记录','coordination.completed':'规划计算完成'};
  const OUTCOMES={accepted:'已受理',prepared:'准备发送',queued:'等待发送',published:'已发出 · 待确认',dispatched:'已发出 · 待确认',readback_confirmed:'回读确认（非设备 ACK）',acknowledged:'设备已确认',not_sent:'未发送',rejected:'已拒绝',failed:'失败',timeout:'确认超时',unknown:'结果未知',reviewed:'已人工核对',committed:'保存已提交',deleted:'移除已提交',observed:'观测记录'};
  const METRICS={rf:'RF 弱信号',af:'AF 过载',battery:'电池低电量',battery_bars:'电池格数低',battery_error:'电池通讯错误',rf_interference:'RF 干扰',rf_interference_secondary:'第二分支 RF 干扰',encryption_mismatch:'加密不匹配',unregistered_transmitter:'未登记发射机'},FIELD_NAMES={rfWeakDbm:'RF 阈值（dBm）',afOverloadDbfs:'AF 阈值（dBFS）',batteryLowPercent:'电池阈值（%）',batteryLowBars:'电池阈值（格）',enabled:'开关',alias:'通道名称',receiverId:'接收机标识',channelNumber:'通道号',projectId:'项目标识',name:'名称',currentRecordId:'当前方案',scanId:'扫描引用',engineVersion:'引擎版本',configuredFrequencyKHz:'配置频率（kHz）',configuredChannelNumber:'配置通道',configuredIp:'配置 IP',specStartFreq:'起始频率（MHz）',specEndFreq:'结束频率（MHz）',timestamp:'原始时间（ms）',channels:'方案通道数',sourceKind:'资料来源',source:'来源',options:'参数',historyPage:'历史页码',alertPage:'告警页码',timelinePage:'旧审计页码',brand:'品牌',model:'型号',models:'型号',manufacturer:'制造商',frequencyUnit:'频率单位',levelUnit:'电平单位',status:'状态'};
  const contextKey=s=>JSON.stringify([s.origin,s.revision,s.source?.id,s.status?.epoch]);
  const title=item=>TYPES[item.kind]||EVENTS[item.kind]||(item.kind?.startsWith('command.')?'设备指令':item.kind||'其他事件');
  const outcome=item=>OUTCOMES[item.outcome]||item.outcome||'—';
  const time=value=>Number.isFinite(value)?new Date(value).toLocaleString('zh-CN'):'未记录';
  function createReader(ports){
    function context(){const c=ports.snapshot();if(!c?.source?.id||!c.status?.epoch)throw Error('服务器数据库尚未连接');return {origin:c.origin,key:contextKey(c),epoch:c.status.epoch};}
    function assert(c){if(context().key!==c.key)throw Error('服务器已变化，请刷新后查询');}
    async function read(c,path,signal){
      assert(c);const response=await ports.request(c.origin+path,{method:'GET',cache:'no-store',signal});const b=await response.json();assert(c);
      if(!response.ok||b.success!==true)throw Error(b.error||b.code||'服务器未确认读取');
      if(b.activity_protocol!=='daty-activity-v1'||b.epoch!==c.epoch)throw Error('数据库或协议已变化，请重新连接');return b;
    }
    async function list(filters,cursor,signal){
      const c=context(),q=new URLSearchParams({...filters,limit:'20'});if(cursor)q.set('cursor',cursor);
      const b=await read(c,'/api/database/activity?'+q,signal);const ids=new Set();
      if(b.source!==filters.source||!Array.isArray(b.items)||b.items.length>20||!(b.next_cursor===null||typeof b.next_cursor==='string'&&b.next_cursor)||!Number.isSafeInteger(b.as_of))throw Error('活动分页格式无效');
      for(const item of b.items){if(item.source!==b.source||!Number.isSafeInteger(item.id)||item.id<1||ids.has(item.id)||!Number.isFinite(item.time_ms)||typeof item.kind!=='string'||typeof item.target!=='string')throw Error('活动记录身份无效');ids.add(item.id);}
      return {...b,context:c,filters:{...filters}};
    }
    async function detail(page,item,signal){assert(page.context);const b=await read(page.context,'/api/database/activity/'+item.source+'/'+item.id,signal);if(b.id!==item.id||b.source!==item.source||!b.record)throw Error('活动详情身份不匹配');return b;}
    return {context,assert,list,detail};
  }
  function mount(g){
    const d=g.document;if(!d?.getElementById('activityFilters'))return;
    const get=id=>d.getElementById(id),life=new AbortController();let page=null,index=0,cursors=[null],filters=null,requestId=0,controller,state={loading:false,error:false,message:'待读取'},owner,unsubscribe,detailController,dialog;
    const reader=createReader({snapshot:()=>g.DatyDatabaseConnection.snapshot(),request:(...a)=>g.DatyDatabaseConnection.request(...a)});
    // alertLogView is a legacy global lexical binding, use the original accessor.
    const view=()=>typeof alertLogView==='undefined'?'archive':alertLogView;
    const isActive=()=>view()==='timeline'||view()==='audit';
    function element(tag,text,cls){const e=d.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
    function button(text,fn){const b=element('button',text,'btn btn-outline btn-sm');b.type='button';b.addEventListener('click',fn);return b;}
    function controls(){
      if(!isActive())return;g.updateAlertLogControls?.();get('activityFilters').hidden=false;
      get('logArchiveStatus').textContent=state.message;
      get('logStorageCount').textContent=state.loading?'读取中':state.error?'读取未确认':view()==='audit'?'数据库保存审计':'设备事件与执行记录';
      get('activityRefresh').disabled=state.loading;get('activityExport').disabled=state.loading||!page?.items.length;
      const paging=get('logPagination');paging.hidden=!page;paging.style.display=page?'flex':'none';
      get('logPrevPage').disabled=state.loading||index===0;get('logNextPage').disabled=state.loading||!page?.next_cursor;
      get('logPageInfo').textContent=page?'第 '+(index+1)+' 页 · 本页 '+page.items.length+' 条 · '+(page.next_cursor?'后续还有记录':'已到末页'):'';
      get('logCount').textContent=page?String(page.items.length):'—';
    }
    function render(){
      if(!isActive())return;
      for(const [id,text]of [['logCountUnit','条（本页）'],['logTimeHeader','服务器记录时间'],['logLevelHeader','功能 / 类型'],['logDeviceHeader','目标标识'],['logStateHeader','结果 / 详情']])get(id).textContent=text;
      const body=get('logBody');body.replaceChildren();
      for(const item of page?.items||[]){const row=element('tr'),type=element('td'),result=element('td'),label=outcome(item);
        type.append(element('span',title(item),'badge b-v'));
        result.append(element('span',label,'activity-outcome '+(['unknown','timeout','failed','rejected'].includes(item.outcome)?'activity-attention':'')),button('详情',()=>void detail(item)));
        row.append(element('td',time(item.time_ms)),type,element('td',item.target),element('td',item.summary||(title(item)+(item.revision===undefined?'':' · v'+item.revision))),result);body.append(row);}
      if(!page?.items.length){const cell=element('td',state.loading?'正在查询服务器…':state.error?state.message:'当前筛选范围没有记录；可调整类型、时间或目标筛选。','log-message-cell');cell.colSpan=5;const row=element('tr');row.append(cell);body.append(row);}
      controls();
    }
    function cancel(){requestId++;controller?.abort();state.loading=false;}
    function clearOld(){cancel();page=null;index=0;cursors=[null];state={loading:false,error:true,message:'服务器连接已变化，请刷新；旧记录已隐藏。'};detailController?.abort();dialog?.close();render();}
    function bind(){const c=g.DatyDatabaseConnection;if(owner===c)return;unsubscribe?.();owner=c;unsubscribe=c?.subscribe?.(clearOld);}
    function makeFilters(){const type=get('activityCategory').value.split(':'),days=Number(get('activityPeriod').value);return {source:type[0],category:type[1],from_ms:days?Date.now()-days*86400000:0,target:get('activityTarget').value.trim()};}
    async function load(next=0,reset=true){
      if(!isActive())return false;cancel();bind();controller=new AbortController();const ticket=requestId;
      if(reset){filters=makeFilters();index=0;cursors=[null];}else index=next;
      page=null;state={loading:true,error:false,message:'正在读取服务器记录…'};render();
      try{
        const result=await reader.list(filters,cursors[index],AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]));if(ticket!==requestId||!isActive())return false;
        page=result;cursors[index+1]=page.next_cursor;
        state={loading:false,error:false,message:(view()==='audit'?'按提交顺序查询已保存版本；默认隐藏自动告警保存、视图翻页及规划参数副本。':'按事件时间查询；已发出、结果未知、设备已确认分别保留。')+' 可继续翻页读取历史。'};
        if(view()==='audit'&&page.cleared_through>0)state.message='已于 '+time(page.cleared_at_ms)+' 清空此前 '+page.cleared_count+' 条操作审计；当前仅显示此后新记录，关联业务历史保留。';
        render();return true;
      }catch(e){if(ticket===requestId&&isActive()){state={loading:false,error:true,message:'读取失败：'+e.message+'；请刷新重试，原始记录保留。'};render();}return false;}
    }
    function select(mode){
      g.selectAlertLogView(mode);page=null;index=0;cursors=[null];
      const options=mode==='audit'?[['operations:all','业务操作（默认）'],['operations:settings','系统设置'],['operations:devices','设备与通道配置'],['operations:spectrum','扫描与导入'],['operations:planning','规划与兼容参数'],['operations:projects','项目信息'],['operations:preferences','视图偏好（含翻页）'],['operations:plugins','协议资料']]:[['timeline:commands','指令执行'],['live:all','设备状态与服务启动'],['timeline:planning','规划与下发事件'],['timeline:devices','旧设备接入事件'],['timeline:discovery','设备发现任务'],['timeline:all','全部服务器事件']];
      get('activityCategory').replaceChildren(...options.map(([value,label])=>{const o=element('option',label);o.value=value;return o;}));
      return load();
    }
    function ensureDialog(){if(dialog)return;dialog=element('dialog',undefined,'data-record-dialog activity-dialog');dialog.setAttribute('aria-labelledby','activityDetailTitle');
      const head=element('div',undefined,'catalog-heading'),title=element('h2','记录详情');title.id='activityDetailTitle';head.append(title,button('关闭',()=>dialog.close()));
      dialog.status=element('p','','catalog-status');dialog.status.setAttribute('role','status');dialog.content=element('div');dialog.append(head,dialog.status,dialog.content);d.body.append(dialog);dialog.addEventListener('close',()=>detailController?.abort());}
    function fields(values){const dl=element('dl',undefined,'catalog-fields');for(const [k,v]of Object.entries(values))dl.append(element('dt',k),element('dd',v==null?'未记录':typeof v==='object'?JSON.stringify(v):String(v)));return dl;}
    function raw(record){const details=element('details'),pre=element('pre'),s=JSON.stringify(record,null,2);pre.textContent=s.length>60000?s.slice(0,60000)+'\n…展示已截断':s;details.append(element('summary','查看记录字段'),pre);return details;}
    async function detail(item){
      const captured=page;if(!captured)return;ensureDialog();detailController?.abort();detailController=new AbortController();const selected=detailController;
      dialog.status.textContent='正在读取对应历史记录…';dialog.content.replaceChildren();dialog.showModal();
      try{
        const b=await reader.detail(captured,item,AbortSignal.any([selected.signal,AbortSignal.timeout(15000)]));if(selected!==detailController||selected.signal.aborted)return;
        dialog.status.textContent=title(item)+' · '+outcome(item);const r=b.record;
        dialog.content.append(fields({'记录时间':time(item.time_ms),'记录来源':item.source==='operations'?'数据库提交审计':item.source==='live'?'设备状态观测':'服务器事件','目标标识':item.target,'记录编号':item.source+':'+item.id}));
        if(item.source==='operations'){
          dialog.content.append(fields({'操作标识':r.operation_id,'网络来源':r.actor?.ip||r.actor?.id||'未记录','历史版本':'v'+r.revision}));
          const table=element('table',undefined,'activity-diff'),head=element('tr');for(const label of ['字段','保存前','保存后'])head.append(element('th',label));table.append(head);
          const before=r.before?.fields||{},after=r.after?.fields||{};
          for(const k of new Set([...Object.keys(before),...Object.keys(after)])){const tr=element('tr');if(JSON.stringify(before[k])!==JSON.stringify(after[k]))tr.className='activity-field-changed';tr.append(element('td',FIELD_NAMES[k]||k),element('td',before[k]===undefined?'未记录':String(before[k])),element('td',after[k]===undefined?'未记录':String(after[k])));table.append(tr);}
          dialog.content.append(table,element('p','展示该次提交的主要业务字段；移除为历史版本标记。保存已提交不代表设备已执行。','catalog-status'));
        }else if(item.kind.startsWith('command.')){
          const x=r.details||{};dialog.content.append(fields({'指令标识':r.command_id,'操作标识':x.operation_id,'期望值':x.expected,'设备回报值':x.actual,'单位':x.unit,'错误信息':x.error,'执行证据':x.execution_evidence}));
          dialog.content.append(element('p','“设备已确认”只用于 acknowledged 记录；人工核对与发送状态不改写此前未知或失败结果。','catalog-status'));
        }
        dialog.content.append(raw(r));
      }catch(e){if(!selected.signal.aborted)dialog.status.textContent='详情读取失败：'+e.message;}
    }
    function alertDetail(id){
      const record=g.readAlertArchive?.().find(r=>r.archiveId===id);if(!record)return;
      ensureDialog();dialog.content.replaceChildren();dialog.status.textContent=(METRICS[record.metric]||'其他历史告警')+' · '+(record.archiveState==='ended'?'已结束':record.archiveState==='active'?'归档状态：触发中':'历史状态未记录');
      const unit=record.metric==='battery'?'%':record.metric==='af'?'dBFS':record.metric==='rf'?'dBm':'';
      dialog.content.append(fields({'事件标识':record.archiveId,'设备 / 通道':record.deviceId||record.channelId,'接收机 IP':record.receiverIP,'首次触发':time(record.firstSeen??record.ts),'最后出现':time(record.lastSeen),'结束时间':record.archiveState==='ended'?time(record.endedAt):'尚未结束','记录值':record.value===undefined?'未记录':record.value+' '+unit,'触发阈值':record.threshold===undefined?'未记录':record.threshold+' '+unit}),element('p','同一事件保留首次触发和最后出现时间；结束后再次触发使用新的事件标识。已结束可能来自条件恢复、离线或遥测不可用，旧记录不推断具体原因，也不表示人工确认。','catalog-status'),raw(record));dialog.showModal();
    }
    async function exportPage(){
      const selected=page;if(!selected?.items.length)return;get('activityExport').disabled=true;
      try{reader.assert(selected.context);const result=await g.DatyTextExportFactory.saveText(g,JSON.stringify({format:'daty-activity-page-v1',server:selected.context.origin,epoch:selected.context.epoch,source:selected.source,filters:selected.filters,asOf:selected.as_of,page:index+1,items:selected.items},null,2),{fileName:'DATY_'+selected.source+'_page'+(index+1)+'.json',mimeType:'application/json;charset=utf-8',source:'activity-page',signal:life.signal});reader.assert(selected.context);if(page===selected){state.message=result?.status==='cancelled'?'下载已取消；如已提交文件保存，可在服务器存档核对。':'本页导出已获服务器保存确认。';controls();}}
      catch(e){if(page===selected){state.message='导出未确认：'+e.message;controls();}}finally{if(page===selected)get('activityExport').disabled=false;}
    }
    g.loadServerTimeline=()=>select('timeline');g.loadOperationAudit=()=>select('audit');g.cancelServerTimelineRead=cancel;
    g.getServerTimelineState=()=>({...state});g.getOperationAuditState=()=>({...state});
    g.changeServerTimelinePage=delta=>{if(!state.loading&&page&&(delta<0?index>0:page.next_cursor))void load(index+delta,false);};
    g.DatyActivityView={refresh:()=>load(),exportPage,alertDetail};
    get('activityRefresh').addEventListener('click',()=>void load());get('activityExport').addEventListener('click',()=>void exportPage());
    get('activityCategory').addEventListener('change',()=>void load());get('activityPeriod').addEventListener('change',()=>void load());get('activityTarget').addEventListener('keydown',e=>{if(e.key==='Enter')void load();});
    get('logBody').addEventListener('click',e=>{const b=e.target.closest?.('[data-alert-id]');if(b)alertDetail(b.dataset.alertId);});
    g.addEventListener('pagehide',()=>{life.abort();cancel();unsubscribe?.();detailController?.abort();},{once:true});
  }
  return {createReader,title,outcome,METRICS,mount};
});
