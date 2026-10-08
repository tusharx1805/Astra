import { describe, expect, it } from "vitest";
import { analyzePipelineChange, changeTitle, levelFor, type ImpactContext, type PipelineDefinitionSnapshot } from "./changeRisk";
import { parseCsvDataset } from "./datasetProfile";
import type { TransformStep } from "./transformations";

const CSV = "customer_id,email,plan,seats,active,region\nC-1001,ada@example.com,pro,12,true,Mumbai\nC-1002,ben@example.com,starter,4,true,Nashik\nC-1003,,pro,8,false,Pune\nC-1004,\"drew, jr@example.com\",enterprise,41,true,Mumbai\nC-1005,esha@example.com,pro,15,true,\n";
const parsed = parseCsvDataset(CSV);
const source = { id: 1, name: "customers", columns: parsed.columns, rows: parsed.rows };
const def = (steps: TransformStep[], extra: Partial<PipelineDefinitionSnapshot> = {}): PipelineDefinitionSnapshot => ({ name: "p", sourceDatasetId: 1, destinationMode: "new_dataset", destinationDatasetId: null, steps, ...extra });
const ctx = (current: PipelineDefinitionSnapshot | null, proposed: PipelineDefinitionSnapshot, extra: Partial<ImpactContext> = {}): ImpactContext => ({
  change: { kind: "pipeline_definition", version: 1, workspaceId: 9, pipelineId: current ? 5 : null, baseVersion: current ? "0123456789abcdef" : null, current, proposed },
  source, destination: null, downstream: [], history: { finished: 0, failed: 0 }, now: new Date("2026-09-24T00:00:00Z"), ...extra,
});

describe("pipeline-impact risk engine", () => {
  it("is deterministic and computes metrics from the stored rows", () => {
    const input = ctx(def([]), def([{ operation: "filter", column: "active", operator: "equals", value: "true" }]));
    const a = analyzePipelineChange(input), b = analyzePipelineChange(input);
    expect(a).toEqual(b);
    expect(a.metrics).toMatchObject({ sourceRows: 5, currentRowsOut: 5, proposedRowsOut: 4 });
    expect(a.factors.map(f => f.code)).toEqual(["row_loss"]);
    expect(a).toMatchObject({ score: 10, level: "SAFE" });
    expect(a.inputs).toMatchObject({ sourceDatasetId: 1, sourceRowCount: 5, analyzedAt: "2026-09-24T00:00:00.000Z" });
  });

  it("flags a downstream pipeline that would break when an overwritten column disappears (CRITICAL)", () => {
    const destination = { id: 2, name: "customers_shared", rowCount: 5, columns: parsed.columns };
    const proposed = def([{ operation: "drop_column", column: "email" }], { destinationMode: "overwrite_existing", destinationDatasetId: 2 });
    const result = analyzePipelineChange(ctx(def([], { destinationMode: "overwrite_existing", destinationDatasetId: 2 }), proposed, {
      destination, downstream: [{ id: 7, name: "contactable customers", steps: [{ operation: "filter", column: "email", operator: "is_not_null" }] }, { id: 8, name: "plans only", steps: [{ operation: "drop_column", column: "seats" }] }],
    }));
    expect(result.level).toBe("CRITICAL");
    expect(result.metrics.downstreamBroken).toEqual([{ pipelineId: 7, name: "contactable customers", issues: [expect.stringMatching(/column "email" does not exist/)] }]);
    expect(result.factors.find(f => f.code === "downstream_break")?.evidence).toMatch(/contactable customers/);
    expect(result.metrics.removedColumns).toEqual(["email"]);
    expect(result.affectedEntities).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "pipeline", id: 7, severity: "CRITICAL", owner: "DOWNSTREAM · would fail" }),
      expect.objectContaining({ type: "pipeline", id: 8, severity: "SAFE" }),
      expect.objectContaining({ type: "dataset", id: 2, severity: "CRITICAL" }),
    ]));
  });

  it("the same drop is harmless when nobody reads the output", () => {
    const result = analyzePipelineChange(ctx(def([]), def([{ operation: "drop_column", column: "email" }])));
    expect(result.metrics.downstreamBroken).toEqual([]);
    expect(result.level).toBe("SAFE");
    expect(result.factors.map(f => f.code)).toEqual(["columns_removed"]);
  });

  it("a filter that empties the output is at least HIGH", () => {
    const result = analyzePipelineChange(ctx(def([]), def([{ operation: "filter", column: "plan", operator: "equals", value: "platinum" }])));
    expect(result.metrics.proposedRowsOut).toBe(0);
    expect(result.factors[0]).toMatchObject({ code: "empty_output", tone: "critical" });
    expect(["HIGH", "CRITICAL"]).toContain(result.level);
  });

  it("an invalid proposal is reported, not executed", () => {
    const result = analyzePipelineChange(ctx(null, def([{ operation: "drop_column", column: "email" }, { operation: "filter", column: "email", operator: "is_null" }])));
    expect(result.metrics.definitionIssues[0]).toMatch(/Step 2/);
    expect(result.metrics.proposedRowsOut).toBe(0);
    expect(result.level).toBe("HIGH");
  });

  it("mass type-coercion failures and unstable history raise the score with evidence", () => {
    const result = analyzePipelineChange(ctx(def([]), def([{ operation: "change_datatype", column: "plan", toType: "number" }]), { history: { finished: 4, failed: 3 } }));
    expect(result.metrics.coercionFailures).toBe(5);
    expect(result.factors.map(f => f.code)).toEqual(expect.arrayContaining(["coercion_failures", "unstable_history"]));
    expect(result.factors.find(f => f.code === "unstable_history")?.evidence).toBe("3 of its last 4 stored runs failed.");
    expect(result.score).toBeGreaterThanOrEqual(35);
  });

  it("titles and levels", () => {
    expect(changeTitle(ctx(def([], { name: "a" }), def([{ operation: "drop_column", column: "email" }], { name: "b" })).change)).toBe('Edit "a" → "b" (0 → 1 step)');
    expect(changeTitle(ctx(null, def([], { name: "n" })).change)).toBe('New pipeline "n" (0 steps)');
    expect([levelFor(10), levelFor(35), levelFor(60), levelFor(80)]).toEqual(["SAFE", "MEDIUM", "HIGH", "CRITICAL"]);
  });
});
