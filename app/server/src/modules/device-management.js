// 设备管理视图：每页 50 个通道。只切显示副本，不改设备集合或接收机 + CH 身份。
const MANAGED_DEVICE_PAGE_SIZE = 50;
let managedDevicePage = 1;
let managedDeviceDetailKey = null;

function getManagedDevicePage(devices, requestedPage = 1) {
  const sorted = devices.map((device, index) => ({device, index})).sort((a, b) =>
    (getDeviceChannelNumberSafe(a.device, Number.MAX_SAFE_INTEGER) ?? Number.MAX_SAFE_INTEGER)
    - (getDeviceChannelNumberSafe(b.device, Number.MAX_SAFE_INTEGER) ?? Number.MAX_SAFE_INTEGER)
    || a.index - b.index).map(item => item.device);
  const pageCount = Math.max(1, Math.ceil(sorted.length / MANAGED_DEVICE_PAGE_SIZE));
  const page = Math.max(1, Math.min(pageCount, Math.floor(Number(requestedPage)) || 1));
  const start = (page - 1) * MANAGED_DEVICE_PAGE_SIZE;
  return {page, pageCount, start, total:sorted.length, devices:sorted.slice(start, start + MANAGED_DEVICE_PAGE_SIZE)};
}

function updateDeviceManagementLayout() {
  const panel = document.getElementById('panel-devices');
  const active = !!(panel?.classList.contains('active') && document.getElementById('devOnline')?.classList.contains('active'));
  panel?.classList.toggle('device-management-layout', active);
  document.querySelector('.content')?.classList.toggle('device-management-view', active);
  const dialog = document.getElementById('managedDeviceDialog');
  if (!active && dialog?.open) dialog.close();
}

function goManagedDevicePage(page) {
  managedDevicePage = getManagedDevicePage(DEVICES, page).page;
  document.getElementById('managedDeviceDialog')?.close();
  renderManagedDeviceCards();
}
function changeManagedDevicePage(delta) { goManagedDevicePage(managedDevicePage + delta); }

function managedDeviceProtocol(d) {
  return d._fasheId ? 'MQTT / SSE' : d.brand === 'Shure' ? 'SCP :2202'
    : d.brand === 'Sennheiser' ? 'SSCv2 :45' : 'TCP 私有';
}

function getManagedDevicePresentation(d) {
  const status = getDeviceDisplayStatus(d);
  return {title:formatBrandModelDisplay(d), name:String(d.name || '—'),
    ip:String(d.receiver_ip || d.receiverIp || d.ip || '—'),
    channel:formatGroupChannelDisplay(d), frequency:_formatFrequencyMHz(d.freq).replace(/\s*MHz$/, ''),
    protocol:managedDeviceProtocol(d), status,
    statusText:({online:'在线',warn:'注意',error:'错误',offline:'离线'})[status] || '未知'};
}

function renderManagedDeviceCards() {
  const grid = document.getElementById('devTableBody');
  if (!grid) return;
  const view = getManagedDevicePage(DEVICES, managedDevicePage);
  managedDevicePage = view.page;
  const retained = new Map([...grid.children].filter(el => el.dataset.deviceKey).map(el => [el.dataset.deviceKey, el]));
  const keys = new Set(view.devices.map(getChannelCardKey));
  for (const child of [...grid.children]) if (!keys.has(child.dataset.deviceKey)) child.remove();
  grid.classList.toggle('is-empty', !view.total);
  view.devices.forEach((d, index) => {
    const key = getChannelCardKey(d), p = getManagedDevicePresentation(d);
    const card = retained.get(key) || document.createElement('button');
    const signature = JSON.stringify([d.id, p]);
    if (card._managedSignature !== signature) {
      card.type = 'button'; card.className = `managed-device-card ${p.status}`;
      card.dataset.deviceKey = key; card.dataset.deviceId = String(d.id);
      card.title = `${p.title}\n${p.name}\n${p.ip}\n${p.channel} · ${p.frequency} MHz\n${p.protocol} · ${p.statusText}\n点击查看详情与操作`;
      card.setAttribute('aria-haspopup', 'dialog');
      card.setAttribute('aria-label', `${p.title}，${p.ip}，${p.channel}，${p.statusText}，查看详情`);
      card.innerHTML = `<span class="managed-device-title">${escapeAlertText(p.title)}</span>
        <span class="managed-device-line"><span class="managed-device-ip">${escapeAlertText(p.ip)}</span><span class="managed-device-state">${escapeAlertText(p.statusText)}</span></span>
        <span class="managed-device-line"><span class="managed-device-channel">${escapeAlertText(p.channel)}</span><span class="managed-device-frequency">${escapeAlertText(p.frequency)}<small> MHz</small></span></span>
        <span class="managed-device-extra"><span>${escapeAlertText(p.name)}</span><span>${escapeAlertText(p.protocol)}</span></span>`;
      card.onclick = () => showManagedDeviceDetails(d.id);
      card._managedSignature = signature;
    }
    if (grid.children[index] !== card) grid.insertBefore(card, grid.children[index] || null);
  });
  if (!view.total && !grid.children.length) {
    const empty = document.createElement('div'); empty.className = 'managed-device-empty';
    empty.textContent = '暂无通道。连接 FAshe 接收机，或添加 / 导入设备后显示。'; grid.appendChild(empty);
  }
  const info = document.getElementById('managedDevicePageInfo');
  const text = `共 ${view.total} 个通道 · ${view.total ? view.start + 1 : 0}–${view.start + view.devices.length} · 50 条/页 · 第 ${view.page}/${view.pageCount} 页`;
  if (info && info.textContent !== text) info.textContent = text;
  for (const [id, disabled] of [['managedDeviceFirstPage',view.page===1],['managedDevicePrevPage',view.page===1],
    ['managedDeviceNextPage',view.page===view.pageCount],['managedDeviceLastPage',view.page===view.pageCount]]) {
    const button = document.getElementById(id); if (button && button.disabled !== disabled) button.disabled = disabled;
  }
  if (document.getElementById('managedDeviceDialog')?.open) refreshManagedDeviceDetails();
}

function showManagedDeviceDetails(id) {
  const device = DEVICES.find(d => d.id === id), dialog = document.getElementById('managedDeviceDialog');
  if (!device || !dialog) return;
  managedDeviceDetailKey = getChannelCardKey(device);
  refreshManagedDeviceDetails();
  if (!dialog.open) dialog.showModal();
}

function refreshManagedDeviceDetails() {
  const device = DEVICES.find(d => getChannelCardKey(d) === managedDeviceDetailKey);
  const notice = document.getElementById('managedDeviceDetailNotice');
  const fields = document.getElementById('managedDeviceDetailFields');
  const text = device ? '详情随实时数据更新。编辑只针对当前接收机的这个通道。' : '该通道已离开当前设备列表，操作已禁用。';
  if (notice && notice.textContent !== text) notice.textContent = text;
  if (device && fields) {
    const p = getManagedDevicePresentation(device);
    const values = [['设备名称',p.name],['品牌 / 型号',p.title],['编组 / 通道',p.channel],['IP 地址',p.ip],
      ['协议',p.protocol],['频率',`${p.frequency} MHz`],['连接状态',p.statusText],['静音状态',normalizeMutedValue(device.muted) ? '已静音' : '未静音']];
    const signature = JSON.stringify(values);
    if (fields._managedSignature !== signature) {
      fields.innerHTML = values.map(([label,value]) => `<div><dt>${label}</dt><dd>${escapeAlertText(value)}</dd></div>`).join('');
      fields._managedSignature = signature;
    }
  } else if (fields) { fields.textContent = ''; fields._managedSignature = null; }
  for (const [id, action] of [['managedDeviceEdit','editDevice'],['managedDeviceDisconnect','disconnectDev'],['managedDeviceDelete','deleteDev']]) {
    const button = document.getElementById(id); if (!button) continue;
    const available = typeof window[action] === 'function';
    button.disabled = !device || !available;
    button.title = available ? '' : '当前版本尚未实现此操作接口';
  }
}

function runManagedDeviceAction(action) {
  if (!['editDevice','disconnectDev','deleteDev'].includes(action)) return;
  const device = DEVICES.find(d => getChannelCardKey(d) === managedDeviceDetailKey);
  if (!device || typeof window[action] !== 'function') return;
  document.getElementById('managedDeviceDialog')?.close();
  window[action](device.id);
}
