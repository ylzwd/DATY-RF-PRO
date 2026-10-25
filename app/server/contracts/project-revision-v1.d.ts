/** C2 CANDIDATE ONLY: isolated HTTP/client integration, not the running Bridge API.
 * See docs/project-concurrency.md. No authorization, I/O or commit occurs here.
 */
import type {ProjectSnapshot, SaveProjectRequest, JsonObject} from './bridge-v1';
export type ProjectRevisionProtocol = 'daty-project-revision-v1';
export type ProjectContent = Pick<ProjectSnapshot, 'id' | 'name' | 'data' | 'devices'>;
export interface RevisionProject extends ProjectContent {
  revision: number; // Positive JS-safe integer, validated at runtime.
  revision_protocol?: ProjectRevisionProtocol;
  created_at?: ProjectSnapshot['created_at']; // Present on GET, not synthesized by a save confirmation.
  updated_at?: ProjectSnapshot['updated_at'];
}
export interface ConditionalProjectSave extends SaveProjectRequest {
  id: string;
  name: string;
  data: JsonObject;
  devices: JsonObject[];
  expected_revision: number; // 0 create-only, positive integer conditional update.
}
export interface ProjectMergeInput {
  base: RevisionProject | null;
  desired: ProjectContent;
  remote: RevisionProject | null;
  protocol?: ProjectRevisionProtocol; // Actual validated response marker; never invented.
}
export interface ProjectConflict {code: string; path: string; recordId?: string}
export type ProjectPrepareResult =
  | {status: 'ready'; protocol: ProjectRevisionProtocol; body: ConditionalProjectSave}
  | {status: 'conflict'; conflicts: ProjectConflict[]}
  | {status: 'unsupported'; code: 'PROJECT_REVISION_UNSUPPORTED'};
