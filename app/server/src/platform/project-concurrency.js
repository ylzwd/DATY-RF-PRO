/* Pure C2 preparation. Not loaded by the production page or connected to I/O.
 * Inputs are FULL project snapshots, not form patches. Missing ordinary fields
 * mean deletion; callers must retain unknown fields when building `desired`.
 * History entries are immutable by ID. Removal needs an explicit tombstone.
 * The caller scopes baselines to the actual server + project and owns consent,
 * persistence, authenticated transport, responses and all commit/retry policy.
 */
(function (root, makeFactory) {
  'use strict';
  const factory = makeFactory();
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.DatyProjectConcurrencyFactory = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PROTOCOL = 'daty-project-revision-v1';
  const MISSING = Symbol('missing-json-member');
  const ATOMIC_FIELDS = Object.freeze([
    'constraints', 'constraintFields', 'currentPlanningRecordId', 'last_coordination_at'
  ]);
  const RESERVED = new Set([...ATOMIC_FIELDS, 'planningHistory', 'deletedRecordIds']);
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const pointer = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  const put = (target, key, value) => Object.defineProperty(target, key,
    {value, enumerable: true, writable: true, configurable: true});

  class ProjectConcurrencyError extends Error {
    constructor(code, message, path = '') {
      super(message);
      this.name = 'ProjectConcurrencyError';
      this.code = code;
      this.path = path;
    }
  }

  function invalid(message, path, code = 'INVALID_PROJECT_SNAPSHOT') {
    throw new ProjectConcurrencyError(code, message, path);
  }

  function unicode(value, path) {
    for (let index = 0; index < value.length; index++) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) invalid('项目不能包含孤立 Unicode 代理字符', path);
      } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid('项目不能包含孤立 Unicode 代理字符', path);
    }
    return value;
  }

  function copy(value, path = '', seen = new Set(), depth = 0) {
    if (value === MISSING) return MISSING;
    if (depth > 128) invalid('项目数据嵌套过深', path);
    if (typeof value === 'string') return unicode(value, path);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object') invalid('项目必须使用有效 JSON 数据', path);
    if (seen.has(value)) invalid('项目数据不能循环引用', path);
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== null && Object.getPrototypeOf(prototype) !== null) {
      invalid('项目数据必须是普通 JSON 对象', path);
    }
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) continue;
      if (typeof key !== 'string' || !own(descriptor, 'value')) invalid('项目不能包含访问器或符号字段', path);
      unicode(key, path);
    }
    let result;
    if (Array.isArray(value)) {
      result = [];
      if (Object.keys(value).length !== value.length) invalid('项目数组不能有空项或额外字段', path);
      for (let index = 0; index < value.length; index++) {
        if (!own(descriptors, String(index))) invalid('项目数组不能有空项', path);
        result.push(copy(descriptors[index].value, `${path}/${index}`, seen, depth + 1));
      }
    } else {
      result = {};
      for (const key of Object.keys(value)) {
        put(result, key, copy(descriptors[key].value, `${path}/${pointer(key)}`, seen, depth + 1));
      }
    }
    seen.delete(value);
    return result;
  }

  function equal(left, right) {
    if (left === right) return true;
    if (left === MISSING || right === MISSING || !left || !right || typeof left !== 'object'
        || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left), other = Object.keys(right);
    return keys.length === other.length && keys.every(key => own(right, key) && equal(left[key], right[key]));
  }

  function member(value, key) { return value !== MISSING && own(value, key) ? value[key] : MISSING; }
  function changed(base, value) { return !equal(base, value); }
  function conflict(code, path, extra = {}) { return {code, path, ...extra}; }

  function snapshot(value, path) {
    if (value === null) return null;
    const result = copy(value, path);
    if (!object(result)) invalid('项目快照必须是对象', path);
    if (typeof result.id !== 'string' || !result.id.trim()) invalid('项目 ID 不能为空', `${path}/id`);
    if (typeof result.name !== 'string' || !result.name.trim()) invalid('项目名称不能为空', `${path}/name`);
    if (!object(result.data)) invalid('项目 data 必须是完整对象', `${path}/data`);
    if (!Array.isArray(result.devices)) invalid('项目 devices 必须是完整数组', `${path}/devices`);
    const ids = new Set();
    for (const device of result.devices) {
      if (!object(device) || !((typeof device.id === 'string' && device.id.trim()) || Number.isSafeInteger(device.id))) {
        invalid('设备 ID 缺失或无效', `${path}/devices`);
      }
      const id = String(device.id);
      if (ids.has(id)) invalid('设备 ID 重复', `${path}/devices`);
      ids.add(id);
    }
    return result;
  }

  function history(snapshotValue, path) {
    const data = snapshotValue?.data || {};
    const records = own(data, 'planningHistory') ? data.planningHistory : [];
    const tombstones = own(data, 'deletedRecordIds') ? data.deletedRecordIds : [];
    if (!Array.isArray(records) || !Array.isArray(tombstones)) invalid('历史与删除墓碑必须是数组', path);
    const byId = new Map();
    for (const item of records) {
      if (!object(item) || typeof item.id !== 'string' || !item.id.trim()) invalid('规划历史 ID 无效', path);
      if (byId.has(item.id)) invalid('同一快照内规划历史 ID 重复', path);
      if (item.projectId !== undefined && item.projectId !== snapshotValue.id) invalid('不能混入其他项目历史', path);
      byId.set(item.id, item);
    }
    for (const id of tombstones) if (typeof id !== 'string' || !id.trim()) invalid('删除墓碑 ID 无效', path);
    return {records, byId, tombstones, present: own(data, 'planningHistory')};
  }

  function atomic(snapshotValue) {
    if (!snapshotValue) return MISSING;
    const result = {devices: snapshotValue.devices};
    for (const key of ATOMIC_FIELDS) if (own(snapshotValue.data, key)) put(result, key, snapshotValue.data[key]);
    return result;
  }

  function ordinaryData(snapshotValue) {
    if (!snapshotValue) return MISSING;
    const result = {};
    for (const key of Object.keys(snapshotValue.data)) {
      if (!RESERVED.has(key)) put(result, key, snapshotValue.data[key]);
    }
    return result;
  }

  function mergeValue(base, desired, remote, path, conflicts) {
    if (equal(desired, remote)) return copy(desired);
    if (equal(base, desired)) return copy(remote);
    if (equal(base, remote)) return copy(desired);
    if (object(desired) && object(remote) && (base === MISSING || object(base))) {
      const result = {};
      const keys = [...new Set([...Object.keys(desired), ...Object.keys(remote),
        ...(base === MISSING ? [] : Object.keys(base))])].sort();
      for (const key of keys) {
        const next = mergeValue(member(base, key), member(desired, key), member(remote, key),
          `${path}/${pointer(key)}`, conflicts);
        if (next !== MISSING) put(result, key, next);
      }
      return result;
    }
    conflicts.push(conflict('FIELD_CONFLICT', path));
    return MISSING;
  }

  function mergeChecked(base, desired, remote) {
    if (!base && remote) return {status: 'conflict', conflicts: [conflict('PROJECT_ALREADY_EXISTS', '/id')]};
    if (base && !remote) return {status: 'conflict', conflicts: [conflict('PROJECT_REMOVED', '/id')]};
    const conflicts = [];
    const histories = [history(base, '/base/data'), history(desired, '/desired/data'), history(remote, '/remote/data')];
    const [baseHistory, desiredHistory, remoteHistory] = histories;
    const deletedRecordIds = [...new Set(histories.flatMap(value => value.tombstones))].sort();
    const deleted = new Set(deletedRecordIds);
    const baseDeleted = new Set(baseHistory.tombstones);
    const desiredDeleted = new Set(desiredHistory.tombstones);
    const remoteDeleted = new Set(remoteHistory.tombstones);
    const records = [];
    // Preserve the current client's existing display order; then append remote
    // additions. Absence alone is NOT permission to remove an existing record.
    const ids = [...new Set([...desiredHistory.byId.keys(), ...remoteHistory.byId.keys(), ...baseHistory.byId.keys()])];
    for (const id of ids) {
      const original = baseHistory.byId.get(id);
      const local = desiredHistory.byId.get(id);
      const latest = remoteHistory.byId.get(id);
      if (deleted.has(id)) {
        // A tombstone never resurrects a record. A NEW deletion must still
        // surface an independent edit/addition from the other client instead
        // of silently throwing that work away. An already-deleted baseline,
        // unchanged stale cache, or mutual explicit deletion is not a conflict.
        if (!baseDeleted.has(id) && (
          (desiredDeleted.has(id) && !remoteDeleted.has(id) && latest && (!original || !equal(latest, original))) ||
          (remoteDeleted.has(id) && !desiredDeleted.has(id) && local && (!original || !equal(local, original)))
        )) {
          conflicts.push(conflict('HISTORY_DELETE_EDIT_CONFLICT', '/data/planningHistory', {recordId: id}));
        }
        continue;
      }
      if (original && (!local || !latest)) {
        conflicts.push(conflict('HISTORY_REMOVAL_REQUIRES_TOMBSTONE', '/data/planningHistory', {recordId: id}));
        continue;
      }
      const values = [original, local, latest].filter(Boolean);
      if (values.some(value => !equal(value, values[0]))) {
        conflicts.push(conflict('HISTORY_ID_CONTENT_CONFLICT', '/data/planningHistory', {recordId: id}));
        continue;
      }
      records.push(copy(local || latest || original));
    }
    let name, data, chosen;
    if (!base && !remote) {
      name = desired.name;
      data = copy(ordinaryData(desired));
      chosen = copy(atomic(desired));
    } else {
      name = mergeValue(base.name, desired.name, remote.name, '/name', conflicts);
      data = mergeValue(ordinaryData(base), ordinaryData(desired), ordinaryData(remote), '/data', conflicts);
      const original = atomic(base), local = atomic(desired), latest = atomic(remote);
      if (changed(original, local) && changed(original, latest) && !equal(local, latest)) {
        conflicts.push(conflict('PLANNING_SNAPSHOT_CONFLICT', '/planningSnapshot'));
      } else chosen = copy(changed(original, local) ? local : latest);
    }
    if (chosen) {
      const selected = member(chosen, 'currentPlanningRecordId');
      if (selected !== MISSING && selected !== null) {
        if (typeof selected !== 'string' || !selected.trim()) invalid('当前规划记录 ID 无效', '/data/currentPlanningRecordId');
        if (deleted.has(selected)) conflicts.push(conflict('SELECTED_RECORD_DELETED', '/planningSnapshot', {recordId: selected}));
        else if (!records.some(record => record.id === selected)) {
          conflicts.push(conflict('SELECTED_RECORD_MISSING', '/planningSnapshot', {recordId: selected}));
        }
      }
    }
    if (conflicts.length) return {status: 'conflict', conflicts};
    for (const key of ATOMIC_FIELDS) if (own(chosen, key)) put(data, key, copy(chosen[key]));
    if (histories.some(value => value.present)) put(data, 'planningHistory', records);
    put(data, 'deletedRecordIds', deletedRecordIds);
    return {status: 'ready', project: {id: desired.id, name, data, devices: copy(chosen.devices)}};
  }

  function checkedInput(input) {
    if (!object(input)) invalid('需要 base、desired 与 remote 快照', '');
    const base = snapshot(input.base, '/base');
    const desired = snapshot(input.desired, '/desired');
    const remote = snapshot(input.remote, '/remote');
    if (!desired) invalid('desired 不能为空', '/desired');
    if ([base, remote].some(value => value && value.id !== desired.id)) {
      invalid('只能合并同一项目 ID 的快照', '/id', 'PROJECT_ID_MISMATCH');
    }
    return {base, desired, remote};
  }

  function mergeProject(input) {
    const {base, desired, remote} = checkedInput(input);
    return mergeChecked(base, desired, remote);
  }

  function revision(value, path) {
    if (!Number.isSafeInteger(value) || value < 1) invalid('服务器 revision 必须是正安全整数', path, 'INVALID_PROJECT_REVISION');
    return value;
  }

  function prepareSave(input) {
    const {base, desired, remote} = checkedInput(input);
    // `protocol` may be the actual response's top-level capability marker.
    // This pure helper cannot verify a server: the caller must obtain it from
    // authenticated/validated transport, never manufacture it after failure.
    const protocol = input.protocol ?? remote?.revision_protocol;
    if (protocol !== PROTOCOL || [base, remote].some(value => value &&
        own(value, 'revision_protocol') && value.revision_protocol !== PROTOCOL)) {
      return {status: 'unsupported', code: 'PROJECT_REVISION_UNSUPPORTED'};
    }
    const remoteRevision = remote ? revision(remote.revision, '/remote/revision') : 0;
    if (base) {
      const baseRevision = revision(base.revision, '/base/revision');
      if (remote && remoteRevision < baseRevision) {
        return {status: 'conflict', conflicts: [conflict('PROJECT_REVISION_ROLLBACK', '/revision')]};
      }
      if (remote && remoteRevision === baseRevision &&
          (!equal(base.name, remote.name) || !equal(base.data, remote.data) || !equal(base.devices, remote.devices))) {
        return {status: 'conflict', conflicts: [conflict('REVISION_CONTENT_MISMATCH', '/revision')]};
      }
    }
    if (remoteRevision === Number.MAX_SAFE_INTEGER) {
      return {status: 'conflict', conflicts: [conflict('PROJECT_REVISION_EXHAUSTED', '/revision')]};
    }
    const merged = mergeChecked(base, desired, remote);
    if (merged.status !== 'ready') return merged;
    return {status: 'ready', protocol: PROTOCOL,
      body: {...merged.project, expected_revision: remoteRevision}};
  }

  function create() { return Object.freeze({PROTOCOL, mergeProject, prepareSave}); }
  return Object.freeze({PROTOCOL, ProjectConcurrencyError, create, mergeProject, prepareSave});
});
