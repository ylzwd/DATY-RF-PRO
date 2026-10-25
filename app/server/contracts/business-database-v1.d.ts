/** Candidate-only wire contract. Not deployed; runtime validation is authoritative.
 * HTTPS + existing project.write permission on every /api/database route.
 * A durable database receipt is NOT a receiver ACK or an online/control identity.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Integer kHz (30000..3000000), never MHz. Enforced by the server. */
export type FrequencyKHz = number;
/** Epoch milliseconds; revision/epoch are distinct from device command IDs. */
export type TimeMs = number;
export type BusinessKind = 'settings' | 'profiles' | 'planning_records' |
  'planning_current' | 'alerts' | 'device_overrides' | 'preferences' | 'plugins' |
  'scans' | 'scan_current' | 'planning_runs' | 'project_metadata' |
  'manual_devices' | 'legacy_snapshots' | 'simulation_settings';
export interface DatabaseIdentity {
  protocol: 'daty-business-db-v1'; schema_version: 1;
  instance_id: string; epoch: string;
}
export interface Resource<T = Json> {
  kind: BusinessKind; id: string; revision: number; deleted: boolean; value: T | null;
}
/** Revision 0 means absent. Deletion requires value:null, not an empty document. */
export interface ResourceWrite<T = Json> {
  kind: BusinessKind; id: string; expected_revision: number; value: T | null; deleted?: boolean;
}
export interface WriteRequest<T = Json> extends ResourceWrite<T> {
  operation_id: string; epoch: string;
}
export interface BatchRequest {
  operation_id: string; epoch: string; writes: ResourceWrite[];
}
export interface WriteReceipt<T = Json> extends DatabaseIdentity {
  success: true; operation_id: string; resource: Resource<T>; replayed_receipt?: boolean;
}
export interface BatchReceipt extends DatabaseIdentity {
  success: true; operation_id: string; resources: Resource[]; replayed_receipt?: boolean;
}
export type Operation = { operation_id: string; status: 'committed' } &
  ({ resource: Resource; resources?: never } | { resources: Resource[]; resource?: never });
export interface OperationResponse extends DatabaseIdentity { success: true; operation: Operation }
export interface ResourcePage extends DatabaseIdentity {
  success: true; resources: Resource[]; next_cursor: string | null; as_of: number;
}
/** 409 conflict/epoch change, 428 missing revision, 401/403 authorization.
 * Transport timeout has UNKNOWN outcome; query this actor's exact operation ID.
 * Do not issue another POST automatically. Reload latest revision after receipt.
 */
export interface DatabaseFailure {
  success: false; accepted?: false; protocol?: 'daty-business-db-v1';
  code: string; error?: string; epoch?: string; instance_id?: string;
}
export interface AlertThresholds { rfWeakDbm: number; batteryLowPercent: number; afOverloadDbfs: number }
export interface Scan {
  projectId: string; name: string; sourceKind: 'imported_csv' | 'instrument' | 'simulation';
  frequencyUnit: 'kHz'; levelUnit: 'dBm';
  points: Array<{ frequencyKHz: FrequencyKHz; levelDbm: number }>;
  original?: { name: string; text: string; sha256?: string };
}
/** Write a new scan then this pointer in one atomic batch. Same project only.
 * Simulation cannot be the current real scan. Referenced scans cannot be edited.
 */
export interface CurrentScan { projectId: string; scanId: string }
export interface PlanningRun {
  projectId: string; input: { [key: string]: Json }; result: { [key: string]: Json };
  engineVersion?: string; scanId?: string;
  profileRefs?: Array<{ id: string; revision: number }>;
  purpose?: 'coordination-history' | 'simulation-study';
  [key: string]: Json | undefined;
}
export interface ManualDevice {
  id: string; source: 'manual'; brand: string; model?: string; name?: string;
  configuredFrequencyKHz?: FrequencyKHz; configuredChannelNumber?: number;
  configuredIp?: string; notes?: string; provenance?: Json;
}
export interface DeviceAlias { receiverId: string; channelNumber: number; alias: string }
export interface ProjectMetadata { id: string; name: string; data?: { [key: string]: Json } }
export interface LegacySnapshot { sourceOrigin: string; sourceKey: string; payload: Json }
/** Historical/last-persisted state, explicitly not a device control target.
 * Null RF/AF/battery/mute values are unknown, not zero/false.
 */
export interface StoredChannel {
  id: string; receiver_id: string; channel_number: number;
  receiver_mac: string | null; receiver_ip: string | null; brand: string | null; model: string | null;
  group_number: number | null; freq: FrequencyKHz | null;
  rf: number | null; af: number | null; af_dbfs: number | null; batt: number | null; muted: boolean | null;
  _online: boolean; status: 'online' | 'offline'; removed: boolean;
  last_seen_at_ms: TimeMs | null; observed_at_ms: TimeMs; boot_id: string;
  storage_origin: 'bridge.snapshot'; control_target: false;
}
export interface StoredChannelPage extends DatabaseIdentity {
  success: true; channels: StoredChannel[]; count: number; next_cursor: string | null;
}
export interface StoredOverview extends DatabaseIdentity {
  success: true; online_devices: number; online_receivers: number; active_channels: number;
  known_channels: number; brand_counts: Record<string, number>; boot_id: string; observed_at_ms: TimeMs;
}
