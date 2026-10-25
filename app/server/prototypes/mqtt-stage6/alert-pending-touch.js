// Only locally-owned, equivalent pending records may be touched in place.
// Archive captures are deep copies; a loaded/merged/replaced record invalidates
// the owner token. Never mutate a captured database transaction or reopen ended
// records. Fall back to the original merge on any content/identity/state change.
const _mqtt6PendingOwners = new WeakMap();
const _mqtt6PendingOwn = Function.call.bind(Object.prototype.hasOwnProperty);
function _mqtt6RememberPending(alert, state, incoming) {
  const current=_pendingAlertArchive.get(incoming.archiveId);
  if(state!=='active'||!current||current.archiveState!=='active'||
      Object.keys(incoming).some(key=>!Object.is(incoming[key],current[key]))){
    _mqtt6PendingOwners.delete(alert);return;
  }
  _mqtt6PendingOwners.set(alert,{record:current,source:{...alert},keys:Object.keys(alert)});
}
function _mqtt6TouchPending(alert,state) {
  if(!alert||typeof alert!=='object'||state!=='active')return false;
  const owner=_mqtt6PendingOwners.get(alert);
  if(!owner||_pendingAlertArchive.get(alert.archiveId)!==owner.record||owner.record.archiveState!=='active')return false;
  // Enumerate the same own enumerable string keys as Object.keys without
  // allocating a new array for every unchanged active alert on every event.
  let index=0;
  for(const key in alert){
    if(!_mqtt6PendingOwn(alert,key))continue;
    if(key!==owner.keys[index++]||(key!=='lastSeen'&&!Object.is(alert[key],owner.source[key])))return false;
  }
  if(index!==owner.keys.length)return false;
  const firstSeen=alert.firstSeen??alert.ts??Date.now();
  const lastSeen=alert.lastSeen??alert.ts??firstSeen;
  const previous=owner.record;
  // Generic/manual alerts may lack occurrence times; their original fallback
  // changes with the clock and must rebuild all normalized timestamp fields.
  if(!Object.is(firstSeen,previous.firstSeen)||!Object.is(firstSeen,previous.ts))return false;
  const previousTime=previous.endedAt||previous.lastSeen||previous.ts||0;
  const incomingTime=alert.endedAt||lastSeen||firstSeen||0;
  if(incomingTime>=previousTime)previous.lastSeen=lastSeen;
  // Preserve synchronous checkpoint timing and errors, including clock rollback.
  try{if(Date.now()-_alertPendingCheckpointAt>=1000)_checkpointPendingAlerts();}
  catch(error){_alertArchiveError=error.message||String(error);}
  globalThis.DatyMqttScheduleArchiveStatus(updateAlertArchiveStatus);
  return true;
}
