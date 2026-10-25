// ============================================================
// spectrum.js — 频谱扫描、RF柱状图、频率轴
// ============================================================

// ══════════════════ SPECTRUM ══════════════════
let scanTimer = null;
let scanData = [];
let importedScanPoints = [];
let scanSource = 'none';
let importedScanSourceName = '';
let spectrumRangeBeforeFit = null;
let lastValidSpectrumRange = [400, 900];

function readSpectrumRangeMHz() {
  const values = ['specStart','specEnd'].map(id => document.getElementById(id)?.value);
  if (values.some(value => value === undefined || String(value).trim() === '')) return null;
  try {
    // 显示留白允许超出接收机调谐范围；实际规划仍由 DatyFrequency 校验。
    const range = values.map(Number);
    return range.every(value => Number.isFinite(value) && value >= 0) && range[0] < range[1] ? range : null;
  } catch (_) { return null; }
}

// 无效输入是草稿；遥测重绘仍使用最后一次有效范围，不回退到假的默认频段。
function getSpectrumRangeMHz() {
  const range = readSpectrumRangeMHz();
  if (range) lastValidSpectrumRange = range;
  return lastValidSpectrumRange.slice();
}
// 纯显示换算：输入整数 kHz 的规划范围，输出两侧各 10 MHz 的视图范围。
function getPlanningSpectrumRangeMHz(range) {
  const start = range?.rangeStartKHz, end = range?.rangeEndKHz;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end <= start) return null;
  return [Math.max(0, start - 10000) / 1000, (end + 10000) / 1000];
}

function applyPlanningSpectrumRange(planningRange, persist = true) {
  const start = document.getElementById('specStart'), end = document.getElementById('specEnd');
  if (!start || !end) return;
  const range = getPlanningSpectrumRangeMHz(planningRange);
  start.value = range ? range[0].toFixed(3) : '';
  end.value = range ? range[1].toFixed(3) : '';
  spectrumRangeBeforeFit = null;
  updateRangeDisplay(persist);
}

const spectrumPointHoverStates = new WeakMap();

function _scanDbmToNormalized(dbm) {
  return Math.max(0, Math.min(1, (dbm + 90) / 60));
}

/** 遥测缺失不等于 0 dBm；合法范围与通道卡一致。 */
function getSpectrumRfDbm(value) {
  if (!(typeof value === 'number' || typeof value === 'string' && value.trim() !== '')) return null;
  const dbm = Number(value);
  return Number.isFinite(dbm) && dbm >= -150 && dbm <= 20 ? dbm : null;
}

/**
 * 设备 RF 几何包络，不是扫描、噪声底或发射谱模型。
 * 中心频点保留实际 RF（按图表范围裁限），中点/范围端点接显示下沿，半余弦连接。
 * 峰宽仅由视图内频点间距决定：绝不使用通道保护间隔作为带宽，也不叠加不同接收机功率。
 * 每个中心峰与谷点都被显式采样，避免全带宽等距采样漏掉密集通道。
 */
function buildDeviceRfEnvelope(devices, startMHz, endMHz) {
  const result = {kind:'device-rf-illustration', points:[], channelCount:0, frequencyCount:0, missingRfCount:0, baselineDbm:-90};
  if (!(typeof startMHz === 'number' && typeof endMHz === 'number'
      && Number.isFinite(startMHz) && Number.isFinite(endMHz) && startMHz >= 0 && endMHz > startMHz)) return result;
  const startKHz = startMHz * 1000, endKHz = endMHz * 1000;
  if (!Number.isFinite(startKHz) || !Number.isFinite(endKHz) || endKHz <= startKHz) return result;
  const levels = new Map();
  for (const device of filterRealtimeFasheDevices(devices)) {
    const rawFrequency = device.freq;
    if (!(typeof rawFrequency === 'number' || typeof rawFrequency === 'string' && rawFrequency.trim() !== '')) continue;
    const frequencyKHz = Number(rawFrequency);
    if (!Number.isSafeInteger(frequencyKHz) || frequencyKHz <= 0 || frequencyKHz < startKHz || frequencyKHz > endKHz) continue;
    const rf = getSpectrumRfDbm(device.rf);
    if (rf === null) { result.missingRfCount++; continue; }
    result.channelCount++;
    levels.set(frequencyKHz, Math.max(levels.get(frequencyKHz) ?? -Infinity, Math.max(-90, Math.min(-30, rf))));
  }
  const peaks = [...levels].sort((a,b) => a[0]-b[0]);
  result.frequencyCount = peaks.length;
  if (!peaks.length) return result;
  const anchors = [];
  if (peaks[0][0] > startKHz) anchors.push([startKHz, -90]);
  peaks.forEach((peak,index) => {
    if (index > 0) anchors.push([(peaks[index-1][0]+peak[0])/2, -90]);
    anchors.push(peak);
  });
  if (peaks[peaks.length-1][0] < endKHz) anchors.push([endKHz, -90]);
  result.points.push({frequencyKHz:anchors[0][0], levelDbm:anchors[0][1]});
  for (let i = 1; i < anchors.length; i++) {
    const [fromKHz, fromDbm] = anchors[i-1], [toKHz, toDbm] = anchors[i];
    for (let step = 1; step <= 12; step++) {
      const t = step/12, eased = (1-Math.cos(Math.PI*t))/2;
      result.points.push({frequencyKHz:step === 12 ? toKHz : fromKHz+(toKHz-fromKHz)*t,
        levelDbm:step === 12 ? toDbm : fromDbm+(toDbm-fromDbm)*eased});
    }
  }
  return result;
}

function calculateCanvasBackingSize(cssWidth, cssHeight, devicePixelRatio = 1) {
  const width = Math.max(1, Math.round(Number(cssWidth) || 1));
  const height = Math.max(1, Math.round(Number(cssHeight) || 1));
  const ratio = Math.max(1, Math.min(3, Number(devicePixelRatio) || 1));
  return {
    cssWidth: width,
    cssHeight: height,
    pixelRatio: ratio,
    backingWidth: Math.round(width * ratio),
    backingHeight: Math.round(height * ratio),
  };
}

function _prepareSpectrumCanvas(canvas) {
  // 显示尺寸由固定比例的外层控制；Canvas backing-store 尺寸不得反向参与布局。
  const layoutElement = canvas.parentElement || canvas;
  const rect = typeof layoutElement.getBoundingClientRect === 'function' ? layoutElement.getBoundingClientRect() : null;
  const cssWidth = rect?.width || canvas.clientWidth || canvas.width || 1050;
  const cssHeight = rect?.height || canvas.clientHeight || canvas.height || 380;
  const deviceRatio = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
  const size = calculateCanvasBackingSize(cssWidth, cssHeight, deviceRatio);
  if (canvas.width !== size.backingWidth) canvas.width = size.backingWidth;
  if (canvas.height !== size.backingHeight) canvas.height = size.backingHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (typeof ctx.setTransform === 'function') ctx.setTransform(size.pixelRatio, 0, 0, size.pixelRatio, 0, 0);
  return {ctx, W: size.cssWidth, H: size.cssHeight};
}

/** 统计当前显示范围内、去重后的设备工作频点。频率单位：设备 kHz，范围 MHz。 */
function countDeviceFrequencyPoints(devices, startMHz, endMHz) {
  const minKHz = Number(startMHz) * 1000;
  const maxKHz = Number(endMHz) * 1000;
  if (!Array.isArray(devices) || !Number.isFinite(minKHz) || !Number.isFinite(maxKHz) || maxKHz <= minKHz) return 0;
  return new Set(devices
    .map(device => Number(device && device.freq))
    .filter(freqKHz => Number.isFinite(freqKHz) && freqKHz >= minKHz && freqKHz <= maxKHz)
    .map(freqKHz => Math.round(freqKHz))).size;
}

/** 频谱设备层只接收 FAshe 当前在线通道，排除手动/演示/离线数据。 */
function filterRealtimeFasheDevices(devices) {
  return (Array.isArray(devices) ? devices : []).filter(device =>
    !!device && !!device._fasheId
      && (typeof _deviceConnectionIsOnline === 'function'
        ? _deviceConnectionIsOnline(device)
        : (![device._online,device.online].some(value => value === false || value === 0
            || typeof value === 'string' && ['false','0','offline','disconnected','timeout','unavailable'].includes(value.trim().toLowerCase()))
          && !['offline','disconnected','timeout','unavailable'].includes(String(device.status || '').trim().toLowerCase())))
  );
}

function getFasheSpectrumSourceState(connected, deviceCount, lastUpdateAt = null, products = '接收机') {
  const updateText = lastUpdateAt !== null && lastUpdateAt !== undefined && Number.isFinite(Number(lastUpdateAt))
    ? new Date(Number(lastUpdateAt)).toLocaleTimeString('zh-CN', {hour12: false})
    : '--:--:--';
  if (connected && deviceCount > 0) {
    return {statusPrefix: `${products} 实时 · ${deviceCount}个设备频点`, sourceText: `${products} 实时 · ${updateText}`, tone: 'b-g'};
  }
  if (connected) return {statusPrefix: `${products} 已连接 · 等待设备频点`, sourceText: `${products} 实时 · 等待数据`, tone: 'b-a'};
  if (deviceCount > 0) return {statusPrefix: `${products} 已断开 · 最后${deviceCount}个设备频点`, sourceText: `${products} 已断开 · ${updateText}`, tone: 'b-a'};
  return {statusPrefix: '等待接收机实时设备数据', sourceText: '接收机未连接', tone: 'b-a'};
}

/** 按实际带宽合并占用区；仅真正相交的区间才会合并。 */
function mergeOccupiedFrequencyRanges(devices, bandwidthKHz = 200) {
  const halfBandwidth = Math.max(0, Number(bandwidthKHz)) / 2;
  const ranges = (Array.isArray(devices) ? devices : [])
    .map(device => Number(device && device.freq))
    .filter(Number.isFinite)
    .map(freqKHz => [freqKHz - halfBandwidth, freqKHz + halfBandwidth])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  ranges.forEach(range => {
    const previous = merged[merged.length - 1];
    if (!previous || range[0] > previous[1]) merged.push([...range]);
    else previous[1] = Math.max(previous[1], range[1]);
  });
  return merged;
}

/** 为相邻通道标签分配最多三条纵向轨道，避免文字覆盖。 */
function assignMarkerLabelLanes(markerXs, labelWidths, laneCount = 3, gapPx = 6) {
  const laneEnds = Array.from({length: Math.max(1, laneCount)}, () => -Infinity);
  return markerXs.map((x, index) => {
    const width = Math.max(18, Number(labelWidths[index]) || 18);
    const start = x - width / 2;
    let lane = laneEnds.findIndex(end => start >= end + gapPx);
    if (lane < 0) lane = laneEnds.indexOf(Math.min(...laneEnds));
    laneEnds[lane] = x + width / 2;
    return lane;
  });
}

/** 频点近看：两端各留半个平均频点间距；单一频点才使用 2 MHz 兜底。 */
function calculateSpectrumFitRange(devices, minimumSpanMHz = 2) {
  const frequencies = [...new Set((Array.isArray(devices) ? devices : [])
    .map(device => device?.freq)
    .filter(value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '')
      && Number.isInteger(Number(value)) && Number(value) > 0)
    .map(Number))].sort((a,b) => a-b);
  if (!frequencies.length) return null;
  const minKHz = frequencies[0], maxKHz = frequencies[frequencies.length - 1];
  const fallback = Number.isFinite(Number(minimumSpanMHz)) && Number(minimumSpanMHz) > 0 ? Number(minimumSpanMHz) : 2;
  const paddingKHz = frequencies.length > 1 ? (maxKHz-minKHz)/(frequencies.length-1)/2 : fallback*1000/2;
  // 向外取整到 kHz，防止三位 MHz 输入框舍入后裁掉边缘频点。
  return [Math.max(0, Math.floor(minKHz-paddingKHz))/1000, Math.ceil(maxKHz+paddingKHz)/1000];
}

/** 等分坐标值，与 flex 等距标签使用同一真实线性 MHz 比例。 */
function getSpectrumAxisTicks(startMHz, endMHz, segments = 10) {
  if (!Number.isFinite(startMHz) || !Number.isFinite(endMHz) || endMHz <= startMHz) return [];
  return Array.from({length:segments+1},(_,i) => startMHz+(endMHz-startMHz)*i/segments);
}

function spectrumFrequencyX(freqKHz, startMHz, endMHz, width) {
  return (freqKHz-startMHz*1000)/((endMHz-startMHz)*1000)*width;
}

/** 频率 40 等分；RF 从 -30 到 -90 dBm 每 5 dBm 一条，位置与数据共用映射。 */
function getSpectrumGrid(width, height) {
  return {
    vertical: Array.from({length: 41}, (_, i) => ({x: width * i / 40, major: i % 4 === 0})),
    horizontal: Array.from({length: 13}, (_, i) => ({
      y: height - _scanDbmToNormalized(-30 - i * 5) * height * 0.9, major: i % 4 === 0,
    })),
  };
}

/** 圆点附近按距离命中，频率始终来自设备数据而非鼠标横坐标。 */
function findSpectrumPoint(markers, x, y, radius = 10) {
  let closest = null, distanceSquared = radius * radius;
  for (const marker of markers) {
    const distance = (marker.x - x) ** 2 + (marker.y - y) ** 2;
    if (distance <= distanceSquared) { closest = marker; distanceSquared = distance; }
  }
  return closest;
}

/** 圆点 + 已绘制竖线均可悬停；线身容差 5px，只选最近的实际通道。 */
function findSpectrumMarker(markers, x, y, baseline) {
  let closest = findSpectrumPoint(markers, x, y);
  let distanceSquared = closest ? (closest.x - x) ** 2 + (closest.y - y) ** 2 : Infinity;
  for (const marker of markers) {
    if (y < marker.y || y > baseline) continue;
    const distance = (marker.x - x) ** 2;
    // 同频重叠时保留圆点优先，避免在该圆点上选到另一条经过这里的线。
    if (distance <= 25 && distance < distanceSquared) { closest = marker; distanceSquared = distance; }
  }
  return closest;
}

/** 命中已绘制的仿真折线或底部避让带；二分查找，不在 pointermove 中重算 IMD。 */
function findSpectrumSimulationPoint(simulation, x, y, width, height) {
  const points = simulation?.result?.points;
  if (!simulation?.result || width <= 0 || height <= 0 || x < 0 || x > width || y < 0 || y > height) return null;
  const frequencyKHz = (simulation.startMHz + x / width * (simulation.endMHz - simulation.startMHz)) * 1000;
  const contains = range => frequencyKHz >= range.startKHz && frequencyKHz <= range.endKHz;
  const containsGuard = range => globalThis.DatyRfSimulation?.containsGuardRange
    ? globalThis.DatyRfSimulation.containsGuardRange(range,frequencyKHz)
    : (range.openStart ? frequencyKHz > range.startKHz : frequencyKHz >= range.startKHz)
      && (range.openEnd ? frequencyKHz < range.endKHz : frequencyKHz <= range.endKHz);
  const guardRange = simulation.result.guardRanges.find(containsGuard);
  const onGuard = y >= height - 5 && !!guardRange;
  if (!points?.length) return onGuard ? {x,y:height-3,frequencyKHz,levelDbm:null,guardRange} : null;
  let low = 0, high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (points[mid].frequencyKHz < frequencyKHz) low = mid + 1; else high = mid;
  }
  const right = points[low], left = points[Math.max(0, low - 1)];
  const weight = right.frequencyKHz === left.frequencyKHz ? 0
    : Math.max(0, Math.min(1, (frequencyKHz - left.frequencyKHz) / (right.frequencyKHz - left.frequencyKHz)));
  const levelDbm = left.levelDbm + (right.levelDbm - left.levelDbm) * weight;
  const leftY = height - _scanDbmToNormalized(left.levelDbm) * height * .9;
  const rightY = height - _scanDbmToNormalized(right.levelDbm) * height * .9;
  const curveY = leftY + (rightY - leftY) * weight;
  if (Math.abs(y - curveY) > 8 && !onGuard) return null;
  return {x, y: onGuard ? height - 3 : curveY, frequencyKHz, levelDbm, guardRange,
    range: simulation.result.ranges.find(contains),possibleRange:simulation.result.possibleRanges?.find(contains)};
}

// 每个横向像素保留首尾、最大和最小值，避免宽频段压缩时窄峰被抽样丢失。
// 只压缩绘制路径，不修改数学模型/原始CSV；悬停复用同一条已绘制路径。
function reduceSpectrumTraceForPixels(points,startMHz,endMHz,width) {
  if (!Array.isArray(points) || !points.length) return [];
  const pixels=Math.max(1,Math.floor(width));
  if (!Number.isFinite(pixels) || endMHz<=startMHz || points.length<=pixels*4) return points;
  const result=[];
  let bucket=null;
  const flush=()=>{
    if(!bucket)return;
    for(const index of [...new Set([bucket.first,bucket.low,bucket.high,bucket.last])].sort((a,b)=>a-b)) result.push(points[index]);
  };
  for(let i=0;i<points.length;i++){
    const pixel=Math.max(0,Math.min(pixels-1,Math.floor(spectrumFrequencyX(points[i].frequencyKHz,startMHz,endMHz,pixels))));
    if(!bucket||bucket.pixel!==pixel){flush();bucket={pixel,first:i,last:i,low:i,high:i};}
    else{
      bucket.last=i;
      if(points[i].levelDbm<points[bucket.low].levelDbm)bucket.low=i;
      if(points[i].levelDbm>points[bucket.high].levelDbm)bucket.high=i;
    }
  }
  flush();return result;
}

function _renderSpectrumPointTooltip(canvas, state) {
  const {tooltip, pointer, markers, width, height, simulation} = state;
  if (!pointer) {
    if (!tooltip.hidden) tooltip.hidden = true;
    if (canvas.style.cursor) canvas.style.cursor = '';
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const pointerX = (pointer.x - rect.left) / rect.width * width;
  const pointerY = (pointer.y - rect.top) / rect.height * height;
  const marker = rect.width > 0 && rect.height > 0
    ? findSpectrumMarker(markers, pointerX, pointerY, height) : null;
  const modeled = !marker && rect.width > 0 && rect.height > 0
    ? findSpectrumSimulationPoint(simulation, pointerX, pointerY, width, height) : null;
  if (!marker && !modeled) {
    tooltip.hidden = true;
    canvas.style.cursor = '';
    return;
  }
  const rangeText = (label, range) => range ? `\n${label} ${(range.startKHz/1000).toFixed(3)}–${(range.endKHz/1000).toFixed(3)} MHz` : '';
  const text = marker ? `${_formatSpectrumChannelLabel(marker.device, marker.index)} · ${(marker.freqKHz / 1000).toFixed(3)} MHz${marker.rfDbm === null ? ' · RF 未知' : ''}`
    : `仿真 ${(modeled.frequencyKHz/1000).toFixed(3)} MHz · ${modeled.levelDbm===null?'RF 未知，仅显示规则范围':'≈ '+modeled.levelDbm.toFixed(1)+' dBm（情景值）'}`
      + rangeText('平滑超阈范围', modeled.range) + (!modeled.range?rangeText('纹理可能越阈', modeled.possibleRange):'')
      + rangeText('全场保守避让', modeled.guardRange);
  if (tooltip.textContent !== text) tooltip.textContent = text;
  tooltip.style.borderColor = marker ? '#10b981' : '#fbbf24';
  tooltip.hidden = false;
  canvas.style.cursor = 'crosshair';
  // DOM 原生清晰字体；边缘翻转/夹取，不扩大固定画布，不截断首尾通道的提示。
  const plotWidth = canvas.parentElement.clientWidth, plotHeight = canvas.parentElement.clientHeight;
  const anchor = marker || modeled;
  const pointX = anchor.x / width * plotWidth;
  // 悬停线身时提示跟随鼠标所在高度，不固定在远处的圆点顶端。
  const pointY = Math.max(anchor.y, Math.min(height, pointerY)) / height * plotHeight;
  const left = pointX + 12 + tooltip.offsetWidth <= plotWidth - 4 ? pointX + 12 : pointX - tooltip.offsetWidth - 12;
  const top = pointY - tooltip.offsetHeight - 10 >= 4 ? pointY - tooltip.offsetHeight - 10 : pointY + 10;
  tooltip.style.left = `${Math.max(4, Math.min(plotWidth - tooltip.offsetWidth - 4, left))}px`;
  tooltip.style.top = `${Math.max(4, Math.min(plotHeight - tooltip.offsetHeight - 4, top))}px`;
}

function _updateSpectrumPointHover(canvas, markers, width, height, simulation = null) {
  const tooltip = document.getElementById('spectrumPointTooltip');
  if (!tooltip || typeof canvas.addEventListener !== 'function') return;
  let state = spectrumPointHoverStates.get(canvas);
  if (!state) {
    state = {tooltip, pointer: null};
    spectrumPointHoverStates.set(canvas, state);
    canvas.addEventListener('pointermove', event => {
      state.pointer = {x: event.clientX, y: event.clientY};
      _renderSpectrumPointTooltip(canvas, state);
    });
    canvas.addEventListener('pointerleave', () => {
      state.pointer = null;
      _renderSpectrumPointTooltip(canvas, state);
    });
  }
  Object.assign(state, {tooltip, markers, width, height, simulation});
  // 遥测、范围、窗口大小变化后重新命中，移走/离线的点不留下旧频率提示。
  _renderSpectrumPointTooltip(canvas, state);
}

function _formatSpectrumChannelLabel(device, index) {
  if (typeof formatChannelDisplay === 'function') return formatChannelDisplay(device);
  const raw = device?.channel_number ?? device?.channel_no ?? device?.channel ?? device?.ch ?? device?.channel_key;
  const marked = String(raw ?? '').match(/(?:^|[^a-z])(?:channel|ch)\s*[-_:#\s]*[^0-9\s]{0,4}\s*(\d+)/i);
  const number = /^\d+$/.test(String(raw ?? '').trim()) ? Number(raw) : (marked ? Number(marked[1]) : null);
  return Number.isInteger(number) && number > 0 ? `CH${number}` : 'CH?';
}

/** 使用原生 DOM 渲染 CH 标签，避免 Canvas 位图缩放造成字体模糊。 */
function _patchSpectrumChannelLabels(markers, canvasWidth, layerId = 'spectrumChannelLabels') {
  const layer = document.getElementById(layerId);
  if (!layer) return;
  const labels = markers.map(marker => _formatSpectrumChannelLabel(marker.device, marker.index));
  const labelWidths = labels.map(label => Math.max(18, label.length * 6));
  const labelOnRight = markers.map((marker,i) => marker.x + labelWidths[i] + 7 <= canvasWidth);
  // 边缘标签会翻到频线左侧，轨道碰撞必须按文字实际位置判断，不能只用频线中心。
  const labelCenters = markers.map((marker,i) => marker.x + (labelOnRight[i] ? 5+labelWidths[i]/2 : -5-labelWidths[i]/2));
  const lanes = assignMarkerLabelLanes(labelCenters, labelWidths, 3, 5);
  const existing = new Map(Array.from(layer.children).map(element => [element.dataset.deviceKey, element]));
  const activeKeys = new Set();

  markers.forEach((marker, index) => {
    const key = String(marker.device._fasheId || marker.device.id || labels[index]);
    activeKeys.add(key);
    let labelElement = existing.get(key);
    if (!labelElement) {
      labelElement = document.createElement('span');
      labelElement.dataset.deviceKey = key;
      layer.appendChild(labelElement);
    }
    const placeRight = labelOnRight[index];
    labelElement.className = `spectrum-channel-label${placeRight ? '' : ' is-left'}`;
    labelElement.textContent = labels[index];
    labelElement.style.left = `${Math.max(0, Math.min(100, marker.x / canvasWidth * 100))}%`;
    labelElement.style.bottom = `${5 + lanes[index] * 14}px`;
    const rfText = Number.isFinite(Number(marker.device.rf)) ? `${Number(marker.device.rf)} dBm` : 'RF --';
    labelElement.title = `${labels[index]} · ${(marker.freqKHz / 1000).toFixed(3)} MHz · ${rfText}`;
  });

  existing.forEach((element, key) => {
    if (!activeKeys.has(key)) element.remove();
  });
}

function getSpectrumDisplayState(scanPointCount, sourceName = '') {
  if (scanPointCount >= 2) {
    const source = String(sourceName || 'CSV').trim();
    return {statusText: `● 已载入 ${source} · ${scanPointCount}点`, statusTone: 'b-c', scanDataText: `${scanPointCount}点`};
  }
  return {statusText: '● 仅显示设备频点（未载入频谱扫描）', statusTone: 'b-a', scanDataText: '未载入'};
}

function updateSpectrumDataSummary() {
  const [startMHz, endMHz] = getSpectrumRangeMHz();
  const allDevices = typeof DEVICES !== 'undefined' ? DEVICES : [];
  const devices = filterRealtimeFasheDevices(allDevices);
  const deviceCount = countDeviceFrequencyPoints(devices, startMHz, endMHz);
  const pointCount = scanSource === 'imported' ? importedScanPoints.length : 0;
  const state = getSpectrumDisplayState(pointCount, importedScanSourceName);
  const realtime = typeof getFasheRealtimeStatus === 'function'
    ? getFasheRealtimeStatus()
    : {connected: false, lastUpdateAt: null};
  const products = typeof formatReceiverProductSummary === 'function' ? formatReceiverProductSummary(devices) : '接收机';
  const sourceState = getFasheSpectrumSourceState(realtime.connected, deviceCount, realtime.lastUpdateAt, products);
  const status = document.getElementById('scanStatus');
  const available = document.getElementById('scanAvailableCount');
  const frequencyCount = document.getElementById('deviceFrequencyCount');
  const scanState = document.getElementById('scanDataState');
  const deviceSource = document.getElementById('deviceDataSource');
  if (status) {
    const scanSuffix = pointCount >= 2 ? ` + ${importedScanSourceName || 'CSV'} · ${pointCount}点` : '（未载入频谱扫描）';
    status.textContent = `● ${sourceState.statusPrefix}${scanSuffix}`;
    status.className = `badge ${sourceState.tone}`;
  }
  // 未经过频率规划时不推测“可用频点”数量。
  if (available) available.textContent = '--';
  if (frequencyCount) frequencyCount.textContent = String(deviceCount);
  if (scanState) scanState.textContent = state.scanDataText;
  if (deviceSource) {
    deviceSource.textContent = sourceState.sourceText;
    deviceSource.title = typeof formatReceiverProductSummary === 'function' ? formatReceiverProductSummary(devices, Infinity) : products;
  }
}

function _resampleImportedScan(totalPoints = 512) {
  if (importedScanPoints.length < 2) return [];
  const startKHz = importedScanPoints[0].frequencyKHz;
  const endKHz = importedScanPoints[importedScanPoints.length - 1].frequencyKHz;
  return Array.from({length: totalPoints}, (_, index) => {
    const frequencyKHz = startKHz + (endKHz - startKHz) * index / (totalPoints - 1);
    const level = DatyCoordination.getScanLevelDbm(importedScanPoints, frequencyKHz);
    return _scanDbmToNormalized(level === null ? -100 : level);
  });
}

/** 装载真实扫描数据。points 必须为 kHz + dBm。 */
function setImportedScanPoints(points, sourceName = 'CSV') {
  if (!Array.isArray(points) || points.length < 2) throw new Error('至少需要两个扫描点');
  const validated = DatyCoordination.prepareScan(points).points;
  if (validated.length < 2) throw new Error('扫描点格式无效');
  importedScanPoints = Object.freeze(validated.map(point => Object.freeze(point)));
  if (typeof invalidateCoordination === 'function') invalidateCoordination('扫描数据已更新，请重新规划');
  scanSource = 'imported';
  importedScanSourceName = String(sourceName || 'CSV').trim();
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  scanData = _resampleImportedScan();
  const planner = document.getElementById('plannerRange');
  if (planner && globalThis.DatyPlanningConstraints?.syncFrequencyRange) {
    planner.value = 'scan';
    globalThis.DatyPlanningConstraints.syncFrequencyRange();
  } else {
    // 独立图表宿主仍支持载入扫描；主页面由规划范围统一派生显示留白。
    document.getElementById('specStart').value = DatyFrequency.formatFrequencyMHz(importedScanPoints[0].frequencyKHz, 3);
    document.getElementById('specEnd').value = DatyFrequency.formatFrequencyMHz(importedScanPoints[importedScanPoints.length - 1].frequencyKHz, 3);
    updateRangeDisplay();
  }
  drawSpectrum();
}

function getCurrentScanPoints() {
  return scanSource === 'imported' ? importedScanPoints.map(point => ({...point})) : [];
}

function clearImportedScan() {
  if (globalThis.DatyBusinessDatabase && !globalThis.DatyBusinessDatabase.hydrating) return globalThis.DatyBusinessDatabase.clearCurrentScan();
  if (typeof invalidateCoordination === 'function') invalidateCoordination('扫描数据已清除，请重新规划');
  importedScanPoints = [];
  scanSource = 'none';
  importedScanSourceName = '';
  if (document.getElementById('plannerRange')?.value === 'scan') globalThis.DatyPlanningConstraints?.syncFrequencyRange();
  initScanData();
  drawSpectrum();
  notify('🧹','扫描数据已清除','已移除实测扫描；设备频点与可选计算曲线仍为独立显示层');
}

function drawSpectrum() {
  if (typeof DatyRfSimulationView !== 'undefined') DatyRfSimulationView.clearDisplay();
  const canvas = document.getElementById('spectrumCanvas');
  if(!canvas) return;
  const prepared = _prepareSpectrumCanvas(canvas);
  if (!prepared) return;
  const {ctx, W, H} = prepared;
  ctx.clearRect(0,0,W,H);
  const [startFreq, endFreq] = getSpectrumRangeMHz();

  // 加密主/次网格；不增加坐标文字，避免密集字体重叠。
  const grid = getSpectrumGrid(W, H);
  ctx.lineWidth = 1;
  grid.vertical.forEach(({x, major}) => {
    ctx.strokeStyle = major ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.04)';
    ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();
  });
  grid.horizontal.forEach(({y, major}) => {
    ctx.strokeStyle = major ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.04)';
    ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();
  });

  // Spectrum fill - map to dBm range (-90 to -30)
  if(scanData.length > 0) {
    // 近看/恢复范围时扫描轨迹仍按原 CSV 的真实频率定位，不能随画布横向拉伸。
    const scanX = i => scanSource === 'imported' && importedScanPoints.length >= 2
      ? spectrumFrequencyX(importedScanPoints[0].frequencyKHz
          + (importedScanPoints[importedScanPoints.length-1].frequencyKHz-importedScanPoints[0].frequencyKHz)*i/Math.max(1,scanData.length-1), startFreq,endFreq,W)
      : i*W/Math.max(1,scanData.length-1);
    ctx.beginPath();
    ctx.moveTo(scanX(0), H);
    scanData.forEach((v,i) => {
      // Map v (0-1) to dBm position: -90dBm=H, -30dBm=H*0.1
      const y = H - v * (H * 0.9);
      ctx.lineTo(scanX(i), y);
    });
    ctx.lineTo(scanX(scanData.length-1), H);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0,0,0,H);
    grad.addColorStop(0,'rgba(99,102,241,0.6)');
    grad.addColorStop(0.6,'rgba(99,102,241,0.2)');
    grad.addColorStop(1,'rgba(99,102,241,0.0)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    scanData.forEach((v,i) => {
      const y = H - v * (H * 0.9);
      i===0 ? ctx.moveTo(scanX(i), y) : ctx.lineTo(scanX(i), y);
    });
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // 设备通道中心频率与 RF 点：只绘制范围内有有效频率的真实通道。
  const minFreq = startFreq * 1000;
  const maxFreq = endFreq * 1000;
  const fasheDevices = filterRealtimeFasheDevices(DEVICES);
  const markers = fasheDevices
    .map((device, index) => ({device, index, freqKHz: Number(device.freq)}))
    .filter(item => (typeof item.device.freq === 'number' || typeof item.device.freq === 'string' && item.device.freq.trim() !== '')
      && Number.isSafeInteger(item.freqKHz) && item.freqKHz > 0 && item.freqKHz >= minFreq && item.freqKHz <= maxFreq)
    .map(item => ({...item, x: spectrumFrequencyX(item.freqKHz,startFreq,endFreq,W)}))
    .sort((a, b) => a.x - b.x);

  // 两种计算图层均独立于真实 CSV、规划与控制；参数变化只使本图重算。
  const envelopeEnabled = document.getElementById('specDeviceEnvelope')?.checked !== false;
  const curveMode = document.getElementById('specCurveMode')?.value || 'envelope';
  let envelope = null, simulation = null, simulationError = '';
  if (envelopeEnabled) {
    if (curveMode === 'simulation') {
      try {
        if (typeof DatyRfSimulationView === 'undefined') throw new Error('仿真模块未加载，请刷新页面');
        simulation = DatyRfSimulationView.get(fasheDevices,startFreq,endFreq);
      } catch(error) { simulationError = error.message || String(error); }
    } else envelope = buildDeviceRfEnvelope(fasheDevices, startFreq, endFreq);
  }
  if (simulation) {
    ctx.fillStyle='rgba(245,158,11,0.035)';
    (simulation.possibleRanges||[]).forEach(range=>{
      const left=spectrumFrequencyX(range.startKHz,startFreq,endFreq,W),right=spectrumFrequencyX(range.endKHz,startFreq,endFreq,W);
      ctx.fillRect(left,0,Math.max(0,right-left),H);
    });
    ctx.fillStyle='rgba(245,158,11,0.08)';
    simulation.ranges.forEach(range=>{
      const left=spectrumFrequencyX(range.startKHz,startFreq,endFreq,W),right=spectrumFrequencyX(range.endKHz,startFreq,endFreq,W);
      ctx.fillRect(left,0,Math.max(0,right-left),H);
    });
    ctx.fillStyle='rgba(96,165,250,0.45)';
    simulation.guardRanges.forEach(range=>{
      const left=spectrumFrequencyX(range.startKHz,startFreq,endFreq,W),right=spectrumFrequencyX(range.endKHz,startFreq,endFreq,W);
      ctx.fillRect(left,H-3,Math.max(0,right-left),3);
    });
    if (simulation.points.length && simulation.options.thresholdDbm>=-90 && simulation.options.thresholdDbm<=-30) {
      const thresholdY=H-_scanDbmToNormalized(simulation.options.thresholdDbm)*H*.9;
      ctx.setLineDash?.([4,4]);ctx.lineWidth=1;ctx.strokeStyle='#f59e0b';
      ctx.beginPath();ctx.moveTo(0,thresholdY);ctx.lineTo(W,thresholdY);ctx.stroke();ctx.setLineDash?.([]);
    }
  }
  const trace = simulation?.points || envelope?.points;
  const displayTrace = simulation ? reduceSpectrumTraceForPixels(trace,startFreq,endFreq,W) : trace;
  if (trace?.length) {
    ctx.beginPath();
    displayTrace.forEach((point,index) => {
      const x = spectrumFrequencyX(point.frequencyKHz,startFreq,endFreq,W);
      const y = H-_scanDbmToNormalized(point.levelDbm)*H*.9;
      index === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  const envelopeState = document.getElementById('deviceEnvelopeState');
  if (envelopeState) {
    envelopeState.textContent = !envelopeEnabled ? '计算曲线已隐藏' : simulationError ? `仿真未生成：${simulationError}`
      : simulation ? `仿真 · ${simulation.stats.frequencyCount}个频点 · ${simulation.stats.imdProductCount}个互调候选 · ${simulation.ranges.length}段平滑超阈${simulation.stats.missingRfCount ? ` · ${simulation.stats.missingRfCount}路 RF 未知` : ''}${simulation.coverage?.complete===false?' · 互调未完整计算':''}${simulation.warnings.length ? ' · 说明见明细' : ''}`
      : envelope?.frequencyCount ? `示意 · ${envelope.frequencyCount}个峰${envelope.missingRfCount ? ` · ${envelope.missingRfCount}通道 RF 未知` : ''}`
      : envelope?.missingRfCount ? `暂无有效 RF · ${envelope.missingRfCount}通道 RF 未知` : '等待范围内有效 RF';
    envelopeState.title = simulation?.warnings.join('\n') || '';
  }
  const curveNote=document.getElementById('spectrumCurveNote'),rangeLegend=document.getElementById('simulationRangeLegend');
  if (rangeLegend) rangeLegend.hidden = curveMode !== 'simulation' || !envelopeEnabled;
  if (curveNote) curveNote.textContent = curveMode === 'simulation'
    ? simulation ? `情景假设：峰宽 ${simulation.options.peakWidthKHz} kHz · 噪底 ${simulation.options.floorDbm} dBm · 阈值 ${simulation.options.thresholdDbm} dBm；RF非同一测量点，不能预测实际互调功率，不参与规划。`
      : '仿真参数可调整，实际范围需扫描校准；仅影响此视图。'
    : '峰宽仅为视觉插值；下沿 −90 dBm 不是实测噪底。平滑示意不参与规划或 IMD。';

  markers.forEach(marker => {
    const {device: d, x} = marker;
    const rfDbm = getSpectrumRfDbm(d.rf);
    marker.rfDbm = rfDbm;
    const normalized = _scanDbmToNormalized(rfDbm === null ? -90 : rfDbm);
    const y = H - normalized * (H * 0.9);
    marker.y = y;
    // 频谱频点层统一为绿色，不再绘制红色竖条；告警及通道卡配色仍由原阈值控制。
    // 缺失 RF 只保留灰色频点标识，不画满格或伪造 RF 竖线。
    const color = rfDbm === null ? '#7c8db5' : '#10b981';
    if (rfDbm !== null) {
      ctx.beginPath();
      ctx.moveTo(x, H);
      ctx.lineTo(x, y);
      ctx.strokeStyle = color + '99';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI*2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  _patchSpectrumChannelLabels(markers, W);
  _updateSpectrumPointHover(canvas, markers, W, H, simulation ? {result:{...simulation,points:displayTrace},startMHz:startFreq,endMHz:endFreq} : null);
  updateSpectrumDataSummary();
}

// 保持旧接口无扫描数据返回值；设备 RF 包络只供画图，不能冒充扫描导入。
function generateSpectrumFromDevices() {
  return [];
}

// 计算设备占用的频段区域
function calculateOccupiedZones() {
  const fasheDevices = filterRealtimeFasheDevices(typeof DEVICES !== 'undefined' ? DEVICES : []);
  if (fasheDevices.length === 0) return [];
  
  const [startFreq, endFreq] = getSpectrumRangeMHz();
  const minFreq = startFreq * 1000;
  const maxFreq = endFreq * 1000;
  const freqRange = maxFreq - minFreq;
  return mergeOccupiedFrequencyRanges(fasheDevices, 200)
    .filter(([startKHz, endKHz]) => endKHz >= minFreq && startKHz <= maxFreq)
    .map(([startKHz, endKHz]) => [
      Math.max(0, (startKHz - minFreq) / freqRange),
      Math.min(1, (endKHz - minFreq) / freqRange),
    ]);
}

function initScanData() {
  scanData = scanSource === 'imported' ? _resampleImportedScan() : [];
}

function updateRangeDisplay(persist = true) {
  const start = document.getElementById('specStart').value;
  const end = document.getElementById('specEnd').value;
  const range = readSpectrumRangeMHz();
  for (const id of ['specStart','specEnd']) document.getElementById(id)?.setAttribute?.('aria-invalid', String(!range));
  if (!range) return false;
  lastValidSpectrumRange = range;
  document.getElementById('rangeDisplay').textContent = start + '–' + end;
  // 更新主页规划范围显示
  const planRangeEl = document.getElementById('planRangeDisplay');
  if (planRangeEl) {
    let planningRange;
    try { planningRange = globalThis.DatyPlanningConstraints?.readPlanningRange(); } catch (_) { /* 尚未完成有效范围 */ }
    planRangeEl.textContent = planningRange
      ? `规划范围 ${(planningRange.rangeStartKHz / 1000).toFixed(3)}–${(planningRange.rangeEndKHz / 1000).toFixed(3)} MHz`
      : '规划范围 ' + start + '–' + end + ' MHz';
  }
  // 更新主页中心频率显示
  const centerFreq = ((parseFloat(start) + parseFloat(end)) / 2).toFixed(3);
  const centerFreqEl = document.getElementById('statCenterFreq');
  if(centerFreqEl) centerFreqEl.textContent = centerFreq;
  // 保存到平台存储，保留原键名与 MHz 字符串。
  if (persist) {
    try {
      const storage = globalThis.DatyPlatform === undefined ? localStorage : globalThis.DatyPlatform.storage;
      storage.setItem('specStartFreq', String(start));
      storage.setItem('specEndFreq', String(end));
    } catch (error) { console.warn('[频率范围] 当前范围已更新，但本机显示偏好未保存', error); }
  }
  renderFreqAxis(); // 更新X轴显示
  updateSpectrumDataSummary();
  // 两图使用同一组手动/适配范围，沿用现有刷新链，不新增轮询。
  if (document.getElementById('panel-spectrum')?.classList.contains('active')) drawSpectrum();
  if (document.getElementById('panel-dashboard')?.classList.contains('active')) drawRFBarChart();
}

function fitSpectrumToDevices() {
  const range = calculateSpectrumFitRange(filterRealtimeFasheDevices(typeof DEVICES !== 'undefined' ? DEVICES : []));
  if (!range) {
    notify('⚠️','无法适配设备','当前没有带有效工作频率的设备');
    return;
  }
  const startInput = document.getElementById('specStart');
  const endInput = document.getElementById('specEnd');
  if (!spectrumRangeBeforeFit) spectrumRangeBeforeFit = [startInput.value, endInput.value];
  startInput.value = range[0].toFixed(3);
  endInput.value = range[1].toFixed(3);
  updateRangeDisplay(false);
  drawSpectrum();
  notify('⤢','已适配设备',`显示范围 ${startInput.value}–${endInput.value} MHz`);
}

function restoreSpectrumRange() {
  if (globalThis.DatyPlanningConstraints?.syncFrequencyRange) {
    globalThis.DatyPlanningConstraints.syncFrequencyRange(false);
    drawSpectrum();
    notify('↩','范围已恢复','已恢复为规划范围两侧各扩展 10 MHz');
    return;
  }
  const startInput = document.getElementById('specStart');
  const endInput = document.getElementById('specEnd');
  const storage = globalThis.DatyPlatform === undefined ? localStorage : globalThis.DatyPlatform.storage;
  const fallback = [storage.getItem('specStartFreq') || '400', storage.getItem('specEndFreq') || '900'];
  const range = spectrumRangeBeforeFit || fallback;
  startInput.value = range[0];
  endInput.value = range[1];
  spectrumRangeBeforeFit = null;
  updateRangeDisplay();
  drawSpectrum();
  notify('↩','范围已恢复',`显示范围 ${startInput.value}–${endInput.value} MHz`);
}

// 主页面跟随规划范围；独立图表宿主保留原显示偏好的兼容加载。
function loadSavedFreqRange() {
  if (globalThis.DatyPlanningConstraints?.syncFrequencyRange) {
    // 原手动显示偏好不再覆盖当前规划；保存的项目稍后仍通过原恢复流程加载。
    globalThis.DatyPlanningConstraints.syncFrequencyRange(false);
    return;
  }
  const storage = globalThis.DatyPlatform === undefined ? localStorage : globalThis.DatyPlatform.storage;
  const savedStart = storage.getItem('specStartFreq');
  const savedEnd = storage.getItem('specEndFreq');
  if(savedStart !== null) document.getElementById('specStart').value = savedStart;
  if(savedEnd !== null) document.getElementById('specEnd').value = savedEnd;
  // 更新显示
  const start = savedStart || 400;
  const end = savedEnd || 900;
  document.getElementById('rangeDisplay').textContent = start + '–' + end;
  // 更新主页规划范围显示
  const planRangeEl = document.getElementById('planRangeDisplay');
  if(planRangeEl) planRangeEl.textContent = '规划范围 ' + start + '–' + end + ' MHz';
  // 更新主页中心频率显示
  const centerFreq = ((parseFloat(start) + parseFloat(end)) / 2).toFixed(3);
  const centerFreqEl = document.getElementById('statCenterFreq');
  if(centerFreqEl) centerFreqEl.textContent = centerFreq;
}

function runScan() {
  initScanData();
  if(scanTimer) clearInterval(scanTimer);
  if (scanSource === 'imported') {
    scanTimer = null;
    drawSpectrum();
    notify('✓','真实扫描已载入',`${importedScanPoints.length} 个 CSV 扫描点参与规划`);
    return;
  }
  scanTimer = null;
  drawSpectrum();
  notify('⚠️','没有真实扫描','请先导入接收机或 Wireless Workbench 导出的频谱 CSV');
}

function stopScan() {
  if(scanTimer) {
    clearInterval(scanTimer);
    scanTimer=null;
    notify('■','扫描停止','已停止实时频谱扫描');
    return;
  }
  notify('ℹ️','没有实时扫描任务','当前页面显示的是设备频点或已导入的静态扫描数据');
}

let spectrumResizeTimer = null;
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', () => {
    if (spectrumResizeTimer) clearTimeout(spectrumResizeTimer);
    spectrumResizeTimer = setTimeout(() => {
      spectrumResizeTimer = null;
      const panel = document.getElementById('panel-spectrum');
      if (panel?.classList.contains('active')) { renderFreqAxis(); drawSpectrum(); }
      if (document.getElementById('panel-dashboard')?.classList.contains('active')) drawRFBarChart();
    }, 80);
  });
}

function getRFBarLayout(width, devices, startMHz, endMHz) {
  const left = 56, right = 48;
  const plotWidth = Math.max(0, width - left - right);
  const validRange = Number.isFinite(startMHz) && Number.isFinite(endMHz) && endMHz > startMHz;
  const markers = !validRange ? [] : (Array.isArray(devices) ? devices : [])
    .map((device, index) => ({device, index, freqKHz: Number(device?.freq)}))
    .filter(marker => Number.isInteger(marker.freqKHz) && marker.freqKHz > 0
      && marker.freqKHz >= startMHz * 1000 && marker.freqKHz <= endMHz * 1000)
    .map(marker => ({...marker, x: spectrumFrequencyX(marker.freqKHz, startMHz, endMHz, plotWidth)}))
    .sort((a,b) => a.x-b.x);
  return {left, right, plotWidth, markers, barWidth: Math.min(4, plotWidth / Math.max(1, markers.length) * 0.65)};
}

function drawRFBarChart() {
  const canvas = document.getElementById('rfBarChart');
  if(!canvas) return;
  const container = canvas.parentElement;
  // 隐藏面板不使用 backing-store 尺寸反推布局；可见时与频谱共用高清画布准备。
  if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
  const prepared = _prepareSpectrumCanvas(canvas);
  if (!prepared) return;
  const {ctx, W, H} = prepared;
  ctx.clearRect(0,0,W,H);
  const [startFreq, endFreq] = getSpectrumRangeMHz();
  // 采用真实 MHz 横坐标，不再把 CH 顺序均分后贴上频率刻度。
  const layout = getRFBarLayout(W, DEVICES, startFreq, endFreq);
  const barW = layout.barWidth;
  renderFrequencyAxisLabels(document.getElementById('rfFrequencyAxis'), startFreq, endFreq, layout.plotWidth);
  
  // 与通道卡及告警阈值统一：-90 dBm 为底、-30 dBm 为满量程。
  const minRf = -90, maxRf = -30;
  const bottomPadding = 24;
  const topPadding = 10;
  
  // 绘制网格线
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for(let i = 0; i <= 4; i++) {
    const y = topPadding + (H - topPadding - bottomPadding) * i / 4;
    ctx.beginPath();
    ctx.moveTo(layout.left, y);
    ctx.lineTo(layout.left + layout.plotWidth, y);
    ctx.stroke();
  }
  
  // 绘制Y轴标签
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  const dbmLabels = ['-30', '-45', '-60', '-75', '-90'];
  dbmLabels.forEach((label, i) => {
    const y = topPadding + (H - topPadding - bottomPadding) * i / 4;
    ctx.fillText(label + ' dBm', 4, y + 3);
  });
  
  layout.markers.forEach(marker=>{
    const d = marker.device;
    const x = layout.left + marker.x - barW / 2;
    const normalized = Number.isFinite(Number(d.rf))
      ? Math.max(0, Math.min(1, (Number(d.rf) - minRf) / (maxRf - minRf)))
      : 0;
    const h = normalized * (H - topPadding - bottomPadding);
    const color = typeof _rfMeterColor === 'function' ? _rfMeterColor(d.rf) : '#4a5578';
    
    // 条形背景
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(x, topPadding, barW, H - topPadding - bottomPadding);
    
    // 条形填充
    const grad = ctx.createLinearGradient(0, H - bottomPadding - h, 0, H - bottomPadding);
    grad.addColorStop(0, color);
    grad.addColorStop(1, color + '66');
    ctx.fillStyle = grad;
    ctx.fillRect(x, H - bottomPadding - h, barW, h);
    
    // 顶部高亮
    ctx.fillStyle = color;
    ctx.fillRect(x, H - bottomPadding - h, barW, 2);
    
  });
  // CH 注释移到绘图区内并借用清晰 DOM 字体；密集时按实际像素距离抽样，所有 RF 条仍绘制。
  let previousLabelX = -Infinity;
  const labels = layout.markers.filter(marker => {
    if (marker.x - previousLabelX < 36) return false;
    previousLabelX = marker.x;
    return true;
  });
  _patchSpectrumChannelLabels(labels, layout.plotWidth, 'rfChannelLabels');
}

// ══════════════════ FREQ AXIS ══════════════════
function renderFrequencyAxisLabels(ax, startFreq, endFreq, plotWidth) {
  if (!ax) return;
  const segments = plotWidth > 0 ? Math.max(2,Math.min(10,Math.floor(plotWidth/85))) : 10;
  const labels = getSpectrumAxisTicks(startFreq,endFreq,segments);
  const markup = '<span style="position:relative;display:block;width:100%;height:15px;">' + labels.map((value,i)=>
    `<span style="position:absolute;left:${i/segments*100}%;transform:translateX(${i===0 ? '0' : i===segments ? '-100%' : '-50%'});white-space:nowrap;">${value.toFixed(3).replace(/\.?0+$/, '')} MHz</span>`).join('') + '</span>';
  // 高频遥测不会反复重建未改变的刻度 DOM。
  if (ax.innerHTML !== markup) ax.innerHTML = markup;
}

function renderFreqAxis() {
  const ax = document.getElementById('freqAxis');
  if(!ax) return;
  const [startFreq, endFreq] = getSpectrumRangeMHz();
  renderFrequencyAxisLabels(ax, startFreq, endFreq, ax.clientWidth - 50);
}

