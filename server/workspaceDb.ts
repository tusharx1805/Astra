import { TRPCError } from "@trpc/server";
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  auditLogs,
  ingestionAttempts,
  organizationMembers,
  organizations,
  pipelines,
  projects,
  queryRuns,
  recentlyViewed,
  savedQueries,
  datasets,
  datasetConnections,
  workspaceDataEnvironment,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from "../drizzle/schema";
import type { AuthUser } from "./_core/supabaseAuth";
import { fetchProfiles } from "./_core/supabaseProfiles";

/** Every function takes the Supabase Auth identity; user references are Supabase Auth UUIDs. */
type User = AuthUser;
import { getDb } from "./db";
import { mayAssignWorkspaceRole, mayInviteWorkspaceMember, mayManageMember, mayManageWorkspace, mayUpdateWorkspaceEnvironment, type WorkspaceRole } from "./workspacePermissions";
import { mayCreateSavedQuery, mayRunSavedQuery, WORKSPACE_AUDIT_ACTIONS } from "./workspaceContracts";
import { buildEncryptedConnectionMetadata } from "./fixtureConnection";

export type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Reads the id from an `INSERT … RETURNING id` result (Postgres). */
export function extractInsertId(result: unknown): number {
  const first = Array.isArray(result) ? result[0] : result;
  const insertId = (first as { id?: number | string } | undefined)?.id;
  if (insertId === undefined || insertId === null) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Unable to create the workspace resource." });
  return Number(insertId);
}

export async function database(): Promise<Database> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Workspace storage is unavailable." });
  return db;
}

/**
 * Datasets visible inside a workspace: datasets owned by that workspace, plus
 * legacy organization-wide datasets (workspaceId IS NULL) created before Phase 1.
 */
export function datasetVisibleInWorkspace(workspace: { id: number; organizationId: number }): SQL {
  return and(eq(datasets.organizationId, workspace.organizationId), or(eq(datasets.workspaceId, workspace.id), isNull(datasets.workspaceId)))!;
}

/**
 * Pipelines created from Phase 2 belong to exactly one workspace. Legacy rows
 * (workspace_id null) stay visible organisation-wide, read-only, as before.
 */
export function pipelineVisibleInWorkspace(workspace: { id: number; organizationId: number }): SQL {
  return and(eq(pipelines.organizationId, workspace.organizationId), or(eq(pipelines.workspaceId, workspace.id), isNull(pipelines.workspaceId)))!;
}

function workspaceSlug(user: User) {
  return `org-${user.id}`.slice(0, 80);
}

/** The caller's personal organization, found through organizationMembers (no users table). */
export async function ensureOrganizationForUser(user: User) {
  const db = await database();
  const membership = await db.select({ organizationId: organizationMembers.organizationId }).from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .where(and(eq(organizationMembers.userId, user.id), eq(organizations.slug, workspaceSlug(user)))).limit(1);
  if (membership[0]) return membership[0].organizationId;

  // Race-safe: two first requests at once must not fail on the unique slug.
  await db.insert(organizations).values({
    name: `${user.name ?? user.email ?? "ASTRA"} Organization`.slice(0, 160),
    slug: workspaceSlug(user),
  }).onConflictDoNothing();
  const [organization] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, workspaceSlug(user))).limit(1);
  if (!organization) throw new Error("Organization could not be created");
  const organizationId = organization.id;
  await db.insert(organizationMembers).values({ organizationId, userId: user.id, role: user.role })
    .onConflictDoUpdate({ target: [organizationMembers.organizationId, organizationMembers.userId], set: { role: user.role } });
  return organizationId;
}

/** @deprecated Phase 9: saves without a live test. Use createConnection in connectorDb.ts (the router now does). */
export async function createWorkspacePostgresConnection(user: User, input: { workspaceId: number; name: string; host: string; port: number; databaseName: string; username: string; password: string; sslMode: string; }) {
  // Credentials are a workspace-admin capability: membership alone is not enough,
  // and the audit record must belong to the workspace's organization.
  const { db, workspace, actorRole } = await getWorkspaceContext(user, input.workspaceId);
  if (!mayManageWorkspace(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners and admins can save connection credentials." });
  const metadata = buildEncryptedConnectionMetadata(input);
  if (!metadata.persisted) return metadata;
  const organizationId = workspace.organizationId;
  const inserted = await db.insert(datasetConnections).values({ ...metadata.record, createdBy: user.id }).returning({ id: datasetConnections.id });
  const id = extractInsertId(inserted);
  await audit(db, { organizationId, workspaceId: input.workspaceId, actorId: user.id, action: "DATASET_CONNECTION_CREATED", resourceType: "dataset_connection", resourceId: String(id), metadata: { type: "postgresql", host: input.host, databaseName: input.databaseName, username: input.username, sslMode: input.sslMode } });
  return { persisted: true as const, id, name: input.name, type: "postgresql", host: input.host, port: input.port, databaseName: input.databaseName, username: input.username, sslMode: input.sslMode };
}

export async function audit(db: Database, values: {
  organizationId: number;
  workspaceId: number;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  result?: "success" | "failure";
}) {
  await db.insert(auditLogs).values({
    ...values,
    resourceId: values.resourceId ?? null,
    result: values.result ?? "success",
    metadata: values.metadata ?? null,
  });
}

export async function listWorkspacesForUser(user: User) {
  const db = await database();
  await ensureOrganizationForUser(user);
  return db.select({
    id: workspaces.id,
    name: workspaces.name,
    description: workspaces.description,
    organizationId: workspaces.organizationId,
    createdAt: workspaces.createdAt,
    role: workspaceMembers.role,
  }).from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, user.id));
}

export async function getWorkspaceContext(user: User, workspaceId: number) {
  const db = await database();
  const rows = await db.select({
    id: workspaces.id,
    name: workspaces.name,
    description: workspaces.description,
    organizationId: workspaces.organizationId,
    createdBy: workspaces.createdBy,
    createdAt: workspaces.createdAt,
    updatedAt: workspaces.updatedAt,
    role: workspaceMembers.role,
  }).from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)))
    .limit(1);
  const context = rows[0];
  if (!context) throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this workspace." });
  return { db, workspace: context, actorRole: context.role as WorkspaceRole };
}

export async function createWorkspaceForUser(user: User, input: { name: string; description?: string }) {
  const db = await database();
  const organizationId = await ensureOrganizationForUser(user);
  const existing = await db.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.organizationId, organizationId), sql`lower(${workspaces.name}) = lower(${input.name})`)).limit(1);
  if (existing[0]) throw new TRPCError({ code: "CONFLICT", message: `A workspace named "${input.name}" already exists in your organization.` });
  try {
    // Workspace + owner membership + audit are one unit: never a workspace without an owner.
    const workspaceId = await db.transaction(async tx => {
      const id = extractInsertId(await tx.insert(workspaces).values({ organizationId, name: input.name, description: input.description || null, createdBy: user.id }).returning({ id: workspaces.id }));
      await tx.insert(workspaceMembers).values({ workspaceId: id, userId: user.id, role: "owner" });
      await audit(tx as unknown as Database, { organizationId, workspaceId: id, actorId: user.id, action: "WORKSPACE_CREATED", resourceType: "workspace", resourceId: String(id), metadata: { name: input.name } });
      return id;
    });
    return { id: workspaceId, organizationId, name: input.name, role: "owner" as const };
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") throw new TRPCError({ code: "CONFLICT", message: `A workspace named "${input.name}" already exists in your organization.` });
    throw error;
  }
}

export async function getWorkspaceOverview(user: User, workspaceId: number, accessToken: string | null = null) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  const [memberRows, invitations, technologies] = await Promise.all([
    db.select({ id: workspaceMembers.id, userId: workspaceMembers.userId, role: workspaceMembers.role, joinedAt: workspaceMembers.joinedAt })
      .from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)),
    db.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, role: workspaceInvitations.role, status: workspaceInvitations.status, createdAt: workspaceInvitations.createdAt, expiresAt: workspaceInvitations.expiresAt })
      .from(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, workspaceId)),
    db.select({ id: workspaceDataEnvironment.id, technology: workspaceDataEnvironment.technology })
      .from(workspaceDataEnvironment).where(eq(workspaceDataEnvironment.workspaceId, workspaceId)),
  ]);
  // Names come from Supabase public.profiles (read with the caller's token, so RLS applies).
  // Emails are private to Supabase Auth; only the caller's own email is known here.
  const profiles = await fetchProfiles(accessToken, memberRows.map(member => member.userId));
  const members = memberRows.map(member => {
    const profile = profiles.get(member.userId);
    return { ...member, name: profile?.full_name ?? (member.userId === user.id ? user.name : null), username: profile?.username ?? null, email: member.userId === user.id ? user.email : null };
  });
  return { workspace, actorRole, members, invitations, technologies };
}

export async function updateWorkspaceEnvironment(user: User, workspaceId: number, technologies: string[]) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayUpdateWorkspaceEnvironment(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners and admins can update the data environment." });
  await db.transaction(async tx => {
    await tx.delete(workspaceDataEnvironment).where(eq(workspaceDataEnvironment.workspaceId, workspaceId));
    if (technologies.length) await tx.insert(workspaceDataEnvironment).values(technologies.map(technology => ({ workspaceId, technology })));
    await audit(tx as unknown as Database, { organizationId: workspace.organizationId, workspaceId, actorId: user.id, action: "WORKSPACE_ENVIRONMENT_UPDATED", resourceType: "workspace_environment", resourceId: String(workspaceId), metadata: { technologies } });
  });
  return { technologies };
}

export async function inviteWorkspaceMember(user: User, workspaceId: number, input: { email: string; role: Exclude<WorkspaceRole, "owner"> }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayInviteWorkspaceMember(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners and admins can invite members." });
  // Member emails live only in Supabase Auth, so "already a member" can only be checked for the caller;
  // other duplicates are resolved when an invitation is accepted.
  if (user.email && input.email.toLowerCase() === user.email.toLowerCase()) throw new TRPCError({ code: "CONFLICT", message: "You are already a member of this workspace." });
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.insert(workspaceInvitations).values({ workspaceId, email: input.email, role: input.role, invitedBy: user.id, status: "pending", expiresAt })
    .onConflictDoUpdate({ target: [workspaceInvitations.workspaceId, workspaceInvitations.email], set: { role: input.role, invitedBy: user.id, status: "pending", expiresAt } });
  await audit(db, { organizationId: workspace.organizationId, workspaceId, actorId: user.id, action: "MEMBER_INVITED", resourceType: "workspace_invitation", resourceId: input.email, metadata: { role: input.role } });
  return { email: input.email, role: input.role, status: "pending" as const, expiresAt };
}

/** Invitations addressed to the signed-in user's (confirmed) e-mail that can still be accepted. */
export async function listMyInvitations(user: User) {
  if (!user.email) return [];
  const db = await database();
  const rows = await db.select({ id: workspaceInvitations.id, workspaceId: workspaceInvitations.workspaceId, workspaceName: workspaces.name, role: workspaceInvitations.role, createdAt: workspaceInvitations.createdAt, expiresAt: workspaceInvitations.expiresAt })
    .from(workspaceInvitations).innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
    .where(and(sql`lower(${workspaceInvitations.email}) = lower(${user.email})`, eq(workspaceInvitations.status, "pending"), sql`${workspaceInvitations.expiresAt} > now()`));
  return rows.map(row => ({ ...row, emailVerified: Boolean(user.emailVerified) }));
}

/**
 * Accept an invitation: the invitation must be pending, unexpired and addressed to the caller's
 * CONFIRMED e-mail. Membership + status change + audit happen in one transaction; the invitation
 * row is locked so a double click cannot create two memberships.
 */
export async function respondToInvitation(user: User, invitationId: number, accept: boolean) {
  const db = await database();
  if (!user.email) throw new TRPCError({ code: "FORBIDDEN", message: "Your account has no e-mail address to match an invitation." });
  if (accept && !user.emailVerified) throw new TRPCError({ code: "FORBIDDEN", message: "Confirm your e-mail address before accepting an invitation." });
  return db.transaction(async tx => {
    const [invitation] = await tx.select().from(workspaceInvitations).where(eq(workspaceInvitations.id, invitationId)).for("update").limit(1);
    // NOT_FOUND for anything not addressed to this user, so invitation ids are not disclosed.
    if (!invitation || invitation.email.toLowerCase() !== user.email!.toLowerCase()) throw new TRPCError({ code: "NOT_FOUND", message: "Invitation not found." });
    if (invitation.status !== "pending") throw new TRPCError({ code: "CONFLICT", message: `This invitation has already been ${invitation.status}.` });
    if (invitation.expiresAt.getTime() <= Date.now()) {
      await tx.update(workspaceInvitations).set({ status: "expired" }).where(eq(workspaceInvitations.id, invitation.id));
      throw new TRPCError({ code: "CONFLICT", message: "This invitation has expired. Ask the workspace admin to invite you again." });
    }
    const [workspace] = await tx.select({ id: workspaces.id, organizationId: workspaces.organizationId, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, invitation.workspaceId)).limit(1);
    if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "The workspace no longer exists." });
    if (accept) {
      // Already a member (e.g. added another way): keep the existing role.
      await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: invitation.role }).onConflictDoNothing();
    }
    await tx.update(workspaceInvitations).set({ status: accept ? "accepted" : "revoked" }).where(eq(workspaceInvitations.id, invitation.id));
    await audit(tx as unknown as Database, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: accept ? "INVITATION_ACCEPTED" : "INVITATION_DECLINED", resourceType: "workspace_invitation", resourceId: String(invitation.id), metadata: { role: invitation.role } });
    const [membership] = await tx.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, user.id))).limit(1);
    return { workspaceId: workspace.id, workspaceName: workspace.name, accepted: accept, role: membership?.role ?? null };
  });
}

/** Owners/admins withdraw a pending invitation. */
export async function revokeInvitation(user: User, workspaceId: number, invitationId: number) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayInviteWorkspaceMember(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners and admins can revoke invitations." });
  const updated = await db.update(workspaceInvitations).set({ status: "revoked" })
    .where(and(eq(workspaceInvitations.id, invitationId), eq(workspaceInvitations.workspaceId, workspaceId), eq(workspaceInvitations.status, "pending")))
    .returning({ id: workspaceInvitations.id, email: workspaceInvitations.email });
  if (!updated[0]) throw new TRPCError({ code: "NOT_FOUND", message: "No pending invitation with that id in this workspace." });
  await audit(db, { organizationId: workspace.organizationId, workspaceId, actorId: user.id, action: "INVITATION_REVOKED", resourceType: "workspace_invitation", resourceId: String(invitationId), metadata: { email: updated[0].email } });
  return { revoked: true as const };
}

export async function changeWorkspaceMemberRole(user: User, workspaceId: number, memberId: number, role: Exclude<WorkspaceRole, "owner">) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  const target = await db.select({ id: workspaceMembers.id, role: workspaceMembers.role, userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, workspaceId))).limit(1);
  if (!target[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace member not found." });
  if (!mayAssignWorkspaceRole(actorRole, target[0].role as WorkspaceRole, role)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot modify this member role." });
  await db.update(workspaceMembers).set({ role }).where(eq(workspaceMembers.id, memberId));
  await audit(db, { organizationId: workspace.organizationId, workspaceId, actorId: user.id, action: "ROLE_CHANGED", resourceType: "workspace_member", resourceId: String(memberId), metadata: { role } });
  return { memberId, role };
}

export async function getWorkspaceViews(user: User, workspaceId: number) {
  const { db, workspace } = await getWorkspaceContext(user, workspaceId);
  const [projectRows, datasetRows, pipelineRows] = await Promise.all([
    db.select({ id: projects.id, name: projects.name, description: projects.description, environment: projects.environment }).from(projects)
      .where(eq(projects.organizationId, workspace.organizationId)),
    db.select({ id: datasets.id, name: datasets.name, sourceType: datasets.sourceType, qualityScore: datasets.qualityScore, projectId: datasets.projectId, workspaceId: datasets.workspaceId, rowCount: datasets.rowCount, createdAt: datasets.createdAt }).from(datasets)
      .where(datasetVisibleInWorkspace(workspace)).orderBy(desc(datasets.createdAt)),
    db.select({ id: pipelines.id, name: pipelines.name, status: pipelines.status, projectId: pipelines.projectId, workspaceId: pipelines.workspaceId }).from(pipelines)
      .where(pipelineVisibleInWorkspace(workspace)).orderBy(desc(pipelines.id)),
  ]);
  return { projects: projectRows, datasets: datasetRows, pipelines: pipelineRows };
}

export async function searchWorkspaceEntities(user: User, workspaceId: number, query: string) {
  const { db, workspace } = await getWorkspaceContext(user, workspaceId);
  // Escape LIKE wildcards with a single backslash (Postgres' default LIKE escape character).
  const needle = `%${query.replace(/[\\%_]/g, "\\$&").slice(0, 120)}%`;
  const [projectRows, datasetRows, pipelineRows, savedQueryRows] = await Promise.all([
    // Workspace membership is checked before this query; organization scope then follows the same server/RLS boundary as other resources.
    db.select({ id: projects.id, name: projects.name, description: projects.description }).from(projects)
      .where(and(eq(projects.organizationId, workspace.organizationId), or(ilike(projects.name, needle), ilike(projects.description, needle)))).limit(25),
    db.select({ id: datasets.id, name: datasets.name, sourceType: datasets.sourceType }).from(datasets)
      .where(and(datasetVisibleInWorkspace(workspace), ilike(datasets.name, needle))).limit(25),
    db.select({ id: pipelines.id, name: pipelines.name, status: pipelines.status }).from(pipelines)
      .where(and(pipelineVisibleInWorkspace(workspace), ilike(pipelines.name, needle))).limit(25),
    db.select({ id: savedQueries.id, name: savedQueries.name, datasetId: savedQueries.datasetId }).from(savedQueries)
      .where(and(eq(savedQueries.workspaceId, workspaceId), ilike(savedQueries.name, needle))).limit(25),
  ]);
  return {
    projects: projectRows.map(row => ({ id: String(row.id), type: "project" as const, title: row.name, subtitle: row.description ?? "Project", href: "/projects" })),
    datasets: datasetRows.map(row => ({ id: String(row.id), type: "dataset" as const, title: row.name, subtitle: row.sourceType, href: `/datasets/${row.id}` })),
    pipelines: pipelineRows.map(row => ({ id: String(row.id), type: "pipeline" as const, title: row.name, subtitle: row.status, href: `/pipelines/${row.id}` })),
    savedQueries: savedQueryRows.map(row => ({ id: String(row.id), type: "saved_query" as const, title: row.name, subtitle: `CSV dataset ${row.datasetId}`, href: "/saved-queries" })),
  };
}

export async function recordRecentView(user: User, workspaceId: number, input: { entityType: "project" | "dataset" | "pipeline"; entityId: string; entityLabel: string }) {
  const { db, workspace } = await getWorkspaceContext(user, workspaceId);
  const entityId = Number(input.entityId);
  if (!Number.isInteger(entityId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid recent entity id." });
  const table = input.entityType === "project" ? projects : input.entityType === "dataset" ? datasets : pipelines;
  const scope = input.entityType === "dataset" ? datasetVisibleInWorkspace(workspace) : input.entityType === "pipeline" ? pipelineVisibleInWorkspace(workspace) : eq(table.organizationId, workspace.organizationId);
  const entity = await db.select({ id: table.id }).from(table).where(and(eq(table.id, entityId), scope)).limit(1);
  if (!entity[0]) throw new TRPCError({ code: "FORBIDDEN", message: "That resource is outside the active workspace." });
  await db.insert(recentlyViewed).values({ userId: user.id, workspaceId, entityType: input.entityType, entityId: input.entityId, entityLabel: input.entityLabel, viewedAt: new Date() }).onConflictDoUpdate({ target: [recentlyViewed.userId, recentlyViewed.workspaceId, recentlyViewed.entityType, recentlyViewed.entityId], set: { entityLabel: input.entityLabel, viewedAt: new Date() } });
  return { success: true } as const;
}

export async function listRecentViews(user: User, workspaceId: number) {
  const { db } = await getWorkspaceContext(user, workspaceId);
  return db.select({ id: recentlyViewed.id, entityType: recentlyViewed.entityType, entityId: recentlyViewed.entityId, entityLabel: recentlyViewed.entityLabel, viewedAt: recentlyViewed.viewedAt }).from(recentlyViewed).where(and(eq(recentlyViewed.userId, user.id), eq(recentlyViewed.workspaceId, workspaceId))).orderBy(desc(recentlyViewed.viewedAt)).limit(20);
}

export async function listSavedQueries(user: User, workspaceId: number) {
  const { db, workspace } = await getWorkspaceContext(user, workspaceId);
  return db.select({ id: savedQueries.id, name: savedQueries.name, sqlText: savedQueries.sqlText, datasetId: savedQueries.datasetId, datasetName: datasets.name, sourceType: datasets.sourceType, createdAt: savedQueries.createdAt }).from(savedQueries).innerJoin(datasets, eq(savedQueries.datasetId, datasets.id)).where(and(eq(savedQueries.workspaceId, workspaceId), datasetVisibleInWorkspace(workspace))).orderBy(desc(savedQueries.createdAt));
}

export async function createSavedQuery(user: User, workspaceId: number, input: { datasetId: number; name: string; sqlText: string }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayCreateSavedQuery(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace build roles can save queries." });
  const dataset = await db.select({ id: datasets.id, sourceType: datasets.sourceType }).from(datasets).where(and(eq(datasets.id, input.datasetId), datasetVisibleInWorkspace(workspace))).limit(1);
  if (!dataset[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Dataset not found in this workspace." });
  if (dataset[0].sourceType !== "CSV / Files") throw new TRPCError({ code: "BAD_REQUEST", message: "Saved queries are available for CSV / Files datasets only." });
  const id = extractInsertId(await db.insert(savedQueries).values({ workspaceId, datasetId: input.datasetId, createdBy: user.id, name: input.name, sqlText: input.sqlText }).returning({ id: savedQueries.id }));
  await audit(db, { organizationId: workspace.organizationId, workspaceId, actorId: user.id, action: WORKSPACE_AUDIT_ACTIONS.savedQueryCreated, resourceType: "saved_query", resourceId: String(id), metadata: { datasetId: input.datasetId, name: input.name } });
  return { id, name: input.name };
}

export async function recordQueryRun(user: User, workspaceId: number, input: { queryId: number; rowCount: number; durationMs: number }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayRunSavedQuery(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot run saved queries in this workspace." });
  const query = await db.select({ id: savedQueries.id }).from(savedQueries).where(and(eq(savedQueries.id, input.queryId), eq(savedQueries.workspaceId, workspaceId))).limit(1);
  if (!query[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Saved query not found in this workspace." });
  const id = extractInsertId(await db.insert(queryRuns).values({ queryId: input.queryId, workspaceId, runBy: user.id, rowCount: Math.max(0, input.rowCount), durationMs: Math.max(0, input.durationMs) }).returning({ id: queryRuns.id }));
  await audit(db, { organizationId: workspace.organizationId, workspaceId, actorId: user.id, action: WORKSPACE_AUDIT_ACTIONS.savedQueryRun, resourceType: "query_run", resourceId: String(id), metadata: { queryId: input.queryId, rowCount: input.rowCount, durationMs: input.durationMs } });
  return { id };
}

export async function listQueryRuns(user: User, workspaceId: number) {
  const { db } = await getWorkspaceContext(user, workspaceId);
  return db.select({ id: queryRuns.id, queryId: queryRuns.queryId, queryName: savedQueries.name, rowCount: queryRuns.rowCount, durationMs: queryRuns.durationMs, runAt: queryRuns.runAt }).from(queryRuns).innerJoin(savedQueries, eq(queryRuns.queryId, savedQueries.id)).where(and(eq(queryRuns.workspaceId, workspaceId), eq(savedQueries.workspaceId, workspaceId))).orderBy(desc(queryRuns.runAt)).limit(100);
}

export async function listIngestionAttempts(user: User, workspaceId: number) {
  const { db } = await getWorkspaceContext(user, workspaceId);
  return db.select({ id: ingestionAttempts.id, datasetName: ingestionAttempts.datasetName, sourceType: ingestionAttempts.sourceType, status: ingestionAttempts.status, rowsIngested: ingestionAttempts.rowsIngested, createdAt: ingestionAttempts.createdAt }).from(ingestionAttempts).where(eq(ingestionAttempts.workspaceId, workspaceId)).orderBy(desc(ingestionAttempts.createdAt)).limit(100);
}

export async function createIngestionAttempt(user: User, workspaceId: number, input: { datasetName: string; sourceType: string; status?: string; rowsIngested?: number }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayManageWorkspace(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace build roles can create ingestion attempts." });
  const id = extractInsertId(await db.insert(ingestionAttempts).values({ workspaceId, datasetName: input.datasetName, sourceType: input.sourceType, status: input.status ?? "pending", rowsIngested: Math.max(0, input.rowsIngested ?? 0), createdBy: user.id }).returning({ id: ingestionAttempts.id }));
  await audit(db, { organizationId: workspace.organizationId, workspaceId, actorId: user.id, action: WORKSPACE_AUDIT_ACTIONS.datasetConnected, resourceType: "ingestion_attempt", resourceId: String(id), metadata: { sourceType: input.sourceType, datasetName: input.datasetName } });
  return { id };
}

export async function removeWorkspaceMember(user: User, workspaceId: number, memberId: number) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  const target = await db.select({ id: workspaceMembers.id, role: workspaceMembers.role }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, workspaceId))).limit(1);
  if (!target[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace member not found." });
  if (!mayManageMember(actorRole, target[0].role as WorkspaceRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot remove this member." });
  await db.delete(workspaceMembers).where(eq(workspaceMembers.id, memberId));
  await audit(db, { organizationId: workspace.organizationId, workspaceId, actorId: user.id, action: "MEMBER_REMOVED", resourceType: "workspace_member", resourceId: String(memberId) });
  return { memberId };
}
