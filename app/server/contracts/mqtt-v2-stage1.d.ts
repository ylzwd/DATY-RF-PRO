/** Stage 1 isolated contract; not a deployed client API. */
export type ReceiverId = string;
export type IngressKind = 'register' | 'telemetry' | 'local-event' | 'clock-ack';
export interface TrustedReceiverSource {
  receiver_id: ReceiverId;
  receiver_mac: string;
  /** From accepted socket. Never from payload, topic, Origin or X-Forwarded-For. */
  peer_ip: string;
  group_number: number;
  brand: string;
  session_id: string;
  authenticated: true;
  ip_source: 'socket-peer';
  identity_source: 'daty-pairing-v1';
  group_source: 'server-fifo-v1';
}
export interface ReceiverIngress {
  schema: 'daty-mqtt-ingress-v2-stage1';
  server_id: string;
  boot_id: string;
  event_id: string;
  sequence: number;
  received_at_ms: number;
  kind: IngressKind;
  source: TrustedReceiverSource;
  /** Legacy units intentionally preserved; not a normalized UI Device object. */
  payload: Record<string, unknown>;
}
/** Target contract for later phases; no stage 1 handler executes these requests. */
export interface ProposedBusinessRequest {
  schema: 'daty-business-request-v2';
  server_id: string;
  boot_id: string;
  client_session_id: string;
  request_id: string;
  method: string;
  deadline_at_ms: number;
  body: Record<string, unknown>;
}
export type OutcomePhase = 'rejected' | 'accepted' | 'committed' | 'published'
  | 'acknowledged' | 'failed' | 'timeout' | 'unknown';
