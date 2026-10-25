/* Pure list model shared by the four data views and future native views. */
(function(root,build){const api=build();if(typeof module==='object'&&module.exports)module.exports=api;else root.DatyDataManagement=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function search(rows,query,fields,predicate=()=>true){
    const terms=String(query||'').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(row=>predicate(row)&&(!terms.length||terms.every(term=>fields.map(key=>String(row[key]??'')).join(' ').toLocaleLowerCase().includes(term))));
  }
  function paginate(rows,page=1,size=20){
    if(!Number.isSafeInteger(size)||size<1)throw TypeError('Invalid page size');
    const pages=Math.max(1,Math.ceil(rows.length/size)),selected=Math.min(pages,Math.max(1,Number.isSafeInteger(page)?page:1));
    return {items:rows.slice((selected-1)*size,selected*size),total:rows.length,page:selected,pages,size};
  }
  return Object.freeze({search,paginate});
});

;
/* Read-only catalogs. Editing stays with the owning feature and its real save
 * receipts. Injected transport/context keeps the same model usable by a native host. */
(function(root,build){
  const api=build();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else {root.DatyDataCatalogFactory=api;api.mount(root);}
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const PROJECT=new Set(['scans','simulation_settings','scan_current','planning_runs','planning_current']);
  const TYPES={device_overrides:'通道名称',manual_devices:'手动设备',scans:'扫描原始资料',scan_current:'当前扫描引用',simulation_settings:'模拟频谱参数',
    profiles:'设备频段与兼容参数',planning_runs:'规划运行记录',planning_current:'当前方案引用',settings:'告警与推荐设置',preferences:'视图与频率范围',plugins:'协议插件资料'};
  const GROUPS={devices:['device_overrides','manual_devices'],scans:['scans','scan_current','simulation_settings'],planning:['profiles','planning_runs','planning_current'],settings:['settings','preferences','plugins']};
  const settingNames={alert_thresholds:'告警阈值',alert_sound:'声音告警',auto_frequency:'自动变频推荐',network_connection:'网络与连接设置'};
  const copy=x=>JSON.parse(JSON.stringify(x)),key=x=>JSON.stringify([x.origin,x.revision,x.sourceId,x.epoch,x.projectId]);
  function createReader(ports){
    const context=()=>{const c=ports.context();if(!c?.sourceId||!c.epoch||!c.projectId)throw Error('服务器数据库尚未连接，请连接后刷新');return copy(c);};
    const assert=c=>{if(key(c)!==key(context()))throw Error('服务器或项目已变化，请刷新列表');};
    async function request(c,path,signal){
      assert(c);
      const response=await ports.request(c.origin+path,{method:'GET',cache:'no-store',signal});
      const body=await response.json();assert(c);
      if(!response.ok||body.success!==true)throw Error(body.error||body.message||(body.code==='CATALOG_CHANGED'?'目录已变化，请刷新列表':body.code)||'服务器读取失败');
      if(body.protocol!=='daty-business-db-v1'||body.epoch!==c.epoch)throw Error('数据库代次已变化，请重新连接后刷新');
      return body;
    }
    async function list(kind,cursor=null,signal){
      if(!TYPES[kind])throw Error('未知数据目录');
      const c=context(),query=new URLSearchParams({kind,limit:'20'});
      if(PROJECT.has(kind))query.set('project_id',c.projectId);
      if(cursor)query.set('cursor',cursor);
      const b=await request(c,'/api/database/catalog?'+query,signal);
      if(b.catalog_protocol!=='daty-business-catalog-v1'||b.kind!==kind||b.project_id!==(PROJECT.has(kind)?c.projectId:null)||!Array.isArray(b.items)||b.items.length>20
        ||!(b.next_cursor===null||typeof b.next_cursor==='string'&&b.next_cursor.length>0))throw Error('服务器目录格式不完整');
      const ids=new Set();
      for(const r of b.items){
        if(r.kind!==kind||typeof r.id!=='string'||!r.id||ids.has(r.id)||!Number.isSafeInteger(r.revision)||r.revision<1||!Number.isFinite(r.saved_at_ms)
          ||typeof r.digest!=='string'||!r.summary||r.project_id!==b.project_id)throw Error('服务器目录记录无效');
        ids.add(r.id);
      }
      return {context:c,...b};
    }
    async function detail(page,item,signal){
      assert(page.context);
      const b=await request(page.context,'/api/database/resources/'+encodeURIComponent(item.kind)+'/'+encodeURIComponent(item.id),signal),r=b.resource;
      if(!r||r.kind!==item.kind||r.id!==item.id||r.revision!==item.revision||r.deleted!==false||!Object.hasOwn(r,'value'))throw Error('该记录已更新或移除，请刷新目录后重试');
      return {format:'daty-resource-export-v1',server:page.context.origin,epoch:b.epoch,projectId:item.project_id,
        savedAtMs:item.saved_at_ms,digest:item.digest,resource:r};
    }
    return {list,detail,assert,context};
  }
  const mhz=n=>Number.isFinite(n)?(n/1000).toFixed(3):'—';
  function describe(item){
    const s=item.summary||{},type=item.kind;
    let title=s.name||s.alias||settingNames[item.id]||item.id,info=TYPES[type];
    if(type==='device_overrides')info=s.receiver_id+' · CH'+s.channel_number;
    if(type==='manual_devices')info=[s.brand,s.model,'配置 '+mhz(s.configured_frequency_khz)+' MHz'].filter(Boolean).join(' · ');
    if(type==='scans')info=({imported_csv:'导入扫描',instrument:'仪器扫描',simulation:'模拟资料'}[s.source_kind]||s.source_kind)+' · '+s.point_count+' 点 · '+mhz(s.min_khz)+'–'+mhz(s.max_khz)+' MHz';
    if(type==='profiles'){title=s.manufacturer||item.id;info=mhz(s.start_khz)+'–'+mhz(s.end_khz)+' MHz'+(s.source==='planning-snapshot'?' · 规划保留版本':' · 设备参数');}
    if(type==='settings')info=item.id==='network_connection'?'网络连接偏好 · 已存入数据库':s.setting_type==='thresholds'||item.id==='alert_thresholds'?'RF '+s.rf_weak_dbm+' dBm · 电池 '+s.battery_low_percent+'% · AF '+s.af_overload_dbfs+' dBFS':s.enabled===1?'已启用':'已关闭';
    if(type==='planning_runs')info='引擎 '+(s.engine_version||'未记录')+' · '+(s.scan_id?'含扫描引用':'未引用扫描');
    if(type==='scan_current')info='扫描资料：'+s.scan_id;
    if(type==='planning_current')info='当前方案：'+(s.current_record_id||'未选择');
    if(type==='simulation_settings')info='噪底 '+s.floor_dbm+' dBm · 占用阈值 '+s.threshold_dbm+' dBm';
    if(type==='plugins')info='资料状态：'+s.status;
    return {title,info};
  }
  function mount(g){
    if(!g.document)return;
    const d=g.document,states=new Map();let reader,dialog,detailTicket=0,detailController,selectedDetail=null;
    function el(tag,text,cls){const e=d.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
    function button(text,fn){const b=el('button',text,'btn btn-outline btn-sm');b.type='button';b.addEventListener('click',fn);return b;}
    function getReader(){return reader||(reader=createReader({context(){const c=g.DatyDatabaseConnection?.snapshot(),p=g.getCurrentPlanningProject?.()||{id:'default',name:'默认项目'};
      return {origin:c?.origin,revision:c?.revision,sourceId:c?.source?.id,epoch:c?.status?.epoch,projectId:p.id,projectName:p.name||p.id};},request:(...args)=>g.DatyDatabaseConnection.request(...args)}));}
    function scopeLabel(page){return PROJECT.has(page.kind)?'项目：'+page.context.projectName:'服务器共享';}
    function makeDialog(){
      if(dialog)return;
      dialog=el('dialog',undefined,'data-record-dialog');dialog.setAttribute('aria-labelledby','dataRecordTitle');
      const head=el('div',undefined,'catalog-heading'),title=el('h2','记录详情');title.id='dataRecordTitle';
      head.append(title,button('关闭',()=>dialog.close()));
      dialog.status=el('p','正在读取完整记录…','catalog-status');dialog.status.setAttribute('role','status');
      dialog.fields=el('dl',undefined,'catalog-fields');dialog.raw=el('pre');
      const rawDetails=el('details'),rawSummary=el('summary','查看原始 JSON');rawDetails.append(rawSummary,dialog.raw);
      dialog.export=button('导出此版本 JSON',()=>void exportDetail());dialog.export.disabled=true;
      dialog.append(head,dialog.status,dialog.fields,rawDetails,dialog.export);d.body.append(dialog);
      dialog.addEventListener('close',()=>{detailTicket++;detailController?.abort();selectedDetail=null;});
    }
    async function openDetail(state,item){
      makeDialog();detailController?.abort();detailController=new AbortController();const ticket=++detailTicket;
      selectedDetail=null;dialog.status.textContent='正在读取完整记录…';dialog.fields.replaceChildren();dialog.raw.textContent='';dialog.export.disabled=true;dialog.querySelector('details').open=false;
      if(!dialog.open)dialog.showModal();
      try{
        const data=await getReader().detail(state.page,item,AbortSignal.any([detailController.signal,AbortSignal.timeout(30000)]));
        if(ticket!==detailTicket)return;
        selectedDetail={data,context:state.page.context};
        dialog.status.textContent=describe(item).title+' · 服务器已保存 · 版本 '+item.revision;
        const fields={'类型':TYPES[item.kind],'归属':scopeLabel(state.page),'记录标识':item.id,'保存时间':new Date(item.saved_at_ms).toLocaleString(),'内容摘要':item.digest};
        const v=data.resource.value;
        if(v&&typeof v==='object')for(const [k,value] of Object.entries(v))if(value===null||typeof value!=='object')fields[k]=String(value);
        for(const [k,v]of Object.entries(fields))dialog.fields.append(el('dt',k),el('dd',v));
        const json=JSON.stringify(data,null,2);dialog.raw.textContent=json.length>60000?json.slice(0,60000)+'\n…预览已截断，导出包含完整记录。':json;
        dialog.export.disabled=false;
      }catch(e){if(ticket===detailTicket)dialog.status.textContent='读取失败：'+e.message;}
    }
    async function exportDetail(){
      const selected=selectedDetail;if(!selected)return;
      dialog.export.disabled=true;
      try{
        getReader().assert(selected.context);
        const signal=AbortSignal.any([detailController.signal,AbortSignal.timeout(30000)]),r=selected.data.resource;
        dialog.status.textContent='正在保存导出文件，请等待服务器确认…';
        const result=await g.DatyTextExportFactory.saveText(g,JSON.stringify(selected.data,null,2),{fileName:('DATY_'+r.kind+'_'+r.id+'_v'+r.revision+'.json').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,180),mimeType:'application/json;charset=utf-8',source:'data-catalog',signal});
        getReader().assert(selected.context);
        if(selectedDetail===selected)dialog.status.textContent=result?.status==='cancelled'?'导出已取消。':'已开始导出到本机。';
      }catch(e){if(selectedDetail===selected)dialog.status.textContent='导出未确认：'+e.message;}
      finally{if(selectedDetail===selected)dialog.export.disabled=false;}
    }
    function render(state){
      state.body.replaceChildren();const q=state.search.value.trim().toLocaleLowerCase(),items=state.page?.items||[];
      const shown=items.filter(item=>[item.id,...Object.values(describe(item))].join(' ').toLocaleLowerCase().includes(q));
      for(const item of shown){
        const tr=el('tr'),name=el('td'),desc=describe(item);name.append(el('strong',desc.title),el('small',item.id,'catalog-id'));
        const action=el('td');action.append(button('查看 / 导出',()=>void openDetail(state,item)));
        tr.append(name,el('td',desc.info),el('td','v'+item.revision),el('td',new Date(item.saved_at_ms).toLocaleString()),action);state.body.append(tr);
      }
      if(!shown.length){const td=el('td',state.busy?'正在读取…':state.page?(q?'本页没有匹配记录':'尚无已保存记录，可前往对应功能保存后刷新。'):'等待读取服务器目录');td.colSpan=5;td.className='catalog-empty';state.body.append(el('tr'));state.body.lastChild.append(td);}
      state.prev.disabled=state.busy||state.index===0;state.next.disabled=state.busy||!state.page?.next_cursor;state.refresh.disabled=state.busy;state.select.disabled=state.busy;
      state.pageLabel.textContent=state.page?'第 '+(state.index+1)+' 页 · 本页 '+shown.length+' / '+items.length+' 条'+(state.page.next_cursor?' · 后续还有记录':' · 已到末页'):'';
    }
    async function load(state,index=0){
      state.abort?.abort();state.abort=new AbortController();const ticket=++state.ticket;
      state.busy=true;state.page=null;state.index=index;state.status.textContent='正在查询服务器已保存记录…';render(state);
      try{
        const page=await getReader().list(state.select.value,state.cursors[index],AbortSignal.any([state.abort.signal,AbortSignal.timeout(15000)]));
        if(ticket!==state.ticket)return;
        state.page=page;state.cursors[index+1]=page.next_cursor;
        state.status.textContent=scopeLabel(page)+' · 已读取服务器保存版本 · 每页 20 条，按标识排序';
      }catch(e){if(ticket===state.ticket)state.status.textContent='读取失败：'+e.message;}
      finally{if(ticket===state.ticket){state.busy=false;render(state);}}
    }
    function initialize(host){
      if(states.has(host))return states.get(host);
      const group=host.dataset.catalog,state={host,index:0,cursors:[null],ticket:0,busy:false,page:null};states.set(host,state);
      const toolbar=el('div',undefined,'data-filterbar'),type=el('label','资料类型 ');state.select=el('select');state.select.setAttribute('aria-label',group+' 资料类型');
      for(const kind of GROUPS[group]){const opt=el('option',TYPES[kind]);opt.value=kind;state.select.append(opt);}type.append(state.select);
      const search=el('label','本页搜索 ');state.search=el('input');state.search.type='search';state.search.placeholder='名称或标识';search.append(state.search);
      const reset=()=>{state.cursors=[null];state.search.value='';void load(state);};
      state.refresh=button('刷新目录',reset);state.select.addEventListener('change',reset);state.search.addEventListener('input',()=>render(state));toolbar.append(type,search,state.refresh);
      state.status=el('p','等待读取服务器目录','catalog-status');state.status.setAttribute('role','status');
      const viewport=el('div',undefined,'catalog-table-viewport'),table=el('table',undefined,'data-table'),head=el('thead'),row=el('tr');
      for(const name of ['名称 / 标识','内容概要','版本','服务器保存时间','操作'])row.append(el('th',name));head.append(row);state.body=el('tbody');table.append(head,state.body);viewport.append(table);
      const pager=el('div',undefined,'catalog-pagination');state.prev=button('上一页',()=>void load(state,state.index-1));state.next=button('下一页',()=>void load(state,state.index+1));state.pageLabel=el('span');pager.append(state.prev,state.pageLabel,state.next);
      host.append(toolbar,state.status,viewport,pager);render(state);return state;
    }
    function activate(){
      if(!d.getElementById('panel-data')?.classList.contains('active'))return;
      if(timer===undefined)timer=g.setInterval(watch,1000);
      for(const host of d.querySelectorAll('#panel-data .tab-panel.active [data-catalog]')){
        if(host.closest('details')&&!host.closest('details').open)continue;
        void load(initialize(host));
      }
    }
    function invalidate(){
      for(const s of states.values()){s.abort?.abort();s.ticket++;s.page=null;s.busy=false;s.index=0;s.cursors=[null];s.status.textContent='服务器或项目已变化，请刷新目录。';render(s);}
      if(dialog?.open){detailController?.abort();detailTicket++;selectedDetail=null;dialog.export.disabled=true;dialog.status.textContent='服务器或项目已变化，请关闭详情并刷新目录。';dialog.fields.replaceChildren();dialog.raw.textContent='';}
    }
    g.DatyDataCatalog={activate,invalidate,openFeature(name){const nav=[...d.querySelectorAll('.nav-item')].find(e=>(e.getAttribute('onclick')||'').includes("'"+name+"'"));g.switchPanel(name,nav);}};
    d.addEventListener('toggle',event=>{if(event.target.matches?.('details.data-catalog-details')&&event.target.open)activate();},true);
    let observed,timer;
    const watch=()=>{try{const next=key(getReader().context());if(observed!==undefined&&observed!==next)invalidate();observed=next;}catch(_){if(observed!==undefined){invalidate();observed=undefined;}}};
    g.addEventListener('pagehide',()=>{if(timer!==undefined)g.clearInterval(timer);invalidate();},{once:true});
    return g.DatyDataCatalog;
  }
  return {createReader,describe,mount,TYPES,GROUPS};
});

;
// ============================================================
// render.js — 设备卡片/通道/告警/频率/监控等渲染函数
// ============================================================

// ══════════════════ REAL-TIME THRESHOLD ALERTS ══════════════════
// 阈值由服务器数据库确认后应用；客户端只保留当前内存视图，不读写本地配置。
// RF 协议单位为 dBm；AF 协议单位为 dBFS；电池为百分比。
const ALERT_THRESHOLD_STORAGE_KEY = 'daty_alert_thresholds_v1';
const DEFAULT_ALERT_THRESHOLDS = Object.freeze({
  rfWeakDbm: -90,
  batteryLowPercent: 20,
  batteryLowBars: 1,
  afOverloadDbfs: -3,
});
let ALERT_THRESHOLDS = {...DEFAULT_ALERT_THRESHOLDS};
let _lastAlertStorageAt = 0;
let _alertRenderTimer = null;
let _realtimeAlertClearPending = false;

function _clampAlertThresholds(values = {}) {
  const numberOr = (value, fallback) => {
    // null/空值以及布尔值不是合法阈值；避免 Number(null)=0、
    // Number(false)=0 把损坏的存储内容变成有效但危险的阈值。
    if (value === null || value === undefined || value === '' || typeof value === 'boolean'
      || (typeof value === 'string' && value.trim() === '')
      || (typeof value !== 'number' && typeof value !== 'string')) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    // 范围固定为 -90（最弱）到 -30 dBm（较强）。
    rfWeakDbm: Math.round(Math.max(-90, Math.min(-30, numberOr(values.rfWeakDbm, DEFAULT_ALERT_THRESHOLDS.rfWeakDbm)))),
    batteryLowBars: Math.round(Math.max(0, Math.min(5, numberOr(values.batteryLowBars, DEFAULT_ALERT_THRESHOLDS.batteryLowBars)))),
    batteryLowPercent: Math.round(Math.max(5, Math.min(50, numberOr(values.batteryLowPercent, DEFAULT_ALERT_THRESHOLDS.batteryLowPercent)))),
    // AF 协议完整有效范围为 -40～0 dBFS；阈值也允许覆盖整个量程。
    afOverloadDbfs: Math.round(Math.max(-40, Math.min(0, numberOr(values.afOverloadDbfs, DEFAULT_ALERT_THRESHOLDS.afOverloadDbfs)))),
  };
}

function _readAlertThresholds() { return {...DEFAULT_ALERT_THRESHOLDS}; }

function getAlertThresholdSettings() {
  return {...ALERT_THRESHOLDS};
}

function setAlertThresholdSettings(values = {}) {
  ALERT_THRESHOLDS = _clampAlertThresholds({...ALERT_THRESHOLDS, ...values});
  _syncAlertThresholdControls();
  return getAlertThresholdSettings();
}

function _syncAlertThresholdControls() {
  const fields = [
    ['rfThreshInput', 'rfThreshVal', ALERT_THRESHOLDS.rfWeakDbm, ' dBm'],
    ['battBarsThreshInput', 'battBarsThreshVal', ALERT_THRESHOLDS.batteryLowBars, ' 格'],
    ['battThreshInput', 'battThreshVal', ALERT_THRESHOLDS.batteryLowPercent, '%'],
    ['afThreshInput', 'afThreshVal', ALERT_THRESHOLDS.afOverloadDbfs, ' dBFS'],
  ];
  fields.forEach(([inputId, valueId, value, suffix]) => {
    const input = document.getElementById(inputId);
    const label = document.getElementById(valueId);
    if (input) input.value = String(value);
    if (label) label.textContent = `${value}${suffix}`;
  });
}

function initializeAlertThresholdSettings() {
  ALERT_THRESHOLDS = _readAlertThresholds();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _syncAlertThresholdControls, {once: true});
  } else {
    _syncAlertThresholdControls();
  }
}

// 设备可能来自 FAshe、旧版服务器或手工录入；这些来源使用的离线状态字符串并不完全一致。
// 将“显式离线”集中判定，保证通道卡、筛选器和阈值引擎不会把断线快照当成在线设备。
function _deviceIsOffline(device) {
  if (!device) return false;
  const offlineFlags = ['false', '0', 'no', 'offline', 'disconnected', 'disconnect',
    'connection_lost', 'connection-lost', 'timeout', 'unavailable', 'lost'];
  const online = device._online ?? device.online;
  if (online === false || online === 0 || offlineFlags.includes(String(online).trim().toLowerCase())) return true;
  const raw = String(device.status || '').trim().toLowerCase();
  return offlineFlags.includes(raw);
}

function _hasNumericTelemetry(value) {
  return typeof value !== 'boolean'
    && value !== null && value !== undefined && value !== ''
    && !(typeof value === 'string' && value.trim() === '')
    && (typeof value === 'number' || typeof value === 'string')
    && Number.isFinite(Number(value));
}

function _validRfDbm(value) {
  return _hasNumericTelemetry(value) && Number(value) >= -150 && Number(value) <= 20;
}

function _validBatteryPercent(value) {
  return _hasNumericTelemetry(value) && Number(value) >= 0 && Number(value) <= 100;
}

function _formatTelemetry(value, suffix = '') {
  return _hasNumericTelemetry(value) ? `${value}${suffix}` : '—';
}

function _formatFrequencyMHz(value) {
  const numeric = _hasNumericTelemetry(value) ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? `${(numeric / 1000).toFixed(3)} MHz` : '—';
}

function _formatRfDbm(value) {
  return _validRfDbm(value) ? `${Number(value).toFixed(0)} dBm` : '—';
}

function _formatBatteryPercent(value) {
  return _validBatteryPercent(value) ? `${Number(value).toFixed(0)}%` : '—';
}

function _rfMeterPercent(value) {
  if (!_validRfDbm(value)) return 0;
  return Math.max(0, Math.min(100, (Number(value) + 90) / 60 * 100));
}

function _rfMeterColor(value) {
  if (!_validRfDbm(value)) return '#4a5578';
  const threshold = getAlertThresholdSettings().rfWeakDbm;
  const caution = Math.min(-30, threshold + 10);
  return Number(value) <= threshold ? '#f43f5e' : Number(value) <= caution ? '#f59e0b' : '#10b981';
}

function _batteryMeterColor(value) {
  if (!_validBatteryPercent(value)) return '#4a5578';
  const threshold = getAlertThresholdSettings().batteryLowPercent;
  const caution = Math.min(100, threshold + 20);
  return Number(value) <= threshold ? '#f43f5e' : Number(value) <= caution ? '#f59e0b' : '#10b981';
}

function _isThresholdManagedDevice(device) {
  return !!(device && (device._thresholdStatusManaged || device._fasheId || device._source));
}

function _thresholdDeviceKey(device) {
  // FAshe ID 在列表重建、通道标签格式变化时仍保持稳定，优先作为设备身份。
  const fasheId = String(device?._fasheId ?? '').trim();
  if (fasheId) return fasheId;
  const id = String(device?.id ?? '').trim();
  if (id) return id;
  const receiver = String(device?.receiverId || device?.receiver_id || device?.ip || '').trim();
  const channel = _canonicalThresholdChannel(device);
  if (receiver && channel) return `${receiver}:${channel}`;
  return String(device?.ch || device?.name || '').trim();
}

// CH-01、CH01、1 等表示同一逻辑通道时，统一为 CH01；Group 数字不参与
// 告警键，避免编组号变化造成通道身份漂移。
function _canonicalThresholdChannel(device) {
  const number = getDeviceChannelNumberSafe(device);
  if (number !== null) return `CH${String(number).padStart(2, '0')}`;
  return '';
}

function _thresholdDeviceLabel(device) {
  const channel = typeof formatChannelDisplay === 'function'
    ? formatChannelDisplay(device)
    : String(device?.ch || device?.channel || device?.id || '通道');
  const name = String(device?.name || '').trim();
  const ip = String(device?.receiver_ip || device?.ip || '').trim() || 'IP 未知';
  const group = getPlannerReceiverGroupNumber(device);
  return `${ip} · ${group === null ? 'GROUP 未知' : 'GROUP'+group} · ${channel} · ${formatBrandModelDisplay(device)}${name ? '（'+name+'）' : ''}`;
}

function _thresholdDeviceEligible(device) {
  return !!device && !_deviceIsOffline(device);
}

function getDeviceThresholdIssues(device, thresholds = ALERT_THRESHOLDS, labelFor = _thresholdDeviceLabel) {
  if (!_thresholdDeviceEligible(device)) return shureConditionIssues(device,thresholds, _thresholdDeviceLabel);
  const issues = [];
  let label;
  const issueLabel=()=>label??(label=labelFor(device));
  const rf = _validRfDbm(device.rf) ? Number(device.rf) : NaN;
  if (Number.isFinite(rf) && rf <= thresholds.rfWeakDbm) {
    issues.push({metric: 'rf', level: 'warn', value: rf, threshold: thresholds.rfWeakDbm,
      msg: `RF 弱信号：${issueLabel()} 当前 ${rf} dBm（阈值 ${thresholds.rfWeakDbm} dBm）`});
  }
  const batt = (!getShureTelemetry(device) || shureFieldFresh(device,'battery_percent')) && _validBatteryPercent(device.batt) ? Number(device.batt) : NaN;
  if (Number.isFinite(batt) && batt <= thresholds.batteryLowPercent) {
    issues.push({metric: 'battery', level: 'warn', value: batt, threshold: thresholds.batteryLowPercent,
      msg: `电池低电量：${issueLabel()} 当前 ${batt}%（阈值 ${thresholds.batteryLowPercent}%）`});
  }
  if (typeof getAfMeter === 'function') {
    const afMeter = getAfMeter(device);
    // 无效/越界 AF 必须按“未知”处理，不能因为内部显示兜底值 -40 而误报。
    const afDbfs = afMeter.available ? Number(afMeter.dbfs) : NaN;
    if (Number.isFinite(afDbfs) && afDbfs >= thresholds.afOverloadDbfs) {
      issues.push({metric: 'af', level: 'crit', value: afDbfs, threshold: thresholds.afOverloadDbfs,
        msg: `AF 过载：${issueLabel()} 当前 ${afDbfs.toFixed(1)} dBFS（阈值 ${thresholds.afOverloadDbfs} dBFS）`});
    }
  }
  issues.push(...shureConditionIssues(device,thresholds,labelFor));
  return issues;
}

function getDeviceDisplayStatus(device, thresholdIssues = getDeviceThresholdIssues(device)) {
  const raw = String(device?.status || '').toLowerCase();
  if (_deviceIsOffline(device)) return 'offline';
  if (raw === 'error') return 'error';
  if (thresholdIssues.length > 0) return 'warn';
  // FAshe/服务器设备的 warn 可能是旧阈值计算结果；保存新阈值后应立即恢复为在线。
  if (_isThresholdManagedDevice(device)) return 'online';
  return raw === 'warn' ? 'warn' : 'online';
}

/**
 * 按当前阈值刷新实时设备的派生 status。
 * 硬件 error/offline 保留，只有由阈值引擎管理的实时设备才重写 warn/online。
 */
function refreshThresholdDerivedStatuses(devices = DEVICES, issuesFor = getDeviceThresholdIssues) {
  if (!Array.isArray(devices)) return 0;
  let changed = 0;
  devices.forEach(device => {
    if (!_isThresholdManagedDevice(device) || _deviceIsOffline(device)) return;
    const raw = String(device.status || '').toLowerCase();
    if (raw === 'error') return;
    const next = issuesFor(device).length > 0 ? 'warn' : 'online';
    if (device.status !== next) {
      device.status = next;
      changed += 1;
    }
  });
  return changed;
}

function _thresholdAlertKey(device, issue) {
  const channel = _canonicalThresholdChannel(device);
  return `threshold:${_thresholdDeviceKey(device)}:${channel || 'channel'}:${issue.metric}`;
}

function _scheduleAlertRender() {
  if (_alertRenderTimer) return;
  const flush = () => {
    _alertRenderTimer = null;
    if (typeof renderAlerts === 'function') renderAlerts();
  };
  if (typeof requestAnimationFrame === 'function') _alertRenderTimer = requestAnimationFrame(flush);
  else _alertRenderTimer = setTimeout(flush, 100);
}

/** 将通道卡当前遥测值与阈值比较，并维护去重的活动告警。 */
// Candidate-only, synchronous projection. Cache pure channel calculations, not
// lifecycle edges or acknowledgements. Every input event still reconciles the
// entire ordered active set and retains original lastSeen/notification rules.
const _mqtt6AlertFields = [
  '_online','online','status','_thresholdStatusManaged','_fasheId','_source',
  'rf','batt','afDbfs','af_dbfs','afLevel','af_level','af','afUnit','af_unit',
  'name','receiver_ip','ip','group_source','group_number','brand','model',
  'channel_number','channel_no','channel','ch','channel_key','id',
  'receiverId','receiver_id','receiver_mac','mac'
];
let _mqtt6AlertCache = null;
// An entry is reusable only when its captured dependencies are scalar. Check
// this once when capturing, rather than once per field on every peer event.
// A later object/function can never equal a captured scalar under Object.is.
function _mqtt6ScalarAlertInputs(inputs) {
  return inputs.every(value=>value===null||
    (typeof value!=='object'&&typeof value!=='function'));
}
// Same nine-field origin comparison as the original reconciliation, without
// allocating a key array and callback for every unchanged active alert.
function _mqtt6AlertOriginMatches(alert,origin) {
  return alert.deviceId===origin.deviceId&&alert.receiverId===origin.receiverId&&
    alert.receiverIP===origin.receiverIP&&alert.receiverMAC===origin.receiverMAC&&
    alert.channel===origin.channel&&alert.groupNumber===origin.groupNumber&&
    alert.receiverBrand===origin.receiverBrand&&alert.receiverModel===origin.receiverModel&&
    alert.channelId===origin.channelId;
}
function _mqtt6AfPresence(device) {
  const own=Object.prototype.hasOwnProperty;
  return Number(own.call(device,'afDbfs'))|Number(own.call(device,'af_dbfs'))<<1|
    Number(own.call(device,'afLevel'))<<2|Number(own.call(device,'af_level'))<<3;
}
function _mqtt6ProjectAlerts(devices, options) {
  const context=[ALERT_THRESHOLDS.batteryLowBars,ALERT_THRESHOLDS.rfWeakDbm,ALERT_THRESHOLDS.batteryLowPercent,ALERT_THRESHOLDS.afOverloadDbfs,
    getDeviceThresholdIssues,getAfMeter,_thresholdDeviceLabel,_thresholdAlertKey,
    getDeviceChannelNumberSafe,getPlannerReceiverGroupNumber,formatBrandModelDisplay,formatChannelDisplay];
  // Full snapshots, explicit UI/threshold edits and non-delta callers rebuild.
  // Scalar dependency guards also catch unannounced edits on another channel.
  if(!Array.isArray(options.changedDevices)||!_mqtt6AlertCache||
      context.some((value,i)=>!Object.is(value,_mqtt6AlertCache.context[i])))
    _mqtt6AlertCache={context,entries:new WeakMap()};
  const state=_mqtt6AlertCache,cache=state.entries;
  let rebuild=state.projectionDirty||!state.order||state.order.length!==devices.length;
  let changedEntries=null;
  let index=0;
  for(const device of devices) {
    if(!rebuild&&state.order[index]!==device)rebuild=true;
    index++;
    if(!device||typeof device!=='object')continue;
    let entry=cache.get(device);
    const presence=String(_mqtt6AfPresence(device))+'|'+shureAlertSignature(device);
    let same=!!entry&&entry.scalar&&presence===entry.presence;
    if(same)for(let i=0;i<_mqtt6AlertFields.length;i++){
      const value=device[_mqtt6AlertFields[i]];
      if(!Object.is(value,entry.inputs[i])){same=false;break;}
    }
    if(!same){
      let label;
      const labelFor=()=>label??(label=_thresholdDeviceLabel(device));
      const issues=getDeviceThresholdIssues(device,ALERT_THRESHOLDS,labelFor);
      refreshThresholdDerivedStatuses([device],()=>issues);
      const entries=issues.map(issue=>{
        const key=_thresholdAlertKey(device,issue);
        const origin={deviceId:labelFor(),receiverId:device.receiverId||device.receiver_id||null,
          receiverIP:device.receiver_ip||device.ip||null,receiverMAC:device.receiver_mac||device.mac||null,
          channel:getDeviceChannelNumberSafe(device),groupNumber:getPlannerReceiverGroupNumber(device),
          receiverBrand:device.brand||null,receiverModel:device.model||null,
          channelId:device._fasheId||device.id||null};
        return {key,issue,origin,expected:{device,issue,key}};
      });
      // Map.set preserves iteration order for an existing key. Only value
      // changes may use this path; new/ended/reordered keys require a rebuild.
      if(!entry||entries.length!==entry.entries.length||
          entries.some((item,i)=>item.key!==entry.entries[i].key))rebuild=true;
      const inputs=_mqtt6AlertFields.map(key=>device[key]);
      entry={presence,inputs,scalar:_mqtt6ScalarAlertInputs(inputs),entries};
      // Cache entries are prepared before the projection is committed. If any
      // later channel throws, the next pass must rebuild from every entry,
      // including channels whose unchanged inputs now hit the prepared cache.
      state.projectionDirty=true;
      cache.set(device,entry);
      (changedEntries??=[]).push(entry);
    }
  }
  // Legacy duplicate keys use the last device in display order. Rebuilding
  // retains that rule even when the earlier duplicate is the only delta.
  if(changedEntries&&state.duplicateKeys)rebuild=true;
  if(rebuild){
    state.projectionDirty=true;
    const expected=new Map(),origins=new Map();
    let duplicateKeys=false;
    // Rebuild the projection in the original order when its key order changes.
    // The caller never mutates this map; lifecycle reconciliation still runs
    // for every event, even when all pure projection inputs are identical.
    for(const device of devices){
      const entry=device&&typeof device==='object'?cache.get(device):null;
      for(const item of entry?.entries||[]){
        if(expected.has(item.key))duplicateKeys=true;
        expected.set(item.key,item.expected);origins.set(item.key,item.origin);
      }
    }
    state.order=devices.slice();state.projection={expected,origins};state.duplicateKeys=duplicateKeys;
  }else if(changedEntries){
    for(const entry of changedEntries)for(const item of entry.entries){
      state.projection.expected.set(item.key,item.expected);
      state.projection.origins.set(item.key,item.origin);
    }
  }
  state.projectionDirty=false;
  return state.projection;
}

function evaluateRealtimeAlerts(devices = DEVICES, options={}) {
  if (!Array.isArray(devices) || typeof ALERTS === 'undefined') return {added: 0, updated: 0, removed: 0, active: 0};
  const projection=_mqtt6ProjectAlerts(devices,options);
  if(options.recommendationRefresh!==false)globalThis.DatyAutoFrequency?.requestRefresh();
  const expected = projection.expected;
  // Audio follows current threshold edges, never history/UI refreshes; audio failure
  // must not interrupt telemetry, archiving, card rendering or device controls.
  if (globalThis.DatyAlertSound) {
    try { globalThis.DatyAlertSound.observe([...expected.values()].filter(({issue})=>!issue.pending).map(({key, issue}) => ({key, level:issue.level, metric:issue.metric==='battery_bars'?'battery':issue.metric}))); }
    catch (error) { console.warn('声音告警不可用，实时告警继续运行:', error); }
  }

  let added = 0, updated = 0, removed = 0, structureChanged = false;
  const now = Date.now();
  for (let index = ALERTS.length - 1; index >= 0; index -= 1) {
    const existing = ALERTS[index];
    if (existing?.source !== 'threshold-monitor') continue;
    if (!expected.has(existing.key)) {
      if (typeof queueAlertForArchive === 'function') queueAlertForArchive(existing, 'ended');
      ALERTS.splice(index, 1);
      removed += 1;
      structureChanged = true;
    }
  }
  const existingByKey=new Map();
  for(const alert of ALERTS)if(alert?.source==='threshold-monitor'&&!existingByKey.has(alert.key))existingByKey.set(alert.key,alert);
  expected.forEach(({device, issue, key}) => {
    const existing = existingByKey.get(key);
    const origin = projection.origins.get(key);
    if (existing) {
      if (existing.msg !== issue.msg || existing.value !== issue.value || existing.threshold !== issue.threshold || existing.level !== issue.level
        || !_mqtt6AlertOriginMatches(existing,origin)) {
        Object.assign(existing, origin, {msg: issue.msg, value: issue.value, threshold: issue.threshold, level: issue.level, ts: now});
        updated += 1;
      }
      existing.lastSeen = now;
      if (typeof queueAlertForArchive === 'function') queueAlertForArchive(existing);
    } else {
      const alert = {id: key, key, source: 'threshold-monitor', level: issue.level, metric: issue.metric,
        msg: issue.msg, ...origin, value: issue.value, threshold: issue.threshold,
        ts: now, firstSeen: now, lastSeen: now};
      if (typeof queueAlertForArchive === 'function') queueAlertForArchive(alert);
      ALERTS.push(alert);
      added += 1;
      structureChanged = true;
    }
  });
  // 结构变化立即落盘；遥测值变化最多每秒落盘一次，避免高频 SSE 造成同步写入抖动。
  if ((structureChanged || (updated && now - _lastAlertStorageAt >= 1000)) && typeof saveDataToStorage === 'function') {
    try { saveDataToStorage(); }
    catch (error) { console.warn('实时告警缓存写入失败，保留内存状态:', error); }
    _lastAlertStorageAt = now;
  }
  if (added || removed) {
    if (typeof renderAlerts === 'function') renderAlerts();
  } else if (updated) {
    _scheduleAlertRender();
  }
  if ((added || updated || removed) && typeof updateDashboardStats === 'function') updateDashboardStats();
  // 历史日志由 30 秒归档刷新，不随每一笔实时遥测重建整张历史表。
  return {added, updated, removed, active: expected.size};
}

initializeAlertThresholdSettings();

// ══════════════════ RENDER ══════════════════
// Vendor telemetry is a separate display DTO; canonical alarm percentages and
// DATY AF validation keep their existing units and thresholds.
function shureFieldFresh(d, key) {
  const s = getShureTelemetry(d);
  return !!s && !_deviceIsOffline(d) && !(s.stale_fields || []).includes(key);
}

function shureConditionIssues(d, thresholds, labelFor) {
  const s = getShureTelemetry(d);
  if (!s) return [];
  const issues = [], unknown = new Set();
  const add = (metric, title, value=1, threshold=1) => issues.push({metric,level:'warn',value,threshold,msg:`${title}：${labelFor(d)}`});
  const condition = (field, metric, title, positive, clear) => {
    const value=s[field];
    if (!shureFieldFresh(d,field) || ![...positive,...clear].includes(value)) unknown.add(metric);
    else if (positive.includes(value)) add(metric,title);
  };
  const percentKnown=shureFieldFresh(d,'battery_percent') && _validBatteryPercent(d.batt);
  const bars=s.battery_bars, limit=Number.isInteger(thresholds.batteryLowBars)?thresholds.batteryLowBars:1;
  if (!percentKnown) {
    if (!shureFieldFresh(d,'battery_bars') || !Number.isInteger(bars) || bars<0 || bars>5) unknown.add('battery_bars');
    else if (bars<=limit) add('battery_bars',`电池低电量 ${bars}/5 格（阈值 ${limit} 格）`,bars,limit);
  }
  if (!percentKnown && (!shureFieldFresh(d,'battery_bars') || !Number.isInteger(bars))) unknown.add('battery');
  condition('battery_runtime_status','battery_error','电池通讯错误',['error'],['known','calculating']);
  condition('interference','rf_interference','接收机报告 RF 干扰',['CRITICAL','DETECTED'],['NONE']);
  condition('interference_secondary','rf_interference_secondary','第二频率分支 RF 干扰',['DETECTED'],['NONE']);
  condition('encryption_warning','encryption_mismatch','加密不匹配',['ON','ERROR'],['OFF','OK']);
  condition('unregistered_transmitter','unregistered_transmitter','未登记的发射机',['ERROR'],['OK']);
  // An unknown/offline update is not evidence that a vendor fault recovered.
  // Keep an existing episode pending, with its original identity and firstSeen.
  if (typeof ALERTS !== 'undefined') for (const old of ALERTS) {
    if (old.source!=='threshold-monitor' || old.channelId!==(d._fasheId||d.id) || !unknown.has(old.metric)) continue;
    issues.push({metric:old.metric,level:old.level,value:old.value,threshold:old.threshold,pending:true,
      msg:old.msg.replace(/（当前状态待确认）$/,'')+'（当前状态待确认）'});
  }
  return issues;
}

function shureAlertSignature(d) {
  const s=getShureTelemetry(d);
  return s ? JSON.stringify([s.audio_dbfs,s.meter_state,s.battery_bars,s.battery_runtime_status,
    s.interference,s.interference_secondary,s.encryption_warning,s.unregistered_transmitter,s.stale_fields]) : '';
}

function shureFieldAgeText(s, keys) {
  const times=keys.map(key=>s.field_times?.[key]).filter(value=>typeof value==='number' && Number.isFinite(value));
  return times.length ? `更新时间 ${new Date(Math.max(...times)).toLocaleTimeString()}` : '更新时间未知';
}

function getShureTelemetry(d) {
  return d?._source === 'shure-scp' && d.brand === 'Shure'
    && d.shure?.schema === 'daty-shure-telemetry-v1' ? d.shure : null;
}

function getBatteryMeter(d) {
  const shure = getShureTelemetry(d);
  const valid = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  const percent = (!shure || shureFieldFresh(d,'battery_percent')) && _validBatteryPercent(d.batt) ? Number(d.batt) : null;
  const bars = shure && shureFieldFresh(d,'battery_bars') && Number.isInteger(shure.battery_bars) && valid(shure.battery_bars,0,5) ? shure.battery_bars : null;
  const minutes = shure && shureFieldFresh(d,'battery_minutes') && Number.isInteger(shure.battery_minutes) && valid(shure.battery_minutes,0,65532) ? shure.battery_minutes : null;
  const remaining = minutes === null ? ({calculating:'剩余时间计算中',error:'电池通讯错误',unknown:'剩余时间未知'}[shureFieldFresh(d,'battery_runtime_status') ? shure?.battery_runtime_status : 'unknown'] || '剩余时间未知')
    : `剩余 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  const label = percent !== null ? _formatBatteryPercent(d.batt) : bars !== null ? `${bars}/5格` : minutes !== null ? `${minutes}分` : shure && (shure.stale_fields||[]).some(k=>k.startsWith('battery_')) ? '已过期' : '—';
  const batteryType = {LION:'锂离子充电电池',ALKA:'碱性电池',NIMH:'镍氢电池',LITH:'锂电池',WARN:'充电中'}[shure?.battery_type];
  return {label, percent:percent ?? (bars !== null ? bars * 20 : 0),
    title:shure ? [percent !== null ? `电量 ${percent}%` : '精确电量百分比未知',bars !== null ? `电池 ${bars}/5 格` : '',remaining,batteryType,shureFieldAgeText(shure,['battery_bars','battery_percent','battery_minutes']),
      ...[['battery_health_percent','健康度','%'],['battery_cycles','循环','次'],['battery_temperature_c','温度','℃']].map(([key,label,unit])=>shureFieldFresh(d,key)&&typeof shure[key]==='number'?label+' '+shure[key]+unit:'')].filter(Boolean).join('；')
      : `电池低电量阈值 ${getAlertThresholdSettings().batteryLowPercent}%`};
}

function getShureMuteLabel(d) {
  const s = getShureTelemetry(d);
  return !s ? '' : !shureFieldFresh(d,'transmitter_muted') ? '话筒状态已过期' : s.transmitter_muted === true ? '话筒已静音' : s.transmitter_muted === false ? '话筒未静音' : '话筒静音未知';
}

function getShureTransmitterLabel(d) {
  const s = getShureTelemetry(d);
  if (!s) return '';
  if (!shureFieldFresh(d,'transmitter_type')) return '话筒型号已过期';
  return typeof s.transmitter_type === 'string' && /^[A-Za-z0-9-]{1,32}$/.test(s.transmitter_type)
    ? `话筒 ${s.transmitter_type}` : '话筒型号未知';
}

function getShureStatusText(d) {
  const s = getShureTelemetry(d);
  if (!s) return '';
  const tx = typeof s.transmitter_type === 'string' && /^[A-Za-z0-9-]{1,32}$/.test(s.transmitter_type) ? s.transmitter_type : '未知';
  const mute = (value,key) => !shureFieldFresh(d,key) ? '已过期' : value === true ? '静音' : value === false ? '未静音' : '未知';
  const encryption={OFF:'关闭',ON:'开启',AUTO:'自动',MANUAL:'手动'}[s.settings?.encryption_mode] || '未知';
  const antenna=s.antenna_status && /^[XRB]{2,4}$/.test(s.antenna_status) ? s.antenna_status : s.rf_antenna;
  const radio=(s.meter_state && s.meter_state!=='live') ? '电平已过期' : /^(AX|XB|AB|XX|[XRB]{2,4})$/.test(antenna||'') ? '天线 '+antenna : '天线未知';
  const branchEntries=s.rf_branches ? Object.entries(s.rf_branches) : [['1',{rf_antennas_dbm:s.rf_antennas_dbm}]];
  const levels=branchEntries.filter(([f])=>/^[12]$/.test(f)).flatMap(([f,b])=>Object.entries(b?.rf_antennas_dbm||{}).filter(([k,v])=>/^[1-4]$/.test(k)&&typeof v==='number').map(([k,v])=>(branchEntries.length>1?'F'+f+' ':'')+'天线'+k+' '+v+' dBm')).join(' / ');
  const peak=typeof s.audio_peak_dbfs==='number' && s.meter_state==='live' ? ' · 峰值 '+s.audio_peak_dbfs+' dBFS' : '';
  const band=d.capabilities?.hardware_band;
  const bandText=band?.band && /^[A-Z][A-Z0-9-]{1,15}$/.test(band.band) ? `频段 ${band.band}（${band.source==='receiver-reported'?'设备上报':band.source==='chassis-label-confirmed'?'机身标签确认':'来源冲突'}） · ` : '频段未识别 · ';
  return `${bandText}话筒 ${shureFieldFresh(d,'transmitter_type')?tx:'已过期'} · 输出${mute(s.receiver_muted,'muted')} · 发射端${mute(s.transmitter_muted,'transmitter_muted')} · 加密${shureFieldFresh(d,'settings.encryption_mode')?encryption:'已过期'} · ${radio}${levels?' · '+levels:''}${peak}`;
}

function getAfMeter(d = {}) {
  const unavailable = () => ({ dbfs: -40, percent: 0, available: false });
  const shure = getShureTelemetry(d);
  if (shure) {
    if (_deviceIsOffline(d) || (shure.meter_state && shure.meter_state !== 'live')) return unavailable();
    const floor = ({ULXD4:-50,ULXD4D:-50,ULXD4Q:-50,AD4D:-120,AD4Q:-120})[d.model];
    const value = shure.audio_dbfs;
    if (!Number.isFinite(floor) || typeof value !== 'number' || !Number.isFinite(value) || value < floor || value > 0) return unavailable();
    return {dbfs:value, percent:(value-floor)/-floor*100, available:true, title:`${floor}～0 dBFS（舒尔 RMS）${shure.meter_state === 'live' ? ' · 实时电平' : ''}`};
  }
  // 新版/桥接数据可能使用 camelCase、snake_case 或 afLevel；这些字段均表示 dBFS。
  const explicitFields = ['afDbfs', 'af_dbfs', 'afLevel', 'af_level'];
  for (const field of explicitFields) {
    if (!Object.prototype.hasOwnProperty.call(d, field)) continue;
    // Canonical current afDbfs is authoritative, including explicit unknown.
    // Do not resurrect an older snake-case/legacy alias after a null update.
    const value = _hasNumericTelemetry(d[field]) ? Number(d[field]) : NaN;
    if (!Number.isFinite(value) || value < -40 || value > 0) return unavailable();
    const dbfs = value;
    return { dbfs, percent: (dbfs + 40) / 40 * 100, available: true };
  }
  const rawAf = d.af;
  const af = _hasNumericTelemetry(rawAf) ? Number(rawAf) : NaN;
  if (Number.isFinite(af)) {
    // 直传的负值 af 是 dBFS；正值仍按历史百分比解释。
    // 实时协议明确规定 0 dBFS 为满量程，因此带实时来源标记的 af=0 也按 dBFS 处理。
    const realtimeAf = !!(d._fasheId || d._source || d._thresholdStatusManaged || d.afUnit === 'dBFS' || d.af_unit === 'dBFS');
    if (af < 0 || (realtimeAf && af === 0)) {
      if (af < -40 || af > 0) return unavailable();
      const dbfs = Math.max(-40, Math.min(0, af));
      return { dbfs, percent: (dbfs + 40) / 40 * 100, available: true };
    }
    // 实时协议的 af 已明确为 dBFS；正值不是合法的 dBFS，也不能再按旧百分比猜测。
    if (realtimeAf && (af < -40 || af > 0)) return unavailable();
    if (af > 100) return unavailable();
    const percent = Math.max(0, Math.min(100, af));
    return { dbfs: -40 + percent * 0.4, percent, available: true };
  }

  return { dbfs: -40, percent: 0, available: false };
}

// ── 接收机/静音身份规范化 ───────────────────────────────────────────
// 一个物理接收机可以有任意数量的 CH；IP/MAC 属于接收机，Group 只是
// 编组元数据。所有前端模块共用下面的规范化函数，避免不同页面各自用
// “名称/Group/ID 中的数字”猜测身份而产生串台。
function normalizeMutedValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'muted'].includes(text)) return true;
  if (['false', '0', 'no', 'off', 'unmuted', 'normal'].includes(text)) return false;
  return !!fallback;
}

function _receiverIdentityText(value) {
  let text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';
  text = text.replace(/^[a-z][a-z\d+.-]*:\/\//, '').split('/')[0];
  if (text.startsWith('[')) text = text.replace(/^\[|\]$/g, '');
  else {
    const parts = text.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) text = parts[0];
  }
  // 公开/内部通道 ID 的后缀不能成为接收机身份的一部分。
  text = text.replace(/(?:[_-])ch\s*\d+$/i, '');
  if (/^group\s*[-_:#/ ]*\d+$/i.test(text)) return '';
  // MQTT/WS 会话后缀是传输层信息，不是硬件身份。
  text = text.replace(/:(?:mqtt|ws|sse)(?::[^:]*)?$/i, '');
  // FAshe 的 MQTT client_id 可能带随机会话后缀（例如
  // FAshe-192.0.2.102_ab12）；IP 仍是同一台接收机的身份。
  const fasheIp = text.match(/^fashe-((?:\d{1,3}\.){3}\d{1,3})(?:[_-][a-z0-9-]+)?$/i);
  if (fasheIp && _receiverIpKey(fasheIp[1])) return `fashe-${fasheIp[1]}`;
  return text;
}

function _receiverMacKey(value) {
  const text = String(value ?? '').trim();
  if (!text || /^mac[-_]?(?:\d{1,3}[-_.]){3}\d{1,3}$/i.test(text)) return '';
  const compact = text.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(compact) ? `mac:${compact}` : '';
}

function _receiverIpKey(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const parts = text.split('.');
  return parts.length === 4 && parts.every(part => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
    ? `ip:${parts.join('.')}` : '';
}

function getReceiverIdentityAliases(device = {}) {
  if (device === null || device === undefined) return new Set();
  const value = typeof device === 'object' ? device : {receiver_id: device};
  const aliases = new Set();
  const addId = raw => {
    const text = _receiverIdentityText(raw);
    if (!text) return;
    const macMatch = text.match(/^fashe-mac-([0-9a-f]{12})$/i);
    if (macMatch) aliases.add(`mac:${macMatch[1].toLowerCase()}`);
    const ipMatch = text.match(/^fashe-((?:\d{1,3}\.){3}\d{1,3})$/i);
    if (ipMatch) {
      const ipKey = _receiverIpKey(ipMatch[1]);
      if (ipKey) aliases.add(ipKey);
    }
    aliases.add(`id:${text}`);
  };
  ['receiver_mac', 'receiverMac', 'mac_address', 'mac', 'hardware_mac'].forEach(key => {
    const macKey = _receiverMacKey(value[key]);
    if (macKey) aliases.add(macKey);
  });
  ['receiver_ip', 'receiverIp', 'ip_address', 'ipAddress', 'ip'].forEach(key => {
    const ipKey = _receiverIpKey(value[key]);
    if (ipKey) aliases.add(ipKey);
  });
  ['receiver_id', 'receiverId', '_receiver_id', '_fasheId', 'client_id', '_source', 'id'].forEach(key => addId(value[key]));
  return aliases;
}

function getCanonicalReceiverKey(device = {}) {
  const aliases = getReceiverIdentityAliases(device);
  const mac = [...aliases].find(alias => alias.startsWith('mac:'));
  if (mac) return mac;
  const ip = [...aliases].find(alias => alias.startsWith('ip:'));
  if (ip) return ip;
  const id = [...aliases].find(alias => alias.startsWith('id:'));
  return id || '';
}

function getChannelCardKey(d) {
  const channel = getDeviceChannelNumberSafe(d, null);
  // 实时通道卡的主键必须是“接收机身份 + CH”；原始 id 有时只含
  // 接收机名（或多个页面复用同一个 id），不能单独作为卡片主键。
  const receiver = getCanonicalReceiverKey(d);
  if (receiver && channel !== null) return encodeURIComponent(`${receiver}_ch${channel}`);
  const stable = d._fasheId || d.id;
  return encodeURIComponent(stable || String(d.ch || 'channel'));
}

// 页面 ID 只是本地操作索引；真实路由仍使用 _fasheId / IP(MAC) + CH。
function _localDeviceIdKey(id) {
  if (typeof id === 'number') return Number.isSafeInteger(id) && id >= 0 ? String(id) : '';
  return typeof id === 'string' && id.trim() ? String(id) : '';
}

function allocateLocalDeviceId(devices = DEVICES) {
  const reserved = new Set(devices.map(device => _localDeviceIdKey(device?.id)).filter(Boolean));
  let next = 1;
  while (reserved.has(String(next))) next++;
  return next;
}

function repairRealtimeDeviceIds(devices = DEVICES) {
  const ids = new Map(), routes = new Map();
  for (const device of devices) {
    const key = _localDeviceIdKey(device?.id), route = String(device?._fasheId ?? '').trim();
    if (key) ids.set(key, (ids.get(key) || 0) + 1);
    if (route) routes.set(route, (routes.get(route) || 0) + 1);
  }
  let changed = 0;
  for (const device of devices) {
    const key = _localDeviceIdKey(device?.id), route = String(device?._fasheId ?? '').trim();
    if (key && ids.get(key) === 1) continue;
    const suffix = route.match(/_ch(\d+)$/i);
    // 仅修复身份唯一、CH 一致的实时设备；缺少身份或真正重复的通道继续拒绝规划。
    if (!suffix || routes.get(route) !== 1 || getDeviceChannelNumberSafe(device) !== Number(suffix[1])) continue;
    device.id = allocateLocalDeviceId(devices);
    changed++;
  }
  if (changed && typeof invalidateCoordination === 'function') invalidateCoordination('已修复重复或缺失的页面 ID，请重新规划');
  return changed;
}

// 通道卡按钮同时兼容数字 ID 与 FAshe/服务器返回的字符串 ID。
// 使用单引号并转义，避免带连字符的字符串被当成未定义变量或破坏 HTML 属性。
function _deviceActionArg(id) {
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  const value = String(id ?? '');
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]/g, ' ')}'`;
}

// 解析显式 CH/channel 号。关键规则：Group1/CH2 → 2，Group1（没有
// CH 标记）→ 无效；绝不能取字符串中的第一个数字。
function getCanonicalChannelNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return number > 0 ? number : fallback;
  }
  const marked = text.match(/(?:^|[^a-z])(?:channel|ch)\s*[-_:#\s]*[^0-9\s]{0,4}\s*(\d+)/i);
  if (marked) {
    const number = Number(marked[1]);
    return number > 0 ? number : fallback;
  }
  const suffix = text.match(/_ch\s*(\d+)$/i);
  if (suffix) {
    const number = Number(suffix[1]);
    return number > 0 ? number : fallback;
  }
  return fallback;
}

function getDeviceChannelNumberSafe(device, fallback = null) {
  if (!device) return fallback;
  for (const key of ['channel_number', 'channel_no', 'channel', 'ch', 'channel_key']) {
    if (!Object.prototype.hasOwnProperty.call(device, key)) continue;
    const parsed = getCanonicalChannelNumber(device[key], null);
    if (parsed !== null) return parsed;
  }
  const suffix = String(device._fasheId || device.id || '').match(/_ch(\d+)$/i);
  return suffix ? Number(suffix[1]) : fallback;
}

// 通道卡只显示一次 CH 前缀，并保留 FAshe 发送的实际通道序号。
function formatChannelDisplay(d) {
  const number = getDeviceChannelNumberSafe(d);
  return number !== null ? `CH${number}` : 'CH?';
}

// 通道卡首行显示接收机的品牌与型号；CH 号单独放在下一行，避免把
// “DATYaudio-CH1”误认为设备型号，也避免 Group/CH 标签混在名称里。
function formatBrandModelDisplay(d) {
  const value = (raw, fallback) => typeof raw === 'string' && raw.trim() && !/^[-—]+$/.test(raw.trim()) ? raw.trim() : fallback;
  return `${value(d?.brand, '未知品牌')} ${value(d?.model, '未知型号')}`;
}

// Product labels come only from reported fields, never IDs, transport names or CH names.
// Plain text for textContent or escaped HTML; presentation never changes routing/ordering.
function formatReceiverProductSummary(devices, limit = 2) {
  const products = [...new Set((Array.isArray(devices) ? devices : []).map(formatBrandModelDisplay))];
  if (!products.length) return '接收机';
  return products.slice(0, limit).join(' / ') + (products.length > limit ? ` 等${products.length}种接收机` : '');
}

function updateReceiverProductDisplays() {
  const devices = (typeof DEVICES === 'undefined' ? [] : DEVICES).filter(d => d && (d._fasheId || d._serverManaged));
  const online = devices.filter(d => typeof _deviceConnectionIsOnline === 'function' ? _deviceConnectionIsOnline(d) : !_deviceIsOffline(d));
  const current = online.length ? online : devices;
  const title = document.getElementById('receiverDataTitle');
  const detail = document.getElementById('receiverDataDescription');
  if (title) {
    title.textContent = formatReceiverProductSummary(current) + ' · 实时数据接收';
    title.title = formatReceiverProductSummary(current, Infinity);
  }
  if (detail) detail.textContent = '通过服务器接收接收机上报的数据，品牌和型号随实时信息更新';
}

// 通道卡的 Group 仅用于显示，不参与设备/CH 路由。编号按接收机的
// MAC 优先、IP 次之分配；同一台接收机的所有 CH 共用一个编号。把别名
// 一起写入映射，设备从“仅 IP”变为“MAC+IP”后也不会换 GroupN。
const RECEIVER_GROUP_MAP_STORAGE_KEY = 'daty_receiver_group_numbers_v1';
let _receiverGroupNumbers = null;

function _loadReceiverGroupNumbers() {
  if (_receiverGroupNumbers) return _receiverGroupNumbers;
  _receiverGroupNumbers = Object.create(null);
  try {
    const stored = JSON.parse((globalThis.DatyPlatform === undefined ? localStorage : globalThis.DatyPlatform.storage).getItem(RECEIVER_GROUP_MAP_STORAGE_KEY) || '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      Object.entries(stored).forEach(([key, value]) => {
        const number = Number(value);
        if (/^(?:mac|ip|id):/.test(key) && Number.isInteger(number) && number > 0) {
          _receiverGroupNumbers[key] = number;
        }
      });
    }
  } catch (_) {
    // 平台存储不可用时沿用当前会话内存映射，不另写浏览器存储。
  }
  return _receiverGroupNumbers;
}

function _saveReceiverGroupNumbers() {
  try {
    (globalThis.DatyPlatform === undefined ? localStorage : globalThis.DatyPlatform.storage).setItem(RECEIVER_GROUP_MAP_STORAGE_KEY, JSON.stringify(_receiverGroupNumbers));
  } catch (_) {
    // 页面隐私模式或存储配额不足时不影响卡片显示。
  }
}

function _receiverGroupIdentityKeys(device) {
  const aliases = typeof getReceiverIdentityAliases === 'function'
    ? getReceiverIdentityAliases(device) : new Set();
  const hardwareKeys = [...aliases].filter(key => /^(?:mac|ip):/.test(key));
  if (hardwareKeys.length) return hardwareKeys;
  return [...aliases].filter(key => /^id:/.test(key));
}

function getReceiverGroupNumber(device) {
  // Server ownership wins over stale browser maps and self-reported Group.
  if (device?.group_source === 'server-fifo-v1') {
    const assigned = Number(device.group_number);
    return Number.isInteger(assigned) && assigned > 0 ? assigned : null;
  }
  const keys = _receiverGroupIdentityKeys(device);
  if (!keys.length) return null;
  const map = _loadReceiverGroupNumbers();
  const known = keys.map(key => map[key]).find(number => Number.isInteger(number) && number > 0);
  const number = known || (Object.values(map).reduce((max, value) => Math.max(max, Number(value) || 0), 0) + 1);
  let changed = false;
  keys.forEach(key => {
    if (map[key] !== number) {
      map[key] = number;
      changed = true;
    }
  });
  if (changed) _saveReceiverGroupNumbers();
  return number;
}

function formatGroupChannelDisplay(d) {
  const groupNumber = getReceiverGroupNumber(d);
  return `${groupNumber === null ? 'GUP?' : `GUP${groupNumber}`} · ${formatChannelDisplay(d)}`;
}

function getMuteControlState(d) {
  const shure = getShureTelemetry(d);
  if (shure && d.capabilities?.mute !== true) {
    const fresh = shureFieldFresh(d,'muted');
    const value = fresh ? shure.receiver_muted : null;
    return {muted:value === true, pending:false, readOnly:true,
      label:!fresh ? '输出状态已过期' : value === true ? '输出已静音' : value === false ? '输出未静音' : '输出静音未知',
      title:'接收机音频输出状态；当前仅监测'};
  }
  const key = String(d._fasheId || d.id || '');
  const muted = normalizeMutedValue(d.muted);
  const pending = typeof window !== 'undefined' && !!window.__DATY_MUTE_COMMANDS_IN_FLIGHT?.has(key);
  const target = typeof window !== 'undefined' ? window.__DATY_MUTE_COMMAND_TARGETS?.get(key) : undefined;
  const action = pending ? (target === false ? '取消静音' : '静音') : (muted ? '取消静音' : '静音');
  return {muted, pending, label:pending ? `⏳ ${action}中…` : `${muted?'🔊':'🔇'} ${action}`,
    title:pending ? `等待设备确认${action}` : (shure ? '接收机输出'+action+' · 下发后回读确认' : action)};
}

function createMuteControlButtonHTML(d, control = getMuteControlState(d)) {
  if (control.readOnly) return `<button data-role="mute-button" data-mute-device-key="${escapeAlertText(getChannelCardKey(d))}" class="btn btn-outline btn-sm" disabled title="${control.title}" aria-label="${control.title}">${control.label}</button>`;
  return `<button data-role="mute-button" data-mute-device-key="${escapeAlertText(getChannelCardKey(d))}"
    class="btn ${control.muted?'btn-unmute':'btn-mute'} btn-sm" ${control.pending?'disabled':''} aria-busy="${control.pending}"
    onclick="${control.muted?'unmuteDevice':'muteDevice'}(${_deviceActionArg(d.id)})"
    title="${control.title}" aria-label="${control.title}">${control.label}</button>`;
}

function patchMuteControlButton(button, d, control = getMuteControlState(d)) {
  button.className = `btn ${control.readOnly ? 'btn-outline' : control.muted?'btn-unmute':'btn-mute'} btn-sm`;
  button.disabled = !!control.readOnly || control.pending;
  button.textContent = control.label;
  button.title = control.title;
  button.setAttribute('aria-label', control.title);
  button.setAttribute('aria-busy', String(control.pending));
  if (control.readOnly) button.removeAttribute('onclick');
  else button.setAttribute('onclick', `${control.muted?'unmuteDevice':'muteDevice'}(${_deviceActionArg(d.id)})`);
}

function refreshMuteControlButtons(d) {
  // 只更新本通道按钮，不重建整张卡；首页和通道总览共用同一忙碌/解锁规则。
  const key = getChannelCardKey(d);
  const control = getMuteControlState(d);
  document.querySelectorAll('[data-mute-device-key]').forEach(button => {
    if (button.dataset.muteDeviceKey === key) patchMuteControlButton(button, d, control);
  });
}

function getChannelCardState(d, locks = globalThis.DatyPlanningConstraints?.getLockedFrequencyView()?.locks) {
  const lock = locks?.get(String(d.id));
  const note = !lock?.invalid && typeof lock?.reason === 'string' ? lock.reason.trim() : '';
  const usage = note && !['用户锁定','手动指定频率'].includes(note) ? note : '';
  const afMeter = getAfMeter(d);
  const thresholdIssues = getDeviceThresholdIssues(d);
  const batteryThreshold = getAlertThresholdSettings().batteryLowPercent;
  const batteryAvailable = _validBatteryPercent(d.batt);
  const displayStatus = getDeviceDisplayStatus(d, thresholdIssues);
  const statusColor = {online:'#10b981',warn:'#f59e0b',error:'#f43f5e',offline:'#4a5578'}[displayStatus] || '#4a5578';
  return {
    afMeter,
    batteryMeter:getBatteryMeter(d),
    shureDetails:getShureStatusText(d),
    usage,
    thresholdIssues,
    displayStatus,
    // RF 显示与阈值统一采用 -90～-30 dBm 标尺。
    rfPercent: _rfMeterPercent(d.rf),
    battPercent: getBatteryMeter(d).percent,
    battColor: thresholdIssues.some(issue=>['battery','battery_bars'].includes(issue.metric)&&!issue.pending) ? 'mf-batt-low' : 'mf-batt',
    rfColor: _rfMeterColor(d.rf),
    batteryAvailable,
    batteryThreshold,
    statusColor,
    statusLabel: {online:'在线',warn:'注意',error:'错误',offline:'离线'}[displayStatus] || '离线',
    brandClass: {AMSaudio:'brand-ams',Shure:'brand-shure',Sennheiser:'brand-senn',DATYaudio:'brand-daty'}[d.brand] || 'brand-ams',
    isMuted: getShureTelemetry(d) ? (shureFieldFresh(d,'muted') && d.shure.receiver_muted === true) || (shureFieldFresh(d,'transmitter_muted') && d.shure.transmitter_muted === true) : normalizeMutedValue(d.muted),
    muteControl: getMuteControlState(d),
  };
}

function createChannelCardHTML(d, locks) {
  const state = getChannelCardState(d, locks);
  const receiverLabel = d.receiver_ip || d.receiverIp || d.ip || d.receiver_id || d.receiverId || '';
  return `<div class="device-card ${state.displayStatus}${state.isMuted ? ' muted' : ''}${state.thresholdIssues.length ? ' threshold-alert' : ''}" data-device-key="${getChannelCardKey(d)}" data-threshold-alerts="${state.thresholdIssues.length}" title="${escapeAlertText(state.thresholdIssues.length ? state.thresholdIssues.map(issue => issue.msg).join('；') : '')}">
    <div class="dc-head">
      <div><div class="dc-name" data-role="name">${formatBrandModelDisplay(d)}</div>${receiverLabel ? `<div class="dc-receiver" data-role="receiver">接收机 ${receiverLabel}</div>` : ''}<div class="dc-ch dc-channel-meta"><span data-role="channel">${formatGroupChannelDisplay(d)}</span><span class="dc-transmitter-meta">${state.shureDetails ? `<span data-role="shure-status" title="${state.shureDetails}">${getShureTransmitterLabel(d)}</span>` : ''}<span class="mute-badge" data-role="mute-badge" style="display:${state.isMuted ? '' : 'none'}">🔇 已静音</span></span></div></div>
      <span class="dc-brand ${state.brandClass}" data-role="brand">${d.brand}</span>
    </div>
    <div class="dc-frequency-meta"><span class="dc-freq" data-role="frequency">${_formatFrequencyMHz(d.freq)}</span><span class="dc-usage" data-role="usage"${state.usage ? '' : ' hidden'}>${escapeAlertText(state.usage)}</span></div>
    <div class="dc-meters">
      <div class="meter-row"><span class="meter-lbl">RF</span><div class="meter-bar" title="-90 dBm（弱）～ -30 dBm（强）"><div class="meter-fill mf-rf" data-meter-fill="rf" style="width:${state.rfPercent}%;background:${state.rfColor}"></div></div><span class="meter-val" data-meter-value="rf">${_formatRfDbm(d.rf)}</span></div>
      <div class="meter-row"><span class="meter-lbl">AF</span><div class="meter-bar" title="${state.afMeter.title || '-40 dBFS = 0%，0 dBFS = 100%'}"><div class="meter-fill mf-af" data-meter-fill="af" style="width:${state.afMeter.percent}%"></div></div><span class="meter-val" data-meter-value="af">${state.afMeter.available ? state.afMeter.dbfs.toFixed(1) + ' dBFS' : '—'}</span></div>
      <div class="meter-row"><span class="meter-lbl">🔋</span><div class="meter-bar" title="${state.batteryMeter.title}"><div class="meter-fill ${state.battColor}" data-meter-fill="batt" style="width:${state.battPercent}%"></div></div><span class="meter-val" data-meter-value="batt">${getBatteryMeter(d).label}</span></div>
    </div>
    <div class="dc-footer">
      <div class="flex gap8"><div class="dc-status-dot" data-role="status-dot" style="background:${state.statusColor}"></div><span data-role="status-label" style="font-size:11px;color:${state.statusColor}">${state.statusLabel}</span></div>
      <div class="dc-actions">
        ${createMuteControlButtonHTML(d, state.muteControl)}
        <button class="btn btn-outline btn-sm" ${getShureTelemetry(d) && d.capabilities?.write_frequency !== true ? 'disabled title="频段、模式或在线身份未满足调频条件"' : `onclick="editFreq(${_deviceActionArg(d.id)})"`}>📡</button>
      </div>
    </div>
  </div>`;
}

function patchChannelCard(card, d, locks) {
  const state = getChannelCardState(d, locks);
  const receiverLabel = d.receiver_ip || d.receiverIp || d.ip || d.receiver_id || d.receiverId || '';
  const nameLabel = formatBrandModelDisplay(d);
  const channelLabel = formatGroupChannelDisplay(d);
  const renderKey = JSON.stringify([d.id, state, d.freq, d.rf, d.batt, d.brand, receiverLabel, nameLabel, channelLabel]);
  // 心跳/其它 CH 变化不应让未变化卡片重复写 DOM；阈值和全部显示状态仍参与比较。
  if (card._datyRenderKey === renderKey) return;
  card.className = `device-card ${state.displayStatus}${state.isMuted ? ' muted' : ''}${state.thresholdIssues.length ? ' threshold-alert' : ''}`;
  card.dataset.thresholdAlerts = String(state.thresholdIssues.length);
  card.title = [nameLabel,receiverLabel,channelLabel,_formatFrequencyMHz(d.freq),state.statusLabel,
    state.isMuted ? '已静音' : '未静音',...state.thresholdIssues.map(issue => issue.msg)].filter(Boolean).join(' · ');
  const setText = (selector, value) => { const el = card.querySelector(selector); if (el && el.textContent !== value) el.textContent = value; };
  for (const [role, value] of [['name',nameLabel],['receiver',receiverLabel],['channel',channelLabel]]) {
    const el = card.querySelector(`[data-role="${role}"]`);
    if (el && el.title !== value) el.title = value;
  }
  const setWidth = (name, value) => { const el = card.querySelector(`[data-meter-fill="${name}"]`); if (el) el.style.width = `${value}%`; };
  setText('[data-role="name"]', nameLabel);
  const receiverEl = card.querySelector('[data-role="receiver"]');
  if (receiverEl) receiverEl.textContent = receiverLabel || '';
  setText('[data-role="channel"]', channelLabel);
  setText('[data-role="shure-status"]', getShureTransmitterLabel(d));
  const shureStatus = card.querySelector('[data-role="shure-status"]');
  if (shureStatus) shureStatus.title = state.shureDetails;
  const battBar = card.querySelector('[data-meter-fill="batt"]')?.parentElement;
  if (battBar) battBar.title = state.batteryMeter.title;
  const afBar = card.querySelector('[data-meter-fill="af"]')?.parentElement;
  if (afBar) afBar.title = state.afMeter.title || '-40 dBFS = 0%，0 dBFS = 100%';
  setText('[data-role="frequency"]', _formatFrequencyMHz(d.freq));
  setText('[data-role="usage"]', state.usage);
  const usageEl = card.querySelector('[data-role="usage"]');
  if (usageEl) usageEl.hidden = !state.usage;
  setText('[data-meter-value="rf"]', _formatRfDbm(d.rf));
  setText('[data-meter-value="af"]', state.afMeter.available ? `${state.afMeter.dbfs.toFixed(1)} dBFS` : '—');
  setText('[data-meter-value="batt"]', state.batteryMeter.label);
  setWidth('rf', state.rfPercent);
  setWidth('af', state.afMeter.percent);
  setWidth('batt', state.battPercent);
  const rfFill = card.querySelector('[data-meter-fill="rf"]');
  if (rfFill) rfFill.style.background = state.rfColor;
  const brand = card.querySelector('[data-role="brand"]');
  if (brand) { brand.className = `dc-brand ${state.brandClass}`; brand.textContent = d.brand; }
  const badge = card.querySelector('[data-role="mute-badge"]');
  if (badge) badge.style.display = state.isMuted ? '' : 'none';
  const battFill = card.querySelector('[data-meter-fill="batt"]');
  if (battFill) battFill.className = `meter-fill ${state.battColor}`;
  const dot = card.querySelector('[data-role="status-dot"]');
  if (dot) { dot.style.background = state.statusColor; dot.title = state.statusLabel; }
  const status = card.querySelector('[data-role="status-label"]');
  if (status) { status.textContent = state.statusLabel; status.style.color = state.statusColor; }
  const muteButton = card.querySelector('[data-role="mute-button"]');
  if (muteButton) patchMuteControlButton(muteButton, d, state.muteControl);
  card._datyRenderKey = renderKey;
}

function renderDeviceGrid(devs) {
  // 更新统计卡片
  updateDashboardStats();
  
  const grid = document.getElementById('deviceGrid');
  if(!grid) return;
  grid.innerHTML = devs.map(d => {
    const thresholdIssues = getDeviceThresholdIssues(d);
    const batteryThreshold = getAlertThresholdSettings().batteryLowPercent;
    const displayStatus = getDeviceDisplayStatus(d, thresholdIssues);
    const batteryAvailable = _validBatteryPercent(d.batt);
    const battColor = batteryAvailable && Number(d.batt) <= batteryThreshold ? 'mf-batt-low' : 'mf-batt';
    const statusColor = {online:'#10b981',warn:'#f59e0b',error:'#f43f5e',offline:'#4a5578'}[displayStatus];
    const brandClass = {AMSaudio:'brand-ams',Shure:'brand-shure',Sennheiser:'brand-senn',DATYaudio:'brand-daty'}[d.brand]||'brand-ams';
    const isMuted = normalizeMutedValue(d.muted) || getShureTelemetry(d)?.transmitter_muted === true;
    const afMeter = getAfMeter(d);
    const rfPercent = _rfMeterPercent(d.rf);
    const rfColor = _rfMeterColor(d.rf);
    const battPercent = getBatteryMeter(d).percent;
    return `<div class="device-card ${displayStatus}${thresholdIssues.length ? ' threshold-alert' : ''}" title="${escapeAlertText(thresholdIssues.length ? thresholdIssues.map(issue => issue.msg).join('；') : '')}">
      <div class="dc-head">
        <div><div class="dc-name">${formatBrandModelDisplay(d)}</div><div class="dc-ch">${formatChannelDisplay(d)}</div></div>
        <span class="dc-brand ${brandClass}">${d.brand}</span>
      </div>
      ${getShureStatusText(d) ? `<div class="dc-ch" style="padding-right:0" title="${getShureStatusText(d)}">${getShureMuteLabel(d)}</div>` : ''}
      <div class="dc-freq">${_formatFrequencyMHz(d.freq)}</div>
      <div class="dc-meters">
      <div class="meter-row"><span class="meter-lbl">RF</span><div class="meter-bar" title="-90 dBm（弱）～ -30 dBm（强）"><div class="meter-fill mf-rf" style="width:${rfPercent}%;background:${rfColor}"></div></div><span class="meter-val">${_formatRfDbm(d.rf)}</span></div>
        <div class="meter-row"><span class="meter-lbl">AF</span><div class="meter-bar" title="${afMeter.title || '-40 dBFS = 0%，0 dBFS = 100%'}"><div class="meter-fill mf-af" style="width:${afMeter.percent}%"></div></div><span class="meter-val">${afMeter.available ? afMeter.dbfs.toFixed(1) + ' dBFS' : '—'}</span></div>
      <div class="meter-row"><span class="meter-lbl">🔋</span><div class="meter-bar" title="${getBatteryMeter(d).title}"><div class="meter-fill ${battColor}" style="width:${battPercent}%"></div></div><span class="meter-val">${getBatteryMeter(d).label}</span></div>
      </div>
      <div class="dc-footer">
        <div class="flex gap8"><div class="dc-status-dot" style="background:${statusColor}"></div><span style="font-size:11px;color:${statusColor}">${{online:'在线',warn:'注意',error:'错误',offline:'离线'}[displayStatus]}</span></div>
        <div class="dc-actions">
          ${createMuteControlButtonHTML(d)}
          <button class="btn btn-outline btn-sm" ${getShureTelemetry(d) && d.capabilities?.write_frequency !== true ? 'disabled title="频段、模式或在线身份未满足调频条件"' : `onclick="editFreq(${_deviceActionArg(d.id)})"`}>📡</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// 通道总览页面渲染
function renderDeviceGridChannels(devs) {
  const grid = document.getElementById('deviceGridChannels');
  if(!grid) return;

  const title = document.getElementById('channelOverviewTitle');
  if (title) title.textContent = `📡 设备通道总览（${DEVICES.length}通道）`;
  if (typeof getVisibleChannelPage === 'function') devs = getVisibleChannelPage(devs);
  if (!devs.length) {
    if (!grid.querySelector('.channel-cards-empty')) grid.innerHTML = '<div class="channel-cards-empty">暂无符合条件的通道</div>';
    return;
  }

  // Resolve lock notes once per render using the existing unique receiver/channel matching.
  const locks = globalThis.DatyPlanningConstraints?.getLockedFrequencyView()?.locks || new Map();
  const cards = Array.from(grid.children);
  const canPatch = cards.length === devs.length && cards.every((card, index) =>
    card.dataset.deviceKey === getChannelCardKey(devs[index])
  );
  if (!canPatch) {
    grid.innerHTML = devs.map(d => createChannelCardHTML(d, locks)).join('');
  }
  Array.from(grid.children).forEach((card, index) => patchChannelCard(card, devs[index], locks));
}

// 通道总览页面过滤
function filterDevicesChannels() {
  if (typeof getFilteredChannelView === 'function') {
    renderDeviceGridChannels(getFilteredChannelView());
    return;
  }
  const brand = document.getElementById('filterBrandChannels')?.value || 'all';
  const status = document.getElementById('filterStatusChannels')?.value || 'all';
  let devs = DEVICES;
  if(brand !== 'all') devs = devs.filter(d => d.brand === brand);
  if(status !== 'all') devs = devs.filter(d => getDeviceDisplayStatus(d) === status);
  renderDeviceGridChannels(devs);
}

// 通道总览页面排序
function sortDevicesChannels(key) {
  if (typeof getFilteredChannelView === 'function') {
    const select = document.getElementById('sortChannels');
    if (select) select.value = key;
    filterDevicesChannels();
    return;
  }
  let sorted = [...DEVICES];
  if(key === 'ch') {
    sorted.sort((a,b) => (getDeviceChannelNumberSafe(a, Number.MAX_SAFE_INTEGER) || Number.MAX_SAFE_INTEGER)
      - (getDeviceChannelNumberSafe(b, Number.MAX_SAFE_INTEGER) || Number.MAX_SAFE_INTEGER));
  } else if(key === 'freq') {
    sorted.sort((a,b) => a.freq - b.freq);
  } else {
    sorted.sort((a,b) => b[key] - a[key]);
  }
  renderDeviceGridChannels(sorted);
}

// 刷新通道数据
function refreshChannels() {
  notify('🔄', '刷新中...', '正在更新通道数据');
  filterDevicesChannels();
  setTimeout(() => notify('✓', '刷新完成', '通道数据已更新'), 500);
}

function escapeAlertText(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

function renderAlerts() {
  const alertList = document.getElementById('alertList');
  if (!alertList) return;
  const recommendation = globalThis.DatyAutoFrequency?.getSummary();
  if (ALERTS.length === 0 && !recommendation) {
    alertList.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px 20px;">暂无告警事件</div>';
  } else {
    alertList.innerHTML = ALERTS.map(a=>`
      <div class="alert-item ${['crit','warn','info'].includes(a.level) ? a.level : 'info'}">
        <span style="font-size:16px;">${{crit:'🔴',warn:'🟡',info:'🔵'}[a.level]}</span>
        <div><div class="alert-msg">${escapeAlertText(a.msg)}</div><div style="font-size:11px;color:var(--dim);margin-top:2px;">${escapeAlertText(a.deviceId || '—')} · ${a.ts ? new Date(a.ts).toLocaleString('zh-CN') : '—'}</div></div>
      </div>`).join('');
  }
  if (recommendation) alertList.insertAdjacentHTML('beforeend', `<div class="alert-item info" data-auto-frequency="true"><span style="font-size:16px;">💡</span><div><div class="alert-msg">${escapeAlertText(recommendation)}</div><button type="button" class="btn btn-outline btn-sm" onclick="DatyAutoFrequency.open()">查看换频建议</button></div></div>`);
}

// 仅清理确认时选中的实时显示；先归档，保留新生命周期及保存期间变化的告警。
async function clearAlerts() {
  if(globalThis.DatyDataRetention?.history===false){
    const selected=new Map(ALERTS.map(a=>[a,JSON.stringify(a)]));
    if(!selected.size)return false;
    if(!await globalThis.DatyDialogs.confirm({title:'清空实时告警',message:'清空当前显示。仍在发生的告警会随新遥测再次显示。',confirmLabel:'确认清空',cancelLabel:'取消'}))return false;
    for(let i=ALERTS.length-1;i>=0;i--)if(selected.get(ALERTS[i])===JSON.stringify(ALERTS[i]))ALERTS.splice(i,1);
    renderAlerts();updateDashboardStats();return true;
  }
  if (_realtimeAlertClearPending) return false;
  if (ALERTS.length === 0) {
    notify('ℹ️', '无需清理', '当前没有告警事件');
    return false;
  }
  _realtimeAlertClearPending = true;
  const button = document.getElementById('realtimeAlertClear');
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
  const selected = new Set(ALERTS), dialogs = globalThis.DatyDialogs;
  const database = globalThis.DatyAlertDatabase, connection = globalThis.DatyDatabaseConnection;
  const scope = typeof alertArchiveScope === 'function' ? alertArchiveScope() : null;
  const sameScope = () => database === globalThis.DatyAlertDatabase && connection === globalThis.DatyDatabaseConnection
    && scope === (typeof alertArchiveScope === 'function' ? alertArchiveScope() : null);
  try {
    if (typeof dialogs?.confirm !== 'function') throw new Error('应用内确认组件未加载，请刷新页面');
    const decision = dialogs.confirm({title:'清空实时告警',eyebrow:'DATY RF PRO · 设备概览',symbol:'🗑️',tone:'danger',
      message:'确认清空当前选中的实时告警显示？',confirmLabel:'确认清空',cancelLabel:'取消',
      details:[{label:'本次范围',value:selected.size+' 条实时告警'},{label:'处理方式',value:'先保存到服务器告警日志，再清空实时显示'},
        {label:'保留内容',value:'服务器历史、服务端 Timeline 和新到告警'}],
      warnings:['仍在发生的告警会在下一次遥测时重新显示。'],footnote:'清空显示不会关闭监测或改变接收机状态'});
    if (!decision || typeof decision.then !== 'function') throw new TypeError('告警确认接口必须返回 Promise<boolean>');
    const accepted = await decision;
    if (typeof accepted !== 'boolean') throw new TypeError('告警确认结果必须为布尔值');
    if (!accepted) return false;
    if (!sameScope() || dialogs !== globalThis.DatyDialogs) throw new Error('服务器连接已变化，请重新核对后清空');
    if (typeof flushAlertArchive !== 'function' || typeof queueAlertForArchive !== 'function') throw new Error('告警归档组件未就绪，实时告警已保留');
    if (_alertArchiveFlushFlight) await _alertArchiveFlushFlight;
    if (!sameScope()) throw new Error('服务器连接已变化，请重新核对后清空');
    const clearing = new Map();
    for (const item of ALERTS) if (selected.has(item)) {
      queueAlertForArchive(item);
      clearing.set(item, JSON.stringify(item));
    }
    const result = await flushAlertArchive(undefined, {all:true});
    if (!result.success) throw new Error(result.error || '告警归档失败，已保留实时告警');
    if (!sameScope()) throw new Error('服务器连接已变化，实时告警已保留');
    let removed = 0;
    for (let index = ALERTS.length - 1; index >= 0; index--) {
      const item = ALERTS[index];
      if (clearing.get(item) === JSON.stringify(item) && !_pendingAlertArchive.has(item.archiveId)) { ALERTS.splice(index, 1); removed++; }
    }
    saveDataToStorage();
    renderAlerts();
    updateDashboardStats();
    notify('🗑️', '实时告警已处理', `已清空 ${removed} 条显示；历史告警已保留${ALERTS.length ? '，新到或更新的 '+ALERTS.length+' 条仍显示' : '，仍在发生的告警会重新显示'}`);
    return true;
  } catch (error) {
    notify('❌', '暂未清空', error.message || String(error));
    return false;
  } finally {
    _realtimeAlertClearPending = false;
    if (button) { button.disabled = false; button.setAttribute('aria-busy', 'false'); }
  }
}

function renderMonitorGrid() {
  const monitorGrid = document.getElementById('monitorGrid');
  if (!monitorGrid) return;
  monitorGrid.innerHTML = DEVICES.map(d=>{
    const batt = _validBatteryPercent(d.batt) ? Number(d.batt) : null;
    const bc = _batteryMeterColor(batt);
    const rfText = _formatRfDbm(d.rf);
    const battText = getBatteryMeter(d).label;
    return `<div class="monitor-card">
      <div class="mc-head">
        <div><div class="mc-ch">${formatChannelDisplay(d)}</div><div class="mc-name">${escapeAlertText(d.name)}</div></div>
        <span class="badge ${d.brand==='AMSaudio'?'b-a':d.brand==='Shure'?'b-v':'b-c'}" style="font-size:10px;">${d.brand}</span>
      </div>
      <div class="mc-rf-big" style="color:${_rfMeterColor(d.rf)}">${rfText}</div>
      <div class="mc-batt-big" style="color:${bc}">🔋 ${battText}</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${getBatteryMeter(d).percent}%;background:${bc};"></div></div>
    </div>`;
  }).join('');
}

// 将服务端样本的年龄锚定到浏览器单调时钟，断流后也会按时失效。
function normalizeReceiverHeartbeat(raw) {
  if (!raw || typeof raw !== 'object' || raw.source !== 'server_clock_ack') return null;
  return {...raw, _receivedAt:performance.now()};
}

function getProtocolHeartbeatSummary(devices) {
  const receivers = new Map();
  const now = performance.now();
  for (const device of devices) {
    const sample = device.heartbeat;
    if (!sample || sample.source !== 'server_clock_ack' || sample.status !== 'measured') continue;
    if (![sample.rtt_ms, sample.age_ms, sample.max_age_ms, sample._receivedAt].every(value => typeof value === 'number' && Number.isFinite(value))) continue;
    const age = sample.age_ms + (now - sample._receivedAt);
    if (sample.rtt_ms < 0 || sample.age_ms < 0 || sample._receivedAt > now || sample.max_age_ms <= 0
        || sample.max_age_ms > 60000 || sample.rtt_ms > sample.max_age_ms || age > sample.max_age_ms) continue;
    const key = _dashboardReceiverIdentity(device);
    const previous = receivers.get(key);
    // 同接收机多个 CH 只取最新样本，不能重复加权或沿用某个 CH 的旧延迟。
    if (!previous || age < previous.age) receivers.set(key, {rtt:sample.rtt_ms, age});
  }
  const values = Array.from(receivers.values(), item => item.rtt);
  return {count:values.length, max:values.length ? Math.max(...values) : null,
    average:values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null};
}

// 协议状态页只显示已从实时快照确认的数据；缺失的指标保持“—”。
function renderProtocolStatus() {
  const devices = typeof DEVICES !== 'undefined' && Array.isArray(DEVICES) ? DEVICES : [];
  const online = devices.filter(device => typeof _dashboardIsDeviceOnline === 'function'
    ? _dashboardIsDeviceOnline(device)
    : !_deviceIsOffline(device));
  const brandKey = value => (typeof _dashboardBrandKey === 'function' ? _dashboardBrandKey(value) : '')
    || String(value || '').trim().toLowerCase();
  const receiverKey = device => typeof _dashboardReceiverIdentity === 'function'
    ? _dashboardReceiverIdentity(device)
    : String(device?.receiverId || device?.receiver_id || device?.ip || device?.id || '');
  const countByBrand = brand => new Set(online
    .filter(device => brandKey(device.brand) === brandKey(brand))
    .map(receiverKey)
    .filter(Boolean)).size;
  const setText = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  };
  const setProgress = (id, count) => {
    const element = document.getElementById(id);
    if (!element) return;
    // 没有协议容量上限时，进度条只能表达“有/无实时数据”，不能伪造百分比。
    element.style.width = count > 0 ? '100%' : '0%';
    element.title = count > 0 ? '已从实时设备快照确认' : '未获得实时设备快照';
  };
  // 卡片的在线数量/状态使用同一来源；新增品牌只需沿用 data 属性和 ID 前缀。
  const cards = document.querySelectorAll('#devProto [data-protocol-brand][data-protocol-prefix]');
  const latencyHints = new Map();
  let visibleBrands = 0;
  cards.forEach(card => {
    const brand = card.dataset.protocolBrand;
    const prefix = card.dataset.protocolPrefix;
    const count = countByBrand(brand);
    card.hidden = count === 0;
    if (count > 0) visibleBrands++;
    setText(`${prefix}Connections`, `${count} 台`);
    setText(`${prefix}Status`, count > 0 ? '在线' : '未连接');
    const status = document.getElementById(`${prefix}Status`);
    if (status) status.dataset.online = String(count > 0);
    const summary = getProtocolHeartbeatSummary(online.filter(device => brandKey(device.brand) === brandKey(brand)));
    setText(`${prefix}Latency`, summary.count ? `${summary.max.toFixed(1)} ms` : '—');
    const latency = document.getElementById(`${prefix}Latency`);
    if (latency) latency.title = summary.count
      ? `服务器 ↔ 接收机应用层 RTT（含设备处理耗时，非音频延迟）；最大 ${summary.max.toFixed(1)} ms，平均 ${summary.average.toFixed(1)} ms；已测 ${summary.count}/${count} 台`
      : count ? '尚无有效设备 ACK 往返测量，或样本已过期；不是浏览器到服务器的延时' : '未连接接收机';
    if (count) latencyHints.set(prefix, summary.count ? `RTT 已测 ${summary.count}/${count} 台${count > 1 ? '（显示最大值）' : ''}` : 'RTT 未测量或已过期');
    setText(`${prefix}Hint`, count > 0 ? `${count} 台接收机已从实时快照确认` : `未发现在线 ${brand} 设备`);
    setProgress(`${prefix}Progress`, count);
  });
  const empty = document.getElementById('protocolEmpty');
  if (empty) empty.hidden = visibleBrands > 0;
  const datyCount = countByBrand('DATYaudio');
  const amsCount = countByBrand('AMSaudio');
  const shureCount = countByBrand('Shure');
  const sennCount = countByBrand('Sennheiser');
  setText('protoDatyHint', datyCount > 0
    ? `${datyCount} 台接收机已从实时快照确认；沿用 MQTT / WebSocket 接入`
    : '未发现在线 DATYaudio 设备；等待 MQTT 实时快照');
  setText('protoAmsLoss', '—');
  setText('protoAmsHint', amsCount > 0
    ? `${amsCount} 台接收机已从实时快照确认；丢包未提供`
    : '未发现在线 AMSaudio 设备');

  setText('protoShureExclusive', shureCount > 0 ? '状态未知' : '未连接');
  setText('protoShureHint', shureCount > 0
    ? `${shureCount} 台接收机在线；支持输出静音，调频按机身频段校验`
    : '未发现在线 Shure 设备');

  setText('protoSennEvents', sennCount > 0 ? '状态未知' : '未连接');
  setText('protoSennHint', sennCount > 0
    ? `${sennCount} 台接收机已从实时快照确认；事件状态未提供`
    : '未发现在线 Sennheiser 设备');
  for (const [prefix, hint] of latencyHints) {
    const element = document.getElementById(`${prefix}Hint`);
    if (element) element.textContent += `；${hint}`;
  }
}

// 分页只是视图：不截断 DEVICES，不改变整个方案的导出与批量下发范围。
const plannerTableView = {page:0, pageSize:8, pageCount:1, usePlanned:false, visible:[]};
const plannerInputDrafts = new WeakMap();

function resetPlannerTablePage() { plannerTableView.page = 0; }

function changePlannerTablePage(delta) {
  plannerTableView.page = Math.max(0, Math.min(plannerTableView.pageCount - 1, plannerTableView.page + delta));
  renderFreqTable(plannerTableView.usePlanned);
}

function refreshPlannerTableLayout() {
  const viewport = document.getElementById('plannerTableViewport');
  if (viewport?.clientHeight > 0) renderFreqTable(plannerTableView.usePlanned);
}

// 规划表仅显示服务器确认的真实编组；不把浏览器本地编号当作接收机编组。
function getPlannerReceiverGroupNumber(device) {
  if (device?.group_source !== 'server-fifo-v1') return null;
  const value = device.group_number;
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function renderFreqTable(usePlanned) {
  window.DatyPlanningDeployment?.refreshControls();
  const freqTableBody = document.getElementById('freqTableBody');
  if (!freqTableBody) return;
  // 翻页/缩放不能丢失尚未提交的输入；新规划或设备频率变化后旧草稿失效。
  for (const row of plannerTableView.visible) {
    const input = document.getElementById('fi_' + row.device.id);
    if (input && input.value !== row.defaultValue) {
      plannerInputDrafts.set(row.device, {value:input.value, freq:row.freq, planned:row.planned});
    } else if (input) plannerInputDrafts.delete(row.device);
  }
  plannerTableView.usePlanned = !!usePlanned;
  // 按服务器确认的 GROUP 数字升序，同 GROUP 内按实际 CH 数字升序。
  // 仅排序表格副本；未知 GROUP/CH 置底，同组同 CH 保留原顺序和下发目标。
  const rows = DEVICES.map((device, index) => {
    return {device, index, group: getPlannerReceiverGroupNumber(device) ?? Infinity,
      channel: getDeviceChannelNumberSafe(device, Infinity)};
  }).sort((a, b) => a.group - b.group || a.channel - b.channel || a.index - b.index);
  const viewport = document.getElementById('plannerTableViewport');
  const table = document.getElementById('freqTable');
  const headerHeight = table?.tHead?.getBoundingClientRect?.().height || 32;
  const rowHeight = (table && typeof getComputedStyle === 'function'
    ? Number.parseFloat(getComputedStyle(table).getPropertyValue('--planner-row-height')) : 0) || 50;
  const pageSize = viewport ? (viewport.clientHeight > 0
    ? Math.max(1, Math.floor((viewport.clientHeight - headerHeight - 1) / rowHeight))
    : plannerTableView.pageSize) : Math.max(1, rows.length);
  if (pageSize !== plannerTableView.pageSize) {
    plannerTableView.page = Math.floor(plannerTableView.page * plannerTableView.pageSize / pageSize);
  }
  plannerTableView.pageSize = pageSize;
  plannerTableView.pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  plannerTableView.page = Math.min(plannerTableView.page, plannerTableView.pageCount - 1);
  const start = plannerTableView.page * pageSize;
  plannerTableView.visible = [];
  const escapeCell = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const lockView = window.DatyPlanningConstraints?.getLockedFrequencyView?.() || {locks:new Map(), errors:[]};
  window.DatyPlanningConstraints?.refreshLockEditor?.();
  const lockStatus = document.getElementById('plannerLockStatus');
  if (lockStatus) {
    lockStatus.hidden = lockView.errors.length === 0;
    lockStatus.textContent = `⚠ 锁定待检查 (${lockView.errors.length})`;
    lockStatus.title = lockView.errors.join('\n');
  }
  document.getElementById('plannerLockedAssignments')?.setAttribute?.('aria-invalid', String(lockView.errors.length > 0));
  document.getElementById('plannerLockChannel')?.setAttribute?.('aria-invalid', String(lockView.errors.length > 0));
  freqTableBody.innerHTML = rows.slice(start, start + pageSize).map(({device: d, group})=>{
    const currentLabel = _formatFrequencyMHz(d.freq);
    const lock = lockView.locks.get(String(d.id));
    const lockLabel = lock?.invalid ? '重复设置' : lock ? _formatFrequencyMHz(lock.frequencyKHz) : '—';
    const lockTitle = lock?.invalid ? lock.reason : lock
      ? `规划约束设定值，尚须规划校验；不是设备实际频率。${lock.reason}` : '未设置可唯一匹配此通道的锁定频率';
    const plannedValue = d.planned;
    const plannedLabel = usePlanned && plannedValue > 0 ? _formatFrequencyMHz(plannedValue) : '—';
    const planned = plannedLabel.replace(/ MHz$/, '');
    const draft = plannerInputDrafts.get(d);
    const inputValue = draft && draft.freq === d.freq && draft.planned === d.planned ? draft.value : planned;
    plannerTableView.visible.push({device:d, defaultValue:planned, freq:d.freq, planned:d.planned});
    const result = window.DATY_LAST_COORDINATION;
    const assignment = usePlanned && result?.assignments?.find(item => item.deviceId === d.id && item.frequencyKHz === d.planned);
    const verified = assignment
      && result.analysis?.conflicts?.length === 0;
    const disposition = assignment?.retainedOriginal === true ? '保留原频' : assignment?.retainedOriginal === false ? '建议调整' : '';
    const deployment = window.DatyPlanningDeployment?.getRowState(d);
    const reason = String(assignment?.changeReason || '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    return `<tr>
      <td class="planner-group-cell">${Number.isFinite(group) ? `GROUP${group}` : '—'}</td>
      <td>${escapeCell(d.ch)}</td>
      <td title="${escapeCell(d.name)}">${escapeCell(d.name)}</td>
      <td><span class="badge ${d.brand==='AMSaudio'?'b-a':d.brand==='Shure'?'b-v':'b-c'}" title="${escapeCell(d.brand)}">${escapeCell(d.brand)}</span></td>
      <td><span class="mono">${currentLabel}</span></td>
      <td class="planner-locked-cell" title="${escapeCell(lockTitle)}"><span class="${lock?.invalid ? 'planner-lock-error' : lock ? 'mono planner-lock-value' : 'text-muted'}">${escapeCell(lockLabel)}</span>${lock && !lock.invalid ? `<span class="planner-lock-note">锁定${lock.reason && lock.reason !== '用户锁定' ? ' · '+escapeCell(lock.reason) : ''}</span>` : ''}</td>
      <td><input class="freq-input" value="${escapeCell(inputValue)}" id="fi_${escapeCell(d.id)}" aria-label="${escapeCell(d.ch)} 规划频率 MHz" title="手填 MHz 会转为人工锁定，须重新全局规划后才能下发" onchange="DatyPlanningConstraints.setManualLock(${_deviceActionArg(d.id).replace(/"/g, '&quot;')},this.value)"></td>
      <td><span class="tag ${verified?'tag-ok':'tag-plan'}">${verified?'✓ 无冲突':usePlanned && d.planned > 0?'待重新校验':'待规划'}</span>${deployment ? `<div class="planner-row-deploy text-sm" data-state="${escapeCell(deployment.state)}" title="${escapeCell(deployment.text)}">${escapeCell(deployment.text)}</div>` : disposition ? `<div class="text-muted text-sm" title="${reason}">${disposition}</div>` : ''}</td>
      <td>
        <button data-planner-action="pushOne" class="btn btn-success btn-sm" onclick="pushFreq(${_deviceActionArg(d.id).replace(/"/g, '&quot;')})">下发</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="text-muted">暂无通道，请先连接接收机或导入设备。</td></tr>';
  const info = document.getElementById('plannerPageInfo');
  if (info) info.textContent = rows.length
    ? `共 ${rows.length} 个通道 · ${start + 1}–${Math.min(start + pageSize, rows.length)} · 第 ${plannerTableView.page + 1}/${plannerTableView.pageCount} 页`
    : '暂无通道';
  const prev = document.getElementById('plannerPrevPage'), next = document.getElementById('plannerNextPage');
  if (prev) prev.disabled = plannerTableView.page === 0;
  if (next) next.disabled = plannerTableView.page + 1 >= plannerTableView.pageCount;
}

function updateDeviceConnectionSummary() {
  // 更新侧边栏设备连接状态（红点/绿点 + 文字）
  const connDot = document.getElementById('connDot');
  const connCount = document.getElementById('connCount');
  // 与 Dashboard 共用同一套在线判定和物理接收机去重口径。
  const receiverCount = _dashboardUniqueReceivers(DEVICES, true).length;
  
  // 更新在线设备数量标签（显示接收机数量，与左下角一致）
  const tabEl = document.getElementById('tabOnlineCount');
  if (tabEl) {
    tabEl.textContent = `在线设备 (${receiverCount})`;
  }
  
  if (connDot) {
    connDot.className = receiverCount > 0 ? 'dot dot-green' : 'dot dot-red';
  }
  if (connCount) {
    connCount.textContent = receiverCount > 0 ? receiverCount + '台接收机在线' : '无设备连接';
  }
}

function renderDevTable() {
  renderProtocolStatus();
  updateDeviceConnectionSummary();
  if (typeof renderPagedDeviceTable === 'function') { renderPagedDeviceTable(); return; }
  
  const tbody = document.getElementById('devTableBody');
  if (!tbody) {
    console.warn('devTableBody 元素未找到，跳过渲染');
    return;
  }
  
  if (DEVICES.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align:center;padding:40px;color:var(--muted);">
          <div style="font-size:48px;margin-bottom:12px;">📭</div>
          <div>暂无设备</div>
          <div style="font-size:12px;margin-top:8px;">点击上方「+ 添加设备」手动添加，或通过「数据管理」导入 / 接收机实时接收</div>
        </td>
      </tr>
    `;
    return;
  }
  
  tbody.innerHTML = DEVICES.map(d=>{
    const displayStatus = getDeviceDisplayStatus(d);
    return `
    <tr>
      <td>${d.ch}</td>
      <td><span class="dev-name-cell" data-id="${d.id}" ondblclick="editDeviceName(${d.id})" style="cursor:pointer;" title="双击编辑">${escapeAlertText(d.name)}</span></td>
      <td><span class="badge ${d.brand==='AMSaudio'?'b-a':d.brand==='Shure'?'b-v':'b-c'}">${d.brand}</span> <span style="color:var(--muted);font-size:11px;">${d.model}</span></td>
      <td><span class="mono">${d.ip}</span></td>
      <td><span class="mono">${d.brand==='Shure'?'SCP :2202':d.brand==='Sennheiser'?'SSCv2 :45':'TCP 私有'}</span></td>
      <td><span class="mono">${_formatFrequencyMHz(d.freq)}</span></td>
      <td><span class="badge ${displayStatus==='online'?'b-g':displayStatus==='warn'?'b-a':'b-r'}">${{online:'在线',warn:'注意',error:'错误',offline:'离线'}[displayStatus]}</span></td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="editDevice(${d.id})">编辑</button>
        <button class="btn btn-outline btn-sm" onclick="disconnectDev(${d.id})">断开</button>
        <button class="btn btn-danger btn-sm" onclick="deleteDev(${d.id})">删除</button>
      </td>
    </tr>`;
  }).join('');
  
  console.log(`设备管理表格已渲染: ${DEVICES.length} 个设备`);
}

// FAshe/SSE、设备添加和数据导入共用的完整刷新入口。
// 此函数必须放在生产入口已加载的 render.js 中；不能依赖未加载的 database.js。
function forceRefreshAllPanels({realtime = false, alertsEvaluated = false} = {}) {
  // 每次设备快照/增量到达先做阈值评估，确保实时告警栏与通道卡使用同一份数据。
  if (!alertsEvaluated && typeof evaluateRealtimeAlerts === 'function') evaluateRealtimeAlerts(DEVICES);
  const shouldRender = name => {
    const panel = document.getElementById(`panel-${name}`);
    return panel && (!realtime || panel.classList.contains('active'));
  };
  updateDeviceConnectionSummary();
  updateReceiverProductDisplays();
  // 协议卡片在设备管理可见时更新。
  if (!shouldRender('devices') && !realtime) renderProtocolStatus();
  // 首页四个统计框优先刷新，其他面板异常不得阻断它。
  updateDashboardStats();

  const refreshSafely = (label, callback) => {
    try { callback(); }
    catch (error) { console.error(`[UI] ${label} 刷新失败:`, error); }
  };

  if (shouldRender('channels')) {
    refreshSafely('通道总览', () => filterDevicesChannels());
  }
  if (shouldRender('devices')) {
    refreshSafely('设备管理', () => renderDevTable());
  }
  if (shouldRender('dashboard')) {
    refreshSafely('设备概览', () => {
      filterDevices();
      drawRFBarChart();
    });
  }
  if (shouldRender('monitor')) {
    refreshSafely('实时监控', () => {
      renderMonitorGrid();
    });
  }
  // #alertList 位于首页设备概览；新增/解除告警时由评估器立即刷新，避免高频 SSE 重建 DOM。
  const spectrumPanel = document.getElementById('panel-spectrum');
  if (spectrumPanel && spectrumPanel.classList.contains('active')) {
    refreshSafely('频谱设备频点', () => drawSpectrum());
  }
  if (shouldRender('planner')) {
    refreshSafely('频率规划', () => {
      const hasPlanned = DEVICES.some(d => d.planned && d.planned > 0);
      renderFreqTable(hasPlanned);
    });
  }
}

// 双击编辑设备名称
function editDeviceName(id) {
  if (typeof startPagedDeviceNameEdit === 'function') { startPagedDeviceNameEdit(id); return; }
  const device = DEVICES.find(d => d.id === id);
  if (!device) return;
  
  const cell = document.querySelector(`.dev-name-cell[data-id="${id}"]`);
  if (!cell) return;
  
  const currentName = device.name;
  
  // 替换为输入框
  cell.innerHTML = `<input type="text" class="edit-name-input" value="${currentName}" 
    style="background:var(--bg3);border:1px solid var(--c1);color:var(--text);padding:4px 8px;border-radius:4px;font-size:13px;width:120px;font-family:inherit;"
    onblur="saveDeviceName(${id}, this.value)"
    onkeydown="if(event.key==='Enter'){saveDeviceName(${id}, this.value);}else if(event.key==='Escape'){renderDevTable();}"
    autofocus>`;
  
  // 聚焦并选中文字
  const input = cell.querySelector('input');
  if (input) {
    input.focus();
    input.select();
  }
}

// 保存设备名称
function saveDeviceName(id, newName) {
  if (globalThis.DatyBusinessDatabase) return globalThis.DatyBusinessDatabase.saveDeviceAlias(id, newName);
  const device = DEVICES.find(d => d.id === id);
  if (!device) return;
  
  const trimmedName = newName.trim();
  if (trimmedName && trimmedName !== device.name) {
    device.name = trimmedName;
    notify('✏️', '名称已修改', `设备 ${device.ch} 已重命名为「${trimmedName}」`);
  }
  
  renderDevTable();
}

const PLANNING_HISTORY_PAGE_SIZE = 20;
let planningHistoryPage = 1;

let databaseHistoryPreferredPage = null;
function DatyApplyHistoryPagePreference(value) { if(Number.isSafeInteger(value.historyPage)&&value.historyPage>0)databaseHistoryPreferredPage=value.historyPage; }
function changePlanningHistoryPage(delta) {
  databaseHistoryPreferredPage=null;
  planningHistoryPage = Math.max(1, planningHistoryPage + delta);
  renderHistory();
  void globalThis.DatyBusinessDatabase?.savePage('historyPage',planningHistoryPage);
}

function deleteHistoryById(id) {
  // 翻页后的删除仍按记录身份定位，不使用当前页的行号。
  const matches = HISTORY.map((record, index) => ({record, index})).filter(({record}) => record.id === id);
  if (matches.length !== 1) { notify('⚠️', '无法删除', '规划记录已变化或身份不唯一，请刷新历史'); renderHistory(); return; }
  return deleteHistory(matches[0].index);
}

function filterPlanningHistory(){planningHistoryPage=1;databaseHistoryPreferredPage=null;renderHistory();}
function filterAlertArchive(){alertLogPage=1;globalThis.DatyAlertDatabasePreferredPage=null;renderLog();}
function renderHistory() {
  if(globalThis.DatyDataRetention?.history===false)return;
  const body = document.getElementById('historyBody');
  if (!body) return;
  const project = typeof getCurrentPlanningProject === 'function' ? getCurrentPlanningProject() : {name:'默认项目'};
  const projectLabel = document.getElementById('planningHistoryProject');
  if (projectLabel) { projectLabel.textContent = `当前项目：${project.name}`; projectLabel.title = projectLabel.textContent; }
  const current = typeof getCurrentPlanningRecord === 'function' ? getCurrentPlanningRecord() : null;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  if(HISTORY.length&&databaseHistoryPreferredPage){planningHistoryPage=databaseHistoryPreferredPage;databaseHistoryPreferredPage=null;}
  const query=document.getElementById('historySearch')?.value||'',filter=document.getElementById('historyFilter')?.value||'all';
  const records=globalThis.DatyDataManagement?DatyDataManagement.search(HISTORY,query,['name','algo','time','date','id'],h=>filter==='all'||filter==='current'&&h.id===current?.id||filter==='conflict'&&h.imdConflicts>0):HISTORY;
  const count=document.getElementById('historyFilterCount');if(count)count.textContent=`显示 ${records.length} / 共 ${HISTORY.length} 条`;
  const pages = Math.max(1, Math.ceil(records.length / PLANNING_HISTORY_PAGE_SIZE));
  planningHistoryPage = Math.min(Math.max(1, planningHistoryPage), pages);
  const pagination = document.getElementById('historyPagination');
  if (pagination) pagination.hidden = records.length === 0;
  const pageInfo = document.getElementById('historyPageInfo');
  if (pageInfo) pageInfo.textContent = `第 ${planningHistoryPage}/${pages} 页 · 每页 ${PLANNING_HISTORY_PAGE_SIZE} 条 · 筛选 ${records.length} / 共 ${HISTORY.length} 条`;
  const prev = document.getElementById('historyPrevPage'), next = document.getElementById('historyNextPage');
  if (prev) prev.disabled = planningHistoryPage <= 1;
  if (next) next.disabled = planningHistoryPage >= pages;
  if (records.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="history-message-cell">'+(HISTORY.length?'没有匹配的记录，请调整搜索或筛选条件':'暂无规划历史，可在频率规划中保存约束或运行规划')+'</td></tr>';
    return;
  }
  const start = (planningHistoryPage - 1) * PLANNING_HISTORY_PAGE_SIZE;
  body.innerHTML = records.slice(start, start + PLANNING_HISTORY_PAGE_SIZE).map(h => {
    const recordArg = escape(JSON.stringify(h.id));
    const constraints = h.constraints;
    const constraintSummary = constraints
      ? `排除 ${constraints.excludedRanges?.length || 0} · 锁定 ${constraints.lockedAssignments?.length || 0} · 占用 ${constraints.knownCarriers?.length || 0} · 备用 ${constraints.backupCount ?? 1}` : '旧记录未保存约束';
    const imdResult = h.imdConflicts > 0 ? h.imdConflicts + ' 冲突' : (h.imdMargin ?? h.imd ?? '—');
    return `<tr>
      <td class="text-muted" title="${escape(h.time || h.date || '')}">${escape(h.time || h.date || '')}</td>
      <td title="${escape(h.name)}"><div class="history-plan-name"><span class="history-name-text">${escape(h.name)}</span>${current?.id === h.id ? ' <span class="badge b-g">当前</span>' : ''}</div></td>
      <td title="${escape(h.channels ?? h.ch ?? 0)} 通道">${escape(h.channels ?? h.ch ?? 0)} 通道</td>
      <td title="${escape(h.algo || '-')}"><span class="badge b-v">${escape(h.algo || '-')}</span></td>
      <td title="${escape(constraintSummary)}">${escape(constraintSummary)}</td>
      <td title="${escape(imdResult)}" style="color:${h.imdConflicts > 0 ? '#fb7185' : '#10b981'};font-weight:700;">${escape(imdResult)}</td>
      <td class="history-actions">
        <button class="btn btn-outline btn-sm" onclick="loadHistory(${recordArg},true)">加载</button>
        <button class="btn btn-outline btn-sm" onclick="exportHistory(${recordArg})">导出</button>
        <button class="btn btn-outline btn-sm" style="color:#fb7185;" onclick="deleteHistoryById(${recordArg})">删除</button>
      </td>
    </tr>`;
  }).join('');
}

async function deleteHistory(idx) {
  const selected=HISTORY[idx];
  if(!selected)return false;
  return runPlanningHistoryAction('delete',selected.id,async record=>{
    const index=HISTORY.indexOf(record),name=record.name;
    const removed=HISTORY.splice(index,1)[0],previousId=currentPlanningRecordId;
    const wasDeleted=planningHistoryDeletedIds.has(removed.id);
    planningHistoryDeletedIds.add(removed.id);
    if(removed.id===currentPlanningRecordId)currentPlanningRecordId=null;
    try {persistPlanningHistoryState();}
    catch(error){
      HISTORY.splice(index,0,removed);currentPlanningRecordId=previousId;
      if(!wasDeleted)planningHistoryDeletedIds.delete(removed.id);
      notify('❌','删除未保存',error.message || String(error));return false;
    }
    renderHistory();
    const suffix=previousId===removed.id?'；当前输入保留为未保存草稿':'';
    const status=setPlanningSaveStatus('本机历史已更新，正在同步服务器…'+suffix);
    try {await persistPlanningProject();setPlanningSaveStatus('规划历史已同步'+suffix,status);}
    catch(_){setPlanningSaveStatus('本机历史已更新；服务器未同步'+suffix,status);}
    notify('🗑️','已删除',name+' 已从历史记录中移除');
    return true;
  });
}

function renderLog() {
  if(globalThis.DatyDataRetention?.history===false)return;
  if (typeof alertLogView === 'undefined' || alertLogView !== 'archive') return;
  if(typeof updateAlertLogControls==='function')updateAlertLogControls();
  const body = document.getElementById('logBody');
  if (!body) return;
  for (const [id, text] of [['logCountUnit', '条告警记录'], ['logTimeHeader', '首次发生'], ['logLevelHeader','级别'],['logDeviceHeader','设备'],['logStateHeader', '状态 / 结束时间']]) {
    const label = document.getElementById(id);
    if (label) label.textContent = text;
  }
  if(typeof renderAlertArchiveReadState==='function'&&renderAlertArchiveReadState())return;
  try {
    // 历史必须从持久化存储读取，不能用活动 ALERTS 冒充归档日志。
    const all=readAlertArchive(),metricFilter=document.getElementById('alertMetricFilter')?.value||'all',levelFilter=document.getElementById('alertLevelFilter')?.value||'all',stateFilter=document.getElementById('alertStateFilter')?.value||'all';
    const records=(globalThis.DatyDataManagement?DatyDataManagement.search(all,document.getElementById('alertSearch')?.value,
      ['deviceId','device','receiverIP','msg','event','metric'],a=>(levelFilter==='all'||String(a.level||'info').toLowerCase()===levelFilter)&&(stateFilter==='all'||a.archiveState===stateFilter)&&(metricFilter==='all'||metricFilter===a.metric||metricFilter==='other'&&!['rf','af','battery'].includes(a.metric))):all).slice().sort((a,b)=>(b.firstSeen||b.ts||0)-(a.firstSeen||a.ts||0));
    const filterCount=document.getElementById('alertFilterCount');if(filterCount)filterCount.textContent=`显示 ${records.length} / 共 ${all.length} 条`;
    if(records.length&&globalThis.DatyAlertDatabasePreferredPage){alertLogPage=globalThis.DatyAlertDatabasePreferredPage;globalThis.DatyAlertDatabasePreferredPage=null;}
    alertLogPage = renderAlertLogPagination(records.length, alertLogPage);
    const count = document.getElementById('logCount');
    if (count) count.textContent = String(records.length);
    const badge = document.getElementById('logStorageCount');
    const state=globalThis.DatyAlertDatabase?.status();
    if (badge) badge.textContent = `💾 ${state?.warning?'待核对记录':state?.loaded?'服务器告警':'本机待存缓存'} (${all.length} 条)`;
    const summary=document.getElementById('alertLifecycleSummary');if(summary)summary.textContent=state?.loaded&&!state.warning?`已归档 ${all.length} 个事件 · 归档中触发中 ${all.filter(a=>a.archiveState==='active').length} · 已结束 ${all.filter(a=>a.archiveState==='ended').length}；实时状态请查看设备概览。`:'告警记录来源尚未完全确认，请先核对连接与保存状态。';
    const page = records.slice((alertLogPage - 1) * ALERT_LOG_PAGE_SIZE, alertLogPage * ALERT_LOG_PAGE_SIZE);
    body.innerHTML = page.length ? page.map(alert => {
      const level = String(alert.level || 'info').toLowerCase();
      const occurred = alert.firstSeen ?? alert.ts ?? alert.timestamp;
      const time = occurred ? new Date(occurred).toLocaleString('zh-CN') : (alert.time || '—');
      const target = [alert.deviceId || alert.device || '—', alert.receiverIP || ''].filter(Boolean).join(' · ');
      const state = alert.archiveState === 'ended'
        ? `已结束 · ${new Date(alert.endedAt).toLocaleString('zh-CN')}`
        : alert.archiveState === 'active' ? '触发中 · '+new Date(alert.lastSeen??occurred).toLocaleString('zh-CN') : '历史记录';
      return `<tr>
        <td style="color:var(--muted);" title="${escapeAlertText(time)}">${escapeAlertText(time)}</td>
        <td><span class="badge ${level === 'crit' ? 'b-r' : level === 'warn' ? 'b-a' : 'b-g'}">${escapeAlertText(level.toUpperCase())}</span></td>
        <td title="${escapeAlertText(target)}">${escapeAlertText(target)}</td>
        <td title="${escapeAlertText(alert.msg || alert.event || '—')}">${escapeAlertText(alert.msg || alert.event || '—')}${alert.archiveId?`<button type="button" class="log-detail-button" data-alert-id="${escapeAlertText(alert.archiveId)}">事件详情</button>`:''}</td>
        <td style="color:var(--muted);" title="${escapeAlertText(state)}；已结束表示条件不再满足、通道离线或遥测不可用；不等于人工确认处理">${escapeAlertText(state)}</td>
      </tr>`;
    }).join('') : alertLogEmptyMarkup(all.length?'没有匹配的告警':state?.loaded?'服务器暂无已归档告警':'服务器告警尚未读取',all.length?'请调整搜索、级别或状态筛选。':state?.loaded?'连接正常时，每 30 秒自动保存待存事件，也可点击“立即保存”。':'等待数据库连接就绪后，点击“告警记录”重新查询。');
    updateAlertArchiveStatus();
  } catch (error) {
    renderAlertLogPagination(0);
    const count = document.getElementById('logCount'); if (count) count.textContent = '—';
    body.innerHTML = `<tr><td colspan="5" class="log-message-cell" style="color:#fb7185;">告警日志读取失败：${escapeAlertText(error.message || error)}。未覆盖原存储。</td></tr>`;
  }
}

