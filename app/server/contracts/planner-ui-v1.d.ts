/** View-only planner capabilities. These ports never bypass original solver, storage or ACK handlers. */
export type PlannerAction = 'basic'|'constraints'|'safety'|'importProfile'|'confirmLock'|'removeLock'|'saveConstraints'|'plan'|'details'|'exportReport'|'exportPlan'|'pushAll'|'pushOne'|'stop'|'previousPage'|'nextPage'|'closeDetails'|'closeSafety';
export interface PlannerField {
  id:string; label:string; type:'number'|'select'; value:string;
  min?:number; max?:number; step?:number; optional?:boolean;
  options?:Array<{value:string;label:string}>;
}
export type PlannerWindow = {kind:'details';title:string;text:string} | {
  kind:'safety';title:string;description:string;footnote:string;liveEdit:true;fields:PlannerField[];
};
export interface DatyPlannerViews {
  VERSION:'daty-planner-views-v1';
  /** Preserve this. Missing native capability cannot fall back to a browser window.
   * Safety edits are live drafts: closing does not undo them. Validate numeric semantics with the original planner.
   * Signal closes the view and disables callbacks; never replay a rejected edit.
   */
  open(model:PlannerWindow,options:{
    signal:AbortSignal;
    onEdit(change:{id:string;value:string}):{accepted:boolean;value?:string;message?:string;validationMessage?:string};
  }):Promise<{status:'closed'}>;
}
export interface DatyPlannerActions {
  VERSION:'daty-planner-actions-v1';
  list():Array<{id:PlannerAction;label:string}>;
  /** Local page adapter: delegates to the original public handler, retaining its sync/async result.
   * pushOne requires a stable channel ID; it must never interpret a missing ID as pushAll.
   */
  execute(action:PlannerAction,channelId?:string|number):unknown;
  getWindowModel(kind:'details'|'safety'):PlannerWindow;
}
export type DeploymentPhase='running'|'success'|'failed'|'stopped'|'unchanged';
export interface DeploymentSnapshot {
  phase:DeploymentPhase;total:number;acknowledged:number;skipped:number;failed:number;remaining:number;
  currentLabel?:string;message?:string;rows:Array<{id:string|number;state:'queued'|'sending'|'acknowledged'|'unchanged'|'failed'|'not-sent';text?:string}>;
}
export interface DatyNativeDeployProgress {
  VERSION:'daty-deploy-progress-v1';
  /** Synchronous session creation is required before any command is sent. No Promise session.
   * The host displays only supplied, already-checked counts. Stop does not cancel an in-flight ACK.
   * Ask onClose before closing from UI; false means an ACK is still unresolved.
   */
  open(options:{title?:string;rows:Array<{id:string|number;brand:string;receiver:string;channel:string;frequency:string}>;
    onStop():void;onClose():boolean;
  }):{update(snapshot:DeploymentSnapshot):void;close():void};
}
/** DatyPlanCsv.buildText(devices) and prepareExport(devices, date) are pure output models;
 * file output reuses daty-text-export-v1, preserving CSV BOM/CRLF/escaping and existing columns.
 * DatyPlannerViews callbacks/sessions are local adapter capabilities, not JSON values.
 * An IPC host must map them to session IDs, commands and cancellation events explicitly.
 */
