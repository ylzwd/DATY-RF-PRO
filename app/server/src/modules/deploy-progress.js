// 频率下发进度视图适配层。计数由调用方在验证设备确认后提供；此模块不发送命令、轮询设备或模拟进度。
// 原生栈迁移时可替换 open/update/close 的视图实现，保持下发事务及 ACK 校验不变。
(function(global){
  'use strict';
  const injected=global.DatyDeployProgress;
  if(injected!==undefined || (global.DatyPlatform!==undefined && global.DatyPlatform?.kind!=='browser')) {
    let session=null;
    global.DatyDeployProgress=Object.freeze({open(options={}){
      if(session && session.platform!==global.DatyPlatform)session.dispose();
      if(session)throw new Error('已有下发进度窗口，请先关闭上次结果');
      if(!injected || injected.VERSION!=='daty-deploy-progress-v1' || typeof injected.open!=='function')throw new Error('当前客户端未提供原生下发进度窗口');
      const rows=options.rows,ids=new Set((rows || []).map(row=>String(row.id)));
      if(!Array.isArray(rows) || !rows.length || rows.some(row=>row.id===null || row.id===undefined) || ids.size!==rows.length)throw new Error('下发进度目标 ID 缺失或重复');
      const platform=global.DatyPlatform;let handle,phase='running',stopped=false,observed=false,opened=false,closed=false;
      const ticket={platform,dispose},copy=value=>JSON.parse(JSON.stringify(value));session=ticket;
      const owns=()=>!closed && session===ticket && global.DatyPlatform===platform;
      function dispose(){if(closed)return;closed=true;if(session===ticket)session=null;global.removeEventListener?.('pagehide',dispose);handle?.close();}
      function close(){if(owns() && phase!=='running')dispose();}
      function update(snapshot={}){
        if(!owns() || phase!=='running')return;
        const total=rows.length,{acknowledged,skipped,failed,remaining}=snapshot,completed=acknowledged+skipped;
        if(!['running','success','failed','stopped','unchanged'].includes(snapshot.phase) || snapshot.total!==total
          || ![acknowledged,skipped,failed,remaining].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=total) || completed+failed+remaining!==total)throw new Error('下发进度状态或计数不一致');
        const readback=snapshot.readbackConfirmed||0;if(!Number.isSafeInteger(readback)||readback<0||readback>acknowledged)throw new Error('回读确认计数无效');
        if(snapshot.phase==='success' && !(acknowledged>0&&completed===total&&failed===0&&remaining===0))throw new Error('下发成功必须有对应接收机的完整状态确认');
        if(snapshot.phase==='unchanged' && !(acknowledged===0&&skipped===total&&failed===0&&remaining===0))throw new Error('无需下发的通道计数不一致');
        if(['failed','stopped'].includes(snapshot.phase)&&completed===total)throw new Error('未完成的下发不能显示完整成功进度');
        const progressRows=Array.isArray(snapshot.rows)?snapshot.rows:[];
        if(acknowledged||skipped||failed||progressRows.some(row=>['sending','readback_confirmed','acknowledged','unchanged','failed'].includes(row.state)))observed=true;
        phase=snapshot.phase;handle.update({...copy(snapshot),rows:copy(progressRows.filter(row=>ids.has(String(row.id))&&['queued','sending','readback_confirmed','acknowledged','unchanged','failed','not-sent'].includes(row.state)))});
      }
      function failBeforeSend(message){
        if(!owns()||phase!=='running')return;if(observed)throw new Error('已开始执行下发，不能按发送前失败清理进度');
        update({phase:'failed',total:rows.length,acknowledged:0,skipped:0,failed:0,remaining:rows.length,message:String(message || '下发准备失败，本次未发送指令。'),rows:rows.map(row=>({id:row.id,state:'not-sent',text:'未发送 · 下发准备失败'}))});
      }
      try {
        handle=injected.open({title:options.title,rows:copy(rows),
          onStop(){if(!opened||!owns()||phase!=='running'||stopped)return;stopped=true;options.onStop?.();},
          onClose(){if(!opened||!owns()||phase==='running')return false;close();return true;}});
        if(!handle || typeof handle.then==='function' || typeof handle.update!=='function' || typeof handle.close!=='function'){
          if(handle?.then)Promise.resolve(handle).catch(()=>{});
          throw new TypeError('原生下发进度须同步返回 update/close 会话');
        }
        opened=true;global.addEventListener?.('pagehide',dispose,{once:true});return Object.freeze({update,close,failBeforeSend});
      }catch(error){try{dispose();}catch(_){}throw error;}
    }});return;
  }
  let active=null;
  const text=value=>String(value ?? '');
  const phases=new Set(['running','success','failed','stopped','unchanged']);
  const states=new Set(['queued','sending','readback_confirmed','acknowledged','unchanged','failed','not-sent']);
  const stateLabels={queued:'排队待发送',sending:'等待设备确认',readback_confirmed:'回读确认',acknowledged:'设备 ACK',unchanged:'原频一致 · 无需发送',failed:'下发失败','not-sent':'未发送'};
  function open(options={}){
    if(active)throw new Error('已有下发进度窗口，请先关闭上次结果');
    const rows=Array.isArray(options.rows)?options.rows:[];
    if(!rows.length)throw new Error('下发进度缺少目标通道');
    const ids=new Set();
    for(const row of rows){
      if(row.id===undefined || row.id===null || ids.has(text(row.id)))throw new Error('下发进度目标 ID 缺失或重复');
      ids.add(text(row.id));
    }
    const opener=document.activeElement;
    const dialog=document.createElement('dialog');
    dialog.id='datyProgressDialog';dialog.className='daty-progress-dialog';dialog.tabIndex=-1;
    dialog.setAttribute('aria-labelledby','datyProgressTitle');
    dialog.setAttribute('aria-describedby','datyProgressMessage datyProgressFootnote');
    // 固定结构；品牌、IP、CH、频率和错误内容仅通过 textContent 写入。
    dialog.innerHTML=`<header class="daty-progress-head">
      <span id="datyProgressSymbol" class="daty-progress-symbol" aria-hidden="true">↑</span>
      <div class="daty-progress-heading"><div class="daty-progress-eyebrow">DATY RF PRO · 接收机执行反馈</div><h2 id="datyProgressTitle"></h2></div>
      <button id="datyProgressDismiss" class="daty-progress-dismiss" type="button" aria-label="关闭下发结果" disabled>×</button>
    </header>
    <div class="daty-progress-body">
      <section class="daty-progress-overview" aria-label="下发进度">
        <div class="daty-progress-meter-heading"><span id="datyProgressCurrent"></span><strong id="datyProgressValue">0%</strong></div>
        <progress id="datyProgressBar" max="1" value="0" aria-label="接收机确认及无需发送的通道进度"></progress>
        <p id="datyProgressCounts" class="daty-progress-counts"></p>
        <p id="datyProgressMessage" class="daty-progress-message" role="status" aria-live="polite" aria-atomic="true"></p>
      </section>
      <div class="daty-progress-table-wrap" tabindex="0" role="region" aria-label="各通道执行结果">
        <table class="daty-progress-table"><thead><tr><th scope="col">品牌</th><th scope="col">接收机</th><th scope="col">通道</th><th scope="col">目标频率</th><th scope="col">执行状态</th></tr></thead><tbody id="datyProgressRows"></tbody></table>
      </div>
    </div>
    <footer class="daty-progress-footer"><span id="datyProgressFootnote">停止后续不会取消正在等待确认 的指令，也不会回退已执行的频率。</span><div class="daty-progress-actions">
      <button id="datyProgressStop" class="btn btn-outline" type="button">停止后续</button>
      <button id="datyProgressClose" class="btn btn-primary" type="button" hidden>关闭</button>
    </div></footer>`;
    const get=id=>dialog.querySelector('#'+id);
    const rowElements=new Map();
    const fragment=document.createDocumentFragment();
    for(const row of rows){
      const tr=document.createElement('tr');tr.dataset.state='queued';
      for(const field of ['brand','receiver','channel','frequency']){
        const td=document.createElement('td');td.textContent=text(row[field]);td.title=text(row[field]);
        if(field==='frequency')td.className='daty-progress-frequency';
        tr.appendChild(td);
      }
      const status=document.createElement('td');status.className='daty-progress-row-status';status.textContent=stateLabels.queued;tr.appendChild(status);
      rowElements.set(text(row.id),{tr,status});fragment.appendChild(tr);
    }
    get('datyProgressRows').appendChild(fragment);
    let phase='running',closed=false,stopRequested=false,executionObserved=false;
    const token={};
    const owns=()=>!closed && active===token;
    function restoreFocus(){
      if(!active && opener?.isConnected && !opener.disabled && typeof opener.focus==='function'
        && (!document.activeElement || document.activeElement===document.body || document.activeElement===opener))opener.focus({preventScroll:true});
    }
    function dispose(){
      if(!owns())return;
      closed=true;active=null;
      global.removeEventListener?.('pagehide',dispose);
      if(dialog.open)dialog.close();
      dialog.remove();restoreFocus();global.queueMicrotask?.(restoreFocus);
    }
    function close(){
      // 调用方和用户都不能在 ACK 未决时将执行窗口误当作“取消指令”。
      if(owns() && phase!=='running')dispose();
    }
    function update(snapshot={}){
      if(!owns())return;
      if(!phases.has(snapshot.phase))throw new Error('未知的下发进度状态');
      // 已完成的窗口保留原结果，不接受延迟到达的旧 running 更新。
      if(phase!=='running')return;
      const total=rows.length;
      if(snapshot.total!==total)throw new Error('下发进度目标数量发生变化');
      const {acknowledged,skipped,failed,remaining}=snapshot;
      if(![acknowledged,skipped,failed,remaining].every(value=>Number.isSafeInteger(value) && value>=0 && value<=total)
        || acknowledged+skipped+failed+remaining!==total)throw new Error('下发进度计数不完整或不一致');
      const completed=acknowledged+skipped;
      const readback=snapshot.readbackConfirmed||0;if(!Number.isSafeInteger(readback)||readback<0||readback>acknowledged)throw new Error('回读确认计数无效');
      // 错误快照必须显式失败，不能通过截断、补零或把“已处理行”改算成 ACK 来展示成功。
      if(snapshot.phase==='success' && !(acknowledged>0 && completed===total && failed===0 && remaining===0))throw new Error('下发成功必须有对应接收机的完整状态确认');
      if(snapshot.phase==='unchanged' && !(acknowledged===0 && skipped===total && failed===0 && remaining===0))throw new Error('无需下发的通道计数不一致');
      if((snapshot.phase==='failed' || snapshot.phase==='stopped') && completed===total)throw new Error('未完成的下发不能显示完整成功进度');
      if(acknowledged || skipped || failed || (Array.isArray(snapshot.rows) && snapshot.rows.some(row=>['sending','readback_confirmed','acknowledged','unchanged','failed'].includes(row.state))))executionObserved=true;
      phase=snapshot.phase;dialog.dataset.phase=phase;
      const running=phase==='running';
      const titles={success:'下发成功',failed:'下发失败',stopped:'下发已停止',unchanged:'无需下发'};
      get('datyProgressTitle').textContent=running?text(options.title || (total===1?'等待接收机确认':'下发进行中')):titles[phase];
      get('datyProgressSymbol').textContent=running?'↑':phase==='success'?'✓':phase==='unchanged'?'＝':'!';
      const percent=Math.floor(completed/total*100);
      const bar=get('datyProgressBar');bar.max=total;bar.value=completed;
      bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax',text(total));bar.setAttribute('aria-valuenow',text(completed));
      bar.setAttribute('aria-valuetext',`设备 ACK ${acknowledged-(snapshot.readbackConfirmed||0)} · 回读确认 ${snapshot.readbackConfirmed||0} 个，原频一致无需发送 ${skipped} 个，共 ${total} 个通道`);
      get('datyProgressValue').textContent=`${percent}%`;
      get('datyProgressCurrent').textContent=text(snapshot.currentLabel || (running?'正在核对并等待接收机确认':'本次执行结果'));
      get('datyProgressCounts').textContent=`设备 ACK ${acknowledged-(snapshot.readbackConfirmed||0)} · 回读确认 ${snapshot.readbackConfirmed||0} · 原频一致 ${skipped} · 失败 ${failed} · 未完成 ${remaining} / 共 ${total} 个通道`;
      get('datyProgressMessage').textContent=text(snapshot.message || (running?'收到并核对设备确认后，进度才会更新。':phase==='success'?'已发送的频率均已收到对应接收机的状态确认。':phase==='unchanged'?'所有目标与当前频率一致，本次未发送指令，未产生设备 ACK。':'未确认的通道不计为下发成功，请核对各通道执行结果。'));
      for(const row of (Array.isArray(snapshot.rows)?snapshot.rows:[])){
        const entry=rowElements.get(text(row.id));
        if(!entry || !states.has(row.state))continue;
        entry.tr.dataset.state=row.state;entry.status.textContent=text(row.text || stateLabels[row.state]);
        entry.status.title=entry.status.textContent;
      }
      get('datyProgressStop').hidden=!running;
      get('datyProgressStop').disabled=stopRequested || !running;
      get('datyProgressClose').hidden=running;
      get('datyProgressDismiss').disabled=running;
      get('datyProgressFootnote').textContent=running
        ?(stopRequested?'已请求停止后续；当前指令仍等待状态确认，结束后可关闭。':'停止后续不会取消正在等待确认 的指令，也不会回退已执行的频率。')
        :'结果已保留；已执行的频率不会因关闭窗口而回退。';
      if(!running)get('datyProgressClose').focus({preventScroll:true});
    }
    function failBeforeSend(message){
      if(!owns() || phase!=='running')return;
      // 仅用于初始进度建立/预检失败；已经进入发送流程时绝不能假称“全部未发送”。
      if(executionObserved)throw new Error('已开始执行下发，不能按发送前失败清理进度');
      update({phase:'failed',total:rows.length,acknowledged:0,skipped:0,failed:0,remaining:rows.length,
        message:text(message || '下发准备失败，本次未发送指令。'),
        rows:rows.map(row=>({id:row.id,state:'not-sent',text:'未发送 · 下发准备失败'}))});
    }
    get('datyProgressStop').addEventListener('click',()=>{
      if(!owns() || phase!=='running' || stopRequested)return;
      stopRequested=true;get('datyProgressStop').disabled=true;get('datyProgressStop').textContent='已请求停止';
      get('datyProgressFootnote').textContent='已请求停止后续；当前指令仍等待状态确认，结束后可关闭。';
      try{options.onStop?.();}catch(error){get('datyProgressMessage').textContent='停止请求未完成：'+text(error?.message || error);}
    });
    get('datyProgressClose').addEventListener('click',close);
    get('datyProgressDismiss').addEventListener('click',close);
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('close',()=>{if(owns() && phase!=='running')dispose();});
    dialog.addEventListener('keydown',event=>{
      if(event.key!=='Tab')return;
      const focusable=[...dialog.querySelectorAll('button:not([disabled]),[tabindex]:not([tabindex="-1"])')]
        .filter(element=>!element.hidden && element.getClientRects().length);
      const index=focusable.indexOf(document.activeElement);
      if(!focusable.length){event.preventDefault();dialog.focus({preventScroll:true});return;}
      if(index===-1 || (event.shiftKey && index===0) || (!event.shiftKey && index===focusable.length-1)){
        event.preventDefault();focusable[event.shiftKey?focusable.length-1:0]?.focus({preventScroll:true});
      }
    });
    try{
      active=token;document.body.appendChild(dialog);
      if(typeof dialog.showModal!=='function')throw new Error('当前环境不支持下发进度窗口，请使用新版服务器客户端');
      update({phase:'running',total:rows.length,acknowledged:0,skipped:0,failed:0,remaining:rows.length,rows:[]});
      dialog.showModal();get('datyProgressStop').focus({preventScroll:true});
      global.addEventListener?.('pagehide',dispose);
    }catch(error){dispose();throw error;}
    return Object.freeze({update,close,failBeforeSend});
  }
  global.DatyDeployProgress=Object.freeze({open});
})(window);
