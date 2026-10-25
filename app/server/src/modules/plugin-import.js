/* UI orchestrates preview/confirmation/one install. The server owns installation truth. */
globalThis.DatyPluginImport = (() => {
  let busy = false, unresolved = null;
  const report = (message, unknown = false) => {
    const state = document.getElementById('pluginImportState');
    if (state) { state.hidden = false; state.textContent = message; }
    const query = document.getElementById('pluginImportQuery'); if (query) query.hidden = !unknown;
  };
  const resultOf = (result, pending) => {
    if (result?.operation_id !== pending.operation_id || result?.sha256 !== pending.sha256 || result?.id !== pending.id) throw Error('安装回执与本次插件不匹配');
    if (result.activation === 'active' && result.state === 'installed') {
      unresolved = null; report(pending.brand + ' 插件已安装并启用 · ' + pending.version);
      globalThis.DatyBrandPlugins?.syncVisibility(); return true;
    }
    if (result.activation === 'failed') { unresolved = null; report('插件安装已记录，但启用失败：' + (result.error || '请检查服务器日志')); return false; }
    report('安装结果尚未确认，请查询结果。',true); return false;
  };
  async function query() {
    if (busy || !unresolved) return false;
    const pending = unresolved; busy = true;
    try {
      if (pending.base !== _fasheApiUrl) throw Error('请连接原服务器后查询');
      const generation = _serverGeneration;
      const result = await globalThis.DatyPluginRpc(pending.base,'plugins.operation',{operation_id:pending.operation_id});
      if (pending.base !== _fasheApiUrl || generation !== _serverGeneration) return false;
      return resultOf(result,pending);
    } catch (error) {
      if (error.code === 'INSTALL_OPERATION_NOT_FOUND' && pending.base === _fasheApiUrl) {
        unresolved = null; report('服务器未记录本次安装，可以重新选择插件包。');
      } else report('安装结果未确认：' + (error.message || String(error)) + '。查询不会重新安装。',true);
      return false;
    }
    finally { busy = false; }
  }
  async function start() {
    if (busy) return false;
    if (unresolved) return query();
    busy = true;
    const button = document.getElementById('brandPluginImport'), controller = new AbortController();
    const base = typeof _fasheApiUrl === 'string' ? _fasheApiUrl : '', generation = _serverGeneration;
    const current = () => !controller.signal.aborted && base === _fasheApiUrl && generation === _serverGeneration;
    const cancel = () => controller.abort();
    globalThis.addEventListener?.('pagehide',cancel,{once:true});
    if (button) { button.disabled = true; button.setAttribute('aria-busy','true'); }
    let pending = null;
    try {
      if (!base) throw Error('请先连接服务器');
      if (typeof globalThis.DatyPluginRpc !== 'function') throw Error('插件导入接口尚未加载，请刷新页面后重试');
      const selected = await globalThis.DatyPluginImportHost.open(globalThis,{signal:controller.signal,maxBytes:131072});
      if (!current() || selected?.status === 'cancelled') return false;
      if (!(selected?.bytes instanceof Uint8Array) || !selected.bytes.length || selected.bytes.length > 131072) throw Error('无效的插件 ZIP');
      let binary = ''; for (const byte of selected.bytes) binary += String.fromCharCode(byte);
      const package_base64 = globalThis.btoa(binary);
      report('正在校验插件包…');
      const preview = await globalThis.DatyPluginRpc(base,'plugins.preview',{package_base64},controller.signal);
      if (!current()) return false;
      const digest = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',selected.bytes)),b => b.toString(16).padStart(2,'0')).join('');
      if (!current()) return false;
      if (preview?.trusted !== true || preview.sha256 !== digest || !Number.isInteger(preview.revision) || !preview.id || !preview.brand) throw Error('插件校验结果不一致');
      const status = await globalThis.DatyPluginRpc(base,'plugins.status',{},controller.signal);
      if (!current()) return false;
      if (!Array.isArray(status?.plugins) || status.revision !== preview.revision) throw Error('服务器插件状态已变化，请重新选择插件包');
      const existing = status.plugins.find(item => item.id === preview.id);
      if (existing?.sha256 === digest && existing.version === preview.version && existing.state === 'installed' && existing.active === true && existing.activation === 'active') {
        report(preview.brand + ' 插件已导入并启用 · ' + preview.version + '，无需重复安装');
        globalThis.DatyBrandPlugins?.syncVisibility(); return true;
      }
      const confirmed = await globalThis.DatyDialogs.confirm({title:'导入品牌插件',message:'安装并启用 ' + preview.name + '？',
        columns:[{key:'brand',label:'品牌'},{key:'version',label:'版本'},{key:'files',label:'源码文件数'}],
        rows:[{brand:preview.brand,version:preview.version,files:String(preview.source_files)}],
        warnings:preview.compatibility_import ? ['此源码包已由平台审核，按兼容安装配置导入。'] : [],confirmLabel:'安装并启用'});
      if (!confirmed || !current()) { if(current())report('已取消，未安装插件。'); return false; }
      pending = {...preview,base,operation_id:globalThis.crypto.randomUUID().replaceAll('-','')};
      unresolved = pending; report('正在保存并启用插件…');
      const result = await globalThis.DatyPluginRpc(base,'plugins.install',{package_base64,operation_id:pending.operation_id,
        expected_revision:preview.revision,sha256:preview.sha256},controller.signal);
      if (!current()) return false;
      return resultOf(result,pending);
    } catch (error) {
      if (pending && ['PLUGIN_REVISION_CHANGED','PLUGIN_PACKAGE_CHANGED','INSTALL_REQUEST_EXPIRED','REQUEST_EXPIRED','SERVER_BOOT_CHANGED','PLUGIN_UPDATE_REQUIRES_MAINTENANCE','PLUGIN_PACKAGE_NOT_TRUSTED','INSTALLED_FILES_CHANGED'].includes(error.code)) {
        unresolved = null; pending = null;
      }
      if (current()) report(pending ? '安装结果未确认，请查询结果；不会自动重复安装。' : '插件未安装：' + (error.message || String(error)),!!pending);
      return false;
    } finally {
      busy = false; globalThis.removeEventListener?.('pagehide',cancel);
      if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }
  }
  return Object.freeze({start,query});
})();
