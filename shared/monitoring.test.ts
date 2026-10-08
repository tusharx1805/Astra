import { describe, expect, it } from "vitest";
import { detectAnomalies, summarizeRuns, type RunRecord } from "./monitoring";

const now = new Date("2026-09-30T12:00:00Z");
const run = (id: number, status: string, durationMs: number, rowsOut: number, dayOffset = 0, extra: Partial<RunRecord> = {}): RunRecord => ({ id, pipelineId: 1, pipelineName: "p", status, rowsIn: 100, rowsOut, coercionFailures: 0, durationMs, startedAt: new Date(now.getTime() - dayOffset * 86_400_000).toISOString(), completedAt: null, ...extra });

describe("monitoring from stored runs", () => {
  const runs = [run(1, "success", 10, 100, 3), run(2, "success", 12, 100, 2), run(3, "success", 11, 100, 2), run(4, "success", 900, 100, 1), run(5, "success", 11, 20, 1), run(6, "failed", 3, 0, 0), run(7, "failed", 3, 0, 0), run(8, "running", 0, 0, 0)];
  it("KPIs, daily series and per-pipeline stats are plain counts over the runs", () => {
    const summary = summarizeRuns(runs, { now, days: 7 });
    expect(summary.kpis).toMatchObject({ runs: 7, successes: 5, failures: 2, successRate: 71.4, rowsProcessed: 500, inProgress: 1, medianDurationMs: 11 });
    expect(summary.days).toHaveLength(7);
    expect(summary.days.at(-1)).toMatchObject({ day: "2026-09-30", success: 0, failed: 2 });
    expect(summary.pipelines[0]).toMatchObject({ runs: 7, failures: 2, consecutiveFailures: 2, lastRun: { id: 7, status: "failed" } });
  });
  it("flags duration spikes and volume changes against the previous successful runs, naming them", () => {
    const anomalies = detectAnomalies(runs);
    expect(anomalies.map(item => [item.kind, item.runId])).toEqual([["volume_change", 5], ["duration_spike", 4]]);
    expect(anomalies.find(item => item.kind === "duration_spike")).toMatchObject({ baseline: 11, baselineRunIds: [1, 2, 3] });
    expect(anomalies.find(item => item.kind === "volume_change")).toMatchObject({ observed: 20, baseline: 100, severity: "warning", message: expect.stringMatching(/-80%/) });
  });
  it("needs a baseline: no anomalies from fewer than 3 prior successes; failed runs are not anomalies", () => {
    expect(detectAnomalies([run(1, "success", 10, 100), run(2, "success", 5000, 1)])).toEqual([]);
    expect(detectAnomalies([run(1, "success", 10, 10, 0, { coercionFailures: 6 })])[0]).toMatchObject({ kind: "coercion_failures", severity: "critical" });
  });
});

describe("daily buckets use the viewer's calendar day", () => {
  it("a 01:00 IST run counts on that IST day, not the previous UTC day", async () => {
    const { localDay, summarizeRuns } = await import("./monitoring");
    expect(localDay("2026-09-29T19:30:00Z", 330)).toBe("2026-09-30");
    expect(localDay("2026-09-29T19:30:00Z", 0)).toBe("2026-09-29");
    const run = { id: 1, pipelineId: 1, status: "success", startedAt: "2026-09-29T19:30:00Z", completedAt: "2026-09-29T19:30:01Z", durationMs: 1000, rowsIn: 1, rowsOut: 1, coercionFailures: 0 } as never;
    const ist = summarizeRuns([run], { now: new Date("2026-09-30T06:00:00Z"), days: 2, utcOffsetMinutes: 330 });
    expect(ist.days.map(day => [day.day, day.success])).toEqual([["2026-09-29", 0], ["2026-09-30", 1]]);
  });
});
