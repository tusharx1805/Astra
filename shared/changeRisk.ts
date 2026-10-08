import { inferColumns, type ColumnProfile } from "./datasetProfile";
import { columnsAfterSteps, validatePipelineSteps, type DestinationMode } from "./pipelineDefinition";
import { applyTransformSteps, type Row, type TransformStep } from "./transformations";

/**
 * Phase 4 — "pipeline-impact" risk engine.
 *
 * The change Astra can reliably obtain from its own data flow is a proposed
 * pipeline definition (new or edited). This engine evaluates that proposal
 * against REAL stored data: it executes the current and proposed definitions
 * over the source dataset's stored rows with the shared transformation engine,
 * diffs the outputs, checks every downstream pipeline that reads the dataset
 * this pipeline overwrites, and looks at the pipeline's stored run history.
 * Every factor carries the evidence (names, counts) it was derived from.
 *
 * Pure and deterministic: the server builds the context from the database;
 * tests can build it by hand. No LLM, no randomness, nothing simulated.
 */

export const RISK_ENGINE = "pipeline-impact" as const;
export const RISK_ENGINE_VERSION = "pipeline-impact/1.0.0";
export const CHANGE_SOURCE_KIND = "pipeline_definition" as const;

export type RiskLevel = "SAFE" | "MEDIUM" | "HIGH" | "CRITICAL";
export type FactorTone = "critical" | "warning" | "neutral";

export type PipelineDefinitionSnapshot = {
  name: string;
  sourceDatasetId: number;
  destinationMode: DestinationMode;
  destinationDatasetId: number | null;
  steps: TransformStep[];
};

/** Exactly what is stored in changes.source (JSON): the full, self-contained input of the analysis. */
export type PipelineChangeSource = {
  kind: typeof CHANGE_SOURCE_KIND;
  version: 1;
  workspaceId: number;
  pipelineId: number | null;
  /** Definition version (Phase 2 hash) the proposal was made against; null for a new pipeline. */
  baseVersion: string | null;
  current: PipelineDefinitionSnapshot | null;
  proposed: PipelineDefinitionSnapshot;
};

export type ImpactContext = {
  change: PipelineChangeSource;
  source: { id: number; name: string; columns: string[]; rows: Row[] };
  /** Only for overwrite_existing: the dataset every successful run replaces. */
  destination: { id: number; name: string; rowCount: number; columns: string[] } | null;
  /** Other pipelines in the workspace whose source is the proposed destination dataset. */
  downstream: Array<{ id: number; name: string; steps: TransformStep[] }>;
  /** Stored runs of the pipeline being changed (finished runs only). */
  history: { finished: number; failed: number };
  now?: Date;
};

export type RiskFactor = { code: string; label: string; weight: number; tone: FactorTone; evidence: string };
export type AffectedEntity = { type: "dataset" | "pipeline"; id: number; name: string; owner: string; severity: RiskLevel };

export type ChangeRiskResult = {
  engine: typeof RISK_ENGINE;
  engineVersion: typeof RISK_ENGINE_VERSION;
  score: number;
  level: RiskLevel;
  summary: string;
  factors: RiskFactor[];
  explanation: string[];
  affectedEntities: AffectedEntity[];
  analysisStages: Array<{ label: string; status: "complete"; detail: string }>;
  metrics: {
    sourceRows: number;
    currentRowsOut: number | null;
    proposedRowsOut: number;
    currentColumns: string[] | null;
    proposedColumns: string[];
    removedColumns: string[];
    addedColumns: string[];
    typeChanges: Array<{ column: string; from: string; to: string }>;
    coercionFailures: number;
    definitionIssues: string[];
    downstreamChecked: number;
    downstreamBroken: Array<{ pipelineId: number; name: string; issues: string[] }>;
    runHistory: { finished: number; failed: number };
  };
  /** Snapshot of the data the analysis was computed from (traceability). */
  inputs: { sourceDatasetId: number; sourceDatasetName: string; sourceRowCount: number; sourceColumns: string[]; destinationDatasetId: number | null; destinationRowCount: number | null; analyzedAt: string };
};

export function levelFor(score: number): RiskLevel {
  if (score >= 80) return "CRITICAL";
  if (score >= 60) return "HIGH";
  if (score >= 35) return "MEDIUM";
  return "SAFE";
}

const BASE_SCORE = 5;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const list = (items: string[]) => items.map(item => `"${item}"`).join(", ");
const typesOf = (profiles: ColumnProfile[]) => new Map(profiles.map(profile => [profile.name, profile.dataType as string]));

export function analyzePipelineChange(context: ImpactContext): ChangeRiskResult {
  const { change, source, destination, downstream, history } = context;
  const { proposed, current } = change;
  const factors: RiskFactor[] = [];
  const add = (code: string, label: string, weight: number, tone: FactorTone, evidence: string) => factors.push({ code, label, weight, tone, evidence });

  // 1) Validate the proposal against the stored source columns.
  const definitionIssues = validatePipelineSteps(proposed.steps, source.columns).map(issue => issue.message);
  const valid = definitionIssues.length === 0;

  // 2) Execute current and proposed definitions over the same stored rows.
  const proposedRun = valid ? applyTransformSteps(source.rows, proposed.steps) : null;
  const proposedColumns = valid ? columnsAfterSteps(proposed.steps, source.columns) : [];
  const proposedRowsOut = proposedRun?.rows.length ?? 0;
  const currentValid = current ? validatePipelineSteps(current.steps, source.columns).length === 0 && current.sourceDatasetId === proposed.sourceDatasetId : false;
  const currentRun = current && currentValid ? applyTransformSteps(source.rows, current.steps) : null;
  const currentColumns = currentRun && current ? columnsAfterSteps(current.steps, source.columns) : null;
  const currentRowsOut = currentRun ? currentRun.rows.length : null;

  // 3) Output schema diff (current output vs proposed output).
  const removedColumns = currentColumns ? currentColumns.filter(column => !proposedColumns.includes(column)) : [];
  const addedColumns = currentColumns ? proposedColumns.filter(column => !currentColumns.includes(column)) : [];
  const typeChanges: Array<{ column: string; from: string; to: string }> = [];
  if (currentRun && proposedRun && currentColumns) {
    const before = typesOf(inferColumns(currentRun.rows, currentColumns));
    const after = typesOf(inferColumns(proposedRun.rows, proposedColumns));
    for (const column of proposedColumns) {
      const from = before.get(column), to = after.get(column);
      if (from && to && from !== to && currentRun.rows.length && proposedRun.rows.length) typeChanges.push({ column, from, to });
    }
  }

  // 4) Downstream pipelines that read the dataset this pipeline overwrites.
  const downstreamBroken: Array<{ pipelineId: number; name: string; issues: string[] }> = [];
  if (valid && proposed.destinationMode === "overwrite_existing") {
    for (const reader of downstream) {
      const issues = validatePipelineSteps(reader.steps, proposedColumns).map(issue => issue.message);
      if (issues.length) downstreamBroken.push({ pipelineId: reader.id, name: reader.name, issues });
    }
  }

  // 5) Score. Each factor's weight is its contribution to the 0–100 score.
  if (!valid) add("invalid_definition", "Proposed definition does not match the stored source", 60, "critical", `${plural(definitionIssues.length, "issue")} against "${source.name}": ${definitionIssues.join(" ")}`);
  if (current && current.sourceDatasetId !== proposed.sourceDatasetId) add("source_changed", "Reads from a different source dataset", 15, "warning", `Source changes to "${source.name}"; every downstream consumer of this pipeline's output will receive different data.`);
  if (downstreamBroken.length) add("downstream_break", `Breaks ${plural(downstreamBroken.length, "downstream pipeline")}`, Math.min(75, 60 + 15 * (downstreamBroken.length - 1)), "critical", downstreamBroken.map(item => `"${item.name}": ${item.issues.join(" ")}`).join(" | "));
  if (valid && proposed.destinationMode === "overwrite_existing" && destination) {
    add("destructive_overwrite", `Overwrites "${destination.name}" on every run`, 10, "warning", `Each successful run replaces all ${destination.rowCount} stored rows of "${destination.name}".`);
    if (destination.rowCount > 0 && proposedRowsOut < destination.rowCount * 0.5) add("destination_shrink", "Destination would lose most of its rows", 15, "warning", `"${destination.name}" would go from ${destination.rowCount} to ${proposedRowsOut} rows.`);
    const lostFromDestination = destination.columns.filter(column => !proposedColumns.includes(column));
    if (lostFromDestination.length && !currentColumns) add("destination_columns_lost", "Destination would lose columns", Math.min(24, 8 * lostFromDestination.length), "warning", `Columns ${list(lostFromDestination)} exist in "${destination.name}" today and would not after the first run.`);
  }
  if (removedColumns.length) add("columns_removed", `Removes ${plural(removedColumns.length, "output column")}`, Math.min(24, 8 * removedColumns.length), "warning", `No longer produced: ${list(removedColumns)}.`);
  if (addedColumns.length) add("columns_added", `Adds ${plural(addedColumns.length, "output column")}`, 2, "neutral", `Newly produced: ${list(addedColumns)}.`);
  if (typeChanges.length) add("type_change", `Changes the type of ${plural(typeChanges.length, "column")}`, Math.min(20, 10 * typeChanges.length), "warning", typeChanges.map(item => `"${item.column}": ${item.from} → ${item.to}`).join(", ") + ".");
  if (valid && source.rows.length > 0 && proposedRowsOut === 0) add("empty_output", "Produces no rows", 55, "critical", `All ${source.rows.length} stored source rows are filtered out.`);
  else if (currentRowsOut !== null && currentRowsOut > 0 && proposedRowsOut < currentRowsOut) {
    const lost = (currentRowsOut - proposedRowsOut) / currentRowsOut;
    const pct = Math.round(lost * 100);
    if (lost >= 0.9) add("row_loss", `Drops ${pct}% of the rows the pipeline outputs today`, 25, "critical", `${currentRowsOut} → ${proposedRowsOut} rows on the same stored input.`);
    else if (lost >= 0.5) add("row_loss", `Drops ${pct}% of the rows the pipeline outputs today`, 15, "warning", `${currentRowsOut} → ${proposedRowsOut} rows on the same stored input.`);
    else if (lost >= 0.1) add("row_loss", `Drops ${pct}% of the rows the pipeline outputs today`, 5, "neutral", `${currentRowsOut} → ${proposedRowsOut} rows on the same stored input.`);
  }
  const coercionFailures = proposedRun?.coercionFailures ?? 0;
  if (coercionFailures) {
    const share = proposedRowsOut ? coercionFailures / proposedRowsOut : 1;
    add("coercion_failures", "Type conversion will null out values", share >= 0.5 ? 30 : share >= 0.1 ? 20 : 10, share >= 0.5 ? "critical" : "warning", `${coercionFailures} value(s) cannot be converted and would become null (${Math.round(share * 100)}% of output rows).`);
  }
  if (history.finished >= 2 && history.failed / history.finished >= 0.5) add("unstable_history", "This pipeline fails often", 10, "warning", `${history.failed} of its last ${history.finished} stored runs failed.`);
  if (!factors.length) add("no_impact", "No breaking impact found on stored data", 0, "neutral", "Outputs, columns and downstream readers were checked against the stored rows.");

  const score = Math.min(100, BASE_SCORE + factors.reduce((sum, factor) => sum + factor.weight, 0));
  const level = levelFor(score);

  // 6) Blast radius: real entities only.
  const affectedEntities: AffectedEntity[] = [{ type: "dataset", id: source.id, name: source.name, owner: "SOURCE · read only", severity: "SAFE" }];
  if (destination) affectedEntities.push({ type: "dataset", id: destination.id, name: destination.name, owner: "DESTINATION · overwritten each run", severity: downstreamBroken.length ? "CRITICAL" : factors.some(f => f.code === "destination_shrink" || f.code === "destination_columns_lost") ? "HIGH" : "MEDIUM" });
  for (const reader of downstream) {
    const broken = downstreamBroken.some(item => item.pipelineId === reader.id);
    affectedEntities.push({ type: "pipeline", id: reader.id, name: reader.name, owner: broken ? "DOWNSTREAM · would fail" : "DOWNSTREAM · still valid", severity: broken ? "CRITICAL" : "SAFE" });
  }

  const summary = !valid ? "The proposal cannot run against the stored source; fix the definition first."
    : level === "CRITICAL" ? "Deploying this change would break or empty data that others depend on. Review required."
    : level === "HIGH" ? "Significant impact on stored data. Review the factors before saving."
    : level === "MEDIUM" ? "Noticeable impact on outputs; check the factors below."
    : "No significant impact found on the stored data.";

  const explanation = [
    `Evaluated against ${plural(source.rows.length, "stored row")} and ${plural(source.columns.length, "column")} of "${source.name}".`,
    current
      ? currentRowsOut !== null
        ? `Today's definition outputs ${currentRowsOut} rows and ${plural(currentColumns!.length, "column")}; the proposal outputs ${proposedRowsOut} rows and ${plural(proposedColumns.length, "column")}.`
        : "Today's definition could not be executed on this source, so outputs were not compared."
      : `New pipeline: the proposal outputs ${proposedRowsOut} rows and ${plural(proposedColumns.length, "column")}.`,
    proposed.destinationMode === "overwrite_existing"
      ? `${plural(downstream.length, "other pipeline")} read${downstream.length === 1 ? "s" : ""} the destination; ${downstreamBroken.length} would fail after this change.`
      : "Output goes to a new dataset per run, so no existing dataset or downstream pipeline is overwritten.",
    ...factors.filter(factor => factor.weight > 0).map(factor => `${factor.label}: ${factor.evidence}`),
  ];

  const analysisStages = [
    { label: "Change recorded", detail: current ? `Edit of "${current.name}"` : `New pipeline "${proposed.name}"` },
    { label: "Definition validated", detail: valid ? "Valid against stored columns" : plural(definitionIssues.length, "issue") },
    { label: "Executed on stored rows", detail: `${source.rows.length} rows · current ${currentRowsOut ?? "n/a"} → proposed ${proposedRowsOut}` },
    { label: "Output schema compared", detail: `${removedColumns.length} removed · ${addedColumns.length} added · ${typeChanges.length} retyped` },
    { label: "Downstream pipelines checked", detail: `${downstream.length} checked · ${downstreamBroken.length} broken` },
    { label: "Run history checked", detail: `${history.failed}/${history.finished} failed` },
    { label: "Risk scored", detail: `${score}/100 · ${level}` },
  ].map(stage => ({ ...stage, status: "complete" as const }));

  return {
    engine: RISK_ENGINE,
    engineVersion: RISK_ENGINE_VERSION,
    score,
    level,
    summary,
    factors,
    explanation,
    affectedEntities,
    analysisStages,
    metrics: { sourceRows: source.rows.length, currentRowsOut, proposedRowsOut, currentColumns, proposedColumns, removedColumns, addedColumns, typeChanges, coercionFailures, definitionIssues, downstreamChecked: downstream.length, downstreamBroken, runHistory: history },
    inputs: { sourceDatasetId: source.id, sourceDatasetName: source.name, sourceRowCount: source.rows.length, sourceColumns: source.columns, destinationDatasetId: destination?.id ?? null, destinationRowCount: destination?.rowCount ?? null, analyzedAt: (context.now ?? new Date()).toISOString() },
  };
}

/** Human title for a change record. */
export function changeTitle(change: PipelineChangeSource) {
  if (!change.current) return `New pipeline "${change.proposed.name}" (${plural(change.proposed.steps.length, "step")})`.slice(0, 160);
  const renamed = change.current.name !== change.proposed.name ? ` → "${change.proposed.name}"` : "";
  return `Edit "${change.current.name}"${renamed} (${change.current.steps.length} → ${plural(change.proposed.steps.length, "step")})`.slice(0, 160);
}
