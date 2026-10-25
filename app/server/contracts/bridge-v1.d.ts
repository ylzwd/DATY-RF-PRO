/**
 * fuwuqi v1.0.3 当前 HTTPS/SSE + 配对 WSS 契约；v1 不是 /api/v1 路由。
 * 仅声明 DTO，不包含业务执行，也不表示原生客户端已经实现。
 * 输入仍须运行时校验；number 别名用于说明单位，不会自动转换或校验范围。
 */
export type InternalFrequencyKHz = number; // 正整数 kHz，内部频率/规划/频段。
export type CommandFrequencyMHz = number; // set_freq.value 及 ACK actual_value，MHz。
export type UnixSeconds = number; // epoch 秒，可带小数。
export type EpochMilliseconds = number; // epoch 毫秒；与耗时毫秒分开。
export type DurationMilliseconds = number;
export type DeviceId = string; // Bridge 通道稳定 ID，不是浏览器的本地数字 id。
export type ReceiverId = string; // 接收机稳定 ID，不包含 CH 或 Group。
export type BrandName = string; // 含扩展品牌；不能靠枚举品牌决定是否可写。
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Certificate/hostname validation is mandatory; never downgrade to http/ws. */
export interface TlsMetadata {
  transport_security: 'tls-v1'; minimum_tls: '1.2';
  certificate_sha256: string; ca_sha256: string[]; not_after: string; hosts: string[];
}
/** Delivered by authenticated development enrollment over HTTPS or offline by admin.
 * Never put this DTO in project/history/logs.
 * MQTT3.1.1 CONNECT: username=credential_id, password=secret,
 * clientId=credential_id + '_' + session suffix (4..80 [A-Za-z0-9_-]).
 * clean session required; no Will/retained. Browser memory or native secret vault.
 */
export interface ReceiverPairingDocument {
  protocol: 'daty-pairing-v1'; credential_id: string; secret: string;
  receiver_mac: string; receiver_id: ReceiverId;
  brand: 'DATYaudio' | 'AMSaudio' | 'Shure' | 'Sennheiser'; max_channels: number;
  broker_url: string; // wss://certificate-SAN-host:8083/mqtt
  expires_at: UnixSeconds; ca_sha256: string; // informational in browser, not a pinning bypass
}
/** Group is persistent display metadata keyed by canonical MAC, never a routing key.
 * IP is the actual socket peer, NOT DHCP assignment. Same receiver's CH share GROUP.
 */
export interface ReceiverAssignment {
  receiver_mac?: string; // required in clock receiver_assignment; pairing MAC in enrollment response
  receiver_ip: string;
  ip_source: 'socket-peer';
  group_number: number; // positive integer, FIFO by first successful registry commit
  group_source: 'server-fifo-v1';
}
export interface ReceiverPublicKey { kty: 'EC'; crv: 'P-256'; x: string; y: string }
export interface ReceiverChallengeRequest {
  protocol: 'daty-auto-pair-v1'; receiver_mac: string;
  brand: ReceiverPairingDocument['brand']; channel_count: number;
  public_key: ReceiverPublicKey; // base64url coordinates, no private d
}
export interface ReceiverChallengeResponse {
  success: true; protocol: 'daty-auto-pair-v1'; challenge_id: string;
  message: string; // exact UTF-8 8-line signing input; see receiver-enrollment.md
  expires_in: number; // 30 seconds, one use, socket peer bound
}
export interface ReceiverEnrollRequest {
  challenge_id: string;
  signature: string; // ECDSA P-256/SHA-256 P1363 r||s (64 bytes), unpadded base64url; not DER
}
export interface ReceiverEnrollResponse extends ReceiverAssignment {
  success: true; protocol: 'daty-auto-pair-v1'; pairing: ReceiverPairingDocument;
}
/** HTTPS POST /api/receivers/challenge and /api/receivers/enroll use their own
 * receiver-key proof, NOT operator Bearer. JSON <=8KiB, no redirects or cookies.
 * New enrollment: explicit local enabled + actual peer IP allowlist.
 * Existing key proof can log in after disable-auto; revoke blocks it.
 * Does not grant any /api/command, project, timeline or discovery permission.
 */
export type ReceiverPublishTopic = 'daty/rf/devices/register' | 'daty/rf/devices/up' |
  'daty/rf/devices/down' | 'daty/rf/clock/ack';
export type ReceiverSubscribeTopic = 'daty/rf/devices/down' | 'daty/rf/clock/sync';
/** Incoming down is an own-state local operation report, never receiver→receiver control.
 * Every supplied MAC/IP/receiver/CH alias must agree with pairing and socket peer.
 * Batch wire field is typed `devices`, not `updates`; Group never identifies CH.
 */

export interface ApiFailure {
  success: false;
  error: string;
  code?: 'AUTH_REQUIRED' | 'FORBIDDEN' | 'AUTH_NOT_CONFIGURED' | 'ORIGIN_FORBIDDEN' |
    'CORS_FORBIDDEN' | 'INVALID_BODY' | 'BODY_TOO_LARGE' | 'JSON_REQUIRED';
  accepted?: false;
  command?: CommandRecord; // 没有命令订阅者时可能同时返回失败事务。
  capabilities?: DeviceCapabilities;
  expected_brand?: BrandName;
  target_brand?: BrandName;
}

/** Direct HTTPS control. No user key, permission scopes, or /api/auth/status.
 * Browser origin / Fetch Metadata checks and bounded JSON remain mandatory.
 * Native clients may omit Origin. Never follow redirects or replay an uncertain POST.
 * MQTT receiver pairing is a separate boundary and remains mandatory.
 */
export interface NetworkPeerActor { kind: 'network-peer'; authenticated: false; ip: string }
/** Existing database rows may contain an actor from the retired authorization feature. */
export interface HistoricalOperatorActor { id: string; name: string; role: 'viewer' | 'operator' }
export interface DirectControlHealth {
  control_access: 'daty-direct-control-v1';
  control_auth_required: false;
  transport_security: 'tls-v1';
}

export interface AdapterCapabilities {
  discover: boolean;
  read_frequency: boolean;
  write_frequency: boolean;
  read_rf: boolean;
  read_af: boolean;
  mute: boolean;
  scan: boolean;
  read_only: boolean;
}

export interface FasheFrequencyControl {
  scope: 'fashe-protocol';
  min_khz: InternalFrequencyKHz;
  max_khz: InternalFrequencyKHz;
  step_khz: InternalFrequencyKHz;
  origin_khz: number; // 当前为 0，不是一个合法接收频点。
  brand_binding: 'expected-brand-v1';
  ack_mode: 'command-id' | 'telemetry';
  note: string; // 协议可写范围，不代表实体硬件频段认证。
}

export interface DeviceCapabilities extends AdapterCapabilities {
  adapter: 'fashe-mqtt' | 'shure-scp-readonly' | 'unknown-readonly';
  frequency_control?: FasheFrequencyControl; // 仅当前 FAshe 适配器返回。
}

export interface CapabilitiesResponse {
  success: true;
  adapters: Record<string, AdapterCapabilities>; // 全局能力不含逐设备 frequency_control。
}

export interface ReceiverHeartbeat {
  source: 'server_clock_ack';
  status: 'unmeasured' | 'offline' | 'measured' | 'stale';
  rtt_ms: DurationMilliseconds | null; // 真实服务器发送至同会话 ACK 的单调耗时。
  age_ms: DurationMilliseconds | null;
  max_age_ms: DurationMilliseconds;
  measured_at_ms?: EpochMilliseconds;
  server_id?: string;
  sequence?: number;
}

/** 每条是一个通道。旧协议透传的描述/指标可能缺失；不存在不能补成 0。 */
export interface DeviceSnapshot {
  id: DeviceId;
  receiver_id?: ReceiverId;
  receiver_ip?: string | null;
  receiver_mac?: string | null;
  ip?: string | null; // 兼容别名。
  channel_number?: number; // 正整数；Group 绝不参与推导。
  channel_key?: string; // CH1、CH2…。
  channel?: number;
  ch?: string;
  group?: string | number | null; // 编组元数据，不是通道号或路由键。
  group_number?: number | null;
  group_source?: 'server-fifo-v1' | null; // authoritative, takes precedence over legacy browser maps
  name?: string | null;
  brand?: BrandName | null;
  model?: string | null;
  freq?: InternalFrequencyKHz | null;
  rf?: number | null; // dBm。
  af_dbfs?: number | null; // -40～0 dBFS。
  af?: number | null; // Bridge 兼容别名，同样是 dBFS；不是 UI 百分比。
  batt?: number | null; // 0～100%。
  muted?: boolean | null;
  identity_basis?: 'model-ip-endpoint'; // Shure DEVICE_ID is editable, not a serial/MAC.
  protocol_verified?: boolean; // published property table verified; NOT a hardware acceptance claim
  hardware_verified?: false;
  af_source_dbfs?: number | null; // actual model-specific value before display-domain validation
  rf_source_dbm?: number | null;
  rf_antennas_dbm?: Record<string, number | null>;
  status?: string | number | null; // 兼容旧自报状态；连接在线以 _online 为准。
  control_protocol?: string | null;
  equipmentProfileId?: string;
  equipmentBandId?: string;
  equipmentModeId?: string;
  equipment_profile_id?: string;
  equipment_band_id?: string;
  equipment_mode_id?: string;
  _source?: string; // 含会话标记，不能作为永久 receiver_id。
  _online: boolean;
  _age_s: number;
  server_time_ms: EpochMilliseconds;
  heartbeat: ReceiverHeartbeat;
  capabilities: DeviceCapabilities;
}

export interface DevicesResponse {
  success: true;
  devices: DeviceSnapshot[];
  count: number; // 通道数，不是接收机数。
  clock_source: 'fuwuqi';
  server_time_ms: EpochMilliseconds;
  ts: UnixSeconds;
}

/** GET /api/discovery/shure/status; POST scan or cancel with exactly {}.
 * No caller-controlled target or command text. Same HTTPS origin/body policy.
 * Repeated scan joins current generation; no replay after an uncertain POST.
 */
export interface ShureDiscoveryState {
  success: true;
  protocol: 'daty-shure-discovery-v1';
  enabled: boolean; scanning: boolean; cancelled: boolean;
  generation: number; progress: number; targets: number; scanned: number;
  started_at: UnixSeconds | null; completed_at: UnixSeconds | null; error: string | null;
  scopes: {address: string; network: string; scan_network: string; limited_to_24: boolean}[];
  receivers: ShureReceiverObservation[]; count: number;
}
export interface ShureChannelObservation {
  channel_number: number;
  frequency_khz?: InternalFrequencyKHz | null; name?: string | null; muted?: boolean | null;
  rf_dbm?: number | null; audio_dbfs?: number | null;
  rf_antennas_dbm?: Record<string, number | null>;
  battery_percent?: number | null; battery_bars?: number | null; battery_minutes?: number | null;
}
export interface ShureReceiverObservation {
  receiver_id: ReceiverId; receiver_ip: string; ip: string;
  identity_basis: 'model-ip-endpoint'; brand: 'Shure';
  model: 'ULXD4' | 'ULXD4D' | 'ULXD4Q' | 'QLXD4' | 'AD4D' | 'AD4Q';
  model_display: string; device_name: string | null; version: string;
  discovered_via: 'shure-scp'; verified: true; protocol_verified: boolean; hardware_verified: false;
  channels: Record<string, ShureChannelObservation>; channel_count: number;
  complete: boolean; ts: UnixSeconds; latency_ms: DurationMilliseconds; // GET transaction, not clock RTT
}

/** 当前 SSE 的增量是“部分设备集合的最新快照”，不是所有设备的替换。 */
export type DeviceDelta = DeviceSnapshot;
export interface DeviceListEvent {
  type?: 'device_list'; // 首次连接的 device_list 没有 type/data/clock_source。
  devices: DeviceSnapshot[]; // 全量；空数组也有清除本来源旧设备的语义。
  data?: null;
  clock_source?: 'fuwuqi';
  server_time_ms: EpochMilliseconds;
  ts: UnixSeconds;
}
export interface DeviceUpdateEvent {
  type: 'device_update';
  devices: DeviceDelta[]; // 仅合并给定通道，不删除本批未出现的通道。
  data: null;
  clock_source: 'fuwuqi';
  server_time_ms: EpochMilliseconds;
  ts: UnixSeconds;
}

export interface TargetedCommandBase {
  type?: 'device_command';
  device_id: DeviceId;
  channel_number: number;
  receiver_id?: ReceiverId;
  receiver_ip?: string;
  receiver_mac?: string;
  ip?: string;
  mac_address?: string;
  channel?: number;
  channel_key?: string;
  group?: string | number | null;
  /** 页面请求关联；16～80 个 A-Z/a-z/0-9/_/-。不等于幂等键。 */
  client_request_id?: string;
}
/** 当前客户端标准：调频必传 expected_brand；后台仍兼容没有该字段的旧请求。 */
export type CommandRequest = TargetedCommandBase & (
  | { command: 'mute'; value: true }
  | { command: 'unmute'; value: false }
  | { command: 'set_freq'; value: CommandFrequencyMHz; expected_brand: BrandName }
);
export type CommandStatus = 'prepared' | 'published' | 'acknowledged' | 'failed' | 'timeout';

export interface CommandRecordBase {
  actor?: NetworkPeerActor | HistoricalOperatorActor; // New records identify only the observed network peer.
  command_id: string; // 每次 POST 由服务器生成，不允许客户端复用设备事务编号。
  client_request_id: string | null;
  device_id: DeviceId | null;
  target_device_ids: DeviceId[];
  channel: number | null;
  channel_number: number | null;
  receiver_id: ReceiverId | null;
  receiver_ip: string | null;
  receiver_mac: string | null;
  ip: string | null;
  status: CommandStatus;
  published_subscribers: number | null;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
  acknowledged_at: UnixSeconds | null;
  ack_round_trip_ms?: DurationMilliseconds; // 确认前不存在。
  error: string | null;
}
export type CommandRecord = CommandRecordBase & (
  | { command: 'mute' | 'unmute'; expected_value: boolean; actual_value: boolean | null }
  | { command: 'set_freq'; expected_value: CommandFrequencyMHz; actual_value: CommandFrequencyMHz | null;
      brand: BrandName; expected_brand?: BrandName }
);
export interface PublishedCommand {
  type: 'device_command';
  command_id: string;
  device_id: DeviceId;
  command: 'mute' | 'unmute' | 'set_freq';
  value: boolean | CommandFrequencyMHz;
  channel: number;
  channel_number: number;
  channel_key: string;
  receiver_id: ReceiverId | null;
  receiver_ip: string | null;
  receiver_mac: string | null;
  ip?: string | null;
  mac_address?: string;
  group?: string | number | null;
  client_request_id?: string;
  brand?: BrandName; // 服务器登记的目标品牌，不能信任客户端自报品牌。
  expected_brand?: BrandName;
}
export interface CommandAcceptanceResponse {
  success: true;
  accepted: true; // 只代表发布；不能据此显示“设备已执行”。
  message: string;
  cmd: PublishedCommand;
  command_id: string;
  status: CommandStatus; // 快速 ACK 可使该字段已是 acknowledged。
  command_record: CommandRecord;
  updated_device_ids: DeviceId[]; // 当前不乐观修改设备；通常为空。
}
export interface CommandResponse { success: true; command: CommandRecord }
export interface CommandsResponse { success: true; commands: CommandRecord[]; count: number }
export interface CommandUpdateEvent {
  type: 'command_update';
  devices: [];
  data: CommandRecord;
  clock_source: 'fuwuqi';
  server_time_ms: EpochMilliseconds;
  ts: UnixSeconds;
}
export type BridgeSsePayload = DeviceListEvent | DeviceUpdateEvent | CommandUpdateEvent;

export interface ProjectSummary {
  id: string;
  name: string;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
}
/** Bridge 以 JSON 保存，不校验规划内容；未知字段必须在读改写时保留。 */
export interface ProjectSnapshot extends ProjectSummary { data: JsonObject; devices: JsonObject[] }
export interface ProjectsResponse { success: true; projects: ProjectSummary[] }
export interface ProjectResponse { success: true; project: ProjectSnapshot }
export interface SaveProjectRequest {
  id?: string; // 省略时服务器创建 UUID。
  name?: string;
  data?: JsonObject; // 整体替换；省略会保存 {}，不是“不修改”。
  devices?: JsonObject[]; // 带此字段时整组替换；省略时保留旧设备快照。
}
export interface SaveProjectResponse { success: true; project_id: string; updated_at: UnixSeconds }
export interface SaveCoordinationRunRequest {
  project_id?: string;
  input?: JsonObject;
  result?: JsonObject;
  baseline?: JsonValue;
}
export interface SaveCoordinationRunResponse { success: true; run_id: string }

export interface TimelineFilter {
  limit?: number; // 1～1000；默认 200；当前没有 offset/cursor。
  project_id?: string;
  device_id?: DeviceId;
  event_type?: string;
}
export interface TimelineEvent {
  id: number;
  project_id: string | null;
  ts: UnixSeconds;
  event_type: string;
  device_id: DeviceId | null;
  command_id: string | null;
  summary: string;
  details: JsonValue;
}
export interface TimelineResponse { success: true; events: TimelineEvent[]; count: number }
export interface AddTimelineEventRequest {
  event_type: string;
  summary: string;
  project_id?: string;
  device_id?: DeviceId;
  command_id?: string;
  details?: JsonValue;
}
export interface AddTimelineEventResponse { success: true }

export interface ClockClientStatus {
  client_id: string;
  receiver_ip: unknown; // 此字段由设备自报，当前 Bridge 未做形状校验。
  server_id: string;
  sequence: number;
  offset_ms: number | null;
  client_epoch_ms: unknown; // 自报诊断值，不作为 RTT/在线判定依据。
  master_epoch_ms: unknown;
  last_ack_ms: EpochMilliseconds;
  rtt_ms: DurationMilliseconds | null;
  sent_at_ms: EpochMilliseconds;
  client_version: string | null;
  client_ack_prepare_ms: DurationMilliseconds | null;
  age_ms: DurationMilliseconds;
  status: 'synced' | 'stale';
}
export interface ClockStatus {
  source: 'fuwuqi';
  protocol: 'daty-clock-v1';
  server_id: string;
  server_epoch_ms: EpochMilliseconds;
  server_iso: string;
  sequence: number;
  last_broadcast_ms: EpochMilliseconds | null;
  sync_interval_s: number;
  max_age_s: number;
  client_retention_s: number;
  rtt_method: 'server_monotonic_send_ack';
  clients: ClockClientStatus[];
}
export interface ClockResponse { success: true; clock: ClockStatus }

export interface StatsResponse {
  success: true;
  stats: JsonObject;
  device_count: number; // 通道数。
  online_count: number; // 在线通道数，不可直接作在线接收机数。
  sse_client_count: number;
  clients: JsonObject[]; // MQTT 来源/会话诊断，不是一台物理接收机一项的保证。
  external_receivers: ShureReceiverObservation[]; // fresh GET observations; no fake MQTT clients
  broker: { ws_clients: number; client_list: { client_id: string; addr: string; subscriptions: string[] }[] };
  clock: ClockStatus;
  clock_source: 'fuwuqi';
  server_time_ms: EpochMilliseconds;
  ts: UnixSeconds;
}
