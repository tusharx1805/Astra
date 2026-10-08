/**
 * Phase 7 — monitoring computed ONLY from stored pipeline_runs rows.
 * Every number here can be re-derived with a SQL query over pipeline_runs;
 * anomalies name the run they flag and the baseline runs they compare against.
 */

export type RunRecord = { id: number; pipelineId: number; pipelineName: string; status: string; rowsIn: number; rowsOut: number; coercionFailures: number; durationMs: number; startedAt: string | Date; completedAt: string | Date | null };

export type AnomalyKind = "duration_spike" | "volume_change" | "coercion_failures";
export type Anomaly = { id: string; kind: AnomalyKind; runId: number; pipelineId: number; pipelineName: string; at: string; severity: "warning" | "critical"; observed: number; baseline: number | null; baselineRunIds: number[]; message: string };

/** Rules, stated so they can be shown to users verbatim. */
export const ANOMALY_RULES = {
  minBaselineRuns: 3,
  baselineWindow: 10,
  durationFactor: 3,
  durationMinExtraMs: 250,
  volumeChange: 0.5,
} as const;

const iso = (value: string | Date) => new Date(value).toISOString();
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const finished = (run: RunRecord) => run.status === "success" || run.status === "failed";

export function detectAnomalies(runs: RunRecord[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const byPipeline = new Map<number, RunRecord[]>();
  for (const run of runs) byPipeline.set(run.pipelineId, [...(byPipeline.get(run.pipelineId) ?? []), run]);
  byPipeline.forEach(list => {
    const successes = list.filter(run => run.status === "success").sort((a, b) => a.id - b.id);
    successes.forEach((run, index) => {
      if (run.coercionFailures > 0) anomalies.push({ id: `coercion_failures:${run.id}`, kind: "coercion_failures", runId: run.id, pipelineId: run.pipelineId, pipelineName: run.pipelineName, at: iso(run.startedAt), severity: run.rowsOut && run.coercionFailures / run.rowsOut >= 0.5 ? "critical" : "warning", observed: run.coercionFailures, baseline: null, baselineRunIds: [], message: `${run.coercionFailures} value(s) could not be converted and were stored as null.` });
      const previous = successes.slice(Math.max(0, index - ANOMALY_RULES.baselineWindow), index);
      if (previous.length < ANOMALY_RULES.minBaselineRuns) return;
      const baselineIds = previous.map(item => item.id);
      const durationBase = median(previous.map(item => item.durationMs));
      if (run.durationMs > durationBase * ANOMALY_RULES.durationFactor && run.durationMs - durationBase >= ANOMALY_RULES.durationMinExtraMs) {
        anomalies.push({ id: `duration_spike:${run.id}`, kind: "duration_spike", runId: run.id, pipelineId: run.pipelineId, pipelineName: run.pipelineName, at: iso(run.startedAt), severity: "warning", observed: run.durationMs, baseline: durationBase, baselineRunIds: baselineIds, message: `Took ${run.durationMs} ms vs a median of ${durationBase} ms over the previous ${previous.length} successful runs.` });
      }
      const volumeBase = median(previous.map(item => item.rowsOut));
      if (volumeBase > 0 && Math.abs(run.rowsOut - volumeBase) / volumeBase >= ANOMALY_RULES.volumeChange) {
        const pct = Math.round(((run.rowsOut - volumeBase) / volumeBase) * 100);
        anomalies.push({ id: `volume_change:${run.id}`, kind: "volume_change", runId: run.id, pipelineId: run.pipelineId, pipelineName: run.pipelineName, at: iso(run.startedAt), severity: Math.abs(pct) >= 90 ? "critical" : "warning", observed: run.rowsOut, baseline: volumeBase, baselineRunIds: baselineIds, message: `Output ${run.rowsOut} rows vs a median of ${volumeBase} (${pct > 0 ? "+" : ""}${pct}%) over the previous ${previous.length} successful runs.` });
      }
    });
  });
  return anomalies.sort((a, b) => b.runId - a.runId || a.kind.localeCompare(b.kind));
}

export type DailyPoint = { day: string; success: number; failed: number; avgDurationMs: number | null };

/** Calendar day of a timestamp for a viewer at `utcOffsetMinutes` (IST = +330). */
export const localDay = (value: string | Date, utcOffsetMinutes = 0) => new Date(new Date(value).getTime() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);

export function summarizeRuns(runs: RunRecord[], options: { now: Date; days: number; utcOffsetMinutes?: number }) {
  const offsetMinutes = options.utcOffsetMinutes ?? 0;
  const since = new Date(options.now.getTime() - options.days * 86_400_000);
  const inWindow = runs.filter(run => new Date(run.startedAt) >= since);
  const done = inWindow.filter(finished);
  const successes = done.filter(run => run.status === "success");
  const failures = done.filter(run => run.status === "failed");

  const days: DailyPoint[] = [];
  for (let offset = options.days - 1; offset >= 0; offset -= 1) {
    const day = localDay(new Date(options.now.getTime() - offset * 86_400_000), offsetMinutes);
    const today = done.filter(run => localDay(run.startedAt, offsetMinutes) === day);
    const ok = today.filter(run => run.status === "success");
    days.push({ day, success: ok.length, failed: today.length - ok.length, avgDurationMs: ok.length ? Math.round(ok.reduce((sum, run) => sum + run.durationMs, 0) / ok.length) : null });
  }

  const byPipeline = new Map<number, RunRecord[]>();
  for (const run of inWindow) byPipeline.set(run.pipelineId, [...(byPipeline.get(run.pipelineId) ?? []), run]);
  const pipelines = Array.from(byPipeline.values()).map(list => {
    const sorted = [...list].sort((a, b) => b.id - a.id);
    const finishedRuns = sorted.filter(finished);
    const ok = finishedRuns.filter(run => run.status === "success");
    let consecutiveFailures = 0;
    for (const run of finishedRuns) { if (run.status === "failed") consecutiveFailures += 1; else break; }
    return {
      pipelineId: sorted[0]!.pipelineId, pipelineName: sorted[0]!.pipelineName,
      runs: finishedRuns.length, successes: ok.length, failures: finishedRuns.length - ok.length,
      successRate: finishedRuns.length ? Math.round((ok.length / finishedRuns.length) * 1000) / 10 : null,
      avgDurationMs: ok.length ? Math.round(ok.reduce((sum, run) => sum + run.durationMs, 0) / ok.length) : null,
      lastRun: finishedRuns[0] ? { id: finishedRuns[0].id, status: finishedRuns[0].status, at: iso(finishedRuns[0].startedAt), rowsOut: finishedRuns[0].rowsOut } : null,
      consecutiveFailures,
    };
  }).sort((a, b) => (b.lastRun?.id ?? 0) - (a.lastRun?.id ?? 0));

  return {
    window: { days: options.days, since: since.toISOString(), until: options.now.toISOString() },
    kpis: {
      runs: done.length,
      successes: successes.length,
      failures: failures.length,
      successRate: done.length ? Math.round((successes.length / done.length) * 1000) / 10 : null,
      avgDurationMs: successes.length ? Math.round(successes.reduce((sum, run) => sum + run.durationMs, 0) / successes.length) : null,
      medianDurationMs: successes.length ? median(successes.map(run => run.durationMs)) : null,
      rowsProcessed: successes.reduce((sum, run) => sum + run.rowsIn, 0),
      inProgress: inWindow.filter(run => run.status === "created" || run.status === "running").length,
    },
    days,
    pipelines,
  };
}
