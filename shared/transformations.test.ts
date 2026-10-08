import { describe, expect, it } from "vitest";
import { applyTransformStep, applyTransformSteps } from "./transformations";

describe("ASTRA transformations", () => {
  const rows = [
    { email: "a@example.com", age: "31", active: "true" },
    { email: "b@example.com", age: "bad", active: "false" },
    { email: null, age: "22", active: "true" },
  ];

  it("filters and removes nulls deterministically", () => {
    expect(applyTransformStep(rows, { operation: "filter", column: "age", operator: "gte", value: 30 }).rows).toHaveLength(1);
    expect(applyTransformStep(rows, { operation: "remove_nulls", column: "email" }).rows).toHaveLength(2);
  });

  it("renames and drops columns without mutating the input", () => {
    const result = applyTransformSteps(rows, [
      { operation: "rename_column", from: "email", to: "contact" },
      { operation: "drop_column", column: "active" },
    ]);
    expect(result.rows[0]).toEqual({ contact: "a@example.com", age: "31" });
    expect(rows[0]).toHaveProperty("email");
  });

  it("sets failed coercions to null and reports the count", () => {
    const result = applyTransformStep(rows, { operation: "change_datatype", column: "age", toType: "number" });
    expect(result.coercionFailures).toBe(1);
    expect(result.rows[1]?.age).toBeNull();
    expect(result.rows[0]?.age).toBe(31);
  });

  it("covers every supported operation in the same ordered engine", () => {
    const result = applyTransformSteps(rows, [
      { operation: "filter", column: "active", operator: "equals", value: "true" },
      { operation: "rename_column", from: "email", to: "contact" },
      { operation: "change_datatype", column: "age", toType: "number" },
      { operation: "drop_column", column: "active" },
      { operation: "remove_nulls", column: "contact" },
    ]);
    expect(result.rows).toEqual([
      { contact: "a@example.com", age: 31 },
    ]);
    expect(result.coercionFailures).toBe(0);
    expect(result.effects).toHaveLength(5);
  });

  it("supports remove_nulls across any column", () => {
    const result = applyTransformStep(rows, { operation: "remove_nulls", column: "any" });
    expect(result.rows).toHaveLength(2);
  });
});
