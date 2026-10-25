/** Isolated M5 wire DTOs; preserve the original data/enrollment domain bodies. */
export type Sha256 = string;
export type OperationId = string;
export interface M5Request<T = Record<string, unknown>> {
  schema: 'daty-mqtt-files-v1' | 'daty-mqtt-enrollment-v1';
  server_id: 'stage5-server'; boot_id: string; client_session_id: string;
  request_id: string; deadline_at_ms: number; method: string; body: T;
}
export interface UploadIntent { operation_id: OperationId; bytes: number; sha256: Sha256; media_type: 'text/plain' | 'text/csv' | 'application/json'; }
export interface UploadReference { upload_id: OperationId; sha256: Sha256; }
/** sha256 is the hash of this chunk; uploads.finish uses the whole-file hash. */
export interface UploadChunk { upload_id: OperationId; offset: number; data: string; sha256: Sha256; }
export interface UploadStatus {
  id: OperationId; bytes: number; sha256: Sha256; offset: number;
  state: 'uploading' | 'ready' | 'cancelling' | 'cancelled'; media_type: string;
}
export interface DownloadDescriptor {
  id: OperationId; bytes: number; sha256: Sha256; state: 'ready';
}
export interface DownloadChunk {
  download_id: OperationId; offset: number; bytes: number; sha256: Sha256;
  file_sha256: Sha256; data: string; eof: boolean;
}
export interface LargeResponse { status: 'download_required'; transfer: DownloadDescriptor; encoding: 'json-utf8'; }
export interface DataDocument { method: string; body: Record<string, unknown>; }
export interface FileOperation {
  id: OperationId; state: 'started' | 'completed' | 'unknown'; result?: unknown; domain_status?: unknown;
}
export interface EnrollmentChallengeRequest {
  protocol: 'daty-auto-pair-v1'; receiver_mac: string; brand: string; channel_count: number;
  public_key: {kty: 'EC'; crv: 'P-256'; x: string; y: string};
}
export interface EnrollmentProof { challenge_id: string; signature: string; }
/** Returned pairing bundle is deliberately not a business resource/receipt. */
export interface EnrollmentAssignment {
  receiver_ip: string; ip_source: 'socket-peer'; group_number: number; group_source: 'server-fifo-v1';
}
