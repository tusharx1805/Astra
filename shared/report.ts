import { detectAnomalies, summarizeRuns, type RunRecord } from "./monitoring";

/**
 * Phase 8 — the ONE place Astra's workspace KPIs are calculated.
 * The Overview dashboard, the Reports page and the CSV export all call
 * buildWorkspaceReport() on the same database snapshot, so they cannot disagree.
 * Every KPI carries its definition and the table it comes from.
 */

export const REPORT_WINDOWS = [7, 30, 90] as const;
export type ReportWindow = (typeof REPORT_WINDOWS)[number];

export type ReportSnapshot = {
  workspace: { id: number; name: string; members: number };
  datasets: Array<{ id: number; name: string; rowCount: number; sourceType: string; owned: boolean }>;
  pipelines: Array<{ id: number; name: string; status: string }>;
  runs: RunRecord[];
  changes: Array<{ id: number; title: string; latestLevel: string | null; latestScore: number | null; reviewStatus: string; createdAt: string | Date }>;
  incidents: Array<{ id: number; title: string; severity: string; status: string; sourceType: string; openedAt: string | Date; resolvedAt: string | Date | null; lastSeenAt: string | Date }>;
  quality: { checks: number; evaluated: number; passing: number; failing: number; errors: number; datasets: Array<{ datasetId: number; datasetName: string; checks: number; passing: number; failing: number; errors: number }> };
};

export type Kpi = { key: string; label: string; value: number | null; display: string; unit: "%" | "count" | "rows"; definition: string; source: string };

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const iso = (value: string | Date | null) => (value ? new Date(value).toISOString() : null);
const count = (value: number) => String(value).padStart(2, "0");

export function buildWorkspaceReport(snapshot: ReportSnapshot, options: { now: Date; days: ReportWindow; utcOffsetMinutes?: number }) {
  const { now, days } = options;
  const since = new Date(now.getTime() - days * 86_400_000);
  const runs = summarizeRuns(snapshot.runs, { now, days, utcOffsetMinutes: options.utcOffsetMinutes ?? 0 });
  const anomalies = detectAnomalies(snapshot.runs).filter(item => new Date(item.at) >= since);
  const owned = snapshot.datasets.filter(dataset => dataset.owned);
  const byStatus = (status: string) => snapshot.pipelines.filter(pipeline => pipeline.status === status).length;
  const analysed = snapshot.changes.filter(change => change.latestLevel);
  const openRisks = analysed.filter(change => change.latestLevel !== "SAFE");
  const pendingReview = analysed.filter(change => change.reviewStatus === "PENDING REVIEW" || change.reviewStatus === "RE-REVIEW NEEDED");
  const activeIncidents = snapshot.incidents.filter(incident => incident.status !== "resolved");
  const q = snapshot.quality;
  const qualityPass = pct(q.passing, q.evaluated);
  const k = runs.kpis;

  const kpis: Kpi[] = [
    { key: "pipeline_health_pct", label: "Pipeline health", value: k.successRate, display: k.successRate === null ? "—" : `${k.successRate}%`, unit: "%", definition: `Successful runs ÷ finished runs, last ${days} days`, source: "pipeline_runs" },
    { key: "runs_succeeded", label: "Successful runs", value: k.successes, display: count(k.successes), unit: "count", definition: `Runs with status success, last ${days} days`, source: "pipeline_runs" },
    { key: "runs_failed", label: "Failed runs", value: k.failures, display: count(k.failures), unit: "count", definition: `Runs with status failed, last ${days} days`, source: "pipeline_runs" },
    { key: "pipelines_total", label: "Pipelines", value: snapshot.pipelines.length, display: count(snapshot.pipelines.length), unit: "count", definition: "Pipeline definitions in the workspace", source: "pipelines" },
    { key: "pipelines_failing", label: "Pipelines failing now", value: byStatus("FAILED"), display: count(byStatus("FAILED")), unit: "count", definition: "Pipelines whose latest finished run failed", source: "pipelines.status" },
    { key: "quality_pass_pct", label: "Quality checks passing", value: qualityPass, display: qualityPass === null ? "—" : `${qualityPass}%`, unit: "%", definition: "Latest result of each enabled check: pass ÷ evaluated", source: "quality_results" },
    { key: "quality_checks_failing", label: "Quality checks failing", value: q.failing + q.errors, display: count(q.failing + q.errors), unit: "count", definition: "Enabled checks whose latest result is fail or error", source: "quality_results" },
    { key: "open_risks", label: "Active risks", value: openRisks.length, display: count(openRisks.length), unit: "count", definition: "Changes whose latest analysis is MEDIUM, HIGH or CRITICAL", source: "risk_analyses" },
    { key: "critical_risks", label: "Critical risks", value: openRisks.filter(change => change.latestLevel === "CRITICAL").length, display: count(openRisks.filter(change => change.latestLevel === "CRITICAL").length), unit: "count", definition: "Changes whose latest analysis is CRITICAL", source: "risk_analyses" },
    { key: "pending_reviews", label: "Awaiting review", value: pendingReview.length, display: count(pendingReview.length), unit: "count", definition: "Analysed changes with no decision on their latest analysis", source: "reviews" },
    { key: "incidents_active", label: "Active incidents", value: activeIncidents.length, display: count(activeIncidents.length), unit: "count", definition: "Incidents that are open or acknowledged", source: "incidents" },
    { key: "incidents_critical", label: "Critical incidents", value: activeIncidents.filter(incident => incident.severity === "critical").length, display: count(activeIncidents.filter(incident => incident.severity === "critical").length), unit: "count", definition: "Active incidents with severity critical", source: "incidents" },
    { key: "incidents_opened", label: "Incidents opened", value: snapshot.incidents.filter(incident => new Date(incident.openedAt) >= since).length, display: count(snapshot.incidents.filter(incident => new Date(incident.openedAt) >= since).length), unit: "count", definition: `Incidents opened in the last ${days} days`, source: "incidents" },
    { key: "incidents_resolved", label: "Incidents resolved", value: snapshot.incidents.filter(incident => incident.resolvedAt && new Date(incident.resolvedAt) >= since).length, display: count(snapshot.incidents.filter(incident => incident.resolvedAt && new Date(incident.resolvedAt) >= since).length), unit: "count", definition: `Incidents resolved in the last ${days} days`, source: "incidents" },
    { key: "anomalies", label: "Anomalies", value: anomalies.length, display: count(anomalies.length), unit: "count", definition: `Runs flagged by the monitoring rules, last ${days} days`, source: "pipeline_runs" },
    { key: "datasets_total", label: "Datasets", value: owned.length, display: count(owned.length), unit: "count", definition: "Datasets stored in this workspace", source: "datasets" },
    { key: "stored_rows", label: "Stored rows", value: owned.reduce((sum, dataset) => sum + dataset.rowCount, 0), display: owned.reduce((sum, dataset) => sum + dataset.rowCount, 0).toLocaleString("en-US"), unit: "rows", definition: "Sum of row counts of the workspace's datasets", source: "datasets.row_count" },
  ];

  const levels = ["CRITICAL", "HIGH", "MEDIUM", "SAFE"] as const;
  const riskByLevel = levels.map(level => ({ level, count: analysed.filter(change => change.latestLevel === level).length }));
  const pipelineHealth = ["HEALTHY", "WARNING", "FAILED", "DRAFT"].map(status => ({ status, count: byStatus(status) }));
  const topRisk = [...openRisks].sort((a, b) => (b.latestScore ?? 0) - (a.latestScore ?? 0) || b.id - a.id)[0] ?? null;
  const recentRuns = [...snapshot.runs].sort((a, b) => b.id - a.id).slice(0, 8).map(run => ({ id: run.id, pipelineId: run.pipelineId, pipelineName: run.pipelineName, status: run.status, rowsIn: run.rowsIn, rowsOut: run.rowsOut, durationMs: run.durationMs, startedAt: iso(run.startedAt)! }));

  // Signals: facts worth attention, each pointing at the record that produced it (not AI).
  const signals = [
    ...activeIncidents.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1) || new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()).slice(0, 3).map(incident => ({ kind: "incident" as const, severity: incident.severity, title: incident.title, href: `/incidents/${incident.id}` })),
    ...anomalies.slice(0, 3).map(item => ({ kind: "anomaly" as const, severity: item.severity, title: `${item.pipelineName}: ${item.message}`, href: `/pipelines/runs/${item.runId}` })),
    ...pendingReview.slice(0, 3).map(change => ({ kind: "review" as const, severity: change.latestLevel === "CRITICAL" || change.latestLevel === "HIGH" ? "critical" : "warning", title: `${change.title} — ${change.latestLevel} ${change.latestScore}, ${change.reviewStatus.toLowerCase()}`, href: `/changes/${change.id}` })),
  ];

  return {
    meta: { workspaceId: snapshot.workspace.id, workspaceName: snapshot.workspace.name, members: snapshot.workspace.members, windowDays: days, since: since.toISOString(), until: now.toISOString(), lastRunAt: recentRuns[0]?.startedAt ?? null },
    kpis,
    pipelineHealth,
    riskByLevel,
    topRisk: topRisk ? { changeId: topRisk.id, title: topRisk.title, level: topRisk.latestLevel!, score: topRisk.latestScore!, reviewStatus: topRisk.reviewStatus } : null,
    recentRuns,
    signals,
    pipelines: runs.pipelines.map(item => ({ ...item, status: snapshot.pipelines.find(pipeline => pipeline.id === item.pipelineId)?.status ?? "—" })),
    changes: snapshot.changes.map(change => ({ id: change.id, title: change.title, level: change.latestLevel, score: change.latestScore, reviewStatus: change.reviewStatus, createdAt: iso(change.createdAt)! })),
    incidents: snapshot.incidents.filter(incident => incident.status !== "resolved" || (incident.resolvedAt && new Date(incident.resolvedAt) >= since)).map(incident => ({ id: incident.id, title: incident.title, severity: incident.severity, status: incident.status, openedAt: iso(incident.openedAt)!, resolvedAt: iso(incident.resolvedAt) })),
    quality: q.datasets,
    daily: runs.days,
  };
}

export type WorkspaceReport = ReturnType<typeof buildWorkspaceReport>;
export const kpi = (report: Pick<WorkspaceReport, "kpis">, key: string) => report.kpis.find(item => item.key === key)!;

/** Everything except the generation clock — two reports over the same records have the same content. */
export function reportContent(report: WorkspaceReport) {
  const { meta, ...rest } = report;
  const { until: _until, since: _since, ...stableMeta } = meta;
  return { meta: stableMeta, ...rest, daily: rest.daily.map(day => ({ success: day.success, failed: day.failed, avgDurationMs: day.avgDurationMs })) };
}

const cell = (value: unknown) => {
  let text = value === null || value === undefined ? "" : String(value);
  // Spreadsheet formula injection: user-controlled names starting with = + - @ (or tab/CR) are neutralised.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const line = (values: unknown[]) => values.map(cell).join(",");

/** CSV serialisation of the SAME report object the Reports page renders. */
export function reportToCsv(report: WorkspaceReport, fingerprint: string) {
  const out: string[] = [
    `# Astra workspace report`,
    `# workspace,${cell(report.meta.workspaceName)}`,
    `# window,last ${report.meta.windowDays} days (${report.meta.since} to ${report.meta.until})`,
    `# fingerprint,${fingerprint}`,
    `# every value below is computed from the Astra database; the Reports page shows the same fingerprint`,
    "",
    line(["section", "metric", "value", "definition", "source"]),
    ...report.kpis.map(item => line(["summary", item.key, item.value ?? "", item.definition, item.source])),
    "",
    line(["section", "pipeline", "runs", "successes", "failures", "success_rate_pct", "avg_duration_ms", "last_run_id", "last_run_status", "current_status"]),
    ...report.pipelines.map(item => line(["pipelines", item.pipelineName, item.runs, item.successes, item.failures, item.successRate ?? "", item.avgDurationMs ?? "", item.lastRun?.id ?? "", item.lastRun?.status ?? "", item.status])),
    "",
    line(["section", "change_id", "title", "risk_level", "risk_score", "review_status", "submitted_at"]),
    ...report.changes.map(item => line(["changes", item.id, item.title, item.level ?? "", item.score ?? "", item.reviewStatus, item.createdAt])),
    "",
    line(["section", "incident_id", "title", "severity", "status", "opened_at", "resolved_at"]),
    ...report.incidents.map(item => line(["incidents", item.id, item.title, item.severity, item.status, item.openedAt, item.resolvedAt ?? ""])),
    "",
    line(["section", "dataset", "checks", "passing", "failing", "cannot_run"]),
    ...report.quality.map(item => line(["quality", item.datasetName, item.checks, item.passing, item.failing, item.errors])),
  ];
  return out.join("\n") + "\n";
}
