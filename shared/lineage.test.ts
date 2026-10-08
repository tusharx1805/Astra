import { describe, expect, it } from "vitest";
import { buildLineageGraph, focusLineage, layoutLineage, parseNodeId } from "./lineage";

const ds = (id: number, name: string) => ({ id, name, sourceType: "CSV / Files", rowCount: 5, workspaceId: 1 });
const pl = (id: number, name: string, source: number | null, mode: "new_dataset" | "overwrite_existing", dest: number | null = null) => ({ id, name, status: "DRAFT", sourceDatasetId: source, destinationMode: mode, destinationDatasetId: dest, stepCount: 1, workspaceId: 1 });

describe("lineage from persisted records", () => {
  // A(1) → refresh(10) ⇒ B(2) → call list(11) → run output C(3)
  const input = {
    datasets: [ds(1, "leads"), ds(2, "leads_shared"), ds(3, "call list · run 7"), ds(4, "unrelated")],
    pipelines: [pl(10, "refresh", 1, "overwrite_existing", 2), pl(11, "call list", 2, "new_dataset"), pl(12, "orphan", null, "new_dataset")],
    runOutputs: [{ runId: 7, pipelineId: 11, datasetId: 3, mode: "new_dataset" as const, completedAt: "2026-09-24T00:00:00Z" }],
  };
  const graph = buildLineageGraph(input);

  it("creates only relationships that exist in the stored data", () => {
    expect(graph.edges.map(edge => [edge.source, edge.kind, edge.target, edge.declared, edge.observed])).toEqual([
      ["dataset:1", "reads", "pipeline:10", true, false],
      ["pipeline:10", "overwrites", "dataset:2", true, false],
      ["dataset:2", "reads", "pipeline:11", true, false],
      ["pipeline:11", "produced", "dataset:3", false, true],
    ]);
    expect(graph.nodes.find(node => node.id === "dataset:3")?.derived).toBe(true);
    expect(graph.edges.some(edge => edge.source === "pipeline:12" || edge.target === "pipeline:12" || edge.target === "dataset:4")).toBe(false);
  });

  it("marks a declared overwrite as observed once a successful run wrote it; keeps historical writes", () => {
    const withRun = buildLineageGraph({ ...input, runOutputs: [...input.runOutputs, { runId: 8, pipelineId: 10, datasetId: 2, mode: "overwrite_existing", completedAt: "x" }, { runId: 5, pipelineId: 10, datasetId: 4, mode: "overwrite_existing", completedAt: "x" }] });
    expect(withRun.edges.find(edge => edge.id === "overwrites:10->2")).toMatchObject({ declared: true, observed: true, label: "overwrites · run #8" });
    expect(withRun.edges.find(edge => edge.id === "overwrites:10->4")).toMatchObject({ declared: false, observed: true, label: "overwrote · run #5" });
  });

  it("changing or removing a relationship changes the graph", () => {
    const moved = buildLineageGraph({ ...input, pipelines: [pl(10, "refresh", 1, "new_dataset"), pl(11, "call list", 4, "new_dataset")] });
    expect(moved.edges.map(edge => edge.id)).toEqual(["reads:1->10", "reads:4->11", "produced:11->3"]);
    const removedDataset = buildLineageGraph({ ...input, datasets: input.datasets.filter(d => d.id !== 3) });
    expect(removedDataset.edges.some(edge => edge.kind === "produced")).toBe(false);
  });

  it("focus returns upstream and downstream only (not siblings)", () => {
    const focus = focusLineage(graph, "dataset:2");
    expect(focus.upstream.sort()).toEqual(["dataset:1", "pipeline:10"]);
    expect(focus.downstream.sort()).toEqual(["dataset:3", "pipeline:11"]);
    expect(focus.nodes.map(node => node.id).sort()).toEqual(["dataset:1", "dataset:2", "dataset:3", "pipeline:10", "pipeline:11"]);
    expect(focusLineage(graph, "dataset:999").nodes).toEqual([]);
  });

  it("lays out left to right and tolerates cycles", () => {
    const positions = layoutLineage(graph);
    expect(positions["dataset:1"]!.x).toBeLessThan(positions["pipeline:10"]!.x);
    expect(positions["pipeline:10"]!.x).toBeLessThan(positions["dataset:2"]!.x);
    expect(positions["dataset:2"]!.x).toBeLessThan(positions["dataset:3"]!.x);
    const cyclic = buildLineageGraph({ datasets: [ds(1, "x"), ds(2, "y")], pipelines: [pl(10, "a", 1, "overwrite_existing", 2), pl(11, "b", 2, "overwrite_existing", 1)], runOutputs: [] });
    expect(Object.keys(layoutLineage(cyclic)).sort()).toEqual(["dataset:1", "dataset:2", "pipeline:10", "pipeline:11"]);
    expect(parseNodeId("pipeline:12")).toEqual({ kind: "pipeline", id: 12 });
    expect(parseNodeId("dashboard:1")).toBeNull();
  });
});
