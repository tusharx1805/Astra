import { describe, expect, it } from "vitest";
import { buildWorkspaceReport, kpi, reportContent, reportToCsv, type ReportSnapshot } from "./report";

const now = new Date("2026-09-30T12:00:00Z");
const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
const run = (id: number, pipelineId: number, status: string, daysAgo = 0) => ({ id, pipelineId, pipelineName: `p${pipelineId}`, status, rowsIn: 5, rowsOut: status === "success" ? 4 : 0, coercionFailures: 0, durationMs: 10, startedAt: at(daysAgo), completedAt: at(daysAgo) });

const snapshot: ReportSnapshot = {
  workspace: { id: 1, name: "Demo, Inc", members: 2 },
  datasets: [{ id: 1, name: "customers", rowCount: 5, sourceType: "CSV / Files", owned: true }, { id: 2, name: "out", rowCount: 4, sourceType: "Pipeline output", owned: true }, { id: 3, name: "legacy", rowCount: 99, sourceType: "x", owned: false }],
  pipelines: [{ id: 1, name: "p1", status: "HEALTHY" }, { id: 2, name: "p2", status: "FAILED" }, { id: 3, name: "p3", status: "DRAFT" }],
  runs: [run(1, 1, "success", 1), run(2, 2, "failed"), run(3, 2, "failed"), run(4, 1, "success"), run(5, 1, "success", 40)],
  changes: [{ id: 7, title: "Edit p1", latestLevel: "CRITICAL", latestScore: 83, reviewStatus: "BLOCKED", createdAt: at(0) }, { id: 8, title: "New p3", latestLevel: "SAFE", latestScore: 5, reviewStatus: "PENDING REVIEW", createdAt: at(0) }, { id: 9, title: "Edit p2", latestLevel: "HIGH", latestScore: 60, reviewStatus: "RE-REVIEW NEEDED", createdAt: at(0) }],
  incidents: [{ id: 1, title: "p2 failed", severity: "critical", status: "open", sourceType: "pipeline_run_failed", openedAt: at(0), resolvedAt: null, lastSeenAt: at(0) }, { id: 2, title: "old", severity: "warning", status: "resolved", sourceType: "quality_check_failed", openedAt: at(60), resolvedAt: at(50), lastSeenAt: at(50) }],
  quality: { checks: 3, evaluated: 2, passing: 1, failing: 1, errors: 0, datasets: [{ datasetId: 1, datasetName: "customers", checks: 3, passing: 1, failing: 1, errors: 0 }] },
};

describe("workspace KPIs (hand-checked against the snapshot)", () => {
  const report = buildWorkspaceReport(snapshot, { now, days: 30 });
  it("computes every KPI from the records", () => {
    const values = Object.fromEntries(report.kpis.map(item => [item.key, item.value]));
    expect(values).toEqual({
      pipeline_health_pct: 50, runs_succeeded: 2, runs_failed: 2, // run 5 is 40 days old → outside the window
      pipelines_total: 3, pipelines_failing: 1,
      quality_pass_pct: 50, quality_checks_failing: 1,
      open_risks: 2, critical_risks: 1, pending_reviews: 2,
      incidents_active: 1, incidents_critical: 1, incidents_opened: 1, incidents_resolved: 0,
      anomalies: 0, datasets_total: 2, stored_rows: 9, // legacy dataset not owned → excluded
    });
    expect(report.riskByLevel).toEqual([{ level: "CRITICAL", count: 1 }, { level: "HIGH", count: 1 }, { level: "MEDIUM", count: 0 }, { level: "SAFE", count: 1 }]);
    expect(report.pipelineHealth).toEqual([{ status: "HEALTHY", count: 1 }, { status: "WARNING", count: 0 }, { status: "FAILED", count: 1 }, { status: "DRAFT", count: 1 }]);
    expect(report.topRisk).toMatchObject({ changeId: 7, score: 83 });
    expect(report.recentRuns.map(item => item.id)).toEqual([5, 4, 3, 2, 1]);
    expect(report.signals[0]).toMatchObject({ kind: "incident", href: "/incidents/1" });
  });
  it("a known new failed run moves the KPIs by exactly the expected amount", () => {
    const after = buildWorkspaceReport({ ...snapshot, runs: [...snapshot.runs, run(6, 1, "failed")] }, { now, days: 30 });
    expect(kpi(after, "runs_failed").value).toBe(3);
    expect(kpi(after, "pipeline_health_pct").value).toBe(40);
  });
  it("CSV is a serialisation of the same object (values, escaping, fingerprint)", () => {
    const csv = reportToCsv(report, "abc123");
    expect(csv).toContain("# workspace,\"Demo, Inc\"");
    expect(csv).toContain("# fingerprint,abc123");
    for (const item of report.kpis) expect(csv).toContain(`summary,${item.key},${item.value ?? ""},`);
    expect(csv).toContain("changes,7,Edit p1,CRITICAL,83,BLOCKED,");
    expect(csv).toContain("pipelines,p2,2,0,2,0,,3,failed,FAILED");
  });
  it("content excludes the clock, so the same records give the same content", () => {
    const later = buildWorkspaceReport(snapshot, { now: new Date(now.getTime() + 1000), days: 30 });
    expect(reportContent(later)).toEqual(reportContent(report));
  });
});
