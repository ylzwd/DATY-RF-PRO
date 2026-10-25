/* ZIP input is a replaceable host capability. No text decoding of binary files. */
globalThis.DatyPluginImportHost = Object.freeze({
  open(runtime, {signal, maxBytes = 131072} = {}) {
    const platform = runtime.DatyPlatform, port = runtime.DatyBinaryImports;
    const check = result => {
      if (signal?.aborted || runtime.DatyPlatform !== platform || runtime.DatyBinaryImports !== port) return {status:'cancelled'};
      if (result?.status === 'cancelled') return result;
      if (result?.status !== 'selected' || !(result.bytes instanceof Uint8Array) || !result.bytes.length || result.bytes.length > maxBytes) throw Error('插件包无效或超过 128 KiB');
      return result;
    };
    if (signal?.aborted) return Promise.resolve({status:'cancelled'});
    if (port !== undefined || platform?.kind !== 'browser') {
      if (port?.VERSION !== 'daty-binary-import-v1' || typeof port.openBytes !== 'function') return Promise.reject(Error('当前宿主未提供 ZIP 读取接口'));
      try {
        const operation = port.openBytes({accept:'.zip',maxBytes,signal});
        if (!operation || typeof operation.then !== 'function') throw Error('ZIP 读取接口必须返回异步结果');
        let abort;
        const cancelled = new Promise(resolve => { abort = () => resolve({status:'cancelled'}); signal?.addEventListener('abort',abort,{once:true}); });
        if (signal?.aborted) abort();
        return Promise.race([operation,cancelled]).then(check).finally(() => signal?.removeEventListener('abort',abort));
      } catch (error) { return Promise.reject(error); }
    }
    // Called synchronously from the button event so the chooser retains user activation.
    return new Promise((resolve,reject) => {
      const input = runtime.document.createElement('input'); input.type = 'file'; input.accept = '.zip,application/zip'; input.hidden = true;
      let settled = false;
      const finish = (value,error) => {
        if (settled) return; settled = true; input.remove(); signal?.removeEventListener('abort',cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => finish({status:'cancelled'});
      input.addEventListener('cancel',cancel,{once:true}); signal?.addEventListener('abort',cancel,{once:true});
      input.addEventListener('change',async () => {
        try {
          const file = input.files?.[0]; if (!file) return cancel();
          if (!/\.zip$/i.test(file.name) || file.size < 1 || file.size > maxBytes) throw Error('请选择不超过 128 KiB 的插件 ZIP');
          const bytes = new Uint8Array(await file.arrayBuffer());
          finish(check({status:'selected',bytes,name:file.name}));
        } catch (error) { finish(null,error); }
      },{once:true});
      try { runtime.document.body.appendChild(input); input.click(); } catch(error) { finish(null,error); }
    });
  }
});
