// ============================================================
// navigation.js — 导航切换、设备操作、频率规划、IMD计算
// ============================================================

// ══════════════════ NAVIGATION ══════════════════
function switchPanel(name, el) {
  const content = document.querySelector('.content');
  if (content) {
    content.classList.toggle('settings-view', name === 'settings');
    content.classList.toggle('planner-view', name === 'planner');
    content.scrollTop = 0;
  }
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('panel-'+name).classList.add('active');
  updateDataManagementLayout();
  if (typeof updateDeviceViewsLayout === 'function') updateDeviceViewsLayout();
  if(el) el.classList.add('active');
  const titles = {
    dashboard:'📊 设备概览', monitor:'📡 实时监控',
    channels:'📡 通道总览',
    spectrum:'📈 频谱扫描', planner:'🧮 频率规划',
    devices:'🔌 设备管理', data:'💾 数据管理', settings:'⚙️ 系统设置'
  };
  document.getElementById('pageTitle').textContent = titles[name]||name;
  if(name==='dashboard'){updateDashboardStats();filterDevices();drawRFBarChart();renderAlerts();}
  if(name==='spectrum'){renderFreqAxis();initScanData();runScan();}
  if(name==='monitor'){renderMonitorGrid();renderAlerts();setTimeout(drawRFBarChart,100);}
  if(name==='channels'){filterDevicesChannels();}
  if(name==='planner'){
    // 检查是否有已规划的频率（任意设备有 planned 值）
    const hasPlanned = DEVICES.some(d => d.planned && d.planned > 0);
    renderFreqTable(hasPlanned);
    _refreshPlannerChannelSelect();
  }
  if(name==='devices'){renderDevTable();}
  globalThis.DatyShureDiscovery?.syncVisibility();
  globalThis.DatyBrandPlugins?.syncVisibility();
  if(name==='data'){globalThis.DatyDataCatalog?.activate();renderHistory();renderLog();if(document.getElementById('dataLog')?.classList.contains('active'))void globalThis.refreshAlertLogView?.();}
}

function switchTab(id, el) {
  const parent = el.closest('.panel') || document.body;
  parent.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  parent.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById(id).classList.add('active');
  updateDataManagementLayout();
  if (typeof updateDeviceViewsLayout === 'function') updateDeviceViewsLayout();
  if (id === 'devOnline') renderDevTable();
  globalThis.DatyShureDiscovery?.syncVisibility();
  if (id.startsWith('data')) globalThis.DatyDataCatalog?.activate();
  if (id === 'dataLog') void globalThis.refreshAlertLogView?.();
}

function handleDataManagementTabKey(event) {
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const tabs=[...event.currentTarget.querySelectorAll('[role="tab"]')],index=tabs.indexOf(event.target);
  if(index<0)return;
  event.preventDefault();
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  tabs[next].click();tabs[next].focus();
}

function updateDataManagementLayout() {
  const data = document.getElementById('panel-data');
  for(const tab of data?.querySelectorAll('[role="tab"]') || []) {
    const selected=tab.classList.contains('active');tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
  }
  const log = document.getElementById('dataLog');
  const active = !!(data?.classList.contains('active') && log?.classList.contains('active'));
  const history = document.getElementById('dataHistory');
  const historyActive = !!(data?.classList.contains('active') && history?.classList.contains('active'));
  const serverActive = !!(data?.classList.contains('active') && document.getElementById('dataServer')?.classList.contains('active'));
  data?.classList.toggle('alert-log-layout', active);
  data?.classList.toggle('planning-history-layout', historyActive);
  data?.classList.toggle('server-archive-layout', serverActive);
  const content = document.querySelector('.content');
  if (content) {
    content.classList.toggle('alert-log-view', active);
    content.classList.toggle('planning-history-view', historyActive);
    content.classList.toggle('server-archive-view', serverActive);
    content.scrollTop = 0;
  }
}

// ══════════════════ ACTIONS ══════════════════
function filterDevices() {
  const brand = document.getElementById('filterBrand')?.value || 'all';
  const devs = brand==='all' ? DEVICES : DEVICES.filter(d=>d.brand===brand);
  renderDeviceGrid(devs);
}

function sortDevices(key) {
  const sorted = [...DEVICES].sort((a,b)=>b[key]-a[key]);
  renderDeviceGrid(sorted);
}

function sortByBatt() {
  const sorted = [...DEVICES].sort((a,b)=>a.batt-b.batt);
  document.getElementById('monitorGrid').innerHTML = '';
  const tmp = DEVICES.splice(0);
  tmp.sort((a,b)=>a.batt-b.batt);
  DEVICES.push(...tmp);
  renderMonitorGrid();
  DEVICES.sort((a,b)=>a.id-b.id);
}

function runPlanning() {
  // planning-ui.js 会在生产入口中接管该函数；若它尚未加载，
  // 只提示不可用，绝不生成演示规划结果。
  notify('⚠️','规划模块未就绪','可信规划器尚未加载，未生成任何结果');
}

// 计算跨品牌 IMD（基于当前频率 device.freq）
function calculateCrossBrandIMD(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const engine = typeof window !== 'undefined' ? window.DatyCoordination : null;
  if (!engine || typeof engine.analyzeFrequencyPlan !== 'function') {
    return {conflicts: [], minMargin: null, brandStats: {}, totalCombinations: 0, unavailable: true};
  }
  const frequencies = new Map(list
    .filter(device => Number.isInteger(Number(device?.freq)) && Number(device.freq) > 0)
    .map(device => [device.id, Number(device.freq)]));
  const analysis = engine.analyzeFrequencyPlan(list, frequencies, {
    compatibilityLevel: 'standard', scanPoints: [], excludedRanges: [], knownCarriers: []
  });
  return {
    ...analysis,
    minMargin: analysis.minImdMarginKHz ?? null,
    totalCombinations: analysis.totalPairs,
  };
}

// 导出 IMD 详细报告
function exportIMDReport() {
  // planning-ui.js 在生产入口中提供唯一的可复核报告导出实现。
  // 这里保留安全占位，防止依赖加载异常时导出过期的演示报告。
  notify('⚠️', '报告不可用', '可信规划器尚未完成运行，未生成任何报告');
}

function planBrand(brand) {
  notify('ℹ️',`${brand} 规划`,`生产规划统一使用“全局规划”，不会生成孤立的单品牌模拟结果`);
}

// 兼容旧入口：只有当前 Profile + 安全参数会进入实际求解，不再保留假规则编辑器。
function applyRule() {
  window.DatyPlanningDeployment?.refreshControls();
  notify('📋','按各品牌 Profile 联合规划','请在基本设置选择兼容级别，或在安全参数中加严；不能用某一品牌规则覆盖其他品牌');
}
function openCustomRule() {
  if(window.openPlannerSafetySettings)window.openPlannerSafetySettings();
  else notify('❌','规划设置未加载','请刷新服务器页面');
}
function saveCustomRule() {
  openCustomRule();
  notify('📋','请使用当前规划设置','安全参数与规划约束会参与下一次全局规划；旧版演示规则不保存、不生效');
}

// 规划频率统一进入预检/事务队列，模块缺失时安全拒绝，绝不回退到当前频率。
async function pushFreq(id) {
  if (!window.DatyPlanningDeployment) { notify('❌','下发不可用','规划部署模块未加载，请刷新页面'); return; }
  return window.DatyPlanningDeployment.pushOne(id);
}
async function pushAllFreq() {
  if (!window.DatyPlanningDeployment) { notify('❌','下发不可用','规划部署模块未加载，请刷新页面'); return; }
  return window.DatyPlanningDeployment.pushAll();
}

function escapeCsvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function _frequencyMHzText(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? (numeric / 1000).toFixed(3) : '—';
}

function escapeReportHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

async function downloadGeneratedFile(filename, content, mimeType) {
  return globalThis.DatyTextExportFactory.saveText(globalThis,content,{fileName:filename,mimeType:mimeType+';charset=utf-8'});
}

function buildPlanCsv(devices = DEVICES, pool = null) {
  const rows = [['device_id','name','brand','model','channel','ip','current_mhz','planned_mhz','profile_id']];
  devices.forEach(device => rows.push([
    device._fasheId || device.id,
    device.name,
    device.brand,
    device.model,
    device.ch,
    device.ip || '',
    Number.isFinite(Number(device.freq)) && Number(device.freq) > 0 ? _frequencyMHzText(device.freq) : '',
    device.planned > 0 ? _frequencyMHzText(device.planned) : '',
    device.equipmentProfileId || '',
  ]));
  (pool?.reservedFrequenciesKHz || []).forEach((value,index)=>rows.push(['',`预留频点 ${index+1}（未绑定设备）`,'','','','','',_frequencyMHzText(value),'']));
  return '\uFEFF' + rows.map(row => row.map(escapeCsvCell).join(',')).join('\r\n');
}

function preparePlanCsvExport(devices,now=new Date(),pool=null) {
  return {text:buildPlanCsv(devices,pool),options:{fileName:`DATY_RF_Plan_${now.toISOString().slice(0,10)}.csv`,mimeType:'text/csv;charset=utf-8'},
    dialog:{title:'导出频率方案',eyebrow:'DATY RF PRO · 频率规划',symbol:'↓',message:'导出当前设备的完整频率分配表。',confirmLabel:'导出方案',cancelLabel:'取消',
      details:[{label:'文件格式',value:'CSV 表格 · UTF-8'},{label:'通道数量',value:`全部 ${devices.length} · 已规划 ${devices.filter(d=>d.planned>0).length}`},
        {label:'包含内容',value:'接收机身份、CH、品牌、当前与规划频率、Profile'},
        ...(pool?[{label:'预留频点',value:`${pool.reservedFrequenciesKHz.length} 个 · 未绑定设备；共规划 ${pool.plannedCount}/${pool.targetCount} 个频点${pool.complete?'':'，目标未达到'}`}]:[])],footnote:'导出全部行，不受当前分页影响；导出不会下发设备'}};
}
let plannerCsvExportPending=false;
async function exportPlan() {
  if(plannerCsvExportPending)return false;
  if(!DEVICES.some(device=>device.planned>0)){notify('⚠️','无法导出','当前没有已规划频率');return false;}
  plannerCsvExportPending=true;const controller=new AbortController(),cancel=()=>controller.abort();
  const button=document.getElementById('plannerExportPlan');if(button){button.disabled=true;button.setAttribute('aria-busy','true');}
  globalThis.addEventListener?.('pagehide',cancel,{once:true});
  try {
    const platform=globalThis.DatyPlatform,dialogs=globalThis.DatyDialogs,exporter=globalThis.DatyTextExportFactory,port=globalThis.DatyTextExports;
    const prepared=preparePlanCsvExport(DEVICES,new Date(),globalThis.DATY_LAST_COORDINATION?.frequencyPool);
    prepared.dialog.details.unshift({label:'文件名称',value:prepared.options.fileName});
    if(typeof dialogs?.confirm!=='function' || typeof exporter?.saveText!=='function')throw new Error('导出组件未加载，请刷新页面');
    const decision=dialogs.confirm(prepared.dialog);
    if(!decision || typeof decision.then!=='function')throw new TypeError('方案确认接口必须返回 Promise<boolean>');
    if(await decision!==true || controller.signal.aborted)return false;
    if(buildPlanCsv(DEVICES,globalThis.DATY_LAST_COORDINATION?.frequencyPool)!==prepared.text)throw new Error('设备或频率方案已变化，请重新打开导出窗口');
    if(globalThis.DatyPlatform!==platform || globalThis.DatyDialogs!==dialogs || globalThis.DatyTextExportFactory!==exporter || globalThis.DatyTextExports!==port)throw new Error('文件保存环境已变化，请重新导出');
    const saved=await exporter.saveText(globalThis,prepared.text,{...prepared.options,signal:controller.signal});
    if(controller.signal.aborted || saved.status==='cancelled' || globalThis.DatyPlatform!==platform || globalThis.DatyTextExportFactory!==exporter || globalThis.DatyTextExports!==port)return false;
    if(!['saved','download-started'].includes(saved.status))throw new Error('文件保存状态无效');
    notify('⬇',saved.status==='saved'?'文件已保存':'已开始下载',saved.status==='saved'?'CSV 频率方案已保存':'请在下载列表中查看 CSV 频率方案');return true;
  }catch(error){if(!controller.signal.aborted)notify('❌','方案导出失败',error.message || String(error));return false;}
  finally{plannerCsvExportPending=false;globalThis.removeEventListener?.('pagehide',cancel);if(button){button.disabled=false;button.removeAttribute('aria-busy');}}
}
globalThis.DatyPlanCsv=Object.freeze({buildText:buildPlanCsv,prepareExport:preparePlanCsvExport});

/**
 * 静音/取消静音设备
 * @param {number} id - 设备ID
 */
function getDeviceChannelNumber(device) {
  if (typeof getDeviceChannelNumberSafe === 'function') {
    return getDeviceChannelNumberSafe(device, null);
  }
  const raw = device?.channel_number ?? device?.channel_no ?? device?.channel ?? device?.ch ?? device?.channel_key;
  const text = String(raw ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text) > 0 ? Number(text) : null;
  const match = text.match(/(?:^|[^a-z])(?:channel|ch)\s*[-_:#\s]*[^0-9\s]{0,4}\s*(\d+)/i);
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

// 服务器命令必须始终带有通道级稳定 ID；如果某个兼容快照没有
// _fasheId，则使用它的 id 作为后备，仍由 bridge 再校验 receiver+CH。
function buildTargetedDeviceCommand(device, command, value) {
  const channelNumber = getDeviceChannelNumber(device);
  const receiverId = device.receiver_id || device.receiverId || device._receiver_id
    || (String(device._fasheId || '').replace(/_ch\d+$/i, '') || undefined);
  const receiverIp = device.receiver_ip || device.receiverIp || device.ip || undefined;
  const receiverMac = device.receiver_mac || device.receiverMac || device.mac || undefined;
  return {
    type: 'device_command',
    device_id: device._fasheId || device.id || undefined,
    receiver_id: receiverId,
    receiver_ip: receiverIp,
    receiver_mac: receiverMac,
    receiver_session_id: device._source === "shure-scp" ? device.shure?.meter_stream_id : String(device._source || "").split(":mqtt:")[1],
    mac_address: receiverMac,
    ip: receiverIp,
    channel: channelNumber,
    channel_number: channelNumber,
    channel_key: channelNumber === null ? undefined : `CH${channelNumber}`,
    group: device.group,
    expected_brand:window.DatyEquipmentProfiles?.normalizeBrand(device.brand || '') || String(device.brand || ''),
    command,
    value
  };
}

// ACK 可能早于 POST 响应到达。按 command_id 缓存终态，禁止迟到的 published
// 覆盖已确认状态；有界缓存不在长时间运行中增长。HTTP 仅用于推送丢失时兜底。
const commandAcknowledgementCache = new Map();
const commandAcknowledgementWaiters = new Map();
const muteRequestWaiters = new Map();
// 最近 50 次真实按钮处理的单调耗时，仅保存在本页内存，不写入生产项目或设备。
// ACK RTT 不包含浏览器排队；ui_updated_ms 才覆盖处理开始到按钮 DOM 更新。
const muteControlDiagnostics = [];
function getMuteControlDiagnostics() {
  return muteControlDiagnostics.map(record => ({...record}));
}
function beginMuteControlDiagnostic(command, started) {
  const record = {device_id:command.device_id, command:command.command, at:new Date().toISOString(), state:'sending'};
  muteControlDiagnostics.push(record);
  if (muteControlDiagnostics.length > 50) muteControlDiagnostics.shift();
  return {record, mark:stage => {record[stage] = Math.round((performance.now() - started) * 1000) / 1000;}};
}
function receiveCommandAcknowledgement(command) {
  if (!command?.command_id || !['acknowledged', 'readback_confirmed', 'failed', 'timeout'].includes(command.status)) return;
  const now = Date.now();
  for (const [id, item] of commandAcknowledgementCache) {
    if (now - item.at > 30000) commandAcknowledgementCache.delete(id);
  }
  const id = String(command.command_id);
  if (!commandAcknowledgementCache.has(id)) commandAcknowledgementCache.set(id, {command, at: now});
  while (commandAcknowledgementCache.size > 256) commandAcknowledgementCache.delete(commandAcknowledgementCache.keys().next().value);
  for (const accept of commandAcknowledgementWaiters.get(id) || []) accept(commandAcknowledgementCache.get(id).command);
  // POST 尚未返回时还不知道服务器 command_id；用本次随机请求编号严格关联。
  muteRequestWaiters.get(command.client_request_id)?.(command);
}

function waitForCommandAcknowledgement(commandId, timeoutMs = 10000, {signal} = {}) {
  const id = String(commandId);
  return new Promise((resolve, reject) => {
    let finished = false, pollTimer, deadlineTimer, controller;
    const finish = (command, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(pollTimer);
      clearTimeout(deadlineTimer);
      controller?.abort();
      signal?.removeEventListener('abort', onAbort);
      const waiters = commandAcknowledgementWaiters.get(id);
      waiters?.delete(accept);
      if (waiters?.size === 0) commandAcknowledgementWaiters.delete(id);
      if (error) reject(error); else resolve(command);
    };
    const onAbort = () => finish(null, new Error('本次确认等待已结束'));
    const accept = command => {
      if (String(command?.command_id) !== id) return;
      if (['acknowledged','readback_confirmed'].includes(command.status)) finish(command);
      else if (['failed', 'timeout'].includes(command.status)) finish(null, new Error(command.error || '设备未确认命令'));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, {once:true});
    const cached = commandAcknowledgementCache.get(id);
    if (cached && Date.now() - cached.at <= 30000) { accept(cached.command); return; }
    if (!commandAcknowledgementWaiters.has(id)) commandAcknowledgementWaiters.set(id, new Set());
    commandAcknowledgementWaiters.get(id).add(accept);
    deadlineTimer = setTimeout(() => finish(null, new Error('等待设备确认超时')), timeoutMs);
    const poll = async () => {
      if (finished) return;
      controller = new AbortController();
      // 单次查询也有期限；短暂网络故障不覆盖真正 ACK，整体期限不随重试延长。
      const requestTimer = setTimeout(() => controller?.abort(), 1500);
      try {
        const response = await (globalThis.DatyPlatform?.request || fetch)(`${_fasheApiUrl}/api/commands/${encodeURIComponent(id)}`, {
          cache: 'no-store', signal: controller.signal
        });
        const result = await response.json();
        if (result.success && String(result.command?.command_id) === id) receiveCommandAcknowledgement(result.command);
      } catch (error) { /* SSE 可继续确认；网络恢复后重试，最终由 deadline 判定失败。 */ }
      finally { clearTimeout(requestTimer); }
      if (!finished) pollTimer = setTimeout(poll, 500);
    };
    const pushReady = typeof _fasheSSE !== 'undefined' && _fasheSSE?.readyState === 1;
    pollTimer = setTimeout(poll, pushReady ? 100 : 0);
  });
}

function sendTrackedMuteCommand(command, timeoutMs = 10000, diagnostic = null) {
  return sendTrackedDeviceCommand(command, timeoutMs, diagnostic);
}

// 静音与改频共用已验证的请求关联、先到 ACK 和 HTTP/SSE 双路径。
function sendTrackedDeviceCommand(command, timeoutMs = 10000, diagnostic = null) {
  // 此编号只关联页面请求；设备 command_id 仍由服务器生成并由设备真实回传。
  const clientRequestId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  const request = {...command, client_request_id: clientRequestId};
  if (diagnostic) diagnostic.record.client_request_id = clientRequestId;
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const started = Date.now();
    let finished = false, commandId = null, transportError = null;
    const finish = (record, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      muteRequestWaiters.delete(clientRequestId);
      // ACK 可独立结束操作：不再等待迟到/卡住的 POST 正文，顺便取消 HTTP 兜底。
      controller.abort();
      if (error) reject(error); else resolve(record);
    };
    const accept = (record, source = 'sse') => {
      if (finished || !record?.command_id) return;
      const byRequest = record.client_request_id === clientRequestId;
      const byCommand = commandId && String(record.command_id) === commandId;
      if (!byRequest && !byCommand) return;
      if (String(record.device_id) !== String(command.device_id)
          || (command.command === 'set_freq' && record.command !== 'set_freq')
          || (record.command !== undefined && record.command !== command.command)
          || (byRequest && record.command !== command.command)) {
        finish(null, new Error('设备确认的目标或命令不匹配')); return;
      }
      if (record.status === 'readback_confirmed') {
        const proof=record.execution_evidence, bound=proof?.target;
        if (proof?.source!=='shure-post-write-readback' || proof.execution_ack_supported!==false
            || String(record.expected_brand||'').toLowerCase()!=='shure'
            || !bound || ['device_id','receiver_id','receiver_ip','receiver_mac','receiver_session_id','channel_number'].some(k=>bound[k]!==command[k])) {
          finish(null,new Error('舒尔回读证据与本次目标不匹配'));return;
        }
      }
      if (['acknowledged','readback_confirmed'].includes(record.status)) {
        let valueMatches = record.actual_value === command.value;
        if (command.command === 'set_freq') {
          try { valueMatches = DatyFrequency.toFrequencyKHz(record.actual_value,'MHz') === DatyFrequency.toFrequencyKHz(command.value,'MHz'); }
          catch (_) { valueMatches = false; }
        }
        if (!valueMatches) finish(null, new Error(command.command === 'set_freq' ? '设备确认的频率不匹配' : '设备确认的静音状态不匹配'));
        else {
          if (diagnostic) {
            diagnostic.mark('ack_received_ms');
            Object.assign(diagnostic.record, {command_id:record.command_id, confirmation_path:source,
              server_ack_ms:record.ack_round_trip_ms ?? null, state:record.status});
          }
          finish(record);
        }
      } else if (['failed','timeout'].includes(record.status)) {
        finish(null, new Error(record.error || '设备未确认命令'));
      }
    };
    const deadlineTimer = setTimeout(() => finish(null, new Error(
      transportError ? '网络请求未完成，未获得设备执行确认；请核对通道当前状态'
        : '本次请求超时，未获得设备执行确认；请核对通道当前状态'
    )), timeoutMs);
    muteRequestWaiters.set(clientRequestId, accept);
    // HTTP 和 SSE 同时有效，任何时候都只能由匹配的真实 ACK 宣告成功。
    (async () => {
      let accepted = false;
      try {
        diagnostic?.mark('request_start_ms');
        const response = await (globalThis.DatyPlatform?.request || fetch)(`${_fasheApiUrl}/api/command`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify(request), signal:controller.signal
        });
        if (!finished) diagnostic?.mark('http_headers_ms');
        const result = await response.json();
        if (finished) return;
        diagnostic?.mark('http_body_ms');
        if (!result.success) {
          const error = new Error(result.error || '服务器拒绝命令');
          // An explicit request rejection is not an executed command or an uncertain POST.
          // Keep all ACK matching, early-SSE and polling behavior unchanged.
          if (result.accepted === false && [400,403,405,413,415,422].includes(response.status)) {
            error.code = result.code; error.notSent = true;
          }
          finish(null, error); return;
        }
        commandId = String(result.command_id || result.command_record?.command_id || '');
        if (!commandId) { finish(null, new Error('服务器未返回可验证的设备确认编号')); return; }
        accepted = true;
        // 部分响应已经携带终态，不需要再等推送或轮询。
        accept(result.command_record, 'http-post');
        if (finished) return;
        const record = await waitForCommandAcknowledgement(commandId,
          Math.max(1, timeoutMs - (Date.now() - started)), {signal:controller.signal});
        accept(record, 'sse-cache-or-http-query');
      } catch (error) {
        if (finished) return;
        if (accepted) finish(null, error);
        else transportError = error; // POST 响应失败不等于设备未执行；给真实 SSE ACK 留出总期限。
      }
    })();
  });
}

// A saved Shure readback is newer than an RF/AF packet carrying old mute metadata.
// This bounded, view-only observation never authorizes a command or fabricates an ACK.
const confirmedShureMuteViews = new Map();
function applyConfirmedShureMuteView(device) {
  const key = String(device?._fasheId || device?.id || ''), view = confirmedShureMuteViews.get(key);
  if (!view) return device;
  const target = buildTargetedDeviceCommand(device, view.command, view.actual);
  const valid = device._source === 'shure-scp' && device._online !== false && device.status !== 'offline' &&
    device.shure?.meter_state === 'live' && performance.now() - view.at < 15000 &&
    ['device_id','receiver_id','receiver_ip','receiver_mac','receiver_session_id','channel_number','expected_brand']
      .every(k => target[k] === view.target[k]);
  if (!valid) {
    if (device.shure === view.projected) {device.shure = view.original; device.muted = view.originalMuted;}
    confirmedShureMuteViews.delete(key); return device;
  }
  // A partial RF-only update may still point at our own last projection.
  if (device.shure === view.projected) return device;
  const observedAt = device.shure?.field_times?.muted;
  if (!Number.isFinite(observedAt) || observedAt >= view.receivedAt) {
    confirmedShureMuteViews.delete(key); return device;
  }
  view.original = device.shure; view.originalMuted = device.muted;
  view.projected = {...device.shure, receiver_muted:view.actual,
    field_times:{...device.shure.field_times, muted:view.receivedAt},
    stale_fields:(device.shure.stale_fields || []).filter(field => field !== 'muted')};
  device.shure = view.projected; device.muted = view.actual;
  return device;
}
function rememberConfirmedShureMuteView(device, record) {
  const proof = record.execution_evidence;
  if (record.status !== 'readback_confirmed' || !['mute','unmute'].includes(record.command) ||
      proof?.source !== 'shure-post-write-readback' || proof.execution_ack_supported !== false ||
      !Number.isFinite(proof.received_at_ms) || !Number.isFinite(proof.sent_at_ms) ||
      proof.received_at_ms < proof.sent_at_ms || typeof record.actual_value !== 'boolean' ||
      record.actual_value !== proof.actual_value || !proof.target) return false;
  const key = String(device._fasheId || device.id || '');
  const previous = confirmedShureMuteViews.get(key);
  if (previous && previous.receivedAt >= proof.received_at_ms) return false;
  // Remove our previous projection before comparing a subsequent command with telemetry.
  if (previous && device.shure === previous.projected) {device.shure=previous.original;device.muted=previous.originalMuted;}
  confirmedShureMuteViews.set(key, {target:{...proof.target}, command:record.command,
    actual:record.actual_value, receivedAt:proof.received_at_ms, at:performance.now()});
  while (confirmedShureMuteViews.size > 256) confirmedShureMuteViews.delete(confirmedShureMuteViews.keys().next().value);
  applyConfirmedShureMuteView(device);
  return true;
}

async function setDeviceMuteState(id, targetMuted) {
  const handlerStarted = performance.now();
  const d = DEVICES.find(x => x.id === id);
  if (!d) {
    notify('❌', '操作失败', `设备 #${id} 不存在`);
    return;
  }

  // 同一通道的上一个命令尚未收到设备确认时，禁止再次反向发送。
  // 否则一次“静音→取消静音”快速连点会在 MQTT 中交错，最终状态取决于
  // 到达顺序，而不是用户最后一次明确操作。
  const commandKey = String(d._fasheId || d.id || '');
  if (typeof window !== 'undefined') {
    window.__DATY_MUTE_COMMANDS_IN_FLIGHT = window.__DATY_MUTE_COMMANDS_IN_FLIGHT || new Set();
  }
  const inFlight = typeof window !== 'undefined' ? window.__DATY_MUTE_COMMANDS_IN_FLIGHT : null;
  if (inFlight && inFlight.has(commandKey)) {
    notify('⏳', '正在等待设备确认', `${d.name} 的上一条静音指令尚未回执`);
    return;
  }

  const cmd = buildTargetedDeviceCommand(d, targetMuted ? 'mute' : 'unmute', targetMuted);
  if (!Number.isInteger(cmd.channel_number) || cmd.channel_number < 1) {
    notify('❌', '操作失败', `${d.name} 缺少有效 CH 通道号，已拒绝发送`);
    return;
  }

  const action = targetMuted ? '静音' : '取消静音';
  const diagnostic = beginMuteControlDiagnostic(cmd, handlerStarted);
  const realtimeAtSend = d._lastRealtimeAt;
  notify(targetMuted ? '🔇' : '🔊', action, `正在向 ${d.name} 发送${action}指令...`);
  if (inFlight) inFlight.add(commandKey);
  if (typeof window !== 'undefined') {
    window.__DATY_MUTE_COMMAND_TARGETS = window.__DATY_MUTE_COMMAND_TARGETS || new Map();
    window.__DATY_MUTE_COMMAND_TARGETS.set(commandKey, targetMuted);
  }

  try {
    if (typeof refreshMuteControlButtons === 'function') refreshMuteControlButtons(d);
    const acknowledged = await sendTrackedMuteCommand(cmd, 10000, diagnostic);
    const actual = acknowledged?.actual_value;
    if (actual !== targetMuted || String(acknowledged.device_id) !== commandKey) {
      throw new Error('设备确认的目标或静音状态不匹配');
    }
    const current = DEVICES.find(x => String(x._fasheId || x.id) === commandKey);
    // 收到更新后的遥测/全量快照时，以最新设备状态为准，不能用较旧 ACK 回写。
    if (current && acknowledged.status === 'readback_confirmed') rememberConfirmedShureMuteView(current, acknowledged);
    else if (current === d && current._lastRealtimeAt === realtimeAtSend) current.muted = actual;
    if (typeof filterDevicesChannels === 'function') filterDevicesChannels();
    notify(targetMuted ? '🔇' : '🔊', `${action}成功`, `${d.name} ${targetMuted ? '已静音' : '已取消静音'}${acknowledged.status==='readback_confirmed'?' · 输出状态回读确认':''}`);
  } catch (error) {
    diagnostic.record.state = 'failed';
    const unconfirmed = `${typeof formatBrandModelDisplay === 'function' ? formatBrandModelDisplay(d) : '接收机'} 未确认`;
    diagnostic.record.error = error?.message || unconfirmed;
    notify('❌', `${action}失败`, `${d.name}: ${error?.message || unconfirmed}`);
  } finally {
    if (inFlight) inFlight.delete(commandKey);
    if (typeof window !== 'undefined') window.__DATY_MUTE_COMMAND_TARGETS?.delete(commandKey);
    const current = DEVICES.find(x => String(x._fasheId || x.id) === commandKey);
    if (current && typeof refreshMuteControlButtons === 'function') refreshMuteControlButtons(current);
    diagnostic.mark('ui_updated_ms');
    // rAF 是下一帧回调时刻，不伪称显示器已经完成绘制。
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => diagnostic.mark('next_frame_ms'));
  }
}

async function muteDevice(id) {
  return setDeviceMuteState(id, true);
}

/**
 * 取消静音设备
 * @param {number} id - 设备ID
 */
async function unmuteDevice(id) {
  return setDeviceMuteState(id, false);
}

function editFreq(id) {
  const d = DEVICES.find(x=>x.id===id);
  notify('📡','频率编辑','请在频率规划面板中调整 '+d.name+' 的频率');
}

async function doScan() {
  notify('🔍','扫描刷新','正在刷新设备状态...');
  try {
    await scanForReceivers();
  } finally {
    renderDeviceGrid(DEVICES);
  }
}

function doConnect() {
  showAddDeviceModal();
}

// ── 添加设备弹窗 ──────────────────────────────────────────────────
function showAddDeviceModal(editDevice) {
  // 移除已有弹窗
  const old = document.getElementById('addDeviceModal');
  if (old) old.remove();

  const isEdit = !!editDevice;
  const d = editDevice || {};
  const usageEditor = isEdit ? window.DatyPlanningConstraints.createLockedUsageEditor(d) : null;

  // 自动生成下一个通道号和 ID
  // 实时服务器设备的稳定 ID 是字符串；只用有限数字 ID 生成手动设备编号，
  // 避免 Math.max(字符串 ID) 得到 NaN。
  const numericIds = DEVICES
    .map(device => device && typeof device.id !== 'boolean' ? Number(device.id) : NaN)
    .filter(Number.isFinite);
  const nextId = numericIds.length > 0 ? Math.max(...numericIds) + 1 : 1;
  const id = isEdit ? d.id : nextId;

  // 解析频率：内部 kHz → 显示 MHz。新建设备不预填示例频率，
  // 必须由用户输入真实设备频点或从已导入的扫描数据中选择。
  const numericFreq = Number(d.freq);
  const freqMHz = Number.isFinite(numericFreq) && numericFreq > 0
    ? (numericFreq / 1000).toFixed(3) : '';
  const scanPoints = typeof getCurrentScanPoints === 'function' ? getCurrentScanPoints() : [];
  const quickFrequencies = Array.from(new Set((Array.isArray(scanPoints) ? scanPoints : [])
    .map(point => Number(point?.frequencyKHz))
    .filter(value => Number.isFinite(value) && value > 0)))
    .slice(0, 12);
  const quickFrequencyHtml = quickFrequencies.length
    ? quickFrequencies.map(kHz => {
        const value = (kHz / 1000).toFixed(3);
        return `<button onclick="document.getElementById('addDev_freq').value='${value}'" style="background:var(--bg4);border:1px solid var(--border);color:var(--c2);padding:3px 8px;border-radius:4px;font-size:10px;font-family:'Cascadia Code',monospace;cursor:pointer;">${value}</button>`;
      }).join('')
    : '<span style="font-size:10px;color:var(--muted);">暂无已导入扫描频点；请输入设备实测频率</span>';

  const modal = document.createElement('div');
  modal.id = 'addDeviceModal';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:0;width:420px;max-width:92vw;box-shadow:0 20px 60px rgba(0,0,0,.6);">
      <!-- 标题栏 -->
      <div style="padding:18px 22px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
        <div style="font-size:16px;font-weight:700;color:var(--text);">${isEdit ? '编辑设备' : '添加设备'}</div>
        <button onclick="document.getElementById('addDeviceModal').remove()" style="background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;padding:2px 6px;line-height:1;">&times;</button>
      </div>
      <!-- 表单 -->
      <div style="padding:18px 22px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <!-- 设备名称 -->
          <div style="grid-column:1/-1;">
            <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px;">${isEdit ? '使用分类' : '设备名称'}</label>
            <input id="addDev_name" type="text" value="" placeholder="例如: 麦克风 01" style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:7px;font-size:13px;font-family:inherit;" onfocus="this.style.borderColor='var(--c1)'" onblur="this.style.borderColor='var(--border)'">
          </div>
          <!-- 品牌 -->
          <div>
            <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px;">品牌</label>
            <select id="addDev_brand" style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:7px;font-size:13px;font-family:inherit;">
              <option value="AMSaudio" ${d.brand==='AMSaudio'?'selected':''}>AMSaudio</option>
              <option value="Shure" ${d.brand==='Shure'?'selected':''}>Shure</option>
              <option value="Sennheiser" ${d.brand==='Sennheiser'?'selected':''}>Sennheiser</option>
              <option value="DATYaudio" ${d.brand==='DATYaudio'?'selected':''}>DATYaudio</option>
            </select>
          </div>
          <!-- 型号 -->
          <div>
            <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px;">型号</label>
            <input id="addDev_model" type="text" value="${d.model || ''}" placeholder="输入实际型号" style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:7px;font-size:13px;font-family:inherit;" onfocus="this.style.borderColor='var(--c1)'" onblur="this.style.borderColor='var(--border)'">
          </div>
          <!-- 通道 -->
          <div>
            <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px;">通道</label>
            <input id="addDev_ch" type="text" value="${d.ch || 'CH-' + String(id).padStart(2,'0')}" placeholder="CH-01" style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:7px;font-size:13px;font-family:inherit;" onfocus="this.style.borderColor='var(--c1)'" onblur="this.style.borderColor='var(--border)'">
          </div>
          <!-- IP 地址 -->
          <div>
            <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px;">IP 地址</label>
            <input id="addDev_ip" type="text" value="${d.ip || ''}" placeholder="输入实际设备 IP（可留空）" style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:7px;font-size:13px;font-family:inherit;" onfocus="this.style.borderColor='var(--c1)'" onblur="this.style.borderColor='var(--border)'">
          </div>
          <!-- 频率 -->
          <div style="grid-column:1/-1;">
            <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px;">频率 (MHz)</label>
            <input id="addDev_freq" type="text" value="${freqMHz}" placeholder="例如 640.000" style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:7px;font-size:13px;font-family:'Cascadia Code','Consolas',monospace;" onfocus="this.style.borderColor='var(--c1)'" onblur="this.style.borderColor='var(--border)'">
          </div>
          <!-- 快捷频率选择 -->
          <div style="grid-column:1/-1;">
            <div style="font-size:10px;color:var(--dim);margin-bottom:6px;">快捷选频（点击填入）</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;" id="quickFreqBtns">
              ${quickFrequencyHtml}
            </div>
          </div>
        </div>
      </div>
      <!-- 底部按钮 -->
      <div style="padding:14px 22px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;">
        <button class="btn btn-outline" onclick="document.getElementById('addDeviceModal').remove()">取消</button>
        <button class="btn btn-primary" id="addDev_save">${isEdit ? '保存修改' : '添加设备'}</button>
      </div>
    </div>
  `;

  // 通过属性写入备注并绑定原始 ID，支持字符串身份且不将备注解释成 HTML。
  const nameInput = modal.querySelector('#addDev_name');
  nameInput.value = isEdit ? usageEditor.value : (d.name || '');
  if (isEdit) {
    nameInput.maxLength = 80;
    nameInput.disabled = usageEditor.disabled;
    nameInput.placeholder = usageEditor.placeholder;
    nameInput.title = usageEditor.placeholder;
    modal._usageEditor = usageEditor;
    modal._editingDevice = {...d};
    modal._initialDeviceFields = Object.fromEntries(['brand','model','ch','ip','freq'].map(key => [key,modal.querySelector('#addDev_'+key).value.trim()]));
  }
  modal.querySelector('#addDev_save').onclick = () => saveAddDevice(id,isEdit);

  // 点击遮罩关闭
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  // ESC 关闭
  const escHandler = e => { if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);

  document.body.appendChild(modal);
  // 自动聚焦名称输入框
  setTimeout(() => { const nameInput = document.getElementById('addDev_name'); if (nameInput) nameInput.focus(); }, 50);
}

// ── 保存添加/编辑的设备 ──────────────────────────────────────────
async function saveAddDevice(id, isEdit) {
  if (globalThis.DatyBusinessDatabase && !isEdit) return globalThis.DatyBusinessDatabase.saveManualForm(id,false);
  const editModal = document.getElementById('addDeviceModal');
  if (!editModal || editModal._saving) return;
  const existingTarget = isEdit ? DEVICES.find(d => d.id === id) : null;
  if (isEdit && (!existingTarget || findPlanningDevice(editModal._editingDevice) !== existingTarget)) {
    notify('⚠️','设备已变化','请关闭后重新打开对应接收机通道'); return;
  }
  const name = isEdit ? existingTarget.name : document.getElementById('addDev_name').value.trim();
  const applyUsage = () => {
    try {
      if (isEdit && editModal._usageEditor.apply(document.getElementById('addDev_name').value)) editModal._usageDirty = true;
      return true;
    } catch (error) { notify('⚠️','使用分类未保存',error.message); return false; }
  };
  const persistUsage = async () => {
    if (!editModal._usageDirty) return true;
    editModal._saving = true; editModal.querySelector('#addDev_save').disabled = true;
    const fields = [...editModal.querySelectorAll('input,select')].map(input => [input,input.disabled]);
    for (const [input] of fields) input.disabled = true;
    try {
      const saved = await saveCurrentPlanningConstraints();
      if (saved === true) editModal._usageDirty = false;
      return saved === true;
    } finally {
      editModal._saving = false; editModal.querySelector('#addDev_save').disabled = false;
      for (const [input,disabled] of fields) input.disabled = disabled;
    }
  };
  // 只改分类时，不把弹窗打开时的旧频率/遥测写回设备。
  if (isEdit && Object.entries(editModal._initialDeviceFields).every(([key,value]) => document.getElementById('addDev_'+key).value.trim() === value)) {
    if (applyUsage() && await persistUsage()) editModal.remove();
    return;
  }
  const brand = document.getElementById('addDev_brand').value;
  const model = document.getElementById('addDev_model').value.trim();
  const ch    = document.getElementById('addDev_ch').value.trim();
  const ip    = document.getElementById('addDev_ip').value.trim();
  const freqStr = document.getElementById('addDev_freq').value.trim();

  // 验证
  if (!isEdit && !name) {
    notify('⚠️', '请填写设备名称', '设备名称不能为空');
    document.getElementById('addDev_name').focus();
    return;
  }
  if (!ch) {
    notify('⚠️', '请填写通道', '通道号不能为空');
    document.getElementById('addDev_ch').focus();
    return;
  }

  const channelNumber = getDeviceChannelNumber({ channel: ch });
  if (!Number.isInteger(channelNumber) || channelNumber < 1) {
    notify('⚠️', '通道无效', '请输入 1、CH1 或 CH-1 这类明确通道号（Group 不能作为通道）');
    document.getElementById('addDev_ch').focus();
    return;
  }

  let freqKHz;
  try {
    freqKHz = DatyFrequency.toFrequencyKHz(freqStr, 'MHz');
    if (freqKHz < 470000 || freqKHz > 960000) throw new Error('请输入 470~960 MHz 范围内的频率');
  } catch (error) {
    notify('⚠️', '频率无效', error.message);
    document.getElementById('addDev_freq').focus();
    return;
  }
  const freqMHz = DatyFrequency.frequencyKHzToMHz(freqKHz);

  // 检查通道重复（排除自己）
  const existingForKey = isEdit ? DEVICES.find(d => d.id === id) : null;
  const receiverKey = ip || existingForKey?.receiver_id || existingForKey?.receiverId || '';
  const dupIdx = DEVICES.findIndex(d => {
    if (d.id === id) return false;
    const otherChannel = getDeviceChannelNumber(d);
    const otherReceiver = d.receiver_ip || d.receiverId || d.receiver_id || d.ip || '';
    return otherChannel === channelNumber && String(otherReceiver).trim() === String(receiverKey).trim();
  });
  if (dupIdx >= 0) {
    notify('⚠️', '通道重复', `通道 ${ch} 已被「${DEVICES[dupIdx].name}」占用`);
    return;
  }

  if (isEdit && ['ch','ip'].some(key => document.getElementById('addDev_'+key).value.trim() !== editModal._initialDeviceFields[key])
    && (editModal._usageDirty || document.getElementById('addDev_name').value.replace(/\s+/g,' ').trim().slice(0,80) !== editModal._usageEditor.value)) {
    notify('⚠️','请分别保存','使用分类关联已锁定的通道，请先保存分类，再修改通道或 IP。'); return;
  }
  if (!applyUsage()) return;
  if(isEdit&&globalThis.DatyBusinessDatabase?.isManualDevice(existingTarget)){
    if(!await persistUsage())return;
    return globalThis.DatyBusinessDatabase.saveManualForm(id,true);
  }
  const existing = isEdit ? DEVICES.find(d => d.id === id) : null;
  const isRealtimeDevice = !!(existing && (existing._fasheId || existing._serverManaged || existing._source));
  const deviceData = {
    ...(existing || {}),
    id,
    ch: `CH${channelNumber}`,
    channel: channelNumber,
    channel_number: channelNumber,
    channel_key: `CH${channelNumber}`,
    name,
    brand,
    model: model || existing?.model || '未填写型号',
    // 空 IP 表示尚未绑定真实设备；不再伪造 127.0.0.1。
    ip,
    freq: freqKHz,
    planned: isRealtimeDevice ? (existing?.planned || freqKHz) : freqKHz,
    muted: existing?.muted === true,
  };

  if (!isRealtimeDevice) {
    // 手工登记设备没有实时遥测来源，所有电平/电量必须显示未知，
    // 并保持离线，避免旧版 -60 dBm/60%/75% 等演示值进入告警与统计。
    deviceData.rf = null;
    deviceData.af = null;
    deviceData.afDbfs = null;
    deviceData.afUnit = 'dBFS';
    deviceData.batt = null;
    deviceData.status = 'offline';
    deviceData._online = false;
    deviceData._thresholdStatusManaged = false;
    deviceData._source = existing?._source || 'manual';
  }

  if (isEdit) {
    // 编辑模式：更新现有设备
    const idx = DEVICES.findIndex(d => d.id === id);
    if (idx >= 0) {
      DEVICES[idx] = deviceData;
    }
    notify('✓', '设备已更新', `${name} (${ch}) 已保存`);
  } else {
    // 添加模式
    DEVICES.push(deviceData);
    notify('📡', '设备已添加', `${name} (${ch}) @ ${freqMHz} MHz`);
  }

  saveDataToStorage();
  renderDevTable();
  renderDeviceGrid(DEVICES);
  forceRefreshAllPanels();

  if (!await persistUsage()) return;
  // 只关闭发起本次保存的弹窗。
  editModal.remove();
}

// ── 编辑设备（复用添加弹窗）─────────────────────────────────────────
function editDevice(id) {
  const d = DEVICES.find(x => x.id === id);
  if (d) showAddDeviceModal(d);
}

function importScan(type) {
  notify('⚠️','扫描模块未就绪',`${type} 导入器尚未加载，未生成任何模拟结果`);
}

function importFile(type) {
  notify('⚠️','导入模块未就绪',`${type} 导入器尚未加载，未修改项目数据`);
}

async function exportData(type) {
  try {
  let outcome;
  const date = new Date().toISOString().slice(0,10);
  if (type === 'csv') {
    outcome=await downloadGeneratedFile(`DATY_RF_Plan_${date}.csv`, buildPlanCsv(), 'text/csv');
  } else if (type === 'json') {
    const payload = {
      schema: 'daty-rf-project-export-v1',
      generated_at: new Date().toISOString(),
      units: {frequency: 'kHz', rf: 'dBm', af: 'dBFS'},
      devices: DEVICES,
      alerts: typeof ALERTS !== 'undefined' ? ALERTS : [],
      coordination: window.DATY_LAST_COORDINATION || null,
      server: await globalThis.DatyServerStorage.businessSnapshot(),
      viewSource: 'current browser view; server.resources contains confirmed server data',
    };
    outcome=await downloadGeneratedFile(`DATY_RF_Project_${date}.json`, JSON.stringify(payload, null, 2), 'application/json');
  } else if (type === 'report') {
    const rows = DEVICES.map(device => `<tr><td>${escapeReportHtml(device.ch)}</td><td>${escapeReportHtml(device.name)}</td><td>${escapeReportHtml(device.brand)}</td><td>${_frequencyMHzText(device.freq)} MHz</td><td>${device.planned > 0 ? _frequencyMHzText(device.planned)+' MHz' : '未规划'}</td><td>${escapeReportHtml(device.status)}</td></tr>`).join('');
    const report = `<!doctype html><meta charset="utf-8"><title>DATY RF PRO 演出报告</title><style>body{font-family:sans-serif;margin:32px;color:#172033}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd3df;padding:8px;text-align:left}th{background:#eef2f8}</style><h1>DATY RF PRO 演出报告</h1><p>生成时间：${new Date().toLocaleString('zh-CN')}</p><p>设备数：${DEVICES.length}；单位：频率 MHz、RF dBm、AF dBFS。</p><table><thead><tr><th>通道</th><th>名称</th><th>品牌</th><th>当前频率</th><th>规划频率</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table>`;
    outcome=await downloadGeneratedFile(`DATY_RF_Report_${date}.html`, report, 'text/html');
  } else {
    notify('❌','导出失败','未知导出格式');
    return;
  }
  if(outcome.status!=='cancelled')notify('✓','已存档到服务器',outcome.status==='saved'?'文件已保存':'已开始下载，可在服务器存档中再次下载');
  }catch(error){notify('❌','导出未完成',error.message);}
}

