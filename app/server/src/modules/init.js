// ============================================================
// init.js — 初始化、设备服务架构常量、启动序列
// ============================================================

// ══════════════════ INIT ══════════════════
// 全局错误处理 - 捕获 IndexedDB 错误
window.addEventListener('error', function(event) {
  if (event.message && event.message.includes('IDBDatabase')) {
    console.error('捕获到 IndexedDB 错误:', event.message);
    console.error('错误来源:', event.filename, '行:', event.lineno);
    (globalThis.DatyHostFactory ? message => globalThis.DatyHostFactory.invokeMessage(globalThis, 'alert', message)
      : globalThis.DatyPlatform === undefined || globalThis.DatyPlatform?.kind === 'browser' ? alert
      : () => { throw new TypeError('DatyHost: native alert capability is unavailable'); }
    )('检测到 IndexedDB 错误，请按 Ctrl+F5 强制刷新页面清除缓存');
  }
});

// 历史存储不得在启动时自动清除；只允许用户通过明确的清空操作删除。

// 初始化存储
initDatabase().then(() => {
  console.log('本地存储已初始化');
  
  // 自动修复旧格式的 FAshe 设备数据
  if (typeof DEVICES !== 'undefined' && Array.isArray(DEVICES)) {
    let fixedCount = 0;
    DEVICES.forEach(d => {
      if (!d || !d._fasheId) return;
      let channelNumber = typeof getDeviceChannelNumberSafe === 'function'
        ? getDeviceChannelNumberSafe(d, null) : null;
      if (channelNumber === null) {
        const idMatch = String(d._fasheId).match(/_ch(\d+)$/i);
        channelNumber = idMatch ? Number(idMatch[1]) : null;
      }
      // 旧代码曾把 _fasheId 最后一个 '-' 分段（甚至 Group1）写入 ch。
      // 现在只接受显式 CH 或稳定 ID 的 _chN 后缀。
      if (channelNumber !== null) {
        const canonical = `CH${channelNumber}`;
        if (d.ch !== canonical || d.channel_number !== channelNumber || d.channel !== channelNumber) {
          const originalCh = d.ch;
          d.ch = canonical;
          d.channel = channelNumber;
          d.channel_number = channelNumber;
          d.channel_key = canonical;
          console.log(`✅ 修复设备 ${d.id}: "${originalCh}" → "${canonical}"`);
          fixedCount++;
        }
      }
    });
    
    fixedCount += repairRealtimeDeviceIds(DEVICES);
    if (fixedCount > 0) {
      console.log(`🔧 已修复 ${fixedCount} 项设备通道号或页面 ID`);
      (globalThis.DatyPlatform?.storage || localStorage).setItem('daty_devices', JSON.stringify(DEVICES));
      // 刷新界面以显示修复后的数据
      if (typeof renderDeviceGridChannels === 'function') {
        const grid = document.getElementById('deviceGridChannels');
        if (grid) {
          renderDeviceGridChannels(DEVICES);
        }
      }
    }
  }
}).catch(err => {
  console.error('存储初始化失败:', err);
});

// 先接住刷新前的告警，再评估离线缓存，避免首次评估移除时丢失历史。
initializeAlertArchiving();
// 页面已有缓存设备时先按当前阈值恢复活动告警状态，再渲染消息栏，避免短暂显示旧告警。
if (typeof evaluateRealtimeAlerts === 'function') evaluateRealtimeAlerts(DEVICES);
renderAlerts();
renderFreqTable(false);
renderHistory();
renderLog();
loadSavedFreqRange(); // 加载保存的频率范围
renderFreqAxis();

// ═══════════════════════════════════════════════════════════════════
// 设备服务发现与连接管理架构 (Device Service Architecture)
// ═══════════════════════════════════════════════════════════════════
// 流程: 设备上电 → IP获取+服务启动 → mDNS/SLP广播 → 软件发现 → 连接 → 数据交换

const DEVICE_SERVICE_ARCHITECTURE = {
  version: '2.0.0',
  discovery: {
    // mDNS 服务发现配置 (Multicast DNS)
    mdns: {
      enabled: true,
      serviceType: '_datyrf._tcp.local',
      port: 5353,           // mDNS 标准端口
      protocol: 'UDP',
      queryInterval: 5000,  // 5秒轮询间隔
      timeout: 30000        // 30秒超时
    },
    // SLP 服务发现配置 (Service Location Protocol) - 备用
    slp: {
      enabled: true,
      serviceType: 'service:datyrf://',
      port: 427,            // SLP 标准端口
      protocol: 'TCP/UDP',
      scope: 'DEFAULT'
    }
  },
  connection: {
    // 连接管理
    maxRetries: 3,
    retryInterval: 2000,
    heartbeatInterval: 1000,  // 1秒心跳
    heartbeatTimeout: 5000    // 5秒心跳超时
  },
  protocols: {
    // 品牌协议支持
    amsaudio: {
      name: 'AMSaudio TCP私有协议',
      port: 5001,
      protocol: 'TCP',
      commands: {
        getStatus: 0x01,
        setFrequency: 0x02,
        setGain: 0x03,
        getBattery: 0x04
      }
    },
    shure: {
      name: 'Shure SCP',
      port: 2202,           // ASCII 第三方控制端口
      protocol: 'TCP',
      controlProtocol: 'SCP/ASCII',
      features: ['ShowLink', 'Encryption', 'FrequencySync']
    },
    sennheiser: {
      name: 'Sennheiser SSCv2',
      port: 45,
      protocol: 'TCP',
      features: ['Encryption', 'RemoteControl']
    }
  },
  showlink: {
    // ShowLink 2.4GHz 控制信道
    enabled: true,
    frequency: 2400,  // 2.4GHz
    bandwidth: 80,    // 80MHz
    channels: [1, 6, 11],  // 非重叠信道
    txPower: 17,      // 17dBm
    protocol: 'Shure ShowLink'
  },
  ports: {
    // 关键端口参考表
    discovery: {
      mdns: { port: 5353, protocol: 'UDP', desc: 'mDNS 服务发现' },
      slp: { port: 427, protocol: 'TCP/UDP', desc: 'SLP 服务发现' }
    },
    firmware: {
      ftp: { port: 21, protocol: 'TCP', desc: '固件更新 FTP' },
      ssh: { port: 22, protocol: 'TCP', desc: '安全远程调试 SSH' },
      telnet: { port: 23, protocol: 'TCP', desc: '远程调试 Telnet' }
    },
    control: {
      ascii: { port: 2202, protocol: 'TCP', desc: '第三方 ASCII 控制 (Shure)' }
    }
  }
};

// 设备服务管理器
class DeviceServiceManager {
  constructor() {
    this.discoveredDevices = new Map();  // 发现的设备
    this.connectedDevices = new Map();   // 已连接设备
    this.heartbeatTimer = null;         // 全部通道共用一个状态巡检，不是设备 RTT 心跳
    this.discoveryTimer = null;
    this.isDiscovering = false;
    this.snapshotRequest = null;
    this.snapshotCache = null;
    this.snapshotEpoch = 0;
    this.snapshotTimeoutMs = 3000;
  }

  // 启动服务发现
  async startDiscovery() {
    if (this.isDiscovering) return;
    this.isDiscovering = true;
    
    console.log('[DeviceService] 启动设备发现...');
    notify('🔍', '设备发现', '正在扫描网络中的射频设备...');
    
    // 浏览器不伪造 mDNS/SLP 结果；周期读取 bridge 的真实设备快照。
    this.discoveryTimer = setInterval(() => {
      this.scanNetworkDevices();
    }, DEVICE_SERVICE_ARCHITECTURE.discovery.mdns.queryInterval);
    
    // 立即执行一次扫描
    await this.scanNetworkDevices();
  }

  // 停止服务发现
  stopDiscovery() {
    this.isDiscovering = false;
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    console.log('[DeviceService] 停止设备发现');
  }

  // SSE 已有完整设备状态；推送不可用时，发现/巡检共用一个有总期限的 HTTP 请求。
  async getBridgeSnapshot() {
    const pushed = typeof getFasheServiceSnapshot === 'function' ? getFasheServiceSnapshot() : null;
    if (pushed !== null) return pushed; // [] 同样是有效空快照
    const selected = typeof _fasheApiUrl === 'string' ? _fasheApiUrl
      : document.getElementById('fasheApiUrl')?.value || 'https://127.0.0.1:8802';
    const base = (globalThis.DatyPlatformFactory ? globalThis.DatyPlatformFactory.normalizeBridgeUrl(selected) : selected).replace(/\/$/, '');
    if (this.snapshotCache?.base === base && performance.now() - this.snapshotCache.at < 1000) {
      return this.snapshotCache.devices;
    }
    if (this.snapshotRequest?.base === base) return this.snapshotRequest.promise;
    this.snapshotRequest?.cancel();
    const request = {base, controller:new AbortController(), at:performance.now()};
    this.snapshotRequest = request;
    const epoch = this.snapshotEpoch;
    request.promise = new Promise((resolve, reject) => {
      request.cancel = () => {request.controller.abort(); reject(new Error('设备快照等待已取消'));};
      request.timer = setTimeout(() => {
        request.controller.abort(); reject(new Error('设备快照请求超时'));
      }, this.snapshotTimeoutMs);
      (async () => {
        const response = await (globalThis.DatyPlatform?.request || fetch)(`${base}/api/devices`, {cache:'no-store',signal:request.controller.signal});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.devices)) throw new Error('设备快照格式无效');
        resolve(payload.devices);
      })().catch(reject);
    }).then(devices => {
      if (epoch === this.snapshotEpoch && this.snapshotRequest === request) {
        this.snapshotCache = {base, at:request.at, devices};
      }
      return devices;
    }).finally(() => {
      clearTimeout(request.timer);
      if (this.snapshotRequest === request) this.snapshotRequest = null;
    });
    return request.promise;
  }

  // 扫描 bridge 已确认的真实设备；不改变页面的设备遥测或静音状态。
  async scanNetworkDevices() {
    const epoch = this.snapshotEpoch;
    try {
      const snapshot = await this.getBridgeSnapshot();
      if (epoch !== this.snapshotEpoch) return;
      const networkDevices = snapshot.filter(d => (d.ip || d.receiver_ip) && (
        typeof _deviceConnectionIsOnline === 'function'
          ? _deviceConnectionIsOnline(d)
          : (d._online !== false && String(d.status || '').trim().toLowerCase() !== 'offline')
      )).map(d => ({
        id: d._fasheId || d.id,
        ip: d.ip || d.receiver_ip,
        receiver_id: d.receiver_id || d.receiverId || d._receiver_id || '',
        receiver_ip: d.receiver_ip || d.receiverIp || d.ip || '',
        receiver_mac: d.receiver_mac || d.receiverMac || d.mac_address || d.mac || '',
        channel: d.channel,
        channel_number: d.channel_number ?? d.channel_no ?? d.channel,
        channel_key: d.channel_key || d.ch || '',
        group: d.group,
        group_number: d.group_number,
        group_source: d.group_source,
        port: this.getDevicePort(d.brand),
        brand: d.brand,
        model: d.model,
        protocol: this.getDeviceProtocol(d.brand),
        lastSeen: Date.now()
      }));
      
      // 按稳定接收机 + CH 保存，不再以 IP:端口覆盖同机其他 CH。
      this.discoveredDevices.clear();
      networkDevices.forEach(device => {
        this.discoveredDevices.set(device.id, device);
      });
      const onlineIds = new Set(networkDevices.map(device => device.id));
      for (const id of this.connectedDevices.keys()) {
        if (!onlineIds.has(id)) this.handleDisconnect(id);
      }
      // 仅把 bridge 已确认在线的设备登记为已连接。
      for (const device of networkDevices) {
        const previous = this.connectedDevices.get(device.id);
        this.connectedDevices.set(device.id, {...previous, ...device,
          connectedAt:previous?.connectedAt ?? Date.now(),lastHeartbeat:Date.now(),status:'online'});
      }
      if (networkDevices.length) this.startHeartbeat();
    } catch (error) {
      if (epoch !== this.snapshotEpoch) return;
      this.snapshotCache = null;
      // 仅移除服务层连接；卡片由原 SSE/服务器生命周期管理。
      for (const id of this.connectedDevices.keys()) this.handleDisconnect(id);
      console.error('[DeviceService] 扫描失败:', error);
    }
  }

  // 获取设备端口
  getDevicePort(brand) {
    const ports = {
      'AMSaudio': DEVICE_SERVICE_ARCHITECTURE.protocols.amsaudio.port,
      'Shure': DEVICE_SERVICE_ARCHITECTURE.protocols.shure.port,
      'Sennheiser': DEVICE_SERVICE_ARCHITECTURE.protocols.sennheiser.port
    };
    return ports[brand] || 5001;
  }

  // 获取设备协议
  getDeviceProtocol(brand) {
    const protocols = {
      'AMSaudio': 'TCP-Private',
      'Shure': 'SCP',
      'Sennheiser': 'SSCv2'
    };
    return protocols[brand] || 'Unknown';
  }

  // 连接设备
  async connectDevice(device) {
    try {
      console.log(`[DeviceService] 连接设备 ${device.ip}:${device.port}`);
      
      // 添加到已连接列表
      this.connectedDevices.set(device.id, {
        ...device,
        connectedAt: Date.now(),
        status: 'online'
      });
      
      // 启动心跳
      this.startHeartbeat(device.id);
      
      // 更新设备状态
      this.updateDeviceStatus(device.id, 'online');
      
      console.log(`[DeviceService] 设备 ${device.id} 连接成功`);
      
    } catch (error) {
      console.error(`[DeviceService] 连接设备 ${device.id} 失败:`, error);
      this.updateDeviceStatus(device.id, 'offline');
    }
  }

  // 扫描设备端口 (检测关键端口开放状态)
  async scanDevicePorts(ip) {
    const ports = DEVICE_SERVICE_ARCHITECTURE.ports;
    const allPorts = [
      { ...ports.discovery.mdns, category: '发现' },
      { ...ports.discovery.slp, category: '发现' },
      { ...ports.firmware.ftp, category: '固件' },
      { ...ports.firmware.ssh, category: '固件' },
      { ...ports.firmware.telnet, category: '固件' },
      { ...ports.control.ascii, category: '控制' }
    ];
    
    const results = [];
    for (const portInfo of allPorts) {
      const isOpen = await this.checkPortOpen(ip, portInfo.port);
      results.push({
        ...portInfo,
        ip,
        status: isOpen ? 'open' : 'closed'
      });
    }
    
    return results;
  }

  // 浏览器无法可信探测任意 TCP/UDP 端口；未得到服务端证据时返回 false。
  async checkPortOpen(ip, port) {
    void ip; void port;
    return false;
  }

  // 一个页面只有一个巡检；真正的设备心跳/RTT 由 Bridge 主时钟负责。
  startHeartbeat() {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => this.scanNetworkDevices(),
      DEVICE_SERVICE_ARCHITECTURE.connection.heartbeatInterval);
  }

  // 发送心跳
  async sendHeartbeat(deviceId) {
    if (!this.connectedDevices.has(deviceId)) return;
    await this.scanNetworkDevices();
    if (!this.connectedDevices.has(deviceId)) throw new Error('设备不在在线快照中');
  }

  // 处理断开连接
  handleDisconnect(deviceId) {
    // 不用后台 HTTP 的缺失/延迟覆盖实时通道卡数据。
    this.connectedDevices.delete(deviceId);
    if (!this.connectedDevices.size && this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    console.log(`[DeviceService] 设备 ${deviceId} 断开连接`);
  }

  // 更新设备状态
  updateDeviceStatus(deviceId, status) {
    const device = DEVICES.find(d => d.id === deviceId);
    if (device) {
      device.status = status;
      if (typeof evaluateRealtimeAlerts === 'function') evaluateRealtimeAlerts(DEVICES);
      // 触发 UI 更新
      renderDevTable();
      renderMonitorGrid();
    }
  }

  // 发送控制命令
  async sendCommand(deviceId, command, params) {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      throw new Error('设备未连接');
    }
    
    const selected = document.getElementById('fasheApiUrl')?.value || 'https://127.0.0.1:8802';
    const base = (globalThis.DatyPlatformFactory ? globalThis.DatyPlatformFactory.normalizeBridgeUrl(selected) : selected).replace(/\/$/, '');
    // 所有服务层命令都必须携带“接收机身份 + CH”目标。优先复用
    // navigation.js 的统一构造器，避免这里再次把 Group 或设备 ID
    // 中的数字当作通道；保留本地回退以兼容独立加载 init.js 的页面。
    const target = typeof buildTargetedDeviceCommand === 'function'
      ? buildTargetedDeviceCommand({ ...device, _fasheId: device._fasheId || device.id }, command, params?.value)
      : {
          type: 'device_command',
          device_id: device._fasheId || device.id,
          receiver_id: device.receiver_id || device.receiverId || device._receiver_id,
          receiver_ip: device.receiver_ip || device.receiverIp || device.ip,
          receiver_mac: device.receiver_mac || device.receiverMac || device.mac,
          ip: device.receiver_ip || device.receiverIp || device.ip,
          channel: device.channel_number ?? device.channel_no ?? device.channel ?? device.ch,
          channel_number: device.channel_number ?? device.channel_no ?? device.channel ?? device.ch,
          channel_key: device.channel_key || undefined,
          group: device.group,
          command,
          value: params?.value
        };
    if (!Number.isInteger(target.channel_number) || target.channel_number < 1) {
      throw new Error('设备缺少有效 CH 通道号');
    }
    const response = await (globalThis.DatyPlatform?.request || fetch)(`${base}/api/command`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(target)});
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || `命令 HTTP ${response.status}`);
    return result;
  }

  // 获取设备状态
  async getDeviceStatus(deviceId) {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      return null;
    }
    
    // 状态来自已连接设备的实时快照；没有快照时返回 null，
    // 不生成任何演示遥测值。
    const dev = DEVICES.find(d => d.id === deviceId);
    if (!dev) return null;
    const afCandidate = dev.afDbfs ?? dev.af_dbfs;
    const afDbfs = typeof afCandidate === 'number' && Number.isFinite(afCandidate)
      && afCandidate >= -40 && afCandidate <= 0 ? afCandidate : null;
    return {
      rf: dev.rf ?? null,
      af_dbfs: afDbfs,
      // `af` 是兼容别名，协议单位同样是 dBFS，不再返回历史百分比。
      af: afDbfs,
      batt: dev.batt ?? null,
      freq: dev.freq ?? null,
      status: dev.status,
      _online: dev._online,
    };
  }

  // 通过 ShowLink 发送远程控制命令
  async sendShowLinkCommand(deviceId, command) {
    if (!DEVICE_SERVICE_ARCHITECTURE.showlink.enabled) {
      throw new Error('ShowLink 未启用');
    }
    
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      throw new Error('设备未连接');
    }
    
    // 检查设备是否支持 ShowLink
    if (device.brand !== 'Shure') {
      throw new Error('仅 Shure 设备支持 ShowLink');
    }
    
    console.log(`[ShowLink] 发送控制命令到 ${deviceId}:`, command);
    
    void command;
    throw new Error('Shure 适配器为只读；服务器不会发送 ShowLink/SCP SET 命令');
  }

  // 获取发现的设备列表
  getDiscoveredDevices() {
    return Array.from(this.discoveredDevices.values());
  }

  // 获取已连接设备列表
  getConnectedDevices() {
    return Array.from(this.connectedDevices.values());
  }

  // 断开所有连接
  disconnectAll() {
    this.snapshotEpoch++;
    this.snapshotRequest?.cancel();
    this.snapshotCache = null;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.connectedDevices.clear();
    this.discoveredDevices.clear();
    console.log('[DeviceService] 已断开所有设备连接');
  }
}

// 创建全局服务管理器实例
const deviceServiceManager = new DeviceServiceManager();

// 页面加载完成后启动设备发现
document.addEventListener('DOMContentLoaded', () => {
  // 延迟启动，等待其他初始化完成
  setTimeout(() => {
    deviceServiceManager.startDiscovery();
  }, 2000);
});

// 页面关闭时清理
window.addEventListener('beforeunload', () => {
  deviceServiceManager.disconnectAll();
  deviceServiceManager.stopDiscovery();
});
initScanData();
drawRFBarChart();
getLocalIP(); // 获取本地 IP 地址
renderDeviceGridChannels(DEVICES); // 预渲染通道总览
renderDeviceGrid(DEVICES); // 渲染设备概览并更新统计卡片
updateDashboardStats(); // 更新统计卡片数据

setTimeout(()=>{
  drawSpectrum();
  drawRFBarChart();
},100);

// Auto live update：仅显式演示设备可更新；服务器或 FAshe/SSE 连接后立即停止。
setInterval(() => {
  const fasheOnline = typeof isFasheConnected === 'function' && isFasheConnected();
  if (!_connectedServer && !fasheOnline) liveUpdate();
  // 即使没有后续 SSE/轮询，打开的协议页也不能一直展示过期 RTT。
  if (document.getElementById('panel-devices')?.classList.contains('active')
      && document.getElementById('devProto')?.classList.contains('active')) renderProtocolStatus();
}, 800);

// ── 开机启动序列 ────────────────────────────────────────────────────
setTimeout(() => notify('✓', 'DATY RF PRO 已启动', '正在搜索局域网服务器...'), 400);

