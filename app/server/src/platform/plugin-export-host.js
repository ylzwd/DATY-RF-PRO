/* ZIP file output belongs to the host; an explicit native host never falls back to browser DOM. */
globalThis.DatyPluginExportHost = Object.freeze({
  async save(runtime, bytes, options) {
    const platform = runtime.DatyPlatform, port = runtime.DatyBinaryExports, signal = options.signal;
    if (!(bytes instanceof Uint8Array) || !bytes.length || !/^[a-zA-Z0-9._-]+\.zip$/.test(options.fileName)) throw Error('无效的配接文件');
    if (signal?.aborted) return {status:'cancelled'};
    if (port !== undefined || platform?.kind !== 'browser') {
      if (port?.VERSION !== 'daty-binary-export-v1' || typeof port.saveBytes !== 'function') throw Error('当前宿主未提供 ZIP 保存接口');
      let abort;
      const cancelled = new Promise(resolve => { abort = () => resolve({status:'cancelled'}); signal?.addEventListener('abort',abort,{once:true}); });
      try {
        const operation = port.saveBytes(bytes, {...options, mimeType:'application/zip'});
        if (!operation || typeof operation.then !== 'function') throw Error('ZIP 保存接口必须返回异步结果');
        const result = await Promise.race([operation, cancelled]);
        if (signal?.aborted || runtime.DatyPlatform !== platform || runtime.DatyBinaryExports !== port) return {status:'cancelled'};
        if (!['saved','cancelled'].includes(result?.status)) throw Error('ZIP 保存结果未确认');
        return result;
      } finally { signal?.removeEventListener('abort',abort); }
    }
    const url = runtime.URL.createObjectURL(new runtime.Blob([bytes], {type:'application/zip'}));
    let link;
    try {
      link = runtime.document.createElement('a'); link.href = url; link.download = options.fileName; link.hidden = true;
      runtime.document.body.appendChild(link); link.click();
      return {status:'download-started'};
    } finally {
      link?.remove();
      // Give the browser time to consume the download URL; no business timers or retries.
      const schedule = runtime.DatyHostFactory ? (fn, ms) => runtime.DatyHostFactory.invokeRuntime(runtime,'setTimeout',fn,ms) : runtime.setTimeout.bind(runtime);
      schedule(() => runtime.URL.revokeObjectURL(url), 30000);
    }
  }
});
