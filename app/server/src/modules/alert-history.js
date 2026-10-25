// 实时告警 -> 本机待存队列 -> 服务器告警历史。只存事件，不生成遥测、不发送设备指令。
const ALERT_ARCHIVE_INTERVAL_MS = 30000;
const ALERT_ARCHIVE_KEY = 'daty_db_alerts';
const ALERT_PENDING_KEY = 'daty_pending_alerts_v1';
const ALERT_ARCHIVE_META_KEY = 'daty_alert_archive_meta_v1';
let alertLogView = 'archive';
let alertLogPage = 1;
const ALERT_LOG_PAGE_SIZE = 20;
let _alertArchiveTimer = null;
let _alertArchiveStarted = false;
let _alertArchiveSerial = 0;
let _alertPendingCheckpointAt = 0;
const _pendingAlertArchive = new Map();
let _alertArchiveError = '';
let _alertArchiveSavedAt = 0;
let _alertManualSavePending = false, _alertArchiveFlushFlight = null;
let _alertLogViewRevision = 0, _alertLogClearedSource = 'archive';
let _alertArchiveReadRequest = 0, _alertArchiveReadFlight = null;
let _alertArchiveReading = false, _alertArchiveReadError = '';

function selectAlertLogView(view) {
  _alertLogViewRevision++;_alertArchiveReadRequest++;_alertArchiveReading=false;
  if(view==='cleared')_alertLogClearedSource=alertLogView;
  alertLogView=view;globalThis.cancelServerTimelineRead?.();updateAlertLogControls();
  return _alertLogViewRevision;
}

function alertArchiveScope() {
  const connection=globalThis.DatyDatabaseConnection;
  if(!connection)return null;
  const state=connection.snapshot();return JSON.stringify([state.origin,state.revision,state.source?.id,state.status?.epoch]);
}

function renderAlertArchiveReadState() {
  const error=_alertArchiveReadError||globalThis.DatyAlertDatabase?.status().readError;
  if(!_alertArchiveReading&&!error)return false;
  renderAlertLogPagination(0);
  const count=document.getElementById('logCount');if(count)count.textContent='—';
  const badge=document.getElementById('logStorageCount');if(badge)badge.textContent=_alertArchiveReading?'💾 服务器告警（读取中）':'💾 服务器告警（未确认）';
  const body=document.getElementById('logBody');if(body)body.innerHTML=alertLogEmptyMarkup(
    _alertArchiveReading?'正在读取服务器告警…':'服务器告警读取失败',
    _alertArchiveReading?'读取完成后显示数据库中的当前记录。':error+'；点击“告警记录”重试，原数据保留。',_alertArchiveReading?'📋':'⚠️');
  updateAlertArchiveStatus();return true;
}

function _readAlertRecords(key) {
  const records = JSON.parse((globalThis.DatyPlatform?.storage || localStorage).getItem(key) || '[]');
  if (!Array.isArray(records) || records.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('告警存储格式异常，原数据已保留');
  }
  return records;
}

function _alertRecordId(alert) {
  if (!alert.archiveId) {
    // 同一生命周期一直复用 ID；恢复后重新创建的告警获得新的 ID。
    const token = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID() : `${Date.now()}-${++_alertArchiveSerial}-${Math.random().toString(36).slice(2)}`;
    alert.archiveId = `alert-${token}`;
  }
  return alert.archiveId;
}

function _mergeAlertRecord(previous, incoming) {
  if (!previous) return {...incoming};
  // 另一页面的过时活动快照不能重新打开已结束的同一事件。
  if (previous.archiveState === 'ended' && incoming.archiveState !== 'ended') return previous;
  const previousTime = previous.endedAt || previous.lastSeen || previous.ts || 0;
  const incomingTime = incoming.endedAt || incoming.lastSeen || incoming.ts || 0;
  return incomingTime >= previousTime ? {...previous, ...incoming} : previous;
}

function _loadPendingAlertRecords() {
  if(globalThis.DatyDataRetention?.history===false)return;
  for (const item of _readAlertRecords(ALERT_PENDING_KEY)) {
    const key = item.archiveId || `legacy-pending:${item.id}:${item.ts}`;
    _pendingAlertArchive.set(key, _mergeAlertRecord(_pendingAlertArchive.get(key), {...item, archiveId:key}));
  }
}

function updateAlertArchiveStatus() {
  const label = document.getElementById('logArchiveStatus');
  if (!label) return;
  const database=globalThis.DatyAlertDatabase?.status();
  const timeline=globalThis.getServerTimelineState?.();
  const error=(alertLogView==='archive'?_alertArchiveReadError||database?.readError||database?.warning:'')||_alertArchiveError||'';
  const hasError=!!error||!!timeline?.error&&alertLogView==='timeline';
  const action=_alertArchiveClearPending?'正在核对或清理告警，待存事件保留':_alertManualSavePending?'正在保存本次全部待存告警':_alertArchiveFlushFlight?'正在自动保存告警':'';
  if(['timeline','audit'].includes(alertLogView)){const activity=alertLogView==='audit'?globalThis.getOperationAuditState?.():timeline;label.textContent=activity?.message||'等待读取服务器记录';label.style.color=activity?.error?'var(--danger, #fb7185)':'var(--muted)';label.dataset.state=activity?.error?'error':activity?.loading?'busy':'ready';return;}
  else if(alertLogView==='cleared')label.textContent='当前显示已清空 · 服务器记录未删除 · 点击数据源按钮重新读取';
  else label.textContent=_alertArchiveReading?'正在读取服务器告警':database?.loaded?'服务器告警记录':'服务器尚未读取，当前为待存缓存';
  label.textContent+=` · 待存 ${_pendingAlertArchive.size} 条`;
  if(action)label.textContent+=' · '+action;
  else if(error)label.textContent+=' · '+(_alertArchiveError===error?'保存失败：':'')+error;
  else if(database?.pending?.status==='unknown')label.textContent+=' · 上笔事务未确认，点击“立即保存”只读核对';
  else label.textContent+=' · 每 30 秒自动保存'+(_alertArchiveSavedAt?' · 最近保存 '+new Date(_alertArchiveSavedAt).toLocaleTimeString('zh-CN'):'');
  label.style.color = hasError ? 'var(--danger, #fb7185)' : 'var(--muted)';
  label.title = label.textContent;
  label.dataset.state=hasError?'error':action?'busy':_pendingAlertArchive.size?'pending':_alertArchiveSavedAt?'saved':'idle';
}

function _checkpointPendingAlerts() {
  if(globalThis.DatyDataRetention?.history===false)return;
  // 写入小型待存队列，避免短暂告警在下一个 30 秒周期前消失或刷新丢失。
  _loadPendingAlertRecords();
  (globalThis.DatyPlatform?.storage || localStorage).setItem(ALERT_PENDING_KEY, JSON.stringify([..._pendingAlertArchive.values()]));
  _alertPendingCheckpointAt = Date.now();
}

function queueAlertForArchive(alert, archiveState = 'active') {
  if(globalThis.DatyDataRetention?.history===false)return;
  if (!alert || typeof alert !== 'object') return;
  const archiveId = _alertRecordId(alert);
  const previous = _pendingAlertArchive.get(archiveId);
  const firstSeen = alert.firstSeen ?? alert.ts ?? Date.now();
  const record = {...alert, archiveId, ts:firstSeen, firstSeen,
    lastSeen:alert.lastSeen ?? alert.ts ?? firstSeen, archiveState};
  if (archiveState === 'ended') record.endedAt = Date.now();
  _pendingAlertArchive.set(archiveId, _mergeAlertRecord(previous, record));
  try {
    if (!previous || archiveState === 'ended' || Date.now() - _alertPendingCheckpointAt >= 1000) {
      _checkpointPendingAlerts();
    }
  } catch (error) {
    // 留在内存并在下一次归档重试，不阻断实时告警引擎。
    _alertArchiveError = error.message || String(error);
  }
  updateAlertArchiveStatus();
}

function readAlertArchive() {
  return globalThis.DatyAlertDatabase ? DatyAlertDatabase.records() : _readAlertRecords(ALERT_ARCHIVE_KEY);
}

async function flushAlertArchive(event, options={}) {
  if(globalThis.DatyDataRetention?.history===false)return {success:false,status:'disabled',persisted:false,pending:0};
  // Every call still checkpoints synchronously, including pagehide. Only one
  // full batch sequence may use the archive writer at a time.
  let database,connection,scope;
  try {
    _loadPendingAlertRecords();
    for (const alert of ALERTS) queueAlertForArchive(alert);
    _checkpointPendingAlerts();
    if (event?.type === 'pagehide') return {success:false, error:'页面关闭前仅保存待提交记录，数据库确认将在重新打开后核对'};
    if (_alertArchiveClearPending) return {success:false, error:'正在核对或清空告警；待存记录保留，下次自动保存继续'};
    if (_alertArchiveFlushFlight) return _alertArchiveFlushFlight;
    if (!globalThis.DatyAlertDatabase) throw new Error('服务器告警数据库尚未就绪；待存记录保留');
    database=globalThis.DatyAlertDatabase;connection=globalThis.DatyDatabaseConnection;scope=alertArchiveScope();
  }catch(error){_alertArchiveError=error.message||String(error);updateAlertArchiveStatus();return {success:false,error:_alertArchiveError};}
  const result={success:true,changed:0,processed:0,readBackConfirmed:false,count:null};
  const operation=(async()=>{try{
    const captured = [..._pendingAlertArchive.values()].slice(0,options.all===true?undefined:200).map(item => JSON.parse(JSON.stringify(item)));
    for(let offset=0;offset<Math.max(captured.length,1);offset+=200){
      if(database!==globalThis.DatyAlertDatabase||connection!==globalThis.DatyDatabaseConnection||scope!==alertArchiveScope())throw new Error('服务器连接已变化，停止后续归档；待存记录保留');
      const batch=await database.flush(captured.slice(offset,offset+200));
      if(!batch.success)throw new Error(batch.error||batch.code||'数据库未确认归档');
      if(database!==globalThis.DatyAlertDatabase||connection!==globalThis.DatyDatabaseConnection||scope!==alertArchiveScope())throw new Error('服务器连接已变化，旧保存结果需核对；待存记录保留');
      result.changed+=batch.changed;result.processed+=batch.confirmed.length;result.readBackConfirmed=batch.readBackConfirmed===true;result.count=batch.count;
      // Commit each confirmed batch's queue checkpoint independently. Failure in
      // a later batch must not pretend an earlier receipt never happened.
      _loadPendingAlertRecords();
      for(const item of batch.confirmed)if(JSON.stringify(_pendingAlertArchive.get(item.id))===JSON.stringify(item.snapshot))_pendingAlertArchive.delete(item.id);
      (globalThis.DatyPlatform?.storage || localStorage).setItem(ALERT_PENDING_KEY,JSON.stringify([..._pendingAlertArchive.values()]));
      if(batch.changed)_alertArchiveSavedAt=Date.now();
    }
    _alertArchiveError = result.readBackConfirmed ? '' : '告警已提交数据库，但历史查询未完成';
    if(result.readBackConfirmed)_alertArchiveReadError='';
    updateAlertArchiveStatus();
    if (typeof renderLog === 'function' && alertLogView === 'archive') renderLog();
    return {...result,count:result.readBackConfirmed?result.count:null,pending:_pendingAlertArchive.size};
  } catch (error) {
    _alertArchiveError = error.message || String(error);
    updateAlertArchiveStatus();
    return {...result,success:false,error:_alertArchiveError,pending:_pendingAlertArchive.size};
  }})();_alertArchiveFlushFlight=operation;updateAlertArchiveStatus();
  try{return await operation;}finally{if(_alertArchiveFlushFlight===operation)_alertArchiveFlushFlight=null;updateAlertArchiveStatus();updateAlertLogControls();}
}

function initializeAlertArchiving() {
  if(globalThis.DatyDataRetention?.history===false)return;
  if (_alertArchiveStarted) return;
  _alertArchiveStarted = true;
  try {
    _loadPendingAlertRecords();
    _alertArchiveSavedAt = JSON.parse((globalThis.DatyPlatform?.storage || localStorage).getItem(ALERT_ARCHIVE_META_KEY) || '{}').savedAt || 0;
  } catch (error) { _alertArchiveError = error.message || String(error); }
  for (const alert of ALERTS) queueAlertForArchive(alert);
  _alertArchiveTimer = setInterval(flushAlertArchive, ALERT_ARCHIVE_INTERVAL_MS);
  // 浏览器后台计时器可能节流；切换后台/关闭前同步补存，返回时再补存。
  window.addEventListener('pagehide', flushAlertArchive);
  document.addEventListener('visibilitychange', flushAlertArchive);
  window.addEventListener('storage', event => {
    if (event.key === ALERT_ARCHIVE_KEY && alertLogView === 'archive') renderLog();
  });
  updateAlertArchiveStatus();
}

async function addAlertToStorage(alert) {
  queueAlertForArchive(alert);
  const result = await flushAlertArchive();
  if (!result.success) throw new Error(result.error);
  return result.count;
}

async function getAllAlertsFromStorage() { return readAlertArchive(); }
async function getAlertCountFromDB() { return readAlertArchive().length; }

async function exportAlertsToDB() {
  if(_alertManualSavePending||_alertArchiveClearPending||['timeline','audit'].includes(alertLogView)||alertLogView==='cleared'&&['timeline','audit'].includes(_alertLogClearedSource))return false;
  _alertManualSavePending=true;updateAlertLogControls();updateAlertArchiveStatus();
  try{
  if(_alertArchiveFlushFlight)await _alertArchiveFlushFlight;
  const pending = globalThis.DatyAlertDatabase?.status().pending;
  if (pending && typeof pending === 'object' && pending.status === 'unknown') {
    const reviewed = await DatyAlertDatabase.reviewPending();
    if(reviewed.status==='reconciled'){_alertArchiveReadError='';if(alertLogView==='archive')renderLog();}
    updateAlertArchiveStatus();
    if(reviewed.status==='cancelled')return false;
    notify(reviewed.status === 'reconciled' ? '✓' : '⚠️', '告警事务核对', reviewed.status === 'reconciled'
      ? '上一笔数据库事务已核对；本次没有重发保存，待存记录保留供后续归档'
      : '尚未确认：' + (reviewed.message || reviewed.code || reviewed.status));
    return reviewed.status==='reconciled';
  }
  const result = await flushAlertArchive(undefined,{all:true});
  if (result.success) {
    if(alertLogView==='archive')renderLog();
    notify(result.readBackConfirmed?'💾':'⚠️',result.readBackConfirmed?'保存完成':'已保存，列表待刷新',
      `服务器已确认 ${result.processed} 条待存记录，更新 ${result.changed} 条；`+(result.count===null?'列表读取未完成':`归档共 ${result.count} 条`)+`；待存 ${result.pending} 条`);
  } else notify('❌',result.processed?'部分保存':'保存失败',(result.processed?`已确认 ${result.processed} 条；`:'')+result.error+'；未确认告警保留');
  return result.success;
  }catch(error){notify('❌','保存失败',error.message||String(error));return false;}
  finally{_alertManualSavePending=false;updateAlertLogControls();updateAlertArchiveStatus();}
}

async function clearAlertsFromStorage(token) {
  if (!globalThis.DatyAlertDatabase) throw new Error('服务器告警数据库尚未就绪');
  const changed=await DatyAlertDatabase.clearAll(token);
  _alertArchiveSavedAt = 0;
  return changed;
}

let _alertArchiveClearPending = false;
function updateAlertLogControls() {
  const filters=document.getElementById('alertArchiveFilters');if(filters)filters.hidden=alertLogView!=='archive';
  for(const [id,view] of [['logArchiveView','archive'],['logTimelineView','timeline'],['logAuditView','audit']]) {
    const button=document.getElementById(id);
    if(button){button.classList.toggle('active',alertLogView===view);button.setAttribute('aria-pressed',String(alertLogView===view));}
  }
  const activityFilters=document.getElementById('activityFilters');if(activityFilters)activityFilters.hidden=!['timeline','audit'].includes(alertLogView);
  const summary=document.getElementById('alertLifecycleSummary');if(summary)summary.hidden=alertLogView!=='archive';
  const readOnly=['timeline','audit'].includes(alertLogView)||alertLogView==='cleared'&&['timeline','audit'].includes(_alertLogClearedSource);
  const busy=_alertArchiveClearPending||_alertManualSavePending;
  const clear=document.getElementById('logClearStorage');if(clear){clear.disabled=busy||readOnly;clear.setAttribute('aria-busy',String(_alertArchiveClearPending));}
  const save=document.getElementById('logSaveNow');if(save){save.disabled=busy||readOnly;save.setAttribute('aria-busy',String(_alertManualSavePending));}
  const archive=document.getElementById('logArchiveView');if(archive)archive.setAttribute('aria-busy',String(_alertArchiveReading));
  const display=document.getElementById('logClearDisplay');if(display)display.disabled=alertLogView==='cleared';
}

function alertLogEmptyMarkup(title,message,symbol='📋') {
  const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  return `<tr><td colspan="5" class="log-message-cell"><div class="log-empty-state"><span class="log-empty-symbol" aria-hidden="true">${escape(symbol)}</span><strong>${escape(title)}</strong><span>${escape(message)}</span></div></td></tr>`;
}

async function clearAllAlertsFromDB() {
  if(_alertArchiveClearPending||_alertManualSavePending||['timeline','audit'].includes(alertLogView)||alertLogView==='cleared'&&['timeline','audit'].includes(_alertLogClearedSource))return false;
  _alertArchiveClearPending=true;updateAlertLogControls();updateAlertArchiveStatus();
  const database=globalThis.DatyAlertDatabase;let token;
  try {
    if(_alertArchiveFlushFlight)await _alertArchiveFlushFlight;
    if(typeof database?.prepareClear==='function'){token=await database.prepareClear();_alertArchiveReadError='';if(alertLogView==='archive')renderLog();}
    const count=token?token.count:readAlertArchive().length;
    if(!count){notify('ℹ️','无需清理','存储中没有告警记录');return false;}
    const platform=globalThis.DatyPlatform,storage=platform?.storage || localStorage,dialogs=globalThis.DatyDialogs;
    const snapshot=storage.getItem(ALERT_ARCHIVE_KEY);
    if(typeof dialogs?.confirm!=='function')throw new Error('应用内确认组件未加载，请刷新页面');
    const decision=dialogs.confirm({title:'清空告警存储',eyebrow:'DATY RF PRO · 数据管理',symbol:'×',tone:'danger',
      message:'确认将服务器已归档告警标记删除？',confirmLabel:'确认清空',cancelLabel:'取消',
      details:[{label:'清理范围',value:'服务器已归档告警'},{label:'记录数量',value:count+' 条'},{label:'保留内容',value:'实时告警、待存事件和服务端 Timeline'}],
      warnings:['从当前列表移除；服务器审计版本继续保留。'],footnote:'自动保存继续运行；新的告警生命周期会继续归档'});
    if(!decision || typeof decision.then!=='function')throw new TypeError('告警确认接口必须返回 Promise<boolean>');
    if(await decision!==true)return false;
    if(globalThis.DatyAlertDatabase!==database || globalThis.DatyDialogs!==dialogs || globalThis.DatyPlatform!==platform || (globalThis.DatyPlatform?.storage || localStorage)!==storage || storage.getItem(ALERT_ARCHIVE_KEY)!==snapshot)
      throw new Error('告警存储已更新，请重新打开清理窗口以核对记录数量');
    const changed=await clearAlertsFromStorage(token);
    _alertArchiveReadError='';
    if(alertLogView==='archive'){alertLogPage=1;renderLog();}updateAlertArchiveStatus();
    notify('🗑️','清理完成',`已将 ${Number.isSafeInteger(changed)?changed:count} 条数据库历史标记删除；审计版本保留`);
    return true;
  } catch(error){notify('❌','清空失败',error.message || String(error));return false;}
  finally{if(token)database.cancelClear(token);_alertArchiveClearPending=false;updateAlertLogControls();updateAlertArchiveStatus();}
}

async function showAlertArchive() {
  if(alertLogView==='archive'&&_alertArchiveReading&&_alertArchiveReadFlight)return _alertArchiveReadFlight;
  selectAlertLogView('archive');alertLogPage=1;globalThis.DatyAlertDatabasePreferredPage=null;
  const request=++_alertArchiveReadRequest,database=globalThis.DatyAlertDatabase;
  _alertArchiveReading=true;_alertArchiveReadError='';renderLog();updateAlertLogControls();
  const operation=(async()=>{try{
    if(typeof database?.load!=='function')throw new Error('服务器告警数据库尚未就绪');
    const result=await database.load({fresh:true});
    if(request!==_alertArchiveReadRequest||alertLogView!=='archive'||database!==globalThis.DatyAlertDatabase)return false;
    if(!result.success)throw new Error(result.error||'服务器没有确认告警列表');
    return true;
  }catch(error){if(request===_alertArchiveReadRequest&&alertLogView==='archive')_alertArchiveReadError=error.message||String(error);return false;}
  finally{if(request===_alertArchiveReadRequest){_alertArchiveReading=false;renderLog();updateAlertLogControls();updateAlertArchiveStatus();}}})();
  _alertArchiveReadFlight=operation;try{return await operation;}finally{if(_alertArchiveReadFlight===operation)_alertArchiveReadFlight=null;}
}

function refreshAlertLogView() {if(alertLogView==='archive')return showAlertArchive();if(alertLogView==='timeline')return globalThis.loadServerTimeline?.();if(alertLogView==='audit')return globalThis.loadOperationAudit?.();}
globalThis.DatyApplyAlertPagePreference = value => { if(Number.isSafeInteger(value.alertPage)&&value.alertPage>0)globalThis.DatyAlertDatabasePreferredPage=value.alertPage; };
function changeAlertLogPage(delta) {
  if (alertLogView === 'timeline' || alertLogView === 'audit') { window.changeServerTimelinePage?.(delta); return; }
  if (alertLogView !== 'archive') return;
  globalThis.DatyAlertDatabasePreferredPage=null;
  alertLogPage = Math.max(1, alertLogPage + delta); renderLog();
  void globalThis.DatyBusinessDatabase?.savePage('alertPage',alertLogPage);
}

// 告警归档与服务端 Timeline 共用 20 条分页；只切分显示，不删历史数据。
function renderAlertLogPagination(count, page = 1) {
  const pages = Math.max(1, Math.ceil(count / ALERT_LOG_PAGE_SIZE));
  page = Math.min(Math.max(1, page), pages);
  const paging = document.getElementById('logPagination');
  if (paging) { paging.hidden = count === 0; paging.style.display = count ? 'flex' : 'none'; }
  const info = document.getElementById('logPageInfo');
  if (info) info.textContent = `第 ${page}/${pages} 页 · 每页 ${ALERT_LOG_PAGE_SIZE} 条 · 共 ${count} 条`;
  const prev = document.getElementById('logPrevPage'), next = document.getElementById('logNextPage');
  if (prev) prev.disabled = !count || page <= 1;
  if (next) next.disabled = !count || page >= pages;
  return page;
}

function clearDataLog() {
  // “清空当前”只清画面，不能删除首页告警或已归档历史。
  if(alertLogView==='cleared')return;
  selectAlertLogView('cleared');
  const body = document.getElementById('logBody');
  if (body) body.innerHTML = alertLogEmptyMarkup('当前显示已清空','服务器记录和待存事件保留；点击任一记录来源重新查询。','🧹');
  const count = document.getElementById('logCount');
  if (count) count.textContent = '0';
  const badge=document.getElementById('logStorageCount');if(badge)badge.textContent='💾 服务器数据保留';
  const paging = document.getElementById('logPagination');
  if (paging) { paging.hidden = true; paging.style.display = 'none'; }
  updateAlertArchiveStatus();
}
