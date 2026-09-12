import { trpc } from "@/lib/trpc";
import { useEffect } from "react";

export function useRecentView(input: { workspaceId?: number; entityType: "project" | "dataset" | "pipeline"; entityId?: string; entityLabel?: string }) {
  const mutation = trpc.workspace.recordRecent.useMutation();
  useEffect(() => {
    if (!input.workspaceId || !input.entityId || !input.entityLabel) return;
    mutation.mutate({ workspaceId: input.workspaceId, entityType: input.entityType, entityId: input.entityId, entityLabel: input.entityLabel });
    // Detail pages intentionally write once per mount; the server upserts and bumps viewed_at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.workspaceId, input.entityType, input.entityId, input.entityLabel]);
}

export function activeWorkspaceId() {
  return typeof window === "undefined" ? 0 : Number(localStorage.getItem("astra-active-workspace")) || 0;
}
