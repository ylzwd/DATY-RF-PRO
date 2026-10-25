/* Browser/native host boundary. Explicit r19 reset clears only known business caches before initialization. */
(function (root, makeFactory) {
  'use strict';
  var factory = makeFactory();
  if (typeof module === 'object' && module.exports) {
    module.exports = factory;
    return;
  }
  // A native shell may install its complete adapter before application scripts.
  var adapter = root.DatyPlatform === undefined
    ? factory.createBrowser(root)
    : factory.create(factory.validate(root.DatyPlatform));
  root.DatyPlatformFactory = factory;
  root.DatyDataRetention=Object.freeze({history:false,scans:false,planning:false,alertsAudit:false,archives:false});
  const transient=new Map(),retiredKey=key=>/^(daty_(alerts$|db_alerts$|pending_alerts|alert_archive|planning_history|server_(draft|archive|export)|scan|rf_simulation))/.test(String(key));
  root.DatyPlatform = factory.create({...adapter,storage:{
    getItem:key=>retiredKey(key)?(transient.get(key)??null):adapter.storage.getItem(key),
    setItem:(key,value)=>retiredKey(key)?transient.set(key,String(value)):adapter.storage.setItem(key,value),
    removeItem:key=>retiredKey(key)?transient.delete(key):adapter.storage.removeItem(key)
  }});
  // Optional, independently versioned async input. Existing 1.0.0 ports stay intact.
  root.DatyTextFileFactory = factory.textFiles;
  root.DatyTextExportFactory = factory.textExports;
  root.DatyHostFactory = factory.host;
  // Explicitly authorized r19 clean start. Run before any business cache reads.
  // One marker per deployment: subsequent reloads preserve all newly saved data.
  if(root.document && root.location) {
    const epoch="3e9fae7920f14e248e6362a61b4a6cd4", marker='daty_formal_reset_epoch_v1';
    let error=null;
    try {
      const storage=adapter.storage;
      if(storage.getItem(marker)!==epoch) {
        const keys=["daty_devices", "daty_alerts", "daty_db_alerts", "daty_pending_alerts_v1", "daty_alert_archive_meta_v1", "daty_equipment_profiles_v1", "daty_equipment_profiles_v2", "daty_planning_history_v1", "daty_planner_constraints_v1", "daty_alert_thresholds_v1", "daty_receiver_group_numbers_v1", "daty_alert_sound_v1", "daty_auto_frequency_v1", "specStartFreq", "specEndFreq", "daty_server_archive_job_v1", "daty_server_draft_pending_v1", "daty_server_export_pending_v1"];
        const local=root.localStorage;
        if(local)for(let i=0;i<local.length;i++) {
          const key=local.key(i);
          if(key?.startsWith('daty_business_pending_v1:'))keys.push(key);
        }
        for(const key of keys)storage.removeItem(key);
        for(const key of keys)if(storage.getItem(key)!==null)throw Error('旧业务缓存未清空');
        storage.setItem(marker,epoch);
        if(storage.getItem(marker)!==epoch)throw Error('初始化标记未保存');
      }
    } catch(failure) { error=String(failure.message||failure); }
    root.DatyFreshStart=Object.freeze({epoch,error});
  }

})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = '1.0.0';

  function requireFunction(value, name) {
    if (typeof value !== 'function') throw new TypeError('DatyPlatform: ' + name + ' must be a function');
  }

  function validatePorts(ports) {
    if (!ports || typeof ports !== 'object') throw new TypeError('DatyPlatform: complete ports are required');
    if (typeof ports.kind !== 'string' || !ports.kind.trim()) throw new TypeError('DatyPlatform: kind is required');
    requireFunction(ports.request, 'request');
    requireFunction(ports.openEventStream, 'openEventStream');
    requireFunction(ports.downloadText, 'downloadText');
    if (!ports.storage) throw new TypeError('DatyPlatform: storage is required');
    ['getItem', 'setItem', 'removeItem'].forEach(function (method) {
      requireFunction(ports.storage[method], 'storage.' + method);
    });
    return ports;
  }

  function validate(adapter) {
    validatePorts(adapter);
    if (adapter.VERSION !== VERSION) throw new TypeError('DatyPlatform: unsupported adapter VERSION');
    return adapter;
  }

  const SERVICE_PORTS = Object.freeze({web: '8080', bridge: '8802', ip: '8765', mqtt: '8083', native: '8801'});

  // Only saved, known Bridge preferences may be migrated. Transport requests are
  // never redirected/retried, and custom plaintext endpoints fail before any I/O.
  function normalizeBridgeUrl(value) {
    const url = new URL(String(value || '').trim() || 'https://127.0.0.1:8802');
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new TypeError('Bridge 地址必须是 HTTPS 服务根地址，不含路径、凭据或查询参数');
    }
    if (url.protocol === 'http:' && url.port === SERVICE_PORTS.bridge) url.protocol = 'https:';
    if (url.protocol !== 'https:') throw new TypeError('Bridge 仅允许 HTTPS；自定义 HTTP 地址不会被自动连接');
    if (url.hostname === 'localhost' && url.port === SERVICE_PORTS.bridge) url.hostname = '127.0.0.1';
    return url.origin;
  }

  function serviceOrigin(service, host) {
    if (!SERVICE_PORTS[service]) throw new TypeError('Unknown DATY service');
    const hostname = String(host || '127.0.0.1').trim();
    if (/[\/@?#\\]/.test(hostname)) throw new TypeError('Service host must be a hostname, without URL credentials or path');
    const url = new URL((service === 'mqtt' ? 'wss://' : 'https://') + hostname + ':' + SERVICE_PORTS[service]);
    if (url.hostname !== hostname.toLowerCase() || url.port !== SERVICE_PORTS[service]) throw new TypeError('Invalid service host');
    if (service === 'bridge' && url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.origin;
  }

  function assertSecureServiceUrl(value, base) {
    let url;
    try { url = new URL(String(value), base); } catch (_) { return; }
    if (Object.values(SERVICE_PORTS).includes(url.port) && !['https:', 'wss:'].includes(url.protocol)) {
      throw new TypeError('DATY 服务仅允许 HTTPS / WSS；TLS 失败时不会退回明文连接');
    }
  }

  function create(ports) {
    validatePorts(ports);
    if (ports.VERSION !== undefined && ports.VERSION !== VERSION) {
      throw new TypeError('DatyPlatform: unsupported adapter VERSION');
    }
    // Explicit injection is all-or-nothing: missing host ports never use browser I/O.
    return Object.freeze({
      VERSION: VERSION,
      kind: ports.kind,
      request: function (url, init) { assertSecureServiceUrl(url); return ports.request(url, init); },
      openEventStream: function (url, init) { assertSecureServiceUrl(url); return ports.openEventStream(url, init); },
      storage: Object.freeze({
        getItem: function (key) { return ports.storage.getItem(key); },
        setItem: function (key, value) { return ports.storage.setItem(key, value); },
        removeItem: function (key) { return ports.storage.removeItem(key); }
      }),
      downloadText: function (text, options) { return ports.downloadText(text, options); }
    });
  }

  function createBrowser(browser) {
    if (browser === undefined) browser = typeof globalThis !== 'undefined' ? globalThis : undefined;
    if (!browser) throw new TypeError('DatyPlatform: browser runtime is unavailable');
    // Resolve browser facilities at the time of use, preserving late test/host stubs.
    return create({
      kind: 'browser',
      request: function (url, init) {
        assertSecureServiceUrl(url, browser.location && browser.location.href);
        // Direct HTTPS transport; receiver pairing remains in the Broker.
        requireFunction(browser.fetch, 'browser.fetch');
        return browser.fetch(url, {...init, credentials: 'omit', redirect: 'error'});
      },
      openEventStream: function (url, init) {
        assertSecureServiceUrl(url, browser.location && browser.location.href);
        requireFunction(browser.EventSource, 'browser.EventSource');
        return new browser.EventSource(url, init);
      },
      storage: {
        getItem: function (key) { return browser.localStorage.getItem(key); },
        setItem: function (key, value) { return browser.localStorage.setItem(key, value); },
        removeItem: function (key) { return browser.localStorage.removeItem(key); }
      },
      downloadText: function (text, options) {
        if (!options || typeof options.fileName !== 'string' || !options.fileName.trim()) {
          throw new TypeError('DatyPlatform: download fileName is required');
        }
        var mimeType = options.mimeType === undefined ? 'text/plain;charset=utf-8' : options.mimeType;
        if (typeof mimeType !== 'string' || !mimeType.trim()) {
          throw new TypeError('DatyPlatform: download mimeType must be a nonempty string');
        }
        var doc = browser.document;
        if (!doc || !doc.body || typeof doc.createElement !== 'function') {
          throw new TypeError('DatyPlatform: download requires a browser document');
        }
        requireFunction(browser.Blob, 'browser.Blob');
        var urls = browser.URL;
        requireFunction(urls && urls.createObjectURL, 'browser.URL.createObjectURL');
        requireFunction(urls && urls.revokeObjectURL, 'browser.URL.revokeObjectURL');
        var blob = new browser.Blob([text], {type: mimeType});
        var link = null, objectUrl, hasUrl = false, failure, failed = false;
        try {
          objectUrl = urls.createObjectURL(blob);
          hasUrl = true;
          link = doc.createElement('a');
          link.href = objectUrl;
          link.download = options.fileName;
          doc.body.appendChild(link);
          link.click();
        } catch (error) {
          failure = error;
          failed = true;
        } finally {
          try {
            if (link && link.parentNode) link.parentNode.removeChild(link);
          } catch (error) {
            if (!failed) { failure = error; failed = true; }
          }
          try {
            if (hasUrl) urls.revokeObjectURL(objectUrl);
          } catch (error) {
            if (!failed) { failure = error; failed = true; }
          }
        }
        if (failed) throw failure;
      }
    });
  }

  // Independently versioned optional facilities; platform 1.0.0 stays unchanged.
  const HOST_RUNTIME_VERSION = 'daty-host-runtime-v1';
  const HOST_MESSAGES_VERSION = 'daty-host-messages-v1';
  const timerRecords = new WeakMap(), browserRuntimes = new WeakMap();
  const runtimeMethods = ['setTimeout','clearTimeout','setInterval','clearInterval','nowEpochMs','nowMonotonicMs'];
  function browserOwned(runtime) {
    return runtime.DatyPlatform === undefined || runtime.DatyPlatform?.kind === 'browser';
  }
  function syncHostResult(value, description) {
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {});
      throw new TypeError('DatyHost: ' + description + ' must be synchronous');
    }
    return value;
  }
  function runtimePort(runtime) {
    const injected = runtime.DatyHostRuntime;
    if (injected !== undefined) {
      if (!injected || injected.VERSION !== HOST_RUNTIME_VERSION
          || runtimeMethods.some(method => typeof injected[method] !== 'function')) {
        throw new TypeError('DatyHost: complete daty-host-runtime-v1 capability is required');
      }
      return injected;
    }
    if (!browserOwned(runtime)) throw new TypeError('DatyHost: native runtime capability is unavailable');
    if (!browserRuntimes.has(runtime)) browserRuntimes.set(runtime, {
      get setTimeout() { return runtime.setTimeout.bind(runtime); },
      get clearTimeout() { return runtime.clearTimeout.bind(runtime); },
      get setInterval() { return runtime.setInterval.bind(runtime); },
      get clearInterval() { return runtime.clearInterval.bind(runtime); },
      nowEpochMs:() => (runtime.Date || Date).now(), nowMonotonicMs:() => runtime.performance.now()
    });
    return browserRuntimes.get(runtime);
  }
  function invokeRuntime(runtime, method, ...args) {
    if (!runtime || !runtimeMethods.includes(method)) throw new TypeError('DatyHost: unknown runtime operation');
    if (method === 'clearTimeout' || method === 'clearInterval') {
      const token = args[0];
      if (token === null || token === undefined) return;
      const record = timerRecords.get(token);
      if (!record || record.runtime !== runtime) throw new TypeError('DatyHost: timer does not belong to this runtime');
      if (!record.active) return;
      record.active = false;
      syncHostResult(record.cancel.call(record.port, record.id), 'timer cancellation');
      return;
    }
    const port = runtimePort(runtime);
    if (method === 'nowEpochMs' || method === 'nowMonotonicMs') {
      const value = syncHostResult(port[method](), 'clock');
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('DatyHost: clock must return finite milliseconds');
      return value;
    }
    const [callback, delay] = args;
    if (typeof callback !== 'function' || typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
      throw new TypeError('DatyHost: timers require a callback and a nonnegative millisecond delay');
    }
    const token = Object.freeze({});
    const record = {runtime, port, cancel:port[method === 'setTimeout' ? 'clearTimeout' : 'clearInterval'], active:true, id:null};
    timerRecords.set(token, record);
    try {
      record.id = syncHostResult(port[method](() => {
        if (!record.active) return;
        if (method === 'setTimeout') record.active = false;
        return callback();
      }, delay), 'timer creation');
      return token;
    } catch (error) { record.active = false; throw error; }
  }
  function usesMessagePort(runtime) {
    return runtime.DatyHostMessages !== undefined || !browserOwned(runtime);
  }
  function invokeMessage(runtime, method, ...args) {
    if (!['confirm','alert','notify'].includes(method)) throw new TypeError('DatyHost: unknown message operation');
    const injected = runtime.DatyHostMessages;
    let value;
    if (injected !== undefined) {
      if (!injected || injected.VERSION !== HOST_MESSAGES_VERSION || typeof injected[method] !== 'function') {
        throw new TypeError('DatyHost: message capability is unavailable: ' + method);
      }
      value = injected[method](...args);
    } else {
      if (!browserOwned(runtime) || method === 'notify' || typeof runtime[method] !== 'function') {
        throw new TypeError('DatyHost: message capability is unavailable: ' + method);
      }
      value = runtime[method](...args);
    }
    syncHostResult(value, method);
    if (method === 'confirm' && typeof value !== 'boolean') throw new TypeError('DatyHost: confirm must return a synchronous boolean');
    if (method !== 'confirm' && value !== undefined) throw new TypeError('DatyHost: message output must return void');
    return value;
  }
  const host = Object.freeze({VERSION:HOST_RUNTIME_VERSION, MESSAGES_VERSION:HOST_MESSAGES_VERSION,
    invokeRuntime, invokeMessage, usesMessagePort});

  const TEXT_FILE_VERSION = 'daty-text-file-v1';
  const pendingInputs = new WeakMap();
  const inputLifecycles = new WeakSet();
  const cancelledInput = () => ({status:'cancelled'});

  function inputOptions(options) {
    if (!options || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0
        || typeof options.accept !== 'string' || !options.accept.trim()) {
      throw new TypeError('文件导入必须指定格式及有效的字节上限');
    }
    if (options.signal && (typeof options.signal.addEventListener !== 'function'
        || typeof options.signal.removeEventListener !== 'function')) throw new TypeError('无效的文件取消信号');
    return {...options};
  }

  function textBytes(text, limit) {
    let size = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x80) size++;
      else if (code < 0x800) size += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
          && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
      else size += 3;
      if (size > limit) throw new Error('文件超过导入大小上限（' + limit + ' 字节），原数据未更改');
    }
    return size;
  }

  function validateTextResult(result, options) {
    if (result && result.status === 'cancelled') return cancelledInput();
    if (!result || result.status !== 'completed' || typeof result.text !== 'string'
        || typeof result.name !== 'string' || !result.name.trim() || /[\\/\u0000]/.test(result.name)
        || !Number.isSafeInteger(result.sizeBytes) || result.sizeBytes < 0) {
      throw new TypeError('文件宿主返回的数据格式无效');
    }
    if (result.sizeBytes > options.maxBytes) throw new Error('文件超过导入大小上限（' + options.maxBytes + ' 字节），原数据未更改');
    // Do not trust host metadata alone. Bound the actual decoded content as well.
    textBytes(result.text, options.maxBytes);
    return {status:'completed', name:result.name, text:result.text.replace(/^\uFEFF/, ''), sizeBytes:result.sizeBytes};
  }

  function createTextFiles(port) {
    return Object.freeze({VERSION:TEXT_FILE_VERSION, openText(options) {
      return new Promise((resolve, reject) => {
        let opts, done = false;
        const finish = (error, result) => {
          if (done) return;
          done = true;
          opts?.signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(result);
        };
        const abort = () => finish(null, cancelledInput());
        try {
          opts = inputOptions(options);
          if (opts.signal?.aborted) { abort(); return; }
          opts.signal?.addEventListener('abort', abort, {once:true});
          if (!port || port.VERSION !== TEXT_FILE_VERSION || typeof port.openText !== 'function') {
            throw new TypeError('当前宿主尚未提供文件导入能力；不会改用浏览器读取');
          }
          // Invoke within the original user gesture, not in a deferred microtask.
          const result = port.openText(opts);
          Promise.resolve(result).then(value => {
            if (done) return;
            try { finish(null, validateTextResult(value, opts)); } catch (error) { finish(error); }
          }, error => finish(error));
        } catch (error) { finish(error); }
      });
    }});
  }

  function createBrowserTextFiles(browser) {
    return createTextFiles({VERSION:TEXT_FILE_VERSION, openText(options) {
      return new Promise((resolve, reject) => {
        let input, reader, done = false;
        const finish = (error, result) => {
          if (done) return;
          done = true;
          options.signal?.removeEventListener('abort', abort);
          browser.removeEventListener?.('pagehide', abort);
          if (reader) {
            reader.onload = reader.onerror = reader.onabort = null;
            if (reader.readyState === 1) { try { reader.abort(); } catch (_) { /* already cancelled */ } }
          }
          input?.remove();
          if (error) reject(error); else resolve(result);
        };
        const abort = () => finish(null, cancelledInput());
        try {
          if (options.signal?.aborted) { abort(); return; }
          options.signal?.addEventListener('abort', abort, {once:true});
          browser.addEventListener?.('pagehide', abort, {once:true});
          input = browser.document.createElement('input');
          input.type = 'file'; input.accept = options.accept; input.style.display = 'none';
          input.addEventListener('cancel', abort, {once:true});
          input.addEventListener('change', () => {
            if (done) return;
            const file = input.files && input.files[0];
            if (!file) { abort(); return; }
            try {
              if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('无法确定文件大小');
              if (file.size > options.maxBytes) throw new Error('文件超过导入大小上限（' + options.maxBytes + ' 字节），原数据未更改');
              reader = new browser.FileReader();
              reader.onload = () => finish(null, {status:'completed', name:file.name, sizeBytes:file.size, text:reader.result});
              reader.onerror = () => finish(new Error('无法读取文件，原数据未更改'));
              reader.onabort = abort;
              reader.readAsText(file, 'utf-8');
            } catch (error) { finish(error); }
          }, {once:true});
          browser.document.body.appendChild(input);
          input.click();
        } catch (error) { finish(error); }
      });
    }});
  }

  function cancelPendingInput(runtime) {
    const previous = pendingInputs.get(runtime);
    pendingInputs.delete(runtime);
    if (previous) { previous.cancel(); previous.controller?.abort(); }
  }

  function openLatestText(runtime, options) {
    try { options = inputOptions(options); } catch (error) { return Promise.reject(error); }
    // One lifecycle hook per runtime, not per read. It also invalidates a finished
    // result if page teardown occurs between promise resolution and UI commit.
    if (!inputLifecycles.has(runtime) && typeof runtime.addEventListener === 'function') {
      runtime.addEventListener('pagehide', () => cancelPendingInput(runtime));
      inputLifecycles.add(runtime);
    }
    cancelPendingInput(runtime);
    const platform = runtime.DatyPlatform, injected = runtime.DatyTextFiles;
    let cancel;
    const cancellation = new Promise(resolve => { cancel = () => resolve(cancelledInput()); });
    const controller = typeof runtime.AbortController === 'function' ? new runtime.AbortController() : null;
    const ticket = {controller, cancel};
    pendingInputs.set(runtime, ticket);
    const externalAbort = () => { cancel(); controller?.abort(); };
    options.signal?.addEventListener('abort', externalAbort, {once:true});
    if (options.signal?.aborted) externalAbort();
    let operation;
    try {
      const adapter = injected !== undefined ? createTextFiles(injected)
        : platform === undefined || platform?.kind === 'browser' ? createBrowserTextFiles(runtime) : createTextFiles(null);
      operation = adapter.openText({...options, signal:controller?.signal || options.signal});
    } catch (error) { operation = Promise.reject(error); }
    const isCurrent = () => pendingInputs.get(runtime) === ticket
      && runtime.DatyPlatform === platform && runtime.DatyTextFiles === injected && !options.signal?.aborted;
    // Race cancellation even when a native host ignores AbortSignal or never settles.
    return Promise.race([operation, cancellation]).then(result => isCurrent() ? {...result, isCurrent} : cancelledInput(), error => {
      if (!isCurrent()) return cancelledInput();
      // Errors have the same caller-await race as successful results. Do not
      // mutate the injected host's error; attach a local-only notification guard.
      const failure = new Error(error?.message || String(error));
      failure.name = 'TextFileError'; failure.cause = error; failure.isCurrent = isCurrent;
      throw failure;
    }).finally(() => {
      options.signal?.removeEventListener('abort', externalAbort);
      ticket.controller = null;
      // Keep the generation until the next operation: callers must check it at
      // commit time too, after their own await continuation has been scheduled.
    });
  }

  const textExports = Object.freeze({VERSION:'daty-text-export-v1', async saveText(runtime,text,options) {
    if(typeof text!=='string' || !options || typeof options.fileName!=='string' || !options.fileName.trim()
      || /[\\/\x00-\x1f]/.test(options.fileName) || typeof options.mimeType!=='string' || !options.mimeType.trim())
      throw new TypeError('DatyTextExports: invalid text/file options');
    const platform=runtime.DatyPlatform, port=runtime.DatyTextExports, signal=options.signal;
    if(signal?.aborted)return {status:'cancelled'};
    if(port!==undefined || (platform!==undefined && platform?.kind!=='browser')) {
      if(!port || port.VERSION!=='daty-text-export-v1' || typeof port.saveText!=='function')
        throw new TypeError('DatyTextExports: native save capability is unavailable');
      let abort;
      const cancelled=new Promise(resolve=>{abort=()=>resolve({status:'cancelled'});signal?.addEventListener('abort',abort,{once:true});});
      try {
        const operation=port.saveText(text,{...options});
        if(!operation || typeof operation.then!=='function')throw new TypeError('DatyTextExports: saveText must return a Promise');
        const result=await Promise.race([operation,cancelled]);
        if(signal?.aborted || runtime.DatyPlatform!==platform || runtime.DatyTextExports!==port)return {status:'cancelled'};
        if(!result || !['saved','cancelled'].includes(result.status))throw new TypeError('DatyTextExports: invalid save result');
        return {status:result.status};
      } catch(error) {
        if(signal?.aborted || runtime.DatyPlatform!==platform || runtime.DatyTextExports!==port)return {status:'cancelled'};
        throw error;
      } finally {signal?.removeEventListener('abort',abort);}
    }
    if(!platform || typeof platform.downloadText!=='function')throw new TypeError('DatyTextExports: browser download capability is unavailable');
    platform.downloadText(text,{fileName:options.fileName,mimeType:options.mimeType});
    return {status:'download-started'};
  }});

  const textFiles = Object.freeze({VERSION:TEXT_FILE_VERSION, create:createTextFiles,
    createBrowser:createBrowserTextFiles, openLatest:openLatestText, cancelPending:cancelPendingInput});

  return Object.freeze({VERSION: VERSION, create: create, createBrowser: createBrowser, validate: validate, textFiles:textFiles, textExports:textExports, host:host,
    normalizeBridgeUrl: normalizeBridgeUrl, serviceOrigin: serviceOrigin, assertSecureServiceUrl: assertSecureServiceUrl});
});
