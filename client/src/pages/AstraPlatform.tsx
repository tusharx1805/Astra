import Editor from "@monaco-editor/react";
import { useAuth } from "@/_core/hooks/useAuth";
import { LineageCanvas } from "@/components/LineageCanvas";
import { SimulatedBadge } from "@/components/SimulatedBadge";
import WorkspaceHub, { WorkspaceSelector } from "@/components/WorkspaceHub";
import { CommandPalette } from "@/components/CommandPalette";
import { getAstraRouteKind } from "@/lib/astraRoutes";
import { ChangesModule, DatasetDetail, DatasetModule, MonitoringModule, PipelineDetail, PipelineModule, PipelineRunDetail, ReportsModule, RiskModule } from "@/components/ModuleViews";
import { DashboardModule, IngestionModule, IntegrationsModule, PipelineRunsModule, QueryHistoryModule, RecentsModule, SavedQueriesModule } from "@/components/AdditionalModules";
import { FixtureDatasetExplorer, FixturePipelineBuilder } from "@/components/RealDataFlowModules";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { startLogin } from "@/const";
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
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";

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
  { label: "Pipeline Runs", path: "/pipeline-runs", icon: Activity, group: "DATA ENGINEERING" },
  { label: "Data Ingestion", path: "/ingestion", icon: UploadCloud },
  { label: "Lineage", path: "/lineage", icon: GitBranch },
  { label: "Change Intelligence", path: "/changes", icon: Braces, group: "INTELLIGENCE" },
  { label: "Risk Analysis", path: "/risk-analysis", icon: AlertOctagon },
  { label: "Incidents", path: "/incidents", icon: FileWarning },
  { label: "AI Agents", path: "/agents", icon: Bot },
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
  return <details className="new-menu"><summary><Plus size={15} /><span>NEW</span></summary><div className="new-menu__panel"><button onClick={() => onNavigate("/projects?create=1")}><FolderKanban size={15} /> NEW PROJECT</button><button onClick={() => onNavigate("/pipelines/create")}><Activity size={15} /> NEW PIPELINE</button><button onClick={() => onNavigate("/integrations")}><Database size={15} /> CONNECT DATASET</button><button onClick={() => onNavigate("/changes")}><Braces size={15} /> SUBMIT CHANGE</button></div></details>;
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

function Overview({ workspaceId, isAuthenticated }: { workspaceId: number | null; isAuthenticated: boolean }) {
  const metrics = trpc.workspace.fixtureDashboardMetrics.useQuery({ workspaceId: workspaceId ?? 0 }, { enabled: Boolean(isAuthenticated && workspaceId) });
  const aggregate = metrics.data;
  return (
    <div className="page-stack">
      <section className="hero-grid">
        <div>
          <p className="eyebrow">SYSTEM OVERVIEW · PROD</p>
          <h1>GOOD MORNING,<br /><em>OPERATOR.</em></h1>
          <p className="hero-copy">Your data ecosystem is operational. One change requires a deliberate decision before it moves through the production perimeter.</p>
        </div>
        <div className="system-panel">
          <div><span>ENVIRONMENT</span><strong>PRODUCTION</strong></div>
          <div><span>OWNERS ONLINE</span><strong>12 / 14</strong></div>
          <div><span>LAST SYNC</span><strong>14:32 UTC</strong></div>
          <SimulatedBadge compact />
        </div>
      </section>
        <section className="metric-grid">
        <Metric value={aggregate ? `${aggregate.pipelineHealth}%` : "—"} label="PIPELINE HEALTH" delta={aggregate ? "WORKSPACE FIXTURE" : "LOADING"} />
        <Metric value={aggregate ? String(aggregate.activePipelines) : "—"} label="ACTIVE PIPELINES" delta={aggregate ? `${aggregate.totalRows} SNAPSHOT ROWS` : "LOADING"} />
        <Metric value={aggregate ? String(aggregate.successfulRuns) : "—"} label="SUCCESSFUL RUNS" delta="FIXTURE RUN HISTORY" />
        <Metric value={aggregate ? String(aggregate.failedRuns).padStart(2, "0") : "—"} label="FAILED RUNS" delta="REQUIRES TRIAGE" alert />
        <Metric value={aggregate ? String(aggregate.qualityScore) : "—"} label="QUALITY SCORE" delta="FIXTURE SNAPSHOT" />
        <Metric value="04" label="ACTIVE RISKS" delta="01 CRITICAL" alert />
      </section>
      <div className="split-grid split-grid--wide">
        <section className="panel panel--red-top">
          <SectionTitle eyebrow="LIVE OPERATIONS" title="PIPELINE HEALTH" detail="Simulated operational fixture data · refreshed with this demo session" action={<Status>HEALTHY</Status>} />
          <div className="health-bars">
            <div><span>HEALTHY <b>13</b></span><i className="bar green" style={{ width: "72%" }} /></div>
            <div><span>WARNING <b>03</b></span><i className="bar yellow" style={{ width: "22%" }} /></div>
            <div><span>FAILED <b>02</b></span><i className="bar red" style={{ width: "12%" }} /></div>
          </div>
        </section>
        <section className="panel panel--signal">
          <div className="risk-orbit"><strong>87</strong><span>/100</span><small>CRITICAL</small></div>
          <div><p className="eyebrow">CHANGE INTELLIGENCE</p><h3>Customer identifier migration</h3><p>The simulated engine maps four downstream dependencies and requests review.</p><Button className="button-red" asChild><a href="/changes">OPEN ANALYSIS</a></Button></div>
        </section>
      </div>
      <section className="panel">
        <SectionTitle eyebrow="RECENT EXECUTION" title="PIPELINE RUNS" detail="Operational sample data is simulated for this product demonstration." action={<SimulatedBadge compact />} />
        <DataTable />
      </section>
      <div className="split-grid">
        <section className="panel">
          <SectionTitle eyebrow="EXPOSURE MAP" title="RISK OVERVIEW" />
          <div className="risk-list">
            {[["CRITICAL", "01", "Schema changes needing review"], ["HIGH", "03", "Dependency impact detected"], ["MEDIUM", "06", "Monitor after deploy"], ["SAFE", "22", "Ready for deployment"]].map(([status, count, copy]) => <div key={status}><Status>{status}</Status><b>{count}</b><span>{copy}</span></div>)}
          </div>
        </section>
        <section className="panel">
          <SectionTitle eyebrow="INTELLIGENCE FEED" title="AI INSIGHTS" action={<SimulatedBadge compact />} />
          <div className="insight-list">
            <article><Sparkles size={16} /><p><b>Runtime regression signal</b><br />customer_etl execution time is 42% above its historical fixture baseline.</p></article>
            <article><GitBranch size={16} /><p><b>Change dependency breadth</b><br />customer_id reaches 4 named production dependencies.</p></article>
            <article><AlertOctagon size={16} /><p><b>Null trend watch</b><br />orders.email null-rate moved from 0.2% to 1.1% in the sample series.</p></article>
          </div>
        </section>
      </div>
    </div>
  );
}

function Changes({ role, setRole }: { role: Role; setRole: (role: Role) => void }) {
  const [source, setSource] = useState(demoSource);
  const [analysis, setAnalysis] = useState<RiskAnalysisUi>(initialAnalysis);
  const [decision, setDecision] = useState<string | null>(null);
  const analyze = trpc.changeIntelligence.analyze.useMutation({
    onSuccess: result => { setAnalysis(result); toast.success("Simulated risk analysis complete", { description: result.notificationDispatched ? "Project owner notified." : "Owner notification was queued or unavailable." }); },
    onError: () => toast.error("Analysis service is unavailable. The visible result remains simulated."),
  });
  const review = trpc.changeIntelligence.recordReview.useMutation({
    onSuccess: result => { setDecision(result.decision); toast.success(`${result.decision.replaceAll("_", " ")} recorded`, { description: result.notificationDispatched ? "Owner notified of the decision." : "Decision was saved; notification is pending." }); },
    onError: () => { setDecision("LOCAL_PREVIEW"); toast.message("Preview decision captured locally", { description: "Sign in with a reviewer or admin account to persist and notify the owner." }); },
  });

  const runAnalysis = () => analyze.mutate({ title: "Widen customer identifier", changeType: "SQL", source });
  const decide = (next: "APPROVED" | "BLOCKED" | "CHANGES_REQUESTED") => {
    if (role === "DEVELOPER") { toast.error("Reviewer action unavailable", { description: "The interface hides review controls for Developer. Server-side role checks remain authoritative." }); return; }
    review.mutate({ changeId: analysis.id, decision: next, comment: "Simulated review action from ASTRA preview", riskLevel: analysis.level });
  };

  return (
    <div className="page-stack">
      <section className="page-heading heading-with-tools">
        <div><p className="eyebrow">CORE WORKSPACE · SIMULATED ENGINE</p><h1>CHANGE<br /><em>INTELLIGENCE.</em></h1><p>Parse before you deploy. Submitted code is only inspected by deterministic rules — it is never executed.</p></div>
        <div className="role-switcher"><span>UI PREVIEW ROLE</span><div>{(["ADMIN", "DEVELOPER", "REVIEWER"] as Role[]).map(item => <button key={item} onClick={() => setRole(item)} className={role === item ? "active" : ""}>{item}</button>)}</div></div>
      </section>
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
            {role !== "DEVELOPER" ? <div><Button variant="outline" onClick={() => decide("CHANGES_REQUESTED")}>REQUEST CHANGES</Button><Button className="button-red" onClick={() => decide("BLOCKED")} disabled={review.isPending}>BLOCK DEPLOY</Button></div> : <small>Developer preview role cannot decide. Secure server validation applies after authentication.</small>}
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
  return <div className="page-stack"><section className="page-heading"><p className="eyebrow">DEPENDENCY MAP · PRODUCTION</p><h1>LINEAGE &<br /><em>BLAST RADIUS.</em></h1><p>Trace ownership, dependencies, and simulated impact paths from the changed source column.</p></section><section className="panel"><SectionTitle eyebrow="INTERACTIVE GRAPH" title="CUSTOMER IDENTIFIER EXPOSURE" detail="Click nodes for the source, owner, and severity context. This dependency map is simulated fixture data." action={<SimulatedBadge compact />} /><LineageCanvas /></section><section className="impact-summary"><div><b>01</b><span>ROOT DATASET</span></div><div><b>02</b><span>PIPELINES</span></div><div><b>01</b><span>DASHBOARD</span></div><div><b>01</b><span>MODEL</span></div></section></div>;
}

function Projects() {
  const rows = projectRows.map(row => ({ name: row.name, status: row.risk, duration: row.environment, rows: `${row.pipelines} pipelines`, quality: `${row.datasets} datasets`, time: row.activity }));
  return <div className="page-stack"><section className="page-heading"><p className="eyebrow">WORKSPACES · ORGANIZATION / NORTHSTAR</p><h1>PROJECT<br /><em>PERIMETER.</em></h1><p>All operational sample data below is simulated to illustrate organization and project scope.</p></section><section className="panel"><SectionTitle eyebrow="ACTIVE PORTFOLIO" title="PROJECTS" action={<Button className="button-red">CREATE PROJECT</Button>} /><DataTable rows={rows} /></section><div className="project-cards">{projectRows.map(project => <article key={project.name}><p>{project.environment}</p><h3>{project.name}</h3><div><span>{project.pipelines} pipelines</span><span>{project.datasets} datasets</span></div><Status>{project.risk}</Status></article>)}</div></div>;
}

function Operations({ page }: { page: string }) {
  const copy = page === "/quality" ? ["DATA QUALITY", "Quality controls hold steady across the simulated production estate."] : page === "/incidents" ? ["INCIDENTS & RCA", "Understand what happened, what changed, and who owns recovery."] : page === "/monitoring" ? ["MONITORING", "Compare the operational series with its simulated historical baseline."] : page === "/agents" ? ["ASTRA INTERNAL AGENTS", "Status visibility for built-in intelligence components. Users do not operate these agents."] : page === "/datasets" ? ["DATASETS", "Schema, ownership, and quality signals at the source boundary."] : ["PIPELINES", "Operational execution history and deliberate deployment controls."];
  const datasets = [{ name: "customers", status: "CRITICAL", duration: "7 columns", rows: "1.24M rows", quality: "94.1%", time: "14 min ago" }, { name: "orders", status: "WARNING", duration: "12 columns", rows: "8.9M rows", quality: "97.7%", time: "37 min ago" }, { name: "transactions", status: "HEALTHY", duration: "16 columns", rows: "2.7M rows", quality: "99.2%", time: "1h ago" }];
  const agentNames = ["Monitoring", "Quality", "Lineage", "Change Intelligence", "Prediction Engine", "RCA", "Recommendation / Recovery"];
  return <div className="page-stack"><section className="page-heading"><p className="eyebrow">OPERATIONAL SURFACE · SIMULATED DATA</p><h1>{copy[0].split(" ").map((word, index) => <span key={word}>{index === 0 ? word : <><br /><em>{word}</em></>}</span>)}</h1><p>{copy[1]}</p></section>{page === "/agents" ? <section className="agent-grid">{agentNames.map((name, index) => <article key={name} className="agent-card"><Bot size={22} /><p>INTERNAL COMPONENT</p><h3>{name}</h3><Status>{index === 5 ? "WARNING" : "HEALTHY"}</Status><small>PROCESSED TODAY · {41 + index * 13}</small><SimulatedBadge compact /></article>)}</section> : <><section className="panel"><SectionTitle eyebrow="CURRENT STATE" title={page === "/quality" ? "QUALITY RULES" : page === "/incidents" ? "OPEN INCIDENTS" : page === "/monitoring" ? "OBSERVED SERIES" : page === "/datasets" ? "DATASET INVENTORY" : "EXECUTION HISTORY"} action={<SimulatedBadge compact />} /><DataTable rows={page === "/datasets" ? datasets : healthRows} /></section><div className="split-grid"><section className="panel"><p className="eyebrow">TREND / 30 DAYS</p><div className="chart-ghost"><i /><i /><i /><i /><i /><i /><i /><b>SIMULATED SERIES</b></div></section><section className="panel"><p className="eyebrow">OPERATIONAL CALLOUT</p><h3>{page === "/monitoring" ? "Execution time is 42% above historical baseline." : "One control needs an owner decision."}</h3><p className="panel-copy">This annotation is calculated from the visible sample-series fixture rather than from a live anomaly model.</p><SimulatedBadge compact /></section></div></>}</div>;
}

function Reports() { return <div className="page-stack"><section className="page-heading"><p className="eyebrow">EXPORTABLE OVERVIEW</p><h1>RISK<br /><em>REPORTS.</em></h1><p>Review-ready summaries of simulated risk, operational health, and ownership context.</p></section><section className="panel empty-panel"><BookOpen size={30} /><h3>No generated reports in this preview</h3><p>Run a simulated risk analysis or filter an operational workspace to construct a report package.</p><Button className="button-red">CREATE REPORT</Button></section></div>; }

function Admin({ role }: { role: Role }) { return <div className="page-stack"><section className="page-heading"><p className="eyebrow">ACCOUNT & GOVERNANCE</p><h1>ROLE-AWARE<br /><em>CONTROL.</em></h1><p>UI preview is currently set to {role}. Persisted privileges are verified by the Node.js + tRPC backend after authentication.</p></section><div className="split-grid"><section className="panel"><SectionTitle eyebrow="RBAC READINESS" title="ACCESS MODEL" /><div className="access-model"><div><span>ADMIN</span><b>Organization, users, integrations, audit logs</b></div><div><span>DEVELOPER</span><b>Projects, changes, pipeline execution</b></div><div><span>REVIEWER</span><b>Risk review, approve, block, request changes</b></div></div></section><section className="panel"><SectionTitle eyebrow="AUTHENTICATION" title="SUPABASE-READY FOUNDATION" /><p className="panel-copy">The current Node.js + tRPC foundation scopes data by organization and role. Its contract maps directly to Supabase Auth session claims and RLS policies when Supabase credentials are connected.</p><div className="architecture-tags"><span>ORG ID</span><span>ROLE</span><span>PROJECT SCOPE</span><span>AUDIT EVENTS</span></div></section></div><section className="panel"><SectionTitle eyebrow="PEOPLE" title="ORGANIZATION MEMBERS" action={<SimulatedBadge compact />} /><div className="member-list">{[["Maya Chen", "ADMIN", "Data Platform"], ["Jordan Lee", "DEVELOPER", "Customer Analytics"], ["Avery Singh", "REVIEWER", "Risk Council"]].map(([name, memberRole, scope]) => <div key={name}><Avatar><AvatarFallback>{name.split(" ").map(part => part[0]).join("")}</AvatarFallback></Avatar><b>{name}</b><span>{scope}</span><Status>{memberRole}</Status></div>)}</div></section></div>; }

export default function AstraPlatform() {
  const [location, setLocation] = useLocation();
  const { user, isAuthenticated } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [role, setRole] = useState<Role>("REVIEWER");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const workspaces = trpc.workspace.list.useQuery(undefined, { enabled: isAuthenticated });
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<number | null>(() => Number(localStorage.getItem("astra-active-workspace")) || null);
  const activeItem = useMemo(() => navItems.find(item => location === item.path || location.startsWith(`${item.path}/`)) ?? navItems[0], [location]);
  useEffect(() => { setMobileOpen(false); }, [location]);
  useEffect(() => {
    const onWorkspaceChange = (event: Event) => setActiveWorkspaceId((event as CustomEvent<number>).detail);
    window.addEventListener("astra-workspace-change", onWorkspaceChange);
    return () => window.removeEventListener("astra-workspace-change", onWorkspaceChange);
  }, []);
  useEffect(() => {
    if (!activeWorkspaceId && workspaces.data?.[0]?.id) setActiveWorkspaceId(workspaces.data[0].id);
  }, [activeWorkspaceId, workspaces.data]);
  const renderPage = () => {
    const routeKind = getAstraRouteKind(location);
    if (routeKind === "changes" && location === "/changes") return <Changes role={role} setRole={setRole} />;
    if (location === "/risk-analysis") return <RiskModule />;
    if (location === "/changes/submitted") return <ChangesModule />;
    if (location === "/changes/history") return <ChangesModule history />;
    if (location === "/risk-analysis/history") return <RiskModule history />;
    if (location === "/lineage") return <Lineage />;
    if (location === "/projects" || location === "/projects?create=1") return <Projects />;
    if (location === "/workspaces") return <WorkspaceHub />;
    if (location === "/recents") return <RecentsModule />;
    if (location === "/integrations") return <IntegrationsModule />;
    if (location === "/saved-queries") return <SavedQueriesModule />;
    if (location === "/query-history") return <QueryHistoryModule />;
    if (location === "/ingestion") return <IngestionModule />;
    if (location === "/pipeline-runs") return <PipelineRunsModule />;
    if (location === "/dashboards") return <DashboardModule />;
    if (location === "/catalog") return <DatasetModule tab="explorer" />;
    if (location === "/datasets/explorer") return <FixtureDatasetExplorer />;
    if (location === "/pipelines/create") return <FixturePipelineBuilder />;
    if (location === "/reports" || location === "/reports/exports") return <ReportsModule />;
    if (location === "/admin" || location === "/settings") return <Admin role={role} />;
    if (location.startsWith("/datasets/") && !["/datasets/explorer", "/datasets/connections"].includes(location)) return <DatasetDetail id={location.split("/")[2] ?? ""} />;
    if (location === "/datasets" || location === "/datasets/explorer") return <DatasetModule tab="explorer" />;
    if (location === "/datasets/connections") return <DatasetModule tab="connections" />;
    if (location.startsWith("/pipelines/runs/")) return <PipelineRunDetail id={location.split("/")[3] ?? ""} />;
    if (location.startsWith("/pipelines/") && location !== "/pipelines/runs") return <PipelineDetail id={location.split("/")[2] ?? ""} />;
    if (location === "/pipelines") return <PipelineModule tab="all" />;
    if (location === "/pipelines/create") return <FixturePipelineBuilder />;
    if (location === "/pipelines/runs") return <PipelineModule tab="runs" />;
    if (location === "/monitoring") return <MonitoringModule />;
    if (location === "/monitoring/anomalies") return <MonitoringModule anomalies />;
    if (["/quality", "/incidents", "/agents"].includes(location)) return <Operations page={location} />;
    return <Overview workspaceId={activeWorkspaceId} isAuthenticated={isAuthenticated} />;
  };
  return <div className="astra-app"><aside className={`astra-sidebar ${mobileOpen ? "open" : ""}`}><div className="brand"><span>ASTRA</span><small>RISK / OPS</small><button className="mobile-close" onClick={() => setMobileOpen(false)}><X size={18} /></button></div><div className="red-rule" /><nav><NewMenu onNavigate={path => { setLocation(path); }} />{navItems.map(item => <div key={item.path}>{item.group && <p className="nav-group">{item.group}</p>}<button onClick={() => setLocation(item.path)} className={item.path === activeItem.path || (item.path === "/catalog" && location.startsWith("/datasets")) ? "nav-active" : ""}><item.icon size={16} /><span>{item.label}</span>{item.path === "/changes" && <b>01</b>}</button></div>)}</nav><div className="sidebar-bottom"><button onClick={() => setLocation("/workspaces")} className={location === "/workspaces" ? "nav-active" : ""}><FolderKanban size={16} /><span>Workspaces</span></button><button onClick={() => setLocation("/admin")} className={location === "/admin" ? "nav-active" : ""}><UsersRound size={16} /><span>Account & Admin</span></button><button onClick={() => setLocation("/settings")}><Settings size={16} /><span>Settings</span></button><div className="account-row"><Avatar><AvatarFallback>{user?.name?.slice(0, 2).toUpperCase() ?? "OP"}</AvatarFallback></Avatar><div><b>{user?.name ?? "Operator Preview"}</b><small>{isAuthenticated ? "AUTHENTICATED" : "SECURE PREVIEW"}</small></div>{!isAuthenticated && <Tooltip><TooltipTrigger asChild><button className="login-icon" onClick={() => startLogin()}><ShieldCheck size={15} /></button></TooltipTrigger><TooltipContent>Sign in to persist reviews</TooltipContent></Tooltip>}</div></div></aside><main className="astra-main"><header className="astra-topbar"><button className="menu-button" onClick={() => setMobileOpen(true)}><Menu size={20} /></button><WorkspaceSelector onOpenWorkspace={() => setLocation("/workspaces")} /><div className="topbar-actions"><button className="search-button" onClick={() => setPaletteOpen(true)}><Search size={16} /><span>SEARCH</span><kbd>⌘ K</kbd></button><button className="icon-button"><Bell size={17} /><i /></button><div className="environment"><span>ENV</span><b>PROD</b></div><Avatar><AvatarFallback>{user?.name?.slice(0, 2).toUpperCase() ?? "OP"}</AvatarFallback></Avatar></div></header><div className="red-rule red-rule--main" /><div className="page-scroll">{renderPage()}</div></main><CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} workspaceId={activeWorkspaceId} onRecent={() => undefined} /><div className={`mobile-scrim ${mobileOpen ? "show" : ""}`} onClick={() => setMobileOpen(false)} /></div>;
}
