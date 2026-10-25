// ============================================================
// planning-ui.js — 可信规划引擎的页面集成
// 覆盖旧 navigation.js 中的演示规划/假导入实现。
// ============================================================
(function (global) {
  'use strict';
  let lastCoordination = null;
  let plannerDetailHtml = '';
  const CONSTRAINT_STORAGE_KEY = 'daty_planner_constraints_v1';
  const FIELD_DEFAULTS = Object.freeze({
    plannerExcludedRanges:'', plannerLockedAssignments:'', plannerKnownCarriers:'',
    plannerBackupCount:'1', plannerRange:'614250:638000', plannerCompatibility:'standard',
    plannerRangeStart:'640.000',plannerRangeEnd:'690.000',plannerStepKHz:'25',
    plannerMinSpacingKHz:'',plannerImdSpacingKHz:'',plannerScanThresholdDbm:'',plannerImdPolicy:'third'
  });
  let constraintRevision = 0;
  let restoredLockTargets = new Map();
  let lockPickerOptions = new Map();
  let lockPickerSignature = '';
  let lockPickerSelection = '';
  let lockEditorDraft = null;

  function getDevices() {
    return global.DATY_STATE?.devices || global.DEVICES || [];
  }

  function getPlanningDevices() {
    // 离线缓存不冒充本次在线目标；无实时身份的手工数据仍可用于离线规划。
    return getDevices().filter(d => (!d._fasheId && (!d._source || d._source==='manual')) || (!/^(false|0|no|offline)$/i.test(String(d._online ?? ''))
      && !/^(offline|disconnected|disconnect|timeout|unavailable|lost)$/i.test(String(d.status ?? ''))));
  }

  function constraintLines(value) {
    return String(value || '').split(/\r?\n/).map((line,index) => ({line:line.trim(),index})).filter(item => item.line);
  }

  function parseConstraintLine(label, index, parse) {
    try { return parse(); }
    catch (error) { throw new Error(`${label}第 ${index + 1} 行：${error.message || String(error)}`); }
  }

  function parseExcludedRanges(value) {
    return constraintLines(value).map(({line,index}) => parseConstraintLine('排除区',index,() => {
      const match = line.match(/^(\d+(?:\.\d+)?)\s*[-–~～—]\s*(\d+(?:\.\d+)?)(?:\s+(.+))?$/);
      if (!match) throw new Error('格式应为 起始MHz-结束MHz 原因');
      const startKHz = DatyFrequency.toFrequencyKHz(match[1], 'MHz');
      const endKHz = DatyFrequency.toFrequencyKHz(match[2], 'MHz');
      if (startKHz >= endKHz) throw new Error('起点必须小于终点');
      return {id:`excluded-${index + 1}`, startKHz, endKHz, reason:match[3] || '用户排除区'};
    }));
  }

  function resolveConstraintDevice(token) {
    const compact = String(token).trim().toLowerCase();
    const saved = restoredLockTargets.get(compact);
    if (saved) {
      const current = global.findPlanningDevice?.(saved);
      if (!current) throw new Error(`锁定目标“${token}”的原接收机通道尚未找到，请连接设备或重新指定目标`);
      return current;
    }
    const matches = getDevices().filter(device =>
      String(device.id).toLowerCase() === compact || String(device.ch || '').toLowerCase() === compact ||
      String(device._fasheId || '').toLowerCase() === compact || String(device.name || '').toLowerCase() === compact);
    if (matches.length !== 1) throw new Error(`锁定目标“${token}”无法唯一匹配设备`);
    return matches[0];
  }

  function parseLockedAssignmentLine(line, index) {
    return parseConstraintLine('锁定频率',index,() => {
      const match = line.replace(/＝/g,'=').match(/^([^=]+)=\s*(\d+(?:\.\d+)?)(?:\s+(.+))?$/);
      if (!match) throw new Error('格式应为 唯一CH或设备ID=MHz 原因');
      return {deviceId:resolveConstraintDevice(match[1]).id, frequencyKHz:DatyFrequency.toFrequencyKHz(match[2], 'MHz'), reason:match[3] || '用户锁定'};
    });
  }

  function parseLockedAssignments(value) {
    const seen = new Set();
    return constraintLines(value).map(({line,index}) => {
      const lock = parseLockedAssignmentLine(line,index), key = String(lock.deviceId);
      if (getDevices().filter(device => String(device.id) === key).length !== 1) {
        throw new Error(`锁定频率第 ${index + 1} 行：设备 ID 不唯一，请先核查接收机身份`);
      }
      if (seen.has(key)) throw new Error(`锁定频率第 ${index + 1} 行：目标 ${key} 重复设置，请仅保留一行`);
      seen.add(key);
      return lock;
    });
  }

  // 表格读取当前约束（含未保存编辑），与实际规划共用解析和历史身份定位。
  // 一行尚未输入完整不遮掉其他合法行；不把未知目标猜到同号 CH 上。
  function getLockedFrequencyView() {
    const locks = new Map(), errors = [];
    constraintLines(document.getElementById('plannerLockedAssignments')?.value).forEach(({line,index}) => {
      try {
        const lock = parseLockedAssignmentLine(line, index), key = String(lock.deviceId);
        if (getDevices().filter(device => String(device.id) === key).length !== 1) {
          throw new Error(`锁定目标 ${key} 的设备 ID 不唯一，请先核查接收机身份`);
        }
        if (locks.has(key)) {
          const reason = `锁定目标 ${key} 重复设置，请仅保留一行`;
          locks.set(key, {invalid:true, reason});
          errors.push(reason);
        } else locks.set(key, lock);
      } catch (error) { errors.push(error.message || String(error)); }
    });
    return {locks, errors};
  }

  // 两框编辑器只是旧多行约束的视图；历史格式、reason 和安全解析保持兼容。
  // 下拉项保存显示时的频点快照，后续遥测刷新绝不重写已锁定频率。
  function lockLineParts(line) {
    const match = line.replace(/＝/g,'=').match(/^([^=]+)=\s*(\d+(?:\.\d+)?)(?:\s+(.+))?$/);
    return match ? {token:match[1].trim(), mhz:match[2], note:match[3] || ''} : null;
  }

  function lockDeviceOnline(device) {
    if (global._dashboardIsDeviceOnline) return global._dashboardIsDeviceOnline(device);
    const offline = /^(false|0|no|offline|disconnected|timeout|unavailable|lost)$/i;
    return !offline.test(String(device?._online ?? '')) && !/^(offline|disconnected|timeout|unavailable|lost)$/i.test(String(device?.status ?? ''))
      && (device?._online === true || /^(true|1)$/i.test(String(device?._online)) || /^(online|warn|0|1)$/i.test(String(device?.status)));
  }

  function lockDeviceLabel(device, token) {
    const channel = device ? global.formatChannelDisplay?.(device) || device.ch || token : token;
    const receiver = [device?.receiver_ip,device?.ip].find(value => typeof value === 'string' && value.trim())?.trim() || 'IP未知';
    const groupNumber = global.DatyCoordination?.getDevicePlanningPosition(device)?.groupNumber;
    const group = groupNumber == null ? '编组未知' : `GROUP${groupNumber}`;
    return {channel,receiver,group};
  }

  function lockFrequencyLabel(frequencyKHz) {
    try { return DatyFrequency.formatFrequencyMHz(frequencyKHz); }
    catch (_) { return '—'; }
  }

  function refreshLockEditor(preferredSelection) {
    updateCompatibilityFeedback();
    const select = document.getElementById('plannerLockChannel'), note = document.getElementById('plannerLockNote');
    if (!select || !note) return;
    const rows = constraintLines(document.getElementById('plannerLockedAssignments')?.value);
    const options = new Map(), lockedIds = new Set();
    rows.forEach(({line,index}) => {
      const parts = lockLineParts(line);
      let device = null, error = '';
      try { device = resolveConstraintDevice(parts?.token || line); }
      catch (e) { error = e.message; }
      if (device) lockedIds.add(String(device.id));
      const saved = restoredLockTargets.get(String(parts?.token || '').toLowerCase());
      const {channel,receiver,group} = lockDeviceLabel(device || saved, parts?.token || line);
      const online = !!device && lockDeviceOnline(device);
      const label = parts ? `${receiver} · ${group} · ${channel} · ${parts.mhz} MHz · ${online ? '已锁定' : '离线/待连接锁定'}${parts.note ? ' · '+parts.note : ''}` : `待修正锁定 · ${line}`;
      options.set(`lock:${index}`, {index,line,parts,device,saved,label,title:error || `${label}；当前频点 ${lockFrequencyLabel(device?.freq)} MHz，锁定值不随遥测改变`});
    });
    const devices = getDevices().filter(d => lockDeviceOnline(d) && !lockedIds.has(String(d.id)));
    devices.sort((a,b) => (global.getDeviceChannelNumberSafe?.(a) || 0) - (global.getDeviceChannelNumberSafe?.(b) || 0)
      || String(a._fasheId || a.id).localeCompare(String(b._fasheId || b.id),undefined,{numeric:true}));
    for (const device of devices) {
      const token = String(device._fasheId || device.id), {channel,receiver,group} = lockDeviceLabel(device,token);
      const frequencyKHz = device.freq;
      if (!Number.isSafeInteger(frequencyKHz) || lockFrequencyLabel(frequencyKHz) === '—') continue; // 不用缺失/错误频点生成锁定
      const label = `${receiver} · ${group} · ${channel} · ${DatyFrequency.formatFrequencyMHz(frequencyKHz)} MHz`;
      // 拒绝不唯一或会借用旧接收机身份的目标，不能按数组位置猜测。
      try { if (resolveConstraintDevice(token) !== device || getDevices().filter(d => String(d.id) === String(device.id)).length !== 1) continue; }
      catch (_) { continue; }
      options.set(`device:${token}`, {token,frequencyKHz,saved:{...device},label,title:`${label} · ${device.brand || ''} ${device.model || ''} · ID ${token}`});
    }
    // 预选是独立草稿：遥测不能换掉待确认的接收机身份、频点或职位属性。
    if (lockEditorDraft && lockEditorDraft.index === undefined) {
      const current = global.findPlanningDevice?.(lockEditorDraft.saved);
      const {channel,receiver,group} = lockDeviceLabel(current || lockEditorDraft.saved,lockEditorDraft.token);
      const label = `${receiver} · ${group} · ${channel} · ${lockFrequencyLabel(lockEditorDraft.frequencyKHz)} MHz · 待确认锁定`;
      options.set(lockEditorDraft.selection,{...lockEditorDraft,device:current,label,
        title:`${label}；${current && lockDeviceOnline(current) ? '点击确定锁定后生效' : '原通道离线或身份已变化，暂不能确认'}`});
    }
    // 只排序显示副本；lock:index 仍对应原约束行，选择、备注和取消不能跟随显示位置串台。
    const orderedOptions = [...options].map(([value,option],index) => {
      const position = global.DatyCoordination?.getDevicePlanningPosition(option.device || option.saved);
      return {value,option,index,group:position?.groupNumber ?? Infinity,channel:position?.channelNumber ?? Infinity};
    }).sort((a,b) => a.group-b.group || a.channel-b.channel || a.index-b.index);
    const signature = JSON.stringify(orderedOptions.map(({value,option}) => [value,option.label,option.title]));
    const previous = preferredSelection ?? select.value;
    if (signature !== lockPickerSignature) {
      select.innerHTML = '<option value="">选择在线 CH / 频点…</option>' + orderedOptions.map(({value,option}) => `<option value="${escapeHtml(value)}" title="${escapeHtml(option.title)}">${escapeHtml(option.label)}</option>`).join('');
      lockPickerSignature = signature;
    }
    lockPickerOptions = options;
    select.value = options.has(previous) ? previous : '';
    const chosen = options.get(select.value), isLock = chosen?.index !== undefined;
    const draft = lockEditorDraft?.selection === select.value ? lockEditorDraft : null;
    if (document.activeElement !== note || lockPickerSelection !== select.value) {
      note.value = draft ? draft.note : isLock && chosen.parts?.note !== '用户锁定' ? chosen.parts?.note || '' : '';
    }
    lockPickerSelection = select.value;
    note.disabled = isLock ? !chosen.parts : !draft;
    const confirm = document.getElementById('plannerConfirmLock');
    if (confirm) confirm.disabled = isLock ? !chosen.parts : !draft || !chosen.device || !lockDeviceOnline(chosen.device);
    document.getElementById('plannerRemoveLock').disabled = !isLock && !draft;
    const count = document.getElementById('plannerLockCount'); if (count) count.textContent = `（${rows.length} 个）`;
    select.title = chosen?.title || '只列出有有效频点的在线通道；已设置的离线锁定不会丢失。';
  }

  function commitLockEditor(lines, selection) {
    const field = document.getElementById('plannerLockedAssignments');
    field.value = lines.join('\n');
    lockEditorDraft = null;
    // 直接重建到当前编辑项，不短暂选中另一条锁定，也不触发服务器命令。
    refreshLockEditor(selection);
    onConstraintEdit();
  }

  function selectLockChannel() {
    const select = document.getElementById('plannerLockChannel'), chosen = lockPickerOptions.get(select.value);
    lockEditorDraft = null;
    if (!chosen || chosen.index !== undefined) { refreshLockEditor(); return; }
    const current = global.findPlanningDevice?.(chosen.saved);
    if (!current || !lockDeviceOnline(current)) {
      global.notify?.('⚠️','无法锁定','所选接收机通道已离线或身份已变化，请重新选择');
      refreshLockEditor(); return;
    }
    try {
      if (resolveConstraintDevice(chosen.token) !== current) throw new Error('接收机身份已变化，请重新选择');
      lockEditorDraft = {...chosen,selection:select.value,note:''};
      refreshLockEditor();
    } catch (error) { global.notify?.('⚠️','无法锁定',error.message); refreshLockEditor(); }
  }

  function editLockNote() {
    const selection = document.getElementById('plannerLockChannel').value, chosen = lockPickerOptions.get(selection);
    if (!chosen || (chosen.index !== undefined && !chosen.parts)) return;
    if (!lockEditorDraft || lockEditorDraft.selection !== selection) lockEditorDraft = {...chosen,selection};
    lockEditorDraft.note = document.getElementById('plannerLockNote').value;
  }

  function confirmSelectedLock() {
    const selection = document.getElementById('plannerLockChannel').value;
    const chosen = lockEditorDraft?.selection === selection ? lockEditorDraft : lockPickerOptions.get(selection);
    if (!chosen) return;
    try {
      const lines = String(document.getElementById('plannerLockedAssignments').value).split(/\r?\n/);
      const note = String(chosen.note ?? document.getElementById('plannerLockNote').value).replace(/\s+/g,' ').trim().slice(0,80);
      if (chosen.index !== undefined) {
        if (!chosen.parts) return;
        if (lines[chosen.index]?.trim() !== chosen.line) throw new Error('该锁定已变化，请重新选择后确认');
        const line = `${chosen.parts.token}=${chosen.parts.mhz}${note ? ' '+note : ''}`;
        if (line === lines[chosen.index].trim()) { lockEditorDraft = null; refreshLockEditor(); return; }
        lines[chosen.index] = line;
        commitLockEditor(lines,selection);
        return;
      }
      if (!lockEditorDraft) return;
      const current = global.findPlanningDevice?.(chosen.saved);
      if (!current || !lockDeviceOnline(current) || resolveConstraintDevice(chosen.token) !== current)
        throw new Error('所选接收机通道已离线或身份已变化，请重新选择');
      if (getDevices().filter(d => String(d.id) === String(current.id)).length !== 1)
        throw new Error('通道身份不唯一，请重新选择');
      if (getLockedFrequencyView().locks.has(String(current.id))) throw new Error('该通道已锁定，请重新选择');
      if (lines.length === 1 && !lines[0]) lines.pop();
      const nextSelection = `lock:${lines.length}`;
      restoredLockTargets.set(chosen.token.toLowerCase(), {...current});
      lines.push(`${chosen.token}=${DatyFrequency.formatFrequencyMHz(chosen.frequencyKHz)}${note ? ' '+note : ''}`);
      commitLockEditor(lines,nextSelection);
    } catch (error) { global.notify?.('⚠️','无法锁定',error.message); refreshLockEditor(); }
  }

  function removeSelectedLock() {
    const chosen = lockPickerOptions.get(document.getElementById('plannerLockChannel').value);
    if (chosen?.index === undefined) { lockEditorDraft = null; refreshLockEditor(''); return; }
    const lines = String(document.getElementById('plannerLockedAssignments').value).split(/\r?\n/);
    if (lines[chosen.index]?.trim() !== chosen.line || (lockEditorDraft?.index === chosen.index && lockEditorDraft.line !== chosen.line)) {
      lockEditorDraft = null;
      global.notify?.('⚠️','无法取消锁定','该锁定已变化，请重新选择后取消');
      refreshLockEditor(''); return;
    }
    lines.splice(chosen.index,1);
    if (chosen.parts && !lines.some(line => lockLineParts(line)?.token.toLowerCase() === chosen.parts.token.toLowerCase())) {
      restoredLockTargets.delete(chosen.parts.token.toLowerCase());
    }
    commitLockEditor(lines,'');
  }

  function onConstraintEdit(event) {
    const id = event?.target?.id;
    if (id === 'plannerRangeStart' || id === 'plannerRangeEnd') {
      const selector = document.getElementById('plannerRange');
      if (selector) selector.value = 'custom';
    }
    global.setPlanningSaveStatus('规划约束已修改，仅当前会话生效');
    invalidateCoordination('规划约束已修改，请重新规划以校验结果。');
    refreshLockEditor();
    updateConstraintFeedback();
    global.renderPagedDeviceTable?.();
    global.filterDevicesChannels?.();
    if (id === 'plannerRange' || id === 'plannerRangeStart' || id === 'plannerRangeEnd') syncFrequencyRange();
  }

  // 设备编辑器复用锁定备注；只更新已有唯一锁定，不创建锁定或改变频点。
  function createLockedUsageEditor(device) {
    const saved = {...device}, lock = getLockedFrequencyView().locks.get(String(device.id));
    const editable = !!lock && !lock.invalid;
    const displayNote = reason => ['用户锁定','手动指定频率'].includes(reason) ? '' : String(reason || '').trim();
    let value = editable ? displayNote(lock.reason) : '';
    const matchingRows = current => constraintLines(document.getElementById('plannerLockedAssignments').value).filter(({line}) => {
      const parts = lockLineParts(line);
      try { return parts && resolveConstraintDevice(parts.token) === current; } catch (_) { return false; }
    });
    let originalLine = editable ? matchingRows(device)[0]?.line : null;
    return {value, disabled:!editable, placeholder:editable ? '例如：鼓手、主唱' : '请先在频率规划中为该通道设置有效锁定',
      apply(input) {
        const note = String(input || '').replace(/\s+/g,' ').trim().slice(0,80);
        if (note === value) return false;
        const current = global.findPlanningDevice?.(saved);
        const rows = current ? matchingRows(current) : [];
        const currentLock = current && getLockedFrequencyView().locks.get(String(current.id));
        if (!editable || !currentLock || currentLock.invalid || rows.length !== 1 || rows[0].line !== originalLine)
          throw new Error('该通道或锁定备注已变化，请关闭后重新打开编辑');
        const lines = String(document.getElementById('plannerLockedAssignments').value).split(/\r?\n/);
        const {token,mhz} = lockLineParts(rows[0].line);
        lines[rows[0].index] = `${token}=${mhz}${note ? ' '+note : ''}`;
        commitLockEditor(lines,`lock:${rows[0].index}`);
        originalLine = lines[rows[0].index]; value = note;
        return true;
      }
    };
  }

  function setManualLock(id, value) {
    try {
      const device = getDevices().find(d => String(d.id) === String(id));
      if (!device) throw new Error('原通道已不存在');
      const frequencyKHz = DatyFrequency.toFrequencyKHz(value,'MHz');
      const token = String(device._fasheId || device.id);
      if (resolveConstraintDevice(token) !== device) throw new Error('通道身份不唯一');
      const lines = constraintLines(document.getElementById('plannerLockedAssignments').value).map(item=>item.line);
      const matches = lines.map((line,index)=>({line,index})).filter(({line})=>{
        const parts=lockLineParts(line); if(!parts)return false;
        try{return resolveConstraintDevice(parts.token)===device;}catch(_){return false;}
      });
      if(matches.length>1)throw new Error('请先取消重复锁定');
      const index=matches[0]?.index ?? lines.length, reason=matches.length ? lockLineParts(matches[0].line).note : '手动指定频率';
      restoredLockTargets.set(token.toLowerCase(),{...device});
      lines[index]=`${token}=${DatyFrequency.formatFrequencyMHz(frequencyKHz)} ${reason}`.trim();
      commitLockEditor(lines,`lock:${index}`);
      global.notify?.('📌','已设为人工锁定','请再次点击一键全局规划，通过联合校验后才能下发');
    } catch(error) { global.notify?.('❌','手动频率无效',error.message); invalidateCoordination(error.message); }
  }

  function readExtraSettings() {
    const number = (id,min,max,optional=false) => {
      const value=String(document.getElementById(id)?.value ?? FIELD_DEFAULTS[id]).trim();
      if(optional && !value)return undefined;
      const n=Number(value);
      if(!value || !Number.isFinite(n) || n<min || n>max || (id!=='plannerScanThresholdDbm' && !Number.isSafeInteger(n))) {
        const error=new Error(`${id==='plannerStepKHz'?'规划步进':id==='plannerMinSpacingKHz'?'最小通道间隔':id==='plannerImdSpacingKHz'?'最小 IMD 间距':'扫描占用阈值'}须为 ${min}～${max}${id==='plannerScanThresholdDbm'?' dBm':' 整数 kHz'}`);
        error.constraintFieldId=id;throw error;
      }
      return n;
    };
    const policy=document.getElementById('plannerImdPolicy')?.value ?? FIELD_DEFAULTS.plannerImdPolicy;
    if(!['third','third-fifth'].includes(policy))throw new Error('请选择有效 IMD 校验阶数');
    const settings={stepKHz:number('plannerStepKHz',1,1000),imdOrders:policy==='third-fifth'?[3,5]:[3],includeThreeTone:true};
    for(const [id,key,min,max]of [['plannerMinSpacingKHz','minChannelSpacingKHz',1,10000],['plannerImdSpacingKHz','minImdSpacingKHz',1,10000],['plannerScanThresholdDbm','scanThresholdDbm',-140,0]]){
      const v=number(id,min,max,true);if(v!==undefined)settings[key]=v;
    }
    return settings;
  }

  function parseKnownCarriers(value) {
    return constraintLines(value).map(({line,index}) => parseConstraintLine('固定占用',index,() => {
      const parts = line.replace(/，/g,',').split(',').map(item => item.trim());
      if (parts.length < 2 || !/^\d+$/.test(parts[1]) || !Number.isSafeInteger(Number(parts[1])) || Number(parts[1]) <= 0) throw new Error('保护间隔必须为正整数 kHz；格式为 MHz,保护kHz,原因');
      return {id:`carrier-${index + 1}`, frequencyKHz:DatyFrequency.toFrequencyKHz(parts[0], 'MHz'), guardKHz:Number(parts[1]), reason:parts.slice(2).join(',') || '用户固定占用'};
    }));
  }

  function parseBackupCount(value) {
    if (!/^[0-4]$/.test(String(value).trim())) throw new Error('备用频率数必须手填 0～4 的整数；0 表示不需要备用，不能留空');
    return Number(value);
  }

  function inspectConstraintFields() {
    const constraints = {}, errors = [];
    for (const [id,key,parse] of [
      ['plannerExcludedRanges','excludedRanges',parseExcludedRanges],
      ['plannerLockedAssignments','lockedAssignments',parseLockedAssignments],
      ['plannerKnownCarriers','knownCarriers',parseKnownCarriers],
      ['plannerBackupCount','backupCount',parseBackupCount],
    ]) {
      const field = document.getElementById(id);
      try { constraints[key] = parse(field?.value ?? FIELD_DEFAULTS[id]); }
      catch (error) { errors.push({fieldId:id,message:error.message || String(error)}); }
    }
    return {constraints,errors};
  }

  function constraintSummaryText(options) {
    return `排除 ${options.excludedRanges.length} · 锁定 ${options.lockedAssignments.length} · 占用 ${options.knownCarriers.length} · 备用 ${options.backupCount}/通道`;
  }

  function readCompatibilityLevel() {
    const value = document.getElementById('plannerCompatibility')?.value ?? 'standard';
    try { global.DatyEquipmentProfiles.getCompatibilityLabel(value); }
    catch (error) { error.constraintFieldId = 'plannerCompatibility'; throw error; }
    return value;
  }
  function compatibilitySummary(snapshot) {
    if (!snapshot?.devices?.length) return snapshot?.label || '尚无设备参数';
    const range = key => {
      const values = snapshot.devices.map(item => item[key]), low = Math.min(...values), high = Math.max(...values);
      return low === high ? String(low) : `${low}～${high}`;
    };
    const imd = snapshot.devices.every(item=>item.intermodSpacingKHz===0) ? '无' : range('intermodSpacingKHz')+' kHz';
    return `${snapshot.label} · 通道保护 ${range('channelSpacingKHz')} kHz · 互调保护 ${imd} · 扫描阈值 ${range('scanThresholdDbm')} dBm`;
  }
  function updateCompatibilityFeedback() {
    const hint = document.getElementById('plannerCompatibilityHint');
    if (!hint) return;
    try {
      const level = readCompatibilityLevel();
      const snapshot = global.DatyCoordination.describeCompatibility(getPlanningDevices(), {...readExtraSettings(),compatibilityLevel:level});
      hint.textContent = compatibilitySummary(snapshot) + (snapshot.devices.length ? '' : ' · 连接设备后显示有效参数');
      hint.title = hint.textContent + '。DATY 标准/保守/紧凑均250 kHz，默认互调保护250/150/无，扫描阈值-78/-75/-72 dBm。实际参数叠加各设备 Profile、硬件模式和人工加严；混合品牌保留参与者的保护要求。扫描达到阈值即避让；无真实扫描不判断现场占用。选择和规划结果仅用于当前会话，关闭页面后不保留。';
    } catch (error) { hint.textContent = error.message; hint.title = error.message; }
  }
  function updateConstraintFeedback(prefix = '待联合校验') {
    updateCompatibilityFeedback();
    const {constraints,errors} = inspectConstraintFields();
    for (const id of ['plannerExcludedRanges','plannerLockedAssignments','plannerKnownCarriers','plannerBackupCount']) {
      const field = document.getElementById(id), error = errors.find(item => item.fieldId === id);
      field?.setAttribute?.('aria-invalid', String(!!error));
      if (field) field.title = error?.message || document.getElementById(field.getAttribute?.('aria-describedby'))?.title || '';
    }
    document.getElementById('plannerLockChannel')?.setAttribute?.('aria-invalid',String(errors.some(item => item.fieldId === 'plannerLockedAssignments')));
    const summary = document.getElementById('plannerConstraintSummary');
    if (summary) {
      summary.textContent = errors.length ? `请检查：${errors.map(error => error.message).join('；')}` : `${prefix}：${constraintSummaryText(constraints)}`;
      summary.title = summary.textContent;
      summary.setAttribute?.('data-invalid', String(!!errors.length));
    }
    return {constraints,errors};
  }

  function readConstraintFields() {
    const {constraints,errors} = inspectConstraintFields();
    if (errors.length) {
      const error = new Error(errors.map(item => item.message).join('；'));
      error.constraintFieldId = errors[0].fieldId;
      throw error;
    }
    return constraints;
  }

  function focusConstraintError(error) {
    updateConstraintFeedback();
    if (!error.constraintFieldId) return;
    if (['plannerStepKHz','plannerMinSpacingKHz','plannerImdSpacingKHz','plannerScanThresholdDbm'].includes(error.constraintFieldId)) global.openPlannerSafetySettings();
    else switchPlannerControlTab(['plannerRangeStart','plannerRangeEnd','plannerRange','plannerCompatibility'].includes(error.constraintFieldId) ? 'basic' : 'constraints');
    document.getElementById(error.constraintFieldId === 'plannerLockedAssignments' ? 'plannerLockChannel' : error.constraintFieldId)?.focus?.();
  }

  function captureConstraintFields() {
    return Object.fromEntries(Object.entries(FIELD_DEFAULTS).map(([id, fallback]) => [id, document.getElementById(id)?.value ?? fallback]));
  }

  function restoreSnapshot(record) {
    global.DatyTextFileFactory?.cancelPending(global);
    lockEditorDraft = null;
    const constraints = {...record.options, ...record.constraints};
    const mhz = value => DatyFrequency.formatFrequencyMHz(Number(value));
    const fields = record.constraintFields || {
      plannerExcludedRanges:(constraints.excludedRanges || []).map(item => `${mhz(item.startKHz)}-${mhz(item.endKHz)} ${item.reason || ''}`.trim()).join('\n'),
      plannerLockedAssignments:(constraints.lockedAssignments || []).map(item => `${item.deviceId}=${mhz(item.frequencyKHz)} ${item.reason || ''}`.trim()).join('\n'),
      plannerKnownCarriers:(constraints.knownCarriers || []).map(item => `${mhz(item.frequencyKHz)},${item.guardKHz},${item.reason || ''}`).join('\n'),
      plannerBackupCount:String(constraints.backupCount ?? 1),
      plannerRangeStart:constraints.rangeStartKHz ? mhz(constraints.rangeStartKHz) : FIELD_DEFAULTS.plannerRangeStart,
      plannerRangeEnd:constraints.rangeEndKHz ? mhz(constraints.rangeEndKHz) : FIELD_DEFAULTS.plannerRangeEnd,
      plannerStepKHz:String(constraints.stepKHz ?? 25),
      plannerMinSpacingKHz:String(constraints.minChannelSpacingKHz ?? ''),
      plannerImdSpacingKHz:String(constraints.minImdSpacingKHz ?? ''),
      plannerImdPolicy:constraints.imdOrders?.includes(5)?'third-fifth':'third',
      plannerScanThresholdDbm:String(constraints.scanThresholdDbm ?? ''),
      plannerRange:constraints.rangeStartKHz && constraints.rangeEndKHz ? `${constraints.rangeStartKHz}:${constraints.rangeEndKHz}` : FIELD_DEFAULTS.plannerRange,
      plannerCompatibility:constraints.compatibilityLevel || 'standard'
    };
    // 只恢复规划字段，缺少字段时清空旧项目值，保留 backupCount=0。
    for (const [id, fallback] of Object.entries(FIELD_DEFAULTS)) {
      const element = document.getElementById(id);
      if (!element) continue;
      const value = String(fields[id] ?? (id === 'plannerCompatibility' ? constraints.compatibilityLevel : undefined) ?? fallback);
      if (id === 'plannerRange' && /^\d+:\d+$/.test(value) && !Array.from(element.options || []).some(item => item.value === value)) {
        const option = document.createElement('option'); option.value = value;
        option.textContent = value.split(':').map(mhz).join('–') + ' MHz（历史范围）'; element.appendChild(option);
      }
      element.value = value;
    }
    // 锁定目标采用历史接收机身份重新定位，浏览器本地数字 ID 可能变化。
    restoredLockTargets = new Map();
    if (constraints.lockedAssignments?.length && Array.isArray(record.devices)) {
      const lines = constraints.lockedAssignments.map(item => {
        const saved = record.devices.find(d => String(d.id) === String(item.deviceId));
        const current = saved && global.findPlanningDevice?.(saved);
        const token = current?._fasheId ?? current?.id ?? saved?._fasheId ?? item.deviceId;
        // 缺失历史身份时也禁止退回到碰巧同号的本地 ID。
        restoredLockTargets.set(String(token).toLowerCase(), saved || {_source:'unresolved-history'});
        return `${token}=${mhz(item.frequencyKHz)} ${item.reason || ''}`.trim();
      });
      const locked = document.getElementById('plannerLockedAssignments'); if (locked) locked.value = lines.join('\n');
    }
    constraintRevision++;
    lastCoordination = null;
    global.DatyPlanningDeployment?.invalidate('已恢复项目，请重新规划后下发');
    global.DATY_LAST_COORDINATION = null;
    showPlannerMessage('已恢复项目约束，请重新规划以校验当前设备与扫描数据。');
    global.DatyAutoFrequency?.invalidate();
    syncFrequencyRange(false);
    global.setPlanningSaveStatus('已恢复项目约束');
    global.renderFreqTable?.(getDevices().some(device => device.planned > 0));
    refreshLockEditor(`lock:${constraintLines(document.getElementById('plannerLockedAssignments')?.value)[0]?.index}`);
    updateConstraintFeedback();
    global.renderPagedDeviceTable?.();
    global.filterDevicesChannels?.();
  }

  async function saveCurrentPlanningConstraints() {
    const button = document.getElementById('savePlannerConstraints');
    if (button?.disabled) return;
    if (button) {button.disabled = true;button.setAttribute?.('aria-busy','true');}
    try {
      // 仅保存约束无需先运行算法或导入扫描；锁定目标仍须唯一匹配。
      const constraints = readConstraintFields();
      const fields = captureConstraintFields();
      const options = {...constraints,...readExtraSettings(), compatibilityLevel:readCompatibilityLevel()};
      if (/^\d+:\d+$/.test(fields.plannerRange)) [options.rangeStartKHz, options.rangeEndKHz] = fields.plannerRange.split(':').map(Number);
      else if(fields.plannerRange==='custom')Object.assign(options,readCustomRange());
      if(global.DatyDataRetention?.history===false){global.setPlanningSaveStatus('规划约束已应用到当前会话');global.notify?.('✓','约束已应用','关闭页面后不保留');return true;}
      const record = global.savePlanningResult(getDevices(), null, options, fields);
      const status = global.setPlanningSaveStatus('已保存到本机规划历史，正在同步服务器…');
      try {
        await global.persistPlanningProject(record);
        global.setPlanningSaveStatus('已保存到当前项目及规划历史', status);
        global.notify?.('💾', '规划约束已保存', '可在数据管理 → 规划历史中加载、恢复和导出');
        return true;
      } catch (error) {
        global.setPlanningSaveStatus('服务器未同步：'+(error.message || '本机历史已保留'), status);
        global.notify?.('⚠️', '服务器未同步', error.message || String(error));
        return false;
      }
    } catch (error) {
      global.setPlanningSaveStatus('未保存，请检查约束格式或本地存储');
      global.notify?.('❌', '约束保存失败', error.message || String(error));
      focusConstraintError(error);
      return false;
    } finally { if (button) {button.disabled = false;button.removeAttribute?.('aria-busy');} }
  }

  async function initializeConstraintFields() {
    const current = global.getCurrentPlanningRecord?.();
    if (current) restoreSnapshot(current);
    else {
      // 迁移旧全局草稿：它不是已保存的项目或规划历史。
      try {
        const storage = global.DatyPlatform === undefined ? localStorage : global.DatyPlatform.storage;
        const fields = storage.getItem('daty_planning_history_v1') ? null : JSON.parse(storage.getItem(CONSTRAINT_STORAGE_KEY) || 'null');
        if (fields) restoreSnapshot({constraintFields:fields});
      } catch (_) { /* 损坏草稿不影响项目加载 */ }
    }
    for (const id of Object.keys(FIELD_DEFAULTS)) {
      document.getElementById(id)?.addEventListener('input', onConstraintEdit);
      document.getElementById(id)?.addEventListener('change', onConstraintEdit);
    }
    document.getElementById('plannerLockChannel')?.addEventListener('change',selectLockChannel);
    document.getElementById('plannerLockNote')?.addEventListener('input',editLockNote);
    document.getElementById('plannerConfirmLock')?.addEventListener('click',confirmSelectedLock);
    document.getElementById('plannerRemoveLock')?.addEventListener('click',removeSelectedLock);
    refreshLockEditor();
    updateConstraintFeedback();
    global.renderPagedDeviceTable?.();
    global.filterDevicesChannels?.();
    // 已恢复项目的有效规划范围优先；无项目时使用当前预设，不保留两套互相矛盾的范围。
    syncFrequencyRange(false);
    if (current) global.setPlanningSaveStatus('已恢复当前项目的已保存约束');
    else if (global.restorePlanningProjectFromServer) {
      const revision = constraintRevision;
      await global.restorePlanningProjectFromServer(() => constraintRevision === revision);
    }
  }

  function readPlanningRange() {
    const rangeValue = document.getElementById('plannerRange')?.value || '614250:638000';
    let [rangeStartKHz, rangeEndKHz] = rangeValue.split(':').map(Number);
    if(rangeValue==='custom')({rangeStartKHz,rangeEndKHz}=readCustomRange());
    const scanPoints = typeof getCurrentScanPoints === 'function' ? getCurrentScanPoints() : [];
    if (rangeValue === 'scan' && scanPoints.length >= 2) {
      rangeStartKHz = scanPoints[0].frequencyKHz;
      rangeEndKHz = scanPoints[scanPoints.length - 1].frequencyKHz;
    }
    if (!Number.isInteger(rangeStartKHz) || !Number.isInteger(rangeEndKHz)) {
      throw new Error('请选择有效规划范围；“按导入扫描范围”需要先导入 CSV');
    }
    if (rangeStartKHz >= rangeEndKHz) throw new Error('规划范围起点必须小于终点');
    return {rangeStartKHz, rangeEndKHz};
  }

  // 页面适配层共用整数 kHz 范围；不引入新的存储、控制通道或自动规划。
  function syncFrequencyRange(persist = true) {
    const selector = document.getElementById('plannerRange');
    if (!selector) return;
    const custom = selector.value === 'custom';
    let range;
    try { range = readPlanningRange(); } catch (_) { /* 未完成输入保持为无效草稿 */ }
    selector.setAttribute?.('aria-invalid', String(!range));
    for (const [plannerId, key] of [
      ['plannerRangeStart','rangeStartKHz'], ['plannerRangeEnd','rangeEndKHz']
    ]) {
      const field = document.getElementById(plannerId);
      if (!custom && field) field.value = range ? DatyFrequency.formatFrequencyMHz(range[key]) : '';
      field?.setAttribute?.('aria-invalid', String(!range));
    }
    // 规划是唯一范围来源；两侧留白仅属于频谱视图，不能回写算法/约束。
    global.applyPlanningSpectrumRange?.(range, persist);
  }

  function getOptions() {
    const {rangeStartKHz, rangeEndKHz} = readPlanningRange();
    const compatibilityLevel=readCompatibilityLevel();
    const scanPoints = typeof getCurrentScanPoints === 'function' ? getCurrentScanPoints() : [];
    const constraints = readConstraintFields();
    return {
      rangeStartKHz,
      rangeEndKHz,
      ...readExtraSettings(),
      compatibilityLevel,
      minimumFrequencyCount:0,
      frequencyDistribution:'spread-range',
      scanPoints,
      ...constraints,
      solver: 'global',
      preserveCurrent: true,
      allocationOrder: 'receiver-group-ascending',
    };
  }

  function readCustomRange() {
    try {
      const rangeStartKHz=DatyFrequency.toFrequencyKHz(document.getElementById('plannerRangeStart')?.value,'MHz');
      const rangeEndKHz=DatyFrequency.toFrequencyKHz(document.getElementById('plannerRangeEnd')?.value,'MHz');
      if(rangeStartKHz>=rangeEndKHz)throw new Error('自定义范围起点必须小于终点');
      return {rangeStartKHz,rangeEndKHz};
    }catch(error){error.constraintFieldId='plannerRangeStart';throw error;}
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }

  function switchPlannerControlTab(name) {
    if (name !== 'basic' && name !== 'constraints') return;
    for (const [key, tabId, paneId] of [['basic','plannerBasicTab','plannerBasics'], ['constraints','plannerConstraintsTab','plannerConstraints']]) {
      const active = key === name;
      const tab = document.getElementById(tabId), pane = document.getElementById(paneId);
      if (tab) {
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
      }
      if (pane) pane.hidden = !active;
    }
    if (name === 'constraints') refreshLockEditor();
  }

  function setPlannerDetails(html) {
    plannerDetailHtml = html;
    const detail = document.getElementById('plannerDetailContent');
    if (detail) detail.innerHTML = html;
  }

  function showPlannerMessage(reason) {
    const container = document.getElementById('planResultContent');
    if (container) container.textContent = reason.length > 160 ? reason.slice(0,160) + '…（完整原因请打开详情 / 限制）' : reason;
    setPlannerDetails(`<p>${escapeHtml(reason)}</p>`);
  }

  const PLANNER_SAFETY_FIELDS=Object.freeze([
    {id:'plannerStepKHz',label:'全局搜索步进 kHz',type:'number',min:1,max:1000,step:1},
    {id:'plannerMinSpacingKHz',label:'最小通道间隔 kHz',type:'number',min:1,max:10000,step:1,optional:true},
    {id:'plannerImdSpacingKHz',label:'最小 IMD 间距 kHz',type:'number',min:1,max:10000,step:1,optional:true},
    {id:'plannerScanThresholdDbm',label:'扫描占用阈值 dBm',type:'number',min:-140,max:0,step:1,optional:true},
    {id:'plannerImdPolicy',label:'IMD 联合校验',type:'select',options:[{value:'third',label:'三阶双频＋三频（标准）'},{value:'third-fifth',label:'三阶双频＋三频＋五阶双频（加严）'}]}
  ]);
  function plannerDetailsText(html) {
    // Only the existing trusted detail template is converted; escaped user text stays literal.
    return String(html).replace(/<br\s*\/?\s*>/gi,'\n').replace(/<li\b[^>]*>/gi,'• ')
      .replace(/<\/(?:p|li|ul|div)>/gi,'\n').replace(/<[^>]*>/g,'')
      .replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[key]))
      .replace(/\n{3,}/g,'\n\n').trim();
  }
  function getPlannerWindowModel(kind) {
    if(kind==='details')return {kind,title:'规划详情与限制',text:plannerDetailsText(plannerDetailHtml || '<p>尚无有效规划结果。请先连接设备、设置规划范围，再点击「一键全局规划」。</p>')};
    if(kind!=='safety')throw new TypeError('未知规划窗口');
    const fields=captureConstraintFields();
    return {kind,title:'自定义安全参数',liveEdit:true,
      description:'输入实时参与下一次全局规划。留空采用设备 Profile；间隔取较大值、阈值取较低值，只加严，不降低安全要求。无真实扫描时不能判断现场干扰。',
      footnote:'输入实时保留，关闭窗口不撤销修改；仍需重新规划及下发前校验。',
      fields:PLANNER_SAFETY_FIELDS.map(field=>({...field,value:String(fields[field.id])}))};
  }
  let plannerWindowSession=null;
  function closePlannerWindow(kind) {
    if(plannerWindowSession && (!kind || plannerWindowSession.kind===kind))plannerWindowSession.close();
  }
  async function openPlannerWindow(kind) {
    try {
      if(plannerWindowSession){
        if(plannerWindowSession.dialog && !plannerWindowSession.dialog.open)plannerWindowSession.close();
        else return false;
      }
      const platform=global.DatyPlatform,port=global.DatyPlannerViews;
      if(port!==undefined || (platform!==undefined && platform?.kind!=='browser')) {
        if(!port || port.VERSION!=='daty-planner-views-v1' || typeof port.open!=='function')throw new Error('当前客户端未提供规划窗口，请完善原生界面接口');
        const controller=new AbortController(),ticket={kind,close:()=>controller.abort()};
        let abort;const cancelled=new Promise(resolve=>{abort=()=>resolve({status:'closed'});controller.signal.addEventListener('abort',abort,{once:true});});
        const expected=()=>JSON.stringify(captureConstraintFields());let before=expected();
        const onEdit=change=>{
          if(kind!=='safety' || controller.signal.aborted || plannerWindowSession!==ticket || global.DatyPlatform!==platform || global.DatyPlannerViews!==port)
            return {accepted:false,message:'窗口已关闭或客户端已切换'};
          if(expected()!==before)return {accepted:false,message:'规划输入已变化，请关闭后重新打开安全参数'};
          if(!change || !PLANNER_SAFETY_FIELDS.some(field=>field.id===change.id) || typeof change.value!=='string' || change.value.length>128)
            return {accepted:false,message:'安全参数字段或内容无效'};
          const field=document.getElementById(change.id);if(!field)return {accepted:false,message:'安全参数尚未就绪'};
          field.value=change.value;onConstraintEdit({target:field});before=expected();
          // Match live browser editing, including temporarily incomplete numeric drafts.
          let error='';try{readExtraSettings();}catch(e){error=e.message;}
          return {accepted:true,value:field.value,validationMessage:error};
        };
        plannerWindowSession=ticket;global.addEventListener?.('pagehide',ticket.close,{once:true});
        try {
          const operation=port.open(getPlannerWindowModel(kind),{signal:controller.signal,onEdit});
          if(!operation || typeof operation.then!=='function')throw new TypeError('规划窗口接口必须返回 Promise');
          const result=await Promise.race([operation,cancelled]);
          if(controller.signal.aborted || global.DatyPlatform!==platform || global.DatyPlannerViews!==port)return false;
          if(result?.status!=='closed')throw new TypeError('规划窗口返回了未知状态');
          return true;
        } finally {
          controller.abort();global.removeEventListener?.('pagehide',ticket.close);
          controller.signal.removeEventListener('abort',abort);if(plannerWindowSession===ticket)plannerWindowSession=null;
        }
      }
      const dialog=document.getElementById(kind==='details'?'plannerResultDialog':'plannerSafetyDialog');
      if(!dialog)throw new Error('规划窗口未加载，请刷新页面');
      if(document.querySelector?.('dialog[open]'))return false;
      const opener=document.activeElement;let finished=false;
      const focusables=()=>[...(dialog.querySelectorAll?.('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]') || [])].filter(el=>el.getClientRects().length);
      const restore=()=>{if(opener?.isConnected && !opener.disabled && (!document.activeElement || document.activeElement===document.body))opener.focus({preventScroll:true});};
      const finish=()=>{
        if(finished)return;finished=true;if(dialog.open)dialog.close();
        dialog.removeEventListener?.('close',finish);dialog.removeEventListener?.('cancel',cancel);dialog.removeEventListener?.('keydown',key);
        global.removeEventListener?.('pagehide',finish);if(plannerWindowSession===ticket)plannerWindowSession=null;restore();global.queueMicrotask?.(restore);
      };
      const cancel=event=>{event.preventDefault();finish();};
      const key=event=>{
        if(event.key!=='Tab')return;const items=focusables(),index=items.indexOf(document.activeElement);
        if(index<0 || (event.shiftKey&&index===0) || (!event.shiftKey&&index===items.length-1)){event.preventDefault();items[event.shiftKey?items.length-1:0]?.focus();}
      };
      const ticket={kind,dialog,close:finish};plannerWindowSession=ticket;
      dialog.addEventListener('close',finish);dialog.addEventListener('cancel',cancel);dialog.addEventListener('keydown',key);global.addEventListener?.('pagehide',finish,{once:true});
      try{dialog.showModal();focusables()[0]?.focus({preventScroll:true});}catch(error){finish();throw error;}
      return true;
    } catch(error){global.notify?.('❌','规划窗口打开失败',error.message || String(error));return false;}
  }

  function openPlannerResultDetails() {
    const dialog = document.getElementById('plannerResultDialog');
    if (!plannerDetailHtml) setPlannerDetails('<p>尚无有效规划结果。请先连接设备、设置规划范围，再点击「一键全局规划」。</p>');
    return openPlannerWindow('details');
  }

  function initializePlannerLayout() {
    switchPlannerControlTab('basic');
    for (const id of ['plannerBasicTab','plannerConstraintsTab']) {
      document.getElementById(id)?.addEventListener('keydown', event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault();
        const basic = event.key === 'Home' || (event.key !== 'End' && id !== 'plannerBasicTab');
        switchPlannerControlTab(basic ? 'basic' : 'constraints');
        document.getElementById(basic ? 'plannerBasicTab' : 'plannerConstraintsTab')?.focus();
      });
    }
    const viewport = document.getElementById('plannerTableViewport');
    if (viewport && typeof global.ResizeObserver === 'function') {
      const observer = new global.ResizeObserver(() => global.refreshPlannerTableLayout?.());
      observer.observe(viewport);
    } else if (viewport) global.addEventListener?.('resize', () => global.refreshPlannerTableLayout?.());
  }

  function calculateCrossBrandIMD(devices) {
    const options = getOptions();
    const frequencies = new Map(devices.filter(device => device.planned > 0).map(device => [device.id, device.planned]));
    const analysis = DatyCoordination.analyzeFrequencyPlan(devices, frequencies, options);
    return {...analysis, minMargin: analysis.minImdMarginKHz, totalCombinations: analysis.totalPairs};
  }

  function invalidateCoordination(reason = '规划输入已变化，请重新规划') {
    global.DatyTextFileFactory?.cancelPending(global);
    constraintRevision++;
    global.DatyAutoFrequency?.invalidate();
    lastCoordination = null;
    global.DATY_LAST_COORDINATION = null;
    global.DatyPlanningDeployment?.invalidate(reason);
    for (const device of getDevices()) device.planned = 0;
    showPlannerMessage(reason);
    global.renderFreqTable?.(true);
  }

  function renderResult(result, elapsedMs, options) {
    const container = document.getElementById('planResultContent');
    if (!container) return;
    const frequencies = result.assignments.map(item => item.frequencyKHz).sort((a,b)=>a-b);
    const minFreq = frequencies.length ? DatyFrequency.formatFrequencyMHz(frequencies[0]) : '—';
    const maxFreq = frequencies.length ? DatyFrequency.formatFrequencyMHz(frequencies[frequencies.length-1]) : '—';
    const minChannel = result.analysis.minChannelSpacingKHz;
    const minImd = result.analysis.minImdMarginKHz;
    const errors = result.errors.length ? `<div class="planner-detail-errors">${result.errors.map(escapeHtml).join('<br>')}</div>` : '';
    const warnings = result.warnings || [];
    const noImd = result.compatibility?.devices?.length > 0 && result.compatibility.devices.every(item=>item.intermodSpacingKHz===0);
    const pool=result.frequencyPool;
    const poolSummary=pool?`紧凑目标至少 ${pool.targetCount} 个频点 · 实际通道 ${pool.actualCount} 个 + 预留 ${pool.reservedFrequenciesKHz.length} 个 = 已规划 ${pool.plannedCount} 个${pool.complete?'':' · 未达标，缺少 '+pool.shortfall+' 个'}`:'';
    const reserveText=pool?.reservedFrequenciesKHz.map(value=>DatyFrequency.formatFrequencyMHz(value)+' MHz').join('、')||'';
    container.innerHTML = `
      <div class="planner-metrics">
        <div class="planner-metric"><strong class="metric-ok">${result.assignments.length}</strong><span>已规划通道</span></div>
        <div class="planner-metric"><strong class="${result.analysis.conflicts.length?'metric-error':'metric-ok'}">${result.analysis.conflicts.length}</strong><span>确定性冲突</span></div>
        <div class="planner-metric"><strong>${minChannel === null ? 'N/A' : minChannel+' kHz'}</strong><span>结果实际最小间隔</span></div>
        <div class="planner-metric"><strong>${minImd === null ? 'N/A' : minImd+' kHz'}</strong><span>最小 IMD 净裕量</span></div>
      </div>
      <div class="planner-retention">保留原频 ${result.retention.retainedCount} 个 · 建议调整 ${result.retention.changedCount} 个 · 未分配 ${result.unassignedDeviceIds.length} 个</div>
      <div class="planner-result-note">${minFreq}–${maxFreq} MHz · ${result.distribution?.enabled?'按实际通道分布于设定范围 · ':''}${result.options.stepKHz} kHz 全局栅格 ∩ 各品牌栅格</div>
      <div class="planner-result-note planner-applied-constraints">人工约束：${constraintSummaryText(options)}</div>
      <div class="planner-result-note">${escapeHtml(compatibilitySummary(result.compatibility))}</div>
      ${pool?`<div class="planner-result-note" title="预留频点未绑定接收机，不参与全部下发；完整频点见详情或导出。">${escapeHtml(poolSummary)}</div>`:''}
      <div class="planner-result-note">${options.scanPoints.length ? '已校核真实扫描；Profile 与部署限制请查详情。' : '未导入真实扫描：仅校核设备与所选数学约束。'}${noImd ? '本次无互调保护。' : ''}</div>
      <div class="planner-result-notice ${result.errors.length?'has-errors':''}">${result.errors.length ? `方案未完整通过 · ${result.errors.length} 项错误` : '部署前须通过 Profile 与硬件频段预检'}${warnings.length ? ` · ${warnings.length} 项提示` : ''}，见「详情 / 限制」。</div>`;
    setPlannerDetails(`
      <p>所有计算均使用整数 kHz，结果可重复。IMD 净裕量 = 频率距离 − 要求间距。</p>
      ${result.distribution?.enabled?`<p>按本次 ${result.distribution.targetCount} 个实际通道，在设定的 ${DatyFrequency.formatFrequencyMHz(result.options.rangeStartKHz)}–${DatyFrequency.formatFrequencyMHz(result.options.rangeEndKHz)} MHz 内分散规划，优先接近均匀分布；实际频点仍服从栅格、锁频、硬件频段、扫描与所选互调保护，不强行等间距。锁频作为固定锚点；不自动补足25个预留频点。</p>`:''}
      ${pool?`<p>${escapeHtml(poolSummary)}。按所有本次设备 Profile 的共同可用范围及当前约束计算，预留与主频、备用共同校核；结果是本次找到的数量，不宣称频段最大容量。</p><p>预留频点（未绑定设备）：${escapeHtml(reserveText||'无')}。新接收机接入后须重新规划，预留不会自动下发。</p>`:''}
      <p>DATYaudio 最小间隔 250 kHz，候选频点为 250 kHz 的整数倍。IMD 冲突会跳过候选，并非最终频率全部连续等距。多品牌任意两通道取各自间隔的较大值；互调保护距离取来源与受影响通道中较大值，统一联合求解。</p>
      <ul>${result.assignments.map(a=>`<li>${escapeHtml(a.brand)} · ${escapeHtml(getDevices().find(d=>d.id===a.deviceId)?.ch || a.deviceId)}：${DatyFrequency.formatFrequencyMHz(a.frequencyKHz)} MHz；栅格交集步进 ${a.candidateStepKHz} kHz；采用通道间隔 ${a.channelSpacingKHz} kHz / IMD 保护 ${a.intermodSpacingKHz===0?'无':a.intermodSpacingKHz+' kHz'}</li>`).join('')}</ul>
      <p>本次直接读取全部当前人工输入（不要求先保存）：${constraintSummaryText(options)}。排除区、锁定和固定占用联合生效，优先于自动保留原频；不能覆盖 Profile 频段、调谐栅格、扫描与 IMD 安全限制，冲突时不静默忽略。备用仅为未锁定通道寻找，不足会提示，不会降低安全标准。</p>
      <p>保留原频 ${result.retention.retainedCount} 个 · 建议调整 ${result.retention.changedCount} 个 · 未分配 ${result.unassignedDeviceIds.length} 个。${result.allocationOrder?.enabled ? '按真实 GROUP 数字升序、同组 CH 升序从低频向高频规划；未知编组置后。原频不再优先保留，锁定频率不变；升序与锁定或设备约束冲突时，明确返回未完成方案。' : '先保护通过校验的原频率，仅重规划其余通道；规划范围、锁定、Profile 和扫描约束仍然有效。'}</p>
      <p>使用频段 ${minFreq}–${maxFreq} MHz<br>${escapeHtml(result.options.compatibilityLevel)} 配置 · ${result.options.stepKHz} kHz 栅格 · 全局搜索 ${result.search.nodes} 节点 · ${elapsedMs.toFixed(1)} ms<br>排除区 ${options.excludedRanges.length} · 锁定 ${options.lockedAssignments.length} · 固定占用 ${options.knownCarriers.length}</p>
      <p>${options.scanPoints.length ? '已检查真实扫描保护窗口峰值、覆盖范围与采样缺口。' : '未导入真实扫描，本次仅按设备与所选数学约束计算。'}<br>${noImd ? '本次全部通道互调保护为无，不执行 IMD 避让；互调裕量不适用。' : `${result.options.imdOrders.includes(5)?'三阶/五阶双频':'三阶双频'} + 三阶三频互调（与各 Profile 要求合并）；不预测产物功率，不等同 WWB6 厂商认证结果。`}</p>
      <p>${result.assignments.length && !result.errors.length && result.assignments.every(item=>item.deploymentEligible) ? '所有 Profile 与硬件频段已标记验证，可进入下发预检。' : '结果仅供规划；未验证 Profile/频段或不完整方案不能开放跨品牌批量下发。'}</p>
      ${warnings.length ? `<ul>${warnings.map(item=>`<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}${errors}`);
  }

  function runPlanning() {
    if(global.DatyPlanningDeployment?.isBusy()){global.notify?.('⚠️','正在下发','请等待当前 ACK 或停止后续队列，再重新规划');return;}
    global.DatyTextFileFactory?.cancelPending(global);
    const devices = getPlanningDevices();
    if (!devices.length) { invalidateCoordination('没有设备，旧规划已失效'); global.notify?.('⚠️','无法规划','请先接收或导入设备'); return; }
    try {
      // 旧浏览器缓存可能携带批量 SSE 曾生成的重复本地 ID，先按稳定通道身份修复。
      global.repairRealtimeDeviceIds?.(devices);
      global.notify?.('⚡','规划中...','正在执行确定性设备配置、频谱和 IMD 约束计算');
      const started = performance.now();
      const options = getOptions();
      let databaseInputSources = null;
      try { databaseInputSources = global.DatyUnifiedProjectSyncFactory?.captureRunSources(global.DatyBusinessDatabase?.appliedSources?.()); } catch (_) { /* Evidence unavailable: never infer it from later current data. */ }
      const result = DatyCoordination.coordinateFrequencies(devices, options);
      global.DatyUnifiedProjectSyncFactory?.rememberRunSources(result, databaseInputSources);
      updateConstraintFeedback(result.errors.length ? '已联合校验，方案未完整通过' : '已叠加到本次规划');
      // 上一次成功规划的旧值不能伪装成本次结果；未分配设备明确保持 0。
      for (const device of getDevices()) device.planned = 0;
      for (const assignment of result.assignments) {
        const device = devices.find(item => item.id === assignment.deviceId);
        if (device) { device.planned = assignment.frequencyKHz; device.equipmentProfileId = assignment.profileId; }
      }
      lastCoordination = result;
      global.DATY_LAST_COORDINATION = result;
      global.DatyPlanningDeployment?.setPlan(result,devices,options,captureConstraintFields());
      global.resetPlannerTablePage?.();
      global.renderFreqTable?.(true);
      global.saveDataToStorage?.();
      renderResult(result, performance.now() - started, options);
      global.DatyAutoFrequency?.invalidate();
      global.setPlanningSaveStatus('规划已完成，仅用于当前会话');
      if (result.errors.length) global.notify?.('⚠️','部分规划完成',`${result.assignments.length}/${devices.length} 个通道满足当前数学约束，完整方案仍未通过`);
      else global.notify?.('✓','规划完成',`保留原频 ${result.retention.retainedCount} 个，建议调整 ${result.retention.changedCount} 个，0 个约束冲突`);
    } catch (error) {
      console.error('[Coordination]', error);
      invalidateCoordination('本次规划失败，旧结果已失效：' + (error.message || String(error)));
      global.notify?.('❌','规划失败',error.message || String(error));
      focusConstraintError(error);
    }
  }

  async function importScanCsv(label) {
    try {
      if (!global.DatyTextFileFactory) throw new Error('文件导入组件未加载，请刷新页面');
      const pending = global.DatyTextFileFactory.openLatest(global, {accept:'.csv,.txt,text/csv', maxBytes:16 * 1024 * 1024});
      if (/WWB/i.test(label)) global.notify?.('ℹ️','WWB 数据导入','请选择从 Wireless Workbench 导出的频谱 CSV；不解析私有 Show 文件');
      const file = await pending;
      if (file.status === 'cancelled' || !file.isCurrent()) return false;
      if (global.DatyPlanningDeployment?.isBusy()) throw new Error('正在下发，请等待当前 ACK 或停止后续队列后再导入');
      const result = DatyScanCsv.parseScanCsv(file.text);
      const scope=()=>JSON.stringify([global.getCurrentPlanningProject?.().id,global.DatyDatabaseConnection?.snapshot?.().origin,
        global.DatyDatabaseConnection?.snapshot?.().revision,global.DatyDatabaseConnection?.snapshot?.().status?.epoch]);
      const captured=scope(),database=global.DatyBusinessDatabase,dialogs=global.DatyDialogs;
      if(typeof dialogs?.confirm!=='function')throw Error('导入确认组件未就绪');
      const status=document.getElementById('scanImportStatus');
      if(status)status.textContent='已解析 '+file.name+'，等待确认；当前扫描保持不变';
      const accepted=await dialogs.confirm({title:'预览扫描数据',eyebrow:'DATY RF PRO · 数据导入',symbol:'↓',
        message:'核对扫描范围与单位。确认后将本次扫描用于当前会话。关闭页面后不保留。',confirmLabel:'确认使用',cancelLabel:'取消',
        details:[{label:'原始文件',value:file.name},{label:'有效频点',value:result.points.length+' 点'},
          {label:'频率范围',value:(result.points[0].frequencyKHz/1000).toFixed(3)+'–'+(result.points.at(-1).frequencyKHz/1000).toFixed(3)+' MHz'},
          {label:'频率 / 电平单位',value:(result.frequencyUnit==='auto'?'按单元格标注':result.frequencyUnit)+' / dBm；保存为整数 kHz'},
          {label:'重复频点',value:result.duplicateRows+' 行，取最大电平'},
          {label:'来源',value:label+' · 文件导入，保留原文与校验摘要'}],footnote:'导入不会调频或下发；需使用新扫描重新规划。'});
      if(accepted!==true||!file.isCurrent()){if(status&&file.isCurrent())status.textContent='已取消导入，当前扫描保持不变';return false;}
      if(scope()!==captured||global.DatyBusinessDatabase!==database||global.DatyDialogs!==dialogs)throw Error('项目或服务器已变化，请重新选择文件');
      if(global.DatyPlanningDeployment?.isBusy())throw Error('正在下发，请等待当前 ACK 后再导入');
      if(status)status.textContent='正在应用 '+file.name+' 到当前会话…';
      if (global.DatyBusinessDatabase) {
        if (!await global.DatyBusinessDatabase.saveImportedScan(file)) {if(status)status.textContent='扫描尚未生效，请重试';return false;}
      } else setImportedScanPoints(result.points, file.name);
      if(scope()!==captured)return false;
      if(status)status.textContent=file.name+' · '+result.points.length+' 点 · 已在当前会话使用，关闭页面后不保留';
      const range = document.getElementById('plannerRange'); if (range) range.value = 'scan';
      syncFrequencyRange();
      global.notify?.('✓','真实扫描已导入',`${result.points.length} 点，${result.duplicateRows} 个重复点取最大电平；单位 kHz/dBm，无效行会拒绝导入`);
      return true;
    } catch (error) {
      if (typeof error?.isCurrent === 'function' && !error.isCurrent()) return false;
      const status=document.getElementById('scanImportStatus');if(status)status.textContent='导入失败：'+(error.message||String(error));
      global.notify?.('❌','扫描导入失败',error.message || String(error));
      return false;
    }
  }

  function importFile(type) { return importScanCsv(type); }
  function importScan(type) { return importScanCsv(type); }

  async function importEquipmentProfile() {
    try {
      if (!global.DatyTextFileFactory) throw new Error('文件导入组件未加载，请刷新页面');
      const file = await global.DatyTextFileFactory.openLatest(global, {accept:'.json,application/json', maxBytes:8 * 1024 * 1024});
      if (file.status === 'cancelled' || !file.isCurrent()) return false;
      if (global.DatyPlanningDeployment?.isBusy()) throw new Error('正在下发，请等待当前 ACK 或停止后续队列后再导入');
      const parsed=JSON.parse(file.text); const imported=Array.isArray(parsed)?parsed:(Array.isArray(parsed?.profiles)?parsed.profiles:[parsed]);
      if(!imported.length)throw new Error('文件中没有 Profile');
      const seen=new Set();
      for(const profile of imported){
        const errors=DatyEquipmentProfiles.validateEquipmentProfile({...profile,source:'custom'});
        if(errors.length)throw new Error(errors.join('；'));
        if(seen.has(profile.id))throw new Error(`重复 Profile ID: ${profile.id}`);
        if(DatyEquipmentProfiles.BUILT_IN_EQUIPMENT_PROFILES.some(item=>item.id===profile.id))throw new Error('自定义 Profile 不得覆盖内置 ID，请使用独立 ID');
        seen.add(profile.id);
      }
      const dialogs=global.DatyDialogs,platform=global.DatyPlatform,storage=platform===undefined?global.localStorage:platform.storage;
      const key=DatyEquipmentProfiles.STORAGE_KEY,before=storage.getItem(key);
      if(typeof dialogs?.confirm!=='function')throw new Error('应用内确认组件未加载，请刷新页面');
      const decision=dialogs.confirm({title:'导入 Equipment Profile',eyebrow:'DATY RF PRO · 频率规划',symbol:'↓',
        message:'核对文件中的设备配置后导入。',confirmLabel:'确认导入',cancelLabel:'取消',
        details:[{label:'文件名称',value:file.name},{label:'配置数量',value:imported.length+' 个'},
          {label:'制造商',value:[...new Set(imported.map(item=>item.manufacturer))].join('、')}],
        warnings:['相同自定义 ID 将按文件内容更新；内置 Profile 不会被覆盖。'],footnote:'导入后须重新规划，频段和下发能力仍按原规则校验'});
      if(!decision || typeof decision.then!=='function')throw new TypeError('Profile 确认接口必须返回 Promise<boolean>');
      if(await decision!==true || !file.isCurrent())return false;
      if(global.DatyDialogs!==dialogs || global.DatyPlatform!==platform || (platform===undefined?global.localStorage:platform.storage)!==storage || storage.getItem(key)!==before)throw new Error('Profile 或保存环境已变化，请重新选择文件');
      if(global.DatyPlanningDeployment?.isBusy())throw new Error('正在下发，请等待当前 ACK 后再导入');
      if (global.DatyBusinessDatabase) {
        if (!await global.DatyBusinessDatabase.saveImportedProfiles(imported) || !file.isCurrent()) return false;
      } else DatyEquipmentProfiles.saveCustomEquipmentProfiles(imported);
      invalidateCoordination('Equipment Profile 已更新，请重新规划');
      global.notify?.('✓','Profile 已导入',`${imported.length} 个 Profile；下发仍须同品牌、来源/频段/间隔已核实及接收机品牌 ACK 能力`);
      return true;
    } catch(error) {
      if (typeof error?.isCurrent === 'function' && !error.isCurrent()) return false;
      global.notify?.('❌','Profile 导入失败',error.message||String(error)); return false;
    }
  }

  // Explicit report inputs, no DOM/storage/network and no mutation of the plan.
  // Kept in the existing published asset until a separately deployed native module.
  function buildIMDReportText(result, devices, generatedAt = new Date()) {
    const lines = ['DATY RF PRO — 确定性频率协调报告',`生成时间: ${generatedAt.toLocaleString('zh-CN')}`,'单位: 频率/间距=kHz，电平=dBm',''];
    lines.push(`保留原频: ${result.retention.retainedCount}；建议调整: ${result.retention.changedCount}`);
    if(result.allocationOrder?.enabled)lines.push('分配顺序: GROUP 数字升序、同组 CH 升序，低组低频；未知编组置后；锁定及设备/扫描/IMD 约束保持');
    if(result.distribution?.enabled)lines.push(`频段分布: 按 ${result.distribution.targetCount} 个实际通道分散于设定范围，锁频固定，均匀目标服从全部设备/扫描/IMD约束；不自动补足预留。`,'分布证据: '+JSON.stringify(result.distribution));
    if(result.frequencyPool){const pool=result.frequencyPool;lines.push(`频点目标: 至少 ${pool.targetCount}；实际通道 ${pool.actualCount} + 预留 ${pool.reservedFrequenciesKHz.length} = 已规划 ${pool.plannedCount}；缺少 ${pool.shortfall}；${pool.complete?'已达标':'未达标'}`,
      '预留频点未绑定设备、不参与下发；按所有当前 Profile 共同范围与约束校核，不代表频段最大容量。',
      '预留频点 (kHz): '+pool.reservedFrequenciesKHz.join(', '),'频点证据: '+JSON.stringify(pool));}
    lines.push(`引擎: ${result.engineVersion}`,`兼容级别: ${result.options.compatibilityLevel}`,`范围: ${result.options.rangeStartKHz}-${result.options.rangeEndKHz} kHz`,`栅格: ${result.options.stepKHz} kHz`,`已规划: ${result.assignments.length}`,`未规划: ${result.unassignedDeviceIds.length}`,`冲突: ${result.analysis.conflicts.length}`,`最小通道间隔: ${result.analysis.minChannelSpacingKHz ?? 'N/A'} kHz`,`最小 IMD 频率距离: ${result.analysis.minImdSeparationKHz ?? 'N/A'} kHz`,`最小 IMD 净裕量: ${result.analysis.minImdMarginKHz ?? 'N/A'} kHz`,'','【频率分配】');
    const reportAssignments=result.allocationOrder?.enabled ? result.assignments.slice().sort((a,b)=>a.allocationRank-b.allocationRank) : result.assignments;
    for (const item of reportAssignments) { const d=devices.find(x=>x.id===item.deviceId); lines.push(`${result.allocationOrder?.enabled ? `${item.groupNumber===null?'未知编组':`GROUP${item.groupNumber}`} · ` : ''}${item.brand} ${d?.ch||item.deviceId}, ${DatyFrequency.formatFrequencyMHz(item.frequencyKHz)} MHz, brandKey=${item.brandKey}, minimumChannelSpacingKHz=${item.minimumChannelSpacingKHz??'UNVERIFIED'}, channelSpacingKHz=${item.channelSpacingKHz}, intermodSpacingKHz=${item.intermodSpacingKHz}, candidateStepKHz=${item.candidateStepKHz}, profile=${item.profileId}, band=${item.profileBandId}, mode=${item.profileModeId}, source=${item.profileSource}, deployable=${item.deploymentEligible}, locked=${item.locked}, backups=${item.backupFrequenciesKHz.map(value=>DatyFrequency.formatFrequencyMHz(value)).join('|')||'N/A'}, scan=${item.scanLevelDbm??'N/A'} dBm`); }
    lines.push('','【原频保留与调整原因】',...result.assignments.map(item=>`${item.deviceId}: ${item.retainedOriginal?'保留原频':'建议调整'}；${item.changeReason}`),
      JSON.stringify(result.retention,null,2));
    if (result.errors.length) { lines.push('','【未分配原因】',...result.errors); }
    if (result.compatibility) lines.push('','【兼容级别有效参数】',compatibilitySummary(result.compatibility),JSON.stringify(result.compatibility,null,2));
    lines.push('','【限制与警告】',...(result.warnings || []),'当前校核只涉及频率关系，不计算 IMD 功率；未做 WWB6 实测对照。',
      '','【可复核输入：约束、扫描原始点、Profile 快照】',JSON.stringify({options:result.options,profiles:result.profileSnapshots},null,2),
      '','【冲突明细】',JSON.stringify(result.analysis.conflicts,null,2));
    return lines.join('\n');
  }

  // Pure export model; native views can reuse the exact text and display fields.
  function prepareIMDReportExport(result, devices, generatedAt = new Date()) {
    const options={fileName:`DATY_Coordination_${generatedAt.toISOString().slice(0,10)}.txt`,mimeType:'text/plain;charset=utf-8'};
    return {text:buildIMDReportText(result,devices,generatedAt),options,
      dialog:{title:'导出频率规划报告',eyebrow:'DATY RF PRO · 频率规划',symbol:'↓',
        message:'导出当前规划的完整校核报告。',confirmLabel:'导出报告',cancelLabel:'取消',
        details:[{label:'文件名称',value:options.fileName},{label:'文件格式',value:'TXT 文本 · UTF-8'},
          {label:'规划范围',value:`${DatyFrequency.formatFrequencyMHz(result.options.rangeStartKHz)}–${DatyFrequency.formatFrequencyMHz(result.options.rangeEndKHz)} MHz`},
          {label:'通道数量',value:`已规划 ${result.assignments.length} · 未规划 ${result.unassignedDeviceIds.length}`},
          {label:'校核结果',value:`冲突 ${result.analysis.conflicts.length} · 错误 ${result.errors.length} · 提示 ${(result.warnings || []).length}`}],
        footnote:'包含频点、人工约束、Profile、扫描证据和校核限制'}};
  }

  let reportExportPending = false;
  async function exportIMDReport() {
    if(reportExportPending)return false;
    const result=lastCoordination;
    if(!result){global.notify?.('⚠️','无可导出结果','请先运行频率规划');return false;}
    reportExportPending=true;
    const controller=new AbortController(),cancel=()=>controller.abort();
    const button=document.getElementById('plannerExportReport');
    const wasDisabled=button?.disabled || false;
    if(button){button.disabled=true;button.setAttribute('aria-busy','true');}
    global.addEventListener?.('pagehide',cancel,{once:true});
    try {
      const dialogs=global.DatyDialogs,platform=global.DatyPlatform,exporter=global.DatyTextExportFactory,port=global.DatyTextExports;
      const context=()=>JSON.stringify([lastCoordination,captureConstraintFields(),
        result.assignments.map(item=>[item.deviceId,getDevices().find(device=>device.id===item.deviceId)?.ch])]);
      const before=context(),prepared=prepareIMDReportExport(result,getDevices());
      if(typeof dialogs?.confirm!=='function')throw new Error('应用内确认组件未加载，请刷新页面');
      if(typeof exporter?.saveText!=='function')throw new Error('文件导出组件未加载，请刷新页面');
      const decision=dialogs.confirm(prepared.dialog);
      if(!decision || typeof decision.then!=='function')throw new TypeError('报告确认接口必须返回 Promise<boolean>');
      if(await decision!==true || controller.signal.aborted)return false;
      if(lastCoordination!==result || context()!==before)throw new Error('规划结果或输入已变化，请重新打开导出窗口');
      if(global.DatyDialogs!==dialogs || global.DatyPlatform!==platform || global.DatyTextExportFactory!==exporter || global.DatyTextExports!==port)
        throw new Error('文件保存环境已变化，请重新打开导出窗口');
      const saved=await exporter.saveText(global,prepared.text,{...prepared.options,signal:controller.signal});
      if(controller.signal.aborted || saved.status==='cancelled')return false;
      if(global.DatyPlatform!==platform || global.DatyTextExportFactory!==exporter || global.DatyTextExports!==port)return false;
      if(!['saved','download-started'].includes(saved.status))throw new TypeError('文件保存接口返回了未知状态');
      global.notify?.('📄',saved.status==='saved'?'文件已保存':'已开始下载',
        saved.status==='saved'?'频率规划 TXT 报告已保存':'请在下载列表中查看频率规划 TXT 报告');
      return true;
    } catch(error) {
      if(!controller.signal.aborted)global.notify?.('❌','报告导出失败',error.message || String(error));
      return false;
    } finally {
      reportExportPending=false;global.removeEventListener?.('pagehide',cancel);
      if(button){button.disabled=wasDisabled;button.removeAttribute('aria-busy');}
    }
  }

  // daty-auto-frequency-v1. Host-independent orchestration; it never creates a
  // deployable plan, writes device frequencies, or calls a command transport.
  const AUTO_FREQUENCY_KEY = 'daty_auto_frequency_v1';
  function createAutoFrequency({storage,readKey,readInput,compute,cancelCompute=()=>{},onChange=()=>{},
    schedule=setTimeout,cancel=clearTimeout,now=Date.now}) {
    let enabled=true,storageError=false,revision=0,lastKey=null,pendingKey=null,timer=null,disposed=false,epoch=0,runningKey=null;
    let view={phase:'waiting',result:null,message:'等待在线设备',checkedAt:null};
    function loadPreference() {
      try {
        const raw=storage.getItem(AUTO_FREQUENCY_KEY);
        if (raw===null) enabled=true;
        else {const value=JSON.parse(raw);if(typeof value?.enabled!=='boolean')throw Error('Invalid preference');enabled=value.enabled;}
        storageError=false;
      } catch (_) {storageError=true;}
    }
    loadPreference();
    function state(){return JSON.parse(JSON.stringify({enabled,storageError,...view}));}
    function emit(){try{onChange(state());}catch(_){/* view errors cannot block telemetry */}}
    function clearTimer(){if(timer!==null)cancel(timer);timer=null;pendingKey=null;}
    function fingerprint(){return revision+':'+readKey();}
    function stopCompute(){epoch++;runningKey=null;try{cancelCompute();}catch(_){/* cancellation cannot block UI */}}
    function refresh(force=false) {
      clearTimer();if(disposed||!enabled)return state();
      let key,ticket;
      function failed(error){
        if(ticket!==undefined&&ticket!==epoch)return state();
        runningKey=null;lastKey=key??null;view={phase:'error',result:null,message:String(error.message||error),checkedAt:null};emit();return state();
      }
      function completed(result){
        if(disposed||!enabled||ticket!==epoch)return state();
        try {
          if(key!==fingerprint()){runningKey=null;lastKey=null;requestRefresh();return state();}
          runningKey=null;
          view={phase:'ready',result,message:result.entries.length?`${result.entries.length} 个通道有换频建议或限制`:
            result.warnings.some(text=>text.includes('未满足'))?'请先核查规划范围与约束':'当前未发现可判定的频率冲突',checkedAt:now()};
          emit();return state();
        }catch(error){return failed(error);}
      }
      try {
        key=fingerprint();if(!force&&key===lastKey&&view.phase!=='checking')return state();lastKey=key;
        stopCompute();ticket=epoch;runningKey=key;
        view={phase:'checking',result:null,message:'正在复核当前频率',checkedAt:null};
        emit();
        const input=readInput();
        if(input.paused)view={phase:'paused',result:null,message:'下发中，暂停推荐',checkedAt:null};
        else if(!input.devices.length)view={phase:'waiting',result:null,message:'等待在线接收机',checkedAt:null};
        else {
          const result=compute(input.devices,input.options);
          return result&&typeof result.then==='function'?result.then(completed,failed):completed(result);
        }
        runningKey=null;
      } catch (error) {return failed(error);}
      emit();return state();
    }
    function requestRefresh() {
      if(disposed||!enabled)return;
      try {
        const key=fingerprint();if(key===runningKey||(key===lastKey&&view.phase!=='checking')||key===pendingKey)return;
        stopCompute();
        pendingKey=key;
        // Invalidate visible stale candidates immediately, calculate once after
        // the burst. AF/RF amplitude, mute, battery and RTT are not key inputs.
        view={phase:'checking',result:null,message:'正在复核当前频率',checkedAt:null};emit();
        if(timer===null)timer=schedule(()=>refresh(),250);
      } catch(error){clearTimer();stopCompute();view={phase:'error',result:null,message:String(error.message||error),checkedAt:null};emit();}
    }
    function invalidate(){revision++;requestRefresh();}
    function setEnabled(value) {
      if(disposed||typeof value!=='boolean')return state();enabled=value;
      try{storage.setItem(AUTO_FREQUENCY_KEY,JSON.stringify({enabled}));storageError=false;}catch(_){storageError=true;}
      clearTimer();stopCompute();lastKey=null;view={phase:'waiting',result:null,message:enabled?'等待检查':'自动变频推荐已关闭',checkedAt:null};emit();
      if(enabled)requestRefresh();return state();
    }
    function reload(){clearTimer();stopCompute();loadPreference();lastKey=null;view={phase:'waiting',result:null,message:'等待检查',checkedAt:null};emit();requestRefresh();}
    return Object.freeze({getState:state,refresh,requestRefresh,invalidate,setEnabled,reload,
      dispose(){disposed=true;clearTimer();stopCompute();view={phase:'waiting',result:null,message:'已停止',checkedAt:null};}});
  }

  function createRecommendationWorker(storage){
    let worker=null,job=null;
    function cancel(){
      if(worker){worker.terminate();worker=null;}
      if(job){clearTimeout(job.timer);const previous=job;job=null;previous.reject(Error('推荐输入已变化，旧计算已取消'));}
    }
    function compute(devices,options){
      // Native shell supplies an asynchronous calculation port; never falls back
      // to browser Worker/Blob if a native platform has been explicitly injected.
      if(global.DatyPlatform&&global.DatyPlatform.kind!=='browser')return Promise.reject(Error('原生宿主尚未提供自动推荐计算接口'));
      if(typeof global.Worker!=='function')return Promise.reject(Error('当前浏览器不支持后台计算，请使用频率规划页面'));
      return new Promise((resolve,reject)=>{
        if(!worker){
          const urls=['frequency','equipment-profiles','coordination'].map(name=>new URL(`src/modules/${name}.js?v=1.0.3-auto-frequency1`,global.location.href).href);
          const source=`self.window=self;let values={};self.DatyPlatform={storage:{getItem:k=>values[k]??null,setItem:()=>{throw Error('只读计算禁止写存储')},removeItem:()=>{throw Error('只读计算禁止写存储')}}};importScripts(...${JSON.stringify(urls)});self.onmessage=event=>{try{values=event.data.profiles;postMessage({result:DatyCoordination.recommendBackupFrequencies(event.data.devices,event.data.options)})}catch(error){postMessage({error:String(error.message||error)})}};`;
          const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
          try{worker=new global.Worker(url);}finally{URL.revokeObjectURL(url);}
          const spawned=worker;
          worker.onmessage=event=>{
            if(worker!==spawned||!job)return;const current=job;job=null;clearTimeout(current.timer);
            if(event.data.error)current.reject(Error(event.data.error));else current.resolve(event.data.result);
          };
          worker.onerror=()=>{if(worker!==spawned)return;if(job){const current=job;job=null;clearTimeout(current.timer);current.reject(Error('后台计算不可用，请检查公开资源或使用频率规划页面'));}if(worker){worker.terminate();worker=null;}};
        }
        const task={resolve,reject,timer:null};job=task;
        task.timer=setTimeout(()=>{if(job!==task)return;job=null;worker?.terminate();worker=null;task.reject(Error('自动推荐计算超时，请缩小范围或使用一键全局规划'));},6000);
        try{worker.postMessage({devices,options,profiles:Object.fromEntries(['daty_equipment_profiles_v1','daty_equipment_profiles_v2'].map(key=>[key,storage.getItem(key)]))});}
        catch(error){clearTimeout(job.timer);job=null;reject(error);}
      });
    }
    return {compute,cancel};
  }

  function mountAutoFrequency() {
    const checkbox=document.getElementById('autoFrequencyEnabled');if(!checkbox)return null;
    const status=document.getElementById('autoFrequencyStatus'),button=document.getElementById('autoFrequencyDetails');
    const storage=global.DatyPlatform===undefined?global.localStorage:global.DatyPlatform.storage;
    const fields=['id','_fasheId','receiver_id','receiverId','receiver_ip','receiver_mac','ip','mac','brand','model',
      'channel_number','channel','ch','freq','equipmentProfileId','equipment_profile_id','equipmentBandId','equipmentModeId','capabilities'];
    function liveDevices(){
      return getDevices().filter(device=>{
        const live=!!(device._fasheId||device.receiver_id||device.receiverId||device._serverManaged);
        const online=device._online===true||device.online===true||['online','warn','error'].includes(device.status);
        return live&&online&&!(typeof global._deviceIsOffline==='function'&&global._deviceIsOffline(device));
      }).map(device=>Object.fromEntries(fields.filter(field=>device[field]!==undefined).map(field=>[field,device[field]])));
    }
    const busy=()=>!!global.DatyPlanningDeployment?.isBusy();
    function sync(state){
      checkbox.checked=state.enabled;
      if(status){
        const localMessage=state.storageError?'推荐设置未保存，仅本页生效':!state.enabled?'自动变频推荐已关闭':state.message;
        const message=global.DatyBusinessDatabase?.preferenceMessage('auto_frequency',localMessage)??localMessage;
        if(status.textContent!==message)status.textContent=message;
        status.title=message+'。只推荐、不自动下发；RF 弱信号、AF 过载和低电量本身不是干扰证据。';
      }
      if(button)button.disabled=!state.enabled;
      global.renderAlerts?.();
    }
    const calculation=global.DatyAutoFrequencyCompute || createRecommendationWorker(storage);
    const settingStorage={getItem:()=>'{"enabled":false}',setItem:()=>{}};
    const controller=createAutoFrequency({storage:settingStorage,cancelCompute:()=>calculation.cancel?.(),
      readKey:()=>JSON.stringify([liveDevices(),captureConstraintFields(),busy(),
        storage.getItem('daty_equipment_profiles_v2'),storage.getItem('daty_equipment_profiles_v1')]),
      readInput:()=>({devices:liveDevices(),options:getOptions(),paused:busy()}),
      compute:(devices,options)=>calculation.compute(devices,options),onChange:sync});
    const limits={locked:'已锁定，保持原频', 'constraints-unapplied':'锁定约束尚未满足，请先全局规划',
      'backups-disabled':'规划约束的备用数为 0', 'search-limited':'检查限额内未找到，请全局规划',none:'未找到满足约束的单通道候选'};
    const channel=row=>'CH'+String(row.channel).replace(/^CH[-\s]*/i,'');
    const frequency=value=>global.DatyFrequency.formatFrequencyMHz(value)+' MHz';
    function getSummary(){
      const state=controller.getState(),rows=state.result?.entries||[];
      if(!state.enabled||!rows.length)return null;
      const first=rows[0],label=`${first.brand} · ${channel(first)} · ${first.receiverIP||first.receiverId}`;
      const recommendation=first.backupFrequenciesKHz.length?first.backupFrequenciesKHz.map(frequency).join(' / '):limits[first.status]||'需重新检查';
      return `${rows.some(row=>row.evidence==='scan')?'导入扫描占用 / 计算风险':'频率约束计算风险'} · ${rows.length} 个通道：${label} → ${recommendation}。仅建议，不自动下发。`;
    }
    let opening=false;
    async function open(){
      if(opening)return;opening=true;
      try {
      const state=await controller.refresh(true),result=state.result;
      const accepted=await global.DatyDialogs.confirm({title:'自动变频推荐 · 只读检查',
        message:result?.entries.length?`发现 ${result.entries.length} 个通道的扫描占用或频率约束风险。以下是各通道单独替换候选，不是可批量下发的方案。`:state.message,
        rows:(result?.entries||[]).map(row=>({brand:row.brand,receiver:row.receiverIP||row.receiverId,channel:channel(row),
          currentFrequency:frequency(row.currentFrequencyKHz),plannedFrequency:row.backupFrequenciesKHz.map(frequency).join(' / ')||limits[row.status],
          note:(row.evidence==='scan'?'导入扫描快照；':'数学风险，非实测；')+row.reasons.join('；')})),
        columns:[{key:'brand',label:'品牌'},{key:'receiver',label:'接收机'},{key:'channel',label:'通道'},
          {key:'currentFrequency',label:'当前频率',numeric:true},{key:'plannedFrequency',label:'候选备用频率 / 限制',numeric:true}],
        warnings:[...(result?.warnings||[]),'RF 弱信号不等于干扰；AF 过载和电池低电量应先处理音频增益或电池。',
          '候选只针对当前各品牌/接收机/CH 快照，不能同时直接套用。前往频率规划，人工确认约束并重新全局规划后，按人工确认及设备 ACK 流程下发。'],
        footnote:state.checkedAt?'检查时间 '+new Date(state.checkedAt).toLocaleString('zh-CN')+'；此窗口不发送设备命令':'只读建议，不自动调频',
        confirmLabel:'前往频率规划',cancelLabel:'关闭'});
      if(accepted)global.switchPanel?.('planner');
      } catch(error) { global.notify?.('⚠️','建议暂不可用',String(error.message||error)); }
      finally {opening=false;}
    }
    checkbox.addEventListener('change',()=>{
      if(global.DatyBusinessDatabase){void global.DatyBusinessDatabase.setBooleanPreference('auto_frequency',checkbox.checked,value=>controller.setEnabled(value));return;}
      global.notify?.('⚠️','推荐设置未保存','服务器数据库尚未就绪');
    });
    button?.addEventListener('click',()=>{void open().catch(error=>global.notify?.('⚠️','建议暂不可用',error.message));});
    global.addEventListener?.('storage',event=>{
      // Recommendation preference is loaded from the server database only.
      if(['daty_equipment_profiles_v1','daty_equipment_profiles_v2'].includes(event.key))controller.invalidate();
    });
    sync(controller.getState());controller.requestRefresh();
    return Object.freeze({...controller,getSummary,open});
  }
  global.DatyAutoFrequencyFactory=Object.freeze({VERSION:'1.0.0',STORAGE_KEY:AUTO_FREQUENCY_KEY,create:createAutoFrequency});
  const initializeAutoFrequency=()=>{global.DatyAutoFrequency=mountAutoFrequency();};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initializeAutoFrequency,{once:true});else initializeAutoFrequency();

  // Command catalog delegates to the existing checked application handlers.
  const plannerActions=[
    ['basic','基本设置',()=>switchPlannerControlTab('basic')],['constraints','规划约束',()=>switchPlannerControlTab('constraints')],
    ['safety','安全参数',()=>global.openPlannerSafetySettings()],['importProfile','导入 Profile',()=>importEquipmentProfile()],
    ['confirmLock','确定锁定',()=>confirmSelectedLock()],['removeLock','取消锁定',()=>removeSelectedLock()],['saveConstraints','应用约束',()=>saveCurrentPlanningConstraints()],
    ['plan','一键全局规划',()=>runPlanning()],['details','详情 / 限制',()=>openPlannerResultDetails()],
    ['exportReport','导出报告',()=>exportIMDReport()],['exportPlan','导出方案',()=>global.exportPlan()],
    ['pushAll','全部下发',()=>global.pushAllFreq()],['pushOne','单通道下发',id=>{if(!['string','number'].includes(typeof id)||String(id)==='')throw new TypeError('缺少通道身份');return global.pushFreq(id);}],
    ['stop','停止后续',()=>global.DatyPlanningDeployment.stop()],['previousPage','上一页',()=>global.changePlannerTablePage(-1)],['nextPage','下一页',()=>global.changePlannerTablePage(1)],
    ['closeDetails','关闭详情',()=>closePlannerWindow('details')],['closeSafety','完成安全参数',()=>closePlannerWindow('safety')]
  ];
  global.DatyPlannerActions=Object.freeze({VERSION:'daty-planner-actions-v1',
    list:()=>plannerActions.map(([id,label])=>({id,label})),
    execute(id,value){const action=plannerActions.find(item=>item[0]===id);if(!action)throw new TypeError('未知规划操作');return action[2](value);},
    getWindowModel:getPlannerWindowModel});

  global.runPlanning = runPlanning;
  global.switchPlannerControlTab = switchPlannerControlTab;
  global.openPlannerResultDetails = openPlannerResultDetails;
  global.invalidateCoordination = invalidateCoordination;
  global.calculateCrossBrandIMD = calculateCrossBrandIMD;
  global.importFile = importFile;
  global.importScan = importScan;
  global.exportIMDReport = exportIMDReport;
  global.DatyCoordinationReport = Object.freeze({buildText:buildIMDReportText,prepareExport:prepareIMDReportExport});
  global.importEquipmentProfile = importEquipmentProfile;
  global.saveCurrentPlanningConstraints = saveCurrentPlanningConstraints;
  global.openPlannerSafetySettings = () => openPlannerWindow('safety');
  global.closePlannerWindow = closePlannerWindow;
  global.DatyPlanningConstraints = Object.freeze({parseExcludedRanges,parseLockedAssignments,parseKnownCarriers,parseBackupCount,readConstraintFields,captureConstraintFields,restoreSnapshot,getLockedFrequencyView,updateConstraintFeedback,refreshLockEditor,getPlanningDevices,getOptions,setManualLock,createLockedUsageEditor,syncFrequencyRange,readPlanningRange});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeConstraintFields, {once:true}); else initializeConstraintFields();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializePlannerLayout, {once:true}); else initializePlannerLayout();
})(window);
