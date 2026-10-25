const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function harness(){
  const c=vm.createContext({localStorage:{getItem:()=>null,setItem(){throw Error('Unexpected storage write');}}});
  c.window=c;
  for(const file of ['equipment-profiles.js','rf-simulation.js','rf-simulation-view.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules',file),'utf8'),c);
  return c;
}
const device=()=>({_fasheId:'isolated_ch1',brand:'DATYaudio',model:'DATY-X1',freq:641000,rf:-40,_online:true,status:0});
test('view reuses RF work through mute/AF updates but invalidates for telemetry, modes and connection status',()=>{
  const c=harness(),d=device(),get=()=>c.DatyRfSimulationView.get([d],640,642),initial=get();
  d.muted=true;d.status='muted';d.af=-10;d.batt=30;
  assert.equal(get(),initial);
  d.equipmentModeId='robust';
  const robust=get();assert.notEqual(robust,initial);
  assert.equal(robust.carriers[0].channelSpacingKHz,initial.carriers[0].channelSpacingKHz);
  assert.equal(robust.carriers[0].intermodSpacingKHz,150);assert.equal(initial.carriers[0].intermodSpacingKHz,250);
  d.rf=-50;const changed=get();assert.equal(changed.carriers[0].peakDbm,-50);
  d.status='timeout';assert.equal(get().carriers.length,0);
  d.status=0;assert.equal(get().carriers.length,1);
});
test('capability changes invalidate Profile resolution without changing device data or storing simulation',()=>{
  const c=harness(),d=device(),get=()=>c.DatyRfSimulationView.get([d],640,642),initial=get();
  d.capabilities={adapter:'fashe-mqtt',write_frequency:true,read_only:false,
    frequency_control:{scope:'fashe-protocol',ack_mode:'command-id',min_khz:400000,max_khz:900000,step_khz:1}};
  const before=JSON.stringify(d),updated=get();
  assert.notEqual(updated,initial);
  assert.equal(JSON.stringify(d),before);
  assert.equal(get(),updated);
  c.DatyRfSimulationView.clearDisplay();
  assert.equal(get(),updated,'clearing displayed state keeps reusable calculation cache');
});

test('read-only legacy Profile content changes invalidate cached simulation without creating v2 storage',()=>{
  const c=harness(),d=device();
  const base=c.DatyEquipmentProfiles.resolveEquipmentProfile(d);
  const legacy=JSON.parse(JSON.stringify(base));legacy.id='custom-v1';legacy.manufacturer='DATYaudio';
  delete legacy.bands;delete legacy.modes;delete legacy.provenance;
  legacy.compatibility.standard.channelSpacingKHz=500;
  const values=new Map([['daty_equipment_profiles_v1',JSON.stringify([legacy])]]);
  c.localStorage.getItem=key=>values.get(key)??null;
  c.localStorage.setItem=()=>{throw Error('Simulation must not migrate Profile storage');};
  d.equipmentProfileId='custom-v1';
  const first=c.DatyRfSimulationView.get([d],640,642);
  assert.equal(first.guardPolicy.channelSpacingKHz,500);
  legacy.compatibility.standard.channelSpacingKHz=750;
  values.set('daty_equipment_profiles_v1',JSON.stringify([legacy]));
  const second=c.DatyRfSimulationView.get([d],640,642);
  assert.notEqual(first,second);assert.equal(second.guardPolicy.channelSpacingKHz,750);
  assert.equal(values.has('daty_equipment_profiles_v2'),false);
});
