import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SimulatedBadge } from "@/components/SimulatedBadge";
import { ModuleSubnav } from "@/components/ModuleSubnav";
import { trpc } from "@/lib/trpc";
import { executeCsvPreview } from "@/lib/csvQuery";
import { ArrowUpRight, Check, Clock3, Database, FileClock, FolderKanban, GitBranch, History, Play, Plug, Search, UploadCloud, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

const connectorTypes = [
  { name: "PostgreSQL", icon: Database, status: "COMING SOON", detail: "Relational source connector" },
  { name: "CSV / Files", icon: UploadCloud, status: "AVAILABLE", detail: "Upload and query preview data" },
  { name: "REST APIs", icon: Plug, status: "COMING SOON", detail: "Ingest from HTTP sources" },
  { name: "GitHub", icon: GitBranch, status: "COMING SOON", detail: "Code and change context" },
  { name: "MySQL", icon: Database, status: "COMING SOON", detail: "Relational source connector" },
  { name: "MinIO / S3", icon: UploadCloud, status: "COMING SOON", detail: "Object-storage files" },
  { name: "Airflow", icon: GitBranch, status: "COMING SOON", detail: "Pipeline execution context" },
  { name: "Other", icon: Plug, status: "COMING SOON", detail: "Tell us what you use" },
];

type WorkspaceRef = { id: number; name: string; role: string };

function useWorkspaceRef() {
  const { isAuthenticated } = useAuth();
  const query = trpc.workspace.list.useQuery(undefined, { enabled: isAuthenticated });
  const [location] = useLocation();
  const storedId = typeof window === "undefined" ? 0 : Number(localStorage.getItem("astra-active-workspace"));
  const workspace = query.data?.find(item => item.id === storedId) ?? query.data?.[0];
  return { query, workspace: workspace as WorkspaceRef | undefined, location };
}

function ModuleHeader({ eyebrow, title, description, tabs, action }: { eyebrow: string; title: React.ReactNode; description: string; tabs?: Array<{ label: string; href: string }>; action?: React.ReactNode }) {
  return <><section className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</section>{tabs ? <ModuleSubnav tabs={tabs} /> : null}</>;
}

function Empty({ icon: Icon, title, detail, action }: { icon: typeof History; title: string; detail: string; action?: React.ReactNode }) {
  return <div className="workspace-empty module-empty"><Icon size={22} /><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

export function RecentsModule() {
  const [, setLocation] = useLocation();
  const { workspace, query } = useWorkspaceRef();
  const recents = trpc.workspace.recents.useQuery({ workspaceId: workspace?.id ?? 0 }, { enabled: Boolean(workspace?.id) });
  const hrefFor = (type: string, id: string) => type === "dataset" ? `/datasets/${id}` : type === "pipeline" ? `/pipelines/${id}` : `/projects/${id}`;
  return <div className="page-stack"><ModuleHeader eyebrow="UTILITY · WORKSPACE MEMORY" title={<>RECENT<br /><em>ACTIVITY.</em></>} description="The last resources you opened in this workspace, most recent first. History is private to your user and workspace." action={<History size={30} className="module-mark" />} /><section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">RECENTLY VIEWED</p><h2>LAST 20 ITEMS</h2></div><span className="module-meta">{workspace?.name ?? "NO WORKSPACE"}</span></div>{query.isLoading || recents.isLoading ? <div className="workspace-loading"><span>LOADING RECENTS…</span></div> : recents.data?.length ? <div className="recent-list">{recents.data.map(item => <button key={item.id} onClick={() => setLocation(hrefFor(item.entityType, item.entityId))}><span className="recent-icon">{item.entityType === "dataset" ? <Database size={16} /> : item.entityType === "pipeline" ? <GitBranch size={16} /> : <FolderKanban size={16} />}</span><span><b>{item.entityLabel}</b><small>{item.entityType.toUpperCase()} · {new Date(item.viewedAt).toLocaleString()}</small></span><ArrowUpRight size={15} /></button>)}</div> : <Empty icon={History} title="Nothing viewed yet" detail="Open a project, dataset, or pipeline detail page and it will appear here for this workspace." />}</section></div>;
}

export function IntegrationsModule() {
  const [workspaceId] = useState(() => Number(localStorage.getItem("astra-active-workspace")) || 0);
  const [, setLocation] = useLocation();
  const [pgHost, setPgHost] = useState("localhost");
  const [pgDatabase, setPgDatabase] = useState("analytics");
  const [pgUsername, setPgUsername] = useState("readonly");
  const testPostgres = trpc.workspace.testPostgresConnection.useMutation({ onSuccess: result => toast.message(result.ok ? "PostgreSQL connection ready" : "PostgreSQL connection deferred", { description: result.message }), onError: error => toast.error("Connection test failed", { description: error.message }) });
  const createAttempt = trpc.workspace.createIngestionAttempt.useMutation({ onSuccess: () => { toast.success("CSV connection started", { description: "The ingestion attempt is now visible in Data Ingestion." }); setLocation("/ingestion"); }, onError: error => toast.error("Connection could not start", { description: error.message }) });
  return <div className="page-stack"><ModuleHeader eyebrow="UTILITY · DATA CONNECTIONS" title={<>CONNECT<br /><em>SOURCES.</em></>} description="Browse the connector types ASTRA currently understands. Only CSV / Files is available in this environment; other sources are honest about their status." action={<Plug size={30} className="module-mark" />} /><section className="connector-grid">{connectorTypes.map(connector => { const Icon = connector.icon; const available = connector.status === "AVAILABLE"; return <article className="connector-card" key={connector.name}><div className="connector-card__icon"><Icon size={20} /></div><p className="eyebrow">{available ? "READY" : "ROADMAP"}</p><h3>{connector.name}</h3><p>{connector.detail}</p><span className={available ? "connector-status connector-status--available" : "connector-status"}>{connector.status}</span><Button className={available && workspaceId ? "button-red" : "button-muted"} disabled={!available || !workspaceId || createAttempt.isPending} onClick={() => createAttempt.mutate({ workspaceId, datasetName: "new_csv_dataset", sourceType: "CSV / Files", status: "pending" })}>{available ? (workspaceId ? "CONNECT" : "SELECT WORKSPACE") : "COMING SOON"}</Button></article>; })}</section><section className="panel postgres-test-panel"><div><p className="eyebrow">POSTGRESQL · SAFE TEST</p><h2>CHECK READ-ONLY ACCESS</h2><p className="panel-copy">Fixture mode accepts connection metadata only. It never opens a socket, stores a password, or returns credentials until CONNECTION_ENCRYPTION_KEY is configured.</p></div><div className="workspace-form"><Input value={pgHost} onChange={event => setPgHost(event.target.value)} placeholder="Host" /><Input value={pgDatabase} onChange={event => setPgDatabase(event.target.value)} placeholder="Database name" /><Input value={pgUsername} onChange={event => setPgUsername(event.target.value)} placeholder="Username" /><Button variant="outline" disabled={!workspaceId || testPostgres.isPending} onClick={() => testPostgres.mutate({ workspaceId, host: pgHost, port: 5432, databaseName: pgDatabase, username: pgUsername, ssl: true })}>{testPostgres.isPending ? "CHECKING" : "TEST CONNECTION"}</Button></div></section><section className="panel"><SimulatedBadge compact /><p className="panel-copy">Connector availability reflects the current ASTRA product boundary. CSV fixtures are usable now; PostgreSQL connector actions are safely staged and remain disabled for live network access until the production encryption key is supplied.</p></section></div>;
}

export function SavedQueriesModule() {
  const { workspace } = useWorkspaceRef();
  const views = trpc.workspace.views.useQuery({ workspaceId: workspace?.id ?? 0 }, { enabled: Boolean(workspace?.id) });
  const queries = trpc.workspace.savedQueries.useQuery({ workspaceId: workspace?.id ?? 0 }, { enabled: Boolean(workspace?.id) });
  const [name, setName] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [sql, setSql] = useState("SELECT * FROM preview LIMIT 25");
  const [csvPreview, setCsvPreview] = useState("email,status\na@company.com,active\nb@company.com,paused");
  const runQuery = trpc.workspace.recordQueryRun.useMutation({ onSuccess: result => toast.success("CSV preview query completed", { description: `Run ${result.id} was logged in Query History.` }), onError: error => toast.error("Query run could not be logged", { description: error.message }) });
  const create = trpc.workspace.createSavedQuery.useMutation({ onSuccess: () => { queries.refetch(); setName(""); toast.success("Saved query created", { description: "The query is now available to workspace members." }); }, onError: error => toast.error("Query could not be saved", { description: error.message }) });
  const csvDatasets = views.data?.datasets.filter(item => item.sourceType === "CSV / Files") ?? [];
  return <div className="page-stack"><ModuleHeader eyebrow="EXPLORE · CSV / FILES" title={<>SAVED<br /><em>QUERIES.</em></>} description="Store SQL text against a CSV-backed dataset. Run actions execute only against the already-loaded client preview rows." tabs={[{ label: "SAVED QUERIES", href: "/saved-queries" }, { label: "QUERY HISTORY", href: "/query-history" }]} action={<SimulatedBadge compact />} /><div className="split-grid"><section className="panel"><p className="eyebrow">NEW SAVED QUERY</p><h2>STORE A QUERY</h2><div className="workspace-form"><div><label htmlFor="query-name">QUERY NAME</label><Input id="query-name" placeholder="Customers with missing email" value={name} onChange={event => setName(event.target.value)} /></div><div><label htmlFor="query-dataset">CSV DATASET</label><select id="query-dataset" value={datasetId} onChange={event => setDatasetId(event.target.value)}><option value="">Select a CSV / Files dataset</option>{csvDatasets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><div><label htmlFor="query-sql">SQL TEXT</label><Textarea id="query-sql" value={sql} onChange={event => setSql(event.target.value)} /></div><div><label htmlFor="csv-preview">CSV PREVIEW ROWS</label><Textarea id="csv-preview" value={csvPreview} onChange={event => setCsvPreview(event.target.value)} /></div><Button className="button-red" disabled={!workspace?.id || !datasetId || !name.trim() || create.isPending} onClick={() => create.mutate({ workspaceId: workspace!.id, datasetId: Number(datasetId), name: name.trim(), sqlText: sql })}>SAVE QUERY</Button></div></section><section className="panel"><p className="eyebrow">CAPABILITY BOUNDARY</p><h2>CSV PREVIEW ONLY</h2><p className="panel-copy">ASTRA does not send this SQL to a warehouse. The future execution adapter will parse a loaded CSV preview in the browser and write a query-run record with its measured row count and duration.</p><SimulatedBadge compact /></section></div><section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">QUERY LIBRARY</p><h2>{queries.data?.length ?? 0} SAVED</h2></div><span className="module-meta">WORKSPACE READ ACCESS</span></div>{queries.isLoading ? <div className="workspace-loading"><span>LOADING SAVED QUERIES…</span></div> : queries.data?.length ? <div className="query-list">{queries.data.map(item => <article key={item.id}><div><b>{item.name}</b><span>{item.datasetName} · {new Date(item.createdAt).toLocaleDateString()}</span></div><code>{item.sqlText}</code><Button variant="outline" onClick={() => { try { const result = executeCsvPreview(item.sqlText, csvPreview); if (!workspace?.id) throw new Error("Select a workspace first."); runQuery.mutate({ workspaceId: workspace.id, queryId: item.id, rowCount: result.rows.length, durationMs: result.durationMs }); } catch (error) { toast.error("Preview query not run", { description: error instanceof Error ? error.message : "Invalid CSV preview." }); } }} disabled={runQuery.isPending}><Play size={14} /> RUN</Button></article>)}</div> : <Empty icon={Search} title="No saved queries yet" detail={csvDatasets.length ? "Save a query above to build a shared CSV-preview library." : "A CSV / Files dataset is required before a query can be saved."} />}</section></div>;
}

export function QueryHistoryModule() {
  const { workspace } = useWorkspaceRef();
  const runs = trpc.workspace.queryRuns.useQuery({ workspaceId: workspace?.id ?? 0 }, { enabled: Boolean(workspace?.id) });
  return <div className="page-stack"><ModuleHeader eyebrow="EXPLORE · EXECUTION LOG" title={<>QUERY<br /><em>HISTORY.</em></>} description="Every saved-query execution recorded with returned row count, duration, dataset context, and timestamp." tabs={[{ label: "SAVED QUERIES", href: "/saved-queries" }, { label: "QUERY HISTORY", href: "/query-history" }]} /><section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">RUN LOG</p><h2>RECENT EXECUTIONS</h2></div><FileClock size={22} className="module-mark" /></div>{runs.isLoading ? <div className="workspace-loading"><span>LOADING QUERY HISTORY…</span></div> : runs.data?.length ? <div className="history-list">{runs.data.map(run => <div key={run.id}><span><b>{run.queryName}</b><small>{new Date(run.runAt).toLocaleString()}</small></span><span><b>{run.rowCount.toLocaleString()}</b><small>ROWS RETURNED</small></span><span><b>{run.durationMs}ms</b><small>DURATION</small></span></div>)}</div> : <Empty icon={Clock3} title="No query runs yet" detail="Run a saved query against a CSV preview to create a real execution history record." />}</section></div>;
}

export function IngestionModule() {
  const { workspace } = useWorkspaceRef();
  const attempts = trpc.workspace.ingestionAttempts.useQuery({ workspaceId: workspace?.id ?? 0 }, { enabled: Boolean(workspace?.id) });
  const [, setLocation] = useLocation();
  return <div className="page-stack"><ModuleHeader eyebrow="DATA ENGINEERING · SOURCE HISTORY" title={<>DATA<br /><em>INGESTION.</em></>} description="Every ingestion attempt across the active workspace, with a direct path back to the existing connection flow." tabs={[{ label: "INGESTION", href: "/ingestion" }, { label: "LINEAGE", href: "/lineage" }]} action={<Button className="button-red" onClick={() => setLocation("/integrations")}>+ NEW INGESTION</Button>} /><section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">INGESTION ATTEMPTS</p><h2>WORKSPACE HISTORY</h2></div><span className="module-meta">REAL PERSISTED LOG</span></div>{attempts.isLoading ? <div className="workspace-loading"><span>LOADING INGESTION HISTORY…</span></div> : attempts.data?.length ? <div className="history-list ingestion-list">{attempts.data.map(attempt => <div key={attempt.id}><span><b>{attempt.datasetName}</b><small>{attempt.sourceType}</small></span><span className={`status ${attempt.status === "failed" ? "status--red" : attempt.status === "complete" ? "status--green" : "status--yellow"}`}>{attempt.status.toUpperCase()}</span><span><b>{attempt.rowsIngested.toLocaleString()}</b><small>ROWS INGESTED</small></span><span><b>{new Date(attempt.createdAt).toLocaleString()}</b><small>TIMESTAMP</small></span></div>)}</div> : <Empty icon={UploadCloud} title="No ingestion attempts" detail="Connect a CSV / Files source from Integrations to start a persisted workspace ingestion record." action={<Button className="button-red" onClick={() => setLocation("/integrations")}>BROWSE INTEGRATIONS</Button>} />}</section></div>;
}

export function DashboardModule() { return <div className="page-stack"><ModuleHeader eyebrow="EXPLORE · RISK & HEALTH" title={<>DATA<br /><em>DASHBOARDS.</em></>} description="The existing ASTRA overview surfaces operational health, quality, and risk in one dashboard context." tabs={[{ label: "SUMMARY", href: "/reports" }, { label: "EXPORTS", href: "/reports/exports" }]} /><section className="panel"><SimulatedBadge compact /><h2>USE OVERVIEW AS THE LIVE DASHBOARD</h2><p className="panel-copy">Dashboards remain an honest alias for the current ASTRA overview while richer saved dashboard layouts are developed.</p><Button className="button-red" onClick={() => window.location.assign("/")}>OPEN OVERVIEW</Button></section></div>; }

export function PipelineRunsModule() { return <div className="page-stack"><ModuleHeader eyebrow="DATA ENGINEERING · PIPELINE EXECUTION" title={<>PIPELINE<br /><em>RUNS.</em></>} description="Execution snapshots currently derived from the workspace pipeline registry." tabs={[{ label: "RUNS", href: "/pipeline-runs" }, { label: "LINEAGE", href: "/lineage" }]} /><section className="panel"><SimulatedBadge compact /><h2>PIPELINE RUN HISTORY</h2><p className="panel-copy">Open a pipeline from the existing Pipelines module to inspect its current registry state and concrete run destination.</p><Button className="button-red" onClick={() => window.location.assign("/pipelines/runs")}>OPEN PIPELINES</Button></section></div>; }
