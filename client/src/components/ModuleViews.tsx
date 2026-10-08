import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ModuleSubnav, type ModuleTab } from "@/components/ModuleSubnav";
import { SimulatedBadge } from "@/components/SimulatedBadge";
import { trpc } from "@/lib/trpc";
import { useRecentView } from "@/hooks/useRecentView";
import { useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { DATASET_TABS, PersistedDatasetDetail } from "@/components/DatasetModules";
import { PersistedPipelineDetail, PIPELINE_TABS } from "@/components/PipelineModules";
import { PersistedRunDetail, PipelineRunHistoryPage } from "@/components/PipelineRunModules";
import { AnalysisHistoryPage, ChangeIntelligencePage, RiskAnalysisPage } from "@/components/ChangeModules";
import { MonitoringPage } from "@/components/OpsModules";
import { ReportsPage } from "@/components/DashboardModules";
import { ArrowUpRight, Download, FileWarning, Filter, Gauge, Search, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";

function useWorkspaceViews() {
  // Previously this ran workspace.list without an auth gate, which made signed-out
  // visitors of /datasets or /pipelines get force-redirected to login.
  const { workspaceId, hasWorkspace, storageError } = useActiveWorkspace();
  const views = trpc.workspace.views.useQuery({ workspaceId }, { enabled: Boolean(workspaceId) });
  return { workspaceId, views, hasWorkspace, storageError };
}

function projectLabel(projectId: number | null | undefined) {
  return projectId ? `PROJECT ${projectId}` : "—";
}

function LoadingRows() {
  return <div className="module-loading-list">{[1, 2, 3].map(item => <div key={item} className="module-loading-row"><i /><i /><i /></div>)}</div>;
}

function EmptyState({ title, detail, icon: Icon = Search }: { title: string; detail: string; icon?: typeof Search }) {
  return <div className="module-empty"><Icon size={23} /><h3>{title}</h3><p>{detail}</p></div>;
}

function ModuleHeader({ eyebrow, title, description, tabs, action }: { eyebrow: string; title: React.ReactNode; description: string; tabs: ModuleTab[]; action?: React.ReactNode }) {
  return <><section className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</section><ModuleSubnav tabs={tabs} /></>;
}

function ViewTable({ headers, rows, onRow }: { headers: string[]; rows: Array<Array<React.ReactNode>>; onRow?: (index: number) => void }) {
  return <div className="data-table-wrap"><table className="data-table"><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} onClick={() => onRow?.(index)} className={onRow ? "table-row-clickable" : ""}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
}

export function DatasetModule({ tab }: { tab: "explorer" | "connections" }) {
  const [, setLocation] = useLocation();
  const [filter, setFilter] = useState(() => new URLSearchParams(window.location.search).get("source") ?? "");
  const [sort, setSort] = useState<"name" | "quality">("name");
  const { views, hasWorkspace, storageError } = useWorkspaceViews();
  const datasets = views.data?.datasets ?? [];
  const filtered = useMemo(() => [...datasets.filter(item => `${item.name} ${item.sourceType}`.toLowerCase().includes(filter.toLowerCase()))].sort((left, right) => sort === "quality" ? (right.qualityScore ?? -1) - (left.qualityScore ?? -1) : left.name.localeCompare(right.name)), [datasets, filter, sort]);
  const tabs = DATASET_TABS;
  if (tab === "connections") {
    const connections = Array.from(new Set(datasets.map(item => item.sourceType)));
    return <div className="page-stack"><ModuleHeader eyebrow="BUILD · DATASETS" title={<>DATASET<br /><em>CONNECTIONS.</em></>} description="Distinct source systems already represented by datasets in the active workspace." tabs={tabs} /><section className="panel"><SectionLabel title="SOURCE INVENTORY" detail="Live view over the existing dataset sourceType field." />{views.isLoading ? <LoadingRows /> : connections.length ? <div className="connection-grid">{connections.map(source => <button key={source} onClick={() => setLocation(`/datasets?source=${encodeURIComponent(source)}`)}><span>CONNECTION</span><b>{source}</b><small>{datasets.filter(item => item.sourceType === source).length} datasets in this workspace <ArrowUpRight size={14} /></small></button>)}</div> : <EmptyState title="No connections yet" detail={hasWorkspace ? "Datasets will appear here when a workspace source is registered." : "Create or join a workspace to see its dataset connections."} />}</section></div>;
  }
  return <div className="page-stack"><ModuleHeader eyebrow="BUILD · DATASETS" title={<>DATASET<br /><em>INVENTORY.</em></>} description="Every dataset in the active workspace with its source, stored row count and measured completeness." tabs={tabs} action={<div className="module-filter"><Search size={14} /><Input placeholder="Filter datasets" value={filter} onChange={event => setFilter(event.target.value)} /><select aria-label="Sort datasets" value={sort} onChange={event => setSort(event.target.value as "name" | "quality")}><option value="name">A–Z</option><option value="quality">QUALITY</option></select></div>} /><section className="panel"><SectionLabel title="DATASET INVENTORY" detail="Results are scoped to the active workspace and authenticated membership." />{views.isLoading ? <LoadingRows /> : filtered.length ? <ViewTable headers={["DATASET", "SOURCE", "ROWS", "COMPLETENESS", "PROJECT", "OPEN"]} rows={filtered.map(item => [<span className="table-name">{item.name}</span>, item.sourceType, item.workspaceId === null ? "LEGACY" : item.rowCount.toLocaleString(), item.qualityScore !== null && item.qualityScore !== undefined ? `${item.qualityScore}%` : "—", projectLabel(item.projectId), <ArrowUpRight size={14} />])} onRow={index => setLocation(`/datasets/${filtered[index]?.id ?? ""}`)} /> : (hasWorkspace ? <EmptyState title="No datasets match" detail={filter ? `No dataset matches “${filter}”. Try a different term.` : "No datasets have been added to this workspace yet. Use IMPORT CSV to add one."} /> : <EmptyState title={storageError ? "Workspace data unavailable" : "Workspace required"} detail={storageError ? "The data store could not be reached. You are still signed in." : "Create or join a workspace to see its datasets."} />)}</section></div>;
}

export function PipelineModule({ tab }: { tab: "all" | "runs" }) {
  if (tab === "runs") return <PipelineRunHistoryPage />;
  return <LegacyPipelineRegistry />;
}

/** Pre-Phase-2 registry view over workspace.views; kept for reference. /pipelines now renders PipelineRegistry. */
function LegacyPipelineRegistry() {
  const tab = "all" as "all" | "runs";
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<"name" | "status">("name");
  const { views, hasWorkspace } = useWorkspaceViews();
  const [, setLocation] = useLocation();
  const pipelines = views.data?.pipelines ?? [];
  const filtered = useMemo(() => [...(filter === "all" ? pipelines : pipelines.filter(item => item.status.toLowerCase() === filter))].sort((left, right) => sort === "status" ? left.status.localeCompare(right.status) : left.name.localeCompare(right.name)), [pipelines, filter, sort]);
  const tabs = PIPELINE_TABS;
  return <div className="page-stack"><ModuleHeader eyebrow="BUILD · PIPELINES" title={tab === "runs" ? <>PIPELINE<br /><em>RUNS.</em></> : <>PIPELINE<br /><em>REGISTRY.</em></>} description={tab === "runs" ? "Cross-pipeline execution snapshots, filterable by current registry status." : "All workspace pipelines with owner, state, and execution context."} tabs={tabs} action={<div className="module-filter"><Filter size={14} /><select aria-label="Filter pipelines" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">ALL STATUS</option><option value="healthy">HEALTHY</option><option value="warning">WARNING</option><option value="failed">FAILED</option></select><select aria-label="Sort pipelines" value={sort} onChange={event => setSort(event.target.value as "name" | "status")}><option value="name">A–Z</option><option value="status">STATUS</option></select></div>} /><section className="panel"><SectionLabel title={tab === "runs" ? "EXECUTION SNAPSHOTS" : "ALL PIPELINES"} detail="The current view is derived from existing workspace pipeline records; no new runs table is introduced." />{views.isLoading ? <LoadingRows /> : filtered.length ? <ViewTable headers={["PIPELINE", "STATUS", "PROJECT", "LAST OBSERVED", "OPEN"]} rows={filtered.map(item => [<span className="table-name">{item.name}</span>, <span className={`status ${item.status === "WARNING" ? "status--yellow" : item.status === "FAILED" ? "status--red" : "status--green"}`}>{item.status}</span>, projectLabel(item.projectId), tab === "runs" ? "Current registry snapshot" : "Workspace registry", <ArrowUpRight size={14} />])} onRow={index => setLocation(tab === "runs" ? `/pipelines/runs/${filtered[index]?.id ?? ""}` : `/pipelines/${filtered[index]?.id ?? ""}`)} /> : <EmptyState icon={Gauge} title={hasWorkspace ? "No pipelines in this view" : "Workspace required"} detail={hasWorkspace ? "Try changing the status filter or add a pipeline to this workspace." : "Create or join a workspace to view pipelines."} />}</section></div>;
}

/** Kept for existing imports; the detail page is now the persisted Phase 1 view. */
export function DatasetDetail({ id }: { id: string }) {
  return <PersistedDatasetDetail id={id} />;
}

/** Kept for existing imports; run detail now loads the pipeline_runs record by its real id (Phase 3). */
export function PipelineRunDetail({ id }: { id: string }) {
  return <PersistedRunDetail id={id} />;
}

/** Kept for existing imports; the detail page is now the persisted Phase 2 view. */
export function PipelineDetail({ id }: { id: string }) {
  return <PersistedPipelineDetail id={id} />;
}

/** Kept for existing imports; these views now read persisted changes / risk analyses (Phase 4). */
export function ChangesModule({ history = false }: { history?: boolean }) {
  return history ? <AnalysisHistoryPage /> : <ChangeIntelligencePage />;
}

export function RiskModule({ history = false }: { history?: boolean }) {
  return <RiskAnalysisPage history={history} />;
}

/** Kept for existing imports; monitoring is now computed from stored runs (Phase 7). */
export function MonitoringModule({ anomalies = false }: { anomalies?: boolean }) {
  return <MonitoringPage anomalies={anomalies} />;
}

/** Kept for existing imports; reports are computed from stored records (Phase 8). */
export function ReportsModule() {
  return <ReportsPage />;
}

function SectionLabel({ title, detail }: { title: string; detail?: string }) { return <div className="module-section-label"><div><p className="eyebrow">MODULE VIEW</p><h2>{title}</h2>{detail ? <p>{detail}</p> : null}</div></div>; }
