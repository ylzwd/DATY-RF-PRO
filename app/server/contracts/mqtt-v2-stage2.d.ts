/** Stage 2 isolated read-only transport. Business fields reuse the SSE DTO. */
export type DeviceReadKind = 'device_list' | 'device_update' | 'heartbeat';
export interface CanonicalDevicePayload {
  devices: Record<string, unknown>[];
  server_time_ms?: number;
  ts?: number;
  type?: 'device_list' | 'device_update';
  clock_source?: 'fuwuqi';
  data?: null;
}
export type DeviceReadEnvelope = {
  schema: 'daty-device-read-v1';
  server_id: 'stage2-server';
  boot_id: string;
  stream_id: string;
  /** Transport sequence, NOT database revision/commit/receiver ACK. */
  seq: number;
} & ({kind: 'device_list' | 'device_update'; payload: CanonicalDevicePayload}
  | {kind: 'heartbeat'; payload: null});
export interface ReadonlyDeviceHandlers {
  snapshot(devices: Record<string, unknown>[], payload: CanonicalDevicePayload): void;
  delta(devices: Record<string, unknown>[], payload: CanonicalDevicePayload): void;
  /** Preserve cached cards and mark only this transport's owned devices offline. */
  offline(reason: string): void;
  online?(): void;
}
export interface ReadonlyDeviceLifecycle { start(): void; stop(): void }
