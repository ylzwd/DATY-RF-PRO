let developerPluginExportPending = false;
async function exportDeveloperPlugin(selectedId) {
  if (developerPluginExportPending) return false;
  developerPluginExportPending = true;
  const button = document.getElementById('developerPluginExport'), list = document.getElementById('developerPluginExports');
  const controller = new AbortController(), cancel = () => controller.abort();
  const base = typeof _fasheApiUrl === 'string' ? _fasheApiUrl : '', generation = _serverGeneration;
  const current = () => !controller.signal.aborted && base === _fasheApiUrl && generation === _serverGeneration;
  const timer = _discoveryRuntime('setTimeout', cancel, 10000);
  if (button) { button.disabled = true; button.setAttribute('aria-busy','true'); }
  if (list) { list.hidden = true; list.replaceChildren(); }
  globalThis.addEventListener?.('pagehide', cancel, {once:true});
  try {
    if (!base) throw Error('请先连接服务器');
    const response = await _discoveryRequest(base + '/api/capabilities', {method:'GET',cache:'no-store',signal:controller.signal});
    const data = await response.json();
    if (!current()) return false;
    if (!response.ok || !data?.success || !data.adapters || typeof data.adapters !== 'object' || Array.isArray(data.adapters)) throw Error('无法确认服务器已集成插件');
    const catalog = globalThis.DatyPluginSourceCatalog;
    if (!Array.isArray(catalog)) throw Error('配接文件目录尚未就绪');
    const available = catalog.filter(item => item.adapterKeys.some(key => Object.prototype.hasOwnProperty.call(data.adapters,key)
      && data.adapters[key] && typeof data.adapters[key] === 'object' && !Array.isArray(data.adapters[key])));
    const selected = selectedId ? available.find(item => item.id === selectedId) : available.length === 1 ? available[0] : null;
    if (!selected) {
      if (selectedId || !available.length) throw Error('当前服务器没有对应的可导出配接文件');
      if (!list) throw Error('插件选择列表不可用');
      const label = document.createElement('span'); label.textContent = '选择要导出的品牌配接文件：'; list.appendChild(label);
      for (const item of available) {
        const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'btn btn-outline btn-sm';
        choice.textContent = '📤 ' + item.name + ' ZIP'; choice.addEventListener('click', () => { void exportDeveloperPlugin(item.id); }); list.appendChild(choice);
      }
      list.hidden = false; return false;
    }
    const raw = globalThis.atob(selected.base64), bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    const digest = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
    if (!current()) return false;
    if (bytes.length !== selected.bytes || digest !== selected.sha256) throw Error('配接文件校验失败，请刷新后重试');
    _discoveryRuntime('clearTimeout', timer);
    const result = await globalThis.DatyPluginExportHost.save(globalThis, bytes, {fileName:selected.fileName,signal:controller.signal});
    if (!current() || result?.status === 'cancelled') return false;
    if (!['saved','download-started'].includes(result?.status)) throw Error('配接文件保存状态未确认');
    notify('📤', result.status === 'saved' ? '配接文件已保存' : '配接文件已开始下载', selected.name + ' · ' + selected.sourceFiles + ' 个源码文件 · ZIP 压缩包');
    return true;
  } catch (error) {
    if (base === _fasheApiUrl && generation === _serverGeneration) notify('❌','配接文件导出未完成',controller.signal.aborted ? '请求已取消或超时，请重试' : error.message || String(error));
    return false;
  } finally {
    _discoveryRuntime('clearTimeout', timer); developerPluginExportPending = false;
    globalThis.removeEventListener?.('pagehide', cancel);
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
  }
}
