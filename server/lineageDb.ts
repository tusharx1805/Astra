import { TRPCError } from "@trpc/server";
import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { datasets, pipelineRuns, pipelineSteps, pipelines } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { buildLineageGraph, focusLineage, layoutLineage, parseNodeId, type LineageGraph } from "../shared/lineage";
import { datasetVisibleInWorkspace, getWorkspaceContext, pipelineVisibleInWorkspace } from "./workspaceDb";
import { mayReadPipeline } from "./workspaceContracts";

/**
 * Phase 6 — Real Lineage. Reads datasets, pipeline definitions and successful
 * run outputs of the active workspace and derives the graph with
 * shared/lineage.ts. No hardcoded nodes; nothing inferred from names.
 */
export async function getWorkspaceLineage(user: User, workspaceId: number, focus?: string | null) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadPipeline(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read lineage in this workspace." });

  const [datasetRows, pipelineRows] = await Promise.all([
    db.select({ id: datasets.id, name: datasets.name, sourceType: datasets.sourceType, rowCount: datasets.rowCount, workspaceId: datasets.workspaceId }).from(datasets).where(datasetVisibleInWorkspace(workspace)),
    db.select({ id: pipelines.id, name: pipelines.name, status: pipelines.status, sourceDatasetId: pipelines.sourceDatasetId, destinationMode: pipelines.destinationMode, destinationDatasetId: pipelines.destinationDatasetId, workspaceId: pipelines.workspaceId }).from(pipelines).where(pipelineVisibleInWorkspace(workspace)),
  ]);
  const pipelineIds = pipelineRows.map(row => row.id);
  const [stepCounts, outputs] = pipelineIds.length ? await Promise.all([
    db.select({ pipelineId: pipelineSteps.pipelineId, total: count() }).from(pipelineSteps).where(inArray(pipelineSteps.pipelineId, pipelineIds)).groupBy(pipelineSteps.pipelineId),
    db.select({
      runId: pipelineRuns.id,
      pipelineId: pipelineRuns.pipelineId,
      datasetId: sql<string | null>`${pipelineRuns.logs} -> 'output' ->> 'datasetId'`,
      mode: sql<string | null>`${pipelineRuns.logs} -> 'output' ->> 'mode'`,
      completedAt: pipelineRuns.completedAt,
    }).from(pipelineRuns).where(and(inArray(pipelineRuns.pipelineId, pipelineIds), eq(pipelineRuns.status, "success"), isNotNull(pipelineRuns.completedAt))),
  ]) : [[], []];
  const steps = new Map(stepCounts.map(row => [row.pipelineId, Number(row.total)]));

  const full = buildLineageGraph({
    datasets: datasetRows,
    pipelines: pipelineRows.map(row => ({ ...row, stepCount: steps.get(row.id) ?? 0 })),
    runOutputs: outputs.filter(row => row.datasetId && (row.mode === "new_dataset" || row.mode === "overwrite_existing")).map(row => ({ runId: row.runId, pipelineId: row.pipelineId, datasetId: Number(row.datasetId), mode: row.mode as "new_dataset" | "overwrite_existing", completedAt: row.completedAt!.toISOString() })),
  });

  let graph: LineageGraph = full;
  let upstream: string[] = [], downstream: string[] = [];
  const focusId = focus && parseNodeId(focus) ? focus : null;
  if (focus && !focusId) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown lineage focus." });
  if (focusId) {
    const focused = focusLineage(full, focusId);
    if (!focused.nodes.length) throw new TRPCError({ code: "NOT_FOUND", message: "That dataset or pipeline is not in the active workspace." });
    graph = { nodes: focused.nodes, edges: focused.edges };
    upstream = focused.upstream; downstream = focused.downstream;
  }
  const connected = new Set(graph.edges.flatMap(edge => [edge.source, edge.target]));
  return {
    nodes: graph.nodes,
    edges: graph.edges,
    positions: layoutLineage(graph),
    focus: focusId,
    upstream, downstream,
    counts: {
      datasets: graph.nodes.filter(node => node.kind === "dataset").length,
      derivedDatasets: graph.nodes.filter(node => node.derived).length,
      pipelines: graph.nodes.filter(node => node.kind === "pipeline").length,
      edges: graph.edges.length,
      observedEdges: graph.edges.filter(edge => edge.observed).length,
      unconnected: graph.nodes.filter(node => !connected.has(node.id)).length,
    },
    /** All entities of the workspace, for the focus picker. */
    entities: full.nodes.map(node => ({ id: node.id, kind: node.kind, label: node.label })),
  };
}
