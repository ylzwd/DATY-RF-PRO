// ============================================================
// frequency.js — 浏览器运行时频率单位边界
// 内部统一使用整数 kHz；仅在 API / CSV / UI 边界转换。
// ============================================================
(function (global) {
  'use strict';

  const MIN_RF_FREQUENCY_KHZ = 30000;
  const MAX_RF_FREQUENCY_KHZ = 3000000;

  function toFrequencyKHz(value, unit = 'auto') {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') throw new Error(`无效频率: ${String(value)}`);
    if (typeof value === 'string' && !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) throw new Error(`无效频率: ${value}`);
    const units = {auto:'auto', hz:'Hz', khz:'kHz', mhz:'MHz'};
    unit = units[String(unit).trim().toLowerCase()];
    if (!unit) throw new Error('频率单位必须为 Hz、kHz 或 MHz');
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new Error(`无效频率: ${String(value)}`);
    }

    let khz;
    if (unit === 'Hz') khz = numeric / 1000;
    else if (unit === 'kHz') khz = numeric;
    else if (unit === 'MHz') khz = numeric * 1000;
    else if (numeric >= 30000000) khz = numeric / 1000;
    else if (numeric >= MIN_RF_FREQUENCY_KHZ) khz = numeric;
    else khz = numeric * 1000;

    const rounded = Math.round(khz);
    // 浮点运算允许极小尾差；不把 12.5 kHz 栅格等信息静默四舍五入。
    if (Math.abs(khz - rounded) > 0.000001) throw new Error('频率精度小于 1 kHz，当前整数 kHz 引擎无法无损表示');
    if (rounded < MIN_RF_FREQUENCY_KHZ || rounded > MAX_RF_FREQUENCY_KHZ) {
      throw new Error(`频率超出支持范围: ${rounded} kHz`);
    }
    return rounded;
  }

  function frequencyKHzToMHz(khz) {
    if (!Number.isInteger(khz) || khz < MIN_RF_FREQUENCY_KHZ || khz > MAX_RF_FREQUENCY_KHZ) throw new Error(`无效 kHz 频率: ${String(khz)}`);
    return khz / 1000;
  }

  function formatFrequencyMHz(khz, decimals = 3) {
    return frequencyKHzToMHz(khz).toFixed(decimals);
  }

  function detectFrequencyUnit(header) {
    const normalized = String(header).toLowerCase().replace(/[\s_()\[\]]/g, '');
    if (normalized.includes('mhz')) return 'MHz';
    if (normalized.includes('khz')) return 'kHz';
    if (normalized.includes('hz')) return 'Hz';
    return 'auto';
  }

  function frequencyFromPayload(data, fallback = null) {
    const fields = [['frequency_khz','kHz'],['frequencyKHz','kHz'],['freq_khz','kHz'],
      ['freq_mhz','MHz'],['frequency_mhz','MHz'],['frequencyMHz','MHz'],
      ['freq_hz','Hz'],['frequency_hz','Hz'],['frequencyHz','Hz'],['frequency','auto'],['freq','auto']];
    for (const [key, declaredUnit] of fields) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      const unitKey = ['frequency_unit','frequencyUnit','freq_unit'].find(name => Object.prototype.hasOwnProperty.call(data, name));
      const unit = declaredUnit === 'auto' && unitKey ? data[unitKey] : declaredUnit;
      try { return toFrequencyKHz(data[key], unit); } catch (_) { return null; }
    }
    return fallback;
  }

  global.DatyFrequency = Object.freeze({
    MIN_RF_FREQUENCY_KHZ,
    MAX_RF_FREQUENCY_KHZ,
    toFrequencyKHz,
    frequencyKHzToMHz,
    formatFrequencyMHz,
    detectFrequencyUnit,
    frequencyFromPayload,
  });
})(window);
