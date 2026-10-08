import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { datasetColumns, datasets, qualityChecks, qualityResults } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { checkDefinitionSchema, describeCheck, evaluateCheck, type CheckDefinition, type CheckSeverity } from "../shared/quality";
import type { Row } from "../shared/transformations";
import { loadAllDatasetRows } from "./datasetDb";
import { audit, datasetVisibleInWorkspace, extractInsertId, getWorkspaceContext, type Database } from "./workspaceDb";
import { mayManageQuality, mayReadChanges, OPS_AUDIT_ACTIONS } from "./workspaceContracts";
import { autoResolveIncident, checkKey, openOrRecurIncident, type Workspace } from "./incidentDb";

/**
 * Phase 7 — data quality. Checks live in quality_checks; every evaluation is a
 * quality_results row computed from the dataset's stored rows (reproducible).
 * Evaluations happen (a) on demand, and (b) automatically inside the transaction
 * of a successful run that OVERWRITES the dataset (the rows just written).
 * A fail/error opens or updates an incident; a pass resolves it.
 */

export type Trigger = { kind: "manual" } | { kind: "run"; runId: number } | { kind: "sync" };

/** Evaluate every enabled check of a dataset against the given rows. Call inside a transaction. */
export async function evaluateDatasetChecks(db: Database, workspace: Workspace, actorId: string, datasetId: number, rows: Row[], columns: string[], trigger: Trigger, onlyCheckIds?: number[]) {
  const checks = await db.select().from(qualityChecks).where(and(eq(qualityChecks.datasetId, datasetId), eq(qualityChecks.enabled, true), ...(onlyCheckIds ? [inArray(qualityChecks.id, onlyCheckIds)] : []))).orderBy(asc(qualityChecks.id));
  if (!checks.length) return [];
  const [dataset] = await db.select({ name: datasets.name }).from(datasets).where(eq(datasets.id, datasetId)).limit(1);
  const out: Array<{ checkId: number; resultId: number; status: string; failingRows: number }> = [];
  for (const check of checks) {
    const evaluation = evaluateCheck(check, rows, columns);
    const resultId = extractInsertId(await db.insert(qualityResults).values({
      checkId: check.id, datasetId, workspaceId: workspace.id, runId: trigger.kind === "run" ? trigger.runId : null, trigger: trigger.kind,
      status: evaluation.status, evaluatedRows: evaluation.evaluatedRows, failingRows: evaluation.failingRows, observed: evaluation.observed, evaluatedBy: actorId,
    }).returning({ id: qualityResults.id }));
    const description = describeCheck(check);
    if (evaluation.status === "pass") {
      await autoResolveIncident(db, workspace, actorId, checkKey(check.id), `Check passed (result #${resultId}).`, { resultId, runId: trigger.kind === "run" ? trigger.runId : null });
    } else {
      await openOrRecurIncident(db, workspace, actorId, {
        sourceType: "quality_check_failed", sourceKey: checkKey(check.id), severity: check.severity as CheckSeverity,
        title: `${evaluation.status === "error" ? "Check cannot run" : "Quality check failed"} on "${dataset?.name ?? `dataset #${datasetId}`}": ${description}`.slice(0, 200),
        detail: evaluation.observed.message, datasetId, qualityCheckId: check.id, resultId, runId: trigger.kind === "run" ? trigger.runId : null,
      });
    }
    out.push({ checkId: check.id, resultId, status: evaluation.status, failingRows: evaluation.failingRows });
  }
  await audit(db, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId, action: OPS_AUDIT_ACTIONS.checksEvaluated, resourceType: "dataset", resourceId: String(datasetId), metadata: { trigger: trigger.kind, runId: trigger.kind === "run" ? trigger.runId : null, results: out } });
  return out;
}

async function ownedDataset(db: Database, workspace: Workspace, datasetId: number) {
  const [dataset] = await db.select({ id: datasets.id, name: datasets.name, workspaceId: datasets.workspaceId }).from(datasets).where(and(eq(datasets.id, datasetId), datasetVisibleInWorkspace(workspace))).limit(1);
  if (!dataset) throw new TRPCError({ code: "NOT_FOUND", message: "Dataset not found in the active workspace." });
  if (dataset.workspaceId !== workspace.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Legacy registry datasets have no stored rows to check." });
  const columns = (await db.select({ name: datasetColumns.name }).from(datasetColumns).where(eq(datasetColumns.datasetId, dataset.id)).orderBy(asc(datasetColumns.id))).map(column => column.name);
  return { ...dataset, columns };
}

export async function createQualityCheck(user: User, input: { workspaceId: number; datasetId: number; severity: CheckSeverity; definition: CheckDefinition }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, input.workspaceId);
  if (!mayManageQuality(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners, admins and developers can define quality checks." });
  const definition = checkDefinitionSchema.parse(input.definition);
  const dataset = await ownedDataset(db, workspace, input.datasetId);
  if (definition.checkType !== "row_count" && !dataset.columns.includes(definition.columnName)) throw new TRPCError({ code: "BAD_REQUEST", message: `"${dataset.name}" has no column "${definition.columnName}".` });
  const rows = await loadAllDatasetRows(db, dataset.id);
  const checkId = await db.transaction(async tx => {
    const tdb = tx as unknown as Database;
    const id = extractInsertId(await tx.insert(qualityChecks).values({ organizationId: workspace.organizationId, workspaceId: workspace.id, datasetId: dataset.id, checkType: definition.checkType, columnName: definition.checkType === "row_count" ? null : definition.columnName, config: definition.config, severity: input.severity, createdBy: user.id }).returning({ id: qualityChecks.id }));
    await audit(tdb, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: OPS_AUDIT_ACTIONS.checkCreated, resourceType: "quality_check", resourceId: String(id), metadata: { datasetId: dataset.id, description: describeCheck(definition), severity: input.severity } });
    // Evaluate immediately so the new rule has a real result from the stored rows.
    await evaluateDatasetChecks(tdb, workspace, user.id, dataset.id, rows, dataset.columns, { kind: "manual" }, [id]);
    return id;
  });
  return { id: checkId };
}

export async function setQualityCheckEnabled(user: User, input: { workspaceId: number; checkId: number; enabled: boolean }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, input.workspaceId);
  if (!mayManageQuality(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners, admins and developers can change quality checks." });
  const updated = await db.update(qualityChecks).set({ enabled: input.enabled }).where(and(eq(qualityChecks.id, input.checkId), eq(qualityChecks.workspaceId, workspace.id))).returning({ id: qualityChecks.id });
  if (!updated[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Check not found in the active workspace." });
  await audit(db, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: OPS_AUDIT_ACTIONS.checkToggled, resourceType: "quality_check", resourceId: String(input.checkId), metadata: { enabled: input.enabled } });
  return { id: input.checkId, enabled: input.enabled };
}

export async function runQualityChecks(user: User, input: { workspaceId: number; datasetId: number }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, input.workspaceId);
  if (!mayManageQuality(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners, admins and developers can run quality checks." });
  const dataset = await ownedDataset(db, workspace, input.datasetId);
  const rows = await loadAllDatasetRows(db, dataset.id);
  const results = await db.transaction(async tx => evaluateDatasetChecks(tx as unknown as Database, workspace, user.id, dataset.id, rows, dataset.columns, { kind: "manual" }));
  if (!results.length) throw new TRPCError({ code: "BAD_REQUEST", message: `"${dataset.name}" has no enabled checks.` });
  return { datasetId: dataset.id, evaluatedRows: rows.length, results };
}

/** Checks with their latest result, per dataset (or the whole workspace). */
export async function listQualityChecks(user: User, workspaceId: number, datasetId?: number | null) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadChanges(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read quality checks in this workspace." });
  const checks = await db.select({ check: qualityChecks, datasetName: datasets.name }).from(qualityChecks).innerJoin(datasets, eq(qualityChecks.datasetId, datasets.id))
    .where(and(eq(qualityChecks.workspaceId, workspace.id), ...(datasetId ? [eq(qualityChecks.datasetId, datasetId)] : []))).orderBy(asc(datasets.name), asc(qualityChecks.id));
  const ids = checks.map(row => row.check.id);
  // Bounded: only the 10 newest results per check are loaded (history grows with every run), plus a count.
  const idList = sql.join(ids.map(id => sql`${id}`), sql`, `);
  const [results, totals] = ids.length ? await Promise.all([
    db.select().from(qualityResults).where(sql`${qualityResults.id} in (select id from (select id, row_number() over (partition by check_id order by id desc) as rn from public.quality_results where check_id in (${idList})) ranked where rn <= 10)`).orderBy(desc(qualityResults.id)),
    db.select({ checkId: qualityResults.checkId, total: count() }).from(qualityResults).where(inArray(qualityResults.checkId, ids)).groupBy(qualityResults.checkId),
  ]) : [[], []];
  const totalByCheck = new Map(totals.map(row => [row.checkId, Number(row.total)]));
  return checks.map(({ check, datasetName }) => {
    const own = results.filter(result => result.checkId === check.id);
    return { ...check, datasetName, description: describeCheck(check), latest: own[0] ?? null, history: own.slice(0, 10), evaluations: totalByCheck.get(check.id) ?? 0 };
  });
}

/** Workspace roll-up: counts only, from the latest result of each enabled check. */
export async function qualityOverview(user: User, workspaceId: number) {
  const checks = await listQualityChecks(user, workspaceId);
  const enabled = checks.filter(check => check.enabled);
  const latest = enabled.map(check => check.latest?.status ?? "never");
  const byDataset = new Map<number, { datasetId: number; datasetName: string; checks: number; passing: number; failing: number; errors: number; neverRun: number; lastEvaluatedAt: Date | null }>();
  for (const check of enabled) {
    const entry = byDataset.get(check.datasetId) ?? { datasetId: check.datasetId, datasetName: check.datasetName, checks: 0, passing: 0, failing: 0, errors: 0, neverRun: 0, lastEvaluatedAt: null };
    entry.checks += 1;
    const status = check.latest?.status;
    if (status === "pass") entry.passing += 1; else if (status === "fail") entry.failing += 1; else if (status === "error") entry.errors += 1; else entry.neverRun += 1;
    if (check.latest && (!entry.lastEvaluatedAt || check.latest.evaluatedAt > entry.lastEvaluatedAt)) entry.lastEvaluatedAt = check.latest.evaluatedAt;
    byDataset.set(check.datasetId, entry);
  }
  const evaluated = latest.filter(status => status !== "never").length;
  const passing = latest.filter(status => status === "pass").length;
  return {
    checks: enabled.length, evaluated, passing, failing: latest.filter(status => status === "fail").length, errors: latest.filter(status => status === "error").length,
    passRate: evaluated ? Math.round((passing / evaluated) * 1000) / 10 : null,
    datasets: Array.from(byDataset.values()),
  };
}
