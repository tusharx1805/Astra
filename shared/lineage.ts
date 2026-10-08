/**
 * Phase 6 — lineage derived ONLY from persisted records. Three relationships
 * are reliable in the current model:
 *
 *   reads       dataset  → pipeline   pipelines.source_dataset_id              (declared)
 *   overwrites  pipeline → dataset    pipelines.destination_dataset_id         (declared; "observed" once a successful run wrote it)
 *   produced    pipeline → dataset    pipeline_runs.logs.output.datasetId      (observed: a successful run created/wrote that dataset)
 *
 * A historical overwrite (a successful run wrote a dataset the pipeline no longer
 * targets) is kept as an observed, non-declared edge — it really happened.
 * Nothing is inferred from names or columns. Pure and deterministic.
 */

export type LineageNodeKind = "dataset" | "pipeline";
export type LineageEdgeKind = "reads" | "overwrites" | "produced";

export type LineageDatasetInput = { id: number; name: string; sourceType: string; rowCount: number; workspaceId: number | null };
export type LineagePipelineInput = { id: number; name: string; status: string; sourceDatasetId: number | null; destinationMode: string | null; destinationDatasetId: number | null; stepCount: number; workspaceId: number | null };
export type LineageRunOutputInput = { runId: number; pipelineId: number; datasetId: number; mode: "new_dataset" | "overwrite_existing"; completedAt: string };

export type LineageNode = {
  id: string;
  kind: LineageNodeKind;
  entityId: number;
  label: string;
  detail: string;
  status: string | null;
  /** Dataset created by a pipeline run (as opposed to imported). */
  derived: boolean;
};
export type LineageEdge = { id: string; source: string; target: string; kind: LineageEdgeKind; declared: boolean; observed: boolean; label: string; evidence: string };
export type LineageGraph = { nodes: LineageNode[]; edges: LineageEdge[] };

export const datasetNodeId = (id: number) => `dataset:${id}`;
export const pipelineNodeId = (id: number) => `pipeline:${id}`;

export function parseNodeId(value: string | null | undefined): { kind: LineageNodeKind; id: number } | null {
  const match = /^(dataset|pipeline):(\d+)$/.exec(value ?? "");
  return match ? { kind: match[1] as LineageNodeKind, id: Number(match[2]) } : null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function buildLineageGraph(input: { datasets: LineageDatasetInput[]; pipelines: LineagePipelineInput[]; runOutputs: LineageRunOutputInput[] }): LineageGraph {
  const datasetIds = new Set(input.datasets.map(dataset => dataset.id));
  const pipelineIds = new Set(input.pipelines.map(pipeline => pipeline.id));
  const producedBy = new Map<number, LineageRunOutputInput>();
  for (const output of input.runOutputs) if (output.mode === "new_dataset" && datasetIds.has(output.datasetId) && pipelineIds.has(output.pipelineId)) producedBy.set(output.datasetId, output);

  const nodes: LineageNode[] = [
    ...input.datasets.map(dataset => ({
      id: datasetNodeId(dataset.id), kind: "dataset" as const, entityId: dataset.id, label: dataset.name,
      detail: `${dataset.workspaceId === null ? "LEGACY · " : ""}${dataset.sourceType} · ${plural(dataset.rowCount, "row")}`,
      status: null, derived: producedBy.has(dataset.id),
    })),
    ...input.pipelines.map(pipeline => ({
      id: pipelineNodeId(pipeline.id), kind: "pipeline" as const, entityId: pipeline.id, label: pipeline.name,
      detail: `${plural(pipeline.stepCount, "step")} · ${pipeline.destinationMode === "overwrite_existing" ? "overwrites" : "new dataset per run"}`,
      status: pipeline.status, derived: false,
    })),
  ];

  const edges = new Map<string, LineageEdge>();
  const put = (edge: LineageEdge) => { if (!edges.has(edge.id)) edges.set(edge.id, edge); };

  for (const pipeline of input.pipelines) {
    if (pipeline.sourceDatasetId !== null && datasetIds.has(pipeline.sourceDatasetId)) {
      put({ id: `reads:${pipeline.sourceDatasetId}->${pipeline.id}`, source: datasetNodeId(pipeline.sourceDatasetId), target: pipelineNodeId(pipeline.id), kind: "reads", declared: true, observed: false, label: "reads", evidence: `Pipeline "${pipeline.name}" is defined with this dataset as its source.` });
    }
    if (pipeline.destinationMode === "overwrite_existing" && pipeline.destinationDatasetId !== null && datasetIds.has(pipeline.destinationDatasetId)) {
      const runs = input.runOutputs.filter(output => output.pipelineId === pipeline.id && output.mode === "overwrite_existing" && output.datasetId === pipeline.destinationDatasetId);
      const last = runs.sort((a, b) => b.runId - a.runId)[0];
      put({ id: `overwrites:${pipeline.id}->${pipeline.destinationDatasetId}`, source: pipelineNodeId(pipeline.id), target: datasetNodeId(pipeline.destinationDatasetId), kind: "overwrites", declared: true, observed: Boolean(last),
        label: last ? `overwrites · run #${last.runId}` : "overwrites (not run yet)",
        evidence: last ? `Declared destination; last written by successful run #${last.runId}.` : "Declared destination; no successful run has written it yet." });
    }
  }
  for (const output of [...input.runOutputs].sort((a, b) => b.runId - a.runId)) {
    if (!datasetIds.has(output.datasetId) || !pipelineIds.has(output.pipelineId)) continue;
    if (output.mode === "new_dataset") {
      put({ id: `produced:${output.pipelineId}->${output.datasetId}`, source: pipelineNodeId(output.pipelineId), target: datasetNodeId(output.datasetId), kind: "produced", declared: false, observed: true, label: `run #${output.runId}`, evidence: `Created by successful run #${output.runId}.` });
    } else if (!edges.has(`overwrites:${output.pipelineId}->${output.datasetId}`)) {
      put({ id: `overwrites:${output.pipelineId}->${output.datasetId}`, source: pipelineNodeId(output.pipelineId), target: datasetNodeId(output.datasetId), kind: "overwrites", declared: false, observed: true, label: `overwrote · run #${output.runId}`, evidence: `Written by successful run #${output.runId}; the pipeline no longer targets this dataset.` });
    }
  }
  return { nodes, edges: Array.from(edges.values()) };
}

/** Upstream + downstream of one node (not siblings): everything it depends on and everything that depends on it. */
export function focusLineage(graph: LineageGraph, nodeId: string): LineageGraph & { upstream: string[]; downstream: string[] } {
  if (!graph.nodes.some(node => node.id === nodeId)) return { nodes: [], edges: [], upstream: [], downstream: [] };
  const walk = (direction: "up" | "down") => {
    const seen = new Set<string>([nodeId]);
    const used = new Set<string>();
    const queue = [nodeId];
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of graph.edges) {
        const next = direction === "down" ? (edge.source === current ? edge.target : null) : (edge.target === current ? edge.source : null);
        if (!next) continue;
        used.add(edge.id);
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    seen.delete(nodeId);
    return { nodes: seen, edges: used };
  };
  const up = walk("up"), down = walk("down");
  const keep = new Set([nodeId, ...Array.from(up.nodes), ...Array.from(down.nodes)]);
  const edgeIds = new Set([...Array.from(up.edges), ...Array.from(down.edges)]);
  return { nodes: graph.nodes.filter(node => keep.has(node.id)), edges: graph.edges.filter(edge => edgeIds.has(edge.id)), upstream: Array.from(up.nodes), downstream: Array.from(down.nodes) };
}

/** Left-to-right layered layout (longest path from sources). Cycles are tolerated. Presentation only. */
export function layoutLineage(graph: LineageGraph, spacing = { x: 255, y: 118 }) {
  const incoming = new Map(graph.nodes.map(node => [node.id, 0]));
  const outgoing = new Map<string, string[]>(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (!incoming.has(edge.target) || !outgoing.has(edge.source) || edge.source === edge.target) continue;
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const layer = new Map<string, number>();
  const queue = graph.nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  queue.forEach(id => layer.set(id, 0));
  const remaining = new Map(incoming);
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of outgoing.get(id)!) {
      layer.set(next, Math.max(layer.get(next) ?? 0, layer.get(id)! + 1));
      remaining.set(next, remaining.get(next)! - 1);
      if (remaining.get(next) === 0) queue.push(next);
    }
  }
  // Nodes in a cycle never reach in-degree 0: place them after their deepest placed predecessor.
  for (const node of graph.nodes) if (!layer.has(node.id)) layer.set(node.id, Math.max(0, ...graph.edges.filter(edge => edge.target === node.id && layer.has(edge.source)).map(edge => layer.get(edge.source)! + 1)));
  const columns = new Map<number, string[]>();
  for (const node of [...graph.nodes].sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))) {
    const column = layer.get(node.id)!;
    columns.set(column, [...(columns.get(column) ?? []), node.id]);
  }
  const positions: Record<string, { x: number; y: number }> = {};
  columns.forEach((ids, column) => ids.forEach((id, row) => { positions[id] = { x: column * spacing.x, y: row * spacing.y }; }));
  return positions;
}
