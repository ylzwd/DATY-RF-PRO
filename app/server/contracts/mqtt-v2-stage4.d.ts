/** Isolated M4 candidate. Runtime validators remain authoritative. */
import type { Json, DatabaseIdentity, WriteRequest, BatchRequest, Operation, Resource } from './business-database-v1';
export type DataMethod = 'database.status' | 'database.resources.list' | 'database.resources.get' |
  'database.operations.get' | 'database.channels' | 'database.overview' | 'database.draft.get' |
  'database.business_snapshot' | 'database.import.preview' | 'projects.list' | 'projects.get' |
  'timeline.list' | 'discovery.status' | 'state.health' | 'state.stats' | 'state.capabilities' | 'state.clock' |
  'operations.get' | 'database.write' | 'database.batch' | 'database.draft.save' | 'database.import.commit' |
  'projects.save' | 'planning.run.create' | 'timeline.append' | 'discovery.scan' | 'discovery.cancel';
export interface DataRequest {
  schema: 'daty-mqtt-data-v1'; server_id: 'stage4-server'; boot_id: string;
  client_session_id: string; request_id: string; method: DataMethod;
  deadline_at_ms: number; body: { [key: string]: Json };
}
/** Metadata and full original JSON response. status is an API status, not a network HTTP response. */
export interface DataResult<T = Json> { status: number; body: T; operation_id?: string }
export type OperationState = 'committed' | 'rejected' | 'dispatching' | 'accepted' |
  'completed' | 'cancel_requested' | 'cancelled' | 'failed' | 'not_started' | 'unknown';
export interface DataOperation {
  operation_id: string; method: DataMethod; epoch: string; state: OperationState;
  created_at_ms: number; updated_at_ms: number; receipt_revision: number;
  generation?: number; error?: string; result: DataResult;
}
export interface OperationQuery extends DatabaseIdentity { success: true; operation: DataOperation | Operation }
export interface Mutation { operation_id: string; epoch: string }
export interface DiscoveryStart extends Mutation { expected_generation: number }
export interface DiscoveryCancel extends DiscoveryStart { scan_operation_id: string }
export interface ProjectSave extends Mutation {
  id?: string; name?: string; expected_revision: number; data?: { [key: string]: Json }; devices?: Json[];
}
export interface DraftSave extends Mutation {
  projectId: string; fields: Record<string,string>; expected_draft_id: string | null;
}
export interface TimelineAppend extends Mutation {
  event_type: string; summary: string; details?: Json; project_id?: string; device_id?: string; command_id?: string;
}
export interface ImportCommit extends Mutation { backup: Json; confirmed: true; previewDigest: string }
export type BusinessMutation = WriteRequest | BatchRequest | ProjectSave | DraftSave | TimelineAppend | ImportCommit;
/** Business writes resolve only after FULL commit. MQTT PUBACK never means saved.
 * A transport error/abort is unknown: preserve the existing pending journal and query.
 * A 404 operation query is not permission to retry a possibly in-flight mutation.
 * Discovery accepted/cancel_requested describe a durable request, not completion.
 * Same-peer reconnect preserves native receipt ownership; DHCP address change does not impersonate the old peer.
 */
