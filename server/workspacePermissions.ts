export type WorkspaceRole = "owner" | "admin" | "developer" | "reviewer" | "viewer";

export function mayManageWorkspace(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

export function mayUpdateWorkspaceEnvironment(role: WorkspaceRole): boolean {
  return mayManageWorkspace(role);
}

export function mayInviteWorkspaceMember(role: WorkspaceRole): boolean {
  return mayManageWorkspace(role);
}

export function mayManageMember(actor: WorkspaceRole, target: WorkspaceRole): boolean {
  if (!mayManageWorkspace(actor)) return false;
  if (target === "owner") return false;
  return true;
}

export function mayAssignWorkspaceRole(actor: WorkspaceRole, target: WorkspaceRole, next: WorkspaceRole): boolean {
  if (!mayManageMember(actor, target)) return false;
  return next !== "owner";
}

export function mayReadWorkspace(requestedWorkspaceId: number, memberWorkspaceIds: number[]): boolean {
  return memberWorkspaceIds.includes(requestedWorkspaceId);
}
