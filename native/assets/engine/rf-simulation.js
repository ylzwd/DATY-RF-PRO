// RF 显示仿真：接收机频点/RSSI + 显式模型假设，不是实测扫描或规划输入。
(function (global) {
  'use strict';
  const DEFAULTS = Object.freeze({peakWidthKHz:100, floorDbm:-88, rippleDb:2,
    thresholdDbm:-75, imdSuppressionDb:30, includeImd:true, includeFifth:false,
    includeThreeTone:true, textureStepKHz:5});
  const GAUSSIAN_DB = 40 * Math.log10(2); // ±半个全宽为 -3.0103 dB（半功率）。
  const MAX_IMD_CARRIERS = 128, MAX_THREE_TONE_CARRIERS = 64, MAX_IMD_ANCHORS = 256;
  const envelopes = new WeakMap();
  const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '')
    && Number.isFinite(Number(value)) ? Number(value) : null;
  const brand = value => String(value || '').toLowerCase().replace(/[\s_-]+/g, '');

  function settings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('仿真参数必须为对象');
    for (const key of Object.keys(input)) if (!Object.prototype.hasOwnProperty.call(DEFAULTS,key)) throw new Error(`未知仿真参数：${key}`);
    const result = {...DEFAULTS, ...input};
    for (const [key, min, max] of [['peakWidthKHz',1,5000],['floorDbm',-150,20],
      ['rippleDb',0,12],['thresholdDbm',-150,20],['imdSuppressionDb',0,120],['textureStepKHz',0.25,1000]]) {
      if (typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < min || result[key] > max)
        throw new RangeError(`仿真参数 ${key} 应为 ${min}～${max} 的数值`);
    }
    for (const key of ['includeImd','includeFifth','includeThreeTone']) if (typeof result[key] !== 'boolean') throw new TypeError(`${key} 应为布尔值`);
    if (result.floorDbm + result.rippleDb >= result.thresholdDbm) throw new RangeError('仿真噪底加锯齿幅度必须低于判定阈值');
    return result;
  }

  function online(device) {
    if (!device || !device._fasheId) return false;
    if (typeof global._deviceConnectionIsOnline === 'function') return !!global._deviceConnectionIsOnline(device);
    const offlineStatuses = ['false','no','offline','disconnected','disconnect','connection_lost',
      'connection-lost','timeout','unavailable','lost'];
    const offFlag = value => value === false || value === 0 || ['0',...offlineStatuses]
      .includes(String(value ?? '').trim().toLowerCase());
    // 旧协议 status:0=在线、status:1=告警；不能按布尔在线标志解释状态码。
    return !offFlag(device._online) && !offFlag(device.online)
      && !offlineStatuses.includes(String(device.status ?? '').trim().toLowerCase());
  }

  function rules(device, warnings) {
    const daty = ['daty','datyaudio'].includes(brand(device.brand));
    let channelSpacingKHz = daty ? 250 : 0, intermodSpacingKHz = 0, intermodSource = true;
    const profiles = global.DatyEquipmentProfiles;
    try {
      if (!profiles) throw new Error('未加载 Equipment Profile');
      const profile = profiles.resolveEquipmentProfile(device,{persistMigration:false});
      const mode = device.equipmentModeId || device.profileModeId || device.modeId || profile.defaultModeId || 'standard';
      const compatibility = profiles.getCompatibilitySettings(profile, 'standard', mode);
      const minimum = profiles.getMinimumChannelSpacingKHz(profile, device);
      if (![compatibility.channelSpacingKHz,compatibility.intermodSpacingKHz,minimum]
        .every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) throw new Error('Profile 间隔参数无效');
      channelSpacingKHz = Math.max(channelSpacingKHz, compatibility.channelSpacingKHz, minimum);
      intermodSpacingKHz = compatibility.intermodSpacingKHz;
      intermodSource = !!profile.intermodSource;
      if (!profile.provenance?.verified || !profile.spacingProvenance?.verified) {
        const label = `${device.brand || profile.manufacturer || '未知品牌'} / ${profile.id || '未命名 Profile'}`;
        const source = `${profile.provenance?.kind || '未知来源'} / ${profile.provenance?.revision || '未注明版本'}`;
        warnings.add(`${label}：保护距离使用 Profile 工程预设（${source}），来源或最小间隔资料未核验，不视为硬件校准参数。`);
      }
    } catch (error) {
      warnings.add('部分通道的 Profile 不可用：仅采用已知 DATYaudio 250 kHz 下限，其他保护距离待确认。');
    }
    return {channelSpacingKHz, intermodSpacingKHz, intermodSource};
  }

  function merge(ranges, startKHz, endKHz, open = false) {
    const clipped = ranges.filter(range => range.endKHz >= startKHz && range.startKHz <= endKHz)
      .map(range => ({startKHz:Math.max(startKHz,range.startKHz),endKHz:Math.min(endKHz,range.endKHz),
        ...(open ? {openStart:range.startKHz>=startKHz,openEnd:range.endKHz<=endKHz} : {})}))
      .filter(range => !open || range.startKHz<range.endKHz)
      .sort((a,b) => a.startKHz-b.startKHz || a.endKHz-b.endKHz);
    const result = [];
    for (const range of clipped) {
      const last = result[result.length-1];
      if (last && (open ? range.startKHz<last.endKHz : range.startKHz<=last.endKHz)) {
        if (range.startKHz===last.startKHz && open) last.openStart=last.openStart && range.openStart;
        if (range.endKHz>last.endKHz) {last.endKHz=range.endKHz;if(open)last.openEnd=range.openEnd;}
        else if (open && range.endKHz===last.endKHz) last.openEnd=last.openEnd && range.openEnd;
      }
      else result.push(range);
    }
    return result;
  }

  function containsGuardRange(range, frequencyKHz) {
    return !!range && typeof frequencyKHz==='number' && Number.isFinite(frequencyKHz)
      && (range.openStart ? frequencyKHz>range.startKHz : frequencyKHz>=range.startKHz)
      && (range.openEnd ? frequencyKHz<range.endKHz : frequencyKHz<=range.endKHz);
  }

  function radius(peakDbm, levelDbm, widthKHz) {
    return !Number.isFinite(peakDbm) || peakDbm < levelDbm ? -1 : widthKHz*Math.sqrt((peakDbm-levelDbm)/GAUSSIAN_DB);
  }

  // 绝对频率上的固定纹理：刷新、遥测顺序和缩放均不改变相同频率处的锯齿。
  function hash(index, seed) {
    let x = Math.imul((index | 0) ^ seed, 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967295 * 2 - 1;
  }

  // 连续的固定格多尺度纹理；相关尺度是视觉参数，不是扫描仪 RBW。
  function texture(frequencyKHz, stepKHz) {
    const noise=(scale,seed)=>{
      const position=frequencyKHz/scale,index=Math.floor(position),fraction=position-index;
      return hash(index,seed)*(1-fraction)+hash(index+1,seed)*fraction;
    };
    return 0.6*noise(stepKHz,0x6d2b79f5)+0.3*noise(stepKHz/2,0x1b873593)+0.1*noise(stepKHz/4,0x5bd1e995);
  }

  function withRipple(envelope, offset, options, frequencyKHz) {
    const scale = Number.isFinite(offset) ? Math.min(1,Math.abs(offset)/options.peakWidthKHz*2) : 1;
    return envelope + options.rippleDb*texture(frequencyKHz,options.textureStepKHz)*scale;
  }

  // 所有情景峰共用一个宽度，去掉共同二次项后是直线的上包络。
  // 构造 O(P log P)，查询 O(log P)；避免 50 通道三频产物使 points×products 爆炸。
  function envelopeFor(result) {
    if (envelopes.has(result)) return envelopes.get(result);
    const peaks=[...result.carriers,...result.products].filter(p=>Number.isFinite(p.peakDbm))
      .sort((a,b)=>a.frequencyKHz-b.frequencyKHz || b.peakDbm-a.peakDbm), hull=[];
    const coefficient=GAUSSIAN_DB/result.options.peakWidthKHz**2;
    let previousFrequency=null;
    for(const peak of peaks){
      if(peak.frequencyKHz===previousFrequency)continue;
      previousFrequency=peak.frequencyKHz;
      let start=-Infinity;
      while(hull.length){
        const previous=hull[hull.length-1];
        start=(previous.frequencyKHz+peak.frequencyKHz)/2
          +(previous.peakDbm-peak.peakDbm)/(2*coefficient*(peak.frequencyKHz-previous.frequencyKHz));
        if(start>previous.start)break;
        hull.pop();
      }
      hull.push({frequencyKHz:peak.frequencyKHz,peakDbm:peak.peakDbm,start:hull.length?start:-Infinity});
    }
    envelopes.set(result,hull);
    return hull;
  }

  function levelAt(result, frequencyKHz) {
    if (!result || result.kind !== 'rf-interference-simulation'
      || typeof frequencyKHz !== 'number' || !Number.isFinite(frequencyKHz)) return null;
    const hull=envelopeFor(result);if(!hull.length)return null;
    let low=0,high=hull.length;
    while(low<high){const mid=(low+high)>>>1;if(hull[mid].start<=frequencyKHz)low=mid+1;else high=mid;}
    const index=Math.max(0,low-1),options=result.options;
    let envelope=options.floorDbm,offset=Infinity;
    // 相邻交点的浮点尾差只影响边界选择；比较邻峰以保持旧 max/近峰规则。
    for(let i=Math.max(0,index-1);i<=Math.min(hull.length-1,index+1);i++){
      const peak=hull[i],delta=frequencyKHz-peak.frequencyKHz;
      const level=peak.peakDbm-GAUSSIAN_DB*(delta/options.peakWidthKHz)**2;
      if(level>envelope || level===envelope && Math.abs(delta)<Math.abs(offset)){envelope=level;offset=delta;}
    }
    return withRipple(envelope,offset,options,frequencyKHz);
  }

  function sample(result, startKHz, endKHz, renderProducts) {
    if(!envelopeFor(result).length)return [];
    const {options} = result, anchors = new Set([startKHz,endKHz]);
    for (let i=1;i<1536;i++) anchors.add(startKHz+(endKHz-startKHz)*i/1536);
    const add = frequency => { if (frequency>=startKHz && frequency<=endKHz) anchors.add(frequency); };
    // 每个已知载波以及可定量产品中心都保留；256 上限仅限制额外局部加密。
    for(const peak of result.carriers)add(peak.frequencyKHz);
    for(const peak of result.products)if(Number.isFinite(peak.peakDbm))add(peak.frequencyKHz);
    for(const ranges of [result.ranges,result.possibleRanges,result.certainRanges])for(const range of ranges){add(range.startKHz);add(range.endKHz);}
    for(const peak of envelopeFor(result))add(peak.start);
    // 宽视窗按像素稀采样；窄视窗额外对齐绝对纹理格，最多 4096 个锚点。
    const lattice=options.textureStepKHz/4;
    const stride=lattice*Math.max(1,Math.ceil((endKHz-startKHz)/lattice/4096));
    for(let f=Math.ceil(startKHz/stride)*stride;f<=endKHz;f+=stride)add(f);
    for (const peak of [...result.carriers,...renderProducts].filter(p=>Number.isFinite(p.peakDbm))) {
      const halfRange = Math.max(options.peakWidthKHz, radius(peak.peakDbm,options.floorDbm-options.rippleDb,options.peakWidthKHz));
      if (peak.frequencyKHz+halfRange<startKHz || peak.frequencyKHz-halfRange>endKHz) continue;
      add(peak.frequencyKHz);
      add(peak.frequencyKHz-options.peakWidthKHz/2); add(peak.frequencyKHz+options.peakWidthKHz/2);
      for (let j=-32;j<=32;j++) add(peak.frequencyKHz+halfRange*j/32);
    }
    return [...anchors].sort((a,b)=>a-b).map(frequencyKHz=>({frequencyKHz,levelDbm:levelAt(result,frequencyKHz)}));
  }

  function build(devices, range, input = {}) {
    const options=settings(input);
    const startKHz=range?.startMHz*1000, endKHz=range?.endMHz*1000;
    if (typeof range?.startMHz !== 'number' || typeof range?.endMHz !== 'number'
      || !Number.isFinite(startKHz) || !Number.isFinite(endKHz) || startKHz<30000 || endKHz<=startKHz
      || endKHz>3000000) throw new RangeError('仿真频率范围无效（30～3000 MHz）');
    const result={kind:'rf-interference-simulation', options, points:[], carriers:[], products:[],ranges:[],possibleRanges:[],certainRanges:[],guardRanges:[],
      guardPolicy:{kind:'scene-conservative',channelSpacingKHz:0,intermodSpacingKHz:0,boundary:'open'},
      coverage:{twoTone:{requested:options.includeImd,complete:true,sourceLimit:MAX_IMD_CARRIERS},
        threeTone:{requested:options.includeImd&&options.includeThreeTone,complete:true,sourceLimit:MAX_THREE_TONE_CARRIERS},complete:true},
      stats:{channelCount:0,missingRfCount:0,frequencyCount:0,imdProductCount:0,displayedImdCount:0,
        refinedImdCount:0,quantifiedImdCount:0,unquantifiedImdCount:0,ruleConflictCount:null}, warnings:[]};
    const warnings=new Set(), frequencies=new Map();
    for (const device of Array.isArray(devices)?devices:[]) {
      if (!online(device)) continue;
      const frequencyKHz=number(device.freq);
      if (!Number.isSafeInteger(frequencyKHz) || frequencyKHz<30000 || frequencyKHz>3000000) continue;
      const rf=number(device.rf),peakDbm=rf===null || rf < -150 || rf > 20 ? null : rf;
      if (peakDbm===null) result.stats.missingRfCount++;
      result.stats.channelCount++;
      const rule=rules(device,warnings), old=frequencies.get(frequencyKHz);
      if (old) {
        if (peakDbm!==null && (old.peakDbm===null || peakDbm>old.peakDbm)) old.peakDbm=peakDbm;
        old.channelSpacingKHz=Math.max(old.channelSpacingKHz,rule.channelSpacingKHz);
        old.intermodSpacingKHz=Math.max(old.intermodSpacingKHz,rule.intermodSpacingKHz);
        old.intermodSource=old.intermodSource || rule.intermodSource;
      } else frequencies.set(frequencyKHz,{frequencyKHz,peakDbm,...rule});
    }
    result.carriers=[...frequencies.values()].sort((a,b)=>a.frequencyKHz-b.frequencyKHz);
    result.stats.frequencyCount=result.carriers.length;
    if (!result.carriers.length) { result.warnings=[...warnings]; return result; }
    const allGuard=result.carriers.reduce((max,p)=>Math.max(max,p.intermodSpacingKHz),0);
    const allChannelGuard=result.carriers.reduce((max,p)=>Math.max(max,p.channelSpacingKHz),0);
    result.guardPolicy.channelSpacingKHz=allChannelGuard;result.guardPolicy.intermodSpacingKHz=allGuard;
    if(result.stats.missingRfCount)warnings.add(`${result.stats.missingRfCount} 个通道缺少有效 RF：保留其数学频点和保护区，涉及未知幅值的产物不作超阈判断。`);
    warnings.add('载波曲线是不同接收机 RF 的参考投影；互调幅值采用较弱参考 RF 减相对抑制的情景假设，不是同一输入测量点的实际互调功率。');
    const products=new Map();
    const add=(frequencyKHz,order,kind,sources)=>{
      if (!Number.isSafeInteger(frequencyKHz) || frequencyKHz<=0) return;
      const peakDbm=sources.every(p=>Number.isFinite(p.peakDbm))
        ? Math.min(...sources.map(p=>p.peakDbm))-options.imdSuppressionDb-(order===5?10:0) : null;
      const key=`${order}:${frequencyKHz}:${kind}`,old=products.get(key),sourceCount=(old?.sourceCount||0)+1;
      if (!old || peakDbm!==null && (old.peakDbm===null || peakDbm>old.peakDbm)) {
        products.set(key,{frequencyKHz,peakDbm,order,kind,guardKHz:allGuard,
          sourceFrequenciesKHz:sources.map(p=>p.frequencyKHz),sourceCount});
      } else old.sourceCount=sourceCount;
    };
    if (options.includeImd && result.carriers.length>MAX_IMD_CARRIERS) {
      result.coverage.twoTone.complete=false;
      warnings.add('超过 128 个不同频点：本次未计算双频互调，不能据此认定无互调风险。');
    } else if (options.includeImd) {
      for (let i=0;i<result.carriers.length;i++) for (let j=i+1;j<result.carriers.length;j++) {
        const a=result.carriers[i], b=result.carriers[j];
        // 与 coordination.productsOf 一致：至少一方允许作为互调源才生成此双频组合。
        if (!a.intermodSource && !b.intermodSource) continue;
        add(2*a.frequencyKHz-b.frequencyKHz,3,'two-tone',[a,b]); add(2*b.frequencyKHz-a.frequencyKHz,3,'two-tone',[a,b]);
        if (options.includeFifth) { add(3*a.frequencyKHz-2*b.frequencyKHz,5,'two-tone',[a,b]); add(3*b.frequencyKHz-2*a.frequencyKHz,5,'two-tone',[a,b]); }
      }
    }
    if(result.coverage.threeTone.requested){
      if(result.carriers.length>MAX_THREE_TONE_CARRIERS){
        result.coverage.threeTone.complete=false;
        warnings.add('超过 64 个不同频点：本次未计算三载波三阶互调，双频结果仍按其预算计算。');
      }else{
        for(let i=0;i<result.carriers.length;i++)for(let j=i+1;j<result.carriers.length;j++)for(let k=j+1;k<result.carriers.length;k++){
          const sources=[result.carriers[i],result.carriers[j],result.carriers[k]];
          if(!sources.some(p=>p.intermodSource))continue;
          const [a,b,c]=sources.map(p=>p.frequencyKHz);
          for(const f of [a+b-c,a+c-b,b+c-a])add(f,3,'three-tone',sources);
        }
      }
    }
    result.coverage.complete=result.coverage.twoTone.complete && result.coverage.threeTone.complete;
    result.products=[...products.values()].sort((a,b)=>a.frequencyKHz-b.frequencyKHz || a.order-b.order || a.kind.localeCompare(b.kind));
    result.stats.imdProductCount=result.products.length;
    result.stats.quantifiedImdCount=result.products.filter(p=>Number.isFinite(p.peakDbm)).length;
    result.stats.unquantifiedImdCount=result.products.length-result.stats.quantifiedImdCount;
    const visible=result.products.filter(peak=>{
      if(!Number.isFinite(peak.peakDbm) || peak.peakDbm<=options.floorDbm)return false;
      const halfRange=Math.max(0,radius(peak.peakDbm,options.floorDbm-options.rippleDb,options.peakWidthKHz));
      return peak.frequencyKHz+halfRange>=startKHz && peak.frequencyKHz-halfRange<=endKHz;
    }).sort((a,b)=>b.peakDbm-a.peakDbm || a.frequencyKHz-b.frequencyKHz || a.order-b.order);
    const renderProducts=visible.slice(0,MAX_IMD_ANCHORS);
    result.stats.displayedImdCount=visible.length; // 有可能高于噪底且与视窗相交，不保证是可分辨的局部峰。
    result.stats.refinedImdCount=renderProducts.length;
    if (visible.length>MAX_IMD_ANCHORS) warnings.add('互调峰较多：仅最强 256 个额外局部加密；所有可定量产品中心、超阈边界仍保留并参与曲线。');
    const rangesFor=threshold=>{
      const ranges=[];
      // 被上包络完全遮蔽的峰不改变任何阈值并集，三次阈值计算只需凸包峰。
      for(const peak of envelopeFor(result)){
        const halfRange=radius(peak.peakDbm,threshold,options.peakWidthKHz);
        if(halfRange>=0)ranges.push({startKHz:peak.frequencyKHz-halfRange,endKHz:peak.frequencyKHz+halfRange});
      }
      return merge(ranges,startKHz,endKHz);
    };
    result.ranges=rangesFor(options.thresholdDbm);
    // 幅度上界推出的可能/必然越限范围；只是纹理边界，不是统计置信区间。
    result.possibleRanges=rangesFor(options.thresholdDbm-options.rippleDb);
    result.certainRanges=rangesFor(options.thresholdDbm+options.rippleDb);
    const guardRanges=result.carriers.filter(()=>allChannelGuard>0).map(p=>({startKHz:p.frequencyKHz-allChannelGuard,endKHz:p.frequencyKHz+allChannelGuard}));
    for (const product of result.products) if (product.guardKHz>0) guardRanges.push({startKHz:product.frequencyKHz-product.guardKHz,endKHz:product.frequencyKHz+product.guardKHz});
    result.guardRanges=merge(guardRanges,startKHz,endKHz,true);
    result.points=sample(result,startKHz,endKHz,renderProducts);
    result.warnings=[...warnings].sort();
    return result;
  }

  global.DatyRfSimulation=Object.freeze({DEFAULTS,build,levelAt,containsGuardRange});
})(typeof window !== 'undefined' ? window : globalThis);
