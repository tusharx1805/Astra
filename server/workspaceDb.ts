import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
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
  users,
  workspaceDataEnvironment,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
  type User,
} from "../drizzle/schema";
import { getDb } from "./db";
import { mayAssignWorkspaceRole, mayInviteWorkspaceMember, mayManageMember, mayManageWorkspace, mayUpdateWorkspaceEnvironment, type WorkspaceRole } from "./workspacePermissions";
import { mayCreateSavedQuery, mayRunSavedQuery, WORKSPACE_AUDIT_ACTIONS } from "./workspaceContracts";
import { buildEncryptedConnectionMetadata } from "./fixtureConnection";

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;

function extractInsertId(result: unknown): number {
  const first = Array.isArray(result) ? result[0] : result;
  const insertId = (first as { insertId?: number } | undefined)?.insertId;
  if (!insertId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Unable to create the workspace resource." });
  return Number(insertId);
}

async function database(): Promise<Database> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Workspace storage is unavailable." });
  return db;
}

function workspaceSlug(user: User) {
  return `workspace-org-${user.id}`.slice(0, 80);
}

export async function ensureOrganizationForUser(user: User) {
  const db = await database();
  if (user.organizationId) return user.organizationId;

  const existing = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, workspaceSlug(user))).limit(1);
  const organizationId = existing[0]?.id ?? extractInsertId(await db.insert(organizations).values({
    name: `${user.name ?? "ASTRA"} Organization`,
    slug: workspaceSlug(user),
  }));
  await db.update(users).set({ organizationId }).where(eq(users.id, user.id));
  await db.insert(organizationMembers).values({ organizationId, userId: user.id, role: user.role }).onDuplicateKeyUpdate({ set: { role: user.role } });
  return organizationId;
}

export async function createWorkspacePostgresConnection(user: User, input: { workspaceId: number; name: string; host: string; port: number; databaseName: string; username: string; password: string; sslMode: string; }) {
  const metadata = buildEncryptedConnectionMetadata(input);
  if (!metadata.persisted) return metadata;
  const db = await database();
  const organizationId = await ensureOrganizationForUser(user);
  const inserted = await db.insert(datasetConnections).values({ ...metadata.record, createdBy: user.id });
  const id = extractInsertId(inserted);
  await audit(db, { organizationId, workspaceId: input.workspaceId, actorId: user.id, action: "DATASET_CONNECTION_CREATED", resourceType: "dataset_connection", resourceId: String(id), metadata: { type: "postgresql", host: input.host, databaseName: input.databaseName, username: input.username, sslMode: input.sslMode } });
  return { persisted: true as const, id, name: input.name, type: "postgresql", host: input.host, port: input.port, databaseName: input.databaseName, username: input.username, sslMode: input.sslMode };
}

async function audit(db: Database, values: {
  organizationId: number;
  workspaceId: number;
  actorId: number;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(auditLogs).values({
    ...values,
    resourceId: values.resourceId ?? null,
    result: "success",
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

async function getWorkspaceContext(user: User, workspaceId: number) {
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
  const workspaceId = extractInsertId(await db.insert(workspaces).values({
    organizationId,
    name: input.name,
    description: input.description || null,
    createdBy: user.id,
  }));
  await db.insert(workspaceMembers).values({ workspaceId, userId: user.id, role: "owner" });
  await audit(db, { organizationId, workspaceId, actorId: user.id, action: "WORKSPACE_CREATED", resourceType: "workspace", resourceId: String(workspaceId), metadata: { name: input.name } });
  return { id: workspaceId, organizationId, name: input.name, role: "owner" as const };
}

export async function getWorkspaceOverview(user: User, workspaceId: number) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  const [members, invitations, technologies] = await Promise.all([
    db.select({ id: workspaceMembers.id, userId: users.id, name: users.name, email: users.email, role: workspaceMembers.role, joinedAt: workspaceMembers.joinedAt })
      .from(workspaceMembers).innerJoin(users, eq(workspaceMembers.userId, users.id)).where(eq(workspaceMembers.workspaceId, workspaceId)),
    db.select({ id: workspaceInvitations.id, email: workspaceInvitations.email, role: workspaceInvitations.role, status: workspaceInvitations.status, createdAt: workspaceInvitations.createdAt, expiresAt: workspaceInvitations.expiresAt })
      .from(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, workspaceId)),
    db.select({ id: workspaceDataEnvironment.id, technology: workspaceDataEnvironment.technology })
      .from(workspaceDataEnvironment).where(eq(workspaceDataEnvironment.workspaceId, workspaceId)),
  ]);
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
  const existing = await db.select({ id: users.id }).from(workspaceMembers).innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(users.email, input.email))).limit(1);
  if (existing[0]) throw new TRPCError({ code: "CONFLICT", message: "This person is already a workspace member." });
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.insert(workspaceInvitations).values({ workspaceId, email: input.email, role: input.role, invitedBy: user.id, status: "pending", expiresAt })
    .onDuplicateKeyUpdate({ set: { role: input.role, invitedBy: user.id, status: "pending", expiresAt } });
  await audit(db, { organizationId: workspace.organizationId, workspaceId, actorId: user.id, action: "MEMBER_INVITED", resourceType: "workspace_invitation", resourceId: input.email, metadata: { role: input.role } });
  return { email: input.email, role: input.role, status: "pending" as const, expiresAt };
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
    db.select({ id: datasets.id, name: datasets.name, sourceType: datasets.sourceType, qualityScore: datasets.qualityScore, projectId: datasets.projectId }).from(datasets)
      .where(eq(datasets.organizationId, workspace.organizationId)),
    db.select({ id: pipelines.id, name: pipelines.name, status: pipelines.status, projectId: pipelines.projectId }).from(pipelines)
      .where(eq(pipelines.organizationId, workspace.organizationId)),
  ]);
  return { projects: projectRows, datasets: datasetRows, pipelines: pipelineRows };
}

export async function searchWorkspaceEntities(user: User, workspaceId: number, query: string) {
  const { db, workspace } = await getWorkspaceContext(user, workspaceId);
  const needle = `%${query.replace(/[\\%_]/g, "\\\\$&").slice(0, 120)}%`;
  const [projectRows, datasetRows, pipelineRows, savedQueryRows] = await Promise.all([
    // Workspace membership is checked before this query; organization scope then follows the same server/RLS boundary as other resources.
    db.select({ id: projects.id, name: projects.name, description: projects.description }).from(projects)
      .where(and(eq(projects.organizationId, workspace.organizationId), or(like(projects.name, needle), like(projects.description, needle)))).limit(25),
    db.select({ id: datasets.id, name: datasets.name, sourceType: datasets.sourceType }).from(datasets)
      .where(and(eq(datasets.organizationId, workspace.organizationId), like(datasets.name, needle))).limit(25),
    db.select({ id: pipelines.id, name: pipelines.name, status: pipelines.status }).from(pipelines)
      .where(and(eq(pipelines.organizationId, workspace.organizationId), like(pipelines.name, needle))).limit(25),
    db.select({ id: savedQueries.id, name: savedQueries.name, datasetId: savedQueries.datasetId }).from(savedQueries)
      .where(and(eq(savedQueries.workspaceId, workspaceId), like(savedQueries.name, needle))).limit(25),
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
  const entity = await db.select({ id: table.id }).from(table).where(and(eq(table.id, entityId), eq(table.organizationId, workspace.organizationId))).limit(1);
  if (!entity[0]) throw new TRPCError({ code: "FORBIDDEN", message: "That resource is outside the active workspace." });
  await db.insert(recentlyViewed).values({ userId: user.id, workspaceId, entityType: input.entityType, entityId: input.entityId, entityLabel: input.entityLabel, viewedAt: new Date() }).onDuplicateKeyUpdate({ set: { entityLabel: input.entityLabel, viewedAt: new Date() } });
  return { success: true } as const;
}

export async function listRecentViews(user: User, workspaceId: number) {
  const { db } = await getWorkspaceContext(user, workspaceId);
  return db.select({ id: recentlyViewed.id, entityType: recentlyViewed.entityType, entityId: recentlyViewed.entityId, entityLabel: recentlyViewed.entityLabel, viewedAt: recentlyViewed.viewedAt }).from(recentlyViewed).where(and(eq(recentlyViewed.userId, user.id), eq(recentlyViewed.workspaceId, workspaceId))).orderBy(desc(recentlyViewed.viewedAt)).limit(20);
}

export async function listSavedQueries(user: User, workspaceId: number) {
  const { db } = await getWorkspaceContext(user, workspaceId);
  return db.select({ id: savedQueries.id, name: savedQueries.name, sqlText: savedQueries.sqlText, datasetId: savedQueries.datasetId, datasetName: datasets.name, sourceType: datasets.sourceType, createdAt: savedQueries.createdAt }).from(savedQueries).innerJoin(datasets, eq(savedQueries.datasetId, datasets.id)).where(and(eq(savedQueries.workspaceId, workspaceId), eq(datasets.organizationId, (await getWorkspaceContext(user, workspaceId)).workspace.organizationId))).orderBy(desc(savedQueries.createdAt));
}

export async function createSavedQuery(user: User, workspaceId: number, input: { datasetId: number; name: string; sqlText: string }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayCreateSavedQuery(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace build roles can save queries." });
  const dataset = await db.select({ id: datasets.id, sourceType: datasets.sourceType }).from(datasets).where(and(eq(datasets.id, input.datasetId), eq(datasets.organizationId, workspace.organizationId))).limit(1);
  if (!dataset[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Dataset not found in this workspace." });
  if (dataset[0].sourceType !== "CSV / Files") throw new TRPCError({ code: "BAD_REQUEST", message: "Saved queries are available for CSV / Files datasets only." });
  const id = extractInsertId(await db.insert(savedQueries).values({ workspaceId, datasetId: input.datasetId, createdBy: user.id, name: input.name, sqlText: input.sqlText }));
  await audit(db, { organizationId: workspace.organizationId, workspaceId, actorId: user.id, action: WORKSPACE_AUDIT_ACTIONS.savedQueryCreated, resourceType: "saved_query", resourceId: String(id), metadata: { datasetId: input.datasetId, name: input.name } });
  return { id, name: input.name };
}

export async function recordQueryRun(user: User, workspaceId: number, input: { queryId: number; rowCount: number; durationMs: number }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayRunSavedQuery(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot run saved queries in this workspace." });
  const query = await db.select({ id: savedQueries.id }).from(savedQueries).where(and(eq(savedQueries.id, input.queryId), eq(savedQueries.workspaceId, workspaceId))).limit(1);
  if (!query[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Saved query not found in this workspace." });
  const id = extractInsertId(await db.insert(queryRuns).values({ queryId: input.queryId, workspaceId, runBy: user.id, rowCount: Math.max(0, input.rowCount), durationMs: Math.max(0, input.durationMs) }));
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
  const id = extractInsertId(await db.insert(ingestionAttempts).values({ workspaceId, datasetName: input.datasetName, sourceType: input.sourceType, status: input.status ?? "pending", rowsIngested: Math.max(0, input.rowsIngested ?? 0), createdBy: user.id }));
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
