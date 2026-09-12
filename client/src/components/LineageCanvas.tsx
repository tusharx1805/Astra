import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const nodeClass = "rounded-none border border-white/20 bg-[#111] px-3 py-2 text-left shadow-none";

function LineageNode({ data }: { data: { label: string; type: string; owner: string; severity?: string } }) {
  return (
    <div className={`${nodeClass} min-w-[160px] ${data.severity === "CRITICAL" ? "border-[#ff2e17]" : ""}`}>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !rounded-none !border-0 !bg-[#ff2e17]" />
      <p className="text-[10px] font-bold tracking-[0.16em] text-white/45">{data.type}</p>
      <p className="mt-1 text-sm font-black tracking-tight text-white">{data.label}</p>
      <p className="mt-1 text-[10px] text-white/50">OWNER · {data.owner}</p>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !rounded-none !border-0 !bg-[#ff2e17]" />
    </div>
  );
}

const nodeTypes = { lineage: LineageNode };

const nodes: Node[] = [
  { id: "customers", type: "lineage", position: { x: 40, y: 150 }, data: { label: "customers", type: "DATASET", owner: "Maya Chen", severity: "CRITICAL" } },
  { id: "etl", type: "lineage", position: { x: 340, y: 45 }, data: { label: "customer_etl", type: "PIPELINE", owner: "Data Platform", severity: "HIGH" } },
  { id: "clean", type: "lineage", position: { x: 340, y: 245 }, data: { label: "clean_customers", type: "DATASET", owner: "Data Platform" } },
  { id: "dashboard", type: "lineage", position: { x: 650, y: 45 }, data: { label: "Customer 360", type: "DASHBOARD", owner: "Revenue Ops", severity: "HIGH" } },
  { id: "model", type: "lineage", position: { x: 650, y: 245 }, data: { label: "Fraud Model", type: "MODEL", owner: "Risk Intelligence" } },
];

const edges: Edge[] = [
  { id: "e1", source: "customers", target: "etl", animated: true, style: { stroke: "#ff2e17", strokeWidth: 2 } },
  { id: "e2", source: "customers", target: "clean", style: { stroke: "#808080", strokeWidth: 1.5 } },
  { id: "e3", source: "etl", target: "dashboard", style: { stroke: "#808080", strokeWidth: 1.5 } },
  { id: "e4", source: "clean", target: "model", style: { stroke: "#808080", strokeWidth: 1.5 } },
];

export function LineageCanvas() {
  return (
    <div className="h-[430px] border border-white/15 bg-[#080808]">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.5} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false} elementsSelectable>
        <Background color="#2c2c2c" gap={22} size={1} />
        <Controls className="!rounded-none !border !border-white/20 !bg-black [&>button]:!rounded-none [&>button]:!border-white/20 [&>button]:!bg-black [&>button]:!fill-white" />
      </ReactFlow>
    </div>
  );
}
