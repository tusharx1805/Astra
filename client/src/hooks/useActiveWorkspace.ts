import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";

export const ACTIVE_WORKSPACE_STORAGE_KEY = "astra-active-workspace";
export const ACTIVE_WORKSPACE_EVENT = "astra-workspace-change";

/** Stored preference only — never trust it without checking membership. */
export function readStoredWorkspaceId(): number {
  try {
    return typeof window === "undefined" ? 0 : Number(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}

export type ActiveWorkspace = { id: number; name: string; role: string; organizationId: number };

/**
 * Single source of truth for "which workspace is the user working in".
 * The stored id is only honoured if it is one of the caller's own memberships
 * (a stale id from another account or a deleted workspace falls back to the
 * first membership). There is no hardcoded fallback id.
 * The membership query only runs when authenticated, so signed-out preview
 * visitors are never bounced to login by a background query.
 */
export function useActiveWorkspace() {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const list = trpc.workspace.list.useQuery(undefined, { enabled: isAuthenticated });
  const [storedId, setStoredId] = useState(readStoredWorkspaceId);
  useEffect(() => {
    const onChange = (event: Event) => setStoredId(Number((event as CustomEvent<number>).detail) || readStoredWorkspaceId());
    window.addEventListener(ACTIVE_WORKSPACE_EVENT, onChange);
    return () => window.removeEventListener(ACTIVE_WORKSPACE_EVENT, onChange);
  }, []);
  const memberships = list.data ?? [];
  const workspace = (memberships.find(item => item.id === storedId) ?? memberships[0] ?? null) as ActiveWorkspace | null;
  return {
    workspace,
    workspaceId: workspace?.id ?? 0,
    role: workspace?.role ?? null,
    isAuthenticated,
    isLoading: authLoading || (isAuthenticated && list.isLoading),
    hasWorkspace: Boolean(workspace),
    /** Set when the workspace database cannot be reached (authentication itself is unaffected). */
    storageError: list.error ? list.error.message : null,
    list,
  };
}

/** Roles allowed to import datasets. Mirrors server/workspaceContracts.mayImportDataset (the server stays authoritative). */
export function canImportDatasets(role: string | null) {
  return role === "owner" || role === "admin" || role === "developer";
}

/** Roles allowed to create and edit pipeline definitions. Mirrors server/workspaceContracts.mayEditPipeline. */
export function canEditPipelines(role: string | null) {
  return canImportDatasets(role);
}
