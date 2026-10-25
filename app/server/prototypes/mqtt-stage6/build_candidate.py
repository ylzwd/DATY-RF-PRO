"""Build reviewable static candidate only, outside production. No hash resets."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[1]

def bundle(entry):
    modules={}
    def add(path):
        path=path.resolve()
        if not path.is_relative_to(ROOT/'prototypes'):raise ValueError('Bundle module outside audited prototypes')
        key=path.relative_to(ROOT/'prototypes').as_posix()
        if key in modules:return key
        modules[key]=''
        source=path.read_text('utf-8')
        def include(match):
            target=(path.parent/match[1]).resolve()
            if not target.suffix:target=target.with_suffix('.cjs')
            return 'require('+json.dumps(add(target))+')'
        modules[key]=re.sub(r"require\(['\"]([^'\"]+)['\"]\)",include,source)
        return key
    entry_key=add(entry)
    text='(function(root){"use strict";const modules={'+','.join(json.dumps(k)+':function(module,exports,require){\n'+v+'\n}' for k,v in modules.items())+'};'
    return text+'const cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}root.DatyMQTT6=require('+json.dumps(entry_key)+');})(globalThis);\n'

def replace_once(path,old,new):
    text=path.read_text('utf-8')
    if text.count(old)!=1:raise ValueError('Candidate patch context changed: '+str(path)+' '+old[:70])
    path.write_text(text.replace(old,new),'utf-8')

def package_data_views(output):
    """Keep modular sources while serving every dependency via fixed assets.

    The deployed static server uses an explicit allowlist. Bundle these small
    additions into existing allowed assets, preserving script and style order.
    """
    output=Path(output)
    html=output/'unirf-app.html'
    replace_once(html,'<link rel="stylesheet" href="src/styles/data-management.css?v=r19-1"/>\n','')
    replace_once(html,'<script src="src/modules/data-management.js?v=r19-1"></script>\n','')
    replace_once(html,'<script src="src/modules/data-catalog.js?v=r19-data6"></script>\n','')
    replace_once(html,'<script src="src/modules/activity.js?v=r19-activity1"></script>\n','')
    timeline=output/'src/modules/timeline.js'
    timeline.write_text(timeline.read_text('utf-8')+'\n;\n'+(output/'src/modules/activity.js').read_text('utf-8'),'utf-8')
    replace_once(html,'src/styles/main.css?v=1.0.3-archive-cleanup1','src/styles/main.css?v=r19-activity1')
    replace_once(html,'src/modules/render.js?v=r19-data-management1','src/modules/render.js?v=r19-activity1')
    style=output/'src/styles/main.css';helper=output/'src/modules/data-management.js';render=output/'src/modules/render.js'
    style.write_text(style.read_text('utf-8')+'\n/* r19 data views: packaged from scoped source. */\n'+(output/'src/styles/data-management.css').read_text('utf-8'),'utf-8')
    render.write_text(helper.read_text('utf-8')+'\n;\n'+(output/'src/modules/data-catalog.js').read_text('utf-8')+'\n;\n'+render.read_text('utf-8'),'utf-8')

def build(output):
    output=Path(output).resolve()
    if any(output.is_relative_to(p.resolve()) for p in (ROOT,ROOT.parent/'FAshe',Path('C:/ProgramData/DATY RF PRO'))):
        raise ValueError('Candidate output must be outside production')
    output.mkdir(parents=True,exist_ok=False)
    shutil.copytree(ROOT/'src',output/'src',ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copy2(ROOT/'unirf-app.html',output/'unirf-app.html')
    shutil.copy2(ROOT/'DATYlogo.png',output/'DATYlogo.png')
    (output/'src/mqtt6').mkdir()
    (output/'src/mqtt6/bundle.js').write_text(bundle(HERE/'browser-exports.cjs'),'utf-8')
    shutil.copy2(HERE/'browser-boot.js',output/'src/mqtt6/browser-boot.js')
    shutil.copy2(ROOT.parent/'FAshe/vendor/mqtt-5.10.4/mqtt.min.js',output/'src/mqtt6/mqtt.min.js')
    for name in ('network-timers.js','receiver-timer-worker.js'):
        shutil.copy2(ROOT.parent/'FAshe/src'/name,output/'src/mqtt6'/name)
    html=output/'unirf-app.html'
    marker='<script src="src/platform/browser-platform.js?v=1.0.3-history-actions1"></script>'
    replace_once(html,marker,'<script src="src/mqtt6/network-timers.js"></script>\n<script src="src/mqtt6/mqtt.min.js"></script>\n<script src="src/mqtt6/bundle.js"></script>\n'+marker+'\n<script src="src/mqtt6/browser-boot.js"></script>')
    nav=output/'src/modules/navigation.js'
    replace_once(nav,'    receiver_mac: receiverMac,','    receiver_mac: receiverMac,\n    receiver_session_id: String(device._source || "").split(":mqtt:")[1],')
    replace_once(nav,"    ...(command==='set_freq' ? {expected_brand:window.DatyEquipmentProfiles?.normalizeBrand(device.brand || '') || String(device.brand || '')} : {}),",
        "    expected_brand:window.DatyEquipmentProfiles?.normalizeBrand(device.brand || '') || String(device.brand || ''),")
    # Existing discovery UI remains; its current query mode now uses MQTT port.
    discovery=output/'src/modules/discovery.js'
    replace_once(discovery,'  const wsOk = _tryWebSocketConnect(server);\n  if (!wsOk) _startHttpPolling(server);',
        '  _startHttpPolling(server); // Logical query DTOs use the sole MQTT port.')
    replace_once(discovery,"    const response = await _discoveryRequest(baseUrl + '/api/discovery/shure/' + action, {",
        "    const intent=method==='POST'?await globalThis.DatyMqttDiscoveryIntent(baseUrl,action):null;\n    if(!isCurrent())throw new Error('服务器已切换，旧扫描请求已取消');\n    const response = await _discoveryRequest(baseUrl + '/api/discovery/shure/' + action, {")
    replace_once(discovery,"...(method === 'POST' ? {headers: {'Content-Type': 'application/json'}, body: '{}'} : {}),",
        "...(method === 'POST' ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(intent)} : {}),")
    deployment=output/'src/modules/planning-deploy.js'
    replace_once(deployment,"body:JSON.stringify({event_type:'planning.deployment',",
        "body:JSON.stringify({...global.DatyMqttMutationIntent(endpoint),event_type:'planning.deployment',")
    storage=output/'src/app/server-storage.js'
    alerts=output/'src/modules/alert-history.js'
    replace_once(alerts,'  updateAlertArchiveStatus();\n}\n\nfunction readAlertArchive()',
        '  globalThis.DatyMqttScheduleArchiveStatus(updateAlertArchiveStatus);\n}\n\nfunction readAlertArchive()')
    # Auto-frequency's unchanged readKey excludes RF/AF/battery/RTT. Avoid
    # rebuilding the entire 100-channel recommendation input for an amplitude-
    # only delta. Changed frequency/identity/capability/online state invalidates
    # synchronously; every telemetry event still evaluates original alerts.
    realtime=output/'src/modules/fashe.js';render=output/'src/modules/render.js'
    recommendation_fields="['id','_fasheId','receiver_id','receiverId','receiver_ip','receiver_mac','ip','mac','brand','model',\n      'channel_number','channel','ch','freq','equipmentProfileId','equipment_profile_id','equipmentBandId','equipmentModeId','capabilities']"
    if recommendation_fields not in (output/'src/modules/planning-ui.js').read_text('utf-8'):
        raise ValueError('Recommendation input fields changed')
    helper="""function _mqtt6RecommendationKey(device) {
  if (!device) return null;
  const live=!!(device._fasheId||device.receiver_id||device.receiverId||device._serverManaged);
  const online=device._online===true||device.online===true||['online','warn','error'].includes(device.status);
  if(!live||!online||(typeof _deviceIsOffline==='function'&&_deviceIsOffline(device)))return null;
  const fields=FIELDS;
  return JSON.stringify(Object.fromEntries(fields.filter(field=>device[field]!==undefined).map(field=>[field,device[field]])));
}

""".replace('FIELDS',recommendation_fields)
    replace_once(realtime,'function _fasheHandleDeviceUpdate(updates) {',helper+'function _fasheHandleDeviceUpdate(updates) {')
    replace_once(realtime,'  updates.forEach(upd => {\n    const existIdx = _fasheFindMatchingIndex(DEVICES, upd);',
        '  let recommendationRefresh=false;\n  updates.forEach(upd => {\n    const existIdx = _fasheFindMatchingIndex(DEVICES, upd);\n    const recommendationBefore=_mqtt6RecommendationKey(DEVICES[existIdx]);')
    replace_once(realtime,'      DEVICES.push(_fasheNormalizeDevice(upd));\n    }\n  });',
        '      DEVICES.push(_fasheNormalizeDevice(upd));\n    }\n    if(recommendationBefore!==_mqtt6RecommendationKey(existIdx>=0?DEVICES[existIdx]:DEVICES[DEVICES.length-1]))recommendationRefresh=true;\n  });')
    replace_once(realtime,'  _fasheUpdateUI(updates, onlineCount);','  _fasheUpdateUI(updates, onlineCount, recommendationRefresh);')
    replace_once(realtime,'function _fasheUpdateUI(devices, onlineCount) {','function _fasheUpdateUI(devices, onlineCount, recommendationRefresh=true) {')
    replace_once(realtime,"\n  if (typeof evaluateRealtimeAlerts === 'function') evaluateRealtimeAlerts(DEVICES);\n  _fasheUiLatest",
        "\n  if (typeof evaluateRealtimeAlerts === 'function') evaluateRealtimeAlerts(DEVICES,{recommendationRefresh});\n  _fasheUiLatest")
    replace_once(render,'function evaluateRealtimeAlerts(devices = DEVICES) {','function evaluateRealtimeAlerts(devices = DEVICES, options={}) {')
    replace_once(render,'  globalThis.DatyAutoFrequency?.requestRefresh();','  if(options.recommendationRefresh!==false)globalThis.DatyAutoFrequency?.requestRefresh();')
    # Each event still evaluates every device and updates every alert lifecycle.
    # Memoize only pure computations WITHIN that one evaluation, never across
    # telemetry events, threshold edits or identity changes. Preserve first-match
    # semantics for existing keys while removing the quadratic ALERTS.find loop.
    replace_once(render,'function getDeviceThresholdIssues(device, thresholds = ALERT_THRESHOLDS) {',
        'function getDeviceThresholdIssues(device, thresholds = ALERT_THRESHOLDS, labelFor = _thresholdDeviceLabel) {')
    replace_once(render,'  const label = _thresholdDeviceLabel(device);','  let label;\n  const issueLabel=()=>label??(label=labelFor(device));')
    # Labels are pure display strings, only used by actual issues. Avoid
    # formatting 100 healthy labels for every single-channel telemetry event.
    # Every threshold and every edge is still evaluated; no cross-event cache.
    for metric in ('RF 弱信号','电池低电量','AF 过载'):
        replace_once(render,metric+'：${label} 当前',metric+'：${issueLabel()} 当前')
    replace_once(render,'function refreshThresholdDerivedStatuses(devices = DEVICES) {',
        'function refreshThresholdDerivedStatuses(devices = DEVICES, issuesFor = getDeviceThresholdIssues) {')
    replace_once(render,"    const next = getDeviceThresholdIssues(device).length > 0 ? 'warn' : 'online';",
        "    const next = issuesFor(device).length > 0 ? 'warn' : 'online';")
    replace_once(render,'  refreshThresholdDerivedStatuses(devices);',
        '''  const labels=new Map(),issues=new Map();
  const labelFor=device=>{if(!labels.has(device))labels.set(device,_thresholdDeviceLabel(device));return labels.get(device);};
  const issuesFor=device=>{if(!issues.has(device))issues.set(device,getDeviceThresholdIssues(device,ALERT_THRESHOLDS,labelFor));return issues.get(device);};
  refreshThresholdDerivedStatuses(devices,issuesFor);''')
    replace_once(render,'  devices.forEach(device => getDeviceThresholdIssues(device).forEach(issue => {',
        '  devices.forEach(device => issuesFor(device).forEach(issue => {')
    replace_once(render,"  expected.forEach(({device, issue, key}) => {\n    const existing = ALERTS.find(alert => alert?.source === 'threshold-monitor' && alert.key === key);\n    const deviceId = _thresholdDeviceLabel(device);",
        "  const existingByKey=new Map();\n  for(const alert of ALERTS)if(alert?.source==='threshold-monitor'&&!existingByKey.has(alert.key))existingByKey.set(alert.key,alert);\n  expected.forEach(({device, issue, key}) => {\n    const existing = existingByKey.get(key);\n    const deviceId = labelFor(device);")
    # Incremental pure projection; every event still reconciles lifecycle edges.
    # Explicit changed-channel input distinguishes deltas from full/UI refreshes.
    replace_once(realtime,'  let recommendationRefresh=false;','  let recommendationRefresh=false;\n  const changedDevices=[];')
    replace_once(realtime,'    if(recommendationBefore!==_mqtt6RecommendationKey(',
        '    changedDevices.push(existIdx>=0?DEVICES[existIdx]:DEVICES[DEVICES.length-1]);\n    if(recommendationBefore!==_mqtt6RecommendationKey(')
    replace_once(realtime,'  _fasheUpdateUI(updates, onlineCount, recommendationRefresh);',
        '  _fasheUpdateUI(updates, onlineCount, recommendationRefresh, changedDevices);')
    replace_once(realtime,'function _fasheUpdateUI(devices, onlineCount, recommendationRefresh=true) {',
        'function _fasheUpdateUI(devices, onlineCount, recommendationRefresh=true, changedDevices) {')
    replace_once(realtime,'evaluateRealtimeAlerts(DEVICES,{recommendationRefresh});',
        'evaluateRealtimeAlerts(DEVICES,{recommendationRefresh,changedDevices});')
    replace_once(render,'function evaluateRealtimeAlerts(devices = DEVICES, options={}) {',
        (HERE/'alert-projection.js').read_text('utf-8')+'\nfunction evaluateRealtimeAlerts(devices = DEVICES, options={}) {')
    replace_once(render,'''  const labels=new Map(),issues=new Map();
  const labelFor=device=>{if(!labels.has(device))labels.set(device,_thresholdDeviceLabel(device));return labels.get(device);};
  const issuesFor=device=>{if(!issues.has(device))issues.set(device,getDeviceThresholdIssues(device,ALERT_THRESHOLDS,labelFor));return issues.get(device);};
  refreshThresholdDerivedStatuses(devices,issuesFor);''',
        '  const projection=_mqtt6ProjectAlerts(devices,options);')
    replace_once(render,'''  const expected = new Map();
  devices.forEach(device => issuesFor(device).forEach(issue => {
    const key = _thresholdAlertKey(device, issue);
    expected.set(key, {device, issue, key});
  }));''','  const expected = projection.expected;')
    replace_once(render,'''    const deviceId = labelFor(device);
    const origin = {deviceId, receiverId: device.receiverId || device.receiver_id || null,
      receiverIP: device.receiver_ip || device.ip || null, receiverMAC: device.receiver_mac || device.mac || null,
      channel: getDeviceChannelNumberSafe(device), groupNumber: getPlannerReceiverGroupNumber(device),
      receiverBrand: device.brand || null, receiverModel: device.model || null,
      channelId: device._fasheId || device.id || null};''','    const origin = projection.origins.get(key);')
    replace_once(render,'Object.keys(origin).some(field => existing[field] !== origin[field])',
        '!_mqtt6AlertOriginMatches(existing,origin)')
    replace_once(alerts,"function queueAlertForArchive(alert, archiveState = 'active') {",
        (HERE/'alert-pending-touch.js').read_text('utf-8')+"\nfunction queueAlertForArchive(alert, archiveState = 'active') {\n  if(_mqtt6TouchPending(alert,archiveState))return;")
    replace_once(alerts,'  globalThis.DatyMqttScheduleArchiveStatus(updateAlertArchiveStatus);\n}\n\nfunction readAlertArchive()',
        '  _mqtt6RememberPending(alert,archiveState,record);\n  globalThis.DatyMqttScheduleArchiveStatus(updateAlertArchiveStatus);\n}\n\nfunction readAlertArchive()')
    project_sync=output/'src/platform/unified-project-sync.js'
    replace_once(project_sync,"  const atomicKeys=['constraints','constraintFields','last_coordination_at'];", """  // Immutable history is an ID-keyed collection. SQL page order and receipt
  // insertion order may differ without any edit. Normalize only that collection
  // for baseline comparison; displayed history and every other array stay intact.
  const sameProject=(a,b)=>{
    const comparable=value=>value&&({...value,data:{...value.data,planningHistory:[...(value.data?.planningHistory||[])].sort((x,y)=>x.id<y.id?-1:x.id>y.id?1:0)}});
    return equal(comparable(a),comparable(b));
  };
  const atomicKeys=['constraints','constraintFields','last_coordination_at'];""")
    replace_once(project_sync,'remote.project.revision===baseline.revision&&!equal(remote.project,baseline)',
        'remote.project.revision===baseline.revision&&!sameProject(remote.project,baseline)')
    replace_once(storage,"    anchor.href=base()+'/api/database/'+category+'/'+encodeURIComponent(record.id)+'/download';anchor.download=record.fileName;",
        "    anchor.href='#';\n    anchor.addEventListener('click',async event=>{event.preventDefault();if(anchor.dataset.busy)return;anchor.dataset.busy='1';\n      try{await global.DatyMqttDownload(base(),category,record);}catch(error){message('下载未完成：'+error.message,true);}\n      finally{delete anchor.dataset.busy;}});")
    package_data_views(output)
    manifest={p.relative_to(output).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(output.rglob('*')) if p.is_file()}
    (output/'candidate-manifest.json').write_text(json.dumps({'phase':'M6 candidate incomplete; not deployed','files':manifest},ensure_ascii=False,indent=2),'utf-8')
    return output

def build_fashe(output):
    output=Path(output).resolve();source=ROOT.parent/'FAshe'
    if any(output.is_relative_to(p.resolve()) for p in (ROOT,source,Path('C:/ProgramData/DATY RF PRO'))):
        raise ValueError('FAshe candidate output must be outside production')
    output.mkdir(parents=True,exist_ok=False)
    for folder in ('src','vendor'):shutil.copytree(source/folder,output/folder)
    shutil.copy2(source/'index.html',output/'index.html')
    (output/'src/mqtt6').mkdir()
    (output/'src/mqtt6/bundle.js').write_text(bundle(HERE/'browser-exports.cjs'),'utf-8')
    shutil.copy2(HERE/'fashe-mqtt.js',output/'src/mqtt6/fashe-mqtt.js')
    html=output/'index.html'
    replace_once(html,"const CLOCK_ACK_CLIENT_VERSION = 'fashe-stability-v2';","const CLOCK_ACK_CLIENT_VERSION = 'fashe-mqtt6-candidate-1';")
    # A periodic tick already captures all channels synchronously. Send those
    # same samples in the Bridge's existing typed-delta batch, retaining each
    # timestamp, field and channel order. Immediate UI/command ACK paths stay
    # individual and do not wait for this periodic transport batch.
    text=html.read_text('utf-8')
    start=text.index('    function sendDeviceUpdates() {');end=text.index('    function onMeterChange(',start)
    periodic=text[start:end]
    anchor="      // 按 DATY RF PRO 服务器期望的格式，每条消息只包含一个通道"
    if periodic.count(anchor)!=1:raise ValueError('Periodic telemetry source changed')
    periodic=periodic.replace(anchor,'      const periodicSamples=[]; // Preserve every original sample in this tick.')
    old='        mqttClient.publish(MQTT_TOPIC_SEND, JSON.stringify(message), { qos: 0 });'
    if periodic.count(old)!=1:raise ValueError('Periodic publication source changed')
    periodic=periodic.replace(old,'        periodicSamples.push(message);')
    anchor='      connectionPulse.sent();'
    periodic=periodic.replace(anchor,"      if(periodicSamples.length)mqttClient.publish(MQTT_TOPIC_SEND,JSON.stringify({\n        type:'device_status_update',control_protocol:'fashe-realtime-v1',\n        receiver_id:clientId,receiver_ip:receiverIP,receiver_mac:macAddress,\n        devices:periodicSamples}),{qos:0});\n"+anchor)
    html.write_text(text[:start]+periodic+text[end:],'utf-8')
    marker='  <script src="src/pairing-ui.js?v=1.0.3-stability2"></script>'
    replace_once(html,marker,'  <script src="src/mqtt6/bundle.js"></script>\n  <script src="src/mqtt6/fashe-mqtt.js"></script>\n'+marker)
    pairing=output/'src/pairing-ui.js'
    replace_once(pairing,'  const automatic = DatyAutoPair.create({browser:window});',
        '  const automatic = DatyAutoPair.create({browser:window,request:globalThis.FasheMqttEnrollment.request});')
    text=pairing.read_text('utf-8');start=text.index('  async function probe() {');end=text.index('  window.FashePairing =',start)
    pairing.write_text(text[:start]+'  async function probe() { return globalThis.FasheMqttEnrollment.probe(assertReady()); }\n'+text[end:],'utf-8')
    (output/'candidate-manifest.json').write_text(json.dumps({'phase':'M6 FAshe candidate incomplete; remote copies unchanged',
        'files':{p.relative_to(output).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(output.rglob('*')) if p.is_file()}},indent=2),'utf-8')
    return output

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--output',required=True);ap.add_argument('--fashe',action='store_true');args=ap.parse_args()
    print((build_fashe if args.fashe else build)(args.output))
