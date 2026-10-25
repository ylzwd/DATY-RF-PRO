// Candidate-only, synchronous projection. Cache pure channel calculations, not
// lifecycle edges or acknowledgements. Every input event still reconciles the
// entire ordered active set and retains original lastSeen/notification rules.
const _mqtt6AlertFields = [
  '_online','online','status','_thresholdStatusManaged','_fasheId','_source',
  'rf','batt','afDbfs','af_dbfs','afLevel','af_level','af','afUnit','af_unit',
  'name','receiver_ip','ip','group_source','group_number','brand','model',
  'channel_number','channel_no','channel','ch','channel_key','id',
  'receiverId','receiver_id','receiver_mac','mac'
];
let _mqtt6AlertCache = null;
// An entry is reusable only when its captured dependencies are scalar. Check
// this once when capturing, rather than once per field on every peer event.
// A later object/function can never equal a captured scalar under Object.is.
function _mqtt6ScalarAlertInputs(inputs) {
  return inputs.every(value=>value===null||
    (typeof value!=='object'&&typeof value!=='function'));
}
// Same nine-field origin comparison as the original reconciliation, without
// allocating a key array and callback for every unchanged active alert.
function _mqtt6AlertOriginMatches(alert,origin) {
  return alert.deviceId===origin.deviceId&&alert.receiverId===origin.receiverId&&
    alert.receiverIP===origin.receiverIP&&alert.receiverMAC===origin.receiverMAC&&
    alert.channel===origin.channel&&alert.groupNumber===origin.groupNumber&&
    alert.receiverBrand===origin.receiverBrand&&alert.receiverModel===origin.receiverModel&&
    alert.channelId===origin.channelId;
}
function _mqtt6AfPresence(device) {
  const own=Object.prototype.hasOwnProperty;
  return Number(own.call(device,'afDbfs'))|Number(own.call(device,'af_dbfs'))<<1|
    Number(own.call(device,'afLevel'))<<2|Number(own.call(device,'af_level'))<<3;
}
function _mqtt6ProjectAlerts(devices, options) {
  const context=[ALERT_THRESHOLDS.rfWeakDbm,ALERT_THRESHOLDS.batteryLowPercent,ALERT_THRESHOLDS.afOverloadDbfs,
    getDeviceThresholdIssues,getAfMeter,_thresholdDeviceLabel,_thresholdAlertKey,
    getDeviceChannelNumberSafe,getPlannerReceiverGroupNumber,formatBrandModelDisplay,formatChannelDisplay];
  // Full snapshots, explicit UI/threshold edits and non-delta callers rebuild.
  // Scalar dependency guards also catch unannounced edits on another channel.
  if(!Array.isArray(options.changedDevices)||!_mqtt6AlertCache||
      context.some((value,i)=>!Object.is(value,_mqtt6AlertCache.context[i])))
    _mqtt6AlertCache={context,entries:new WeakMap()};
  const state=_mqtt6AlertCache,cache=state.entries;
  let rebuild=state.projectionDirty||!state.order||state.order.length!==devices.length;
  let changedEntries=null;
  let index=0;
  for(const device of devices) {
    if(!rebuild&&state.order[index]!==device)rebuild=true;
    index++;
    if(!device||typeof device!=='object')continue;
    let entry=cache.get(device);
    const presence=_mqtt6AfPresence(device);
    let same=!!entry&&entry.scalar&&presence===entry.presence;
    if(same)for(let i=0;i<_mqtt6AlertFields.length;i++){
      const value=device[_mqtt6AlertFields[i]];
      if(!Object.is(value,entry.inputs[i])){same=false;break;}
    }
    if(!same){
      let label;
      const labelFor=()=>label??(label=_thresholdDeviceLabel(device));
      const issues=getDeviceThresholdIssues(device,ALERT_THRESHOLDS,labelFor);
      refreshThresholdDerivedStatuses([device],()=>issues);
      const entries=issues.map(issue=>{
        const key=_thresholdAlertKey(device,issue);
        const origin={deviceId:labelFor(),receiverId:device.receiverId||device.receiver_id||null,
          receiverIP:device.receiver_ip||device.ip||null,receiverMAC:device.receiver_mac||device.mac||null,
          channel:getDeviceChannelNumberSafe(device),groupNumber:getPlannerReceiverGroupNumber(device),
          receiverBrand:device.brand||null,receiverModel:device.model||null,
          channelId:device._fasheId||device.id||null};
        return {key,issue,origin,expected:{device,issue,key}};
      });
      // Map.set preserves iteration order for an existing key. Only value
      // changes may use this path; new/ended/reordered keys require a rebuild.
      if(!entry||entries.length!==entry.entries.length||
          entries.some((item,i)=>item.key!==entry.entries[i].key))rebuild=true;
      const inputs=_mqtt6AlertFields.map(key=>device[key]);
      entry={presence,inputs,scalar:_mqtt6ScalarAlertInputs(inputs),entries};
      // Cache entries are prepared before the projection is committed. If any
      // later channel throws, the next pass must rebuild from every entry,
      // including channels whose unchanged inputs now hit the prepared cache.
      state.projectionDirty=true;
      cache.set(device,entry);
      (changedEntries??=[]).push(entry);
    }
  }
  // Legacy duplicate keys use the last device in display order. Rebuilding
  // retains that rule even when the earlier duplicate is the only delta.
  if(changedEntries&&state.duplicateKeys)rebuild=true;
  if(rebuild){
    state.projectionDirty=true;
    const expected=new Map(),origins=new Map();
    let duplicateKeys=false;
    // Rebuild the projection in the original order when its key order changes.
    // The caller never mutates this map; lifecycle reconciliation still runs
    // for every event, even when all pure projection inputs are identical.
    for(const device of devices){
      const entry=device&&typeof device==='object'?cache.get(device):null;
      for(const item of entry?.entries||[]){
        if(expected.has(item.key))duplicateKeys=true;
        expected.set(item.key,item.expected);origins.set(item.key,item.origin);
      }
    }
    state.order=devices.slice();state.projection={expected,origins};state.duplicateKeys=duplicateKeys;
  }else if(changedEntries){
    for(const entry of changedEntries)for(const item of entry.entries){
      state.projection.expected.set(item.key,item.expected);
      state.projection.origins.set(item.key,item.origin);
    }
  }
  state.projectionDirty=false;
  return state.projection;
}
