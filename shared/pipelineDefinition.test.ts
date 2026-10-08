import { describe, expect, it } from "vitest";
import { columnsAfterSteps, fromStepRecord, normalizeStep, toStepRecord, transformStepSchema, validatePipelineSteps } from "./pipelineDefinition";
import { applyTransformSteps, type TransformStep } from "./transformations";

const COLUMNS = ["customer_id", "email", "plan", "seats", "active"];

describe("pipeline step ⇄ pipeline_steps row mapping", () => {
  const steps: TransformStep[] = [
    { operation: "filter", column: "active", operator: "equals", value: "true" },
    { operation: "rename_column", from: "customer_id", to: "customer_key" },
    { operation: "change_datatype", column: "seats", toType: "number" },
    { operation: "drop_column", column: "email" },
    { operation: "remove_nulls", column: "any" },
  ];

  it("round-trips every operation through (operation, config) without loss", () => {
    const records = steps.map((step, index) => toStepRecord(step, index));
    expect(records.map(record => record.stepOrder)).toEqual([0, 1, 2, 3, 4]);
    expect(records[1]).toEqual({ stepOrder: 1, operation: "rename_column", config: { from: "customer_id", to: "customer_key" } });
    expect(records.map(record => fromStepRecord(record))).toEqual(steps);
  });

  it("accepts config stored as a JSON string and rejects rows that break the contract", () => {
    expect(fromStepRecord({ operation: "drop_column", config: '{"column":"email"}' })).toEqual({ operation: "drop_column", column: "email" });
    expect(fromStepRecord({ operation: "drop_column", config: {} })).toBeNull();
    expect(fromStepRecord({ operation: "sql", config: { query: "drop table x" } })).toBeNull();
    expect(fromStepRecord({ operation: "filter", config: { column: "a", operator: "equals", value: 1, extra: true } })).toBeNull();
  });

  it("the schema rejects unknown operations and unknown fields", () => {
    expect(transformStepSchema.safeParse({ operation: "join", column: "a" }).success).toBe(false);
    expect(transformStepSchema.safeParse({ operation: "drop_column", column: "a", code: "rm -rf" }).success).toBe(false);
  });
});

describe("server-side definition validation", () => {
  it("accepts a valid pipeline and tracks renames", () => {
    expect(validatePipelineSteps([{ operation: "rename_column", from: "seats", to: "licences" }, { operation: "change_datatype", column: "licences", toType: "number" }], COLUMNS)).toEqual([]);
  });

  it("reports columns used after they were renamed or dropped, with the step number", () => {
    const issues = validatePipelineSteps([
      { operation: "drop_column", column: "email" },
      { operation: "filter", column: "email", operator: "is_null" },
      { operation: "rename_column", from: "plan", to: "tier" },
      { operation: "change_datatype", column: "plan", toType: "string" },
    ], COLUMNS);
    expect(issues.map(issue => issue.stepIndex)).toEqual([1, 3]);
    expect(issues[0]!.message).toMatch(/Step 2: column "email" does not exist/);
  });

  it("requires filter values, numeric values for comparisons, and a free rename target", () => {
    expect(validatePipelineSteps([{ operation: "filter", column: "plan", operator: "equals", value: "" }], COLUMNS)[0]!.message).toMatch(/needs a value/);
    expect(validatePipelineSteps([{ operation: "filter", column: "seats", operator: "gt", value: "ten" }], COLUMNS)[0]!.message).toMatch(/numeric/);
    expect(validatePipelineSteps([{ operation: "filter", column: "email", operator: "is_null" }], COLUMNS)).toEqual([]);
    expect(validatePipelineSteps([{ operation: "rename_column", from: "plan", to: "email" }], COLUMNS)[0]!.message).toMatch(/already exists/);
  });

  it("rejects a pipeline that drops every column", () => {
    const steps: TransformStep[] = COLUMNS.map(column => ({ operation: "drop_column", column }));
    expect(validatePipelineSteps(steps, COLUMNS).at(-1)!.message).toMatch(/drops every column/);
  });

  it("columnsAfterSteps gives the builder the columns available at each step", () => {
    const steps: TransformStep[] = [{ operation: "rename_column", from: "plan", to: "tier" }, { operation: "drop_column", column: "email" }];
    expect(columnsAfterSteps(steps, COLUMNS, 1)).toEqual(["customer_id", "email", "tier", "seats", "active"]);
    expect(columnsAfterSteps(steps, COLUMNS)).toEqual(["customer_id", "tier", "seats", "active"]);
  });
});

describe("normalization keeps the transformation engine's behaviour identical", () => {
  const rows = [{ seats: "12", email: null }, { seats: "4", email: "b@x" }, { seats: "41", email: "" }];
  it("numeric comparisons store a number; value-less filters drop the value", () => {
    const gt: TransformStep = { operation: "filter", column: "seats", operator: "gt", value: "10" };
    expect(normalizeStep(gt)).toEqual({ ...gt, value: 10 });
    expect(applyTransformSteps(rows, [normalizeStep(gt)]).rows).toEqual(applyTransformSteps(rows, [gt]).rows);
    const isNull: TransformStep = { operation: "filter", column: "email", operator: "is_null", value: "ignored" };
    expect(normalizeStep(isNull)).toEqual({ operation: "filter", column: "email", operator: "is_null" });
    expect(applyTransformSteps(rows, [normalizeStep(isNull)]).rows).toHaveLength(2);
  });
});
