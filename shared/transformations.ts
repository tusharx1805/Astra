export type Row = Record<string, unknown>;

export type TransformStep =
  | { operation: "filter"; column: string; operator: "equals" | "not_equals" | "gt" | "lt" | "gte" | "lte" | "contains" | "is_null" | "is_not_null"; value?: string | number }
  | { operation: "rename_column"; from: string; to: string }
  | { operation: "change_datatype"; column: string; toType: "string" | "number" | "boolean" | "date" }
  | { operation: "drop_column"; column: string }
  | { operation: "remove_nulls"; column: string | "any" };

export type TransformResult = { rows: Row[]; coercionFailures: number; effect: string };

function isNull(value: unknown) {
  return value === null || value === undefined || value === "";
}

function compare(value: unknown, operator: Exclude<TransformStep, { operation: "filter" }> extends never ? never : string, target: unknown) {
  if (operator === "is_null") return isNull(value);
  if (operator === "is_not_null") return !isNull(value);
  if (operator === "contains") return String(value ?? "").toLowerCase().includes(String(target ?? "").toLowerCase());
  if (operator === "equals") return String(value ?? "") === String(target ?? "");
  if (operator === "not_equals") return String(value ?? "") !== String(target ?? "");
  const left = typeof value === "number" ? value : Number(value);
  const right = typeof target === "number" ? target : Number(target);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === "gt") return left > right;
  if (operator === "lt") return left < right;
  if (operator === "gte") return left >= right;
  if (operator === "lte") return left <= right;
  return false;
}

function coerce(value: unknown, toType: "string" | "number" | "boolean" | "date") {
  if (isNull(value)) return { value: null, failed: false };
  if (toType === "string") return { value: String(value), failed: false };
  if (toType === "number") {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? { value: number, failed: false } : { value: null, failed: true };
  }
  if (toType === "boolean") {
    if (typeof value === "boolean") return { value, failed: false };
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return { value: true, failed: false };
    if (["false", "0", "no"].includes(normalized)) return { value: false, failed: false };
    return { value: null, failed: true };
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? { value: null, failed: true } : { value: date.toISOString(), failed: false };
}

export function applyTransformStep(inputRows: Row[], step: TransformStep): TransformResult {
  const rows = inputRows.map(row => ({ ...row }));
  if (step.operation === "filter") {
    const filtered = rows.filter(row => compare(row[step.column], step.operator, step.value));
    return { rows: filtered, coercionFailures: 0, effect: `${inputRows.length} → ${filtered.length} rows` };
  }
  if (step.operation === "rename_column") {
    const renamed = rows.map(row => {
      if (!(step.from in row)) return row;
      const next = { ...row, [step.to]: row[step.from] };
      delete next[step.from];
      return next;
    });
    return { rows: renamed, coercionFailures: 0, effect: `renamed ${step.from} → ${step.to}` };
  }
  if (step.operation === "drop_column") {
    const dropped = rows.map(row => {
      const next = { ...row };
      delete next[step.column];
      return next;
    });
    return { rows: dropped, coercionFailures: 0, effect: `dropped ${step.column}` };
  }
  if (step.operation === "remove_nulls") {
    const filtered = rows.filter(row => step.column === "any" ? Object.values(row).every(value => !isNull(value)) : !isNull(row[step.column]));
    return { rows: filtered, coercionFailures: 0, effect: `${inputRows.length - filtered.length} rows removed` };
  }
  let coercionFailures = 0;
  const converted = rows.map(row => {
    const next = { ...row };
    const result = coerce(row[step.column], step.toType);
    next[step.column] = result.value;
    if (result.failed) coercionFailures += 1;
    return next;
  });
  return { rows: converted, coercionFailures, effect: `converted ${step.column} → ${step.toType}${coercionFailures ? `; ${coercionFailures} coercion failures` : ""}` };
}

export function applyTransformSteps(inputRows: Row[], steps: TransformStep[]) {
  return steps.reduce((acc, step) => {
    const result = applyTransformStep(acc.rows, step);
    return { rows: result.rows, coercionFailures: acc.coercionFailures + result.coercionFailures, effects: [...acc.effects, result.effect] };
  }, { rows: inputRows.map(row => ({ ...row })), coercionFailures: 0, effects: [] as string[] });
}
