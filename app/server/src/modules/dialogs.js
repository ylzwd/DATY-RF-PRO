// 应用内确认界面适配层：只接收展示数据并返回 Promise<boolean>，不访问设备或发送命令。
// 原生栈迁移时可替换此模块的视图实现，保留调用方的预检/ACK 事务。
(function(global){
  'use strict';
  const injected=global.DatyDialogs;
  const nativeHost=global.DatyPlatform!==undefined && global.DatyPlatform?.kind!=='browser';
  if(injected!==undefined || nativeHost){
    // Retain the supplied native implementation; only guard its async result.
    // No DOM modal is created when a native capability is missing or fails.
    let pending=null;
    function confirm(options={}){
      if(pending)return Promise.resolve(false);
      return new Promise((resolve,reject)=>{
        if(!injected || typeof injected.confirm!=='function' || typeof injected.cancelActive!=='function'
          || (injected.VERSION!==undefined && injected.VERSION!=='daty-dialogs-v1')){
          reject(new TypeError('DatyDialogs: native confirmation capability is unavailable'));return;
        }
        const ticket={finish};pending=ticket;
        function finish(value,error){
          if(pending!==ticket)return;
          pending=null;global.removeEventListener?.('pagehide',cancelActive);
          if(error)reject(error);else resolve(value===true);
        }
        global.addEventListener?.('pagehide',cancelActive);
        try{
          const result=injected.confirm(options);
          if(!result || typeof result.then!=='function')throw new TypeError('DatyDialogs: confirm must return Promise<boolean>');
          Promise.resolve(result).then(value=>{
            if(typeof value!=='boolean')finish(false,new TypeError('DatyDialogs: confirmation result must be boolean'));
            else finish(value);
          },error=>finish(false,error));
        }catch(error){finish(false,error);}
      });
    }
    function cancelActive(){
      if(!pending)return;
      const ticket=pending;
      // Settle first; a synchronous/late host completion cannot authorize work.
      ticket.finish(false);
      try{injected.cancelActive();}catch(_){/* cancellation remains fail-closed */}
    }
    global.DatyDialogs=Object.freeze({VERSION:'daty-dialogs-v1',confirm,cancelActive,isOpen:()=>!!pending});
    return;
  }
  let active=null;
  const text=value=>String(value ?? '');
  const defaultColumns=[
    {key:'brand',label:'品牌'}, {key:'receiver',label:'接收机'}, {key:'channel',label:'通道'},
    {key:'currentFrequency',label:'当前频率',numeric:true}, {key:'plannedFrequency',label:'规划频率',numeric:true}
  ];
  function confirm(options={}) {
    // 单一模态操作，不排队展示可能已经过期的确认内容。
    if(active)return Promise.resolve(false);
    return new Promise((resolve,reject)=>{
      const opener=document.activeElement;
      const dialog=document.createElement('dialog');
      dialog.id='datyConfirmDialog';dialog.className='daty-confirm-dialog';
      dialog.setAttribute('aria-labelledby','datyConfirmTitle');
      dialog.setAttribute('aria-describedby','datyConfirmMessage datyConfirmWarnings');
      // 此模板仅含固定 UI 文本；设备名称、IP、备注等数据只写入 textContent。
      dialog.innerHTML=`<header class="daty-confirm-head">
        <span class="daty-confirm-symbol" aria-hidden="true">↑</span>
        <div class="daty-confirm-heading"><div class="daty-confirm-eyebrow">DATY RF PRO · 操作确认</div><h2 id="datyConfirmTitle"></h2></div>
        <button id="datyConfirmClose" class="daty-confirm-close" type="button" aria-label="关闭并取消">×</button>
      </header>
      <div class="daty-confirm-body">
        <p id="datyConfirmMessage" class="daty-confirm-message"></p>
        <div class="daty-confirm-table-wrap" tabindex="0" role="region" aria-label="下发目标清单">
          <table class="daty-confirm-table"><thead></thead><tbody id="datyConfirmRows"></tbody></table>
        </div>
        <dl id="datyConfirmDetails" class="daty-confirm-details" hidden></dl>
        <div id="datyConfirmWarnings" class="daty-confirm-warnings"></div>
      </div>
      <footer class="daty-confirm-footer"><span id="datyConfirmFootnote"></span><div class="daty-confirm-actions">
        <button id="datyConfirmCancel" class="btn btn-outline" type="button" autofocus>取消</button>
        <button id="datyConfirmAccept" class="btn btn-primary" type="button">确认</button>
      </div></footer>`;
      const get=id=>dialog.querySelector('#'+id);
      get('datyConfirmTitle').textContent=text(options.title || '确认操作');
      get('datyConfirmMessage').textContent=text(options.message);
      get('datyConfirmFootnote').textContent=text(options.footnote || '确认前请核对操作内容');
      get('datyConfirmAccept').textContent=text(options.confirmLabel || '确认');
      get('datyConfirmCancel').textContent=text(options.cancelLabel || '取消');
      const details=Array.isArray(options.details)?options.details:[];
      if(details.length){
        dialog.classList.add('daty-confirm-details-dialog');
        get('datyConfirmDetails').hidden=false;
        for(const item of details){
          const dt=document.createElement('dt'),dd=document.createElement('dd');
          dt.textContent=text(item.label);dd.textContent=text(item.value);
          get('datyConfirmDetails').append(dt,dd);
        }
      }
      if(options.symbol)dialog.querySelector('.daty-confirm-symbol').textContent=text(options.symbol);
      if(options.eyebrow)dialog.querySelector('.daty-confirm-eyebrow').textContent=text(options.eyebrow);
      if(options.tone==='danger')dialog.classList.add('daty-confirm-danger');
      const rows=Array.isArray(options.rows)?options.rows:[];
      const columns=Array.isArray(options.columns)&&options.columns.length?options.columns:defaultColumns;
      const head=document.createElement('tr');
      for(const column of columns){const th=document.createElement('th');th.scope='col';th.textContent=text(column.label);head.appendChild(th);}
      dialog.querySelector('thead').appendChild(head);
      const fragment=document.createDocumentFragment();
      for(const row of rows){
        const tr=document.createElement('tr');
        for(const column of columns){
          const td=document.createElement('td'),value=text(row[column.key]);
          td.className=column.numeric?'daty-confirm-frequency':'';
          const span=document.createElement('span');span.textContent=value;td.title=value;td.appendChild(span);
          if(column.key==='plannedFrequency' && row.note){const note=document.createElement('small');note.textContent=text(row.note);td.appendChild(note);}
          tr.appendChild(td);
        }
        fragment.appendChild(tr);
      }
      get('datyConfirmRows').appendChild(fragment);
      dialog.querySelector('.daty-confirm-table-wrap').hidden=!rows.length;
      const warnings=Array.isArray(options.warnings)?options.warnings:[];
      for(const warning of warnings){const p=document.createElement('p');p.textContent=text(warning);get('datyConfirmWarnings').appendChild(p);}
      get('datyConfirmWarnings').hidden=!warnings.length;
      let settled=false;
      function restoreFocus(){
        if(!active && opener?.isConnected && !opener.disabled && typeof opener.focus==='function'
          && (!document.activeElement || document.activeElement===document.body || document.activeElement===opener))opener.focus({preventScroll:true});
      }
      function finish(accepted){
        if(settled)return;settled=true;
        global.removeEventListener?.('pagehide',cancel);
        active=null;
        if(dialog.open)dialog.close();
        dialog.remove();
        restoreFocus();
        resolve(accepted===true);
        // 调用方会在 await 的 finally 里解除按钮禁用；不要把取消后的焦点丢到页面外。
        global.queueMicrotask?.(restoreFocus);
      }
      function cancel(){finish(false);}
      get('datyConfirmAccept').addEventListener('click',()=>finish(true));
      get('datyConfirmCancel').addEventListener('click',cancel);
      get('datyConfirmClose').addEventListener('click',cancel);
      dialog.addEventListener('cancel',event=>{event.preventDefault();cancel();});
      dialog.addEventListener('close',cancel);
      dialog.addEventListener('keydown',event=>{
        if(event.key!=='Tab')return;
        const focusable=[...dialog.querySelectorAll('button:not([disabled]),[tabindex]:not([tabindex="-1"])')]
          .filter(element=>element.getClientRects().length);
        const index=focusable.indexOf(document.activeElement);
        if(index===-1 || (event.shiftKey && index===0) || (!event.shiftKey && index===focusable.length-1)){
          event.preventDefault();focusable[event.shiftKey?focusable.length-1:0]?.focus({preventScroll:true});
        }
      });
      try{
        active={cancel};document.body.appendChild(dialog);
        if(typeof dialog.showModal!=='function')throw new Error('当前环境不支持应用内确认界面，请使用新版服务器客户端');
        dialog.showModal();get('datyConfirmCancel').focus({preventScroll:true});
        global.addEventListener?.('pagehide',cancel);
      }catch(error){active=null;dialog.remove();reject(error);}
    });
  }
  global.DatyDialogs=Object.freeze({confirm,cancelActive:()=>active?.cancel(),isOpen:()=>!!active});
})(window);
