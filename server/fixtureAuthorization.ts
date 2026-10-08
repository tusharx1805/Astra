import { TRPCError } from "@trpc/server";

export function authorizeFixtureWorkspace(workspaceId: number, memberWorkspaceIds: number[]) {
  if (!memberWorkspaceIds.includes(workspaceId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this fixture workspace." });
  }
  return true as const;
}
