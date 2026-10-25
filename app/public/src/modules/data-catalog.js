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
  const settingNames={alert_thresholds:'告警阈值',alert_sound:'声音告警',auto_frequency:'自动变频推荐'};
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
    if(type==='settings')info=s.setting_type==='thresholds'||item.id==='alert_thresholds'?'RF '+s.rf_weak_dbm+' dBm · 电池 '+s.battery_low_percent+'% · AF '+s.af_overload_dbfs+' dBFS':s.enabled===1?'已启用':'已关闭';
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
