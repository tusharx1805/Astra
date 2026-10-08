import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { datasetColumns, datasetRows, datasets, ingestionAttempts } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { completenessScore, computeColumnStats, CsvParseError, DATASET_LIMITS, inferColumns, parseCsvDataset, type ColumnProfile } from "../shared/datasetProfile";
import type { Row } from "../shared/transformations";
import { audit, datasetVisibleInWorkspace, extractInsertId, getWorkspaceContext, type Database } from "./workspaceDb";
import { DATASET_AUDIT_ACTIONS, mayImportDataset, mayReadDataset } from "./workspaceContracts";

/**
 * Phase 1 — Real Dataset.
 * Source of truth: datasets + dataset_columns + dataset_rows (Supabase Postgres via Drizzle).
 * Every function authorizes the caller against the workspace before touching data.
 */

export const CSV_SOURCE_TYPE = "CSV / Files";
const ROW_INSERT_CHUNK = 500;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

type ImportInput = { workspaceId: number; name: string; csvText: string; fileName?: string };

function toColumnRecord(datasetId: number, column: ColumnProfile) {
  return { datasetId, name: column.name, dataType: column.dataType, nullable: column.nullable, uniqueValues: column.uniqueValues, nullPercent: column.nullPercent };
}

/** Insert column metadata and rows (chunked, rowIndex 0..n-1) for a dataset. Callers own the transaction. */
export async function writeDatasetContent(db: Database, datasetId: number, columns: ColumnProfile[], rows: Row[]) {
  if (columns.length) await db.insert(datasetColumns).values(columns.map(column => toColumnRecord(datasetId, column)));
  for (let start = 0; start < rows.length; start += ROW_INSERT_CHUNK) {
    const chunk = rows.slice(start, start + ROW_INSERT_CHUNK);
    await db.insert(datasetRows).values(chunk.map((row, offset) => ({ datasetId, rowIndex: start + offset, data: row })));
  }
}

/** Replace a dataset's columns, rows, row_count and quality_score in place. Callers own the transaction. */
export async function replaceDatasetContent(db: Database, datasetId: number, columns: ColumnProfile[], rows: Row[], qualityScore: number) {
  await db.delete(datasetRows).where(eq(datasetRows.datasetId, datasetId));
  await db.delete(datasetColumns).where(eq(datasetColumns.datasetId, datasetId));
  await writeDatasetContent(db, datasetId, columns, rows);
  await db.update(datasets).set({ rowCount: rows.length, qualityScore }).where(eq(datasets.id, datasetId));
}

function fromColumnRecord(record: typeof datasetColumns.$inferSelect): ColumnProfile {
  return { name: record.name, dataType: record.dataType as ColumnProfile["dataType"], nullable: record.nullable, uniqueValues: record.uniqueValues, nullPercent: record.nullPercent };
}

/** jsonb comes back as an object; tolerate a string payload defensively. */
function parseRowData(value: unknown): Row {
  if (typeof value === "string") {
    try { return JSON.parse(value) as Row; } catch { return {}; }
  }
  return (value ?? {}) as Row;
}

export function isDuplicateKey(error: unknown) {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505"; // Postgres unique_violation
}

export async function recordFailedImport(db: Database, context: { organizationId: number; workspaceId: number; userId: string; name: string; reason: string; sourceType?: string; metadata?: Record<string, unknown> }) {
  // Failure records are best-effort: they must never mask the original error.
  try {
    await db.insert(ingestionAttempts).values({ workspaceId: context.workspaceId, datasetName: context.name.slice(0, 160), sourceType: context.sourceType ?? CSV_SOURCE_TYPE, status: "failed", rowsIngested: 0, createdBy: context.userId });
    await audit(db, { organizationId: context.organizationId, workspaceId: context.workspaceId, actorId: context.userId, action: DATASET_AUDIT_ACTIONS.importFailed, resourceType: "dataset", metadata: { name: context.name, sourceType: context.sourceType ?? CSV_SOURCE_TYPE, reason: context.reason.slice(0, 300), ...context.metadata } });
  } catch (error) {
    console.warn("[Dataset] Could not record failed import", error);
  }
}

/**
 * Parse, validate and persist a CSV dataset in one transaction:
 * dataset record → column metadata → rows (chunked) → ingestion attempt → audit.
 * Nothing is committed unless every step succeeds.
 */
export async function importCsvDataset(user: User, input: ImportInput) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, input.workspaceId);
  if (!mayImportDataset(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners, admins and developers can import datasets." });
  const name = input.name.trim();

  let parsed: ReturnType<typeof parseCsvDataset>;
  try {
    parsed = parseCsvDataset(input.csvText);
  } catch (error) {
    const message = error instanceof CsvParseError ? error.message : "The CSV file could not be parsed.";
    await recordFailedImport(db, { organizationId: workspace.organizationId, workspaceId: workspace.id, userId: user.id, name, reason: message });
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }

  const existing = await db.select({ id: datasets.id }).from(datasets).where(and(eq(datasets.workspaceId, workspace.id), eq(datasets.name, name))).limit(1);
  if (existing[0]) throw new TRPCError({ code: "CONFLICT", message: `A dataset named "${name}" already exists in this workspace.` });

  return persistNewDataset(db, { workspace, userId: user.id }, {
    name, sourceType: CSV_SOURCE_TYPE, columnOrder: parsed.columns, rows: parsed.rows,
    auditMetadata: { fileName: input.fileName ?? null },
  });
}

/**
 * The one write path for a NEW dataset (Phase 1), shared by CSV upload and the
 * PostgreSQL connector (Phase 9): dataset record → column metadata → rows →
 * ingestion attempt → audit (+ optional extra writes), all in one transaction.
 */
export async function persistNewDataset(db: Database, context: { workspace: { id: number; organizationId: number }; userId: string }, input: {
  name: string; sourceType: string; columnOrder: string[]; rows: Row[];
  auditMetadata?: Record<string, unknown>;
  afterInsert?: (tx: Database, datasetId: number) => Promise<void>;
}) {
  const { workspace, userId } = context;
  const { name, rows } = input;
  const columns = inferColumns(rows, input.columnOrder);
  const qualityScore = completenessScore(rows, input.columnOrder);
  try {
    const datasetId = await db.transaction(async tx => {
      const tdb = tx as unknown as Database;
      const id = extractInsertId(await tx.insert(datasets).values({
        organizationId: workspace.organizationId,
        workspaceId: workspace.id,
        projectId: null,
        name,
        ownerId: userId,
        sourceType: input.sourceType,
        qualityScore,
        rowCount: rows.length,
      }).returning({ id: datasets.id }));
      await writeDatasetContent(tdb, id, columns, rows);
      if (input.afterInsert) await input.afterInsert(tdb, id);
      await tx.insert(ingestionAttempts).values({ workspaceId: workspace.id, datasetName: name, sourceType: input.sourceType, status: "complete", rowsIngested: rows.length, createdBy: userId });
      await audit(tdb, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: userId, action: DATASET_AUDIT_ACTIONS.imported, resourceType: "dataset", resourceId: String(id), metadata: { name, sourceType: input.sourceType, rows: rows.length, columns: columns.length, ...input.auditMetadata } });
      return id;
    });
    return { id: datasetId, name, rowCount: rows.length, columnCount: columns.length, qualityScore, sourceType: input.sourceType };
  } catch (error) {
    if (isDuplicateKey(error)) throw new TRPCError({ code: "CONFLICT", message: `A dataset named "${name}" already exists in this workspace.` });
    await recordFailedImport(db, { organizationId: workspace.organizationId, workspaceId: workspace.id, userId, name, sourceType: input.sourceType, reason: error instanceof Error ? error.message : "Database write failed" });
    console.error("[Dataset] Import transaction failed", error);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The dataset could not be saved. Nothing was imported." });
  }
}

async function authorizedDataset(user: User, workspaceId: number, datasetId: number) {
  const context = await getWorkspaceContext(user, workspaceId);
  if (!mayReadDataset(context.actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read datasets in this workspace." });
  const rows = await context.db.select().from(datasets).where(and(eq(datasets.id, datasetId), datasetVisibleInWorkspace(context.workspace))).limit(1);
  // NOT_FOUND (not FORBIDDEN) so dataset ids in other workspaces are not disclosed.
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Dataset not found in the active workspace." });
  return { ...context, dataset: rows[0] };
}

export async function listDatasets(user: User, workspaceId: number) {
  const { db, workspace } = await getWorkspaceContext(user, workspaceId);
  const records = await db.select({ id: datasets.id, name: datasets.name, sourceType: datasets.sourceType, qualityScore: datasets.qualityScore, rowCount: datasets.rowCount, workspaceId: datasets.workspaceId, projectId: datasets.projectId, createdAt: datasets.createdAt })
    .from(datasets).where(datasetVisibleInWorkspace(workspace)).orderBy(desc(datasets.createdAt));
  const columnCounts = records.length
    ? await db.select({ datasetId: datasetColumns.datasetId, total: count() }).from(datasetColumns).where(inArray(datasetColumns.datasetId, records.map(record => record.id))).groupBy(datasetColumns.datasetId)
    : [];
  const byDataset = new Map(columnCounts.map(item => [item.datasetId, Number(item.total)]));
  return records.map(record => ({ ...record, columnCount: byDataset.get(record.id) ?? 0, persisted: record.workspaceId !== null }));
}

export async function getDataset(user: User, workspaceId: number, datasetId: number) {
  const { db, dataset } = await authorizedDataset(user, workspaceId, datasetId);
  const columns = await db.select().from(datasetColumns).where(eq(datasetColumns.datasetId, dataset.id)).orderBy(asc(datasetColumns.id));
  return {
    id: dataset.id,
    name: dataset.name,
    sourceType: dataset.sourceType,
    qualityScore: dataset.qualityScore,
    rowCount: dataset.rowCount,
    projectId: dataset.projectId,
    workspaceId: dataset.workspaceId,
    ownerId: dataset.ownerId,
    createdAt: dataset.createdAt,
    columns: columns.map(fromColumnRecord),
  };
}

export async function getDatasetRows(user: User, workspaceId: number, datasetId: number, page: { offset?: number; limit?: number } = {}) {
  const { db, dataset } = await authorizedDataset(user, workspaceId, datasetId);
  const offset = Math.max(0, page.offset ?? 0);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, page.limit ?? DEFAULT_PAGE_SIZE));
  // rowIndex is contiguous from 0, so a range scan on the unique (datasetId,rowIndex) index is exact.
  const records = await db.select({ rowIndex: datasetRows.rowIndex, data: datasetRows.data }).from(datasetRows)
    .where(and(eq(datasetRows.datasetId, dataset.id), gte(datasetRows.rowIndex, offset), lt(datasetRows.rowIndex, offset + limit)))
    .orderBy(asc(datasetRows.rowIndex));
  return { datasetId: dataset.id, offset, limit, total: dataset.rowCount, rows: records.map(record => ({ rowIndex: record.rowIndex, data: parseRowData(record.data) })) };
}

/** Load every persisted row (bounded by the import limit). Used by stats and, later, pipeline execution. */
export async function loadAllDatasetRows(db: Database, datasetId: number): Promise<Row[]> {
  const records = await db.select({ data: datasetRows.data }).from(datasetRows).where(eq(datasetRows.datasetId, datasetId)).orderBy(asc(datasetRows.rowIndex)).limit(DATASET_LIMITS.maxRows);
  return records.map(record => parseRowData(record.data));
}

export async function getDatasetStats(user: User, workspaceId: number, datasetId: number) {
  const { db, dataset } = await authorizedDataset(user, workspaceId, datasetId);
  const columnRecords = await db.select().from(datasetColumns).where(eq(datasetColumns.datasetId, dataset.id)).orderBy(asc(datasetColumns.id));
  const rows = await loadAllDatasetRows(db, dataset.id);
  return { datasetId: dataset.id, rowCount: rows.length, columns: computeColumnStats(rows, columnRecords.map(fromColumnRecord)) };
}
