import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { datasetColumns, datasets, pipelineRuns, pipelineSteps, pipelines } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { completenessScore, inferColumns } from "../shared/datasetProfile";
import { columnsAfterSteps, describeStep, fromStepRecord, validatePipelineSteps } from "../shared/pipelineDefinition";
import { ACTIVE_RUN_STATUSES, emptyRunLog, parseRunLog, RUN_SAMPLE_ROWS, RUN_STALE_AFTER_MS, type PipelineHealth, type RunLog } from "../shared/pipelineRun";
import { applyTransformStep, type Row, type TransformStep } from "../shared/transformations";
import { loadAllDatasetRows, replaceDatasetContent, writeDatasetContent } from "./datasetDb";
import { audit, datasetVisibleInWorkspace, extractInsertId, getWorkspaceContext, pipelineVisibleInWorkspace, type Database } from "./workspaceDb";
import { mayReadPipeline, mayRunPipeline, PIPELINE_RUN_AUDIT_ACTIONS } from "./workspaceContracts";
import { recordRunFailure, recordRunSuccess } from "./incidentDb";
import { evaluateDatasetChecks } from "./qualityDb";

/**
 * Phase 3 — Real Pipeline Run.
 * Source of truth: pipeline_runs. Execution happens here, on the server, against
 * rows loaded from dataset_rows, using the unchanged transformation engine.
 * See shared/pipelineRun.ts for the lifecycle and transaction boundaries.
 */

export const PIPELINE_OUTPUT_SOURCE_TYPE = "Pipeline output";
const INTERRUPTED_MESSAGE = "Interrupted: the server stopped before this run finished. Nothing was written. Start a new run.";
const WRITE_FAILED_MESSAGE = "The transformation finished but its output could not be saved, so nothing was written. Try again; if it keeps failing, check the database connection.";

type Workspace = { id: number; organizationId: number };

/** An expected, user-meaningful failure. Its message is stored on the run as-is. */
class RunFailure extends Error {}

// ---------------------------------------------------------------- housekeeping

async function refreshPipelineHealth(db: Database, pipelineId: number, health: PipelineHealth) {
  const [totals] = await db.select({
    finished: count(),
    successes: sql<number>`count(*) filter (where ${pipelineRuns.status} = 'success')`,
    failures: sql<number>`count(*) filter (where ${pipelineRuns.status} = 'failed')`,
    avgMs: sql<number | null>`avg(${pipelineRuns.durationMs}) filter (where ${pipelineRuns.status} = 'success')`,
  }).from(pipelineRuns).where(and(eq(pipelineRuns.pipelineId, pipelineId), inArray(pipelineRuns.status, ["success", "failed"])));
  const finished = Number(totals?.finished ?? 0);
  const avgMs = totals?.avgMs === null || totals?.avgMs === undefined ? null : Number(totals.avgMs);
  await db.update(pipelines).set({
    status: health,
    successRate: finished ? Math.round((Number(totals!.successes) / finished) * 100) : null,
    avgDurationSeconds: avgMs === null ? null : Math.round(avgMs / 1000),
    failureCount: Number(totals?.failures ?? 0),
  }).where(eq(pipelines.id, pipelineId));
}

/**
 * Close runs a crashed/restarted server left in created/running. They are marked
 * failed (never success) so history stays truthful and the pipeline can run again.
 */
export async function recoverStaleRuns(db: Database, workspace: Workspace, actorId: string, now = Date.now()) {
  const workspacePipelines = db.select({ id: pipelines.id }).from(pipelines).where(eq(pipelines.workspaceId, workspace.id));
  const closed = await db.update(pipelineRuns)
    .set({ status: "failed", errorMessage: INTERRUPTED_MESSAGE, completedAt: new Date(now) })
    .where(and(inArray(pipelineRuns.status, ACTIVE_RUN_STATUSES), lt(pipelineRuns.startedAt, new Date(now - RUN_STALE_AFTER_MS)), inArray(pipelineRuns.pipelineId, workspacePipelines)))
    .returning({ id: pipelineRuns.id, pipelineId: pipelineRuns.pipelineId });
  for (const pipelineId of Array.from(new Set(closed.map(row => row.pipelineId)))) await refreshPipelineHealth(db, pipelineId, "FAILED");
  // Phase 7: an interrupted run is a failed run, so it is an incident source too.
  for (const run of closed) await recordRunFailure(db, workspace, actorId, run.pipelineId, run.id, INTERRUPTED_MESSAGE);
  return closed.length;
}

// ---------------------------------------------------------------- start + execute

export async function startPipelineRun(user: User, input: { workspaceId: number; pipelineId: number }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, input.workspaceId);
  if (!mayRunPipeline(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners, admins and developers can run pipelines." });
  await recoverStaleRuns(db, workspace, user.id);

  // 1) created — committed before any work, under a pipeline row lock so two clicks cannot start two runs.
  const runId = await db.transaction(async tx => {
    const [pipeline] = await tx.select({ id: pipelines.id, workspaceId: pipelines.workspaceId }).from(pipelines)
      .where(and(eq(pipelines.id, input.pipelineId), pipelineVisibleInWorkspace(workspace))).for("update");
    if (!pipeline) throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in the active workspace." });
    if (pipeline.workspaceId !== workspace.id) throw new TRPCError({ code: "FORBIDDEN", message: "Legacy organisation-level pipelines cannot be run." });
    const [active] = await tx.select({ id: pipelineRuns.id }).from(pipelineRuns)
      .where(and(eq(pipelineRuns.pipelineId, pipeline.id), inArray(pipelineRuns.status, ACTIVE_RUN_STATUSES))).limit(1);
    if (active) throw new TRPCError({ code: "CONFLICT", message: `Run #${active.id} of this pipeline is still in progress.` });
    return extractInsertId(await tx.insert(pipelineRuns).values({ pipelineId: pipeline.id, status: "created", logs: emptyRunLog() }).returning({ id: pipelineRuns.id }));
  });

  const started = Date.now();
  const log = emptyRunLog();
  const note = (level: "info" | "warn" | "error", message: string) => log.entries.push({ at: new Date().toISOString(), level, message });
  note("info", `Run #${runId} created.`);

  try {
    // 2) running
    await db.update(pipelineRuns).set({ status: "running", logs: log }).where(eq(pipelineRuns.id, runId));
    note("info", "Execution started on the server.");
    const plan = await loadRunPlan(db, workspace, input.pipelineId);
    log.source = { datasetId: plan.source.id, name: plan.source.name, rowCount: plan.sourceRows.length };
    note("info", `Loaded ${plan.sourceRows.length} rows and ${plan.sourceColumns.length} columns from "${plan.source.name}".`);
    // Re-validated at run time: the source may have been overwritten by another pipeline since this one was saved.
    if (plan.issues.length) throw new RunFailure(`The source dataset "${plan.source.name}" no longer matches this pipeline. ${plan.issues.map(issue => issue.message).join(" ")}`);

    // Execute each stored step with the unchanged engine, recording per-step row counts.
    let rows: Row[] = plan.sourceRows;
    let coercionFailures = 0;
    plan.steps.forEach((step, order) => {
      const before = rows.length;
      const result = applyTransformStep(rows, step);
      rows = result.rows;
      coercionFailures += result.coercionFailures;
      log.steps.push({ order, operation: step.operation, description: describeStep(step), rowsIn: before, rowsOut: rows.length, coercionFailures: result.coercionFailures, effect: result.effect });
      note(result.coercionFailures ? "warn" : "info", `Step ${order + 1} · ${describeStep(step)}: ${result.effect}`);
    });
    const outputColumns = columnsAfterSteps(plan.steps, plan.sourceColumns);
    const outputProfiles = inferColumns(rows, outputColumns);
    const qualityScore = completenessScore(rows, outputColumns);
    if (coercionFailures) note("warn", `${coercionFailures} value(s) could not be converted and were set to null.`);

    // 3) success — output write, run completion and pipeline health commit together or not at all.
    await db.transaction(async tx => {
      const tdb = tx as unknown as Database;
      let datasetId: number;
      let datasetName: string;
      if (plan.destinationMode === "overwrite_existing") {
        const [destination] = await tx.select({ id: datasets.id, name: datasets.name, workspaceId: datasets.workspaceId }).from(datasets)
          .where(and(eq(datasets.id, plan.destinationDatasetId!), datasetVisibleInWorkspace(workspace))).for("update");
        if (!destination || destination.workspaceId !== workspace.id) throw new RunFailure("The destination dataset no longer exists in this workspace. Edit the pipeline and choose a destination.");
        await replaceDatasetContent(tdb, destination.id, outputProfiles, rows, qualityScore);
        datasetId = destination.id;
        datasetName = destination.name;
      } else {
        datasetName = `${plan.name} · run ${runId}`.slice(0, 160);
        datasetId = extractInsertId(await tx.insert(datasets).values({
          organizationId: workspace.organizationId, workspaceId: workspace.id, projectId: plan.projectId, name: datasetName,
          ownerId: user.id, sourceType: PIPELINE_OUTPUT_SOURCE_TYPE, qualityScore, rowCount: rows.length,
        }).returning({ id: datasets.id }));
        await writeDatasetContent(tdb, datasetId, outputProfiles, rows);
      }
      // Phase 7: checks defined on an overwritten destination are evaluated on exactly the rows just written.
      if (plan.destinationMode === "overwrite_existing") {
        const checks = await evaluateDatasetChecks(tdb, workspace, user.id, datasetId, rows, outputColumns, { kind: "run", runId });
        if (checks.length) {
          const failing = checks.filter(check => check.status !== "pass").length;
          note(failing ? "warn" : "info", `Quality checks on "${datasetName}": ${checks.length - failing} passed, ${failing} failed.`);
        }
      }
      log.output = { mode: plan.destinationMode, datasetId, datasetName, columns: outputColumns, rowCount: rows.length, qualityScore };
      log.sample = rows.slice(0, RUN_SAMPLE_ROWS);
      note("info", `Wrote ${rows.length} rows to "${datasetName}" (${plan.destinationMode === "overwrite_existing" ? "replaced" : "new dataset"}).`);
      const durationMs = Date.now() - started;
      note("info", `Run succeeded in ${durationMs} ms.`);
      // Only a run that is still live may succeed: if stale-run recovery already closed it as
      // interrupted, roll back this run's writes instead of flipping it back to success.
      const closed = await tx.update(pipelineRuns).set({ status: "success", rowsIn: plan.sourceRows.length, rowsOut: rows.length, coercionFailures, durationMs, errorMessage: null, logs: log, completedAt: new Date() })
        .where(and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ACTIVE_RUN_STATUSES))).returning({ id: pipelineRuns.id });
      if (!closed.length) throw new RunFailure("This run was already closed as interrupted before it finished; its output was discarded.");
      await refreshPipelineHealth(tdb, input.pipelineId, coercionFailures ? "WARNING" : "HEALTHY");
      await recordRunSuccess(tdb, workspace, user.id, input.pipelineId, runId);
      await audit(tdb, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: PIPELINE_RUN_AUDIT_ACTIONS.succeeded, resourceType: "pipeline_run", resourceId: String(runId), metadata: { pipelineId: input.pipelineId, rowsIn: plan.sourceRows.length, rowsOut: rows.length, outputDatasetId: datasetId } });
    });
  } catch (error) {
    const message = error instanceof RunFailure ? error.message : error instanceof TRPCError ? error.message : WRITE_FAILED_MESSAGE;
    if (!(error instanceof RunFailure)) console.error(`[PipelineRun] run #${runId} failed`, error);
    note("error", message);
    log.output = null;
    log.sample = [];
    try {
      await db.transaction(async tx => {
        const tdb = tx as unknown as Database;
        const closed = await tx.update(pipelineRuns).set({ status: "failed", rowsIn: log.source?.rowCount ?? 0, rowsOut: 0, durationMs: Date.now() - started, errorMessage: message, logs: log, completedAt: new Date() })
          .where(and(eq(pipelineRuns.id, runId), inArray(pipelineRuns.status, ACTIVE_RUN_STATUSES))).returning({ id: pipelineRuns.id });
        if (!closed.length) return; // already closed (as interrupted) and recorded by stale-run recovery
        await refreshPipelineHealth(tdb, input.pipelineId, "FAILED");
        await recordRunFailure(tdb, workspace, user.id, input.pipelineId, runId, message);
        await audit(tdb, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: PIPELINE_RUN_AUDIT_ACTIONS.failed, resourceType: "pipeline_run", resourceId: String(runId), metadata: { pipelineId: input.pipelineId, error: message.slice(0, 300) } });
      });
    } catch (recordError) {
      // The run row stays created/running and will be closed as interrupted by recoverStaleRuns.
      console.error(`[PipelineRun] could not record failure of run #${runId}`, recordError);
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The run failed and its result could not be recorded." });
    }
  }
  return getPipelineRun(user, input.workspaceId, runId);
}

/** Everything execution needs, re-validated at run time (datasets may have changed since the pipeline was saved). */
async function loadRunPlan(db: Database, workspace: Workspace, pipelineId: number) {
  const [pipeline] = await db.select().from(pipelines).where(and(eq(pipelines.id, pipelineId), eq(pipelines.workspaceId, workspace.id))).limit(1);
  if (!pipeline) throw new RunFailure("The pipeline no longer exists in this workspace.");
  const stepRows = await db.select({ stepOrder: pipelineSteps.stepOrder, operation: pipelineSteps.operation, config: pipelineSteps.config })
    .from(pipelineSteps).where(eq(pipelineSteps.pipelineId, pipeline.id)).orderBy(asc(pipelineSteps.stepOrder));
  const steps: TransformStep[] = [];
  for (const row of stepRows) {
    const step = fromStepRecord(row);
    if (!step) throw new RunFailure(`Stored step ${row.stepOrder + 1} (${row.operation}) is not a valid step. Edit and re-save the pipeline.`);
    steps.push(step);
  }
  if (!pipeline.sourceDatasetId) throw new RunFailure("The source dataset was removed. Edit the pipeline and choose a source.");
  const [source] = await db.select({ id: datasets.id, name: datasets.name, workspaceId: datasets.workspaceId }).from(datasets)
    .where(and(eq(datasets.id, pipeline.sourceDatasetId), datasetVisibleInWorkspace(workspace))).limit(1);
  if (!source || source.workspaceId !== workspace.id) throw new RunFailure("The source dataset no longer exists in this workspace.");
  const sourceColumns = (await db.select({ name: datasetColumns.name }).from(datasetColumns).where(eq(datasetColumns.datasetId, source.id)).orderBy(asc(datasetColumns.id))).map(column => column.name);
  if (!sourceColumns.length) throw new RunFailure(`The source dataset "${source.name}" has no columns.`);
  const issues = validatePipelineSteps(steps, sourceColumns);
  const destinationMode = pipeline.destinationMode === "overwrite_existing" ? "overwrite_existing" as const : "new_dataset" as const;
  if (destinationMode === "overwrite_existing" && !pipeline.destinationDatasetId) throw new RunFailure("The destination dataset was removed. Edit the pipeline and choose a destination.");
  const sourceRows = await loadAllDatasetRows(db, source.id);
  return { name: pipeline.name, projectId: pipeline.projectId, steps, source, sourceColumns, sourceRows, destinationMode, destinationDatasetId: pipeline.destinationDatasetId, issues };
}

// ---------------------------------------------------------------- read

export async function getPipelineRun(user: User, workspaceId: number, runId: number) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadPipeline(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read pipeline runs in this workspace." });
  await recoverStaleRuns(db, workspace, user.id);
  const [row] = await db.select({ run: pipelineRuns, pipelineName: pipelines.name, pipelineWorkspaceId: pipelines.workspaceId }).from(pipelineRuns)
    .innerJoin(pipelines, eq(pipelineRuns.pipelineId, pipelines.id))
    .where(and(eq(pipelineRuns.id, runId), pipelineVisibleInWorkspace(workspace))).limit(1);
  // NOT_FOUND (not FORBIDDEN) so run ids from other workspaces are not disclosed.
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Run not found in the active workspace." });
  const log = parseRunLog(row.run.logs);
  let outputAvailable = false;
  if (log.output) {
    const [dataset] = await db.select({ id: datasets.id }).from(datasets).where(and(eq(datasets.id, log.output.datasetId), datasetVisibleInWorkspace(workspace))).limit(1);
    outputAvailable = Boolean(dataset);
  }
  const { logs: _logs, ...run } = row.run;
  return { ...run, pipelineName: row.pipelineName, log, outputAvailable };
}

export async function listPipelineRuns(user: User, workspaceId: number, options: { pipelineId?: number; limit?: number } = {}) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadPipeline(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read pipeline runs in this workspace." });
  await recoverStaleRuns(db, workspace, user.id);
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  return db.select({
    id: pipelineRuns.id,
    pipelineId: pipelineRuns.pipelineId,
    pipelineName: pipelines.name,
    status: pipelineRuns.status,
    rowsIn: pipelineRuns.rowsIn,
    rowsOut: pipelineRuns.rowsOut,
    coercionFailures: pipelineRuns.coercionFailures,
    durationMs: pipelineRuns.durationMs,
    errorMessage: pipelineRuns.errorMessage,
    startedAt: pipelineRuns.startedAt,
    completedAt: pipelineRuns.completedAt,
    outputDatasetId: sql<number | null>`(${pipelineRuns.logs} -> 'output' ->> 'datasetId')::bigint`.mapWith(value => (value === null ? null : Number(value))),
    outputDatasetName: sql<string | null>`${pipelineRuns.logs} -> 'output' ->> 'datasetName'`,
  }).from(pipelineRuns)
    .innerJoin(pipelines, eq(pipelineRuns.pipelineId, pipelines.id))
    .where(and(pipelineVisibleInWorkspace(workspace), ...(options.pipelineId ? [eq(pipelineRuns.pipelineId, options.pipelineId)] : [])))
    .orderBy(desc(pipelineRuns.id)).limit(limit);
}
