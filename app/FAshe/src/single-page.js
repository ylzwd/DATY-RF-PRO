// Layout adapter only: every channel stays in the DOM and in the original telemetry model.
(function(global){
  'use strict';
  let start=0,capacity=1,queued=false,lastCanvasWidth=0;
  const byId=id=>document.getElementById(id);
  function refresh(){
    const grid=byId('deviceCards');
    if(!grid||!grid.clientWidth||!grid.clientHeight)return;
    const cards=Array.from(grid.children).filter(node=>node.classList.contains('device-card'));
    // 桌面一页八张（四列两行），窄卡独立启用紧凑排版。
    const columns=Math.min(4,Math.max(1,Math.floor((grid.clientWidth+8)/164)));
    grid.classList.toggle('compact-cards',(grid.clientWidth-(columns-1)*8)/columns<250);
    const minimumHeight=parseFloat(global.getComputedStyle(grid).getPropertyValue('--card-min-height'))||190;
    const rows=Math.min(2,Math.max(1,Math.floor((grid.clientHeight+8)/(minimumHeight+8))));
    capacity=columns*rows;
    start=Math.min(Math.floor(start/capacity)*capacity,Math.max(0,Math.ceil(cards.length/capacity)-1)*capacity);
    grid.style.setProperty('--card-columns',String(columns));
    grid.style.setProperty('--card-rows',String(rows));
    cards.forEach((card,index)=>{card.hidden=index<start||index>=start+capacity;});
    const state=byId('devicePagerState');
    const description=cards.length?`${start+1}–${Math.min(cards.length,start+capacity)} / ${cards.length} · 第 ${Math.floor(start/capacity)+1}/${Math.ceil(cards.length/capacity)} 页`:'暂无通道';
    if(state.textContent!==description)state.textContent=description;
    byId('devicePrevPage').disabled=start===0;
    byId('deviceNextPage').disabled=start+capacity>=cards.length;
  }
  function resized(){
    if(queued)return;queued=true;
    global.requestAnimationFrame(()=>{
      queued=false;refresh();
      const canvas=byId('interferenceCanvas');
      if(canvas?.offsetWidth&&byId('tab-interference')?.classList.contains('active')&&canvas.offsetWidth!==lastCanvasWidth){
        lastCanvasWidth=canvas.offsetWidth;global.initInterferenceCanvas?.();
      }
    });
  }
  function changePage(direction){start=Math.max(0,start+(direction<0?-capacity:capacity));refresh();byId('deviceCards').scrollTop=0;}
  function showSidebar(section){
    const diagnostics=section==='diagnostics';
    byId('sidebarConnection').hidden=diagnostics;byId('sidebarDiagnostics').hidden=!diagnostics;
    document.querySelectorAll('[data-sidebar-tab]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.sidebarTab===(diagnostics?'diagnostics':'connection'))));
  }
  function toggleSettings(){
    const shown=document.body.classList.toggle('receiver-settings-open');
    document.querySelector('.compact-settings-btn').setAttribute('aria-expanded',String(shown));
    global.switchTab?.('monitor');refresh();
  }
  global.FasheViewport=Object.freeze({refresh,changePage,showSidebar,toggleSettings});
  if(typeof ResizeObserver==='function'){
    const observer=new ResizeObserver(resized);observer.observe(byId('deviceCards'));observer.observe(byId('interferenceCanvas'));
  }
  global.addEventListener('resize',resized);
  refresh();
})(window);
