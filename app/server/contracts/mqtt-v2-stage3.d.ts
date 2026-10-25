export interface ControlTarget {
  device_id: string;
  receiver_id: string;
  receiver_mac: string;
  receiver_ip: string;
  receiver_session_id: string;
  channel_number: number;
  expected_brand: string;
}
export type ControlIntent = {operation_id: string; target: ControlTarget} & (
  {command: 'set_freq'; expected_value: number} | // Integer kHz, never MHz at this boundary.
  {command: 'mute'; expected_value: true} |
  {command: 'unmute'; expected_value: false});
export type CommandRpcRequest = {
  schema: 'daty-command-rpc-v1';
  server_id: 'stage3-server';
  boot_id: string;
  client_session_id: string;
  request_id: string;
  deadline_at_ms: number;
} & ({method: 'commands.request'; body: ControlIntent} |
  {method: 'commands.get'; body: {operation_id: string}} |
  {method: 'commands.targets'; body: Record<string, never>});
export type ControlState = 'reserved' | 'dispatching' | 'published' | 'acknowledged'
  | 'rejected' | 'not_sent' | 'timeout' | 'unknown';
export interface ControlRecord {
  operation_id: string;
  command_id: string;
  entry: 'mqtt' | 'https';
  server_id: 'stage3-server';
  boot_id: string;
  revision: number;
  state: ControlState;
  target: ControlTarget;
  command: 'mute' | 'unmute' | 'set_freq';
  expected_value: boolean | number;
  actual_value: boolean | number | null;
  deadline_at_ms: number;
  /** Durable dispatch claims. A claim may crash before the actual socket write. */
  attempts: 0 | 1;
  error: string | null;
  execution_evidence: null | {
    source: 'paired-receiver-status';
    command_id: string;
    receiver_session_id: string;
    receiver_id: string;
    device_id: string;
    channel_number: number;
    brand: string;
    received_at_ms: number;
  };
}
export interface NativeControlBoundary {
  start(): Promise<void>;
  stop(): void;
  targets(): Promise<{active_entry: 'mqtt' | 'https'; targets: {
    target: ControlTarget; group_number: number | null; group_source: 'server-fifo-v1';
    model: string | null; capabilities: Record<string, unknown>;
  }[]}>;
  /** Requires injected existing confirmation/review callback; never HTTP fallback. */
  execute(intent: ControlIntent): Promise<ControlRecord | {
    operation_id: string; state: 'cancelled' | 'not_sent' | 'unknown';
    error?: string; query_only?: true;
  }>;
  /** The only recovery operation; never republishes the original command. */
  query(operation_id: string): Promise<ControlRecord>;
}
