import type { Row } from "./transformations";

/**
 * Phase 3 — pipeline run lifecycle, constrained by pipeline_runs.status CHECK
 * (created | running | success | failed):
 *
 *   created  → the run row is committed before any work starts (authoritative record exists)
 *   running  → the server has begun loading the source and executing steps
 *   success  → set ONLY in the same transaction that writes the output dataset
 *   failed   → a meaningful error_message is stored; nothing partial is written
 *
 * A run left in created/running by a crashed server is closed as failed
 * ("interrupted") after RUN_STALE_AFTER_MS, the next time runs are read or started.
 */
export const RUN_STATUSES = ["created", "running", "success", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES: RunStatus[] = ["created", "running"];
export const RUN_STALE_AFTER_MS = 15 * 60 * 1000;
export const RUN_SAMPLE_ROWS = 10;

/** Pipeline registry status derived from the latest finished run. */
export type PipelineHealth = "HEALTHY" | "WARNING" | "FAILED";

export type RunLogEntry = { at: string; level: "info" | "warn" | "error"; message: string };
export type RunStepResult = { order: number; operation: string; description: string; rowsIn: number; rowsOut: number; coercionFailures: number; effect: string };
export type RunOutput = { mode: "new_dataset" | "overwrite_existing"; datasetId: number; datasetName: string; columns: string[]; rowCount: number; qualityScore: number };

/** Shape stored in pipeline_runs.logs (jsonb). */
export type RunLog = {
  version: 1;
  entries: RunLogEntry[];
  source: { datasetId: number; name: string; rowCount: number } | null;
  steps: RunStepResult[];
  output: RunOutput | null;
  /** First rows actually written by this run (the destination may be overwritten later). */
  sample: Row[];
};

export function emptyRunLog(): RunLog {
  return { version: 1, entries: [], source: null, steps: [], output: null, sample: [] };
}

/** Tolerant reader: pipeline_runs.logs is jsonb and may be null or older-shaped. */
export function parseRunLog(value: unknown): RunLog {
  const raw = typeof value === "string" ? safeJson(value) : value;
  const log = emptyRunLog();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return log;
  const input = raw as Partial<RunLog>;
  return {
    version: 1,
    entries: Array.isArray(input.entries) ? input.entries : [],
    source: input.source ?? null,
    steps: Array.isArray(input.steps) ? input.steps : [],
    output: input.output ?? null,
    sample: Array.isArray(input.sample) ? input.sample : [],
  };
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}
