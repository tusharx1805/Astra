import Editor from "@monaco-editor/react";
import { useAuth } from "@/_core/hooks/useAuth";
import { LineagePage } from "@/components/LineageModules";
import { IncidentDetailPage, IncidentsPage, MonitoringPage, QualityPage } from "@/components/OpsModules";
import { DashboardsPage, LiveOverview, ReportExportsPage, ReportsPage } from "@/components/DashboardModules";
import { SimulatedBadge } from "@/components/SimulatedBadge";
import WorkspaceHub, { WorkspaceSelector } from "@/components/WorkspaceHub";
import { CommandPalette } from "@/components/CommandPalette";
import { getAstraRouteKind } from "@/lib/astraRoutes";
import { ChangesModule, DatasetModule, MonitoringModule, PipelineModule, PipelineRunDetail, ReportsModule, RiskModule } from "@/components/ModuleViews";
import { ConnectionDetailPage } from "@/components/ConnectionModules";
import { AiActivityPage } from "@/components/AiModules";
import { AdminPage, SettingsPage } from "@/components/AccountModules";
import { DashboardModule, IngestionModule, IntegrationsModule, PipelineRunsModule, QueryHistoryModule, RecentsModule, SavedQueriesModule } from "@/components/AdditionalModules";
import { FixtureDatasetExplorer, FixturePipelineBuilder } from "@/components/RealDataFlowModules";
import { PersistedPipelineDetail, PipelineEditor, PipelineRegistry } from "@/components/PipelineModules";
import { PersistedRunDetail, PipelineRunHistoryPage } from "@/components/PipelineRunModules";
import { AnalysisHistoryPage, CHANGE_TABS, ChangeDetailPage, ChangeIntelligencePage, ReviewsPage, RiskAnalysisPage } from "@/components/ChangeModules";
import { ModuleSubnav } from "@/components/ModuleSubnav";
import { DatasetImportPage, PersistedDatasetDetail, PersistedDatasetExplorer } from "@/components/DatasetModules";
import { useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Activity,
  AlertOctagon,
  Bell,
  BookOpen,
  Bot,
  Boxes,
  Braces,
  ChevronDown,
  CircleDot,
  ClipboardCheck,
  Database,
  FileWarning,
  FolderKanban,
  Gauge,
  GitBranch,
  LayoutDashboard,
  Menu,
  PanelRight,
  Play,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
  Plus,
  Plug,
  UploadCloud,
  History,
  LogOut,
  FileText,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";

type Role = "ADMIN" | "DEVELOPER" | "REVIEWER";
type NavItem = { label: string; path: string; icon: typeof LayoutDashboard; group?: string };
type RiskAnalysisUi = {
  id: string;
  score: number;
  level: "SAFE" | "MEDIUM" | "HIGH" | "CRITICAL";
  predictionProbability: number;
  summary: string;
  simulated: true;
  notificationDispatched: boolean;
  factors: Array<{ label: string; weight: number; tone: "critical" | "warning" | "neutral" }>;
  affectedEntities: Array<{ type: "dataset" | "pipeline" | "dashboard" | "model"; name: string; owner: string; severity: "SAFE" | "MEDIUM" | "HIGH" | "CRITICAL" }>;
  explanation: string[];
  analysisStages: Array<{ label: string; status: "complete" }>;
};

const navItems: NavItem[] = [
  { label: "Overview", path: "/", icon: LayoutDashboard },
  { label: "Recents", path: "/recents", icon: History },
  { label: "Catalog", path: "/catalog", icon: Database },
  { label: "Pipelines", path: "/pipelines", icon: Activity },
  { label: "Integrations", path: "/integrations", icon: Plug },
  { label: "Saved Queries", path: "/saved-queries", icon: Search, group: "EXPLORE" },
  { label: "Query History", path: "/query-history", icon: History },
  { label: "Data Quality", path: "/quality", icon: ClipboardCheck },
  { label: "Dashboards", path: "/dashboards", icon: BookOpen },
  { label: "Reports", path: "/reports", icon: FileText },
  { label: "Pipeline Runs", path: "/pipeline-runs", icon: Activity, group: "DATA ENGINEERING" },
  { label: "Data Ingestion", path: "/ingestion", icon: UploadCloud },
  { label: "Lineage", path: "/lineage", icon: GitBranch },
  { label: "Change Intelligence", path: "/changes", icon: Braces, group: "INTELLIGENCE" },
  { label: "Risk Analysis", path: "/risk-analysis", icon: AlertOctagon },
  { label: "Incidents", path: "/incidents", icon: FileWarning },
  { label: "AI Assistant", path: "/agents", icon: Bot },
  { label: "Monitoring", path: "/monitoring", icon: Gauge },
];

const demoSource = "ALTER TABLE customers ALTER COLUMN customer_id TYPE VARCHAR;";

const initialAnalysis: RiskAnalysisUi = {
  id: "RA-DEMO87",
  score: 87,
  level: "CRITICAL",
  predictionProbability: 91,
  summary: "Reviewer attention required before deployment.",
  simulated: true as const,
  notificationDispatched: false,
  factors: [
    { label: "Breaking datatype compatibility", weight: 32, tone: "critical" as const },
    { label: "Identity-column contract exposure", weight: 21, tone: "critical" as const },
    { label: "Downstream customer lineage", weight: 15, tone: "warning" as const },
    { label: "Schema migration surface", weight: 10, tone: "warning" as const },
  ],
  affectedEntities: [
    { type: "dataset", name: "customers", owner: "Maya Chen", severity: "CRITICAL" },
    { type: "pipeline", name: "customer_etl", owner: "Data Platform", severity: "HIGH" },
    { type: "dashboard", name: "Customer 360", owner: "Revenue Ops", severity: "HIGH" },
    { type: "model", name: "Fraud Model", owner: "Risk Intelligence", severity: "MEDIUM" },
  ],
  explanation: [
    "The proposed type change can invalidate downstream joins, validators, and warehouse contracts that expect a numeric identifier.",
    "Customer-domain lineage reaches four named downstream entities, increasing its coordination and rollback burden.",
    "No destructive statement was detected; source is analyzed only and is not executed.",
  ],
  analysisStages: ["Change detected", "Schema compatibility checked", "Lineage analyzed", "Blast radius calculated", "Historical incident fixtures searched", "Risk predicted", "Explanation generated"].map(label => ({ label, status: "complete" as const })),
};

const healthRows = [
  { name: "customer_etl", status: "AT RISK", duration: "08m 42s", rows: "1.24M", quality: "94.1%", time: "14 min ago" },
  { name: "fraud_features", status: "HEALTHY", duration: "12m 11s", rows: "892K", quality: "99.2%", time: "39 min ago" },
  { name: "daily_sales", status: "WARNING", duration: "04m 58s", rows: "217K", quality: "97.8%", time: "1h ago" },
];

const projectRows = [
  { name: "Customer Analytics", environment: "Production", pipelines: 12, datasets: 8, risk: "CRITICAL", activity: "14 min ago" },
  { name: "Fraud Detection", environment: "Production", pipelines: 7, datasets: 5, risk: "HEALTHY", activity: "39 min ago" },
  { name: "Sales Intelligence", environment: "Staging", pipelines: 4, datasets: 3, risk: "WARNING", activity: "2h ago" },
];

function NewMenu({ onNavigate }: { onNavigate: (path: string) => void }) {
  return <details className="new-menu"><summary><Plus size={15} /><span>NEW</span></summary><div className="new-menu__panel"><button onClick={() => onNavigate("/projects?create=1")}><FolderKanban size={15} /> NEW PROJECT</button><button onClick={() => onNavigate("/pipelines/create")}><Activity size={15} /> NEW PIPELINE</button><button onClick={() => onNavigate("/datasets/import")}><Database size={15} /> IMPORT DATASET</button><button onClick={() => onNavigate("/changes")}><Braces size={15} /> SUBMIT CHANGE</button></div></details>;
}

function Status({ children }: { children: string }) {
  const tone = children === "CRITICAL" || children === "FAILED" || children === "BLOCKED" || children === "AT RISK"
    ? "status--red"
    : children === "WARNING" || children === "HIGH" || children === "CHANGES REQUESTED"
      ? "status--yellow"
      : children === "MEDIUM"
        ? "status--blue"
        : "status--green";
  return <span className={`status ${tone}`}>{children}</span>;
}

function Metric({ value, label, delta, alert }: { value: string; label: string; delta: string; alert?: boolean }) {
  return (
    <div className={`metric-card ${alert ? "metric-card--alert" : ""}`}>
      <p className="metric-card__value">{value}</p>
      <p className="metric-card__label">{label}</p>
      <p className="metric-card__delta">{delta}</p>
    </div>
  );
}

function SectionTitle({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail?: string; action?: React.ReactNode }) {
  return (
    <div className="section-title">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        {detail ? <p className="section-title__detail">{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}

function DataTable({ rows = healthRows }: { rows?: typeof healthRows }) {
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead><tr><th>PIPELINE / RESOURCE</th><th>STATUS</th><th>LAST RUN</th><th>VOLUME</th><th>QUALITY</th><th>TIME</th></tr></thead>
        <tbody>
          {rows.map(row => <tr key={row.name}><td className="table-name">{row.name}</td><td><Status>{row.status}</Status></td><td>{row.duration}</td><td>{row.rows}</td><td>{row.quality}</td><td>{row.time}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

function Overview(_props: { workspaceId: number | null; isAuthenticated: boolean }) {
  // Phase 8: every figure comes from reports.workspace (shared/report.ts) — the same builder as Reports and its CSV export.
  return <LiveOverview />;
}

function Changes({ role, setRole }: { role: Role; setRole: (role: Role) => void }) {
  const { user: accountUser } = useAuth();
  const accountMayReview = accountUser?.role === "reviewer" || accountUser?.role === "admin";
  const [source, setSource] = useState(demoSource);
  const [analysis, setAnalysis] = useState<RiskAnalysisUi>(initialAnalysis);
  const [decision, setDecision] = useState<string | null>(null);
  const analyze = trpc.changeIntelligence.analyze.useMutation({
    onSuccess: result => { setAnalysis(result); toast.success("Simulated risk analysis complete", { description: result.notificationDispatched ? "Project owner notified." : "Owner notification was queued or unavailable." }); },
    onError: () => toast.error("Analysis service is unavailable. The visible result remains simulated."),
  });
  const review = trpc.changeIntelligence.recordSandboxReview.useMutation({
    onSuccess: result => { setDecision(result.decision); toast.success(`${result.decision.replaceAll("_", " ")} (simulated)`, { description: "Sandbox decisions are kept in server memory only and are NOT saved. Review real changes from Change Intelligence." }); },
    // No fake success: a failed mutation records nothing, so the UI must not show a decision.
    onError: error => { toast.error("Decision not recorded", { description: error.data?.code === "UNAUTHORIZED" ? "Sign in with a reviewer or admin account to record decisions." : error.message }); },
  });

  const runAnalysis = () => analyze.mutate({ title: "Widen customer identifier", changeType: "SQL", source });
  const decide = (next: "APPROVED" | "BLOCKED" | "CHANGES_REQUESTED") => {
    if (role === "DEVELOPER") { toast.error("Reviewer action unavailable", { description: "The interface hides review controls for Developer. Server-side role checks remain authoritative." }); return; }
    review.mutate({ changeId: analysis.id, decision: next, comment: "Simulated review action from ASTRA preview", riskLevel: analysis.level });
  };

  return (
    <div className="page-stack">
      <section className="page-heading heading-with-tools">
        <div><p className="eyebrow">SIMULATED SANDBOX · NOT SAVED</p><h1>SQL<br /><em>SANDBOX.</em></h1><p>Free-text SQL is only pattern-matched by the deterministic demo engine: never executed, never stored, and not the real risk analysis. Real analyses come from ANALYZE RISK in the pipeline editor.</p></div>
        <div className="role-switcher"><span>UI PREVIEW ROLE</span><div>{(["ADMIN", "DEVELOPER", "REVIEWER"] as Role[]).map(item => <button key={item} onClick={() => setRole(item)} className={role === item ? "active" : ""}>{item}</button>)}</div></div>
      </section>
      <ModuleSubnav tabs={CHANGE_TABS} />
      <div className="analysis-layout">
        <section className="panel code-panel">
          <div className="panel-bar"><span><CircleDot size={14} /> SQL CHANGE</span><SimulatedBadge compact /></div>
          <Editor height="410px" defaultLanguage="sql" value={source} onChange={value => setSource(value ?? "")} theme="vs-dark" options={{ minimap: { enabled: false }, fontSize: 14, lineNumbersMinChars: 3, scrollBeyondLastLine: false, padding: { top: 18 } }} />
          <div className="code-footer"><span>ASTRA ONLY PARSES THIS SOURCE. NO STATEMENT IS EXECUTED.</span><Button className="button-red" onClick={runAnalysis} disabled={analyze.isPending}><Play size={14} fill="currentColor" /> {analyze.isPending ? "ANALYZING" : "RUN ANALYSIS"}</Button></div>
        </section>
        <section className="panel analysis-stage-panel">
          <p className="eyebrow">ANALYSIS PIPELINE</p>
          <ol className="stage-list">{analysis.analysisStages.map((stage, index) => <li key={stage.label}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{stage.label}</b><small>COMPLETE · SIMULATED</small></div><ShieldCheck size={15} /></li>)}</ol>
        </section>
        <section className="panel risk-result">
          <SimulatedBadge compact />
          <div className="score-block"><span>RISK SCORE</span><strong>{analysis.score}</strong><em>/100</em><Status>{analysis.level}</Status></div>
          <p className="risk-summary">{analysis.summary}</p>
          <div className="probability-row"><span>FAILURE PROBABILITY</span><b>{analysis.predictionProbability}%</b></div>
          <div className="factor-bars">{analysis.factors.map(factor => <div key={factor.label}><p><span>{factor.label}</span><b>{factor.weight}%</b></p><i className={factor.tone} style={{ width: `${factor.weight * 2.5}%` }} /></div>)}</div>
          <div className="review-actions">
            <p>{decision ? `DECISION · ${decision.replaceAll("_", " ")}` : "REVIEW REQUIRED"}</p>
            {role !== "DEVELOPER" && accountMayReview ? <div><Button variant="outline" onClick={() => decide("CHANGES_REQUESTED")} disabled={review.isPending}>REQUEST CHANGES</Button><Button className="button-red" onClick={() => decide("BLOCKED")} disabled={review.isPending}>BLOCK DEPLOY</Button></div> : <small>{accountMayReview ? "Developer preview role cannot decide." : "Sandbox decisions need an account-level reviewer or admin role (Supabase app_metadata.astra_role). Real changes are reviewed with your workspace role in Change Intelligence."}</small>}
          </div>
        </section>
      </div>
      <div className="split-grid">
        <section className="panel">
          <SectionTitle eyebrow="WHY ASTRA FLAGS THIS" title="EXPLANATION" action={<SimulatedBadge compact />} />
          <ol className="numbered-explanation">{analysis.explanation.map((text, index) => <li key={text}><span>{index + 1}</span><p>{text}</p></li>)}</ol>
        </section>
        <section className="panel">
          <SectionTitle eyebrow="IMPACT SURFACE" title="BLAST RADIUS" detail={`${analysis.affectedEntities.length} named dependencies are present in the simulated fixture.`} />
          <div className="entity-grid">{analysis.affectedEntities.map(entity => <div key={entity.name} className="entity-card"><span>{entity.type.toUpperCase()}</span><b>{entity.name}</b><small>{entity.owner}</small><Status>{entity.severity}</Status></div>)}</div>
        </section>
      </div>
    </div>
  );
}

function Lineage() {
  // Phase 6: built from stored datasets, pipeline definitions and run outputs (see LineageModules).
  return <LineagePage />;
}

function RealProjects() {
  const active = useActiveWorkspace();
  const utils = trpc.useUtils();
  const workspaceId = active.workspaceId;
  const list = trpc.project.list.useQuery({ workspaceId }, { enabled: Boolean(workspaceId) });
  const search = useSearch();
  const [open, setOpen] = useState(() => new URLSearchParams(search).get("create") === "1");
  useEffect(() => { if (new URLSearchParams(search).get("create") === "1") setOpen(true); }, [search]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [environment, setEnvironment] = useState<"Production" | "Staging" | "Development">("Development");
  const create = trpc.project.create.useMutation({
    onSuccess: project => { toast.success("Project created", { description: `${project.name} · ${project.environment}` }); setName(""); setDescription(""); setOpen(false); void utils.project.list.invalidate({ workspaceId }); void utils.workspace.views.invalidate({ workspaceId }); },
    onError: error => toast.error("Project not created", { description: error.message }),
  });
  const canCreate = active.role === "owner" || active.role === "admin";
  if (!active.isAuthenticated) return <section className="panel"><SectionTitle eyebrow="ORGANIZATION PROJECTS" title="PROJECTS" detail="Sign in to create and list real projects." /></section>;
  return <section className="panel"><SectionTitle eyebrow={`ORGANIZATION PROJECTS · ${active.workspace?.name ?? "NO WORKSPACE"}`} title="PROJECTS" detail="Stored in the database for this workspace's organization." action={<Button className="button-red" disabled={!workspaceId || !canCreate} title={canCreate ? undefined : "Only workspace owners and admins can create projects"} onClick={() => setOpen(value => !value)}>{open ? "CANCEL" : "CREATE PROJECT"}</Button>} />{open && !canCreate ? <p className="form-error">Only workspace owners and admins can create projects. Ask an admin of this workspace.</p> : null}{open && canCreate ? <div className="workspace-form"><Input aria-label="Project name" placeholder="Project name" value={name} onChange={event => setName(event.target.value)} maxLength={160} /><Input aria-label="Project description" placeholder="Description (optional)" value={description} onChange={event => setDescription(event.target.value)} maxLength={1000} /><select aria-label="Environment" value={environment} onChange={event => setEnvironment(event.target.value as typeof environment)}><option>Development</option><option>Staging</option><option>Production</option></select><Button className="button-red" disabled={!canCreate || name.trim().length < 3 || create.isPending} title={canCreate ? undefined : "Only workspace owners and admins can create projects"} onClick={() => create.mutate({ workspaceId, name: name.trim(), description: description.trim() || undefined, environment })}>{create.isPending ? "CREATING" : "SAVE PROJECT"}</Button></div> : null}{list.isLoading ? <div className="workspace-loading"><span>LOADING PROJECTS…</span></div> : list.data?.length ? <div className="history-list">{list.data.map(project => <div key={project.id}><span><b>{project.name}</b><small>{project.description ?? "No description"}</small></span><span><b>{project.environment.toUpperCase()}</b><small>ENVIRONMENT</small></span><span><b>{new Date(project.createdAt).toLocaleDateString()}</b><small>CREATED</small></span></div>)}</div> : <p className="panel-copy">{workspaceId ? "No projects yet." : "Create or join a workspace first."}</p>}</section>;
}

function Projects() {
  const rows = projectRows.map(row => ({ name: row.name, status: row.risk, duration: row.environment, rows: `${row.pipelines} pipelines`, quality: `${row.datasets} datasets`, time: row.activity }));
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">WORKSPACES · PROJECTS</p><h1>PROJECT<br /><em>PERIMETER.</em></h1><p>Real projects are listed first. The sample portfolio below is simulated and labeled as such.</p></div></section><RealProjects /><section className="panel"><SectionTitle eyebrow="SAMPLE PORTFOLIO" title="ILLUSTRATIVE PROJECTS" detail="Sample rows kept for layout reference; not read from the database." action={<SimulatedBadge compact />} /><DataTable rows={rows} /><div className="project-cards">{projectRows.map(project => <article key={project.name}><p>{project.environment} · SAMPLE</p><h3>{project.name}</h3><div><span>{project.pipelines} pipelines</span><span>{project.datasets} datasets</span></div><Status>{project.risk}</Status></article>)}</div></section></div>;
}

function Operations({ page }: { page: string }) {
  const copy = page === "/quality" ? ["DATA QUALITY", "Quality controls hold steady across the simulated production estate."] : page === "/incidents" ? ["INCIDENTS & RCA", "Understand what happened, what changed, and who owns recovery."] : page === "/monitoring" ? ["MONITORING", "Compare the operational series with its simulated historical baseline."] : page === "/agents" ? ["ASTRA INTERNAL AGENTS", "Status visibility for built-in intelligence components. Users do not operate these agents."] : page === "/datasets" ? ["DATASETS", "Schema, ownership, and quality signals at the source boundary."] : ["PIPELINES", "Operational execution history and deliberate deployment controls."];
  const datasets = [{ name: "customers", status: "CRITICAL", duration: "7 columns", rows: "1.24M rows", quality: "94.1%", time: "14 min ago" }, { name: "orders", status: "WARNING", duration: "12 columns", rows: "8.9M rows", quality: "97.7%", time: "37 min ago" }, { name: "transactions", status: "HEALTHY", duration: "16 columns", rows: "2.7M rows", quality: "99.2%", time: "1h ago" }];
  const agentNames = ["Monitoring", "Quality", "Lineage", "Change Intelligence", "Prediction Engine", "RCA", "Recommendation / Recovery"];
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">OPERATIONAL SURFACE · SIMULATED DATA</p><h1>{copy[0].split(" ").map((word, index) => <span key={word}>{index === 0 ? word : <><br /><em>{word}</em></>}</span>)}</h1><p>{copy[1]}</p></div></section>{page === "/agents" ? <section className="agent-grid">{agentNames.map((name, index) => <article key={name} className="agent-card"><Bot size={22} /><p>INTERNAL COMPONENT</p><h3>{name}</h3><Status>{index === 5 ? "WARNING" : "HEALTHY"}</Status><small>PROCESSED TODAY · {41 + index * 13}</small><SimulatedBadge compact /></article>)}</section> : <><section className="panel"><SectionTitle eyebrow="CURRENT STATE" title={page === "/quality" ? "QUALITY RULES" : page === "/incidents" ? "OPEN INCIDENTS" : page === "/monitoring" ? "OBSERVED SERIES" : page === "/datasets" ? "DATASET INVENTORY" : "EXECUTION HISTORY"} action={<SimulatedBadge compact />} /><DataTable rows={page === "/datasets" ? datasets : healthRows} /></section><div className="split-grid"><section className="panel"><p className="eyebrow">TREND / 30 DAYS</p><div className="chart-ghost"><i /><i /><i /><i /><i /><i /><i /><b>SIMULATED SERIES</b></div></section><section className="panel"><p className="eyebrow">OPERATIONAL CALLOUT</p><h3>{page === "/monitoring" ? "Execution time is 42% above historical baseline." : "One control needs an owner decision."}</h3><p className="panel-copy">This annotation is calculated from the visible sample-series fixture rather than from a live anomaly model.</p><SimulatedBadge compact /></section></div></>}</div>;
}

function Reports() { return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">EXPORTABLE OVERVIEW</p><h1>RISK<br /><em>REPORTS.</em></h1><p>Review-ready summaries of simulated risk, operational health, and ownership context.</p></div></section><section className="panel empty-panel"><BookOpen size={30} /><h3>No generated reports in this preview</h3><p>Run a simulated risk analysis or filter an operational workspace to construct a report package.</p><Button className="button-red">CREATE REPORT</Button></section></div>; }

function NotFoundPanel({ path, onHome }: { path: string; onHome: () => void }) {
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">404 · NOT FOUND</p><h1>NOTHING<br /><em>HERE.</em></h1><p>There is no page at <code>{path}</code>. It may have been moved, or the link is mistyped.</p></div></section><section className="panel empty-panel"><Button className="button-red" onClick={onHome}>GO TO OVERVIEW</Button></section></div>;
}

/** @deprecated replaced by AccountModules.AdminPage (kept for reference; not routed). */
function Admin({ role }: { role: Role }) { return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">ACCOUNT & GOVERNANCE</p><h1>ROLE-AWARE<br /><em>CONTROL.</em></h1><p>UI preview is currently set to {role}. Persisted privileges are verified by the Node.js + tRPC backend after authentication.</p></div></section><div className="split-grid"><section className="panel"><SectionTitle eyebrow="RBAC READINESS" title="ACCESS MODEL" /><div className="access-model"><div><span>ADMIN</span><b>Organization, users, integrations, audit logs</b></div><div><span>DEVELOPER</span><b>Projects, changes, pipeline execution</b></div><div><span>REVIEWER</span><b>Risk review, approve, block, request changes</b></div></div></section><section className="panel"><SectionTitle eyebrow="AUTHENTICATION" title="SUPABASE AUTH" /><p className="panel-copy">Sign-in uses Supabase Auth only. Every API call carries the Supabase access token; the server confirms it with Supabase and uses the Supabase user ID directly. There is no separate user table. Data stays scoped by organization, workspace and role on the server.</p><div className="architecture-tags"><span>ORG ID</span><span>ROLE</span><span>PROJECT SCOPE</span><span>AUDIT EVENTS</span></div></section></div><section className="panel"><SectionTitle eyebrow="PEOPLE" title="ORGANIZATION MEMBERS" action={<SimulatedBadge compact />} /><div className="member-list">{[["Maya Chen", "ADMIN", "Data Platform"], ["Jordan Lee", "DEVELOPER", "Customer Analytics"], ["Avery Singh", "REVIEWER", "Risk Council"]].map(([name, memberRole, scope]) => <div key={name}><Avatar><AvatarFallback>{name.split(" ").map(part => part[0]).join("")}</AvatarFallback></Avatar><b>{name}</b><span>{scope}</span><Status>{memberRole}</Status></div>)}</div></section></div>; }

export default function AstraPlatform() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const { user, profile, isAuthenticated, logout } = useAuth();
  const displayName = profile?.full_name ?? user?.name ?? user?.email ?? "Operator";
  const [mobileOpen, setMobileOpen] = useState(false);
  const [role, setRole] = useState<Role>("REVIEWER");
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Validated against the caller's memberships (no stale or hardcoded workspace ids).
  const activeWorkspace = useActiveWorkspace();
  const activeWorkspaceId = activeWorkspace.workspaceId || null;
  // Real count (Phase 4): changes whose latest persisted analysis is MEDIUM/HIGH/CRITICAL. Previously a hardcoded "01".
  const activeRisks = trpc.changeIntelligence.riskAnalyses.useQuery({ workspaceId: activeWorkspaceId ?? 0, scope: "active" }, { enabled: Boolean(activeWorkspaceId) });
  const activeRiskCount = activeRisks.data?.length ?? 0;
  // Phase 8: the bell's red dot was always on; it now reflects real active incidents.
  const activeIncidents = trpc.incidents.list.useQuery({ workspaceId: activeWorkspaceId ?? 0, filter: "active" }, { enabled: Boolean(activeWorkspaceId) });
  const activeIncidentCount = activeIncidents.data?.length ?? 0;
  const myInvitations = trpc.workspace.myInvitations.useQuery(undefined, { enabled: isAuthenticated, retry: false });
  const invitationCount = myInvitations.data?.length ?? 0;
  // Overview ("/") only matches exactly; otherwise every unmatched route (e.g. /datasets/*) also lit up Overview.
  const activeItem = useMemo(() => navItems.find(item => item.path === "/" ? location === "/" : location === item.path || location.startsWith(`${item.path}/`)) ?? null, [location]);
  useEffect(() => { setMobileOpen(false); }, [location]);
  const renderPage = () => {
    const routeKind = getAstraRouteKind(location);
    if (routeKind === "changes" && (location === "/changes" || location === "/changes/submitted")) return <ChangeIntelligencePage />;
    if (location === "/changes/sandbox") return <Changes role={role} setRole={setRole} />;
    if (location === "/changes/history") return <AnalysisHistoryPage />;
    if (location === "/changes/reviews") return <ReviewsPage />;
    if (location.startsWith("/changes/")) return <ChangeDetailPage id={location.split("/")[2] ?? ""} />;
    if (location === "/risk-analysis") return <RiskAnalysisPage />;
    if (location === "/risk-analysis/history") return <RiskAnalysisPage history />;
    if (location === "/lineage") return <Lineage />;
    if (location === "/projects" || location === "/projects?create=1") return <Projects />;
    if (location === "/workspaces") return <WorkspaceHub />;
    if (location === "/recents") return <RecentsModule />;
    if (location === "/integrations") return <IntegrationsModule />;
    if (location.startsWith("/integrations/postgres/")) return <ConnectionDetailPage id={location.split("/")[3] ?? ""} />;
    if (location === "/saved-queries") return <SavedQueriesModule />;
    if (location === "/query-history") return <QueryHistoryModule />;
    if (location === "/ingestion") return <IngestionModule />;
    if (location === "/pipeline-runs") return <PipelineRunHistoryPage />;
    if (location === "/dashboards") return <DashboardsPage />;
    if (location === "/catalog") return <DatasetModule tab="explorer" />;
    if (location === "/datasets/explorer") return <PersistedDatasetExplorer />;
    if (location === "/datasets/import") return <DatasetImportPage />;
    if (location === "/datasets/fixtures") return <FixtureDatasetExplorer />;
    if (location === "/pipelines/create") return <PipelineEditor />;
    if (location === "/pipelines/fixtures") return <FixturePipelineBuilder />;
    { const edit = /^\/pipelines\/(\d+)\/edit$/.exec(location); if (edit) return <PipelineEditor key={edit[1]} pipelineId={Number(edit[1])} />; }
    if (location === "/reports") return <ReportsPage />;
    if (location === "/reports/exports") return <ReportExportsPage />;
    if (location === "/admin") return <AdminPage />;
    if (location === "/settings") return <SettingsPage />;
    if (location.startsWith("/datasets/") && location !== "/datasets/connections") return <PersistedDatasetDetail id={location.split("/")[2] ?? ""} />;
    if (location === "/datasets") return <DatasetModule key={`datasets?${search}`} tab="explorer" />;
    if (location === "/datasets/connections") return <DatasetModule tab="connections" />;
    if (location.startsWith("/pipelines/runs/")) return <PersistedRunDetail id={location.split("/")[3] ?? ""} />;
    if (location.startsWith("/pipelines/") && location !== "/pipelines/runs") return <PersistedPipelineDetail id={location.split("/")[2] ?? ""} />;
    if (location === "/pipelines") return <PipelineRegistry />;
    if (location === "/pipelines/runs") return <PipelineRunHistoryPage />;
    if (location === "/monitoring") return <MonitoringPage />;
    if (location === "/monitoring/anomalies") return <MonitoringPage anomalies />;
    if (location === "/quality") return <QualityPage />;
    if (location === "/incidents") return <IncidentsPage />;
    if (location.startsWith("/incidents/")) return <IncidentDetailPage id={location.split("/")[2] ?? ""} />;
    // Phase 10: the AI page shows real activity of the one AI workflow (review briefs).
    if (location === "/agents") return <AiActivityPage />;
    if (location === "/") return <Overview workspaceId={activeWorkspaceId} isAuthenticated={isAuthenticated} />;
    return <NotFoundPanel path={location} onHome={() => setLocation("/")} />;
  };
  return <div className="astra-app"><aside className={`astra-sidebar ${mobileOpen ? "open" : ""}`}><div className="brand"><span>ASTRA</span><small>RISK / OPS</small><button className="mobile-close" onClick={() => setMobileOpen(false)}><X size={18} /></button></div><div className="red-rule" /><nav><NewMenu onNavigate={path => { setLocation(path); }} />{navItems.map(item => <div key={item.path}>{item.group && <p className="nav-group">{item.group}</p>}<button onClick={() => setLocation(item.path)} className={item.path === activeItem?.path || (item.path === "/catalog" && location.startsWith("/datasets")) ? "nav-active" : ""}><item.icon size={16} /><span>{item.label}</span>{item.path === "/changes" && activeRiskCount ? <b title="Changes whose latest stored analysis is not SAFE">{String(activeRiskCount).padStart(2, "0")}</b> : null}</button></div>)}</nav><div className="sidebar-bottom"><button onClick={() => setLocation("/workspaces")} className={location === "/workspaces" ? "nav-active" : ""}><FolderKanban size={16} /><span>Workspaces</span></button><button onClick={() => setLocation("/admin")} className={location === "/admin" ? "nav-active" : ""}><UsersRound size={16} /><span>Account & Admin</span></button><button onClick={() => setLocation("/settings")} className={location === "/settings" ? "nav-active" : ""}><Settings size={16} /><span>Settings</span></button><div className="account-row"><Avatar><AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar><div><b>{displayName}</b><small>{profile ? `@${profile.username}` : isAuthenticated ? "AUTHENTICATED" : "SIGNED OUT"}</small></div><Tooltip><TooltipTrigger asChild><button className="login-icon" aria-label="Sign out" onClick={() => void logout()}><LogOut size={15} /></button></TooltipTrigger><TooltipContent>Sign out</TooltipContent></Tooltip></div></div></aside><main className="astra-main"><header className="astra-topbar"><button className="menu-button" onClick={() => setMobileOpen(true)}><Menu size={20} /></button><WorkspaceSelector onOpenWorkspace={() => setLocation("/workspaces")} /><div className="topbar-actions"><button className="search-button" onClick={() => setPaletteOpen(true)}><Search size={16} /><span>SEARCH</span><kbd>⌘ K</kbd></button><button className="icon-button" aria-label={activeIncidentCount ? `${activeIncidentCount} active incidents` : "No active incidents"} title={activeIncidentCount ? `${activeIncidentCount} active incidents` : "No active incidents"} onClick={() => setLocation("/incidents")}><Bell size={17} />{activeIncidentCount ? <i /> : null}</button><div className="environment"><span>ROLE</span><b>{(activeWorkspace.role ?? "—").toUpperCase()}</b></div><Avatar><AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar></div></header><div className="red-rule red-rule--main" /><div className="page-scroll">{activeWorkspace.storageError ? <div className="storage-banner" role="alert"><b>WORKSPACE DATA UNAVAILABLE</b><span>You are signed in, but ASTRA's data store could not be reached ({activeWorkspace.storageError}). Workspaces, datasets and projects will load once the database connection (DATABASE_URL) is fixed.</span></div> : null}{location !== "/workspaces" && invitationCount ? <div className="storage-banner invitation-banner" role="status"><b>{invitationCount === 1 ? "YOU HAVE A WORKSPACE INVITATION" : `YOU HAVE ${invitationCount} WORKSPACE INVITATIONS`}</b><span><button className="link-button" onClick={() => setLocation("/workspaces")}>REVIEW AND ACCEPT →</button></span></div> : null}{renderPage()}</div></main><CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} workspaceId={activeWorkspaceId} onRecent={() => undefined} /><div className={`mobile-scrim ${mobileOpen ? "show" : ""}`} onClick={() => setMobileOpen(false)} /></div>;
}
