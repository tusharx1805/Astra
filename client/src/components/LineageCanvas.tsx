import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { LineageEdge, LineageNode } from "../../../shared/lineage";

/**
 * Phase 6: a pure renderer. Nodes, edges and positions come from the lineage.graph
 * API (server/lineageDb.ts → shared/lineage.ts); this component holds no data
 * and applies no database rules. The static fixture graph was removed.
 */

const nodeClass = "rounded-none border bg-[#111] px-3 py-2 text-left shadow-none";

type NodeData = { node: LineageNode; focused: boolean };

function statusTone(status: string | null) {
  if (!status) return "";
  if (status === "FAILED") return "text-[#ff513d]";
  if (status === "WARNING") return "text-[#f3c94b]";
  if (status === "HEALTHY") return "text-[#6ae580]";
  return "text-[#9b9cff]";
}

function LineageNodeView({ data }: { data: NodeData }) {
  const { node, focused } = data;
  const kind = node.kind === "pipeline" ? "PIPELINE" : node.derived ? "DATASET · RUN OUTPUT" : "DATASET";
  return (
    <div className={`${nodeClass} w-[200px] cursor-pointer ${focused ? "border-2 border-[#ff2e17]" : node.kind === "pipeline" ? "border-white/35" : "border-white/20"}`} title="Open">
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !rounded-none !border-0 !bg-[#ff2e17]" />
      <p className="text-[10px] font-bold tracking-[0.16em] text-white/45">{kind}</p>
      <p className="mt-1 truncate text-sm font-black tracking-tight text-white">{node.label}</p>
      <p className="mt-1 truncate text-[10px] text-white/50">{node.detail}</p>
      {node.status ? <p className={`mt-1 text-[10px] font-bold tracking-[0.12em] ${statusTone(node.status)}`}>{node.status}</p> : null}
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !rounded-none !border-0 !bg-[#ff2e17]" />
    </div>
  );
}

const nodeTypes = { lineage: LineageNodeView };

export const EDGE_STYLE: Record<LineageEdge["kind"], { color: string; label: string }> = {
  reads: { color: "#8a8a84", label: "reads (pipeline source)" },
  overwrites: { color: "#ff2e17", label: "overwrites (destination)" },
  produced: { color: "#6ae580", label: "produced by a successful run" },
};

export function LineageCanvas({ nodes, edges, positions, focus, onOpen }: { nodes: LineageNode[]; edges: LineageEdge[]; positions: Record<string, { x: number; y: number }>; focus?: string | null; onOpen?: (node: LineageNode) => void }) {
  const flowNodes: Node<NodeData>[] = nodes.map(node => ({ id: node.id, type: "lineage", position: positions[node.id] ?? { x: 0, y: 0 }, data: { node, focused: node.id === focus } }));
  const flowEdges: Edge[] = edges.map(edge => ({
    id: edge.id, source: edge.source, target: edge.target, label: edge.label,
    style: { stroke: EDGE_STYLE[edge.kind].color, strokeWidth: edge.observed ? 2 : 1.5, strokeDasharray: edge.kind === "overwrites" && !edge.observed ? "6 4" : undefined },
    markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_STYLE[edge.kind].color },
    labelStyle: { fill: "#d6d6ce", fontSize: 10, fontFamily: "IBM Plex Mono, monospace" },
    labelBgStyle: { fill: "#080808" },
  }));
  return (
    <div className="h-[520px] border border-white/15 bg-[#080808]" data-testid="lineage-canvas">
      <ReactFlow key={`${focus ?? "all"}-${nodes.length}-${edges.length}`} nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.3} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false} elementsSelectable onNodeClick={(_, node) => onOpen?.((node.data as NodeData).node)}>
        <Background color="#2c2c2c" gap={22} size={1} />
        <Controls className="!rounded-none !border !border-white/20 !bg-black [&>button]:!rounded-none [&>button]:!border-white/20 [&>button]:!bg-black [&>button]:!fill-white" />
      </ReactFlow>
    </div>
  );
}
