// Client observation only; authoritative execution remains command_id + server ACK.
export interface DeploymentStep {
  device_id: string;
  receiver_id?: string;
  receiver_ip?: string;
  group_number: number | null;
  channel: number | null;
  frequency_khz: number;
  state: 'checking' | 'unchanged' | 'sending' | 'acknowledged' | 'failed' | 'not-sent';
  started_ms: number | null;
  preflight_finished_ms?: number | null;
  request_start_ms?: number | null;
  http_headers_ms?: number | null;
  http_body_ms?: number | null;
  ack_received_ms?: number | null;
  verified_ms?: number | null;
  client_request_id?: string;
  command_id?: string;
  server_ack_ms?: number | null;
  confirmation_path?: string;
  error?: string;
}
export interface DeploymentDiagnostic {
  version: 'daty-deployment-diagnostic-v1';
  at: string; // Client wall clock. Server Timeline supplies its own timestamp/peer.
  total: number;
  state: 'running' | 'success' | 'failed' | 'stopped' | 'unchanged';
  steps: DeploymentStep[];
  acknowledged?: number;
  skipped?: number;
  failed?: number;
  sent?: number;
  remaining?: number;
  elapsed_ms?: number | null;
  audit?: 'saved' | 'unconfirmed'; // Affects diagnostic persistence, never device ACK.
}
