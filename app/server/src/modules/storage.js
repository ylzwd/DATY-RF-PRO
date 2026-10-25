// ============================================================
// storage.js — 浏览器设备缓存与规划历史（告警归档见 alert-history.js）
// ============================================================

// ══════════════════ DATA ══════════════════
// 默认设备数据（首次加载时使用）
const DEFAULT_DEVICES = [];

const DEFAULT_ALERTS = [];

// 从 localStorage 加载数据，如果没有则使用默认值
function loadDataFromStorage() {
  const savedDevices = (globalThis.DatyPlatform?.storage || localStorage).getItem('daty_devices');
  const savedAlerts = (globalThis.DatyPlatform?.storage || localStorage).getItem('daty_alerts');
  let alerts = [];
  try {
    const parsedAlerts = savedAlerts ? JSON.parse(savedAlerts) : [];
    if (Array.isArray(parsedAlerts)) alerts = parsedAlerts.filter(item => item && typeof item === 'object');
  } catch (error) { console.warn('活动告警缓存读取失败:', error); }

  if (savedDevices) {
    try {
      const parsed = JSON.parse(savedDevices);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // 确保所有设备都有统一的频率单位和 muted 字段（向后兼容）。
        // 浏览器缓存不是实时来源：页面重新打开前，曾经在线的设备必须先
        // 标为离线，等待 bridge/FAshe 的新快照确认；手工设备没有遥测来源，
        // 清除旧版本留下的演示 RF/AF/电量值，避免它们进入告警和统计。
        const devices = parsed.map(d => {
          let freq = 0;
          let planned = 0;
          try { freq = DatyFrequency.toFrequencyKHz(d.freq ?? d.frequencyKHz ?? d.frequency); } catch (_) { /* 未知频率保持 0 */ }
          if (d.planned) {
            try { planned = DatyFrequency.toFrequencyKHz(d.planned); } catch (_) { planned = 0; }
          }
          const source = String(d._source ?? '').trim().toLowerCase();
          const hasLiveIdentity = !!(d._fasheId || d._serverManaged || d.receiverId || d.receiver_id || (source && source !== 'manual'));
          const normalized = { ...d, freq, planned, muted: d.muted === true };
          if (hasLiveIdentity) {
            normalized._online = false;
            normalized.status = 'offline';
          } else {
            normalized.rf = null;
            normalized.af = null;
            normalized.afDbfs = null;
            normalized.afUnit = 'dBFS';
            normalized.batt = null;
            normalized._online = false;
            normalized.status = 'offline';
            normalized._thresholdStatusManaged = false;
            normalized._source = d._source || 'manual';
          }
          return normalized;
        });
        return {
          devices: devices,
          alerts
        };
      }
    } catch (e) {
      console.error('加载设备数据失败:', e);
    }
  }

  // 首次使用默认值
  return {
    devices: JSON.parse(JSON.stringify(DEFAULT_DEVICES)),
    alerts
  };
}

// 保存数据到 localStorage
function saveDataToStorage() {
  (globalThis.DatyPlatform?.storage || localStorage).setItem('daty_devices', JSON.stringify(DEVICES));
  (globalThis.DatyPlatform?.storage || localStorage).setItem('daty_alerts', JSON.stringify(ALERTS));
}

// 清除所有 FAshe 缓存设备（保留手动添加的设备）
function clearFasheDevices() {
  const fasheCount = DEVICES.filter(d => d._fasheId).length;
  if (fasheCount === 0) {
    notify('ℹ️', '无需清理', '没有 FAshe 缓存设备');
    return;
  }
  // 移除所有带 _fasheId 的设备（它们来自 FAshe）
  DEVICES = DEVICES.filter(d => !d._fasheId);
  if (typeof evaluateRealtimeAlerts === 'function') evaluateRealtimeAlerts(DEVICES);
  saveDataToStorage();
  if (typeof forceRefreshAllPanels === 'function') forceRefreshAllPanels();
  if (typeof renderDevTable === 'function') renderDevTable();
  if (typeof refreshChannels === 'function') refreshChannels();
  notify('🗑️', '缓存已清除', `已移除 ${fasheCount} 个 FAshe 缓存设备`);
}

// 初始化数据
const initialData = loadDataFromStorage();
let DEVICES = initialData.devices;
let ALERTS = initialData.alerts;

// 给后加载的独立脚本提供实时状态访问；使用 getter 避免 DEVICES 重建后引用失效。
window.DATY_STATE = Object.freeze({
  get devices() { return DEVICES; },
  get alerts() { return ALERTS; }
});

const PLANNING_HISTORY_STORAGE_KEY = 'daty_planning_history_v1';
function readPlanningHistoryState() {
  try {
    const data = JSON.parse((globalThis.DatyPlatform?.storage || localStorage).getItem(PLANNING_HISTORY_STORAGE_KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch (_) { return {}; }
}
const savedPlanningState = readPlanningHistoryState();
const HISTORY = Array.isArray(savedPlanningState.records)
  ? savedPlanningState.records.filter(record => { try { validatePlanningRecord(record); return !!record.id; } catch (_) { return false; } }) : [];
let currentPlanningProject = savedPlanningState.project?.id
  ? savedPlanningState.project : {id:'default', name:'默认项目'};
let currentPlanningRecordId = savedPlanningState.currentRecordId || null;
const planningHistoryDeletedIds = new Set(Array.isArray(savedPlanningState.deletedRecordIds) ? savedPlanningState.deletedRecordIds : []);
let planningHistoryRevision = 0;
let planningProjectSaveQueue = Promise.resolve();
let planningSaveStatusRevision = 0;

function getCurrentPlanningProject() { return {...currentPlanningProject}; }
function getCurrentPlanningRecord() {
  return HISTORY.find(record => record.id === currentPlanningRecordId) || null;
}
function persistPlanningHistoryState() {
  (globalThis.DatyPlatform?.storage || localStorage).setItem(PLANNING_HISTORY_STORAGE_KEY, JSON.stringify({
    project:currentPlanningProject, currentRecordId:currentPlanningRecordId, records:HISTORY, deletedRecordIds:[...planningHistoryDeletedIds]
  }));
  planningHistoryRevision++;
}
function setPlanningSaveStatus(message, expectedRevision) {
  if (expectedRevision !== undefined && expectedRevision !== planningSaveStatusRevision) return;
  planningSaveStatusRevision++;
  for (const id of ['plannerConstraintSaveStatus', 'planningHistorySaveStatus']) {
    const element = document.getElementById(id);
    if (element) { element.textContent = message; element.title = message; }
  }
  return planningSaveStatusRevision;
}
function planningProjectApiBase() {
  const value = document.getElementById('fasheApiUrl')?.value || 'https://127.0.0.1:8802';
  return (globalThis.DatyPlatformFactory ? globalThis.DatyPlatformFactory.normalizeBridgeUrl(value) : value).replace(/\/$/, '');
}

// 使用已存在的项目 API；每次保存捕获独立快照并串行写入，防止两次
// 规划的异步请求倒序完成，或将当前项目之外的数据写进默认项目。
function persistPlanningProject(record = getCurrentPlanningRecord(), run = null) {
  if (window.DATY_DISABLE_SERVER_PERSISTENCE === true) return Promise.reject(new Error('服务器项目同步已禁用，仅保存到本机'));
  const base = planningProjectApiBase();
  const snapshot = JSON.parse(JSON.stringify({
    project:currentPlanningProject, record, run, deletedRecordIds:[...planningHistoryDeletedIds],
    history:HISTORY.filter(item => (item.projectId || 'default') === currentPlanningProject.id)
  }));
  const save = async () => {
    const previousResponse = await (globalThis.DatyPlatform?.request || fetch)(`${base}/api/projects/${encodeURIComponent(snapshot.project.id)}`, {cache:'no-store', signal:AbortSignal.timeout(5000)});
    let previous = {};
    if (previousResponse.status !== 404) {
      const previousResult = await previousResponse.json();
      if (!previousResponse.ok || !previousResult.success) throw new Error(previousResult.error || '项目读取失败');
      previous = previousResult.project?.data || {};
    }
    // 保留服务器上尚未载入本浏览器的历史；只删除用户明确删除的记录。
    const localIds = new Set(snapshot.history.map(item => item.id));
    const remoteHistory = Array.isArray(previous.planningHistory) ? previous.planningHistory : [];
    const history = [...snapshot.history, ...remoteHistory.filter(item => item?.id
      && !localIds.has(item.id) && !snapshot.deletedRecordIds.includes(item.id))];
    const data = {...previous, planningHistory:history, currentPlanningRecordId:snapshot.record?.id || null};
    if (snapshot.record) {
      data.constraints = snapshot.record.options || snapshot.record.constraints || {};
      data.constraintFields = snapshot.record.constraintFields;
      if (snapshot.run) data.last_coordination_at = new Date(snapshot.record.timestamp).toISOString();
    } else {
      delete data.constraints;
      delete data.constraintFields;
    }
    const body = {id:snapshot.project.id, name:snapshot.project.name, data};
    if (snapshot.record) body.devices = snapshot.record.devices;
    const response = await (globalThis.DatyPlatform?.request || fetch)(`${base}/api/projects`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(5000)
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || `项目保存 HTTP ${response.status}`);
    if (snapshot.run) {
      const runResponse = await (globalThis.DatyPlatform?.request || fetch)(`${base}/api/coordination-runs`, {
        method:'POST', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(5000),
        body:JSON.stringify({project_id:snapshot.project.id, input:{devices:snapshot.record.devices, options:snapshot.record.options}, result:snapshot.run})
      });
      const runResult = await runResponse.json();
      if (!runResponse.ok || !runResult.success) throw new Error(runResult.error || '项目已保存，但运行记录未保存');
    }
  };
  const pending = planningProjectSaveQueue.catch(() => {}).then(save);
  planningProjectSaveQueue = pending;
  return pending;
}

async function restorePlanningProjectFromServer(canRestore = () => true) {
  if (window.DATY_DISABLE_SERVER_PERSISTENCE === true || getCurrentPlanningRecord()) return;
  const revision = planningHistoryRevision;
  const project = getCurrentPlanningProject();
  try {
    const response = await (globalThis.DatyPlatform?.request || fetch)(`${planningProjectApiBase()}/api/projects/${encodeURIComponent(project.id)}`, {cache:'no-store', signal:AbortSignal.timeout(5000)});
    if (response.status === 404) return;
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '读取当前项目失败');
    // 网络读取期间用户可能已经编辑、保存或加载另一份历史，不能覆盖。
    if (!canRestore() || revision !== planningHistoryRevision || currentPlanningProject.id !== project.id) return;
    const serverProject = result.project;
    const data = serverProject?.data || {};
    currentPlanningProject = {id:project.id, name:serverProject?.name || project.name};
    if (Array.isArray(data.planningHistory)) {
      const records = data.planningHistory.filter(item => {
        try { validatePlanningRecord(item); return item.id && !planningHistoryDeletedIds.has(item.id) && (item.projectId || 'default') === project.id; }
        catch (_) { return false; }
      });
      const existingIds = new Set(HISTORY.map(item => item.id));
      HISTORY.unshift(...records.filter(item => !existingIds.has(item.id)));
      currentPlanningRecordId = data.currentPlanningRecordId === null || planningHistoryDeletedIds.has(data.currentPlanningRecordId) ? null
        : records.find(item => item.id === data.currentPlanningRecordId)?.id || records[0]?.id || null;
      persistPlanningHistoryState();
    } else if (data.constraints || data.constraintFields) {
      // 兼容之前服务端只存 constraints、没有规划历史的项目。
      savePlanningResult(serverProject.devices || [], null, data.constraints || {}, data.constraintFields || null);
    }
    const record = getCurrentPlanningRecord();
    if (record) window.DatyPlanningConstraints?.restoreSnapshot(record);
    if (typeof renderHistory === 'function') renderHistory();
    setPlanningSaveStatus(record ? '已从服务器恢复当前项目及规划历史' : '当前项目暂无规划历史');
  } catch (error) {
    if (canRestore() && revision === planningHistoryRevision) setPlanningSaveStatus('未读取到服务器项目，当前输入可先保存到本机历史');
    console.warn('[规划历史]', error);
  }
}

// ══════════════════ 规划历史 文件导入导出 ══════════════════
// 文件选择/读取按需通过异步宿主能力；启动时不创建浏览器文件控件。

function savePlanningResult(devices, coordination, options = {}, constraintFields = null) {
  if(globalThis.DatyDataRetention?.history===false)return {devices,coordination,options,constraintFields,persisted:false};
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const id = window.crypto?.randomUUID?.() || `plan-${now.getTime()}-${++planningHistoryRevision}`;
  const analysis = coordination?.analysis;
  const planData = {
    id, type:'daty_rf_planning', version:'1.0.3',
    projectId:currentPlanningProject.id, projectName:currentPlanningProject.name,
    name:`${currentPlanningProject.name} · ${coordination ? '频率规划' : '规划约束'} · ${now.toLocaleString('zh-CN', {hour12:false})}`,
    time:now.toLocaleString('zh-CN', {hour12:false}),
    date: dateStr,
    timestamp: now.getTime(),
    channels: devices.length,
    algo:coordination ? '确定性跨品牌约束规划' : '仅保存约束',
    imdMargin:analysis?.minImdMarginKHz == null ? null : `${analysis.minImdMarginKHz} kHz（净）`,
    imdConflicts:analysis?.conflicts?.length ?? 0,
    constraints:{excludedRanges:options.excludedRanges || [], lockedAssignments:options.lockedAssignments || [], knownCarriers:options.knownCarriers || [], backupCount:options.backupCount ?? 1},
    options, constraintFields, coordination:coordination || null,
    // 保留接收机身份和型号，加载时只恢复 planned，绝不覆盖实时遥测。
    devices:devices.map(d => ({
      id:d.id, _fasheId:d._fasheId, receiver_id:d.receiver_id || d.receiverId,
      receiver_ip:d.receiver_ip || d.ip, receiver_mac:d.receiver_mac || d.mac,
      channel_number:d.channel_number ?? d.channel, name:d.name, brand:d.brand,
      model:d.model, ch:d.ch, ip:d.ip, freq:d.freq, planned:d.planned,
      _source:d._source,
      equipmentProfileId:d.equipmentProfileId, equipmentBandId:d.equipmentBandId, equipmentModeId:d.equipmentModeId
    }))
  };
  const snapshot = JSON.parse(JSON.stringify(planData));
  const records = [snapshot, ...HISTORY];
  // 写入成功后才更新内存和成功提示；历史不再按日期同名覆盖。
  (globalThis.DatyPlatform?.storage || localStorage).setItem(PLANNING_HISTORY_STORAGE_KEY, JSON.stringify({
    project:currentPlanningProject, currentRecordId:id, records, deletedRecordIds:[...planningHistoryDeletedIds]
  }));
  HISTORY.splice(0, HISTORY.length, ...records);
  currentPlanningRecordId = id;
  planningHistoryRevision++;
  if (typeof renderHistory === 'function') renderHistory();
  return snapshot;
}

async function downloadPlanningFile(planData) {
  if(!globalThis.DatyTextExportFactory)throw Error('服务器文件存档接口尚未就绪');
  return globalThis.DatyTextExportFactory.saveText(globalThis,JSON.stringify(planData,null,2),planningHistoryExportOptions(planData));
}

let planningHistoryActionPending = false;
function planningHistoryExportOptions(record) {
  return {fileName:`guihua_${String(record.date || 'undated').replace(/[^0-9-]/g,'_')}_${String(record.name || '规划记录').replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g,'_')}.json`,mimeType:'application/json'};
}
function planningHistoryDialogOptions(action,record) {
  const definitions={
    load:{title:'加载规划历史',symbol:'↶',confirmLabel:'确认加载',message:'恢复这条记录中的规划约束与规划频点。',
      warnings:['当前未保存的规划输入将被此记录替换。'],footnote:'加载不会向接收机下发频率'},
    export:{title:'导出规划历史',symbol:'↓',confirmLabel:'导出 JSON',message:'导出完整规划记录，包含约束、频点和接收机通道信息。',footnote:'可在其他项目或桌面客户端中导入'},
    delete:{title:'删除规划历史',symbol:'×',tone:'danger',confirmLabel:'确认删除',message:'确认删除这条规划历史？',
      warnings:record.id===currentPlanningRecordId?['当前规划输入将保留为未保存草稿。']:[],footnote:'仅删除此条历史，接收机当前频率不受影响'}
  };
  if(!definitions[action])throw new TypeError('未知历史操作');
  const constraints={...record.options,...record.constraints};
  const details=[{label:'规划名称',value:record.name || '未命名规划'},{label:'所属项目',value:record.projectName || record.projectId || '默认项目'},
    {label:'保存时间',value:record.time || record.date || '—'},{label:'通道数量',value:record.devices?.length ?? record.channels ?? '—'},
    {label:'规划约束',value:record.constraints || record.options ? `锁定 ${constraints.lockedAssignments?.length || 0} · 排除 ${constraints.excludedRanges?.length || 0} · 占用 ${constraints.knownCarriers?.length || 0}` : '旧记录未保存约束'}];
  if(action==='export')details.push({label:'文件名称',value:planningHistoryExportOptions(record).fileName});
  return {...definitions[action],eyebrow:'DATY RF PRO · 规划历史',details,cancelLabel:'取消'};
}
async function runPlanningHistoryAction(action,id,execute) {
  if(planningHistoryActionPending)return false;
  planningHistoryActionPending=true;
  const controller=new AbortController(),cancel=()=>controller.abort();
  globalThis.addEventListener?.('pagehide',cancel,{once:true});
  try {
    const matches=HISTORY.filter(record=>record.id===id);
    if(matches.length!==1)throw new Error('规划记录已变化或身份不唯一，请刷新历史');
    const record=matches[0],json=JSON.stringify(record),revision=planningHistoryRevision;
    const context=()=>JSON.stringify([currentPlanningProject,currentPlanningRecordId,planningProjectApiBase(),window.DatyPlanningConstraints?.captureConstraintFields?.()]);
    const before=context(),dialogs=globalThis.DatyDialogs,platform=globalThis.DatyPlatform;
    if(typeof dialogs?.confirm!=='function')throw new Error('应用内确认组件未加载，请刷新页面');
    const decision=dialogs.confirm(planningHistoryDialogOptions(action,JSON.parse(json)));
    if(!decision || typeof decision.then!=='function')throw new TypeError('历史确认接口必须返回 Promise<boolean>');
    if(await decision!==true || controller.signal.aborted)return false;
    if(globalThis.DatyDialogs!==dialogs || globalThis.DatyPlatform!==platform || revision!==planningHistoryRevision || context()!==before
      || HISTORY.filter(item=>item.id===id).length!==1 || !HISTORY.includes(record) || JSON.stringify(record)!==json)
      throw new Error('规划或当前项目已变化，请重新打开操作窗口');
    if(action==='load' && window.DatyPlanningDeployment?.isBusy())throw new Error('正在下发，请等待完成后再加载规划');
    return await execute(record,controller.signal);
  } catch(error) {
    if(!controller.signal.aborted)notify('❌',({load:'加载失败',export:'导出失败',delete:'删除失败'})[action],error.message || String(error));
    return false;
  } finally {planningHistoryActionPending=false;globalThis.removeEventListener?.('pagehide',cancel);}
}

async function loadHistory(name, fromHistory = false) {
  // 先尝试从 HISTORY 内存中加载
  const matches = HISTORY.filter(h => h.id === name || h.name === name);
  if(matches.length>1){notify('❌','加载失败','规划记录身份不唯一');return false;}
  const record=matches[0];
  if (record && record.devices) return runPlanningHistoryAction('load',record.id,selected=>loadPlanFromData(selected));
  if(fromHistory){notify('❌','加载失败','该规划记录已不存在，请刷新历史');return false;}
  try {
    if (!globalThis.DatyTextFileFactory) throw new Error('文件导入组件未加载，请刷新页面');
    const revision = planningHistoryRevision;
    const file = await globalThis.DatyTextFileFactory.openLatest(globalThis, {accept:'.json', maxBytes:8 * 1024 * 1024});
    if (file.status === 'cancelled' || !file.isCurrent() || planningHistoryRevision !== revision) return false;
    if (window.DatyPlanningDeployment?.isBusy()) throw new Error('正在下发，请等待当前 ACK 或停止后续队列后再导入');
    const data = JSON.parse(file.text);
    if (data?.type === 'daty_rf_planning' && data.devices) return loadPlanFromData(data);
    notify('❌', '格式错误', '请选择 guihua_ 开头的规划方案 JSON 文件');
  } catch(err) {
    if (typeof err?.isCurrent === 'function' && !err.isCurrent()) return false;
    notify('❌', '读取失败', '无法解析或读取该文件：' + err.message);
  }
  return false;
}

function loadPlanFromData(planData) {
  globalThis.DatyTextFileFactory?.cancelPending(globalThis);
  let snapshot;
  try {
    validatePlanningRecord(planData);
    snapshot = JSON.parse(JSON.stringify(planData));
    if (!snapshot.id) snapshot.id = window.crypto?.randomUUID?.() || `import-${Date.now()}`;
    const project = {id:snapshot.projectId || 'default', name:snapshot.projectName || '默认项目'};
    const records = [snapshot, ...HISTORY.filter(record => record.id !== snapshot.id)];
    // 本机写入成功前，不改变当前项目、表单或设备规划频率。
    (globalThis.DatyPlatform?.storage || localStorage).setItem(PLANNING_HISTORY_STORAGE_KEY, JSON.stringify({project, currentRecordId:snapshot.id, records,
      deletedRecordIds:[...planningHistoryDeletedIds].filter(id => id !== snapshot.id)}));
    planningHistoryDeletedIds.delete(snapshot.id);
    currentPlanningProject = project;
    currentPlanningRecordId = snapshot.id;
    HISTORY.splice(0, HISTORY.length, ...records);
    planningHistoryRevision++;
  } catch (error) {
    notify('❌', '加载失败', error.message || String(error));
    return false;
  }
  const planDevices = snapshot.devices;
  window.DatyPlanningConstraints?.restoreSnapshot(snapshot);
  let matched = 0;
  planDevices.forEach(pd => {
    const existing = findPlanningDevice(pd);
    if (existing && Number.isInteger(pd.planned) && pd.planned >= 0) {
      existing.planned = pd.planned;
      matched++;
    }
  });
  try { saveDataToStorage(); } catch (error) { console.warn('[规划频率缓存]', error); }
  renderFreqTable(true);
  renderHistory();
  setPlanningSaveStatus('已加载历史约束；修改后请保存到当前项目');
  notify('✓', '方案已加载', `${snapshot.name || '历史方案'} — 约束已恢复，${matched}/${planDevices.length} 通道规划频率已应用（未下发设备）`);
  return true;
}

function validatePlanningRecord(record) {
  if (!record || record.type !== 'daty_rf_planning' || !Array.isArray(record.devices)
      || record.devices.some(device => !device || typeof device !== 'object' || Array.isArray(device))) throw new Error('规划设备数据格式错误');
  for (const key of ['constraints', 'options', 'constraintFields']) {
    const value = record[key];
    if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('规划约束数据格式错误');
  }
  const constraints = {...record.options, ...record.constraints};
  for (const [key, frequencies] of Object.entries({excludedRanges:['startKHz', 'endKHz'], lockedAssignments:['frequencyKHz'], knownCarriers:['frequencyKHz']})) {
    if (constraints[key] == null) continue;
    if (!Array.isArray(constraints[key]) || constraints[key].some(item => !item || frequencies.some(field => !Number.isInteger(item[field]) || item[field] <= 0))) throw new Error(`${key} 数据格式错误`);
  }
}

function findPlanningDevice(saved) {
  if (!saved) return null;
  const channel = typeof getDeviceChannelNumberSafe === 'function' ? getDeviceChannelNumberSafe(saved) : null;
  const aliases = typeof getReceiverIdentityAliases === 'function' ? [...getReceiverIdentityAliases(saved)] : [];
  const compatible = device => {
    if (channel !== null && getDeviceChannelNumberSafe(device) !== channel) return false;
    const other = [...getReceiverIdentityAliases(device)];
    const mac = aliases.find(key => key.startsWith('mac:'));
    const otherMac = other.find(key => key.startsWith('mac:'));
    if (mac && otherMac) return mac === otherMac;
    const ip = aliases.find(key => key.startsWith('ip:'));
    const otherIp = other.find(key => key.startsWith('ip:'));
    return !(ip && otherIp && ip !== otherIp);
  };
  const stableId = saved._fasheId || (typeof saved.id === 'string' && /_ch\d+$/i.test(saved.id) ? saved.id : null);
  const exact = stableId ? DEVICES.filter(d => String(d._fasheId || d.id) === String(stableId) && compatible(d)) : [];
  if (exact.length === 1) return exact[0];
  const hardware = aliases.filter(key => /^(mac|ip):/.test(key));
  const hasReceiver = !!(saved.receiver_id || saved.receiverId || hardware.length || saved._fasheId);
  if (hasReceiver && channel !== null) {
    const receiver = getCanonicalReceiverKey(saved);
    const matches = DEVICES.filter(d => compatible(d) && getDeviceChannelNumberSafe(d) === channel
      && (hardware.some(key => getReceiverIdentityAliases(d).has(key)) || getCanonicalReceiverKey(d) === receiver));
    return matches.length === 1 ? matches[0] : null;
  }
  // 旧手动方案只有本地 ID；禁止仅凭同名 CH1 匹配另一台接收机。
  if (hasReceiver || saved.id == null || (saved._source && saved._source !== 'manual')) return null;
  const manual = DEVICES.filter(d => !d._fasheId && (!d._source || d._source === 'manual') && String(d.id) === String(saved.id) && compatible(d));
  return manual.length === 1 ? manual[0] : null;
}

async function exportHistory(name) {
  const matches=HISTORY.filter(h=>h.id===name || h.name===name);
  if(matches.length!==1){notify('❌','导出失败','未找到唯一的规划记录');return false;}
  return runPlanningHistoryAction('export',matches[0].id,async(record,signal)=>{
    if(!globalThis.DatyTextExportFactory)throw new Error('文件导出组件未加载，请刷新页面');
    const result=await globalThis.DatyTextExportFactory.saveText(globalThis,JSON.stringify(record,null,2),{...planningHistoryExportOptions(record),signal});
    if(signal.aborted || result.status==='cancelled')return false;
    notify('📤',result.status==='saved'?'文件已保存':'已开始下载',result.status==='saved'?'规划 JSON 文件已保存':'请在下载列表中查看规划 JSON 文件');
    return true;
  });
}

// 告警归档由 alert-history.js 管理。初始化不再自动删除任何 IndexedDB。
async function initDatabase() { return null; }

