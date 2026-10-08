import type { WorkspaceRole } from "./workspacePermissions";

export type AstraRole = "admin" | "developer" | "reviewer";

/**
 * Global Supabase role (app_metadata.astra_role). Used only by the SIMULATED
 * sandbox review path, which is not tied to a workspace.
 */
export function mayRecordReview(role: AstraRole): boolean {
  return role === "admin" || role === "reviewer";
}

/**
 * Phase 5 — who may record a decision on a persisted change: the workspace
 * owner, admins and reviewers. Developers propose changes; viewers read.
 */
export function mayRecordWorkspaceReview(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin" || role === "reviewer";
}

/**
 * Separation of duties: the author of a change may not APPROVE it (they may
 * still block it or request changes). Flip to true to allow self-approval.
 */
export const ALLOW_SELF_APPROVAL = false;
