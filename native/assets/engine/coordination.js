// 确定性协调核心。单位：整数 kHz / dBm；仅频率约束，不预测互调产物功率。
(function (global) {
  'use strict';
  const profiles = global.DatyEquipmentProfiles;
  const ENGINE_VERSION = 'p1-2026-10-07-scan-peak-sources';
  const IMD_PRODUCT_TYPES = Object.freeze(['2T3O','2T5O','2T7O','2T9O','3T3O']);
  const clone = value => JSON.parse(JSON.stringify(value));
  // Pure ordering metadata. GROUP is only authoritative with the server source;
  // it never becomes a device ID or a fallback CH number.
  function getDevicePlanningPosition(device) {
    const value=device?.group_number;
    const groupNumber=device?.group_source==='server-fifo-v1' &&
      (typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value)) &&
      Number.isSafeInteger(Number(value))&&Number(value)>0 ? Number(value) : null;
    let channelNumber=null;
    for(const key of ['channel_number','channel_no','channel','ch','channel_key']) {
      const value=device?.[key];
      if(value===null||value===undefined||typeof value==='boolean')continue;
      const text=String(value).trim();
      const match=/^\d+$/.test(text) ? [text,text] : text.match(/(?:^|[^a-z])(?:channel|ch)\s*[-_:#\s]*[^0-9\s]{0,4}\s*(\d+)/i);
      if(match&&Number.isSafeInteger(Number(match[1]))&&Number(match[1])>0){channelNumber=Number(match[1]);break;}
    }
    if(channelNumber===null) {
      const match=String(device?._fasheId||device?.id||'').match(/_ch(\d+)$/i);
      if(match&&Number.isSafeInteger(Number(match[1]))&&Number(match[1])>0)channelNumber=Number(match[1]);
    }
    return {groupNumber,channelNumber};
  }
  const lcm=(a,b)=>{let x=a,y=b;while(y){const r=x%y;x=y;y=r;}return a/x*b;};
  function integer(value, label, min = 1) {
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`${label} 必须为不小于 ${min} 的整数`);
    return value;
  }
  function frequency(value, label) {
    integer(value, label, 30000);
    if (value > 3000000) throw new Error(`${label} 超出支持的 kHz 范围`);
    return value;
  }
  function calculateImd3KHz(a,b) { frequency(a,'f1KHz'); frequency(b,'f2KHz'); return [2*a-b,2*b-a]; }
  function calculateImd5KHz(a,b) { frequency(a,'f1KHz'); frequency(b,'f2KHz'); return [3*a-2*b,3*b-2*a]; }
  function calculateImd7KHz(a,b) { frequency(a,'f1KHz'); frequency(b,'f2KHz'); return [4*a-3*b,4*b-3*a]; }
  function calculateImd9KHz(a,b) { frequency(a,'f1KHz'); frequency(b,'f2KHz'); return [5*a-4*b,5*b-4*a]; }
  function calculateImd3ThreeToneKHz(a,b,c) {
    for (const value of [a,b,c]) frequency(value,'sourceKHz');
    return [a+b-c,a+c-b,b+c-a];
  }

  function maxIndex(values) {
    let size = 1; while (size < values.length) size *= 2;
    const tree = new Float64Array(size * 2); tree.fill(-Infinity);
    tree.set(values,size);
    for (let i=size-1;i>0;i--) tree[i]=Math.max(tree[i*2],tree[i*2+1]);
    return (left,right) => {
      let result=-Infinity; left+=size; right+=size;
      while(left<=right) {
        if(left%2) result=Math.max(result,tree[left++]);
        if(!(right%2)) result=Math.max(result,tree[right--]);
        left=Math.floor(left/2); right=Math.floor(right/2);
      }
      return result;
    };
  }
  function prepareScan(points = []) {
    if (!Array.isArray(points)) throw new Error('scanPoints 必须为数组');
    const unique = new Map();
    for (const point of points) {
      frequency(point?.frequencyKHz,'扫描频率');
      if (!Number.isFinite(point.levelDbm) || point.levelDbm < -200 || point.levelDbm > 50) throw new Error('扫描电平必须是有限 dBm');
      unique.set(point.frequencyKHz,Math.max(unique.get(point.frequencyKHz) ?? -Infinity,point.levelDbm));
    }
    const sorted=[...unique].sort((a,b)=>a[0]-b[0]).map(([frequencyKHz,levelDbm])=>({frequencyKHz,levelDbm}));
    if (sorted.length === 1) throw new Error('扫描至少需要两个不同频率点');
    const lower = value => {
      let l=0,r=sorted.length;
      while(l<r) { const m=(l+r)>>1; if(sorted[m].frequencyKHz<value)l=m+1;else r=m; }
      return l;
    };
    const levelMax=maxIndex(sorted.map(p=>p.levelDbm));
    const gapMax=maxIndex(sorted.map((p,i)=>i ? p.frequencyKHz-sorted[i-1].frequencyKHz : 0));
    return {
      points:sorted,
      levelAt(value) {
        if (!sorted.length || value<sorted[0].frequencyKHz || value>sorted.at(-1).frequencyKHz) return null;
        const i=lower(value),right=sorted[i];
        if(right.frequencyKHz===value)return right.levelDbm;
        const left=sorted[i-1],ratio=(value-left.frequencyKHz)/(right.frequencyKHz-left.frequencyKHz);
        return left.levelDbm+ratio*(right.levelDbm-left.levelDbm);
      },
      window(value,guard,maxGap) {
        if(!sorted.length)return {covered:false,levelDbm:null,reason:'no-scan'};
        const start=value-guard,end=value+guard;
        if(start<sorted[0].frequencyKHz||end>sorted.at(-1).frequencyKHz)return {covered:false,levelDbm:null,reason:'out-of-coverage'};
        let l=lower(start); if(sorted[l].frequencyKHz!==start)l--;
        const r=lower(end);
        if(r>l && gapMax(l+1,r)>maxGap)return {covered:false,levelDbm:null,reason:'scan-gap'};
        return {covered:true,levelDbm:levelMax(l,r),reason:null};
      }
    };
  }
  const immutableScans = new WeakMap();
  function getScanLevelDbm(points, value) {
    if (!Number.isFinite(value)) throw new Error('查询频率无效');
    if (!points?.length) return null;
    if (Object.isFrozen(points)) {
      if(!immutableScans.has(points))immutableScans.set(points,prepareScan(points));
      return immutableScans.get(points).levelAt(value);
    }
    return prepareScan(points).levelAt(value);
  }

  function optionsFor(input = {}) {
    const o={...input,rangeStartKHz:input.rangeStartKHz ?? 30000,rangeEndKHz:input.rangeEndKHz ?? 3000000,
      stepKHz:input.stepKHz ?? 25,compatibilityLevel:input.compatibilityLevel ?? 'standard',
      backupCount:input.backupCount ?? 1,maxSearchNodes:input.maxSearchNodes ?? 100000,
      minimumFrequencyCount:input.minimumFrequencyCount ?? 0,
      frequencyDistribution:input.frequencyDistribution ?? 'legacy',
      maxScanGapKHz:input.maxScanGapKHz ?? 200,imdOrders:input.imdOrders ?? [3],
      includeThreeTone:input.includeThreeTone ?? true,solver:input.solver ?? 'global',preserveCurrent:input.preserveCurrent ?? true,
      protectCurrentFrequencies:input.protectCurrentFrequencies ?? false,autoExpandRange:input.autoExpandRange ?? false,
      allocationOrder:input.allocationOrder ?? 'preserve-current'};
    profiles.getCompatibilityLabel(o.compatibilityLevel);
    frequency(o.rangeStartKHz,'rangeStartKHz'); frequency(o.rangeEndKHz,'rangeEndKHz');
    if(o.rangeStartKHz>=o.rangeEndKHz)throw new Error('频率范围起点必须小于终点');
    // Expansion changes the interval, never the phase of the requested grid.
    o.requestedRangeStartKHz=input.requestedRangeStartKHz ?? o.rangeStartKHz;
    o.requestedRangeEndKHz=input.requestedRangeEndKHz ?? o.rangeEndKHz;
    frequency(o.requestedRangeStartKHz,'requestedRangeStartKHz');frequency(o.requestedRangeEndKHz,'requestedRangeEndKHz');
    if(o.requestedRangeStartKHz>=o.requestedRangeEndKHz)throw new Error('原始规划范围起点必须小于终点');
    o.rangeStartKHz=o.requestedRangeStartKHz;o.rangeEndKHz=o.requestedRangeEndKHz;
    o.planningGridOriginKHz=input.planningGridOriginKHz ?? o.requestedRangeStartKHz;
    frequency(o.planningGridOriginKHz,'planningGridOriginKHz');
    integer(o.stepKHz,'stepKHz');integer(o.backupCount,'backupCount',0);integer(o.maxSearchNodes,'maxSearchNodes');integer(o.maxScanGapKHz,'maxScanGapKHz');
    if(o.backupCount>4)throw new Error('备用频率数量不能超过 4');
    integer(o.minimumFrequencyCount,'最少规划频点数',0);
    if(o.minimumFrequencyCount>256)throw new Error('最少规划频点数不能超过 256');
    if(!['legacy','spread-range'].includes(o.frequencyDistribution))throw new Error('未知频段分布策略');
    if(!['global','greedy'].includes(o.solver))throw new Error('未知求解方式');
    if(typeof o.includeThreeTone!=='boolean')throw new Error('includeThreeTone 必须为布尔值');
    if(typeof o.preserveCurrent!=='boolean')throw new Error('preserveCurrent 必须为布尔值');
    if(typeof o.protectCurrentFrequencies!=='boolean')throw new Error('protectCurrentFrequencies 必须为布尔值');
    if(typeof o.autoExpandRange!=='boolean')throw new Error('autoExpandRange 必须为布尔值');
    if(!['preserve-current','receiver-group-ascending'].includes(o.allocationOrder))throw new Error('未知频率分配顺序');
    if(!Array.isArray(o.imdOrders)||o.imdOrders.some(order=>![3,5,7,9].includes(order)))throw new Error('当前只支持三阶/五阶/七阶/九阶互调');
    o.imdOrders=[...new Set(o.imdOrders)].sort();
    if(input.imdProducts!==undefined) {
      if(!Array.isArray(input.imdProducts)||input.imdProducts.some(type=>!IMD_PRODUCT_TYPES.includes(type))||new Set(input.imdProducts).size!==input.imdProducts.length)
        throw new Error('imdProducts 必须为不重复的 2T3O、2T5O、2T7O、2T9O、3T3O 数组');
      o.imdProducts=IMD_PRODUCT_TYPES.filter(type=>input.imdProducts.includes(type));
      o.imdOrders=o.imdProducts.filter(type=>type[0]==='2').map(type=>Number(type[2]));
      o.includeThreeTone=o.imdProducts.includes('3T3O');
    }
    for(const name of ['excludedRanges','knownCarriers','lockedAssignments','scanPoints','scanPeakCarriers']) {
      if(name==='scanPeakCarriers'&&input[name]===null)throw new Error('scanPeakCarriers 必须为数组');
      o[name]=input[name] ?? [];if(!Array.isArray(o[name]))throw new Error(`${name} 必须为数组`);
      o[name]=o[name].slice();
    }
    for(const r of o.excludedRanges) {
      frequency(r.startKHz,'排除区起点');frequency(r.endKHz,'排除区终点');if(r.startKHz>r.endKHz)throw new Error('排除区范围反向');
    }
    for(const carrier of o.knownCarriers) {
      frequency(carrier.frequencyKHz,'固定占用');integer(carrier.guardKHz,'固定占用保护间隔');
      if(carrier.intermodSource!==undefined && typeof carrier.intermodSource!=='boolean')throw new Error('固定占用 intermodSource 必须为布尔值');
      if(carrier.ownerDeviceId!==undefined&&!(typeof carrier.ownerDeviceId==='string'&&carrier.ownerDeviceId.trim()||Number.isSafeInteger(carrier.ownerDeviceId)&&carrier.ownerDeviceId>0))throw new Error('固定占用 ownerDeviceId 无效');
    }
    for(const peak of o.scanPeakCarriers) {
      frequency(peak?.frequencyKHz,'扫描峰频率');
      if(!Number.isFinite(peak.levelDbm)||peak.levelDbm < -200||peak.levelDbm > 50)throw new Error('扫描峰电平必须是有限 dBm');
      if(peak.guardKHz!==undefined)integer(peak.guardKHz,'扫描峰保护间隔');
      if(peak.startKHz!==undefined||peak.endKHz!==undefined) {
        frequency(peak.startKHz,'扫描峰起点');frequency(peak.endKHz,'扫描峰终点');
        if(peak.startKHz>peak.frequencyKHz||peak.endKHz<peak.frequencyKHz)throw new Error('扫描峰频率必须位于实测段内');
      }
    }
    for(const lock of o.lockedAssignments)frequency(lock.frequencyKHz,'锁定频率');
    for (const field of ['minChannelSpacingKHz','minImdSpacingKHz']) if (o[field] !== undefined) integer(o[field],field);
    if (o.scanThresholdDbm !== undefined && (!Number.isFinite(o.scanThresholdDbm) || o.scanThresholdDbm < -140 || o.scanThresholdDbm > 0)) throw new Error('扫描占用阈值必须为 -140～0 dBm');
    return o;
  }
  function contextFor(devices, input, profileReadOptions) {
    if(!Array.isArray(devices))throw new Error('设备必须为数组');
    const options=optionsFor(input),byId=new Map();
    for(const device of devices) {
      if(device?.id===undefined || device.id===null || !String(device.id).trim() || byId.has(String(device.id)))throw new Error('设备 ID 缺失或重复，不能可靠定位通道');
      const profile=profiles.resolveEquipmentProfile(device,profileReadOptions),errors=profiles.validateEquipmentProfile(profile);
      if(errors.length)throw new Error(`Profile ${profile.id}: ${errors.join('；')}`);
      const baseSettings=profiles.getPlanningCompatibilitySettings(profile,options.compatibilityLevel,device.equipmentModeId);
      const settings={...baseSettings,
        channelSpacingKHz:Math.max(baseSettings.channelSpacingKHz,profiles.getMinimumChannelSpacingKHz(profile,device),options.minChannelSpacingKHz ?? 0),
        intermodSpacingKHz:Math.max(baseSettings.intermodSpacingKHz,options.minImdSpacingKHz ?? 0),
        scanThresholdDbm:Math.min(baseSettings.scanThresholdDbm,options.scanThresholdDbm ?? 0)};
      const range=profiles.getProfileTuningRange(profile,device.equipmentBandId),grid=profiles.getProfileFrequencyGrid(profile,device.equipmentBandId);
      const coordinationGrid=profiles.getProfileCoordinationGrid(profile,device);
      const candidateStepKHz=lcm(lcm(options.stepKHz,grid.stepKHz),coordinationGrid.stepKHz);
      byId.set(String(device.id),{id:device.id,device,profile,settings,range,grid,coordinationGrid,candidateStepKHz,intermodSource:profile.intermodSource,fixed:false});
    }
    if(options.protectCurrentFrequencies)for(const item of byId.values()) {
      const value=item.device.freq;
      if(item.device._online!==true||!Number.isSafeInteger(value)||value<30000||value>3000000)continue;
      if(options.knownCarriers.some(carrier=>String(carrier.ownerDeviceId)===String(item.id)&&carrier.frequencyKHz===value))continue;
      options.knownCarriers.push({id:`current:${String(item.id)}`,ownerDeviceId:String(item.id),frequencyKHz:value,
        guardKHz:Math.max(1,item.settings.channelSpacingKHz,item.settings.intermodSpacingKHz),
        intermodSource:item.intermodSource,reason:'在线通道当前实频仍占用；本轮移频不自动释放原占用'});
    }
    // A measured peak is an anonymous occupied tone, not a fabricated receiver
    // or a profile. Preserve its measured kHz, even off the device tuning grid.
    // Results may be passed back for manual/deployment revalidation. Replace
    // derived peaks instead of appending another copy on each round trip.
    options.knownCarriers=options.knownCarriers.filter(carrier=>carrier.generatedBy!=='scanPeakCarriers');
    const peakGuard=Math.max(1,options.minChannelSpacingKHz ?? 0,options.minImdSpacingKHz ?? 0,
      ...[...byId.values()].flatMap(item=>[item.settings.channelSpacingKHz,item.settings.intermodSpacingKHz,item.settings.scanGuardKHz ?? 0]),
      ...options.knownCarriers.map(carrier=>carrier.guardKHz));
    const peaks=new Map();
    for(const peak of options.scanPeakCarriers) {
      const guardKHz=Math.max(peakGuard,peak.guardKHz ?? 0),prior=peaks.get(peak.frequencyKHz);
      if(prior) {
        prior.guardKHz=Math.max(prior.guardKHz,guardKHz);prior.levelDbm=Math.max(prior.levelDbm,peak.levelDbm);
        prior.startKHz=Math.min(prior.startKHz,peak.startKHz ?? peak.frequencyKHz);
        prior.endKHz=Math.max(prior.endKHz,peak.endKHz ?? peak.frequencyKHz);
      } else peaks.set(peak.frequencyKHz,{id:`scan-peak:${peak.frequencyKHz}`,sourceKind:'scan-peak',generatedBy:'scanPeakCarriers',frequencyKHz:peak.frequencyKHz,
        levelDbm:peak.levelDbm,startKHz:peak.startKHz ?? peak.frequencyKHz,endKHz:peak.endKHz ?? peak.frequencyKHz,
        guardKHz,intermodSource:true,reason:'真实扫描峰参与占用保护及互调计算'});
    }
    options.knownCarriers.push(...peaks.values());
    const rangeSources=[];
    if(options.autoExpandRange) {
      for(const item of byId.values())if(item.device._online===true&&Number.isSafeInteger(item.device.freq)&&item.device.freq>=30000&&item.device.freq<=3000000)
        rangeSources.push({kind:'online-frequency',frequencyKHz:item.device.freq,deviceId:item.id});
      for(const lock of options.lockedAssignments)rangeSources.push({kind:'locked-frequency',frequencyKHz:lock.frequencyKHz,deviceId:lock.deviceId});
      for(const carrier of options.knownCarriers)rangeSources.push({kind:carrier.sourceKind==='scan-peak'?'scan-peak':'known-carrier',frequencyKHz:carrier.frequencyKHz});
      for(const source of rangeSources) {
        options.rangeStartKHz=Math.min(options.rangeStartKHz,source.frequencyKHz);
        options.rangeEndKHz=Math.max(options.rangeEndKHz,source.frequencyKHz);
      }
    }
    const outside=rangeSources.filter(source=>source.frequencyKHz<options.requestedRangeStartKHz||source.frequencyKHz>options.requestedRangeEndKHz);
    options.rangeExpansion={enabled:options.autoExpandRange,expanded:outside.length>0,
      participatingFrequencyCount:new Set(rangeSources.map(source=>source.frequencyKHz)).size,
      outsideFrequencyCount:new Set(outside.map(source=>source.frequencyKHz)).size,
      scanPeakCount:peaks.size,reasons:[...new Set(outside.map(source=>source.kind))],
      boundarySources:outside.filter(source=>source.frequencyKHz===options.rangeStartKHz||source.frequencyKHz===options.rangeEndKHz)};
    const fixed=options.knownCarriers.map((carrier,index)=>({
      id:`fixed:${index}:${carrier.id||''}`,ownerDeviceId:carrier.ownerDeviceId,frequencyKHz:carrier.frequencyKHz,
      intermodSource:carrier.intermodSource!==false,fixed:true,guardKHz:carrier.guardKHz,
      settings:{intermodSpacingKHz:carrier.sourceKind==='scan-peak'?carrier.guardKHz:0},device:{ch:carrier.id||'固定占用'}}));
    // 多品牌共用一个求解空间，合并各 Profile 要求的互调阶数，不能分品牌独立算完再拼接。
    const policies=[...byId.values()].map(item=>item.profile.imdPolicy).filter(Boolean);
    if(options.imdProducts===undefined) {
      options.imdOrders=[...new Set([...options.imdOrders,...policies.flatMap(p=>p.orders)])].sort();
      options.includeThreeTone=options.includeThreeTone || policies.some(p=>p.includeThreeTone);
      if(options.includeThreeTone && !options.imdOrders.includes(3))options.imdOrders=[3,...options.imdOrders];
      options.imdProducts=options.imdOrders.map(order=>`2T${order}O`).concat(options.includeThreeTone?['3T3O']:[]);
    }
    return {options,byId,fixed,scan:prepareScan(options.scanPoints)};
  }
  function rangeSnapshot(ctx) {
    const o=ctx.options;
    return {requestedRangeStartKHz:o.requestedRangeStartKHz,requestedRangeEndKHz:o.requestedRangeEndKHz,
      rangeStartKHz:o.rangeStartKHz,rangeEndKHz:o.rangeEndKHz,planningGridOriginKHz:o.planningGridOriginKHz,
      rangeExpansion:clone(o.rangeExpansion)};
  }
  function firstGridValue(start,o) {
    return o.planningGridOriginKHz+Math.ceil((start-o.planningGridOriginKHz)/o.stepKHz)*o.stepKHz;
  }
  function compatibilitySnapshot(ctx) {
    return {version:'daty-compatibility-v1',level:ctx.options.compatibilityLevel,
      label:profiles.getCompatibilityLabel(ctx.options.compatibilityLevel),imdProducts:ctx.options.imdProducts.slice(),
      devices:[...ctx.byId.values()].map(item => ({deviceId:item.id,profileId:item.profile.id,
        deviceModeId:item.device.equipmentModeId || null,
        channelSpacingKHz:item.settings.channelSpacingKHz,intermodSpacingKHz:item.settings.intermodSpacingKHz,
        scanThresholdDbm:item.settings.scanThresholdDbm,
        scanGuardKHz:item.settings.scanGuardKHz ?? Math.ceil(item.settings.channelSpacingKHz/2),
        candidateStepKHz:item.candidateStepKHz}))};
  }
  function unary(item,value,ctx) {
    const {options:o}=ctx;
    if(!Number.isInteger(value)||value<o.rangeStartKHz||value>o.rangeEndKHz||value<item.range[0]||value>item.range[1])return {type:'tuning-range',reason:'超出规划范围或 Equipment Profile 精确频段'};
    if((value-o.planningGridOriginKHz)%o.stepKHz || (value-item.grid.originKHz)%item.grid.stepKHz)return {type:'frequency-grid',reason:'不在规划栅格与设备调谐栅格的交集上'};
    if((value-item.coordinationGrid.originKHz)%item.coordinationGrid.stepKHz)return {type:'coordination-grid',reason:`不在 ${item.device.brand || item.profile.manufacturer} 的 ${item.coordinationGrid.stepKHz} kHz 协调候选栅格上`};
    const excluded=o.excludedRanges.find(r=>value>=r.startKHz&&value<=r.endKHz);
    if(excluded)return {type:'excluded-range',reason:excluded.reason||'频率位于排除区'};
    const carrier=o.knownCarriers.find(c=>!(c.ownerDeviceId!==undefined&&String(c.ownerDeviceId)===String(item.id)&&value===c.frequencyKHz)&&Math.abs(value-c.frequencyKHz)<Math.max(c.guardKHz,item.settings.channelSpacingKHz));
    if(carrier)return {type:'known-carrier',requiredSpacingKHz:Math.max(carrier.guardKHz,item.settings.channelSpacingKHz),actualSpacingKHz:Math.abs(value-carrier.frequencyKHz),reason:carrier.reason||'与固定占用冲突（不能低于该设备最小间隔）'};
    if(ctx.scan.points.length) {
      const sample=ctx.scan.window(value,item.settings.scanGuardKHz ?? Math.ceil(item.settings.channelSpacingKHz/2),o.maxScanGapKHz);
      if(!sample.covered)return {type:'scan-uncovered',reason:sample.reason==='scan-gap'?'扫描采样间隔过大，不能断言空闲':'扫描未覆盖接收通道保护窗口'};
      if(sample.levelDbm>=item.settings.scanThresholdDbm)return {type:'scan-occupied',scanLevelDbm:sample.levelDbm,thresholdDbm:item.settings.scanThresholdDbm,reason:'通道保护窗口内的实测峰值达到扫描占用阈值'};
    }
    return null;
  }

  // 生成器对称去重：每个双源组合 2 个产物，每个三源组合 3 个产物。
  function* productsOf(sources, options) {
    for(let i=0;i<sources.length;i++)for(let j=i+1;j<sources.length;j++) {
      const pair=[sources[i],sources[j]],a=pair[0].frequencyKHz,b=pair[1].frequencyKHz;
      if(!pair.some(s=>s.intermodSource))continue;
      for(const type of options.imdProducts) {
        if(type[0]!=='2')continue;
        const order=Number(type[2]),positive=(order+1)/2,negative=(order-1)/2;
        for(const productKHz of [positive*a-negative*b,positive*b-negative*a])
          if(productKHz>0)yield {order,productType:type,kind:'two-tone',sources:pair,productKHz};
      }
    }
    if(options.imdProducts.includes('3T3O')) {
      for(let i=0;i<sources.length;i++)for(let j=i+1;j<sources.length;j++)for(let k=j+1;k<sources.length;k++) {
        const trio=[sources[i],sources[j],sources[k]];
        if(!trio.some(s=>s.intermodSource))continue;
        const [a,b,c]=trio.map(s=>s.frequencyKHz);
        for(const productKHz of [a+b-c,a+c-b,b+c-a])if(productKHz>0)yield {order:3,productType:'3T3O',kind:'three-tone',sources:trio,productKHz};
      }
    }
  }
  function interactions(items,ctx,emit,focus=null,stats=null) {
    for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++) {
      const a=items[i],b=items[j];if(focus && a!==focus && b!==focus)continue;
      const actual=Math.abs(a.frequencyKHz-b.frequencyKHz),required=Math.max(a.settings.channelSpacingKHz,b.settings.channelSpacingKHz);
      if(stats)stats.minChannelSpacingKHz=Math.min(stats.minChannelSpacingKHz,actual);
      if(actual<required && emit({type:'channel-spacing',sourceDeviceIds:[a.id,b.id],frequencyKHz:a.frequencyKHz,requiredSpacingKHz:required,actualSpacingKHz:actual,reason:`通道间隔 ${actual} kHz < ${required} kHz`})===false)return false;
    }
    // Zero means no IMD protection, not a fabricated positive margin. Mixed
    // scenes still apply the strongest participating Profile/manual guard.
    if(!ctx.options.imdProducts.length)return true;
    // A live carrier retained at its actual frequency is one tone, even when
    // represented both by a planned receiver and by protected current use.
    const ownedGuards=new Map(),ownedSources=new Map(),fixedByFrequency=new Map();
    for(const carrier of ctx.fixed) {
      const owner=items.find(item=>carrier.ownerDeviceId!==undefined&&String(carrier.ownerDeviceId)===String(item.id)&&carrier.frequencyKHz===item.frequencyKHz);
      if(owner) {
        // One physical tone keeps its strongest occupied-frequency protection;
        // merging ownership must not silently weaken an explicit carrier guard.
        ownedGuards.set(owner,Math.max(ownedGuards.get(owner)||0,carrier.guardKHz));
        ownedSources.set(owner,(ownedSources.get(owner)||false)||carrier.intermodSource);
        continue;
      }
      const prior=fixedByFrequency.get(carrier.frequencyKHz);
      if(prior) {
        prior.guardKHz=Math.max(prior.guardKHz,carrier.guardKHz);
        prior.intermodSource=prior.intermodSource||carrier.intermodSource;
        prior.settings={intermodSpacingKHz:Math.max(prior.settings.intermodSpacingKHz,carrier.settings.intermodSpacingKHz)};
        prior.carrierIds.push(carrier.id);
      } else fixedByFrequency.set(carrier.frequencyKHz,{...carrier,carrierIds:[carrier.id]});
    }
    const fixed=[...fixedByFrequency.values()],victims=[...items,...fixed];
    const guardOf=victim=>victim.fixed?victim.guardKHz:Math.max(victim.settings.intermodSpacingKHz,ownedGuards.get(victim)||0);
    // A three-tone product needs three distinct RF tones. Repeated imported or
    // current carrier entries do not create a new source at the same frequency.
    const sourceByFrequency=new Map();
    for(const member of [...items,...fixed.filter(carrier=>carrier.intermodSource)]) {
      const emits=member.intermodSource||ownedSources.get(member)||false,prior=sourceByFrequency.get(member.frequencyKHz);
      if(prior) {
        prior.members.push(member);prior.intermodSource=prior.intermodSource||emits;
        prior.fixed=prior.fixed&&member.fixed;
        prior.settings.intermodSpacingKHz=Math.max(prior.settings.intermodSpacingKHz,member.settings.intermodSpacingKHz);
      } else sourceByFrequency.set(member.frequencyKHz,{frequencyKHz:member.frequencyKHz,intermodSource:emits,
        fixed:member.fixed,settings:{intermodSpacingKHz:member.settings.intermodSpacingKHz},members:[member]});
    }
    const sources=[...sourceByFrequency.values()];
    if(victims.every(item=>guardOf(item)===0))return true;
    // Only victims within the largest possible guard can conflict. Range-index
    // checks keep live occupied systems from multiplying every product by all
    // receivers during the bounded search; reporting still measures all margins.
    const indexedVictims=stats?null:victims.slice().sort((a,b)=>a.frequencyKHz-b.frequencyKHz);
    const widestGuard=Math.max(0,...victims.map(guardOf),...sources.map(item=>item.settings.intermodSpacingKHz));
    function nearbyVictims(value) {
      let lo=0,hi=indexedVictims.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(indexedVictims[mid].frequencyKHz<value-widestGuard)lo=mid+1;else hi=mid;}
      const nearby=[];
      for(let at=lo;at<indexedVictims.length&&indexedVictims[at].frequencyKHz<=value+widestGuard;at++)nearby.push(indexedVictims[at]);
      return nearby;
    }
    for(const product of productsOf(sources,ctx.options)) {
      if(stats)stats.totalImdProducts++;
      // Incremental candidate checks need existing products only against the
      // candidate, and candidate-produced products against every other victim.
      const touchedFocus=focus&&product.sources.some(source=>source.members.includes(focus));
      const sourceGuard=Math.max(...product.sources.map(s=>s.settings.intermodSpacingKHz));
      for(const victim of focus&&!touchedFocus?[focus]:stats?victims:nearbyVictims(product.productKHz)) {
        if(product.sources.some(source=>source.members.includes(victim)))continue;
        // Existing fixed-to-fixed interference cannot be repaired by moving a
        // new receiver, but any new source must protect the fixed receiver too.
        if(victim.fixed&&product.sources.every(source=>source.fixed))continue;
        const actual=Math.abs(product.productKHz-victim.frequencyKHz),required=Math.max(guardOf(victim),sourceGuard);
        if(stats) { stats.minImdSeparationKHz=Math.min(stats.minImdSeparationKHz,actual);stats.minImdMarginKHz=Math.min(stats.minImdMarginKHz,actual-required); }
        if(actual<required && emit({type:`intermod-${product.order}`,productType:product.productType,imdKind:product.kind,sourceDeviceIds:product.sources.flatMap(s=>s.members.filter(member=>!member.fixed).map(member=>member.id)),sourceCarrierIds:product.sources.flatMap(s=>s.members.filter(member=>member.fixed).flatMap(member=>member.carrierIds)),...(victim.fixed?{victimCarrierId:victim.id}:{victimDeviceId:victim.id}),frequencyKHz:victim.frequencyKHz,productKHz:product.productKHz,requiredSpacingKHz:required,actualSpacingKHz:actual,marginKHz:actual-required,reason:`${product.productType} 互调 ${product.productKHz} kHz，距${victim.fixed?'固定占用':'目标'} ${actual} kHz（要求 ${required} kHz）`})===false)return false;
      }
    }
    return true;
  }
  function analyzeItems(items,ctx) {
    const conflicts=[],brandStats={},stats={minChannelSpacingKHz:Infinity,minImdSeparationKHz:Infinity,minImdMarginKHz:Infinity,totalImdProducts:0};
    for(const item of items) {
      brandStats[item.device.brand||'Unknown']=(brandStats[item.device.brand||'Unknown']||0)+1;
      const issue=unary(item,item.frequencyKHz,ctx);
      if(issue)conflicts.push({...issue,sourceDeviceIds:[item.id],victimDeviceId:item.id,frequencyKHz:item.frequencyKHz});
    }
    for(const lock of ctx.options.lockedAssignments) {
      const item=items.find(d=>String(d.id)===String(lock.deviceId));
      if(!item || item.frequencyKHz!==lock.frequencyKHz)conflicts.push({type:'locked-frequency',victimDeviceId:lock.deviceId,frequencyKHz:lock.frequencyKHz,reason:'锁定频率未满足'});
    }
    interactions(items,ctx,c=>{conflicts.push(c);},null,stats);
    for(const key of ['minChannelSpacingKHz','minImdSeparationKHz','minImdMarginKHz'])if(!Number.isFinite(stats[key]))stats[key]=null;
    return {conflicts,...stats,...rangeSnapshot(ctx),totalPairs:items.length*(items.length-1)/2,brandStats,engineVersion:ENGINE_VERSION};
  }
  // Extra frequencies have no receiver/CH identity and never enter assignments.
  // Each is valid for every current input Profile and jointly compatible with
  // the fixed main plan, its conservative backups and all earlier reserves.
  function reserveFrequencyPool(items,main,backups,ctx,mainComplete) {
    const o=ctx.options,targetCount=Math.max(o.minimumFrequencyCount,items.length),reserved=[];
    const settings={channelSpacingKHz:Math.max(0,...items.map(i=>i.settings.channelSpacingKHz)),
      intermodSpacingKHz:Math.max(0,...items.map(i=>i.settings.intermodSpacingKHz))};
    const working=[...main,...backups],noImd=settings.intermodSpacingKHz===0;
    const limit=noImd?o.maxSearchNodes:Math.min(o.maxSearchNodes,Math.max(1,Math.floor(2000000/Math.max(1,(working.length+targetCount+ctx.fixed.length)**3))));
    let checkedCandidates=0,truncated=false;
    if(mainComplete&&items.length&&main.length<targetCount) {
      for(let value=firstGridValue(o.rangeStartKHz,o);value<=o.rangeEndKHz&&main.length+reserved.length<targetCount;value+=o.stepKHz) {
        if(checkedCandidates>=limit){truncated=true;break;}
        checkedCandidates++;
        if(items.some(item=>unary(item,value,ctx)))continue;
        const candidate={id:Symbol('unbound-frequency'),frequencyKHz:value,settings,
          intermodSource:items.some(item=>item.intermodSource),fixed:false};
        if(!interactions([...working,candidate],ctx,()=>false,candidate))continue;
        working.push(candidate);reserved.push(value);
      }
    }
    const actualCount=main.length,plannedCount=actualCount+reserved.length;
    return {version:'daty-frequency-pool-v1',targetCount,actualCount,plannedCount,
      reservedFrequenciesKHz:reserved,shortfall:Math.max(0,targetCount-plannedCount),
      complete:mainComplete&&plannedCount>=targetCount,checkedCandidates,truncated,
      scope:'all-input-profile-intersection',strategy:'ascending-first-fit',
      channelSpacingKHz:settings.channelSpacingKHz,intermodSpacingKHz:settings.intermodSpacingKHz};
  }
  function analyzeFrequencyPlan(devices,frequencies,input={}) {
    const ctx=contextFor(devices,input);
    const entries=frequencies && typeof frequencies.entries==='function' ? [...frequencies.entries()] : Object.entries(frequencies||{});
    const seen=new Set(),items=[];
    for(const [id,value] of entries) {
      const item=ctx.byId.get(String(id));
      if(!item || seen.has(String(id)))throw new Error(`分析目标不存在或重复：${id}`);
      frequency(value,'规划频率'); seen.add(String(id));items.push({...item,frequencyKHz:value});
    }
    return analyzeItems(items,ctx);
  }
  function coordinateFrequencies(devices,input) {
    if(!input || input.rangeStartKHz===undefined || input.rangeEndKHz===undefined)throw new Error('规划必须指定起止频率（kHz）');
    const ctx=contextFor(devices,input),o=ctx.options,items=[...ctx.byId.values()],candidateMap=new Map(),errors=[],warnings=[];
    const positions=new Map(items.map(item=>[item.id,getDevicePlanningPosition(item.device)]));
    const groupOrdered=o.allocationOrder==='receiver-group-ascending'&&items.some(item=>positions.get(item.id).groupNumber!==null);
    const preserveCurrent=o.preserveCurrent&&!groupOrdered;
    const ranked=items.map((item,index)=>({item,index,...positions.get(item.id)})).sort((a,b)=>
      (a.groupNumber??Infinity)-(b.groupNumber??Infinity)||(a.channelNumber??Infinity)-(b.channelNumber??Infinity)||a.index-b.index);
    const ranks=new Map(ranked.map(({item},index)=>[item.id,index]));
    const spreadRange=groupOrdered&&o.frequencyDistribution==='spread-range';
    const preferred=new Map();
    if(spreadRange)for(const {item} of ranked) {
      const rank=ranks.get(item.id);
      let left={rank:0,frequencyKHz:o.rangeStartKHz},right={rank:items.length-1,frequencyKHz:o.rangeEndKHz};
      // Locks split the interval into independent spacing targets. They are
      // still hard constraints below; preferences never validate a bad lock.
      for(const lock of o.lockedAssignments) {
        const source=ctx.byId.get(String(lock.deviceId));if(!source)continue;
        const at=ranks.get(source.id);
        if(at<=rank&&at>=left.rank)left={rank:at,frequencyKHz:lock.frequencyKHz};
        if(at>=rank&&at<=right.rank)right={rank:at,frequencyKHz:lock.frequencyKHz};
      }
      const denominator=Math.max(1,right.rank-left.rank);
      preferred.set(item.id,items.length===1&&!o.lockedAssignments.length
        ? {numerator:o.rangeStartKHz+o.rangeEndKHz,denominator:2}
        : {numerator:left.frequencyKHz*denominator+(right.frequencyKHz-left.frequencyKHz)*(rank-left.rank),denominator});
    }
    const respectsOrder=(candidate,current)=>!groupOrdered||current.every(other=>
      ranks.get(candidate.id)<ranks.get(other.id) ? candidate.frequencyKHz<other.frequencyKHz : candidate.frequencyKHz>other.frequencyKHz);
    if(o.allocationOrder==='receiver-group-ascending'&&!groupOrdered)warnings.push('没有服务器确认的 GROUP：不推测编组，本次沿用原频审核与设备约束规划');
    if(groupOrdered&&ranked.some(item=>item.groupNumber===null))warnings.push('未知编组通道排在已知 GROUP 后规划，不生成或推测编组编号');
    if(!ctx.scan.points.length)warnings.push('没有真实扫描：仅验证数学与设备约束，不能证明现场无干扰');
    if(items.some(item=>!profiles.isProfileDeploymentEligible(item.profile,item.device.equipmentBandId)))warnings.push('存在未验证 Profile/硬件频段，不能视为厂商认证或开放跨品牌批量下发');
    const unverifiedBrands=[...new Set(items.filter(item=>!item.profile.spacingProvenance?.verified).map(item=>item.device.brand || item.profile.manufacturer))];
    if(unverifiedBrands.length)warnings.push(`${unverifiedBrands.join(' / ')} 的最小间隔资料未确认：使用 Profile 工程预设联合计算，不视为厂商验证参数`);
    for(const item of items) {
      const start=Math.max(o.rangeStartKHz,item.range[0]),end=Math.min(o.rangeEndKHz,item.range[1]);
      if((end-start)/o.stepKHz>150000)throw new Error('候选频率超过安全规模，请缩小规划范围或增大栅格');
      const candidates=[];
      for(let value=firstGridValue(start,o);value<=end;value+=o.stepKHz) {
        if(!unary(item,value,ctx))candidates.push(value);
      }
      const origin=Number.isInteger(item.device.freq)&&item.device.freq>0?item.device.freq:o.rangeStartKHz;
      // Candidate preference spreads actual channels across the selected range;
      // every candidate still passes the same unary, order and IMD checks.
      if(spreadRange){const t=preferred.get(item.id);candidates.sort((a,b)=>Math.abs(a*t.denominator-t.numerator)-Math.abs(b*t.denominator-t.numerator)||a-b);}
      else if(!groupOrdered)candidates.sort((a,b)=>Math.abs(a-origin)-Math.abs(b-origin)||a-b);
      candidateMap.set(item.id,candidates);
    }
    const locks=new Map(),assigned=[];
    for(const lock of o.lockedAssignments) {
      const item=ctx.byId.get(String(lock.deviceId));
      if(!item || locks.has(String(lock.deviceId))) { errors.push(`锁定目标不存在或重复：${lock.deviceId}`);continue; }
      locks.set(String(lock.deviceId),lock.frequencyKHz);
      const issue=unary(item,lock.frequencyKHz,ctx);
      if(issue)errors.push(`锁定 ${lock.deviceId}：${issue.reason}`);
      else {
        const candidate={...item,frequencyKHz:lock.frequencyKHz};
        if(!respectsOrder(candidate,assigned))errors.push('锁定频率与 GROUP / CH 升序冲突：请调整锁定或解除相关锁定后重新规划');
        assigned.push(candidate);
      }
    }
    interactions(assigned,ctx,conflict=>{errors.push(`锁定冲突：${conflict.reason}`);});

    // 记录原频检查证据；仅旧策略保护通过审核的原频，编组规划只固定显式锁频。
    // 没有真实扫描时，这只是数学/设备约束审核，不把接收机 RF 值冒充环境扫描。
    const originalIssues=new Map(items.map(item=>[String(item.id),[]])),originals=[],protectedIds=new Set();
    const noteOriginal=(id,issue)=>{
      const issues=originalIssues.get(String(id));
      if(issues && !issues.some(value=>value.type===issue.type))issues.push({type:issue.type,reason:issue.reason});
    };
    for(const item of items) {
      const value=item.device.freq;
      const issue=unary(item,value,ctx);
      if(issue)noteOriginal(item.id,issue);
      if(locks.has(String(item.id))) {
        if(value!==locks.get(String(item.id)))noteOriginal(item.id,{type:'user-lock',reason:'按用户指定的锁定频率规划'});
      } else if(!issue)originals.push({...item,frequencyKHz:value});
    }
    interactions([...assigned,...originals],ctx,conflict=>{
      // 通道间隔冲突涉及双方；IMD 先调整受影响的接收通道。
      // 若 IMD 命中用户锁定通道，则必须让未锁定的产物来源参与重规划。
      const affected=conflict.victimDeviceId!==undefined && !locks.has(String(conflict.victimDeviceId))
        ? [conflict.victimDeviceId] : conflict.sourceDeviceIds || [];
      for(const id of affected)if(!locks.has(String(id)))noteOriginal(id,conflict);
    });
    if(!errors.length && preserveCurrent) {
      for(const original of originals)if(!originalIssues.get(String(original.id)).length) {
        protectedIds.add(String(original.id));assigned.push(original);
      }
    }
    let best=errors.length?[]:assigned.slice(),nodes=0,truncated=false;
    const ordered=items.filter(item=>!locks.has(String(item.id))&&!protectedIds.has(String(item.id))).sort((a,b)=>groupOrdered
      ? ranks.get(a.id)-ranks.get(b.id)
      : candidateMap.get(a.id).length-candidateMap.get(b.id).length||b.profile.priority-a.profile.priority||String(a.id).localeCompare(String(b.id),'en'));
    function search(index,current) {
      if(current.length>best.length)best=current.slice();
      if(best.length===items.length)return true;
      if(index===ordered.length || current.length+ordered.length-index<=best.length)return false;
      const item=ordered[index];
      for(const value of candidateMap.get(item.id)) {
        if(nodes>=o.maxSearchNodes){truncated=true;return false;} nodes++;
        const candidate={...item,frequencyKHz:value};
        if(!respectsOrder(candidate,current))continue;
        if(!interactions([...current,candidate],ctx,()=>false,candidate))continue;
        current.push(candidate);
        if(search(index+1,current))return true;
        current.pop();
        if(truncated)return false;
      }
      search(index+1,current);
      return false;
    }
    if(!errors.length && o.solver==='global')search(0,assigned.slice());
    else if(!errors.length) {
      const current=assigned.slice();
      for(const item of ordered) {
        for(const value of candidateMap.get(item.id)) {
          if(nodes>=o.maxSearchNodes){truncated=true;break;} nodes++;
          const candidate={...item,frequencyKHz:value};
          if(!respectsOrder(candidate,current))continue;
          if(interactions([...current,candidate],ctx,()=>false,candidate)){current.push(candidate);break;}
        }
        if(truncated)break;
      }
      best=current;
      warnings.push('贪心求解不回溯，不保证最大可分配通道数');
    }
    const assignments=[],backupItems=[];
    for(const item of items) {
      const chosen=best.find(value=>value.id===item.id);if(!chosen)continue;
      const backups=[];
      if(!locks.has(String(item.id)))for(const value of candidateMap.get(item.id)) {
        if(backups.length>=o.backupCount)break;
        const candidate={...item,id:`backup:${String(item.id)}:${backups.length}`,frequencyKHz:value};
        // 备用频率按同时存在的保守条件验证，包括所有主频和已保留备用频率。
        if(interactions([...best,...backupItems,candidate],ctx,()=>false,candidate)){backups.push(value);backupItems.push(candidate);}
      }
      const scan=ctx.scan.window(chosen.frequencyKHz,item.settings.scanGuardKHz ?? Math.ceil(item.settings.channelSpacingKHz/2),o.maxScanGapKHz);
      const retainedOriginal=chosen.frequencyKHz===item.device.freq;
      const changeReason=retainedOriginal ? (ctx.scan.points.length ? '保留原频：扫描窗口及当前协调约束校验通过' : '保留原频：数学与设备约束通过；无真实扫描，现场干扰未验证')
        : [groupOrdered&&!locks.has(String(item.id))?'按 GROUP 数字升序、同组 CH 升序从低频向高频规划':'',
          originalIssues.get(String(item.id)).map(issue=>issue.reason).join('；')].filter(Boolean).join('；') || '为满足其余通道的全局约束而调整';
      assignments.push({deviceId:item.id,frequencyKHz:chosen.frequencyKHz,originalFrequencyKHz:Number.isInteger(item.device.freq)&&item.device.freq>0?item.device.freq:null,
        ...positions.get(item.id),allocationRank:groupOrdered?ranks.get(item.id):null,
        brand:item.device.brand || '',brandKey:profiles.normalizeBrand(item.device.brand || ''),
        minimumChannelSpacingKHz:profiles.getMinimumChannelSpacingKHz(item.profile,item.device) || null,channelSpacingKHz:item.settings.channelSpacingKHz,
        intermodSpacingKHz:item.settings.intermodSpacingKHz,coordinationGrid:clone(item.coordinationGrid),candidateStepKHz:item.candidateStepKHz,
        retainedOriginal,protectedOriginal:protectedIds.has(String(item.id)),changeReason,
        profileId:item.profile.id,profileBandId:item.device.equipmentBandId||item.profile.defaultBandId,profileModeId:item.device.equipmentModeId||o.compatibilityLevel,
        profileSource:`${item.profile.provenance.kind}:${item.profile.provenance.revision}`,deploymentEligible:profiles.isProfileDeploymentEligible(item.profile,item.device.equipmentBandId),
        score:null,scanLevelDbm:scan.levelDbm,locked:locks.has(String(item.id)),backupFrequenciesKHz:backups});
      if(backups.length<o.backupCount&&!locks.has(String(item.id)))warnings.push(`${item.device.ch||item.id} 仅找到 ${backups.length}/${o.backupCount} 个保守兼容的备用频率`);
    }
    const unassignedDeviceIds=items.filter(item=>!best.some(chosen=>chosen.id===item.id)).map(item=>item.id);
    if(unassignedDeviceIds.length)errors.push(`仍有 ${unassignedDeviceIds.length} 个通道未分配，不构成完整可用方案`);
    if(unassignedDeviceIds.length&&groupOrdered)warnings.push('当前范围、锁定、设备频段或避干扰约束下尚未找到完整的 GROUP / CH 升序方案；不会倒序分配或放宽约束来补齐通道');
    if(unassignedDeviceIds.length && protectedIds.size)warnings.push(`已保护 ${protectedIds.size} 个通过校验的原频率，不会为增加分配数量而自动挪动；请调整约束或规划范围后重试`);
    if(truncated)errors.push(`已达 ${o.maxSearchNodes} 次候选校验上限；返回确定性的部分解，不声称最优`);
    const analysis=analyzeItems(best,ctx);
    const frequencyPool=o.minimumFrequencyCount?reserveFrequencyPool(items,best,backupItems,ctx,!errors.length):null;
    if(frequencyPool&&!frequencyPool.complete)errors.push(`最少 ${frequencyPool.targetCount} 个频点目标未达到：当前已规划 ${frequencyPool.plannedCount} 个，缺少 ${frequencyPool.shortfall} 个${frequencyPool.truncated?'；预留搜索已达限额，未证明无解':'；请检查范围、Profile、扫描及人工约束'}`);
    const retention={enabled:preserveCurrent,protectedDeviceIds:items.filter(item=>protectedIds.has(String(item.id))).map(item=>item.id),
      retainedCount:assignments.filter(item=>item.retainedOriginal).length,changedCount:assignments.filter(item=>!item.retainedOriginal).length,
      scanAvailable:ctx.scan.points.length>0,originalChecks:items.map(item=>({deviceId:item.id,frequencyKHz:item.device.freq ?? null,issues:originalIssues.get(String(item.id))}))};
    return {assignments,analysis,unassignedDeviceIds,errors,warnings,solver:o.solver,...rangeSnapshot(ctx),
      allocationOrder:{policy:o.allocationOrder,enabled:groupOrdered,deviceIds:groupOrdered?ranked.map(({item})=>item.id):[],unknownGroupDeviceIds:items.filter(item=>positions.get(item.id).groupNumber===null).map(item=>item.id)},
      distribution:{policy:o.frequencyDistribution,enabled:spreadRange,targetCount:items.length,rangeStartKHz:o.rangeStartKHz,rangeEndKHz:o.rangeEndKHz,
        preferredFrequencies:spreadRange?ranked.map(({item})=>({deviceId:item.id,frequencyKHz:Math.round(preferred.get(item.id).numerator/preferred.get(item.id).denominator)})):[]},
      retention,search:{nodes,truncated,objective:groupOrdered?'max-assigned-count-with-group-ascending':preserveCurrent?'max-assigned-count-with-clean-current-held':'max-assigned-count',complete:assignments.length===items.length && !errors.length},
      engineVersion:ENGINE_VERSION,options:clone(o),compatibility:compatibilitySnapshot(ctx),
      ...(frequencyPool?{frequencyPool}:{}),profileSnapshots:items.map(item=>({deviceId:item.id,profile:clone(item.profile)}))};
  }
  // Read-only, single-channel substitutions against ALL current live carriers.
  // This is not a new plan or an assertion of measured on-air interference.
  function recommendBackupFrequencies(devices,input) {
    if (!Array.isArray(devices) || devices.length>64) throw new Error('自动推荐支持最多 64 个在线通道；更大系统请使用一键全局规划');
    const ctx=contextFor(devices,input,{persistMigration:false}),o=ctx.options;
    if (devices.length+ctx.fixed.length>64) throw new Error('自动推荐的在线通道与互调固定占用合计最多 64 个，请使用一键全局规划');
    const items=[...ctx.byId.values()].map(item=>({...item,frequencyKHz:frequency(item.device.freq,'在线通道当前频率')}));
    const locks=new Set();
    for (const lock of o.lockedAssignments) {
      const id=String(lock.deviceId);
      if (!ctx.byId.has(id) || locks.has(id)) throw new Error('锁定目标离线、缺失或重复，请先修正规划约束');
      locks.add(id);
    }
    const analysis=analyzeItems(items,ctx),entries=[],warnings=[];
    const riskTypes=new Set(['channel-spacing','intermod-3','intermod-5','intermod-7','intermod-9','scan-occupied','known-carrier','excluded-range']);
    const touches=(issue,id)=>String(issue.victimDeviceId)===String(id)||(issue.sourceDeviceIds||[]).some(source=>String(source)===String(id));
    const lockedMismatch=analysis.conflicts.some(issue=>issue.type==='locked-frequency');
    // Bound foreground work without weakening checks or claiming an exhaustive search.
    const limit=Math.max(1,Math.min(512,Math.floor(1000000/Math.max(1,(items.length+ctx.fixed.length)**3))));
    let checkedCandidates=0,truncated=false;
    for (const item of items) {
      const issues=analysis.conflicts.filter(issue=>riskTypes.has(issue.type)&&touches(issue,item.id));
      if (!issues.length) continue;
      const row={deviceId:item.id,brand:item.device.brand || item.profile.manufacturer,
        receiverId:item.device.receiver_id || item.device.receiverId || '',receiverIP:item.device.receiver_ip || item.device.ip || '',
        channel:item.device.channel_number ?? item.device.channel ?? item.device.ch ?? '',
        currentFrequencyKHz:item.frequencyKHz,profileId:item.profile.id,
        profileVerified:profiles.isProfileDeploymentEligible(item.profile,item.device.equipmentBandId),
        evidence:issues.some(issue=>issue.type==='scan-occupied')?'scan':'calculation',
        reasonTypes:[...new Set(issues.map(issue=>issue.type))],reasons:[...new Set(issues.map(issue=>issue.reason))].slice(0,4),
        backupFrequenciesKHz:[],status:'none'};
      entries.push(row);
      if (locks.has(String(item.id))) {row.status='locked';continue;}
      if (lockedMismatch) {row.status='constraints-unapplied';continue;}
      if (!o.backupCount) {row.status='backups-disabled';continue;}
      if (checkedCandidates>=limit) {row.status='search-limited';truncated=true;continue;}
      const start=Math.max(o.rangeStartKHz,item.range[0]),end=Math.min(o.rangeEndKHz,item.range[1]),candidates=[];
      if ((end-start)/o.stepKHz>150000) throw new Error('自动推荐候选范围过大，请缩小规划范围或增大步进');
      for (let value=firstGridValue(start,o);value<=end;value+=o.stepKHz) {
        if (value!==item.frequencyKHz&&!unary(item,value,ctx)) candidates.push(value);
      }
      candidates.sort((a,b)=>Math.abs(a-item.frequencyKHz)-Math.abs(b-item.frequencyKHz)||a-b);
      for (const value of candidates) {
        if (checkedCandidates>=limit) {truncated=true;row.status='search-limited';break;}
        checkedCandidates++;
        const candidate={...item,frequencyKHz:value},substitution=items.map(other=>other===item?candidate:other);
        // Focus checks also reject IMD produced by the candidate against OTHER
        // channels. Unrelated pre-existing conflicts are not called resolved.
        if (interactions(substitution,ctx,()=>false,candidate)) row.backupFrequenciesKHz.push(value);
        if (row.backupFrequenciesKHz.length>=o.backupCount) break;
      }
      if (row.backupFrequenciesKHz.length) row.status='recommended';
    }
    if (!ctx.scan.points.length) warnings.push('没有真实扫描：仅校验数学与设备约束，不能证明现场无干扰。');
    else warnings.push('依据当前导入扫描快照，不是实时频谱测量；现场变化后请重新扫描。');
    if (items.some(item=>!profiles.isProfileDeploymentEligible(item.profile,item.device.equipmentBandId))) warnings.push('包含未核实的 Profile/硬件频段，建议不代表厂商认证或下发许可。');
    if (analysis.conflicts.some(issue=>!riskTypes.has(issue.type))) warnings.push('部分通道频段、栅格、锁定或扫描覆盖未满足，请在频率规划中核查。');
    if (truncated) warnings.push('已达到自动检查限额；未找到候选不代表无解，请使用一键全局规划。');
    return {format:'daty-frequency-recommendation-v1',entries,warnings,...rangeSnapshot(ctx),scanAvailable:ctx.scan.points.length>0,
      checkedCandidates,truncated,engineVersion:ENGINE_VERSION};
  }
  global.DatyCoordination=Object.freeze({ENGINE_VERSION,IMD_PRODUCT_TYPES,getDevicePlanningPosition,calculateImd3KHz,calculateImd5KHz,calculateImd7KHz,calculateImd9KHz,calculateImd3ThreeToneKHz,prepareScan,getScanLevelDbm,analyzeFrequencyPlan,coordinateFrequencies,recommendBackupFrequencies,
    describeCompatibility:(devices,options)=>compatibilitySnapshot(contextFor(devices,options,{persistMigration:false}))});
})(window);
