/** Network peer is a transport source, not an authenticated operator. */
export interface NetworkSource { id: string; kind: 'network-peer'; authenticated: false; ip: string }
export interface ArchiveRequest { operation_id: string }
export interface TextArchiveRequest extends ArchiveRequest { text: string; fileName: string; mimeType: string; source?: string }
export interface ArchiveRecord {
  protocol: 'daty-server-archive-v1'; id: string;
  status: 'writing' | 'queued' | 'running' | 'saved' | 'failed' | 'interrupted' | 'deleting' | 'deleted';
  createdAtMs: number; completedAtMs?: number; fileName: string;
  bytes?: number; sha256?: string; stage?: string; error?: string;
  tables?: number; rows?: number; exports?: number;
  generation?: string; cleanupId?: string; deletedAtMs?: number; deletedBy?: NetworkSource;
}
export interface ArchiveCleanupSelection { category: 'all' | 'archives' | 'exports'; id?: string }
export interface ArchiveCleanupPlan {
  protocol: 'daty-archive-cleanup-v1'; id: string;
  status: 'prepared' | 'running' | 'completed' | 'partial' | 'interrupted';
  selection: ArchiveCleanupSelection; createdAtMs: number; completedAtMs?: number;
  planSha256: string; count: number; bytes: number;
  items: Array<{ category: 'archives' | 'exports'; id: string; fileName: string; bytes: number; fingerprint: string }>;
  deletedCount?: number; freedBytes?: number; error?: string;
  results?: Array<{ category: 'archives' | 'exports'; id: string; status: 'deleted' | 'failed'; freedBytes: number; error?: string }>;
}
/** POST archive-cleanups {operation_id, selection} freezes exact files for 10 minutes.
 * Confirm through the host dialog; POST archive-cleanups/:id/commit {confirmed:true, planSha256}.
 * GET archive-cleanups/:id reconciles a lost response, never automatically repeat the commit.
 * This removes generated payload files only, preserving live SQLite and deletion manifests/receipts.
 * New exports (including browser-cache archival) after deletion are new generations.
 */
export interface PlanningDraftRequest extends ArchiveRequest {
  projectId: string; fields: Record<string, string>;
  expected_draft_id: string | null; epoch: string;
}
export interface UnconfirmedDraft {
  projectId: string; fields: Record<string, string>;
  sourceKind: 'ui-draft'; deploymentEligible: false;
}
/** GET status/list/detail/download; POST exports/archives/draft.
 * Server saved is separate from native file completion and receiver ACK.
 * Full ZIP is streamed as an HTTPS attachment, not a text-export port.
 */
