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
