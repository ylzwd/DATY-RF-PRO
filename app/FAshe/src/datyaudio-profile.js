(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DATYaudioProfile = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BRAND = 'DATYaudio';
  const DISPLAY_BRAND = 'DATY audio';
  const AF_MIN_DBFS = -40;
  const AF_MAX_DBFS = 0;
  const DEFAULT_AF_DBFS = 0;
  const DEFAULT_RF_DBM = -35;
  const DEFAULT_BATTERY_PERCENT = 100;
  const DEFAULT_MODEL = 'RF PRO';
  const MODELS = Object.freeze([
    Object.freeze({ id: 'RF PRO', label: 'RF PRO', equipmentProfileId: 'datyaudio-generic' }),
    Object.freeze({ id: 'DATY-X1', label: 'DATY-X1', equipmentProfileId: 'datyaudio-generic' }),
    Object.freeze({ id: 'DATY-X2', label: 'DATY-X2', equipmentProfileId: 'datyaudio-generic' })
  ]);

  function normalizeBrand(value) {
    const compact = String(value || '').replace(/[\s_-]+/g, '').toLowerCase();
    return compact === 'datyaudio' ? BRAND : String(value || '');
  }

  function clampAfDbfs(value, fallback) {
    const parsed = Number(value);
    const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : DEFAULT_AF_DBFS;
    if (!Number.isFinite(parsed)) return Math.max(AF_MIN_DBFS, Math.min(AF_MAX_DBFS, safeFallback));
    return Math.max(AF_MIN_DBFS, Math.min(AF_MAX_DBFS, parsed));
  }

  function frequencyForChannel(channel) {
    const channelNumber = Math.max(1, Math.min(100, Math.trunc(Number(channel) || 1)));
    return Number((641 + (channelNumber - 1) * 0.25).toFixed(3));
  }

  function getModel(modelId) {
    return MODELS.find(function (item) { return item.id === modelId; }) || MODELS[0];
  }

  function createChannel(channel, modelId) {
    const channelNumber = Math.max(1, Math.min(100, Math.trunc(Number(channel) || 1)));
    const suffix = String(channelNumber).padStart(2, '0');
    const model = getModel(modelId);
    return {
      id: DISPLAY_BRAND + '-CH' + suffix,
      name: DISPLAY_BRAND + '-CH' + suffix,
      brand: BRAND,
      model: model.id,
      equipmentProfileId: model.equipmentProfileId,
      channel: String(channelNumber),
      channel_number: channelNumber,
      channel_key: 'CH' + channelNumber,
      frequency: frequencyForChannel(channelNumber),
      rfLevel: DEFAULT_RF_DBM,
      afLevel: DEFAULT_AF_DBFS,
      battery: DEFAULT_BATTERY_PERCENT,
      muted: false,
      online: true
    };
  }

  return {
    BRAND,
    DISPLAY_BRAND,
    AF_MIN_DBFS,
    AF_MAX_DBFS,
    DEFAULT_AF_DBFS,
    DEFAULT_RF_DBM,
    DEFAULT_BATTERY_PERCENT,
    DEFAULT_MODEL,
    MODELS,
    normalizeBrand,
    clampAfDbfs,
    frequencyForChannel,
    getModel,
    createChannel
  };
});
