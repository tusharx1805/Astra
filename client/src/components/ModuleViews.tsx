import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ModuleSubnav, type ModuleTab } from "@/components/ModuleSubnav";
import { SimulatedBadge } from "@/components/SimulatedBadge";
import { trpc } from "@/lib/trpc";
import { activeWorkspaceId, useRecentView } from "@/hooks/useRecentView";
import { ArrowUpRight, Download, FileWarning, Filter, Gauge, Search, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";

function useWorkspaceViews() {
  const query = trpc.workspace.list.useQuery();
  const stored = typeof window === "undefined" ? 0 : Number(localStorage.getItem("astra-active-workspace"));
  const workspaceId = query.data?.find(item => item.id === stored)?.id ?? query.data?.[0]?.id ?? 0;
  const views = trpc.workspace.views.useQuery({ workspaceId }, { enabled: Boolean(workspaceId) });
  return { workspaceId, views, hasWorkspace: Boolean(workspaceId) };
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
  const { views, hasWorkspace } = useWorkspaceViews();
  const datasets = views.data?.datasets ?? [];
  const filtered = useMemo(() => [...datasets.filter(item => `${item.name} ${item.sourceType}`.toLowerCase().includes(filter.toLowerCase()))].sort((left, right) => sort === "quality" ? (right.qualityScore ?? -1) - (left.qualityScore ?? -1) : left.name.localeCompare(right.name)), [datasets, filter, sort]);
  const tabs = [{ label: "EXPLORER", href: "/datasets/explorer" }, { label: "CONNECTIONS", href: "/datasets/connections" }];
  if (tab === "connections") {
    const connections = Array.from(new Set(datasets.map(item => item.sourceType)));
    return <div className="page-stack"><ModuleHeader eyebrow="BUILD · DATASETS" title={<>DATASET<br /><em>CONNECTIONS.</em></>} description="Distinct source systems already represented by datasets in the active workspace." tabs={tabs} /><section className="panel"><SectionLabel title="SOURCE INVENTORY" detail="Live view over the existing dataset sourceType field." />{views.isLoading ? <LoadingRows /> : connections.length ? <div className="connection-grid">{connections.map(source => <button key={source} onClick={() => setLocation(`/datasets/explorer?source=${encodeURIComponent(source)}`)}><span>CONNECTION</span><b>{source}</b><small>{datasets.filter(item => item.sourceType === source).length} datasets in this workspace <ArrowUpRight size={14} /></small></button>)}</div> : <EmptyState title="No connections yet" detail={hasWorkspace ? "Datasets will appear here when a workspace source is registered." : "Create or join a workspace to see its dataset connections."} />}</section></div>;
  }
  return <div className="page-stack"><ModuleHeader eyebrow="BUILD · DATASETS" title={<>DATASET<br /><em>EXPLORER.</em></>} description="Inspect workspace datasets, source systems, and quality scores from one scannable inventory." tabs={tabs} action={<div className="module-filter"><Search size={14} /><Input placeholder="Filter datasets" value={filter} onChange={event => setFilter(event.target.value)} /><select aria-label="Sort datasets" value={sort} onChange={event => setSort(event.target.value as "name" | "quality")}><option value="name">A–Z</option><option value="quality">QUALITY</option></select></div>} /><section className="panel"><SectionLabel title="DATASET INVENTORY" detail="Results are scoped to the active workspace and authenticated membership." />{views.isLoading ? <LoadingRows /> : filtered.length ? <ViewTable headers={["DATASET", "SOURCE", "QUALITY", "PROJECT", "OPEN"]} rows={filtered.map(item => [<span className="table-name">{item.name}</span>, item.sourceType, item.qualityScore ? `${item.qualityScore}%` : "—", `PROJECT ${item.projectId}`, <ArrowUpRight size={14} />])} onRow={index => setLocation(`/datasets/${filtered[index]?.id ?? ""}`)} /> : <EmptyState title="No datasets match" detail={filter ? `No dataset matches “${filter}”. Try a different term.` : "No datasets have been added to this workspace yet."} />}</section></div>;
}

export function PipelineModule({ tab }: { tab: "all" | "runs" }) {
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<"name" | "status">("name");
  const { views, hasWorkspace } = useWorkspaceViews();
  const [, setLocation] = useLocation();
  const pipelines = views.data?.pipelines ?? [];
  const filtered = useMemo(() => [...(filter === "all" ? pipelines : pipelines.filter(item => item.status.toLowerCase() === filter))].sort((left, right) => sort === "status" ? left.status.localeCompare(right.status) : left.name.localeCompare(right.name)), [pipelines, filter, sort]);
  const tabs = [{ label: "ALL PIPELINES", href: "/pipelines" }, { label: "RUNS", href: "/pipelines/runs" }];
  return <div className="page-stack"><ModuleHeader eyebrow="BUILD · PIPELINES" title={tab === "runs" ? <>PIPELINE<br /><em>RUNS.</em></> : <>PIPELINE<br /><em>REGISTRY.</em></>} description={tab === "runs" ? "Cross-pipeline execution snapshots, filterable by current registry status." : "All workspace pipelines with owner, state, and execution context."} tabs={tabs} action={<div className="module-filter"><Filter size={14} /><select aria-label="Filter pipelines" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">ALL STATUS</option><option value="healthy">HEALTHY</option><option value="warning">WARNING</option><option value="failed">FAILED</option></select><select aria-label="Sort pipelines" value={sort} onChange={event => setSort(event.target.value as "name" | "status")}><option value="name">A–Z</option><option value="status">STATUS</option></select></div>} /><section className="panel"><SectionLabel title={tab === "runs" ? "EXECUTION SNAPSHOTS" : "ALL PIPELINES"} detail="The current view is derived from existing workspace pipeline records; no new runs table is introduced." />{views.isLoading ? <LoadingRows /> : filtered.length ? <ViewTable headers={["PIPELINE", "STATUS", "PROJECT", "LAST OBSERVED", "OPEN"]} rows={filtered.map(item => [<span className="table-name">{item.name}</span>, <span className={`status ${item.status === "WARNING" ? "status--yellow" : item.status === "FAILED" ? "status--red" : "status--green"}`}>{item.status}</span>, `PROJECT ${item.projectId}`, tab === "runs" ? "Current registry snapshot" : "Workspace registry", <ArrowUpRight size={14} />])} onRow={index => setLocation(tab === "runs" ? `/pipelines/runs/${filtered[index]?.id ?? ""}` : `/pipelines/${filtered[index]?.id ?? ""}`)} /> : <EmptyState icon={Gauge} title={hasWorkspace ? "No pipelines in this view" : "Workspace required"} detail={hasWorkspace ? "Try changing the status filter or add a pipeline to this workspace." : "Create or join a workspace to view pipelines."} />}</section></div>;
}

export function DatasetDetail({ id }: { id: string }) {
  const { views, hasWorkspace } = useWorkspaceViews();
  const dataset = views.data?.datasets.find(item => String(item.id) === id);
  useRecentView({ workspaceId: activeWorkspaceId(), entityType: "dataset", entityId: dataset ? String(dataset.id) : undefined, entityLabel: dataset?.name });
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">BUILD · DATASETS · DETAIL</p><h1>{dataset?.name ?? "DATASET"}<br /><em>DETAIL.</em></h1><p>Workspace-scoped metadata and quality context for this dataset record.</p></div><SimulatedBadge compact /></section><ModuleSubnav tabs={[{ label: "EXPLORER", href: "/datasets/explorer" }, { label: "CONNECTIONS", href: "/datasets/connections" }]} /><section className="panel">{views.isLoading ? <LoadingRows /> : dataset ? <div className="detail-grid"><div><span>DATASET</span><b>{dataset.name}</b></div><div><span>SOURCE</span><b>{dataset.sourceType}</b></div><div><span>QUALITY SCORE</span><b>{dataset.qualityScore ? `${dataset.qualityScore}%` : "NOT SCORED"}</b></div><div><span>PROJECT SCOPE</span><b>PROJECT {dataset.projectId}</b></div></div> : <EmptyState title={hasWorkspace ? "Dataset not found" : "Workspace required"} detail={hasWorkspace ? "This dataset does not belong to the active workspace." : "Create or join a workspace to inspect dataset details."} />}</section></div>;
}

export function PipelineRunDetail({ id }: { id: string }) {
  const { views, hasWorkspace } = useWorkspaceViews();
  const pipeline = views.data?.pipelines.find(item => String(item.id) === id);
  useRecentView({ workspaceId: activeWorkspaceId(), entityType: "pipeline", entityId: pipeline ? String(pipeline.id) : undefined, entityLabel: pipeline?.name });
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">BUILD · PIPELINES · RUNS · EXECUTION</p><h1>RUN<br /><em>DETAIL.</em></h1><p>Concrete execution-detail destination for the selected pipeline snapshot.</p></div><SimulatedBadge compact /></section><ModuleSubnav tabs={[{ label: "ALL PIPELINES", href: "/pipelines" }, { label: "RUNS", href: "/pipelines/runs" }]} /><section className="panel">{views.isLoading ? <LoadingRows /> : pipeline ? <div className="detail-grid"><div><span>PIPELINE</span><b>{pipeline.name}</b></div><div><span>RUN ID</span><b>RUN-{id}-LATEST</b></div><div><span>STATUS</span><b>{pipeline.status}</b></div><div><span>OBSERVATION</span><b>Latest workspace registry snapshot</b></div></div> : <EmptyState icon={Gauge} title={hasWorkspace ? "Run not found" : "Workspace required"} detail={hasWorkspace ? "This execution does not belong to the active workspace." : "Create or join a workspace to inspect execution details."} />}</section></div>;
}

export function PipelineDetail({ id }: { id: string }) {
  const { views, hasWorkspace } = useWorkspaceViews();
  const pipeline = views.data?.pipelines.find(item => String(item.id) === id);
  useRecentView({ workspaceId: activeWorkspaceId(), entityType: "pipeline", entityId: pipeline ? String(pipeline.id) : undefined, entityLabel: pipeline?.name });
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">BUILD · PIPELINES · DETAIL</p><h1>{pipeline?.name ?? "PIPELINE"}<br /><em>DETAIL.</em></h1><p>Workspace-scoped registry context and latest known status for this pipeline.</p></div><SimulatedBadge compact /></section><ModuleSubnav tabs={[{ label: "ALL PIPELINES", href: "/pipelines" }, { label: "RUNS", href: "/pipelines/runs" }]} /><section className="panel">{views.isLoading ? <LoadingRows /> : pipeline ? <div className="detail-grid"><div><span>PIPELINE</span><b>{pipeline.name}</b></div><div><span>STATUS</span><b>{pipeline.status}</b></div><div><span>PROJECT SCOPE</span><b>PROJECT {pipeline.projectId}</b></div><div><span>OBSERVATION</span><b>Current registry snapshot</b></div></div> : <EmptyState icon={Gauge} title={hasWorkspace ? "Pipeline not found" : "Workspace required"} detail={hasWorkspace ? "This pipeline does not belong to the active workspace." : "Create or join a workspace to inspect pipeline details."} />}</section></div>;
}

export function ChangesModule({ history = false }: { history?: boolean }) {
  const [, setLocation] = useLocation();
  const tabs = [{ label: "SUBMITTED", href: "/changes/submitted" }, { label: "HISTORY", href: "/changes/history" }];
  const rows = history ? [["Orders contract migration", "APPROVED", "REVIEWER · 2d ago"], ["Customer identifier migration", "BLOCKED", "ADMIN · 5d ago"]] : [["Widen customer identifier", "CRITICAL", "14 min ago"], ["Update daily sales schema", "HIGH", "39 min ago"]];
  return <div className="page-stack"><ModuleHeader eyebrow={`INTELLIGENCE · ${history ? "RESOLVED" : "OPEN QUEUE"}`} title={history ? <>CHANGE<br /><em>HISTORY.</em></> : <>SUBMITTED<br /><em>CHANGES.</em></>} description={history ? "Review outcomes and resolved changes from the simulated intelligence queue." : "Incoming code and data changes awaiting simulated analysis or reviewer action."} tabs={tabs} action={<SimulatedBadge compact />} /><section className="panel"><SectionLabel title={history ? "RESOLVED REVIEWS" : "OPEN QUEUE"} detail="Changes and reviews remain simulated in this phase." />{rows.length ? <ViewTable headers={["CHANGE", "STATUS", "ACTIVITY", "OPEN"]} rows={rows.map(row => [<span className="table-name">{row[0]}</span>, <span className={`status ${row[1] === "CRITICAL" || row[1] === "BLOCKED" ? "status--red" : "status--yellow"}`}>{row[1]}</span>, row[2], <ArrowUpRight size={14} />])} onRow={() => setLocation("/changes")} /> : <EmptyState title="No changes yet" detail="Submit a code, schema, configuration, or GitHub change to populate this simulated queue." />}</section></div>;
}

export function RiskModule({ history = false }: { history?: boolean }) {
  const tabs = [{ label: "ACTIVE", href: "/risk-analysis" }, { label: "HISTORY", href: "/risk-analysis/history" }];
  const rows = history ? [["Customer identifier migration", "87", "BLOCKED", "5d ago"], ["Orders contract migration", "61", "APPROVED", "2d ago"]] : [["Customer identifier migration", "87", "CRITICAL", "14 min ago"], ["Daily sales schema", "63", "HIGH", "39 min ago"]];
  return <div className="page-stack"><ModuleHeader eyebrow="INTELLIGENCE · SIMULATED MODEL" title={history ? <>RISK<br /><em>HISTORY.</em></> : <>ACTIVE<br /><em>RISKS.</em></>} description="Browse deterministic simulated risk analyses. No submitted source is executed." tabs={tabs} action={<SimulatedBadge compact />} /><section className="panel"><SectionLabel title={history ? "PAST ANALYSES" : "ACTIVE RISK ANALYSES"} detail="This queue is intentionally mock-backed until the prediction service is connected." />{rows.length ? <ViewTable headers={["CHANGE", "SCORE", "LEVEL", "TIME"]} rows={rows.map(row => [<span className="table-name">{row[0]}</span>, <b>{row[1]}/100</b>, <span className={`status ${row[2] === "CRITICAL" || row[2] === "BLOCKED" ? "status--red" : "status--yellow"}`}>{row[2]}</span>, row[3]])} /> : <EmptyState icon={Sparkles} title="No risk analyses yet" detail="Run a simulated analysis from Change Intelligence to populate this view." />}</section></div>;
}

export function MonitoringModule({ anomalies = false }: { anomalies?: boolean }) {
  const tabs = [{ label: "CHARTS", href: "/monitoring" }, { label: "ANOMALIES", href: "/monitoring/anomalies" }];
  return <div className="page-stack"><ModuleHeader eyebrow="INTELLIGENCE · SIMULATED SERIES" title={anomalies ? <>MONITORING<br /><em>ANOMALIES.</em></> : <>MONITORING<br /><em>CHARTS.</em></>} description={anomalies ? "A filtered view of the same visible monitoring series, showing only flagged deviations." : "Observe execution time, quality, and volume as a single operational series."} tabs={tabs} action={<SimulatedBadge compact />} /><section className="panel"><SectionLabel title={anomalies ? "FLAGGED DEVIATIONS" : "OBSERVED SERIES"} detail="No second anomaly data source is created; this is a filtered view of the existing simulated series." />{anomalies ? <div className="monitor-alert"><FileWarning size={20} /><div><b>customer_etl · 42% above historical baseline</b><p>Simulated anomaly flag. Review the pipeline execution before the next deployment window.</p></div><span className="status status--yellow">WARNING</span></div> : <><div className="chart-ghost chart-ghost--large"><i /><i /><i /><i /><i /><i /><i /><b>SIMULATED SERIES · 30 DAYS</b></div><div className="monitor-stat-grid"><div><span>EXECUTION TIME</span><b>+42%</b></div><div><span>QUALITY VARIANCE</span><b>+1.4%</b></div><div><span>VOLUME CHANGE</span><b>+8.2%</b></div></div></>}</section></div>;
}

export function ReportsModule() {
  const summaries = [{ label: "Pipeline health", value: "92.4%" }, { label: "Active risks", value: "04" }, { label: "Quality score", value: "96.8" }, { label: "Failed runs", value: "03" }];
  const exportCsv = () => { const csv = ["metric,value", ...summaries.map(item => `${item.label},${item.value}`)].join("\n"); const blob = new Blob([csv], { type: "text/csv" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "astra-report.csv"; link.click(); URL.revokeObjectURL(url); };
  return <div className="page-stack"><ModuleHeader eyebrow="REPORTS · SUMMARY EXPORT" title={<>RISK<br /><em>REPORTS.</em></>} description="Review-ready summaries using the KPI data already computed in ASTRA’s overview surfaces." tabs={[{ label: "SUMMARY", href: "/reports" }, { label: "EXPORTS", href: "/reports/exports" }]} action={<Button className="button-red" onClick={exportCsv}><Download size={14} /> EXPORT CSV</Button>} /><section className="report-grid">{summaries.map(item => <article key={item.label}><span>{item.label}</span><b>{item.value}</b><small>SUMMARY SNAPSHOT</small></article>)}</section><section className="panel"><SectionLabel title="REPORT CONTENT" detail="Client-side CSV export contains only the visible summary metrics." /><div className="report-note"><Sparkles size={18} /><p><b>Ready for review.</b><br />Use this summary to package operational context before a change review. Simulated intelligence remains labeled in source workspaces.</p></div></section></div>;
}

function SectionLabel({ title, detail }: { title: string; detail?: string }) { return <div className="module-section-label"><div><p className="eyebrow">MODULE VIEW</p><h2>{title}</h2>{detail ? <p>{detail}</p> : null}</div></div>; }
