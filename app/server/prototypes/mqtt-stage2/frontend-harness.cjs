'use strict';
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..');
function harness() {
  class FixedDate extends Date { static now() { return 1900000000000; } }
  const c = vm.createContext({DEVICES: [], console: {log(){},warn(){},error(){}}, Date: FixedDate, performance: {now:()=>1000},
    document: {readyState:'loading', addEventListener(){}, getElementById(){return null;}},
    localStorage: {getItem(){return null;}, setItem(){throw Error('No browser writes');}}});
  c.window = c;
  for (const name of ['frequency','dashboard','render','fashe','device-views']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src/modules', name + '.js'),'utf8'), c);
  }
  c._fasheUpdateUI = () => {};
  c._rebuildReceiversFromDevices = () => {};
  c.notify = () => {};
  c.evaluateRealtimeAlerts = () => {};
  c.forceRefreshAllPanels = () => {};
  return c;
}
const clone = value => JSON.parse(JSON.stringify(value));
const handlers = context => ({snapshot: d => context._fasheHandleDeviceList(d),
  delta: d => context._fasheHandleDeviceUpdate(d), offline: () => context._fasheMarkDevicesOffline()});
function view(context) {
  const sorted = context.sortDeviceView(context.DEVICES, 'ch', true);
  return clone({devices: context.DEVICES, sorted,
    table: [1,2,3,4,5,6].map(p => context.deviceViewPage(sorted,20,p)),
    cards: [1,2,3].map(p => context.deviceViewPage(sorted,50,p))});
}
module.exports = {harness, handlers, view, clone};
