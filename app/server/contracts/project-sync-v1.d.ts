/** C2 candidate only. Not loaded by the current production HTML or Bridge.
 * Host transport retains its receiver-independent access, TLS and cancellation.
 */
import type {JsonObject} from './bridge-v1';
import type {ProjectContent, RevisionProject, ProjectConflict, ProjectPrepareResult, ProjectMergeInput} from './project-revision-v1';

export interface ProjectSyncScope {
  baseUrl: string; // Exact HTTPS service origin; no path, userinfo, query or hash.
  projectId: string;
  accessRevision: number | string;
}
export type ProjectSyncStatus = 'unloaded' | 'loaded' | 'saved' | 'unsupported' |
  'conflict' | 'unknown' | 'partial' | 'invalidated' | 'unauthorized' | 'error' | 'busy';
export interface ProjectSyncResult {
  status: ProjectSyncStatus;
  scope?: ProjectSyncScope;
  project?: RevisionProject | null;
  revision?: number;
  protocol?: 'daty-project-revision-v1';
  phase?: 'project' | 'run';
  expectedRevision?: number;
  code?: string;
  message?: string;
  httpStatus?: number;
  conflicts?: ProjectConflict[];
  projectSaved?: boolean;
  runStatus?: 'saved' | 'failed' | 'unknown' | 'not-sent';
  runId?: string;
  reconciled?: boolean;
  blocked?: boolean;
  writeRejected?: boolean;
  knownUnsent?: boolean; // Only a trusted synchronous host refusal, not an async network assertion.
}
export interface ProjectSyncSnapshot {
  VERSION: 'daty-project-sync-v1';
  scope: ProjectSyncScope | null;
  project: RevisionProject | null | undefined;
  loaded: boolean;
  pending: 'load' | 'save' | 'reconcile' | null;
  unknown: null | {phase: 'project' | 'run'; expectedRevision: number; projectSaved: boolean};
  status: ProjectSyncStatus;
}
export interface ProjectSyncPorts {
  request(url: string, init: RequestInit): Promise<{status: number; ok: boolean; json(): Promise<unknown>}>;
  readScope(): ProjectSyncScope;
  schedule(callback: () => void, delayMs: number): unknown; // Synchronous cancellable handle, never Promise.
  cancel(handle: unknown): void;
  concurrency: {
    PROTOCOL: 'daty-project-revision-v1';
    prepareSave(input: ProjectMergeInput): ProjectPrepareResult;
    mergeProject(input: Omit<ProjectMergeInput, 'protocol'>): unknown;
  };
}
export interface ProjectSyncController {
  VERSION: 'daty-project-sync-v1';
  load(): Promise<ProjectSyncResult>; // Establishes editing baseline; never POST.
  save(desired: ProjectContent, options?: {run?: JsonObject}): Promise<ProjectSyncResult>;
  reconcile(): Promise<ProjectSyncResult>; // Explicit GET-only, no automatic resend.
  invalidate(): void; // Does not discard an uncertain write for the same server/project.
  snapshot(): ProjectSyncSnapshot;
}
// A separate legacy-page adapter maps these results to existing status/dialog UI.
// Unknown locks last for this controller instance only; durable operation IDs,
// run lookup and database-restore epochs are not implemented by this contract.
