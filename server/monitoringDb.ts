import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte } from "drizzle-orm";
import { pipelineRuns, pipelines } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { ANOMALY_RULES, detectAnomalies, summarizeRuns, type RunRecord } from "../shared/monitoring";
import { getWorkspaceContext, pipelineVisibleInWorkspace } from "./workspaceDb";
import { mayReadPipeline } from "./workspaceContracts";
import { countActiveIncidents } from "./incidentDb";
import { recoverStaleRuns } from "./pipelineRunDb";
import { qualityOverview } from "./qualityDb";

/**
 * Phase 7 — monitoring. Everything is computed from pipeline_runs of the active
 * workspace (shared/monitoring.ts); nothing is stored twice and nothing is simulated.
 * Anomaly baselines look back up to 90 days so a short window still has history.
 */
const BASELINE_LOOKBACK_DAYS = 90;
const MAX_RUNS = 5000;

export async function getMonitoring(user: User, workspaceId: number, days: number, now = new Date(), utcOffsetMinutes = 0) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadPipeline(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read monitoring in this workspace." });
  await recoverStaleRuns(db, workspace, user.id);
  const since = new Date(now.getTime() - Math.max(days, BASELINE_LOOKBACK_DAYS) * 86_400_000);
  const rows = await db.select({
    id: pipelineRuns.id, pipelineId: pipelineRuns.pipelineId, pipelineName: pipelines.name, status: pipelineRuns.status,
    rowsIn: pipelineRuns.rowsIn, rowsOut: pipelineRuns.rowsOut, coercionFailures: pipelineRuns.coercionFailures, durationMs: pipelineRuns.durationMs,
    startedAt: pipelineRuns.startedAt, completedAt: pipelineRuns.completedAt,
  }).from(pipelineRuns).innerJoin(pipelines, eq(pipelineRuns.pipelineId, pipelines.id))
    .where(and(pipelineVisibleInWorkspace(workspace), gte(pipelineRuns.startedAt, since))).orderBy(desc(pipelineRuns.id)).limit(MAX_RUNS);
  const runs: RunRecord[] = rows;
  const summary = summarizeRuns(runs, { now, days, utcOffsetMinutes });
  const windowStart = new Date(summary.window.since);
  const anomalies = detectAnomalies(runs).filter(item => new Date(item.at) >= windowStart);
  const [incidents, quality] = await Promise.all([countActiveIncidents(db, workspace.id), qualityOverview(user, workspaceId)]);
  return { ...summary, anomalies, rules: ANOMALY_RULES, incidents, quality: { checks: quality.checks, failing: quality.failing + quality.errors, passRate: quality.passRate } };
}
