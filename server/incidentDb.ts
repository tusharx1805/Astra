import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { auditLogs, datasets, incidents, pipelineRuns, pipelines, qualityChecks, qualityResults } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { fetchProfiles } from "./_core/supabaseProfiles";
import { describeCheck } from "../shared/quality";
import { audit, getWorkspaceContext, type Database } from "./workspaceDb";
import { mayHandleIncidents, mayReadChanges, OPS_AUDIT_ACTIONS } from "./workspaceContracts";

/**
 * Phase 7 — incidents. An incident exists ONLY because of a defined source event:
 *
 *   pipeline_run_failed    a pipeline run ended in `failed` (including runs closed as interrupted)
 *                          key "pipeline:<id>" · warning, escalates to critical at 3 occurrences
 *                          auto-resolves when that pipeline's next run succeeds
 *   quality_check_failed   a quality check evaluated to `fail` or `error`
 *                          key "check:<id>" · severity = the check's severity
 *                          auto-resolves when that check next passes
 *
 * One unresolved incident per source (DB partial unique index); repeats increment
 * `occurrences`. People can acknowledge or resolve (with a note); a later failure
 * opens a NEW incident. Every transition is written to audit_logs.
 */

export const PIPELINE_ESCALATE_AT = 3;
type Workspace = { id: number; organizationId: number };
type Severity = "warning" | "critical";

export const pipelineKey = (pipelineId: number) => `pipeline:${pipelineId}`;
export const checkKey = (checkId: number) => `check:${checkId}`;

async function logIncident(db: Database, workspace: Workspace, actorId: string, action: string, incidentId: number, metadata: Record<string, unknown>) {
  await audit(db, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId, action, resourceType: "incident", resourceId: String(incidentId), metadata });
}

/** Open a new incident for a source, or record a recurrence on the active one. Call inside the caller's transaction. */
export async function openOrRecurIncident(db: Database, workspace: Workspace, actorId: string, input: {
  sourceType: "pipeline_run_failed" | "quality_check_failed"; sourceKey: string; severity: Severity; title: string; detail: string;
  pipelineId?: number | null; datasetId?: number | null; qualityCheckId?: number | null; runId?: number | null; resultId?: number | null;
}) {
  const active = async () => (await db.select().from(incidents).where(and(eq(incidents.workspaceId, workspace.id), eq(incidents.sourceKey, input.sourceKey), ne(incidents.status, "resolved"))).limit(1).for("update"))[0];
  let current = await active();
  if (!current) {
    const inserted = await db.insert(incidents).values({
      organizationId: workspace.organizationId, workspaceId: workspace.id, sourceType: input.sourceType, sourceKey: input.sourceKey,
      pipelineId: input.pipelineId ?? null, datasetId: input.datasetId ?? null, qualityCheckId: input.qualityCheckId ?? null,
      firstRunId: input.runId ?? null, lastRunId: input.runId ?? null, lastResultId: input.resultId ?? null,
      title: input.title.slice(0, 200), detail: input.detail, severity: input.severity, openedAt: sql`clock_timestamp()`, lastSeenAt: sql`clock_timestamp()`,
    }).onConflictDoNothing({ target: [incidents.workspaceId, incidents.sourceKey], where: sql`status <> 'resolved'` }).returning({ id: incidents.id });
    if (inserted[0]) {
      await logIncident(db, workspace, actorId, OPS_AUDIT_ACTIONS.incidentOpened, inserted[0].id, { sourceKey: input.sourceKey, severity: input.severity, runId: input.runId ?? null, resultId: input.resultId ?? null });
      return { id: inserted[0].id, opened: true };
    }
    current = await active(); // lost a race: another transaction opened it first
    if (!current) throw new Error("Incident vanished during upsert");
  }
  const occurrences = current.occurrences + 1;
  const severity: Severity = current.severity === "critical" || input.severity === "critical" || (input.sourceType === "pipeline_run_failed" && occurrences >= PIPELINE_ESCALATE_AT) ? "critical" : "warning";
  await db.update(incidents).set({ occurrences, severity, detail: input.detail, lastSeenAt: sql`clock_timestamp()`, lastRunId: input.runId ?? current.lastRunId, lastResultId: input.resultId ?? current.lastResultId }).where(eq(incidents.id, current.id));
  await logIncident(db, workspace, actorId, OPS_AUDIT_ACTIONS.incidentRecurred, current.id, { occurrences, severity, runId: input.runId ?? null, resultId: input.resultId ?? null });
  return { id: current.id, opened: false };
}

/** Close the active incident of a source because its source event cleared (a successful run / a passing check). */
export async function autoResolveIncident(db: Database, workspace: Workspace, actorId: string, sourceKey: string, note: string, refs: { runId?: number | null; resultId?: number | null } = {}) {
  const resolved = await db.update(incidents).set({ status: "resolved", resolution: "auto", resolutionNote: note, resolvedAt: sql`clock_timestamp()`, resolvedBy: null })
    .where(and(eq(incidents.workspaceId, workspace.id), eq(incidents.sourceKey, sourceKey), ne(incidents.status, "resolved"))).returning({ id: incidents.id });
  for (const row of resolved) await logIncident(db, workspace, actorId, OPS_AUDIT_ACTIONS.incidentResolved, row.id, { resolution: "auto", note, ...refs });
  return resolved.length;
}

/** Hook: a pipeline run ended in `failed`. */
export async function recordRunFailure(db: Database, workspace: Workspace, actorId: string, pipelineId: number, runId: number, message: string) {
  const [pipeline] = await db.select({ name: pipelines.name }).from(pipelines).where(eq(pipelines.id, pipelineId)).limit(1);
  return openOrRecurIncident(db, workspace, actorId, {
    sourceType: "pipeline_run_failed", sourceKey: pipelineKey(pipelineId), severity: "warning",
    title: `Pipeline "${pipeline?.name ?? `#${pipelineId}`}" failed`, detail: `Run #${runId}: ${message}`, pipelineId, runId,
  });
}

/** Hook: a pipeline run succeeded. */
export function recordRunSuccess(db: Database, workspace: Workspace, actorId: string, pipelineId: number, runId: number) {
  return autoResolveIncident(db, workspace, actorId, pipelineKey(pipelineId), `Run #${runId} succeeded.`, { runId });
}

// ---------------------------------------------------------------- reads + manual actions

async function names(accessToken: string | null, user: User, ids: Array<string | null>) {
  const profiles = await fetchProfiles(accessToken, Array.from(new Set(ids.filter((id): id is string => Boolean(id))))).catch(() => new Map());
  return (id: string | null) => (!id ? null : id === user.id ? "You" : profiles.get(id) ? `@${profiles.get(id)!.username}` : "Workspace member");
}

export async function listIncidents(user: User, workspaceId: number, filter: "active" | "all" = "active") {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadChanges(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read incidents in this workspace." });
  const rows = await db.select({ incident: incidents, pipelineName: pipelines.name, datasetName: datasets.name }).from(incidents)
    .leftJoin(pipelines, eq(incidents.pipelineId, pipelines.id)).leftJoin(datasets, eq(incidents.datasetId, datasets.id))
    .where(and(eq(incidents.workspaceId, workspace.id), ...(filter === "active" ? [ne(incidents.status, "resolved")] : [])))
    .orderBy(sql`case when ${incidents.status} = 'resolved' then 1 else 0 end`, desc(incidents.lastSeenAt)).limit(200);
  return rows.map(row => ({ ...row.incident, pipelineName: row.pipelineName, datasetName: row.datasetName }));
}

export async function getIncident(user: User, workspaceId: number, incidentId: number, accessToken: string | null = null) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadChanges(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read incidents in this workspace." });
  const [row] = await db.select().from(incidents).where(and(eq(incidents.id, incidentId), eq(incidents.workspaceId, workspace.id))).limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Incident not found in the active workspace." });
  const [pipeline] = row.pipelineId ? await db.select({ id: pipelines.id, name: pipelines.name, status: pipelines.status }).from(pipelines).where(eq(pipelines.id, row.pipelineId)).limit(1) : [];
  const [dataset] = row.datasetId ? await db.select({ id: datasets.id, name: datasets.name }).from(datasets).where(eq(datasets.id, row.datasetId)).limit(1) : [];
  const [check] = row.qualityCheckId ? await db.select().from(qualityChecks).where(eq(qualityChecks.id, row.qualityCheckId)).limit(1) : [];
  // The evidence: every source event in this incident's lifetime.
  const until = row.resolvedAt ?? new Date(Date.now() + 60_000);
  const runs = row.pipelineId ? await db.select({ id: pipelineRuns.id, status: pipelineRuns.status, errorMessage: pipelineRuns.errorMessage, rowsIn: pipelineRuns.rowsIn, rowsOut: pipelineRuns.rowsOut, startedAt: pipelineRuns.startedAt })
    .from(pipelineRuns).where(and(eq(pipelineRuns.pipelineId, row.pipelineId), sql`${pipelineRuns.id} >= ${row.firstRunId ?? 0}`, sql`${pipelineRuns.startedAt} <= ${until.toISOString()}`)).orderBy(desc(pipelineRuns.id)).limit(50) : [];
  const results = row.qualityCheckId ? await db.select().from(qualityResults).where(and(eq(qualityResults.checkId, row.qualityCheckId), sql`${qualityResults.evaluatedAt} >= ${row.openedAt.toISOString()}::timestamptz - interval '1 second'`, sql`${qualityResults.evaluatedAt} <= ${until.toISOString()}`)).orderBy(desc(qualityResults.id)).limit(50) : [];
  const timeline = await db.select({ action: auditLogs.action, actorId: auditLogs.actorId, metadata: auditLogs.metadata, createdAt: auditLogs.createdAt }).from(auditLogs)
    .where(and(eq(auditLogs.resourceType, "incident"), eq(auditLogs.resourceId, String(row.id)), eq(auditLogs.workspaceId, workspace.id))).orderBy(asc(auditLogs.id));
  const name = await names(accessToken, user, [row.acknowledgedBy, row.resolvedBy, ...timeline.map(item => item.actorId)]);
  return {
    ...row, acknowledgedByName: name(row.acknowledgedBy), resolvedByName: name(row.resolvedBy),
    pipeline: pipeline ?? null, dataset: dataset ?? null,
    check: check ? { id: check.id, description: describeCheck(check), severity: check.severity, enabled: check.enabled, datasetId: check.datasetId } : null,
    runs, results,
    timeline: timeline.map(item => ({ ...item, actor: name(item.actorId) })),
    canHandle: mayHandleIncidents(actorRole),
  };
}

export async function updateIncidentStatus(user: User, input: { workspaceId: number; incidentId: number; action: "acknowledge" | "resolve"; note?: string | null }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, input.workspaceId);
  if (!mayHandleIncidents(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners, admins, developers and reviewers can acknowledge or resolve incidents." });
  const note = input.note?.trim() || null;
  if (input.action === "resolve" && (!note || note.length < 5)) throw new TRPCError({ code: "BAD_REQUEST", message: "Explain the resolution in a note (at least 5 characters)." });
  await db.transaction(async tx => {
    const tdb = tx as unknown as Database;
    const [row] = await tx.select().from(incidents).where(and(eq(incidents.id, input.incidentId), eq(incidents.workspaceId, workspace.id))).for("update");
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Incident not found in the active workspace." });
    if (row.status === "resolved") throw new TRPCError({ code: "CONFLICT", message: "This incident is already resolved." });
    if (input.action === "acknowledge") {
      if (row.status === "acknowledged") throw new TRPCError({ code: "CONFLICT", message: "This incident is already acknowledged." });
      await tx.update(incidents).set({ status: "acknowledged", acknowledgedBy: user.id, acknowledgedAt: sql`clock_timestamp()` }).where(eq(incidents.id, row.id));
      await logIncident(tdb, workspace, user.id, OPS_AUDIT_ACTIONS.incidentAcknowledged, row.id, { note });
    } else {
      await tx.update(incidents).set({ status: "resolved", resolution: "manual", resolutionNote: note, resolvedBy: user.id, resolvedAt: sql`clock_timestamp()` }).where(eq(incidents.id, row.id));
      await logIncident(tdb, workspace, user.id, OPS_AUDIT_ACTIONS.incidentResolved, row.id, { resolution: "manual", note });
    }
  });
  return getIncident(user, input.workspaceId, input.incidentId);
}

export async function countActiveIncidents(db: Database, workspaceId: number) {
  const rows = await db.select({ severity: incidents.severity, total: sql<number>`count(*)` }).from(incidents).where(and(eq(incidents.workspaceId, workspaceId), ne(incidents.status, "resolved"))).groupBy(incidents.severity);
  const by = new Map(rows.map(row => [row.severity, Number(row.total)]));
  return { total: (by.get("warning") ?? 0) + (by.get("critical") ?? 0), critical: by.get("critical") ?? 0 };
}

export type { Workspace };
