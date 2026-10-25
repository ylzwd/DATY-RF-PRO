// Frequency simulation controls and read-only display state. Never sends device commands.
(function(global){
  'use strict';
  let settings=null, cachedKey='', cachedResult=null, currentView=null;
  const fields={peakWidthKHz:'simPeakWidth',floorDbm:'simFloor',rippleDb:'simRipple',textureStepKHz:'simTextureStep',thresholdDbm:'simThreshold',imdSuppressionDb:'simSuppression'};
  const engine=()=>{if(!global.DatyRfSimulation)throw new Error('干扰仿真模块未加载，请刷新页面');return global.DatyRfSimulation;};
  const getOptions=()=>({...engine().DEFAULTS,...settings});
  function get(devices,startMHz,endMHz){
    const opts=getOptions();
    // AF、静音、电池和心跳不影响RF模型；只在模型输入改变时重算。
    const input=devices.map(d=>[d._fasheId,d.freq,d.rf,d.brand,d.model,d.equipmentProfileId,d.equipment_profile_id,d.equipmentModeId,d.profileModeId,d.modeId,d._online,d.online,
      ['false','no','offline','disconnected','disconnect','connection_lost','connection-lost','timeout','unavailable','lost'].includes(String(d.status??'').trim().toLowerCase()),
      d.capabilities?.adapter,d.capabilities?.write_frequency,d.capabilities?.read_only,d.capabilities?.frequency_control]);
    let customProfiles='';
    try{const storage=global.DatyPlatform === undefined ? global.localStorage : global.DatyPlatform.storage;
    customProfiles=JSON.stringify([
      storage?.getItem(global.DatyEquipmentProfiles?.STORAGE_KEY||'daty_equipment_profiles_v2')||'',
      storage?.getItem('daty_equipment_profiles_v1')||''
    ]);}catch(_){}
    const key=JSON.stringify([input,startMHz,endMHz,opts,customProfiles]);
    if(key!==cachedKey){const next=engine().build(devices,{startMHz,endMHz},opts);cachedKey=key;cachedResult=next;}
    currentView={startMHz,endMHz,result:cachedResult};
    return cachedResult;
  }
  function modal(id,title){
    const existing=document.getElementById(id);
    if(existing){existing.focus();return null;}
    // Only one of these related windows is open at a time.
    if(document.querySelector('.rf-simulation-dialog[open]'))return null;
    const opener=document.activeElement, dialog=document.createElement('dialog');
    dialog.id=id;dialog.className='rf-simulation-dialog';dialog.setAttribute('aria-labelledby',id+'Title');
    const head=document.createElement('header'),h=document.createElement('h2'),close=document.createElement('button');
    h.id=id+'Title';h.textContent=title;close.type='button';close.className='btn btn-outline btn-sm';close.textContent='×';close.setAttribute('aria-label','关闭');
    head.append(h,close);dialog.append(head);
    const body=document.createElement('div');body.className='rf-simulation-dialog-body';dialog.append(body);
    const footer=document.createElement('footer');dialog.append(footer);
    const finish=()=>{dialog.close();dialog.remove();if(opener?.isConnected)opener.focus();};
    close.addEventListener('click',finish);dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});
    document.body.append(dialog);
    return {dialog,body,footer,finish,show:()=>dialog.showModal()};
  }
  function openSettings(){
    const m=modal('rfSimulationSettings','干扰仿真设置');if(!m)return;
    m.body.innerHTML=`<p>绿色竖条是各接收机的频点与 RF；黄色曲线是参考这些数据的情景仿真。不同接收位置的 RF 不能推导实际互调功率，峰宽、噪底与互调幅度都需要实测校准。</p>
      <div class="rf-simulation-fields">
        <label>半功率全宽（kHz）<input id="simPeakWidth" type="number" min="5" max="1000" step="1"><small>决定谱峰宽度；与品牌最小通道间隔分别计算。</small></label>
        <label>仿真噪底（dBm）<input id="simFloor" type="number" min="-120" max="-40" step="1"><small>空隙处曲线的参考电平。</small></label>
        <label>锯齿幅度（±dB）<input id="simRipple" type="number" min="0" max="10" step="0.5"><small>固定、有界的频率纹理；设为 0 显示平滑模型。</small></label>
        <label>纹理频率尺度（kHz）<input id="simTextureStep" type="number" min="0.5" max="100" step="0.5"><small>小值更细密，大值更宽缓；仅为显示参数，不等同仪器 RBW。</small></label>
        <label>情景判定阈值（dBm）<input id="simThreshold" type="number" min="-110" max="-30" step="1"><small>深色区：平滑包络≥阈值；浅色边带：含锯齿可能越阈，非故障告警。</small></label>
        <label>互调情景抑制（dB）<input id="simSuppression" type="number" min="5" max="100" step="1"><small>相对代表源中较弱 RF 的假设衰减；五阶再减 10 dB。不是 IIP3 测量。</small></label>
        <label>互调模型<select id="simImdMode"><option value="off">关闭互调</option><option value="3">三阶双频</option><option value="3+5">三阶 + 五阶双频</option><option value="3-full">三阶双频 + 三频（推荐）</option><option value="3-full+5">三阶双频 / 三频 + 五阶双频</option></select><small>双频 2f₁−f₂；三频 f₁+f₂−f₃；五阶 3f₁−2f₂，均含排列。</small></label>
      </div><p id="rfSimulationSettingsError" class="rf-simulation-error" role="alert" hidden></p>`;
    const fill=values=>{for(const [key,id]of Object.entries(fields))m.dialog.querySelector('#'+id).value=values[key];m.dialog.querySelector('#simImdMode').value=values.includeImd?(values.includeThreeTone?(values.includeFifth?'3-full+5':'3-full'):(values.includeFifth?'3+5':'3')):'off';};
    fill(getOptions());
    const reset=document.createElement('button');reset.type='button';reset.className='btn btn-outline';reset.textContent='恢复默认';reset.onclick=()=>fill(engine().DEFAULTS);
    const cancel=document.createElement('button');cancel.type='button';cancel.className='btn btn-outline';cancel.textContent='取消';cancel.onclick=m.finish;
    const apply=document.createElement('button');apply.type='button';apply.id='applyRfSimulationSettings';apply.className='btn btn-primary';apply.textContent='应用到当前视图';
    apply.onclick=async()=>{
      const error=m.dialog.querySelector('#rfSimulationSettingsError');
      try{
        const next={};
        for(const [key,id]of Object.entries(fields)){
          const input=m.dialog.querySelector('#'+id);
          if(input.value.trim()===''||!input.checkValidity())throw new Error('请填写有效的'+input.parentElement.firstChild.textContent);
          next[key]=Number(input.value);
        }
        const mode=m.dialog.querySelector('#simImdMode').value;next.includeImd=mode!=='off';next.includeFifth=mode.endsWith('+5');next.includeThreeTone=mode.startsWith('3-full');
        engine().build([],{startMHz:400,endMHz:900},next); // Validate atomically before replacing visible settings.
        if(global.DatyBusinessDatabase){
          const signature=()=>JSON.stringify([...m.dialog.querySelectorAll('input,select')].map(input=>input.value)),submitted=signature();
          apply.disabled=true;
          try{if(!await global.DatyBusinessDatabase.saveSimulation(next,()=>m.dialog.isConnected&&signature()===submitted))return;}
          finally{apply.disabled=false;}
        }
        settings=next;cachedKey='';m.finish();global.drawSpectrum();
      }catch(e){error.textContent=e.message||String(e);error.hidden=false;}
    };
    m.footer.append(reset,cancel,apply);m.show();
  }
  function table(body,heading,columns,rows){
    const h=document.createElement('h3');h.textContent=heading;body.append(h);
    if(!rows.length){const p=document.createElement('p');p.textContent='当前显示范围内无对应结果。';body.append(p);return;}
    const wrap=document.createElement('div');wrap.className='rf-simulation-table-wrap';
    const t=document.createElement('table');t.className='data-table';const thead=document.createElement('thead'),tr=document.createElement('tr');
    for(const label of columns){const th=document.createElement('th');th.textContent=label;tr.append(th);}thead.append(tr);t.append(thead);
    const tbody=document.createElement('tbody');
    for(const row of rows.slice(0,100)){const line=document.createElement('tr');for(const value of row){const td=document.createElement('td');td.textContent=String(value);line.append(td);}tbody.append(line);}
    t.append(tbody);wrap.append(t);body.append(wrap);
    if(rows.length>100){const p=document.createElement('p');p.textContent=`显示前100项，共${rows.length}项；图形及合并范围使用完整计算结果。`;body.append(p);}
  }
  const mhz=value=>(value/1000).toFixed(3);
  function openRanges(){
    global.drawSpectrum?.();
    if(!currentView)return global.notify?.('ℹ️','暂无仿真结果','请启用干扰仿真并接收设备数据');
    const {result:r,startMHz,endMHz}=currentView,m=modal('rfSimulationRanges','干扰仿真范围明细');if(!m)return;
    const intro=document.createElement('p');intro.textContent=`视图 ${startMHz.toFixed(3)}–${endMHz.toFixed(3)} MHz。平滑超阈区不等于实际干扰；浅色范围是±${r.options.rippleDb} dB纹理的可能越阈边界，不是统计置信区间。频率避让与电平阈值分别计算，不自动修改规划或告警。`;m.body.append(intro);
    const policy=document.createElement('p');policy.textContent=`全场保守避让：取当前场景各 Profile 最大要求，载波中心间隔 ${r.guardPolicy?.channelSpacingKHz ?? '未知'} kHz，互调保护 ${r.guardPolicy?.intermodSpacingKHz ?? '未知'} kHz。不是每一台接收机的精确干扰范围；距离恰好等于要求时允许，接壤安全点不合并。`;m.body.append(policy);
    const coverage=document.createElement('p');coverage.textContent=r.coverage?.complete===false?'互调计算未完整覆盖：请查看下面的容量提示，不能据此判定无冲突。':'已完成本次所选模型范围内的互调频点计算；不代表已检查所有阶数或硬件干扰。';m.body.append(coverage);
    for(const warning of r.warnings||[]){const p=document.createElement('p');p.className='rf-simulation-warning';p.textContent=warning;m.body.append(p);}
    table(m.body,'平滑包络超阈范围',['起始 MHz','结束 MHz','判定阈值'],r.ranges.map(x=>[mhz(x.startKHz),mhz(x.endKHz),'≥ '+r.options.thresholdDbm+' dBm']));
    table(m.body,'含锯齿的可能越阈范围',['起始 MHz','结束 MHz','依据'],(r.possibleRanges||[]).map(x=>[mhz(x.startKHz),mhz(x.endKHz),'包络 + 最大纹理幅度 ≥ 阈值']));
    table(m.body,'全场保守避让区（严格重叠才合并）',['起始 MHz','结束 MHz','端点规则'],r.guardRanges.map(x=>[mhz(x.startKHz),mhz(x.endKHz),
      `${x.openStart===false?'左端为视窗截取':'左端允许'}；${x.openEnd===false?'右端为视窗截取':'右端允许'}`]));
    const products=r.products.filter(p=>p.frequencyKHz>=startMHz*1000&&p.frequencyKHz<=endMHz*1000);
    table(m.body,'互调候选频点（数学位置，幅值为情景假设）',['频率 MHz','阶数 / 类型','代表来源 MHz','情景峰值 dBm'],products.map(x=>[mhz(x.frequencyKHz),
      `${x.order}阶 · ${x.kind==='three-tone'?'三频':'双频'}`,
      (x.sourceFrequenciesKHz||[]).map(mhz).join(' / ')+(x.sourceCount>1?`（${x.sourceCount}组同频组合）`:''),
      typeof x.peakDbm==='number'&&Number.isFinite(x.peakDbm)?x.peakDbm.toFixed(1):'未知（源 RF 缺失）']));
    const note=document.createElement('p');note.textContent='同频源和产物按最大参考幅值显示，不把不同接收位置的 RSSI 相加；缺 RF 仅影响幅值与超阈判断，不删除已知频点的数学互调/避让区。真实干扰功率还需要同一测量参考面、非线性参数和实际扫描。';m.body.append(note);
    const close=document.createElement('button');close.className='btn btn-primary';close.textContent='关闭';close.onclick=m.finish;m.footer.append(close);m.show();
  }
  const clearDisplay=()=>{currentView=null;};
  global.DatyRfSimulationView=Object.freeze({get,getOptions,openSettings,openRanges,clearDisplay,adoptDatabaseOptions(value){engine().build([],{startMHz:400,endMHz:900},value);settings={...value};cachedKey='';global.drawSpectrum?.();}});
})(window);
