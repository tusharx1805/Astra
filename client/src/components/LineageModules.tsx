import { Button } from "@/components/ui/button";
import { PersistedBadge, StateMessage, WorkspaceGate } from "@/components/DatasetModules";
import { EDGE_STYLE, LineageCanvas } from "@/components/LineageCanvas";
import { trpc } from "@/lib/trpc";
import type { LineageEdge } from "../../../shared/lineage";
import { GitBranch } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";

/**
 * Phase 6 — Lineage page. Reads lineage.graph for the active workspace. Every node
 * is a stored dataset or pipeline; every edge comes from a pipeline definition
 * or a successful run's recorded output (see shared/lineage.ts).
 */

function readFocus() {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("focus");
  return value && /^(dataset|pipeline):\d+$/.test(value) ? value : null;
}

const KIND_LABEL: Record<LineageEdge["kind"], string> = { reads: "READS", overwrites: "OVERWRITES", produced: "PRODUCED" };

function LineageBody({ workspaceId }: { workspaceId: number }) {
  const [, setLocation] = useLocation();
  const [focus, setFocusState] = useState<string | null>(readFocus);
  const setFocus = (value: string | null) => {
    setFocusState(value);
    try { window.history.replaceState(null, "", value ? `/lineage?focus=${value}` : "/lineage"); } catch { /* URL sync is best-effort */ }
  };
  const graph = trpc.lineage.graph.useQuery({ workspaceId, focus }, { retry: false, placeholderData: previous => previous });
  if (graph.isLoading) return <div className="workspace-loading"><span>BUILDING LINEAGE FROM STORED RECORDS…</span></div>;
  if (graph.error) return <section className="panel"><StateMessage title={graph.error.data?.code === "NOT_FOUND" ? "Not in this workspace" : "Lineage unavailable"} detail={graph.error.message} action={focus ? <Button variant="outline" onClick={() => setFocus(null)}>SHOW WHOLE WORKSPACE</Button> : undefined} /></section>;
  const data = graph.data!;
  const names = new Map(data.nodes.map(node => [node.id, node.label]));
  const focusLabel = focus ? data.entities.find(entity => entity.id === focus)?.label : null;
  const open = (id: string, kind: string, entityId: number) => setLocation(kind === "dataset" ? `/datasets/${entityId}` : `/pipelines/${entityId}`);
  return <>
    <section className="panel">
      <div className="workspace-section-head"><div><p className="eyebrow">LINEAGE · DERIVED FROM DATABASE RECORDS</p><h2>{focusLabel ? `UPSTREAM & DOWNSTREAM OF ${focusLabel}` : "WHOLE WORKSPACE"}</h2></div><PersistedBadge /></div>
      <div className="module-filter lineage-toolbar"><GitBranch size={14} /><select aria-label="Lineage focus" value={focus ?? ""} onChange={event => setFocus(event.target.value || null)}><option value="">Whole workspace</option>{data.entities.map(entity => <option key={entity.id} value={entity.id}>{entity.kind === "dataset" ? "Dataset" : "Pipeline"} · {entity.label}</option>)}</select>{focus ? <Button variant="outline" onClick={() => setFocus(null)}>CLEAR FOCUS</Button> : null}</div>
      {data.nodes.length ? <LineageCanvas nodes={data.nodes} edges={data.edges} positions={data.positions} focus={data.focus} onOpen={node => open(node.id, node.kind, node.entityId)} />
        : <StateMessage title="Nothing to draw yet" detail="Lineage appears once this workspace has datasets and pipelines. Import a CSV, build a pipeline that reads it, then run it." action={<Button className="button-red" onClick={() => setLocation("/datasets/import")}>IMPORT CSV</Button>} />}
      <div className="lineage-legend">{(Object.keys(EDGE_STYLE) as LineageEdge["kind"][]).map(kind => <span key={kind}><i style={{ background: EDGE_STYLE[kind].color }} />{EDGE_STYLE[kind].label}</span>)}<span><i className="lineage-legend__dashed" />declared, not yet run</span><span>Click a box to open it.</span></div>
    </section>
    <section className="impact-summary">
      <div><b>{String(data.counts.datasets).padStart(2, "0")}</b><span>DATASETS{data.counts.derivedDatasets ? ` · ${data.counts.derivedDatasets} FROM RUNS` : ""}</span></div>
      <div><b>{String(data.counts.pipelines).padStart(2, "0")}</b><span>PIPELINES</span></div>
      <div><b>{String(data.counts.edges).padStart(2, "0")}</b><span>RELATIONSHIPS · {data.counts.observedEdges} OBSERVED IN RUNS</span></div>
      <div><b>{String(focus ? data.downstream.length : data.counts.unconnected).padStart(2, "0")}</b><span>{focus ? "DOWNSTREAM (WOULD BE AFFECTED)" : "UNCONNECTED ITEMS"}</span></div>
    </section>
    <section className="panel"><p className="eyebrow">EVERY RELATIONSHIP AND ITS EVIDENCE</p><h2>{data.edges.length} EDGES</h2>
      {data.edges.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>FROM</th><th>RELATIONSHIP</th><th>TO</th><th>SOURCE OF TRUTH</th><th>EVIDENCE</th></tr></thead><tbody>{data.edges.map(edge => <tr key={edge.id}><td>{names.get(edge.source)}</td><td><span className="status" style={{ color: EDGE_STYLE[edge.kind].color }}>{KIND_LABEL[edge.kind]}</span></td><td>{names.get(edge.target)}</td><td>{edge.declared && edge.observed ? "Definition + run" : edge.declared ? "Pipeline definition" : "Run output"}</td><td>{edge.evidence}</td></tr>)}</tbody></table></div> : <p className="panel-copy">No relationships yet: no pipeline reads a dataset in this {focus ? "selection" : "workspace"}.</p>}
    </section>
  </>;
}

export function LineagePage() {
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">DEPENDENCY MAP · STORED RELATIONSHIPS</p><h1>LINEAGE &<br /><em>BLAST RADIUS.</em></h1><p>Which pipelines read which datasets, which datasets they overwrite, and which datasets their runs produced — built from the database, never from a fixture.</p></div></section><WorkspaceGate subject="Lineage">{workspaceId => <LineageBody key={workspaceId} workspaceId={workspaceId} />}</WorkspaceGate></div>;
}
