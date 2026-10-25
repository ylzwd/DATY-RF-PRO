/* Candidate business repository. No production mount, device commands, DOM or
 * browser fallbacks. Storage is a synchronous, non-secret recovery journal;
 * network persistence is explicitly asynchronous and never silently retried. */
(function (root, makeFactory) {
  'use strict';
  const factory = makeFactory();
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.DatyDatabaseClientFactory = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PROTOCOL = 'daty-business-db-v1', TIMEOUT_MS = 5000;
  const JOURNAL_PREFIX = 'daty_business_pending_v1:';
  const MAX_JSON_CHARS = 32 * 1024 * 1024;
  const secretKey = /^(?:authorization|password|passwd|credential[s]?|bearer|access[_-]?key|api[_-]?key|app[_-]?secret|client[_-]?secret|private[_-]?key|(?:access|refresh|id)[_-]?token|token|secret)$/i;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const fail = (code, message) => Object.assign(new Error(message), {code});
  function jsonCopy(value) {
    const visiting = new Set(); let nodes = 0;
    function check(item, depth) {
      if (++nodes > 4000000 || depth > 64) throw fail('INVALID_VALUE', 'Business JSON is too large or deeply nested');
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      if (!item || typeof item !== 'object' || visiting.has(item)) throw fail('INVALID_VALUE', 'Expected finite, acyclic JSON');
      const prototype = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw fail('INVALID_VALUE', 'Expected plain JSON objects');
      visiting.add(item);
      if (Object.getOwnPropertySymbols(item).length) throw fail('INVALID_VALUE', 'Symbol properties are not business JSON');
      for (const key of Object.getOwnPropertyNames(item)) {
        if (Array.isArray(item) && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !own(descriptor, 'value')) throw fail('INVALID_VALUE', 'Hidden properties and accessors are not business JSON');
      }
      if (Array.isArray(item) && (Object.keys(item).length !== item.length || Object.keys(item).some((key, index) => key !== String(index)))) throw fail('INVALID_VALUE', 'Sparse or decorated arrays are not business JSON');
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !own(descriptor, 'value')) throw fail('INVALID_VALUE', 'Accessors are not business JSON');
        if (secretKey.test(key)) throw fail('SECRET_DATA', 'Credentials cannot enter the business database journal');
        check(descriptor.value, depth + 1);
      }
      visiting.delete(item);
    }
    check(value, 0);
    const text = JSON.stringify(value);
    if (text.length > MAX_JSON_CHARS) throw fail('INVALID_VALUE', 'Business JSON exceeds the journal size limit');
    return JSON.parse(text);
  }
  function equal(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && equal(a[key], b[key]));
  }
  function textId(value, label, limit = 256) {
    if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw fail('INVALID_ID', `Invalid ${label}`);
    return value;
  }
  function target(kind, id) {
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(kind)) throw fail('INVALID_ID', 'Invalid resource kind');
    return {kind, id:textId(id, 'resource id')};
  }
  function scopeValue(value) {
    if (!value || typeof value.baseUrl !== 'string' || !(Number.isSafeInteger(value.accessRevision) && value.accessRevision >= 0
      || typeof value.accessRevision === 'string' && value.accessRevision.length > 0)) throw fail('INVALID_SCOPE', 'Server and public authorization generation are required');
    let url; try { url = new URL(value.baseUrl); } catch (_) { throw fail('INVALID_SCOPE', 'Invalid database server'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail('INVALID_SCOPE', 'Database requests require a credential-free HTTPS service origin');
    if (url.hostname === 'localhost' && url.port === '8802') url.hostname = '127.0.0.1';
    return {baseUrl:url.origin, principalId:textId(value.principalId, 'public principal id'), accessRevision:value.accessRevision};
  }
  const sameScope = (a, b) => !!a && !!b && a.baseUrl === b.baseUrl && a.principalId === b.principalId && a.accessRevision === b.accessRevision;
  const namespace = scope => ({baseUrl:scope.baseUrl, principalId:scope.principalId});
  const journalKey = (scope, item) => JOURNAL_PREFIX + encodeURIComponent(JSON.stringify([scope.baseUrl, scope.principalId, item.kind, item.id]));
  function resourceValue(value, item) {
    if (!value || value.kind !== item.kind || value.id !== item.id || !Number.isSafeInteger(value.revision) || value.revision < 1
      || typeof value.deleted !== 'boolean' || !own(value, 'value')) throw fail('INVALID_RESOURCE', 'Server resource identity, revision or value is invalid');
    return {kind:value.kind, id:value.id, revision:value.revision, value:jsonCopy(value.value), deleted:value.deleted};
  }
  function create(ports) {
    if (!ports || ['request','readScope','schedule','cancel'].some(key => typeof ports[key] !== 'function')
      || !ports.storage || ['getItem','setItem','removeItem'].some(key => typeof ports.storage[key] !== 'function')
      || ports.newOperationId !== undefined && typeof ports.newOperationId !== 'function') throw new TypeError('DatyDatabaseClient requires request/readScope/storage/schedule/cancel ports');
    let scope = null, epoch = null, generation = 0;
    const states = new Map();
    function invalidate() {
      generation++; epoch = null; scope = null;
      for (const state of states.values()) {
        const previous = state.active; state.active = null; state.loaded = false; state.resource = null;
        previous?.interrupt?.(fail('SCOPE_CHANGED', 'Database scope was invalidated'));
      }
      states.clear();
    }
    function synchronize() {
      const next = scopeValue(ports.readScope());
      if (!sameScope(scope, next)) { invalidate(); scope = next; }
      return scope;
    }
    function getState(item) {
      const key = JSON.stringify([item.kind, item.id]);
      if (!states.has(key)) states.set(key, {item, loaded:false, resource:null, epoch:null, active:null, status:'unloaded'});
      return states.get(key);
    }
    function current(ticket) {
      try { return ticket.state.active === ticket && ticket.generation === generation && sameScope(ticket.scope, scopeValue(ports.readScope())); }
      catch (_) { return false; }
    }
    function assertCurrent(ticket) { if (!current(ticket)) throw fail('SCOPE_CHANGED', 'Server or authorization changed'); }
    function readJournal(selectedScope, item) {
      const raw = ports.storage.getItem(journalKey(selectedScope, item));
      if (raw === null) return null;
      if (typeof raw !== 'string' || raw.length > MAX_JSON_CHARS) throw fail('JOURNAL_INVALID', 'Pending journal is unreadable; it has been preserved');
      let record;
      try { record = jsonCopy(JSON.parse(raw)); } catch (_) { throw fail('JOURNAL_INVALID', 'Pending journal is invalid; it has been preserved'); }
      const body = record.body;
      if (record.protocol !== PROTOCOL || !equal(record.scope, namespace(selectedScope)) || !body || body.kind !== item.kind || body.id !== item.id
        || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0 || body.expected_revision >= Number.MAX_SAFE_INTEGER
        || typeof body.deleted !== 'boolean' || !own(body, 'value')) throw fail('JOURNAL_INVALID', 'Pending journal does not match this resource');
      try { textId(body.operation_id, 'operation id'); textId(body.epoch, 'database epoch'); } catch (_) { throw fail('JOURNAL_INVALID', 'Pending operation identity is invalid'); }
      return {record, raw, key:journalKey(selectedScope, item)};
    }
    function clearJournal(pending) {
      // Never erase a concurrent controller's different request.
      if (ports.storage.getItem(pending.key) !== pending.raw) throw fail('JOURNAL_CHANGED', 'Pending journal changed; no data was removed');
      ports.storage.removeItem(pending.key);
      if (ports.storage.getItem(pending.key) !== null) throw fail('JOURNAL_WRITE_FAILED', 'Pending journal removal was not confirmed');
    }
    function writeJournal(selectedScope, body) {
      const item = target(body.kind, body.id);
      if (readJournal(selectedScope, item)) throw fail('PREVIOUS_POST_UNCONFIRMED', 'A previous operation must be reconciled first');
      const record = {protocol:PROTOCOL, scope:namespace(selectedScope), body:jsonCopy(body)};
      const pending = {record, raw:JSON.stringify(record), key:journalKey(selectedScope, item)};
      const result = ports.storage.setItem(pending.key, pending.raw);
      if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); throw fail('INVALID_STORAGE', 'Journal writes must complete synchronously'); }
      if (ports.storage.getItem(pending.key) !== pending.raw) throw fail('JOURNAL_WRITE_FAILED', 'Pending journal write was not confirmed');
      return pending;
    }
    function begin(item, action) {
      synchronize(); const state = getState(item);
      if (state.active) return {status:'busy', code:'RESOURCE_BUSY'};
      const ticket = {state, item, action, scope:{...scope}, generation, sent:false, interrupt:null};
      state.active = ticket; return ticket;
    }
    function envelope(body) {
      if (!body || body.protocol !== PROTOCOL) throw fail('UNSUPPORTED_PROTOCOL', 'Business database protocol is unavailable');
      textId(body.epoch, 'database epoch'); return body.epoch;
    }
    function requestJson(ticket, path, options = {}, onRefusal = () => {}) {
      assertCurrent(ticket);
      return new Promise((resolve, reject) => {
        const controller = new AbortController(); let timer, finished = false;
        const finish = (error, value) => {
          if (finished) return; finished = true;
          if (ticket.interrupt === interrupt) ticket.interrupt = null;
          try { if (timer !== undefined) ports.cancel(timer); } catch (error2) { error = error || error2; }
          if (error) reject(error); else resolve(value);
        };
        const interrupt = error => { controller.abort(); finish(error); };
        ticket.interrupt = interrupt;
        try {
          timer = ports.schedule(() => interrupt(fail('REQUEST_TIMEOUT', 'Database response was not confirmed within 5 seconds')), TIMEOUT_MS);
          if (timer === undefined || timer === null || typeof timer?.then === 'function') {
            if (typeof timer?.then === 'function') Promise.resolve(timer).catch(() => {});
            throw fail('INVALID_TIMER', 'Timer must synchronously return a cancellation handle');
          }
        } catch (error) { finish(error); return; }
        Promise.resolve().then(() => {
          if (finished) return;
          assertCurrent(ticket);
          if (options.method === 'POST') {
            if (!ticket.pending || ports.storage.getItem(ticket.pending.key) !== ticket.pending.raw) throw fail('JOURNAL_CHANGED', 'Pending journal changed before send; request was not sent');
            ticket.sent = true;
          }
          try { return ports.request(ticket.scope.baseUrl + path, {...options, cache:'no-store', redirect:'error', signal:controller.signal}); }
          catch (error) {
            if (error?.knownUnsent === true) { ticket.sent = false; onRefusal(); }
            throw error;
          }
        }).then(response => {
          // The authorization client may advance its generation before its 401
          // resolves. Refusal can release only this exact old journal, never a
          // newer scope's baseline or pending operation.
          if (response && (response.status === 401 || response.status === 403)) {
            onRefusal(); if (!finished) throw fail('UNAUTHORIZED', 'Database access was refused');
          }
          if (finished) return;
          assertCurrent(ticket);
          if (!response || !Number.isInteger(response.status) || typeof response.json !== 'function') throw fail('INVALID_RESPONSE', 'Invalid database HTTP response');
          return Promise.resolve(response.json()).then(body => ({response, body}));
        }).then(value => { if (!finished) { assertCurrent(ticket); finish(null, value); } }).catch(error => finish(error));
      });
    }
    function unknown(pending, code = 'PREVIOUS_POST_UNCONFIRMED') {
      return {status:'unknown', code, operationId:pending.record.body.operation_id, kind:pending.record.body.kind, id:pending.record.body.id};
    }
    function errorResult(ticket, error) {
      if (!current(ticket)) return {status:'invalidated', code:'SCOPE_CHANGED'};
      return {status:error.code === 'UNAUTHORIZED' ? 'unauthorized' : 'error', code:error.code || 'DATABASE_FAILED', message:error.message || String(error)};
    }
    function finish(ticket, result) {
      if (ticket.state.active === ticket) { ticket.state.active = null; ticket.state.status = result.status; }
      return result;
    }
    async function checkStatus(ticket) {
      const {response, body} = await requestJson(ticket, '/api/database/status');
      const foundEpoch = envelope(body);
      if (response.status !== 200 || body.success !== true) throw fail('DATABASE_READ_FAILED', 'Database status is unavailable');
      if (epoch !== null && epoch !== foundEpoch) {
        for (const state of states.values()) { state.loaded = false; state.resource = null; }
      }
      epoch = foundEpoch; return foundEpoch;
    }
    async function load(kind, id) {
      let ticket;
      try {
        ticket = begin(target(kind, id), 'load'); if (!ticket.state) return ticket;
        const pending = readJournal(ticket.scope, ticket.item);
        if (pending) return finish(ticket, unknown(pending));
        ticket.state.loaded = false;
        const foundEpoch = await checkStatus(ticket);
        const {response, body} = await requestJson(ticket, `/api/database/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
        if (envelope(body) !== foundEpoch || epoch !== foundEpoch) throw fail('EPOCH_CHANGED', 'Database was restored or replaced during loading');
        let resource;
        if (response.status === 404 && body.success === false) resource = null;
        else {
          if (response.status !== 200 || body.success !== true) throw fail('DATABASE_READ_FAILED', 'Resource could not be loaded');
          resource = resourceValue(body.resource, ticket.item);
        }
        ticket.state.resource = resource; ticket.state.epoch = foundEpoch; ticket.state.loaded = true;
        return finish(ticket, {status:'ready', epoch:foundEpoch, resource:resource === null ? null : jsonCopy(resource)});
      } catch (error) { const result = ticket?.state ? errorResult(ticket, error) : {status:'error', code:error.code || 'DATABASE_FAILED', message:error.message}; return ticket?.state ? finish(ticket, result) : result; }
    }
    function matchesWrite(body, resource) {
      return resource.kind === body.kind && resource.id === body.id && resource.revision === body.expected_revision + 1
        && resource.deleted === body.deleted && equal(resource.value, body.value);
    }
    async function save(kind, id, value, options = {}) {
      let ticket, pending, refused = false;
      try {
        const item = target(kind, id), checked = jsonCopy(value);
        if (!options || typeof options !== 'object' || options.deleted !== undefined && typeof options.deleted !== 'boolean') throw fail('INVALID_VALUE', 'deleted must be boolean');
        ticket = begin(item, 'save'); if (!ticket.state) return ticket;
        pending = readJournal(ticket.scope, item);
        if (pending) return finish(ticket, unknown(pending));
        if (!ticket.state.loaded || ticket.state.epoch !== epoch) return finish(ticket, {status:'unloaded', code:'LOAD_REQUIRED'});
        const operationId = ports.newOperationId ? ports.newOperationId() : globalThis.crypto?.randomUUID?.();
        const body = {operation_id:textId(operationId, 'operation id'), epoch:ticket.state.epoch, kind, id,
          expected_revision:ticket.state.resource?.revision || 0, value:checked, deleted:options.deleted === true};
        if (body.expected_revision >= Number.MAX_SAFE_INTEGER) throw fail('INVALID_REVISION', 'Resource revision cannot be incremented safely');
        pending = writeJournal(ticket.scope, body); ticket.pending = pending;
        const release = () => { refused = true; try { clearJournal(pending); } catch (_) { /* preserved as unknown */ } };
        const {response, body:reply} = await requestJson(ticket, '/api/database/write', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}, release);
        const replyEpoch = envelope(reply);
        if ([400,409,422,428].includes(response.status) && reply.success === false) {
          clearJournal(pending); refused = true; ticket.state.loaded = false;
          if (replyEpoch !== body.epoch) {
            for (const state of states.values()) state.loaded = false;
            epoch = replyEpoch;
          }
          return finish(ticket, {status:response.status === 409 ? 'conflict' : 'rejected', code:reply.code || (replyEpoch !== body.epoch ? 'EPOCH_CHANGED' : 'WRITE_REJECTED'), epoch:replyEpoch});
        }
        if (response.status !== 200 || reply.success !== true || replyEpoch !== body.epoch || epoch !== body.epoch || reply.operation_id !== body.operation_id) throw fail('UNCONFIRMED_WRITE', 'Database did not confirm the exact write');
        const resource = resourceValue(reply.resource, item);
        if (!matchesWrite(body, resource)) throw fail('UNCONFIRMED_WRITE', 'Database write receipt does not match the requested content');
        clearJournal(pending);
        ticket.state.resource = resource; ticket.state.loaded = true; ticket.state.epoch = replyEpoch;
        return finish(ticket, {status:'saved', epoch:replyEpoch, operationId:body.operation_id, resource:jsonCopy(resource)});
      } catch (error) {
        if (pending && ticket?.state && !ticket.sent && !refused) { try { clearJournal(pending); pending = null; } catch (_) {} }
        let result = ticket?.state ? errorResult(ticket, error) : {status:'error', code:error.code || 'DATABASE_FAILED', message:error.message};
        if (pending && ticket?.state) {
          try { const retained = readJournal(ticket.scope, ticket.item); if (retained) result = {...unknown(retained, error.code || 'WRITE_UNCONFIRMED'), invalidated:!current(ticket)}; }
          catch (_) { result = {status:'unknown', code:'JOURNAL_INVALID'}; }
        }
        if (ticket?.state && (ticket.sent || refused)) ticket.state.loaded = false;
        return ticket?.state ? finish(ticket, result) : result;
      }
    }
    async function reconcile(kind, id) {
      let ticket;
      try {
        ticket = begin(target(kind, id), 'reconcile'); if (!ticket.state) return ticket;
        const pending = readJournal(ticket.scope, ticket.item);
        if (!pending) { ticket.state.loaded = false; return finish(ticket, {status:'unloaded', code:'NO_PENDING_OPERATION'}); }
        const body = pending.record.body, foundEpoch = await checkStatus(ticket);
        if (foundEpoch !== body.epoch) return finish(ticket, {...unknown(pending, 'EPOCH_CHANGED'), epoch:foundEpoch});
        const {response, body:reply} = await requestJson(ticket, '/api/database/operations/' + encodeURIComponent(body.operation_id));
        if (envelope(reply) !== body.epoch || epoch !== body.epoch) return finish(ticket, unknown(pending, 'EPOCH_CHANGED'));
        // 404 cannot prove that an earlier in-flight write will never commit.
        if (response.status === 404 && reply.success === false) return finish(ticket, unknown(pending, 'OPERATION_NOT_FOUND'));
        if (response.status !== 200 || reply.success !== true || reply.operation?.operation_id !== body.operation_id || reply.operation.status !== 'committed') return finish(ticket, unknown(pending, 'UNCONFIRMED_OPERATION'));
        const resource = resourceValue(reply.operation.resource, ticket.item);
        if (!matchesWrite(body, resource)) return finish(ticket, unknown(pending, 'RECEIPT_MISMATCH'));
        clearJournal(pending);
        // A historical receipt proves this operation, not that its revision is
        // still current. Require an explicit resource load before another save.
        ticket.state.loaded = false; ticket.state.resource = null;
        return finish(ticket, {status:'reconciled', epoch:body.epoch, operationId:body.operation_id, resource:jsonCopy(resource), reloadRequired:true});
      } catch (error) {
        let result = ticket?.state ? errorResult(ticket, error) : {status:'error', code:error.code || 'DATABASE_FAILED', message:error.message};
        if (ticket?.state) {
          try { const pending = readJournal(ticket.scope, ticket.item); if (pending) result = {...unknown(pending, error.code || 'RECONCILE_FAILED'), invalidated:!current(ticket)}; } catch (_) {}
          return finish(ticket, result);
        }
        return result;
      }
    }
    async function list(kind, options = {}) {
      let ticket;
      try {
        target(kind, 'list');
        const limit = options.limit ?? 200, cursor = options.cursor ?? null;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200 || cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 4096)) throw fail('INVALID_CURSOR', 'Invalid database list parameters');
        const since=options.since??null,projectId=options.projectId??null,sinceEpoch=options.sinceEpoch??null;
        if(since!==null&&(!Number.isSafeInteger(since)||since<0||typeof sinceEpoch!=='string'||!sinceEpoch)
          ||since===null&&sinceEpoch!==null||projectId!==null&&(kind!=='planning_records'||typeof projectId!=='string'||!projectId.trim()))throw fail('INVALID_CURSOR','Invalid list filter');
        ticket = begin({kind, id:'\u0000list'}, 'list'); if (!ticket.state) return ticket;
        const {response, body} = await requestJson(ticket, '/api/database/resources?kind=' + encodeURIComponent(kind)
          + '&limit=' + limit + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor))
          + (since===null?'':'&since='+since+'&since_epoch='+encodeURIComponent(sinceEpoch))
          + (projectId===null?'':'&project_id='+encodeURIComponent(projectId)));
        const foundEpoch = envelope(body);
        if (response.status !== 200 || body.success !== true || !Array.isArray(body.resources) || body.resources.length > limit
          || !Number.isSafeInteger(body.as_of) || body.as_of < 0 || body.next_cursor !== null && (typeof body.next_cursor !== 'string' || !body.next_cursor || body.next_cursor.length > 4096)) throw fail('INVALID_LIST', 'Database list response is invalid');
        if (epoch !== null && epoch !== foundEpoch) {
          for (const state of states.values()) state.loaded = false;
          epoch = foundEpoch;
          throw fail('EPOCH_CHANGED', 'Database changed during list loading');
        }
        if(since!==null&&(body.since!==since||body.as_of<since||foundEpoch!==sinceEpoch)
          ||projectId!==null&&body.project_id!==projectId)throw fail('INVALID_LIST','Database did not confirm list filter');
        epoch = foundEpoch;
        const ids = new Set(), resources = body.resources.map(value => {
          const item = target(kind, value?.id), resource = resourceValue(value, item);
          if (ids.has(item.id)) throw fail('INVALID_LIST', 'Duplicate resource in database list');
          ids.add(item.id); return resource;
        });
        // Historical high-water list entries are never save baselines.
        return finish(ticket, {status:'ready', epoch:foundEpoch, resources, cursor:body.next_cursor, asOf:body.as_of});
      } catch (error) {
        const result = ticket?.state ? errorResult(ticket, error) : {status:'error', code:error.code || 'DATABASE_FAILED', message:error.message};
        return ticket?.state ? finish(ticket, result) : result;
      }
    }
    function snapshot(kind, id) {
      try {
        synchronize(); const item = target(kind, id), state = getState(item), pending = readJournal(scope, item);
        return {status:pending ? 'unknown' : state.status, scope:{...scope}, epoch:state.epoch,
          loaded:state.loaded && !pending && state.epoch === epoch, pending:state.active?.action || null,
          resource:state.resource === null ? null : jsonCopy(state.resource), unknown:pending ? unknown(pending) : null};
      } catch (error) { return {status:'error', loaded:false, code:error.code || 'DATABASE_FAILED', message:error.message}; }
    }
    return Object.freeze({load, save, reconcile, list, snapshot, invalidate});
  }
  return Object.freeze({VERSION:PROTOCOL, PROTOCOL, TIMEOUT_MS, JOURNAL_PREFIX, copyBusinessValue:jsonCopy, create});
});
