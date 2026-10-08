import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { projects } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { audit, extractInsertId, getWorkspaceContext } from "./workspaceDb";
import { mayManageWorkspace } from "./workspacePermissions";

/**
 * Projects are organization-scoped in the current schema (no workspaceId column).
 * Access is still gated through workspace membership: the caller must belong to a
 * workspace of that organization, and only owners/admins may create projects.
 */

export async function listProjects(user: User, workspaceId: number) {
  const { db, workspace } = await getWorkspaceContext(user, workspaceId);
  return db.select({ id: projects.id, name: projects.name, description: projects.description, environment: projects.environment, createdAt: projects.createdAt })
    .from(projects).where(eq(projects.organizationId, workspace.organizationId)).orderBy(desc(projects.createdAt));
}

export async function createProject(user: User, workspaceId: number, input: { name: string; description?: string; environment: string }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayManageWorkspace(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners and admins can create projects." });
  const name = input.name.trim();
  const duplicate = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.organizationId, workspace.organizationId), eq(projects.name, name))).limit(1);
  if (duplicate[0]) throw new TRPCError({ code: "CONFLICT", message: `A project named "${name}" already exists.` });
  const id = extractInsertId(await db.insert(projects).values({ organizationId: workspace.organizationId, name, description: input.description?.trim() || null, environment: input.environment }).returning({ id: projects.id }));
  await audit(db, { organizationId: workspace.organizationId, workspaceId, actorId: user.id, action: "PROJECT_CREATED", resourceType: "project", resourceId: String(id), metadata: { name, environment: input.environment } });
  return { id, name, environment: input.environment };
}
