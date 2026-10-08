import { z } from "zod";
import type { TransformStep } from "./transformations";

/**
 * Phase 2 — the pipeline definition contract shared by the builder UI and the server.
 *
 * UI step model  →  pipeline_steps row
 *   steps[i]         step_order = i (0-based, contiguous)
 *   step.operation   operation  (varchar, CHECK-constrained to the five engine operations)
 *   rest of step     config     (jsonb, only the fields that operation needs)
 *
 * The step shape is exactly TransformStep from transformations.ts, so a stored
 * definition feeds applyTransformSteps() unchanged. Execution is NOT done here.
 */

export const PIPELINE_LIMITS = { maxSteps: 32, maxName: 160, maxIdentifier: 160, maxValue: 500 } as const;

export const PIPELINE_OPERATIONS = ["filter", "rename_column", "change_datatype", "drop_column", "remove_nulls"] as const;
export const FILTER_OPERATORS = ["equals", "not_equals", "gt", "lt", "gte", "lte", "contains", "is_null", "is_not_null"] as const;
export const NUMERIC_FILTER_OPERATORS = ["gt", "lt", "gte", "lte"] as const;
export const VALUELESS_FILTER_OPERATORS = ["is_null", "is_not_null"] as const;
export const DATATYPES = ["string", "number", "boolean", "date"] as const;
export const DESTINATION_MODES = ["new_dataset", "overwrite_existing"] as const;

export type PipelineOperation = (typeof PIPELINE_OPERATIONS)[number];
export type DestinationMode = (typeof DESTINATION_MODES)[number];

const identifier = z.string().trim().min(1, "A column name is required.").max(PIPELINE_LIMITS.maxIdentifier);

export const transformStepSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("filter"), column: identifier, operator: z.enum(FILTER_OPERATORS), value: z.union([z.string().max(PIPELINE_LIMITS.maxValue), z.number().finite()]).optional() }).strict(),
  z.object({ operation: z.literal("rename_column"), from: identifier, to: identifier }).strict(),
  z.object({ operation: z.literal("change_datatype"), column: identifier, toType: z.enum(DATATYPES) }).strict(),
  z.object({ operation: z.literal("drop_column"), column: identifier }).strict(),
  z.object({ operation: z.literal("remove_nulls"), column: identifier }).strict(),
]);

export const pipelineStepsSchema = z.array(transformStepSchema).max(PIPELINE_LIMITS.maxSteps, `A pipeline can have at most ${PIPELINE_LIMITS.maxSteps} steps.`);

export type StepRecord = { stepOrder: number; operation: PipelineOperation; config: Record<string, unknown> };

/** UI/engine step → pipeline_steps row values. */
export function toStepRecord(step: TransformStep, stepOrder: number): StepRecord {
  const { operation, ...config } = step;
  return { stepOrder, operation, config: config as Record<string, unknown> };
}

/** pipeline_steps row → engine step. Returns null for a row that no longer matches the contract. */
export function fromStepRecord(record: { operation: string; config: unknown }): TransformStep | null {
  const config = typeof record.config === "string" ? safeJson(record.config) : record.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const parsed = transformStepSchema.safeParse({ ...(config as Record<string, unknown>), operation: record.operation });
  return parsed.success ? (parsed.data as TransformStep) : null;
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Canonical form stored in config: value-less filters carry no value, numeric
 * comparisons store a number, everything else keeps the value as text.
 * applyTransformSteps() behaves identically on the normalized step.
 */
export function normalizeStep(step: TransformStep): TransformStep {
  if (step.operation !== "filter") return step;
  const { value, ...rest } = step;
  if ((VALUELESS_FILTER_OPERATORS as readonly string[]).includes(step.operator)) return rest;
  if ((NUMERIC_FILTER_OPERATORS as readonly string[]).includes(step.operator) && value !== undefined && Number.isFinite(Number(value))) return { ...rest, value: Number(value) };
  return { ...rest, value: value === undefined ? undefined : String(value) };
}

export type StepIssue ={ stepIndex: number; message: string };

/**
 * Walk the ordered steps against the source dataset's columns, tracking renames
 * and drops, and report every step that references a column that will not exist
 * at that point, or that is missing a required input. Pure and deterministic;
 * the server calls it before persisting, the builder calls it for inline errors.
 */
export function validatePipelineSteps(steps: TransformStep[], sourceColumns: string[]): StepIssue[] {
  const issues: StepIssue[] = [];
  const columns = new Set(sourceColumns);
  const missing = (index: number, column: string) => issues.push({ stepIndex: index, message: `Step ${index + 1}: column "${column}" does not exist at this point in the pipeline.` });
  if (steps.length > PIPELINE_LIMITS.maxSteps) issues.push({ stepIndex: PIPELINE_LIMITS.maxSteps, message: `A pipeline can have at most ${PIPELINE_LIMITS.maxSteps} steps.` });
  steps.forEach((step, index) => {
    switch (step.operation) {
      case "filter": {
        if (!columns.has(step.column)) missing(index, step.column);
        const valueless = (VALUELESS_FILTER_OPERATORS as readonly string[]).includes(step.operator);
        const text = step.value === undefined || step.value === null ? "" : String(step.value).trim();
        if (!valueless && text === "") issues.push({ stepIndex: index, message: `Step ${index + 1}: the "${step.operator}" filter needs a value.` });
        if ((NUMERIC_FILTER_OPERATORS as readonly string[]).includes(step.operator) && text !== "" && !Number.isFinite(Number(text))) issues.push({ stepIndex: index, message: `Step ${index + 1}: the "${step.operator}" filter needs a numeric value.` });
        break;
      }
      case "rename_column":
        if (!columns.has(step.from)) missing(index, step.from);
        else if (!step.to.trim()) issues.push({ stepIndex: index, message: `Step ${index + 1}: enter the new column name.` });
        else if (step.from === step.to) issues.push({ stepIndex: index, message: `Step ${index + 1}: the new name must differ from "${step.from}".` });
        else if (columns.has(step.to)) issues.push({ stepIndex: index, message: `Step ${index + 1}: a column named "${step.to}" already exists.` });
        else { columns.delete(step.from); columns.add(step.to); }
        break;
      case "change_datatype":
        if (!columns.has(step.column)) missing(index, step.column);
        break;
      case "drop_column":
        if (!columns.has(step.column)) missing(index, step.column);
        else columns.delete(step.column);
        break;
      case "remove_nulls":
        if (step.column !== "any" && !columns.has(step.column)) missing(index, step.column);
        break;
    }
  });
  if (sourceColumns.length && columns.size === 0) issues.push({ stepIndex: Math.max(0, steps.length - 1), message: "The pipeline drops every column; the output would be empty." });
  return issues;
}

/** Columns available after the first `upTo` steps (used by the builder's column pickers). */
export function columnsAfterSteps(steps: TransformStep[], sourceColumns: string[], upTo = steps.length): string[] {
  const columns = [...sourceColumns];
  for (const step of steps.slice(0, upTo)) {
    if (step.operation === "rename_column") {
      const position = columns.indexOf(step.from);
      if (position >= 0 && !columns.includes(step.to)) columns[position] = step.to;
    } else if (step.operation === "drop_column") {
      const position = columns.indexOf(step.column);
      if (position >= 0) columns.splice(position, 1);
    }
  }
  return columns;
}

export function describeStep(step: TransformStep): string {
  if (step.operation === "filter") return `Filter ${step.column} ${step.operator.replace(/_/g, " ")}${(VALUELESS_FILTER_OPERATORS as readonly string[]).includes(step.operator) ? "" : ` ${String(step.value ?? "")}`}`;
  if (step.operation === "rename_column") return `Rename ${step.from} → ${step.to}`;
  if (step.operation === "change_datatype") return `Convert ${step.column} → ${step.toType}`;
  if (step.operation === "drop_column") return `Drop ${step.column}`;
  return `Remove nulls · ${step.column}`;
}
