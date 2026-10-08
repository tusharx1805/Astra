import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { auditLogs, datasetColumns, datasetConnections, datasets, datasetSources, ingestionAttempts } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { decryptConnectionPassword, encryptConnectionPassword, hasConnectionEncryptionKey } from "./connectionCrypto";
import { persistNewDataset, recordFailedImport, replaceDatasetContent } from "./datasetDb";
import { completenessScore, inferColumns } from "../shared/datasetProfile";
import { connectionTargetSchema, describeConnectorError, PG_SOURCE_TYPE, qualifiedName, SSL_MODES, type ConnectionTarget, type SslMode } from "../shared/pgConnector";
import { listSourceObjects, previewSourceObject, probeSource, readSourceObject, type ProbeResult, type SourceSnapshot } from "./pgClient";
import { evaluateDatasetChecks } from "./qualityDb";
import { audit, datasetVisibleInWorkspace, extractInsertId, getWorkspaceContext, type Database } from "./workspaceDb";
import { mayManageWorkspace } from "./workspacePermissions";
import { mayImportDataset } from "./workspaceContracts";

/**
 * Phase 9 — external PostgreSQL connections.
 * Source of truth: dataset_connections (credentials AES-256-GCM encrypted) and
 * dataset_sources (provenance of imported datasets). Every procedure authorizes the
 * caller against the workspace first; connection ids of other workspaces are NOT_FOUND.
 * Passwords are decrypted only inside this module, only to open a connection, and are
 * never returned, logged or written to audit metadata.
 */

export const CONNECTOR_AUDIT_ACTIONS = {
  draftTested: "PG_CONNECTION_DRAFT_TESTED",
  created: "DATASET_CONNECTION_CREATED",
  tested: "PG_CONNECTION_TESTED",
  deleted: "DATASET_CONNECTION_DELETED",
  previewed: "PG_OBJECT_PREVIEWED",
  refreshed: "DATASET_REFRESHED_FROM_SOURCE",
  refreshFailed: "DATASET_REFRESH_FAILED",
} as const;

type Context = Awaited<ReturnType<typeof getWorkspaceContext>>;
type ConnectionRecord = typeof datasetConnections.$inferSelect;

/** Owners/admins manage credentials; build roles (owner/admin/developer) may use saved connections. */
function requireManage(context: Context) {
  if (!mayManageWorkspace(context.actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners and admins can add, test new, or remove database connections." });
}
function requireUse(context: Context) {
  if (!mayImportDataset(context.actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners, admins and developers can use database connections." });
}

let sourcesTableReady = false;
/** dataset_sources arrives with the Phase 9 migration; fail with a clear instruction rather than a raw SQL error. */
async function requireSourcesTable(db: Database) {
  if (sourcesTableReady) return;
  const [row] = await db.execute<{ ok: boolean }>(sql`select to_regclass('public.dataset_sources') is not null as ok`) as unknown as Array<{ ok: boolean }>;
  if (!row?.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The Phase 9 database migration (dataset_sources) has not been applied yet. Run supabase/migrations/20261001000000_astra_phase9_postgres_sources.sql." });
  sourcesTableReady = true;
}

function normalizeSslMode(value: string): SslMode {
  if ((SSL_MODES as readonly string[]).includes(value)) return value as SslMode;
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This connection was saved with an unsupported SSL mode ("${value}"). Remove it and add it again.` });
}

function publicConnection(record: ConnectionRecord) {
  return { id: record.id, name: record.name, type: record.type, host: record.host, port: record.port, databaseName: record.databaseName, username: record.username, sslMode: record.sslMode, createdBy: record.createdBy, createdAt: record.createdAt };
}

async function ownedConnection(context: Context, connectionId: number) {
  const [record] = await context.db.select().from(datasetConnections).where(and(eq(datasetConnections.id, connectionId), eq(datasetConnections.workspaceId, context.workspace.id))).limit(1);
  if (!record) throw new TRPCError({ code: "NOT_FOUND", message: "Connection not found in the active workspace." });
  if (record.type !== "postgresql") throw new TRPCError({ code: "BAD_REQUEST", message: "Only PostgreSQL connections are supported." });
  return record;
}

function targetOf(record: ConnectionRecord): ConnectionTarget {
  if (!hasConnectionEncryptionKey()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "CONNECTION_ENCRYPTION_KEY is not configured on this server, so saved credentials cannot be used." });
  let password: string;
  try {
    password = decryptConnectionPassword(record.encryptedPassword);
  } catch {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The saved password cannot be decrypted with this server's CONNECTION_ENCRYPTION_KEY (was the key changed?). Remove the connection and add it again." });
  }
  return { host: record.host, port: record.port, databaseName: record.databaseName, username: record.username, password, sslMode: normalizeSslMode(record.sslMode) };
}

function describeTarget(target: Pick<ConnectionTarget, "host" | "port" | "databaseName" | "username" | "sslMode">) {
  return { host: target.host, port: target.port, databaseName: target.databaseName, username: target.username, sslMode: target.sslMode };
}

type ProbeOutcome = { ok: true; probe: ProbeResult; durationMs: number; warnings: string[] } | { ok: false; failure: ReturnType<typeof describeConnectorError>; durationMs: number };

export function probeWarnings(probe: ProbeResult): string[] {
  const warnings: string[] = [];
  if (probe.superuser) warnings.push(`"${probe.currentUser}" is a SUPERUSER. Astra only reads, but a leaked superuser password compromises the whole server — use a dedicated read-only role.`);
  else if (probe.writableTables > 0) warnings.push(`"${probe.currentUser}" can write to ${probe.writableTables} table${probe.writableTables === 1 ? "" : "s"}. Astra never writes (every session is READ ONLY), but a read-only role is the safer credential to store.`);
  if (probe.readableObjects === 0) warnings.push("This user cannot SELECT from any table or view, so there is nothing to import yet.");
  return warnings;
}

async function runProbe(target: ConnectionTarget): Promise<ProbeOutcome> {
  const started = Date.now();
  try {
    const probe = await probeSource(target);
    return { ok: true, probe, durationMs: Date.now() - started, warnings: probeWarnings(probe) };
  } catch (error) {
    const failure = describeConnectorError(error, [target.password]);
    console.warn("[Connector] probe failed", { kind: failure.kind, code: (error as { code?: string })?.code ?? null, host: target.host });
    return { ok: false, failure, durationMs: Date.now() - started };
  }
}

function sourceError(error: unknown, target: ConnectionTarget): never {
  if (error instanceof TRPCError) throw error;
  const failure = describeConnectorError(error, [target.password]);
  console.warn("[Connector] source operation failed", { kind: failure.kind, code: (error as { code?: string })?.code ?? null, host: target.host });
  throw new TRPCError({ code: failure.kind === "not_found" ? "NOT_FOUND" : "BAD_REQUEST", message: failure.message });
}

/** Test credentials typed into the "new connection" form. Nothing is stored except an audit line without secrets. */
export async function testDraftConnection(user: User, input: { workspaceId: number } & ConnectionTarget) {
  const context = await getWorkspaceContext(user, input.workspaceId);
  requireManage(context);
  const target = connectionTargetSchema.parse(input);
  const outcome = await runProbe(target);
  await audit(context.db, { organizationId: context.workspace.organizationId, workspaceId: context.workspace.id, actorId: user.id, action: CONNECTOR_AUDIT_ACTIONS.draftTested, resourceType: "dataset_connection", result: outcome.ok ? "success" : "failure", metadata: { ...describeTarget(target), ok: outcome.ok, failure: outcome.ok ? null : outcome.failure.kind, durationMs: outcome.durationMs } });
  return outcome;
}

/** Save a connection. Only after a live probe succeeds, and only with the encryption key present. */
export async function createConnection(user: User, input: { workspaceId: number; name: string } & ConnectionTarget) {
  const context = await getWorkspaceContext(user, input.workspaceId);
  requireManage(context);
  if (!hasConnectionEncryptionKey()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "CONNECTION_ENCRYPTION_KEY is not configured on this server. Astra will not store database passwords without it." });
  const target = connectionTargetSchema.parse(input);
  const name = input.name.trim();
  const clash = await context.db.select({ id: datasetConnections.id }).from(datasetConnections).where(and(eq(datasetConnections.workspaceId, context.workspace.id), sql`lower(${datasetConnections.name}) = lower(${name})`)).limit(1);
  if (clash[0]) throw new TRPCError({ code: "CONFLICT", message: `A connection named "${name}" already exists in this workspace.` });
  const outcome = await runProbe(target);
  if (!outcome.ok) {
    await audit(context.db, { organizationId: context.workspace.organizationId, workspaceId: context.workspace.id, actorId: user.id, action: CONNECTOR_AUDIT_ACTIONS.draftTested, resourceType: "dataset_connection", result: "failure", metadata: { ...describeTarget(target), ok: false, failure: outcome.failure.kind, durationMs: outcome.durationMs, onSave: true } });
    throw new TRPCError({ code: "BAD_REQUEST", message: `Not saved — the connection test failed. ${outcome.failure.message}` });
  }
  const id = await context.db.transaction(async tx => {
    const created = extractInsertId(await tx.insert(datasetConnections).values({ workspaceId: context.workspace.id, name, type: "postgresql", host: target.host, port: target.port, databaseName: target.databaseName, username: target.username, encryptedPassword: encryptConnectionPassword(target.password), sslMode: target.sslMode, createdBy: user.id }).returning({ id: datasetConnections.id }));
    await audit(tx as unknown as Database, { organizationId: context.workspace.organizationId, workspaceId: context.workspace.id, actorId: user.id, action: CONNECTOR_AUDIT_ACTIONS.created, resourceType: "dataset_connection", resourceId: String(created), metadata: { type: "postgresql", name, ...describeTarget(target), serverVersion: outcome.probe.serverVersion, superuser: outcome.probe.superuser, writableTables: outcome.probe.writableTables } });
    await audit(tx as unknown as Database, { organizationId: context.workspace.organizationId, workspaceId: context.workspace.id, actorId: user.id, action: CONNECTOR_AUDIT_ACTIONS.tested, resourceType: "dataset_connection", resourceId: String(created), metadata: { ok: true, durationMs: outcome.durationMs, serverVersion: outcome.probe.serverVersion, currentUser: outcome.probe.currentUser, superuser: outcome.probe.superuser, writableTables: outcome.probe.writableTables, readableObjects: outcome.probe.readableObjects } });
    return created;
  });
  return { id, name, ...describeTarget(target), probe: outcome.probe, warnings: outcome.warnings };
}

type TestMeta = { ok: boolean; failure?: string | null; message?: string | null; durationMs?: number; serverVersion?: string; currentUser?: string; superuser?: boolean; writableTables?: number; readableObjects?: number };

async function latestTests(db: Database, workspaceId: number, connectionIds: number[]) {
  if (!connectionIds.length) return new Map<number, { at: Date; meta: TestMeta }>();
  const rows = await db.select({ resourceId: auditLogs.resourceId, metadata: auditLogs.metadata, createdAt: auditLogs.createdAt }).from(auditLogs)
    .where(and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, CONNECTOR_AUDIT_ACTIONS.tested), inArray(auditLogs.resourceId, connectionIds.map(String))))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(500);
  const latest = new Map<number, { at: Date; meta: TestMeta }>();
  rows.forEach(row => { const id = Number(row.resourceId); if (!latest.has(id)) latest.set(id, { at: row.createdAt, meta: (row.metadata ?? { ok: false }) as TestMeta }); });
  return latest;
}

async function datasetCounts(db: Database, connectionIds: number[]) {
  const counts = new Map<number, number>();
  if (!connectionIds.length) return counts;
  try {
    await requireSourcesTable(db);
  } catch {
    return counts;
  }
  const rows = await db.select({ connectionId: datasetSources.connectionId, total: count() }).from(datasetSources).where(inArray(datasetSources.connectionId, connectionIds)).groupBy(datasetSources.connectionId);
  rows.forEach(row => { if (row.connectionId) counts.set(row.connectionId, Number(row.total)); });
  return counts;
}

export async function listConnections(user: User, workspaceId: number) {
  const context = await getWorkspaceContext(user, workspaceId);
  requireUse(context);
  const records = await context.db.select().from(datasetConnections).where(eq(datasetConnections.workspaceId, context.workspace.id)).orderBy(asc(datasetConnections.name));
  const ids = records.map(record => record.id);
  const [tests, counts] = await Promise.all([latestTests(context.db, context.workspace.id, ids), datasetCounts(context.db, ids)]);
  return {
    canManage: mayManageWorkspace(context.actorRole),
    encryptionReady: hasConnectionEncryptionKey(),
    connections: records.map(record => ({ ...publicConnection(record), lastTest: tests.get(record.id) ?? null, datasetCount: counts.get(record.id) ?? 0 })),
  };
}

export async function getConnection(user: User, workspaceId: number, connectionId: number) {
  const context = await getWorkspaceContext(user, workspaceId);
  requireUse(context);
  const record = await ownedConnection(context, connectionId);
  const tests = await latestTests(context.db, context.workspace.id, [record.id]);
  let imported: Array<{ datasetId: number; name: string; schema: string; table: string; rowCount: number; lastSyncedAt: Date; syncCount: number }> = [];
  try {
    await requireSourcesTable(context.db);
    imported = await context.db.select({ datasetId: datasetSources.datasetId, name: datasets.name, schema: datasetSources.sourceSchema, table: datasetSources.sourceTable, rowCount: datasets.rowCount, lastSyncedAt: datasetSources.lastSyncedAt, syncCount: datasetSources.syncCount })
      .from(datasetSources).innerJoin(datasets, eq(datasets.id, datasetSources.datasetId))
      .where(and(eq(datasetSources.connectionId, record.id), eq(datasetSources.workspaceId, context.workspace.id))).orderBy(asc(datasets.name));
  } catch { /* migration not applied: list stays empty, import will explain */ }
  return { ...publicConnection(record), lastTest: tests.get(record.id) ?? null, imported, canManage: mayManageWorkspace(context.actorRole), encryptionReady: hasConnectionEncryptionKey() };
}

/** Re-test a saved connection with its stored (encrypted) credentials. */
export async function testSavedConnection(user: User, workspaceId: number, connectionId: number) {
  const context = await getWorkspaceContext(user, workspaceId);
  requireUse(context);
  const record = await ownedConnection(context, connectionId);
  const outcome = await runProbe(targetOf(record));
  const meta: TestMeta = outcome.ok
    ? { ok: true, durationMs: outcome.durationMs, serverVersion: outcome.probe.serverVersion, currentUser: outcome.probe.currentUser, superuser: outcome.probe.superuser, writableTables: outcome.probe.writableTables, readableObjects: outcome.probe.readableObjects }
    : { ok: false, failure: outcome.failure.kind, message: outcome.failure.message, durationMs: outcome.durationMs };
  await audit(context.db, { organizationId: context.workspace.organizationId, workspaceId: context.workspace.id, actorId: user.id, action: CONNECTOR_AUDIT_ACTIONS.tested, resourceType: "dataset_connection", resourceId: String(record.id), result: outcome.ok ? "success" : "failure", metadata: meta });
  return outcome;
}

export async function deleteConnection(user: User, workspaceId: number, connectionId: number) {
  const context = await getWorkspaceContext(user, workspaceId);
  requireManage(context);
  const record = await ownedConnection(context, connectionId);
  await context.db.transaction(async tx => {
    await tx.delete(datasetConnections).where(eq(datasetConnections.id, record.id));
    await audit(tx as unknown as Database, { organizationId: context.workspace.organizationId, workspaceId: context.workspace.id, actorId: user.id, action: CONNECTOR_AUDIT_ACTIONS.deleted, resourceType: "dataset_connection", resourceId: String(record.id), metadata: { name: record.name, host: record.host, databaseName: record.databaseName } });
  });
  // Imported datasets keep their rows; dataset_sources.connection_id becomes NULL (they can no longer refresh).
  return { deleted: true as const, id: record.id };
}

export async function browseConnection(user: User, workspaceId: number, connectionId: number) {
  const context = await getWorkspaceContext(user, workspaceId);
  requireUse(context);
  const target = targetOf(await ownedConnection(context, connectionId));
  try {
    const result = await listSourceObjects(target);
    return { ...result, fetchedAt: new Date() };
  } catch (error) {
    sourceError(error, target);
  }
}

export async function previewConnectionObject(user: User, input: { workspaceId: number; connectionId: number; schema: string; table: string }) {
  const context = await getWorkspaceContext(user, input.workspaceId);
  requireUse(context);
  const record = await ownedConnection(context, input.connectionId);
  const target = targetOf(record);
  try {
    const preview = await previewSourceObject(target, input.schema, input.table);
    await audit(context.db, { organizationId: context.workspace.organizationId, workspaceId: context.workspace.id, actorId: user.id, action: CONNECTOR_AUDIT_ACTIONS.previewed, resourceType: "dataset_connection", resourceId: String(record.id), metadata: { schema: input.schema, table: input.table, rows: preview.rows.length } });
    return preview;
  } catch (error) {
    sourceError(error, target);
  }
}

/** Import a table/view through the Phase 1 dataset path, and record where it came from. */
export async function importConnectionObject(user: User, input: { workspaceId: number; connectionId: number; schema: string; table: string; datasetName: string }) {
  const context = await getWorkspaceContext(user, input.workspaceId);
  requireUse(context);
  await requireSourcesTable(context.db);
  const record = await ownedConnection(context, input.connectionId);
  const name = input.datasetName.trim();
  const { db, workspace } = context;
  const existing = await db.select({ id: datasets.id }).from(datasets).where(and(eq(datasets.workspaceId, workspace.id), eq(datasets.name, name))).limit(1);
  if (existing[0]) throw new TRPCError({ code: "CONFLICT", message: `A dataset named "${name}" already exists in this workspace.` });
  const target = targetOf(record);
  const object = qualifiedName(input.schema, input.table);
  let snapshot: SourceSnapshot;
  try {
    snapshot = await readSourceObject(target, input.schema, input.table);
  } catch (error) {
    const failure = describeConnectorError(error, [target.password]);
    await recordFailedImport(db, { organizationId: workspace.organizationId, workspaceId: workspace.id, userId: user.id, name, sourceType: PG_SOURCE_TYPE, reason: failure.message, metadata: { connectionId: record.id, object, failure: failure.kind } });
    sourceError(error, target);
  }
  return {
    ...(await persistNewDataset(db, { workspace, userId: user.id }, {
      name, sourceType: PG_SOURCE_TYPE, columnOrder: snapshot.columns, rows: snapshot.rows,
      auditMetadata: { connectionId: record.id, connectionName: record.name, object, kind: snapshot.kind, orderedBy: snapshot.primaryKey },
      afterInsert: async (tx, datasetId) => {
        await tx.insert(datasetSources).values({ datasetId, workspaceId: workspace.id, connectionId: record.id, sourceSchema: input.schema, sourceTable: input.table, sourceKind: snapshot.kind, orderColumns: snapshot.primaryKey, lastSyncedBy: user.id, lastSyncRows: snapshot.rows.length, syncCount: 1 });
      },
    })),
    object, orderedBy: snapshot.primaryKey,
  };
}

/** Provenance for the dataset page. Only queried for PostgreSQL datasets so Phase 1–8 pages never depend on this table. */
export async function getDatasetSource(db: Database, datasetId: number) {
  try {
    await requireSourcesTable(db);
  } catch {
    return { available: false as const, reason: "migration" as const };
  }
  const [row] = await db.select({ source: datasetSources, connectionName: datasetConnections.name, host: datasetConnections.host, databaseName: datasetConnections.databaseName })
    .from(datasetSources).leftJoin(datasetConnections, eq(datasetConnections.id, datasetSources.connectionId)).where(eq(datasetSources.datasetId, datasetId)).limit(1);
  if (!row) return { available: false as const, reason: "untracked" as const };
  return {
    available: true as const,
    connectionId: row.source.connectionId,
    connectionName: row.connectionName,
    host: row.host,
    databaseName: row.databaseName,
    schema: row.source.sourceSchema,
    table: row.source.sourceTable,
    object: qualifiedName(row.source.sourceSchema, row.source.sourceTable),
    kind: row.source.sourceKind,
    orderedBy: (row.source.orderColumns ?? []) as string[],
    lastSyncedAt: row.source.lastSyncedAt,
    lastSyncRows: row.source.lastSyncRows,
    syncCount: row.source.syncCount,
  };
}

/**
 * Re-read the source object and replace the dataset's rows in one transaction.
 * Quality checks re-run on the new rows (trigger 'sync'); column changes are reported.
 */
export async function refreshDatasetFromSource(user: User, workspaceId: number, datasetId: number) {
  const context = await getWorkspaceContext(user, workspaceId);
  requireUse(context);
  await requireSourcesTable(context.db);
  const { db, workspace } = context;
  const [dataset] = await db.select().from(datasets).where(and(eq(datasets.id, datasetId), datasetVisibleInWorkspace(workspace))).limit(1);
  if (!dataset || dataset.workspaceId !== workspace.id) throw new TRPCError({ code: "NOT_FOUND", message: "Dataset not found in the active workspace." });
  const [source] = await db.select().from(datasetSources).where(eq(datasetSources.datasetId, dataset.id)).limit(1);
  if (!source) throw new TRPCError({ code: "BAD_REQUEST", message: "This dataset was not imported from a database connection, so it has no source to refresh from." });
  if (!source.connectionId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The connection this dataset was imported from has been removed. Add the connection again and re-import." });
  const record = await ownedConnection(context, source.connectionId);
  const target = targetOf(record);
  const object = qualifiedName(source.sourceSchema, source.sourceTable);
  let snapshot: SourceSnapshot;
  try {
    snapshot = await readSourceObject(target, source.sourceSchema, source.sourceTable);
  } catch (error) {
    const failure = describeConnectorError(error, [target.password]);
    try {
      await db.insert(ingestionAttempts).values({ workspaceId: workspace.id, datasetName: dataset.name, sourceType: PG_SOURCE_TYPE, status: "failed", rowsIngested: 0, createdBy: user.id });
      await audit(db, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: CONNECTOR_AUDIT_ACTIONS.refreshFailed, resourceType: "dataset", resourceId: String(dataset.id), result: "failure", metadata: { connectionId: record.id, object, failure: failure.kind, reason: failure.message } });
    } catch (logError) {
      console.warn("[Connector] could not record failed refresh", logError);
    }
    sourceError(error, target);
  }
  const previousColumns = (await db.select({ name: datasetColumns.name }).from(datasetColumns).where(eq(datasetColumns.datasetId, dataset.id)).orderBy(asc(datasetColumns.id))).map(column => column.name);
  const added = snapshot.columns.filter(name => !previousColumns.includes(name));
  const removed = previousColumns.filter(name => !snapshot.columns.includes(name));
  const columns = inferColumns(snapshot.rows, snapshot.columns);
  const qualityScore = completenessScore(snapshot.rows, snapshot.columns);
  const result = await db.transaction(async tx => {
    const tdb = tx as unknown as Database;
    await tx.select({ id: datasets.id }).from(datasets).where(eq(datasets.id, dataset.id)).for("update");
    await replaceDatasetContent(tdb, dataset.id, columns, snapshot.rows, qualityScore);
    await tx.update(datasetSources).set({ lastSyncedAt: sql`clock_timestamp()`, lastSyncedBy: user.id, lastSyncRows: snapshot.rows.length, syncCount: sql`${datasetSources.syncCount} + 1`, sourceKind: snapshot.kind, orderColumns: snapshot.primaryKey }).where(eq(datasetSources.datasetId, dataset.id));
    await tx.insert(ingestionAttempts).values({ workspaceId: workspace.id, datasetName: dataset.name, sourceType: PG_SOURCE_TYPE, status: "complete", rowsIngested: snapshot.rows.length, createdBy: user.id });
    await audit(tdb, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: CONNECTOR_AUDIT_ACTIONS.refreshed, resourceType: "dataset", resourceId: String(dataset.id), metadata: { connectionId: record.id, object, rowsBefore: dataset.rowCount, rowsAfter: snapshot.rows.length, columnsAdded: added, columnsRemoved: removed } });
    const checks = await evaluateDatasetChecks(tdb, workspace, user.id, dataset.id, snapshot.rows, snapshot.columns, { kind: "sync" });
    return { checks };
  });
  return { datasetId: dataset.id, object, rowsBefore: dataset.rowCount, rowsAfter: snapshot.rows.length, columnsAdded: added, columnsRemoved: removed, qualityScore, checks: result.checks };
}

