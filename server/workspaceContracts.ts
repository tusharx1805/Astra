import type { WorkspaceRole } from "./workspacePermissions";

export const WORKSPACE_AUDIT_ACTIONS = {
  savedQueryCreated: "SAVED_QUERY_CREATED",
  savedQueryRun: "SAVED_QUERY_RUN",
  datasetConnected: "DATASET_CONNECTED_VIA_INTEGRATIONS",
} as const;

export function mayCreateSavedQuery(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

export function mayRunSavedQuery(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin" || role === "developer" || role === "reviewer" || role === "viewer";
}

export const DATASET_AUDIT_ACTIONS = {
  imported: "DATASET_IMPORTED",
  importFailed: "DATASET_IMPORT_FAILED",
} as const;

/** Build roles may create datasets; reviewers and viewers are read-only. */
export function mayImportDataset(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin" || role === "developer";
}

/** Every workspace member may read the workspace's datasets. */
export function mayReadDataset(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin" || role === "developer" || role === "reviewer" || role === "viewer";
}

export const PIPELINE_AUDIT_ACTIONS = {
  created: "PIPELINE_CREATED",
  updated: "PIPELINE_UPDATED",
} as const;

/** Build roles may create and edit pipeline definitions; reviewers and viewers are read-only. */
export function mayEditPipeline(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin" || role === "developer";
}

/** Every workspace member may read the workspace's pipeline definitions. */
export function mayReadPipeline(role: WorkspaceRole): boolean {
  return mayReadDataset(role);
}

export const PIPELINE_RUN_AUDIT_ACTIONS = {
  succeeded: "PIPELINE_RUN_SUCCEEDED",
  failed: "PIPELINE_RUN_FAILED",
} as const;

/** Build roles may start runs (a run writes datasets); reviewers and viewers can read run history. */
export function mayRunPipeline(role: WorkspaceRole): boolean {
  return mayEditPipeline(role);
}

export const CHANGE_AUDIT_ACTIONS = {
  analyzed: "CHANGE_ANALYZED",
  reanalyzed: "CHANGE_REANALYZED",
} as const;

/** Proposing a change (and re-running its analysis) is a build action. */
export function mayAnalyzeChange(role: WorkspaceRole): boolean {
  return mayEditPipeline(role);
}

/** Every workspace member, including reviewers and viewers, can read changes and their analyses. */
export function mayReadChanges(role: WorkspaceRole): boolean {
  return mayReadDataset(role);
}

export const REVIEW_AUDIT_ACTIONS = { recorded: "REVIEW_RECORDED" } as const;

export const OPS_AUDIT_ACTIONS = {
  checkCreated: "QUALITY_CHECK_CREATED",
  checkToggled: "QUALITY_CHECK_TOGGLED",
  checksEvaluated: "QUALITY_CHECKS_EVALUATED",
  incidentOpened: "INCIDENT_OPENED",
  incidentRecurred: "INCIDENT_RECURRED",
  incidentAcknowledged: "INCIDENT_ACKNOWLEDGED",
  incidentResolved: "INCIDENT_RESOLVED",
} as const;

/** Defining and running quality checks is a build action. */
export function mayManageQuality(role: WorkspaceRole): boolean {
  return mayEditPipeline(role);
}

/** Acknowledging and resolving incidents: owner, admin, developer and reviewer (viewers read only). */
export function mayHandleIncidents(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin" || role === "developer" || role === "reviewer";
}

export const AI_AUDIT_ACTIONS = {
  briefGenerated: "AI_BRIEF_GENERATED",
  briefFailed: "AI_BRIEF_FAILED",
  /** Written before every model call (rate-limit reservation), whatever the outcome. */
  callStarted: "AI_CALL_STARTED",
} as const;

/** Requesting an AI brief costs money and sends metadata to the AI provider: build roles and reviewers, not viewers. */
export function mayGenerateAiBrief(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin" || role === "developer" || role === "reviewer";
}
