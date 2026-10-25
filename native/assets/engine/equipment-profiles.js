// ============================================================
// equipment-profiles.js — 浏览器运行时设备协调配置文件
// DATYaudio 250 kHz 下限/候选栅格由用户确认；其他未核实值仍是工程预设。
// ============================================================
(function (global) {
  'use strict';

  const STORAGE_KEY = 'daty_equipment_profiles_v2';
  const LEGACY_STORAGE_KEY = 'daty_equipment_profiles_v1';
  const LEVELS = {
    robust: { channelSpacingKHz: 500, intermodSpacingKHz: 350, scanThresholdDbm: -85 },
    standard: { channelSpacingKHz: 350, intermodSpacingKHz: 250, scanThresholdDbm: -78 },
    'more-frequencies': { channelSpacingKHz: 250, intermodSpacingKHz: 150, scanThresholdDbm: -72 },
  };
  const LEVEL_LABELS = Object.freeze({standard:'标准',robust:'保守','more-frequencies':'紧凑'});
  function compatibilityLabel(level) {
    if (!Object.prototype.hasOwnProperty.call(LEVEL_LABELS, level)) throw new Error(`未知兼容级别：${level}`);
    return LEVEL_LABELS[level];
  }
  function compatibilitySettings(profile, level = 'standard', modeId) {
    compatibilityLabel(level);
    const preset = profile.compatibility[level];
    if (!preset) throw new Error(`Profile ${profile.id} 没有兼容级别 ${level}`);
    const mode = modeId ? profile.modes.find(item => item.id === modeId) : null;
    if (modeId && !mode) throw new Error(`Profile ${profile.id} 没有模式 ${modeId}`);
    // Coordination presets are selected by the planner, not a receiver's stale
    // preset ID. Actual/legacy hardware modes remain independent safety floors.
    const selected = profile.modes.find(item => item.id === level);
    const limits = [preset, selected?.settings,
      mode?.modeType !== 'coordination-preset' ? mode?.settings : null].filter(Boolean);
    const settings = {...preset,
      channelSpacingKHz:Math.max(...limits.map(item => item.channelSpacingKHz)),
      intermodSpacingKHz:Math.max(...limits.map(item => item.intermodSpacingKHz)),
      scanThresholdDbm:Math.min(...limits.map(item => item.scanThresholdDbm))};
    const guards = limits.map(item => item.scanGuardKHz).filter(value => value !== undefined);
    if (guards.length) settings.scanGuardKHz = Math.max(...guards);
    return settings;
  }

  function builtIn(id, manufacturer, models, range, priority, provenance, deploymentEligible = false) {
    const compatibility = JSON.parse(JSON.stringify(LEVELS));
    return {
      id, manufacturer, models, tuningRangeKHz: range, intermodSource: true, priority, frequencyStepKHz:25, frequencyOriginKHz:0,
      compatibility,
      bands: [{id:'family-envelope',label:'系列范围（未指定硬件频段）',tuningRangeKHz:range,region:'UNKNOWN',verified:false}],
      modes: Object.keys(compatibility).map(modeId=>({id:modeId,label:modeId,modeType:'coordination-preset',settings:JSON.parse(JSON.stringify(compatibility[modeId]))})),
      defaultBandId: 'family-envelope', defaultModeId: 'standard',
      provenance: {...provenance,checkedAt:'2026-09-08'}, deploymentEligible,
      source: 'built-in',
      note: 'DATY 项目默认协调参数；上线前须用对应频段和厂商资料校准。',
    };
  }

  const builtIns = [
    builtIn('shure-axient-digital','Shure',['Axient AD','AD4D','AD4Q'],[470000,698000],40,{kind:'manufacturer-public-reference',title:'Shure Axient Digital / WWB public product reference',url:'https://www.shure.com/en-US/products/wireless-systems/axient_digital',revision:'public-reference',verified:false}),
    builtIn('shure-ulx-d','Shure',['ULX-D','ULXD4','ULXD4Q'],[470000,698000],30,{kind:'manufacturer-public-reference',title:'Shure ULX-D public product reference',url:'https://www.shure.com/en-US/products/wireless-systems/ulx-d_digital_wireless',revision:'public-reference',verified:false}),
    builtIn('shure-qlx-d','Shure',['QLX-D','QLXD4'],[470000,698000],25,{kind:'manufacturer-public-reference',title:'Shure QLX-D public product reference',url:'https://www.shure.com/en-US/products/wireless-systems/qlx-d_digital_wireless',revision:'public-reference',verified:false}),
    builtIn('shure-generic','Shure',['*'],[470000,698000],20,{kind:'manufacturer-public-reference',title:'Shure Wireless Workbench archive',url:'https://www.shure.com/en-US/support/downloads/software-firmware-archive/wireless-workbench',revision:'WWB6.15.4-reference',verified:false}),
    builtIn('sennheiser-ew-dx','Sennheiser',['EW-DX','EW-D'],[470000,694000],25,{kind:'project-default',title:'DATY conservative EW-DX envelope',url:'about:blank',revision:'daty-v1',verified:false}),
    builtIn('sennheiser-generic','Sennheiser',['*'],[470000,694000],20,{kind:'project-default',title:'DATY conservative Sennheiser envelope',url:'about:blank',revision:'daty-v1',verified:false}),
    builtIn('amsaudio-gt-tc','AMSaudio',['GT6000','TC2200','TC2100','UHF-501'],[470000,700000],20,{kind:'project-default',title:'DATY AMSaudio project defaults',url:'about:blank',revision:'daty-v1',verified:false}),
    builtIn('amsaudio-generic','AMSaudio',['*'],[470000,700000],15,{kind:'project-default',title:'DATY AMSaudio generic defaults',url:'about:blank',revision:'daty-v1',verified:false}),
    builtIn('datyaudio-generic','DATYaudio',['RF PRO','DATY-X1','DATY-X2','*'],[400000,900000],15,{kind:'project-validated',title:'FAshe DATYaudio protocol manifest',url:'project://FAshe/profiles/datyaudio-wireless-mics.json',revision:'schema-v1/2026-09-08',verified:true},false),
    builtIn('generic-uhf','*',['*'],[400000,900000],10,{kind:'project-default',title:'Generic UHF planning fallback',url:'about:blank',revision:'daty-v1',verified:false}),
  ];

  // 仅适用于 Bridge 明确识别的本项目 FAshe 协议端点，不升级通用硬件 Profile。
  const fasheProfile = builtIn('datyaudio-fashe-protocol','DATYaudio',['FAshe protocol endpoint'],[400000,900000],15,
    {kind:'project-protocol-validation',title:'FAshe index.html set_freq + Bridge frequency boundary',url:'project://FAshe/index.html',revision:'fashe-realtime-v1/frequency-400-900',verified:true},true);
  fasheProfile.deploymentScope = 'fashe-protocol-only';
  fasheProfile.provenance.checkedAt = '2026-09-11';
  fasheProfile.frequencyStepKHz = 1;
  fasheProfile.bands = [{id:'fashe-400-900',label:'FAshe 协议 400–900 MHz（非硬件认证）',tuningRangeKHz:[400000,900000],region:'PROJECT-SIMULATOR',verified:true}];
  fasheProfile.defaultBandId = 'fashe-400-900';
  fasheProfile.note = '已核对本项目 FAshe 频率控制范围及 command_id ACK；协调间隔仍为 DATY 工程默认值，不代表硬件频段/厂家 RF 认证。';
  builtIns.push(fasheProfile);

  const normalize = value => {
    const token = String(value).toLowerCase().replace(/[\s_-]+/g, '');
    return ({senn:'sennheiser',daty:'datyaudio',ams:'amsaudio'})[token] || token;
  };
  // 接收机协调约束与 MQTT 可接受的 1 kHz 数字精度是两回事。
  const DATY_MINIMUM_KHZ = 250;
  for (const profile of builtIns.filter(p=>normalize(p.manufacturer)==='datyaudio')) {
    profile.minimumChannelSpacingKHz = DATY_MINIMUM_KHZ;
    profile.spacingProvenance = {kind:'user-confirmed',title:'项目用户确认 DATYaudio 最小通道间隔及候选步进 250 kHz',revision:'2026-09-11-daty250',verified:true};
    profile.coordinationGrid = {stepKHz:250,originKHz:0};
    profile.compatibility.standard.channelSpacingKHz = 250;
    profile.modes.find(mode=>mode.id==='standard').settings.channelSpacingKHz = 250;
    profile.compatibility.robust = {channelSpacingKHz:250,intermodSpacingKHz:150,scanThresholdDbm:-75};
    profile.compatibility['more-frequencies'] = {channelSpacingKHz:250,intermodSpacingKHz:0,scanThresholdDbm:-72};
    for (const mode of profile.modes) mode.settings = {...profile.compatibility[mode.id]};
    profile.compatibilityProvenance = {kind:'user-confirmed',revision:'2026-09-17-daty-table4',title:'DATY 三档均250kHz；互调250/150/无；扫描-78/-75/-72dBm'};
    profile.note = 'DATYaudio 三档通道间隔/候选步进均250 kHz；标准/保守/紧凑的默认互调保护为250/150/0 kHz（0=无），扫描阈值为-78/-75/-72 dBm，按用户确认表。其他品牌、硬件模式及人工加严保持；不是厂商RF认证。';
  }
  function minimumSpacing(profile, device) {
    const daty=normalize(profile.manufacturer)==='datyaudio' || normalize(device?.brand || '')==='datyaudio';
    return Math.max(daty ? DATY_MINIMUM_KHZ : 0, profile.minimumChannelSpacingKHz || 0);
  }
  function coordinationGrid(profile, device) {
    const daty=normalize(profile.manufacturer)==='datyaudio' || normalize(device?.brand || '')==='datyaudio';
    const custom=profile.coordinationGrid || {stepKHz:1,originKHz:0};
    // 自定义 Profile 只能加严，不得用通用 Profile/协议精度绕过 DATY 栅格。
    if(daty && (custom.stepKHz!==1 || custom.originKHz!==0)
      && (custom.stepKHz%250 || custom.originKHz%250))throw new Error('DATYaudio 协调栅格必须落在 250 kHz 候选频点上');
    return daty ? {stepKHz:Math.max(250,custom.stepKHz),originKHz:custom.originKHz} : {...custom};
  }
  function freezeDeep(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
    return value;
  }
  freezeDeep(builtIns);

  function validate(profile) {
    const errors = [];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return ['Profile 必须是对象'];
    if (typeof profile.id !== 'string' || !profile.id.trim()) errors.push('id 必须为非空字符串');
    if (typeof profile.manufacturer !== 'string' || !profile.manufacturer.trim()) errors.push('manufacturer 必须为非空字符串');
    if (!profile || !Array.isArray(profile.models) || !profile.models.length) errors.push('models 至少包含一个型号');
    if (!profile || !profile.provenance || !profile.provenance.title || !profile.provenance.revision) errors.push('provenance 数据来源不完整');
    if (!profile || !Array.isArray(profile.bands) || !profile.bands.length) errors.push('bands 至少包含一个频段');
    if (!profile || !Array.isArray(profile.modes) || !profile.modes.length) errors.push('modes 至少包含一个模式');
    const range = profile && profile.tuningRangeKHz;
    if (!Array.isArray(range) || !Number.isInteger(range[0]) || !Number.isInteger(range[1]) || range[0] >= range[1]) errors.push('tuningRangeKHz 无效');
    for (const level of ['robust', 'standard', 'more-frequencies']) {
      const settings = profile && profile.compatibility && profile.compatibility[level];
      const imdMinimum = normalize(profile.manufacturer)==='datyaudio' && level==='more-frequencies' ? 0 : 1;
      if (!settings || settings.channelSpacingKHz <= 0 || settings.intermodSpacingKHz < imdMinimum) errors.push(`${level} 兼容参数无效`);
      if (!settings || settings.scanThresholdDbm < -140 || settings.scanThresholdDbm > 0) errors.push(`${level} 扫描阈值无效`);
    }
    const isRange = value => Array.isArray(value) && value.length === 2 && value.every(Number.isInteger)
      && value[0] >= 30000 && value[1] <= 3000000 && value[0] < value[1];
    if (!isRange(range)) errors.push('频段必须使用 30000～3000000 范围内的整数 kHz');
    if (!Array.isArray(profile.models) || !profile.models.every(item => typeof item === 'string' && item.trim())) errors.push('models 包含无效型号');
    if (typeof profile.intermodSource !== 'boolean') errors.push('intermodSource 必须为布尔值');
    if (!Number.isFinite(profile.priority)) errors.push('priority 必须为有限数值');
    for (const field of ['frequencyStepKHz','frequencyOriginKHz']) {
      if (profile[field] !== undefined && (!Number.isInteger(profile[field]) || profile[field] < (field === 'frequencyStepKHz' ? 1 : 0))) errors.push(`${field} 无效`);
    }
    const checkSettings = (settings, name) => {
      for (const field of ['channelSpacingKHz','intermodSpacingKHz']) {
        const minimum = field==='intermodSpacingKHz' && normalize(profile.manufacturer)==='datyaudio'
          && ['more-frequencies','mode:more-frequencies'].includes(name) ? 0 : 1;
        if (!Number.isInteger(settings?.[field]) || settings[field] < minimum) errors.push(`${name}.${field} 必须为不小于 ${minimum} 的整数 kHz`);
      }
      if (!Number.isFinite(settings?.scanThresholdDbm) || settings.scanThresholdDbm < -140 || settings.scanThresholdDbm > 0) errors.push(`${name}.scanThresholdDbm 无效`);
      if (settings?.scanGuardKHz !== undefined && (!Number.isInteger(settings.scanGuardKHz) || settings.scanGuardKHz < 0)) errors.push(`${name}.scanGuardKHz 无效`);
    };
    for (const [name, settings] of Object.entries(profile.compatibility || {})) checkSettings(settings, name);
    for (const [collection, defaultKey] of [['bands','defaultBandId'],['modes','defaultModeId']]) {
      const items = Array.isArray(profile[collection]) ? profile[collection] : [];
      const ids = new Set();
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) { errors.push(`${collection} 标识缺失或重复`); continue; }
        ids.add(item.id);
        if (collection === 'modes') checkSettings(item.settings, `mode:${item.id}`);
        else {
          if (!isRange(item.tuningRangeKHz) || !isRange(range) || item.tuningRangeKHz[0] < range[0] || item.tuningRangeKHz[1] > range[1]) errors.push(`频段 ${item.id} 超出设备范围或单位错误`);
          if (typeof item.verified !== 'boolean' || !String(item.region || '').trim()) errors.push(`频段 ${item.id} 缺少区域/校验状态`);
          for (const field of ['frequencyStepKHz','frequencyOriginKHz']) if (item[field] !== undefined && (!Number.isInteger(item[field]) || item[field] < (field === 'frequencyStepKHz' ? 1 : 0))) errors.push(`频段 ${item.id}.${field} 无效`);
        }
      }
      if (!ids.has(profile[defaultKey])) errors.push(`${defaultKey} 未匹配有效条目`);
    }
    if (!['kind','url','title','revision'].every(field => typeof profile.provenance?.[field] === 'string' && profile.provenance[field].trim()) || typeof profile.provenance?.verified !== 'boolean') errors.push('provenance 缺少来源类型、地址或校验状态');
    if (typeof profile.deploymentEligible !== 'boolean') errors.push('deploymentEligible 必须为布尔值');
    if (profile.minimumChannelSpacingKHz !== undefined && (!Number.isInteger(profile.minimumChannelSpacingKHz) || profile.minimumChannelSpacingKHz <= 0)) errors.push('minimumChannelSpacingKHz 必须为正整数 kHz');
    if (normalize(profile.manufacturer)==='datyaudio' && profile.minimumChannelSpacingKHz !== undefined && profile.minimumChannelSpacingKHz<250) errors.push('DATYaudio 最小通道间隔不得低于 250 kHz');
    const minimum=minimumSpacing(profile);
    for(const [name, settings] of [...Object.entries(profile.compatibility || {}),...(Array.isArray(profile.modes)?profile.modes:[]).map(mode=>['mode:'+mode?.id,mode?.settings])]) {
      if(settings?.channelSpacingKHz<minimum)errors.push(`${name} 通道间隔不得低于 ${minimum} kHz 品牌/Profile 下限`);
    }
    if(profile.coordinationGrid !== undefined) {
      if(!Number.isInteger(profile.coordinationGrid?.stepKHz) || profile.coordinationGrid.stepKHz<1 || !Number.isInteger(profile.coordinationGrid?.originKHz) || profile.coordinationGrid.originKHz<0)errors.push('coordinationGrid 必须使用正整数 stepKHz 和非负整数 originKHz');
      else try{coordinationGrid(profile);}catch(error){errors.push(error.message);}
    }
    if(profile.imdPolicy !== undefined && (!Array.isArray(profile.imdPolicy?.orders) || !profile.imdPolicy.orders.length || profile.imdPolicy.orders.some(order=>![3,5].includes(order)) || typeof profile.imdPolicy.includeThreeTone!=='boolean'))errors.push('imdPolicy 仅支持三阶/五阶 orders 与布尔 includeThreeTone（三频要求会补入三阶）');
    if(profile.spacingProvenance !== undefined && (!profile.spacingProvenance || !String(profile.spacingProvenance.title || '').trim() || !String(profile.spacingProvenance.revision || '').trim() || typeof profile.spacingProvenance.verified!=='boolean'))errors.push('spacingProvenance 必须注明间隔来源、版本和校验状态');
    return errors;
  }

  function loadCustom(options = {}) {
    try {
      const storage=global.DatyPlatform === undefined ? localStorage : global.DatyPlatform.storage;
      const current=storage.getItem(STORAGE_KEY),legacy=storage.getItem(LEGACY_STORAGE_KEY);
      const parsed = JSON.parse(current || legacy || '[]');
      const upgraded=parsed.map(profile=>profile.bands&&profile.modes&&profile.provenance?profile:{...profile,bands:[{id:'legacy-envelope',label:'旧版范围（未验证）',tuningRangeKHz:profile.tuningRangeKHz,region:'UNKNOWN',verified:false}],modes:Object.keys(profile.compatibility||{}).map(id=>({id,label:id,settings:profile.compatibility[id]})),defaultBandId:'legacy-envelope',defaultModeId:'standard',provenance:{kind:'custom',title:'Migrated v1 custom profile',url:'localStorage://daty_equipment_profiles_v1',revision:'v1-migrated',verified:false,checkedAt:'2026-09-08'},deploymentEligible:false});
      const valid=upgraded.filter(profile => validate(profile).length === 0).map(profile => ({ ...profile, source: 'custom' }));
      // 只读视图可使用迁移后的内存结构；规划/导入等原调用仍默认写回升级结果。
      if(options?.persistMigration!==false&&(!current||upgraded.some((profile,index)=>profile!==parsed[index]))&&valid.length&&valid.length===upgraded.length)storage.setItem(STORAGE_KEY,JSON.stringify(valid));
      return valid;
    } catch (_) {
      return [];
    }
  }

  const getAll = (options) => JSON.parse(JSON.stringify([...loadCustom(options), ...builtIns]));

  function saveCustom(profile) {
    saveCustomBatch([profile]);
  }

  function saveCustomBatch(imported) {
    if (!Array.isArray(imported) || !imported.length) throw new Error('文件中没有 Profile');
    const ids = new Set();
    const candidates = imported.map(profile => {
    const candidate = { ...profile, source: 'custom' };
    const errors = validate(candidate);
    if (errors.length) throw new Error(errors.join('；'));
    if (ids.has(candidate.id)) throw new Error(`重复 Profile ID: ${candidate.id}`);
    if (builtIns.some(item => item.id === candidate.id)) throw new Error('自定义 Profile 不得覆盖内置 ID，请使用独立 ID');
    ids.add(candidate.id);
    return candidate;
    });
    // 批量先全部校验，再原子写入一次；不能导入半份文件或覆盖损坏的旧存储。
    const storage = global.DatyPlatform === undefined ? localStorage : global.DatyPlatform.storage;
    const raw = storage.getItem(STORAGE_KEY);
    const stored = raw !== null ? JSON.parse(raw) : null;
    if (raw !== null && !Array.isArray(stored)) throw new Error('已有 Profile 存储损坏，未覆盖');
    const existing = loadCustom();
    if (stored && existing.length !== stored.length) throw new Error('已有 Profile 未通过校验，请先修复原文件；未覆盖存储');
    storage.setItem(STORAGE_KEY, JSON.stringify([...existing.filter(item => !ids.has(item.id)), ...candidates]));
  }

  function resolve(device, options) {
    const profiles = getAll(options);
    const explicit = device.equipmentProfileId || device.equipment_profile_id;
    const control=device.capabilities?.frequency_control, hardware=device.capabilities?.hardware_band;
    if ((!explicit || explicit==='shure-ulxd-'+hardware?.band) && normalize(device.brand||'')==='shure' && control?.scope==='shure-scp' && hardware?.verified) {
      const p=builtIn('shure-ulxd-'+hardware.band,'Shure',[device.model],[control.min_khz,control.max_khz],30,
        {kind:'manufacturer-public-reference',title:'ULXD user guide 8964: hardware band / normal spacing',url:'https://www.shure.com/en-US/docs/guide/ULXD',revision:'8964/L51-normal',verified:true},true);
      p.frequencyStepKHz=control.step_khz;p.frequencyOriginKHz=control.origin_khz;
      p.bands=[{id:hardware.band,label:hardware.band+' · '+(hardware.source==='receiver-reported'?'设备上报':'机身标签确认'),tuningRangeKHz:p.tuningRangeKHz,region:'HARDWARE-BAND',verified:true}];
      p.defaultBandId=hardware.band;p.minimumChannelSpacingKHz=350;
      p.spacingProvenance={verified:true,title:'ULXD normal mode minimum 350 kHz',revision:'guide8964'};
      p.note='普通模式，频率分集关闭；回读确认不等于设备 command_id ACK。';
      for(const settings of Object.values(p.compatibility))settings.channelSpacingKHz=Math.max(settings.channelSpacingKHz,350);
      for(const mode of p.modes)mode.settings={...p.compatibility[mode.id]};
      return p;
    }
    if ((!explicit || explicit === 'datyaudio-generic') && isFasheFrequencyEndpoint(device)) return profiles.find(p=>p.id==='datyaudio-fashe-protocol');
    if (explicit) {
      const selected = profiles.find(profile => profile.id === explicit);
      if (selected) {
        if(selected.manufacturer!=='*' && normalize(selected.manufacturer)!==normalize(device.brand || ''))throw new Error(`品牌不匹配：${device.brand || '未知品牌'} 不能使用 ${selected.manufacturer} 的 Profile ${explicit}`);
        return selected;
      }
      throw new Error(`找不到指定的 Equipment Profile：${explicit}`);
    }
    const brand = normalize(device.brand || '');
    const model = normalize(device.model || '');
    const manufacturerProfiles = profiles.filter(profile => normalize(profile.manufacturer) === brand);
    return manufacturerProfiles.find(profile => profile.models.some(item => item !== '*' && model.includes(normalize(item))))
      || manufacturerProfiles.find(profile => profile.models.includes('*'))
      || profiles.find(profile => profile.id === 'generic-uhf');
  }

  function isFasheFrequencyEndpoint(device) {
    return normalize(device?.brand || '') === 'datyaudio' && hasFasheFrequencyProtocol(device);
  }
  function hasFasheFrequencyProtocol(device) {
    const c = device?.capabilities, control = c?.frequency_control;
    return c?.adapter === 'fashe-mqtt'
      && c.write_frequency === true && c.read_only !== true
      && control?.scope === 'fashe-protocol' && control.ack_mode === 'command-id'
      && control.min_khz === 400000 && control.max_khz === 900000 && control.step_khz === 1;
  }
  function canDeployProfileToFashe(profile, device) {
    const brand=normalize(device?.brand || '');
    return !!(brand && brand===normalize(profile.manufacturer) && (hasFasheFrequencyProtocol(device) || (brand==='shure' && device.capabilities?.adapter==='shure-scp' && device.capabilities.write_frequency===true && device.capabilities.frequency_control?.ack_mode==='readback' && device.capabilities.hardware_band?.verified===true))
      && (brand==='datyaudio' || (profile.minimumChannelSpacingKHz>0 && profile.spacingProvenance?.verified===true)));
  }

  global.DatyEquipmentProfiles = Object.freeze({
    STORAGE_KEY,
    BUILT_IN_EQUIPMENT_PROFILES: builtIns,
    validateEquipmentProfile: validate,
    loadCustomEquipmentProfiles: loadCustom,
    getAllEquipmentProfiles: getAll,
    saveCustomEquipmentProfile: saveCustom,
    saveCustomEquipmentProfiles: saveCustomBatch,
    resolveEquipmentProfile: resolve,
    isFasheFrequencyEndpoint,
    canDeployProfileToFashe,
    normalizeBrand: normalize,
    getMinimumChannelSpacingKHz: minimumSpacing,
    getProfileCoordinationGrid: coordinationGrid,
    getCompatibilityLabel: compatibilityLabel,
    getPlanningCompatibilitySettings: compatibilitySettings,
    getCompatibilitySettings: (profile, level = 'standard', modeId) => {
      if (!profile.compatibility[level]) throw new Error(`未知兼容级别：${level}`);
      if (modeId && !profile.modes.some(mode => mode.id === modeId)) throw new Error(`Profile ${profile.id} 没有模式 ${modeId}`);
      return (profile.modes.find(mode=>mode.id===(modeId||level))||{}).settings || profile.compatibility[level];
    },
    getProfileTuningRange: (profile, bandId) => {
      const band = profile.bands.find(item=>item.id===(bandId||profile.defaultBandId));
      if (!band) throw new Error(`Profile ${profile.id} 没有频段 ${bandId}`);
      return band.tuningRangeKHz;
    },
    getProfileFrequencyGrid: (profile, bandId) => {
      const band = profile.bands.find(item=>item.id===(bandId||profile.defaultBandId));
      if (!band) throw new Error(`Profile ${profile.id} 没有频段 ${bandId}`);
      return {stepKHz:band.frequencyStepKHz ?? profile.frequencyStepKHz ?? 25, originKHz:band.frequencyOriginKHz ?? profile.frequencyOriginKHz ?? 0};
    },
    isProfileDeploymentEligible: (profile, bandId) => { const band=profile.bands.find(item=>item.id===(bandId||profile.defaultBandId)); return !!(profile.deploymentEligible&&profile.provenance.verified&&band&&band.verified); },
  });
})(window);
