import { z } from "zod";
import type { Row } from "./transformations";

/**
 * Phase 7 — data-quality checks. A check is a rule a person defines on one
 * dataset; evaluation reads the dataset's STORED rows and is deterministic, so
 * any result can be reproduced by re-running the same check on the same rows.
 */

export const CHECK_TYPES = ["not_null", "unique", "allowed_values", "range", "row_count"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];
export const CHECK_SEVERITIES = ["warning", "critical"] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];

const column = z.string().trim().min(1).max(160);
const finite = z.number().finite();

export const checkDefinitionSchema = z.discriminatedUnion("checkType", [
  z.object({ checkType: z.literal("not_null"), columnName: column, config: z.object({}).strict().default({}) }),
  z.object({ checkType: z.literal("unique"), columnName: column, config: z.object({}).strict().default({}) }),
  z.object({ checkType: z.literal("allowed_values"), columnName: column, config: z.object({ values: z.array(z.string().max(200)).min(1).max(50) }).strict() }),
  z.object({ checkType: z.literal("range"), columnName: column, config: z.object({ min: finite.optional(), max: finite.optional() }).strict().refine(value => value.min !== undefined || value.max !== undefined, "Give a minimum, a maximum, or both.").refine(value => value.min === undefined || value.max === undefined || value.min <= value.max, "Minimum must not exceed maximum.") }),
  z.object({ checkType: z.literal("row_count"), columnName: z.null().optional(), config: z.object({ min: z.number().int().min(0).optional(), max: z.number().int().min(0).optional() }).strict().refine(value => value.min !== undefined || value.max !== undefined, "Give a minimum, a maximum, or both.").refine(value => value.min === undefined || value.max === undefined || value.min <= value.max, "Minimum must not exceed maximum.") }),
]);
export type CheckDefinition = z.infer<typeof checkDefinitionSchema>;

export type QualityStatus = "pass" | "fail" | "error";
export type QualityEvaluation = {
  status: QualityStatus;
  evaluatedRows: number;
  failingRows: number;
  observed: { message: string; measured?: number | string | null; sample: Array<{ rowIndex: number; value: string }> };
};

const SAMPLE = 5;
const isNull = (value: unknown) => value === null || value === undefined || value === "";
const show = (value: unknown) => (isNull(value) ? "∅" : String(value));

export function describeCheck(check: { checkType: string; columnName?: string | null; config?: unknown }): string {
  const config = (check.config ?? {}) as { values?: string[]; min?: number; max?: number };
  const col = check.columnName ?? "";
  const bounds = (unit = "") => config.min !== undefined && config.max !== undefined ? `between ${config.min} and ${config.max}${unit}` : config.min !== undefined ? `at least ${config.min}${unit}` : `at most ${config.max}${unit}`;
  switch (check.checkType) {
    case "not_null": return `${col} is never empty`;
    case "unique": return `${col} has no duplicate values`;
    case "allowed_values": return `${col} is one of: ${(config.values ?? []).join(", ")}`;
    case "range": return `${col} is a number ${bounds()}`;
    case "row_count": return `row count is ${bounds(" rows")}`;
    default: return check.checkType;
  }
}

/** Evaluate one check against stored rows. `columns` are the dataset's stored column names. */
export function evaluateCheck(check: CheckDefinition | { checkType: string; columnName?: string | null; config?: unknown }, rows: Row[], columns: string[]): QualityEvaluation {
  const parsed = checkDefinitionSchema.safeParse({ ...check, columnName: check.columnName ?? null, config: check.config ?? {} });
  if (!parsed.success) return { status: "error", evaluatedRows: rows.length, failingRows: 0, observed: { message: "The stored check definition is not valid.", sample: [] } };
  const def = parsed.data;
  if (def.checkType === "row_count") {
    const { min, max } = def.config;
    const ok = (min === undefined || rows.length >= min) && (max === undefined || rows.length <= max);
    return { status: ok ? "pass" : "fail", evaluatedRows: rows.length, failingRows: 0, observed: { message: `${rows.length} rows; expected ${describeCheck(def).replace("row count is ", "")}.`, measured: rows.length, sample: [] } };
  }
  const name = def.columnName;
  if (!columns.includes(name)) return { status: "error", evaluatedRows: rows.length, failingRows: 0, observed: { message: `Column "${name}" does not exist in this dataset any more, so the check cannot run.`, sample: [] } };

  const failing: Array<{ rowIndex: number; value: string }> = [];
  if (def.checkType === "not_null") {
    rows.forEach((row, rowIndex) => { if (isNull(row[name])) failing.push({ rowIndex, value: show(row[name]) }); });
  } else if (def.checkType === "unique") {
    const seen = new Map<string, number[]>();
    rows.forEach((row, rowIndex) => { if (!isNull(row[name])) { const key = String(row[name]); seen.set(key, [...(seen.get(key) ?? []), rowIndex]); } });
    seen.forEach((indexes, value) => { if (indexes.length > 1) indexes.forEach(rowIndex => failing.push({ rowIndex, value })); });
    failing.sort((a, b) => a.rowIndex - b.rowIndex);
  } else if (def.checkType === "allowed_values") {
    const allowed = new Set(def.config.values);
    rows.forEach((row, rowIndex) => { if (!isNull(row[name]) && !allowed.has(String(row[name]))) failing.push({ rowIndex, value: show(row[name]) }); });
  } else if (def.checkType === "range") {
    const { min, max } = def.config;
    rows.forEach((row, rowIndex) => {
      if (isNull(row[name])) return;
      const number = typeof row[name] === "number" ? (row[name] as number) : Number(row[name]);
      if (!Number.isFinite(number) || (min !== undefined && number < min) || (max !== undefined && number > max)) failing.push({ rowIndex, value: show(row[name]) });
    });
  }
  const status: QualityStatus = failing.length ? "fail" : "pass";
  const message = failing.length ? `${failing.length} of ${rows.length} rows break "${describeCheck(def)}".` : `All ${rows.length} rows satisfy "${describeCheck(def)}".`;
  return { status, evaluatedRows: rows.length, failingRows: failing.length, observed: { message, measured: failing.length, sample: failing.slice(0, SAMPLE) } };
}
