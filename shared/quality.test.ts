import { describe, expect, it } from "vitest";
import { checkDefinitionSchema, describeCheck, evaluateCheck } from "./quality";
import { parseCsvDataset } from "./datasetProfile";

const CSV = "customer_id,email,plan,seats,active,region\nC-1001,ada@example.com,pro,12,true,Mumbai\nC-1002,ben@example.com,starter,4,true,Nashik\nC-1003,,pro,8,false,Pune\nC-1004,\"drew, jr@example.com\",enterprise,41,true,Mumbai\nC-1005,esha@example.com,pro,15,true,\n";
const { rows, columns } = parseCsvDataset(CSV);

describe("quality checks on stored rows", () => {
  it("not_null finds the blank email and blank region", () => {
    expect(evaluateCheck({ checkType: "not_null", columnName: "email", config: {} }, rows, columns)).toMatchObject({ status: "fail", evaluatedRows: 5, failingRows: 1, observed: { sample: [{ rowIndex: 2, value: "∅" }] } });
    expect(evaluateCheck({ checkType: "not_null", columnName: "customer_id", config: {} }, rows, columns)).toMatchObject({ status: "pass", failingRows: 0 });
  });
  it("unique flags every row of a duplicated value", () => {
    const result = evaluateCheck({ checkType: "unique", columnName: "plan", config: {} }, rows, columns);
    expect(result).toMatchObject({ status: "fail", failingRows: 3 });
    expect(result.observed.sample.map(item => item.value)).toEqual(["pro", "pro", "pro"]);
    expect(evaluateCheck({ checkType: "unique", columnName: "customer_id", config: {} }, rows, columns).status).toBe("pass");
  });
  it("allowed_values and range", () => {
    expect(evaluateCheck({ checkType: "allowed_values", columnName: "plan", config: { values: ["pro", "starter"] } }, rows, columns)).toMatchObject({ status: "fail", failingRows: 1, observed: { sample: [{ rowIndex: 3, value: "enterprise" }] } });
    expect(evaluateCheck({ checkType: "range", columnName: "seats", config: { min: 1, max: 40 } }, rows, columns)).toMatchObject({ status: "fail", failingRows: 1, observed: { sample: [{ value: "41" }] } });
    expect(evaluateCheck({ checkType: "range", columnName: "plan", config: { min: 0 } }, rows, columns)).toMatchObject({ status: "fail", failingRows: 5 });
  });
  it("row_count and missing columns", () => {
    expect(evaluateCheck({ checkType: "row_count", columnName: null, config: { min: 5 } }, rows, columns).status).toBe("pass");
    expect(evaluateCheck({ checkType: "row_count", columnName: null, config: { min: 10 } }, rows, columns)).toMatchObject({ status: "fail", observed: { measured: 5 } });
    expect(evaluateCheck({ checkType: "not_null", columnName: "phone", config: {} }, rows, columns)).toMatchObject({ status: "error", observed: { message: expect.stringMatching(/does not exist/) } });
  });
  it("is reproducible and validates definitions", () => {
    const check = { checkType: "not_null" as const, columnName: "email", config: {} };
    expect(evaluateCheck(check, rows, columns)).toEqual(evaluateCheck(check, rows, columns));
    expect(checkDefinitionSchema.safeParse({ checkType: "range", columnName: "seats", config: {} }).success).toBe(false);
    expect(checkDefinitionSchema.safeParse({ checkType: "range", columnName: "seats", config: { min: 5, max: 1 } }).success).toBe(false);
    expect(describeCheck({ checkType: "range", columnName: "seats", config: { min: 1, max: 40 } })).toBe("seats is a number between 1 and 40");
  });
});
