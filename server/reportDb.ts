import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gte } from "drizzle-orm";
import { auditLogs, datasets, incidents, pipelineRuns, pipelines, workspaceMembers } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { buildWorkspaceReport, reportContent, reportToCsv, type ReportSnapshot, type ReportWindow } from "../shared/report";
import { audit, datasetVisibleInWorkspace, getWorkspaceContext, pipelineVisibleInWorkspace } from "./workspaceDb";
import { mayReadPipeline } from "./workspaceContracts";
import { listChanges } from "./changeDb";
import { qualityOverview } from "./qualityDb";
import { recoverStaleRuns } from "./pipelineRunDb";

/**
 * Phase 8 — dashboard & reports. One snapshot of the workspace's stored records
 * → shared/report.ts buildWorkspaceReport() → used by the Overview, the Reports
 * page and the CSV export. The fingerprint is a hash of the report CONTENT, so
 * the page and the exported file can be shown to contain the same numbers.
 */
const RUN_LOOKBACK_DAYS = 90;
export const REPORT_AUDIT_ACTION = "REPORT_EXPORTED";

async function loadSnapshot(user: User, workspaceId: number, now: Date): Promise<ReportSnapshot> {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadPipeline(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read reports in this workspace." });
  await recoverStaleRuns(db, workspace, user.id);
  const since = new Date(now.getTime() - RUN_LOOKBACK_DAYS * 86_400_000);
  const [members, datasetRows, pipelineRows, runRows, incidentRows, changeRows, quality] = await Promise.all([
    db.select({ total: count() }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspace.id)),
    db.select({ id: datasets.id, name: datasets.name, rowCount: datasets.rowCount, sourceType: datasets.sourceType, workspaceId: datasets.workspaceId }).from(datasets).where(datasetVisibleInWorkspace(workspace)),
    db.select({ id: pipelines.id, name: pipelines.name, status: pipelines.status }).from(pipelines).where(pipelineVisibleInWorkspace(workspace)),
    db.select({ id: pipelineRuns.id, pipelineId: pipelineRuns.pipelineId, pipelineName: pipelines.name, status: pipelineRuns.status, rowsIn: pipelineRuns.rowsIn, rowsOut: pipelineRuns.rowsOut, coercionFailures: pipelineRuns.coercionFailures, durationMs: pipelineRuns.durationMs, startedAt: pipelineRuns.startedAt, completedAt: pipelineRuns.completedAt })
      .from(pipelineRuns).innerJoin(pipelines, eq(pipelineRuns.pipelineId, pipelines.id)).where(and(pipelineVisibleInWorkspace(workspace), gte(pipelineRuns.startedAt, since))).orderBy(desc(pipelineRuns.id)).limit(5000),
    db.select({ id: incidents.id, title: incidents.title, severity: incidents.severity, status: incidents.status, sourceType: incidents.sourceType, openedAt: incidents.openedAt, resolvedAt: incidents.resolvedAt, lastSeenAt: incidents.lastSeenAt }).from(incidents).where(eq(incidents.workspaceId, workspace.id)).orderBy(desc(incidents.id)).limit(1000),
    listChanges(user, workspaceId),
    qualityOverview(user, workspaceId),
  ]);
  return {
    workspace: { id: workspace.id, name: workspace.name, members: Number(members[0]?.total ?? 0) },
    datasets: datasetRows.map(row => ({ id: row.id, name: row.name, rowCount: row.rowCount, sourceType: row.sourceType, owned: row.workspaceId === workspace.id })),
    pipelines: pipelineRows,
    runs: runRows,
    changes: changeRows.map(row => ({ id: row.id, title: row.title, latestLevel: row.latest?.level ?? null, latestScore: row.latest?.score ?? null, reviewStatus: row.reviewStatus, createdAt: row.createdAt })),
    incidents: incidentRows,
    quality,
  };
}

export function fingerprintOf(report: ReturnType<typeof buildWorkspaceReport>) {
  return createHash("sha256").update(JSON.stringify(reportContent(report))).digest("hex").slice(0, 12);
}

export async function getWorkspaceReport(user: User, workspaceId: number, days: ReportWindow, now = new Date(), utcOffsetMinutes = 0) {
  const report = buildWorkspaceReport(await loadSnapshot(user, workspaceId, now), { now, days, utcOffsetMinutes });
  return { ...report, fingerprint: fingerprintOf(report), generatedAt: now.toISOString() };
}

/** CSV built server-side from the SAME report object as the page. Every export is logged. */
export async function exportWorkspaceReport(user: User, workspaceId: number, days: ReportWindow, now = new Date(), utcOffsetMinutes = 0) {
  const report = buildWorkspaceReport(await loadSnapshot(user, workspaceId, now), { now, days, utcOffsetMinutes });
  const fingerprint = fingerprintOf(report);
  const csv = reportToCsv(report, fingerprint);
  const { db, workspace } = await getWorkspaceContext(user, workspaceId);
  await audit(db, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: REPORT_AUDIT_ACTION, resourceType: "report", resourceId: fingerprint, metadata: { windowDays: days, bytes: csv.length, kpis: Object.fromEntries(report.kpis.map(item => [item.key, item.value])) } });
  const slug = workspace.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace";
  return { filename: `astra-report-${slug}-${days}d-${now.toISOString().slice(0, 10)}-${fingerprint}.csv`, csv, fingerprint, generatedAt: now.toISOString() };
}

export async function listReportExports(user: User, workspaceId: number) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadPipeline(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read reports in this workspace." });
  const rows = await db.select({ id: auditLogs.id, actorId: auditLogs.actorId, fingerprint: auditLogs.resourceId, metadata: auditLogs.metadata, createdAt: auditLogs.createdAt }).from(auditLogs)
    .where(and(eq(auditLogs.workspaceId, workspace.id), eq(auditLogs.action, REPORT_AUDIT_ACTION))).orderBy(desc(auditLogs.id)).limit(100);
  return rows.map(row => ({ ...row, byYou: row.actorId === user.id }));
}
