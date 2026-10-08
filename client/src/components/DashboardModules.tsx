import { Button } from "@/components/ui/button";
import { ModuleSubnav, type ModuleTab } from "@/components/ModuleSubnav";
import { PersistedBadge, StateMessage, WorkspaceGate } from "@/components/DatasetModules";
import { RunsPerDayChart } from "@/components/OpsModules";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { AlertOctagon, ArrowUpRight, Download, GitBranch, Loader2, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

/** Daily charts use the viewer's calendar days (e.g. IST), not UTC. */
const VIEWER_UTC_OFFSET = -new Date().getTimezoneOffset();

/**
 * Phase 8 — the Overview dashboard and Reports. Every number comes from the
 * reports.workspace query, which runs the single KPI builder (shared/report.ts)
 * on the workspace's stored records. The CSV export is produced by the server
 * from the same builder; both carry the same fingerprint.
 */

type Days = 7 | 30 | 90;
const REPORT_TABS: ModuleTab[] = [{ label: "SUMMARY", href: "/reports" }, { label: "EXPORTS", href: "/reports/exports" }];
const when = (value: string | Date | null | undefined) => (value ? new Date(value).toLocaleString() : "—");
const levelTone = (level: string) => (level === "CRITICAL" ? "status status--red" : level === "HIGH" ? "status status--yellow" : level === "MEDIUM" ? "status status--blue" : "status status--green");
const runTone = (status: string) => (status === "success" ? "status status--green" : status === "failed" ? "status status--red" : "status status--yellow");

function Metric({ value, label, delta, alert, href }: { value: string; label: string; delta: string; alert?: boolean; href?: string }) {
  const [, setLocation] = useLocation();
  return <button type="button" className={`metric-card metric-card--link ${alert ? "metric-card--alert" : ""}`} onClick={() => href && setLocation(href)}><p className="metric-card__value">{value}</p><p className="metric-card__label">{label}</p><p className="metric-card__delta">{delta}</p></button>;
}

function WindowPicker({ days, onChange }: { days: Days; onChange: (days: Days) => void }) {
  return <div className="module-filter"><select aria-label="Report window" value={days} onChange={event => onChange(Number(event.target.value) as Days)}><option value={7}>LAST 7 DAYS</option><option value={30}>LAST 30 DAYS</option><option value={90}>LAST 90 DAYS</option></select></div>;
}

function greeting(now = new Date()) {
  const hour = now.getHours();
  return hour < 12 ? "GOOD MORNING" : hour < 17 ? "GOOD AFTERNOON" : "GOOD EVENING";
}

// ---------------------------------------------------------------- overview

function OverviewBody({ workspaceId }: { workspaceId: number }) {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const [days, setDays] = useState<Days>(30);
  const query = trpc.reports.workspace.useQuery({ workspaceId, days, utcOffsetMinutes: VIEWER_UTC_OFFSET }, { placeholderData: previous => previous });
  if (query.isLoading) return <div className="workspace-loading"><span>COMPUTING FROM STORED RECORDS…</span></div>;
  if (query.error) return <section className="panel"><StateMessage title="Dashboard unavailable" detail={query.error.message} /></section>;
  const report = query.data!;
  const v = (key: string) => report.kpis.find(item => item.key === key)!;
  const firstName = (user?.name ?? "").split(" ")[0] || "there";
  const attention = [v("incidents_active").value ? `${v("incidents_active").value} active incident${v("incidents_active").value === 1 ? "" : "s"}` : null, v("pending_reviews").value ? `${v("pending_reviews").value} change${v("pending_reviews").value === 1 ? "" : "s"} awaiting review` : null, v("pipelines_failing").value ? `${v("pipelines_failing").value} failing pipeline${v("pipelines_failing").value === 1 ? "" : "s"}` : null].filter(Boolean);
  const statusCount = Math.max(1, ...report.pipelineHealth.map(item => item.count));
  return <div className="page-stack">
    <section className="hero-grid">
      <div><p className="eyebrow">SYSTEM OVERVIEW · {report.meta.workspaceName.toUpperCase()}</p><h1>{greeting()},<br /><em>{firstName.toUpperCase()}.</em></h1><p className="hero-copy">{attention.length ? `Needs attention: ${attention.join(" · ")}.` : v("runs_succeeded").value || v("pipelines_total").value ? "Nothing needs attention right now: no active incidents, no changes awaiting review, no failing pipelines." : "This workspace is empty. Import a dataset and build a pipeline to see it come alive here."}</p></div>
      <div className="system-panel"><div><span>WORKSPACE</span><strong>{report.meta.workspaceName}</strong></div><div><span>MEMBERS</span><strong>{report.meta.members}</strong></div><div><span>LAST RUN</span><strong>{report.meta.lastRunAt ? new Date(report.meta.lastRunAt).toLocaleString() : "No runs yet"}</strong></div><PersistedBadge /></div>
    </section>
    <div className="dashboard-toolbar"><span className="module-meta">ALL NUMBERS COMPUTED FROM THE DATABASE · REPORT {report.fingerprint} · {new Date(report.generatedAt).toLocaleTimeString()}</span><WindowPicker days={days} onChange={setDays} /></div>
    <section className="metric-grid">
      <Metric value={v("pipeline_health_pct").display} label="PIPELINE HEALTH" delta={`${v("runs_succeeded").value} OK · ${v("runs_failed").value} FAILED · ${days}D`} href="/monitoring" />
      <Metric value={v("pipelines_total").display} label="PIPELINES" delta={`${v("pipelines_failing").value} FAILING NOW`} alert={Boolean(v("pipelines_failing").value)} href="/pipelines" />
      <Metric value={v("runs_failed").display} label="FAILED RUNS" delta={`LAST ${days} DAYS`} alert={Boolean(v("runs_failed").value)} href="/pipelines/runs" />
      <Metric value={v("quality_pass_pct").display} label="QUALITY CHECKS PASSING" delta={`${v("quality_checks_failing").value} FAILING`} alert={Boolean(v("quality_checks_failing").value)} href="/quality" />
      <Metric value={v("open_risks").display} label="ACTIVE RISKS" delta={`${v("critical_risks").value} CRITICAL · ${v("pending_reviews").value} AWAITING REVIEW`} alert={Boolean(v("critical_risks").value)} href="/risk-analysis" />
      <Metric value={v("incidents_active").display} label="ACTIVE INCIDENTS" delta={`${v("incidents_critical").value} CRITICAL`} alert={Boolean(v("incidents_active").value)} href="/incidents" />
    </section>
    <div className="split-grid split-grid--wide">
      <section className="panel panel--red-top"><div className="section-title"><div><p className="eyebrow">PIPELINES BY CURRENT STATUS</p><h2>PIPELINE HEALTH</h2><p className="section-title__detail">Each pipeline's status after its latest run (DRAFT = never run).</p></div></div>
        <div className="health-bars">{report.pipelineHealth.map(item => <div key={item.status}><span>{item.status} <b>{String(item.count).padStart(2, "0")}</b></span><i className={`bar ${item.status === "HEALTHY" ? "green" : item.status === "WARNING" ? "yellow" : item.status === "FAILED" ? "red" : "blue"}`} style={{ width: `${(item.count / statusCount) * 100}%` }} /></div>)}</div>
      </section>
      {report.topRisk ? <section className="panel panel--signal"><div className="risk-orbit"><strong>{report.topRisk.score}</strong><span>/100</span><small>{report.topRisk.level}</small></div><div><p className="eyebrow">HIGHEST OPEN RISK · {report.topRisk.reviewStatus}</p><h3>{report.topRisk.title}</h3><p>The highest-scoring change whose latest analysis is not SAFE.</p><Button className="button-red" onClick={() => setLocation(`/changes/${report.topRisk!.changeId}`)}>OPEN ANALYSIS</Button></div></section>
        : <section className="panel panel--signal"><div className="risk-orbit risk-orbit--calm"><strong>0</strong><span>open</span><small>RISKS</small></div><div><p className="eyebrow">CHANGE INTELLIGENCE</p><h3>No open risks</h3><p>No change's latest analysis is MEDIUM or above.</p><Button variant="outline" onClick={() => setLocation("/changes")}>OPEN CHANGES</Button></div></section>}
    </div>
    <section className="panel"><div className="section-title"><div><p className="eyebrow">RECENT EXECUTION · PIPELINE_RUNS</p><h2>PIPELINE RUNS</h2></div><Button variant="outline" onClick={() => setLocation("/pipelines/runs")}>ALL RUNS</Button></div>
      {report.recentRuns.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>RUN</th><th>PIPELINE</th><th>STATUS</th><th>ROWS IN → OUT</th><th>DURATION</th><th>STARTED</th></tr></thead><tbody>{report.recentRuns.map(run => <tr key={run.id} className="table-row-clickable" onClick={() => setLocation(`/pipelines/runs/${run.id}`)}><td className="table-name">#{run.id}</td><td>{run.pipelineName}</td><td><span className={runTone(run.status)}>{run.status.toUpperCase()}</span></td><td>{run.status === "success" ? `${run.rowsIn} → ${run.rowsOut}` : "—"}</td><td>{run.durationMs} ms</td><td>{when(run.startedAt)}</td></tr>)}</tbody></table></div> : <p className="panel-copy">No runs yet.</p>}
    </section>
    <div className="split-grid">
      <section className="panel"><div className="section-title"><div><p className="eyebrow">LATEST ANALYSIS OF EACH CHANGE</p><h2>RISK OVERVIEW</h2></div></div><div className="risk-list">{report.riskByLevel.map(item => <div key={item.level} className="table-row-clickable" onClick={() => setLocation(item.level === "SAFE" ? "/changes/history" : "/risk-analysis")}><span className={levelTone(item.level)}>{item.level}</span><b>{String(item.count).padStart(2, "0")}</b><span>{item.level === "SAFE" ? "No significant impact" : item.level === "MEDIUM" ? "Noticeable impact" : item.level === "HIGH" ? "Significant impact" : "Would break or empty data"}</span></div>)}</div></section>
      <section className="panel"><div className="section-title"><div><p className="eyebrow">SIGNALS · FROM INCIDENTS, ANOMALIES AND REVIEWS</p><h2>NEEDS ATTENTION</h2></div></div>
        {report.signals.length ? <div className="insight-list">{report.signals.map((signal, index) => <article key={index} className="table-row-clickable" onClick={() => setLocation(signal.href)}>{signal.kind === "incident" ? <AlertOctagon size={16} /> : signal.kind === "anomaly" ? <GitBranch size={16} /> : <ShieldAlert size={16} />}<p><b>{signal.kind === "incident" ? "Incident" : signal.kind === "anomaly" ? "Anomaly" : "Awaiting review"} · <span className={signal.severity === "critical" ? "status status--red" : "status status--yellow"}>{signal.severity.toUpperCase()}</span></b><br />{signal.title}</p></article>)}</div> : <p className="panel-copy">Nothing flagged. Incidents, anomalies and changes awaiting review appear here.</p>}
      </section>
    </div>
  </div>;
}

export function LiveOverview() {
  return <WorkspaceGate subject="Dashboards">{workspaceId => <OverviewBody key={workspaceId} workspaceId={workspaceId} />}</WorkspaceGate>;
}

// ---------------------------------------------------------------- reports

function downloadCsv(filename: string, csv: string) {
  // UTF-8 byte-order mark so Excel on Windows shows "÷", "—" etc. correctly.
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ReportBody({ workspaceId }: { workspaceId: number }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const [days, setDays] = useState<Days>(30);
  const query = trpc.reports.workspace.useQuery({ workspaceId, days, utcOffsetMinutes: VIEWER_UTC_OFFSET }, { placeholderData: previous => previous });
  const exporter = trpc.reports.exportCsv.useMutation({
    onSuccess: async file => {
      downloadCsv(file.filename, file.csv);
      await utils.reports.exports.invalidate();
      if (query.data && file.fingerprint !== query.data.fingerprint) { toast.warning("The data changed since this page loaded", { description: `The file (report ${file.fingerprint}) reflects the latest records. Refreshing the page to match.` }); void query.refetch(); }
      else toast.success("Report exported", { description: `${file.filename} — same data as on screen (report ${file.fingerprint}).` });
    },
    onError: error => toast.error("Export failed", { description: error.message }),
  });
  if (query.isLoading) return <div className="workspace-loading"><span>BUILDING REPORT…</span></div>;
  if (query.error) return <section className="panel"><StateMessage title="Report unavailable" detail={query.error.message} /></section>;
  const report = query.data!;
  return <>
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">WORKSPACE REPORT · {report.meta.workspaceName.toUpperCase()} · LAST {days} DAYS</p><h2>REPORT <span className="report-fingerprint" data-testid="report-fingerprint">{report.fingerprint}</span></h2><p className="panel-copy">Generated {when(report.generatedAt)} from the database. The exported CSV carries the same report ID; it changes only when the underlying records change.</p></div><div className="step-actions"><WindowPicker days={days} onChange={setDays} /><Button className="button-red" disabled={exporter.isPending} onClick={() => exporter.mutate({ workspaceId, days, utcOffsetMinutes: VIEWER_UTC_OFFSET })}>{exporter.isPending ? <><Loader2 size={14} className="spin" /> EXPORTING</> : <><Download size={14} /> EXPORT CSV</>}</Button></div></div>
      <div className="data-table-wrap"><table className="data-table" data-testid="report-kpis"><thead><tr><th>METRIC</th><th>VALUE</th><th>DEFINITION</th><th>SOURCE</th></tr></thead><tbody>{report.kpis.map(item => <tr key={item.key} data-kpi={item.key}><td><b>{item.label}</b></td><td className="report-value">{item.display}</td><td>{item.definition}</td><td><code>{item.source}</code></td></tr>)}</tbody></table></div>
    </section>
    <section className="panel"><p className="eyebrow">RUNS PER DAY</p><h2>EXECUTION</h2><RunsPerDayChart days={report.daily} /></section>
    <section className="panel"><p className="eyebrow">PIPELINES · SAME WINDOW</p><h2>{report.pipelines.length} PIPELINES RAN</h2>{report.pipelines.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>PIPELINE</th><th>RUNS</th><th>SUCCESS RATE</th><th>AVG DURATION</th><th>LAST RUN</th><th>STATUS NOW</th></tr></thead><tbody>{report.pipelines.map(item => <tr key={item.pipelineId} className="table-row-clickable" onClick={() => setLocation(`/pipelines/${item.pipelineId}`)}><td className="table-name">{item.pipelineName}</td><td>{item.runs}</td><td>{item.successRate === null ? "—" : `${item.successRate}%`}</td><td>{item.avgDurationMs === null ? "—" : `${item.avgDurationMs} ms`}</td><td>{item.lastRun ? <span className={runTone(item.lastRun.status)}>#{item.lastRun.id} {item.lastRun.status.toUpperCase()}</span> : "—"}</td><td>{item.status}</td></tr>)}</tbody></table></div> : <p className="panel-copy">No runs in this window.</p>}</section>
    <div className="split-grid">
      <section className="panel"><p className="eyebrow">CHANGES · LATEST ANALYSIS & REVIEW</p><h2>{report.changes.length} CHANGES</h2>{report.changes.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>CHANGE</th><th>RISK</th><th>REVIEW</th></tr></thead><tbody>{report.changes.map(item => <tr key={item.id} className="table-row-clickable" onClick={() => setLocation(`/changes/${item.id}`)}><td>#{item.id} · {item.title}</td><td>{item.level ? <span className={levelTone(item.level)}>{item.level} {item.score}</span> : "—"}</td><td>{item.reviewStatus}</td></tr>)}</tbody></table></div> : <p className="panel-copy">No changes analysed.</p>}</section>
      <section className="panel"><p className="eyebrow">INCIDENTS · ACTIVE OR RESOLVED IN WINDOW</p><h2>{report.incidents.length} INCIDENTS</h2>{report.incidents.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>INCIDENT</th><th>SEVERITY</th><th>STATUS</th></tr></thead><tbody>{report.incidents.map(item => <tr key={item.id} className="table-row-clickable" onClick={() => setLocation(`/incidents/${item.id}`)}><td>#{item.id} · {item.title}</td><td><span className={item.severity === "critical" ? "status status--red" : "status status--yellow"}>{item.severity.toUpperCase()}</span></td><td>{item.status.toUpperCase()}</td></tr>)}</tbody></table></div> : <p className="panel-copy">No incidents.</p>}</section>
    </div>
    <section className="panel"><p className="eyebrow">DATA QUALITY · LATEST RESULT PER CHECK</p><h2>{report.quality.length} DATASETS WITH CHECKS</h2>{report.quality.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>DATASET</th><th>CHECKS</th><th>PASSING</th><th>FAILING</th><th>CANNOT RUN</th></tr></thead><tbody>{report.quality.map(item => <tr key={item.datasetId}><td className="table-name">{item.datasetName}</td><td>{item.checks}</td><td>{item.passing}</td><td>{item.failing}</td><td>{item.errors}</td></tr>)}</tbody></table></div> : <p className="panel-copy">No quality checks defined.</p>}</section>
  </>;
}

export function ReportsPage() {
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">REPORTS · WORKSPACE SUMMARY</p><h1>WORKSPACE<br /><em>REPORT.</em></h1><p>Every figure is computed from the Astra database by the same code as the Overview. The CSV export is built by the server from this exact report.</p></div></section><ModuleSubnav tabs={REPORT_TABS} /><WorkspaceGate subject="Reports">{workspaceId => <ReportBody key={workspaceId} workspaceId={workspaceId} />}</WorkspaceGate></div>;
}

function ExportsBody({ workspaceId }: { workspaceId: number }) {
  const list = trpc.reports.exports.useQuery({ workspaceId });
  if (list.isLoading) return <div className="workspace-loading"><span>LOADING EXPORTS…</span></div>;
  if (list.error) return <section className="panel"><StateMessage title="Exports unavailable" detail={list.error.message} /></section>;
  const rows = list.data ?? [];
  return <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">AUDIT_LOGS · REPORT_EXPORTED</p><h2>{rows.length} EXPORTS</h2></div><PersistedBadge /></div>
    {rows.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>WHEN</th><th>REPORT ID</th><th>BY</th><th>WINDOW</th><th>KEY FIGURES AT EXPORT</th></tr></thead><tbody>{rows.map(row => { const meta = (row.metadata ?? {}) as { windowDays?: number; kpis?: Record<string, number | null> }; return <tr key={row.id}><td>{when(row.createdAt)}</td><td><code>{row.fingerprint}</code></td><td>{row.byYou ? "You" : "Workspace member"}</td><td>{meta.windowDays ?? "—"} days</td><td>health {meta.kpis?.pipeline_health_pct ?? "—"}% · failed runs {meta.kpis?.runs_failed ?? "—"} · active risks {meta.kpis?.open_risks ?? "—"} · incidents {meta.kpis?.incidents_active ?? "—"}</td></tr>; })}</tbody></table></div>
      : <StateMessage title="No exports yet" detail="Use EXPORT CSV on the Summary tab. Every export is recorded here with the figures it contained." />}
  </section>;
}

export function ReportExportsPage() {
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">REPORTS · EXPORT HISTORY</p><h1>REPORT<br /><em>EXPORTS.</em></h1><p>Who exported which report, when, and the headline figures it contained.</p></div></section><ModuleSubnav tabs={REPORT_TABS} /><WorkspaceGate subject="Reports">{workspaceId => <ExportsBody key={workspaceId} workspaceId={workspaceId} />}</WorkspaceGate></div>;
}

export function DashboardsPage() {
  const [, setLocation] = useLocation();
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">EXPLORE · DASHBOARDS</p><h1>DATA<br /><em>DASHBOARDS.</em></h1><p>The Overview is Astra's live dashboard, computed from the database. Custom saved dashboards are not built yet.</p></div></section><section className="panel"><StateMessage title="Use the Overview as the dashboard" detail="Same numbers as the Workspace Report and its CSV export." action={<div className="step-actions"><Button className="button-red" onClick={() => setLocation("/")}><ArrowUpRight size={14} /> OPEN OVERVIEW</Button><Button variant="outline" onClick={() => setLocation("/reports")}>OPEN REPORT</Button></div>} /></section></div>;
}
