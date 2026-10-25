// Display-only pagination. The original device collection and receiver + CH routing stay intact.
const deviceTableView = {page:1};
const channelCardsView = {page:1, filterKey:null};

function deviceViewPage(devices, size, requested = 1) {
  const pageCount = Math.max(1, Math.ceil(devices.length / size));
  const page = Math.max(1, Math.min(pageCount, Math.floor(Number(requested)) || 1));
  const start = (page - 1) * size;
  return {page, pageCount, start, total:devices.length, size, devices:devices.slice(start, start + size)};
}

function sortDeviceView(devices, key = 'ch', byGroup = false) {
  const value = d => key === 'ch' ? getDeviceChannelNumberSafe(d, null) : d[key];
  // 先按服务器确认的真实编组升序；未知编组置底，组内沿用指定排序。
  // 只排序显示副本，不改变 DEVICES 或控制目标。
  return devices.map((d, i) => ({d, i, group: byGroup ? (getPlannerReceiverGroupNumber(d) ?? Infinity) : 0})).sort((a, b) => {
    const groupOrder = a.group - b.group;
    if (groupOrder) return groupOrder;
    const av = value(a.d), bv = value(b.d);
    const valid = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    if (!valid(av) || !valid(bv)) return Number(valid(bv)) - Number(valid(av)) || a.i - b.i;
    return (Number(av) - Number(bv)) * (['rf','batt'].includes(key) ? -1 : 1) || a.i - b.i;
  }).map(item => item.d);
}

function updateDeviceViewsLayout() {
  const content = document.querySelector('.content');
  const table = !!(document.getElementById('panel-devices')?.classList.contains('active')
    && document.getElementById('devOnline')?.classList.contains('active'));
  const cards = !!document.getElementById('panel-channels')?.classList.contains('active');
  content?.classList.toggle('device-table-view', table);
  content?.classList.toggle('channel-cards-view', cards);
}

function updateDeviceViewPager(prefix, view, noun) {
  const info = document.getElementById(prefix + 'PageInfo');
  const text = `共 ${view.total} ${noun} · ${view.total ? view.start + 1 : 0}–${view.start + view.devices.length} · 每页 ${view.size} · 第 ${view.page}/${view.pageCount} 页`;
  if (info && info.textContent !== text) info.textContent = text;
  for (const [suffix, disabled] of [['First',view.page===1],['Prev',view.page===1],['Next',view.page===view.pageCount],['Last',view.page===view.pageCount]]) {
    const button = document.getElementById(prefix + suffix + 'Page');
    if (button && button.disabled !== disabled) button.disabled = disabled;
  }
}

function getFilteredChannelView() {
  const brand = document.getElementById('filterBrandChannels')?.value || 'all';
  const status = document.getElementById('filterStatusChannels')?.value || 'all';
  const sort = document.getElementById('sortChannels')?.value || 'ch';
  const key = JSON.stringify([brand,status,sort]);
  if (channelCardsView.filterKey !== key) { channelCardsView.page = 1; channelCardsView.filterKey = key; }
  return sortDeviceView(DEVICES.filter(d => (brand === 'all' || d.brand === brand)
    && (status === 'all' || getDeviceDisplayStatus(d) === status)), sort, true);
}

function getVisibleChannelPage(devices) {
  if(devices.length&&channelCardsView.databasePreferredPage){channelCardsView.page=channelCardsView.databasePreferredPage;delete channelCardsView.databasePreferredPage;}
  const sort = document.getElementById('sortChannels')?.value || 'ch';
  const view = deviceViewPage(sortDeviceView(devices, sort, true), 50, channelCardsView.page);
  channelCardsView.page = view.page;
  updateDeviceViewPager('channelCards', view, '个通道');
  return view.devices;
}

function goChannelCardsPage(page) { delete channelCardsView.databasePreferredPage; channelCardsView.page = page; filterDevicesChannels(); void globalThis.DatyBusinessDatabase?.savePage('channelPage',channelCardsView.page); }
function DatyApplyDevicePagePreferences(value) {
  if(Number.isSafeInteger(value.devicePage)&&value.devicePage>0)deviceTableView.databasePreferredPage=value.devicePage;
  if(Number.isSafeInteger(value.channelPage)&&value.channelPage>0){getFilteredChannelView();channelCardsView.databasePreferredPage=value.channelPage;}
}
function changeChannelCardsPage(delta) { goChannelCardsPage(channelCardsView.page + delta); }
function goDeviceTablePage(page) {
  document.querySelector('#devTableBody .edit-name-input')?.blur();
  delete deviceTableView.databasePreferredPage;
  deviceTableView.page = page; renderDevTable();
  void globalThis.DatyBusinessDatabase?.savePage('devicePage',deviceTableView.page);
}
function changeDeviceTablePage(delta) { goDeviceTablePage(deviceTableView.page + delta); }

function runDeviceTableAction(key, action) {
  if (!['editDevice','disconnectDev','deleteDev','editDeviceName'].includes(action)) return;
  const device = DEVICES.find(d => getChannelCardKey(d) === key);
  if (device && typeof window[action] === 'function') window[action](device.id);
}

function renderPagedDeviceTable() {
  const body = document.getElementById('devTableBody');
  if (!body) return;
  if(DEVICES.length&&deviceTableView.databasePreferredPage){deviceTableView.page=deviceTableView.databasePreferredPage;delete deviceTableView.databasePreferredPage;}
  const view = deviceViewPage(sortDeviceView(DEVICES, 'ch', true), 20, deviceTableView.page);
  deviceTableView.page = view.page;
  updateDeviceViewPager('deviceTable', view, '条通道记录');
  // 复用规划锁定的唯一设备/历史身份定位，分类不写入设备名称。
  const locks = window.DatyPlanningConstraints?.getLockedFrequencyView()?.locks;
  const retained = new Map([...body.children].map(row => [row.dataset.deviceKey, row]));
  const keys = new Set(view.devices.map(getChannelCardKey));
  for (const row of [...body.children]) if (!keys.has(row.dataset.deviceKey)) row.remove();
  for (const [index,d] of view.devices.entries()) {
    const key = getChannelCardKey(d), row = retained.get(key) || document.createElement('tr');
    const status = getDeviceDisplayStatus(d);
    // 与频率分配表共用服务器真实编组读取，不使用浏览器本地编号。
    const group = getPlannerReceiverGroupNumber(d);
    const lock = locks?.get(String(d.id));
    const note = !lock?.invalid && typeof lock?.reason === 'string' ? lock.reason.trim() : '';
    const usage = note && !['用户锁定','手动指定频率'].includes(note) ? note : '—';
    const values = [group === null ? '—' : `GROUP${group}`,String(d.ch || formatChannelDisplay(d)),usage,formatBrandModelDisplay(d),
      String(d.receiver_ip || d.receiverIp || d.ip || '—'),
      d._fasheId ? 'MQTT / SSE' : d.brand === 'Shure' ? 'SCP :2202' : d.brand === 'Sennheiser' ? 'SSCv2 :45' : 'TCP 私有',
      _formatFrequencyMHz(d.freq),({online:'在线',warn:'注意',error:'错误',offline:'离线'})[status] || '未知'];
    if (!row.children.length) {
      row.dataset.deviceKey = key;
      row.innerHTML = '<td class="device-group-cell"></td><td></td><td><span class="device-usage-cell"></span></td><td></td><td class="mono"></td><td class="mono"></td><td class="mono"></td><td></td><td class="device-table-actions"></td>';
      for (const [label,action] of [['编辑','editDevice'],['断开','disconnectDev'],['删除','deleteDev']]) {
        const button = document.createElement('button');
        button.className = `btn ${action === 'deleteDev' ? 'btn-danger' : 'btn-outline'} btn-sm`;
        button.textContent = label; button.dataset.action = action;
        button.onclick = () => runDeviceTableAction(key, action);
        row.lastChild.appendChild(button);
      }
    }
    row.className = `device-table-row ${status}`;
    values.forEach((value,i) => {
      const cell = i === 2 ? row.children[2].firstChild : row.children[i];
      if (cell.title !== value) cell.title = value;
      if (cell.textContent !== value) cell.textContent = value;
    });
    row.children[2].firstChild.dataset.id = String(d.id);
    for (const button of row.lastChild.children) {
      const available = typeof window[button.dataset.action] === 'function' && (button.dataset.action !== 'deleteDev' || !globalThis.DatyBusinessDatabase || globalThis.DatyBusinessDatabase.isManualDevice(d));
      button.disabled = !available;
      button.title = available ? `${values[4]} · ${values[1]} · ${button.textContent}` : '当前版本尚未实现此操作接口';
    }
    if (body.children[index] !== row) body.insertBefore(row,body.children[index] || null);
  }
  if (!view.total && !body.children.length) body.innerHTML = '<tr><td colspan="9" class="device-table-empty">暂无设备。连接接收机，或添加 / 导入设备后显示。</td></tr>';
}

function startPagedDeviceNameEdit(id) {
  const device = DEVICES.find(d => d.id === id);
  const key = device && getChannelCardKey(device);
  const row = [...document.querySelectorAll('#devTableBody tr')].find(row => row.dataset.deviceKey === key);
  const cell = row?.querySelector('.dev-name-cell');
  if (!cell || cell.querySelector('input')) return;
  const input = document.createElement('input'); input.className = 'edit-name-input'; input.value = globalThis.DatyBusinessDatabase?.deviceDisplayName(device) || device.name || '';
  let finished = false;
  const finish = async save => {
    if (finished) return; finished = true;
    const current = DEVICES.find(d => getChannelCardKey(d) === key);
    if (globalThis.DatyBusinessDatabase && save && current) {
      const submitted = input.value;
      let saved=false;try{saved=await saveDeviceName(current.id,submitted);}finally{finished=false;}
      if(saved!==true||input.value!==submitted)return;
      finished=true;input.remove();renderDevTable();return;
    }
    input.remove();
    if (save && current) saveDeviceName(current.id, input.value); else renderDevTable();
  };
  input.onblur = () => finish(true);
  input.onkeydown = event => { if (event.key === 'Enter' || event.key === 'Escape') {event.preventDefault();finish(event.key === 'Enter');} };
  cell.replaceChildren(input);input.focus();input.select();
}
