import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ModuleSubnav, type ModuleTab } from "@/components/ModuleSubnav";
import { PersistedBadge, StateMessage, WorkspaceGate } from "@/components/DatasetModules";
import { canEditPipelines } from "@/hooks/useActiveWorkspace";
import { trpc } from "@/lib/trpc";
import type { DailyPoint } from "../../../shared/monitoring";
import { CHECK_TYPES, type CheckType } from "../../../shared/quality";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Loader2, Play, ShieldAlert, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";

/**
 * Phase 7 — operations screens. Every number is read from the database through
 * monitoring.summary, quality.* and incidents.* — no hardcoded rows. The old
 * static Monitoring / Quality / Incidents views were replaced; AI Agents stays a
 * labelled simulation (Phase 10).
 */

const MONITORING_TABS: ModuleTab[] = [{ label: "OVERVIEW", href: "/monitoring" }, { label: "ANOMALIES", href: "/monitoring/anomalies" }, { label: "INCIDENTS", href: "/incidents" }, { label: "DATA QUALITY", href: "/quality" }];
const GOOD = "#6ae580", BAD = "#ff513d";
const when = (value: Date | string | null | undefined) => (value ? new Date(value).toLocaleString() : "—");
const pad = (value: number) => String(value).padStart(2, "0");

function Heading({ eyebrow, title, description, action }: { eyebrow: string; title: React.ReactNode; description: string; action?: React.ReactNode }) {
  return <><section className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</section><ModuleSubnav tabs={MONITORING_TABS} /></>;
}

export function severityClass(severity: string) {
  return severity === "critical" ? "status status--red" : "status status--yellow";
}
function incidentStatusClass(status: string) {
  return status === "resolved" ? "status status--green" : status === "acknowledged" ? "status status--blue" : "status status--red";
}
function resultClass(status: string | undefined) {
  return status === "pass" ? "status status--green" : status === "fail" ? "status status--red" : status === "error" ? "status status--yellow" : "status status--blue";
}

function Tile({ label, value, detail, onClick, tone }: { label: string; value: string; detail?: string; onClick?: () => void; tone?: "bad" | "good" }) {
  return <button type="button" className={`ops-tile ${onClick ? "ops-tile--link" : ""}`} onClick={onClick} disabled={!onClick}><span>{label}</span><b className={tone === "bad" ? "ops-tile__bad" : tone === "good" ? "ops-tile__good" : ""}>{value}</b>{detail ? <small>{detail}</small> : null}</button>;
}

// ---------------------------------------------------------------- chart: runs per day (status colours, legend, hover, table view)

/** Round the axis maximum up to an even, clean number so the mid tick is a whole count. */
function niceMax(value: number) {
  if (value <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(value)));
  const max = Math.ceil(value / step) * step;
  return max % 2 ? max + step : max;
}

export function RunsPerDayChart({ days }: { days: DailyPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const width = 900, height = 230, left = 34, right = 8, top = 12, bottom = 26;
  const max = niceMax(Math.max(0, ...days.map(day => day.success + day.failed)));
  const slot = (width - left - right) / Math.max(1, days.length);
  const barWidth = Math.min(24, Math.max(3, slot * 0.6));
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(days.length / 10);
  const total = days.reduce((sum, day) => sum + day.success + day.failed, 0);
  const rounded = (x: number, yTop: number, w: number, h: number) => h <= 0 ? "" : `M${x},${yTop + h} V${yTop + Math.min(4, h)} Q${x},${yTop} ${x + Math.min(4, w / 2)},${yTop} H${x + w - Math.min(4, w / 2)} Q${x + w},${yTop} ${x + w},${yTop + Math.min(4, h)} V${yTop + h} Z`;
  return <div className="ops-chart">
    <div className="ops-chart__head"><div className="ops-legend"><span><i style={{ background: GOOD }} />Succeeded</span><span><i style={{ background: BAD }} />Failed</span></div><Button variant="outline" onClick={() => setAsTable(value => !value)}>{asTable ? "SHOW CHART" : "SHOW TABLE"}</Button></div>
    {asTable ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>DAY (UTC)</th><th>SUCCEEDED</th><th>FAILED</th><th>AVG DURATION</th></tr></thead><tbody>{[...days].reverse().map(day => <tr key={day.day}><td>{day.day}</td><td>{day.success}</td><td>{day.failed}</td><td>{day.avgDurationMs === null ? "—" : `${day.avgDurationMs} ms`}</td></tr>)}</tbody></table></div>
      : total === 0 ? <p className="panel-copy">No finished runs in this window yet. Run a pipeline and it appears here.</p>
      : <div className="ops-chart__plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Runs per day: ${total} runs in ${days.length} days`}>
          {ticks.map(tick => <g key={tick}><line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke="rgba(255,255,255,.12)" strokeWidth={1} /><text x={left - 6} y={y(tick) + 3} textAnchor="end" className="ops-axis">{Math.round(tick)}</text></g>)}
          {days.map((day, index) => {
            const x = left + slot * index + (slot - barWidth) / 2;
            const successTop = y(day.success), failedTop = y(day.success + day.failed);
            const gap = day.success && day.failed ? 2 : 0;
            return <g key={day.day}>
              <rect x={left + slot * index} y={top} width={slot} height={height - top - bottom} fill="transparent" onMouseEnter={() => setHover(index)} />
              {hover === index ? <rect x={left + slot * index} y={top} width={slot} height={height - top - bottom} fill="rgba(255,255,255,.04)" pointerEvents="none" /> : null}
              {day.success ? <path d={day.failed ? `M${x},${y(0)} V${successTop} H${x + barWidth} V${y(0)} Z` : rounded(x, successTop, barWidth, y(0) - successTop)} fill={GOOD} pointerEvents="none" /> : null}
              {day.failed ? <path d={rounded(x, failedTop, barWidth, successTop - failedTop - gap)} fill={BAD} pointerEvents="none" /> : null}
              {index % labelEvery === 0 || index === days.length - 1 ? <text x={x + barWidth / 2} y={height - 8} textAnchor="middle" className="ops-axis">{day.day.slice(5)}</text> : null}
            </g>;
          })}
        </svg>
        {hover !== null ? <div className="ops-tooltip" style={{ left: `${((left + slot * hover + slot / 2) / width) * 100}%` }}><b>{days[hover]!.day}</b><span><i style={{ background: GOOD }} />{days[hover]!.success} succeeded</span><span><i style={{ background: BAD }} />{days[hover]!.failed} failed</span><span>{days[hover]!.avgDurationMs === null ? "no successful runs" : `avg ${days[hover]!.avgDurationMs} ms`}</span></div> : null}
      </div>}
  </div>;
}

// ---------------------------------------------------------------- monitoring

function MonitoringBody({ workspaceId, anomaliesOnly }: { workspaceId: number; anomaliesOnly: boolean }) {
  const [, setLocation] = useLocation();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const summary = trpc.monitoring.summary.useQuery({ workspaceId, days, utcOffsetMinutes: -new Date().getTimezoneOffset() }, { placeholderData: previous => previous });
  if (summary.isLoading) return <div className="workspace-loading"><span>COMPUTING FROM STORED RUNS…</span></div>;
  if (summary.error) return <section className="panel"><StateMessage title="Monitoring unavailable" detail={summary.error.message} /></section>;
  const data = summary.data!;
  const picker = <div className="module-filter"><select aria-label="Time window" value={days} onChange={event => setDays(Number(event.target.value) as 7 | 30 | 90)}><option value={7}>LAST 7 DAYS</option><option value={30}>LAST 30 DAYS</option><option value={90}>LAST 90 DAYS</option></select></div>;
  const anomalyTable = data.anomalies.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>ANOMALY</th><th>PIPELINE</th><th>RUN</th><th>OBSERVED</th><th>BASELINE</th><th>COMPARED WITH</th><th>WHEN</th></tr></thead><tbody>{data.anomalies.map(item => <tr key={item.id} className="table-row-clickable" onClick={() => setLocation(`/pipelines/runs/${item.runId}`)}><td><span className={severityClass(item.severity)}>{item.kind.replace(/_/g, " ").toUpperCase()}</span><small className="ops-cell-note">{item.message}</small></td><td>{item.pipelineName}</td><td>#{item.runId}</td><td>{item.kind === "duration_spike" ? `${item.observed} ms` : item.kind === "volume_change" ? `${item.observed} rows` : `${item.observed} values`}</td><td>{item.baseline === null ? "—" : item.kind === "duration_spike" ? `${item.baseline} ms` : `${item.baseline} rows`}</td><td>{item.baselineRunIds.length ? item.baselineRunIds.map(id => `#${id}`).join(", ") : "—"}</td><td>{when(item.at)}</td></tr>)}</tbody></table></div>
    : <StateMessage title="No anomalies" detail={`Nothing unusual in the last ${days} days. A run is compared only with at least ${data.rules.minBaselineRuns} earlier successful runs of the same pipeline.`} />;
  const rules = <p className="panel-copy">Rules: a successful run is compared with the median of the previous {data.rules.minBaselineRuns}–{data.rules.baselineWindow} successful runs of the same pipeline. <b>Duration spike</b>: more than {data.rules.durationFactor}× the median and at least {data.rules.durationMinExtraMs} ms longer. <b>Volume change</b>: rows out differ by {Math.round(data.rules.volumeChange * 100)}% or more. <b>Coercion failures</b>: any value that could not be converted.</p>;
  if (anomaliesOnly) return <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">ANOMALIES · COMPUTED FROM PIPELINE_RUNS</p><h2>{data.anomalies.length} IN THE LAST {days} DAYS</h2></div>{picker}</div>{rules}{anomalyTable}</section>;
  const k = data.kpis;
  return <>
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">PIPELINE_RUNS · LAST {days} DAYS</p><h2>OPERATIONAL HEALTH</h2></div><div className="step-actions">{picker}<PersistedBadge /></div></div>
      <div className="ops-tiles">
        <Tile label="RUNS" value={pad(k.runs)} detail={k.inProgress ? `${k.inProgress} in progress` : "finished"} onClick={() => setLocation("/pipelines/runs")} />
        <Tile label="SUCCESS RATE" value={k.successRate === null ? "—" : `${k.successRate}%`} detail={`${k.successes} ok · ${k.failures} failed`} tone={k.failures ? "bad" : k.runs ? "good" : undefined} />
        <Tile label="MEDIAN DURATION" value={k.medianDurationMs === null ? "—" : `${k.medianDurationMs} ms`} detail="successful runs" />
        <Tile label="ROWS PROCESSED" value={k.rowsProcessed.toLocaleString()} detail="input rows of successful runs" />
        <Tile label="ACTIVE INCIDENTS" value={pad(data.incidents.total)} detail={`${data.incidents.critical} critical`} tone={data.incidents.total ? "bad" : undefined} onClick={() => setLocation("/incidents")} />
        <Tile label="QUALITY CHECKS FAILING" value={pad(data.quality.failing)} detail={`of ${data.quality.checks} checks`} tone={data.quality.failing ? "bad" : undefined} onClick={() => setLocation("/quality")} />
      </div>
    </section>
    <section className="panel"><p className="eyebrow">RUNS PER DAY (UTC)</p><h2>{k.runs} FINISHED RUNS</h2><RunsPerDayChart days={data.days} /></section>
    <section className="panel"><p className="eyebrow">PER PIPELINE · SAME WINDOW</p><h2>{data.pipelines.length} PIPELINES RAN</h2>
      {data.pipelines.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>PIPELINE</th><th>RUNS</th><th>SUCCESS RATE</th><th>AVG DURATION</th><th>LAST RUN</th><th>FAILING STREAK</th><th>OPEN</th></tr></thead><tbody>{data.pipelines.map(item => <tr key={item.pipelineId} className="table-row-clickable" onClick={() => setLocation(`/pipelines/${item.pipelineId}`)}><td><span className="table-name">{item.pipelineName}</span></td><td>{item.runs}</td><td>{item.successRate === null ? "—" : `${item.successRate}%`}</td><td>{item.avgDurationMs === null ? "—" : `${item.avgDurationMs} ms`}</td><td>{item.lastRun ? <span className={item.lastRun.status === "success" ? "status status--green" : "status status--red"}>#{item.lastRun.id} {item.lastRun.status.toUpperCase()}</span> : "—"}</td><td>{item.consecutiveFailures ? <span className="status status--red">{item.consecutiveFailures} FAILED IN A ROW</span> : "—"}</td><td><ArrowUpRight size={14} /></td></tr>)}</tbody></table></div> : <p className="panel-copy">No runs in this window.</p>}
    </section>
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">ANOMALIES</p><h2>{data.anomalies.length} FLAGGED</h2></div><Button variant="outline" onClick={() => setLocation("/monitoring/anomalies")}>OPEN ANOMALIES</Button></div>{rules}{data.anomalies.length ? anomalyTable : <p className="panel-copy">None in this window.</p>}</section>
  </>;
}

export function MonitoringPage({ anomalies = false }: { anomalies?: boolean }) {
  return <div className="page-stack"><Heading eyebrow={anomalies ? "OPERATIONS · ANOMALIES" : "OPERATIONS · MONITORING"} title={anomalies ? <>MONITORING<br /><em>ANOMALIES.</em></> : <>MONITORING<br /><em>OVERVIEW.</em></>} description={anomalies ? "Runs that behaved differently from the same pipeline's recent history, with the runs they were compared against." : "Run health computed from the pipeline_runs table of the active workspace. Nothing on this page is simulated."} /><WorkspaceGate subject="Monitoring">{workspaceId => <MonitoringBody key={`${workspaceId}-${anomalies}`} workspaceId={workspaceId} anomaliesOnly={anomalies} />}</WorkspaceGate></div>;
}

// ---------------------------------------------------------------- data quality

const CHECK_LABEL: Record<CheckType, string> = { not_null: "Never empty", unique: "No duplicates", allowed_values: "Only allowed values", range: "Number within range", row_count: "Row count" };

function AddCheckForm({ workspaceId, datasetId, columns, onDone }: { workspaceId: number; datasetId: number; columns: string[]; onDone: () => void }) {
  const [checkType, setCheckType] = useState<CheckType>("not_null");
  const [column, setColumn] = useState(columns[0] ?? "");
  const [values, setValues] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [severity, setSeverity] = useState<"warning" | "critical">("warning");
  const create = trpc.quality.createCheck.useMutation({ onSuccess: () => { toast.success("Check saved and evaluated on the stored rows"); setValues(""); setMin(""); setMax(""); onDone(); }, onError: error => toast.error("Check not saved", { description: error.message }) });
  const num = (text: string) => (text.trim() === "" ? undefined : Number(text));
  const submit = () => {
    const bounds = { ...(num(min) !== undefined ? { min: num(min) } : {}), ...(num(max) !== undefined ? { max: num(max) } : {}) };
    const definition = checkType === "row_count" ? { checkType, columnName: null, config: bounds }
      : checkType === "allowed_values" ? { checkType, columnName: column, config: { values: values.split(",").map(item => item.trim()).filter(Boolean) } }
      : checkType === "range" ? { checkType, columnName: column, config: bounds }
      : { checkType, columnName: column, config: {} };
    create.mutate({ workspaceId, datasetId, severity, definition: definition as never });
  };
  return <div className="workspace-form ops-check-form">
    <div><label htmlFor="check-type">RULE</label><select id="check-type" value={checkType} onChange={event => setCheckType(event.target.value as CheckType)}>{CHECK_TYPES.map(type => <option key={type} value={type}>{CHECK_LABEL[type]}</option>)}</select></div>
    {checkType !== "row_count" ? <div><label htmlFor="check-column">COLUMN</label><select id="check-column" value={column} onChange={event => setColumn(event.target.value)}>{columns.map(name => <option key={name} value={name}>{name}</option>)}</select></div> : null}
    {checkType === "allowed_values" ? <div><label htmlFor="check-values">ALLOWED VALUES (COMMA-SEPARATED)</label><Input id="check-values" value={values} onChange={event => setValues(event.target.value)} placeholder="pro, starter, enterprise" /></div> : null}
    {checkType === "range" || checkType === "row_count" ? <div className="ops-inline"><div><label htmlFor="check-min">MINIMUM</label><Input id="check-min" inputMode="decimal" value={min} onChange={event => setMin(event.target.value)} /></div><div><label htmlFor="check-max">MAXIMUM</label><Input id="check-max" inputMode="decimal" value={max} onChange={event => setMax(event.target.value)} /></div></div> : null}
    <div><label htmlFor="check-severity">SEVERITY IF IT FAILS</label><select id="check-severity" value={severity} onChange={event => setSeverity(event.target.value as "warning" | "critical")}><option value="warning">Warning</option><option value="critical">Critical</option></select></div>
    <Button className="button-red" disabled={create.isPending || (checkType !== "row_count" && !column)} onClick={submit}>{create.isPending ? <><Loader2 size={14} className="spin" /> SAVING</> : "ADD CHECK"}</Button>
  </div>;
}

function QualityBody({ workspaceId, role }: { workspaceId: number; role: string | null }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const datasets = trpc.dataset.list.useQuery({ workspaceId });
  const usable = useMemo(() => (datasets.data ?? []).filter(item => item.persisted), [datasets.data]);
  const [picked, setPicked] = useState<number>(() => Number(new URLSearchParams(window.location.search).get("dataset")) || 0);
  const datasetId = usable.some(item => item.id === picked) ? picked : usable[0]?.id ?? 0;
  const overview = trpc.quality.overview.useQuery({ workspaceId });
  const checks = trpc.quality.checks.useQuery({ workspaceId, datasetId }, { enabled: datasetId > 0 });
  const detail = trpc.dataset.get.useQuery({ workspaceId, datasetId }, { enabled: datasetId > 0 });
  const refresh = () => Promise.all([utils.quality.invalidate(), utils.incidents.invalidate(), utils.monitoring.invalidate()]);
  const run = trpc.quality.run.useMutation({ onSuccess: async out => { await refresh(); const failed = out.results.filter(item => item.status !== "pass").length; (failed ? toast.error : toast.success)(`${out.results.length} checks evaluated on ${out.evaluatedRows} stored rows`, { description: failed ? `${failed} failed — see Incidents.` : "All passed." }); }, onError: error => toast.error("Checks not run", { description: error.message }) });
  const toggle = trpc.quality.setEnabled.useMutation({ onSuccess: refresh, onError: error => toast.error(error.message) });
  const canManage = canEditPipelines(role);
  if (datasets.isLoading || overview.isLoading) return <div className="workspace-loading"><span>LOADING QUALITY…</span></div>;
  if (datasets.error) return <section className="panel"><StateMessage title="Quality unavailable" detail={datasets.error.message} /></section>;
  if (overview.error) return <section className="panel"><StateMessage title="Quality summary unavailable" detail={overview.error.message} /></section>;
  if (!usable.length) return <section className="panel"><StateMessage title="No datasets to check" detail="Import a dataset first. Quality checks run against a dataset's stored rows." action={<Button className="button-red" onClick={() => setLocation("/datasets/import")}>IMPORT CSV</Button>} /></section>;
  const o = overview.data;
  return <>
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">QUALITY_CHECKS · LATEST RESULT OF EACH ENABLED CHECK</p><h2>WORKSPACE QUALITY</h2></div><PersistedBadge /></div>
      <div className="ops-tiles"><Tile label="CHECKS" value={pad(o?.checks ?? 0)} detail={`${o?.evaluated ?? 0} evaluated`} /><Tile label="PASSING" value={o?.passRate === null || o?.passRate === undefined ? "—" : `${o.passRate}%`} detail={`${o?.passing ?? 0} of ${o?.evaluated ?? 0}`} tone={o?.failing || o?.errors ? "bad" : o?.passing ? "good" : undefined} /><Tile label="FAILING" value={pad(o?.failing ?? 0)} tone={o?.failing ? "bad" : undefined} /><Tile label="CANNOT RUN" value={pad(o?.errors ?? 0)} detail="column missing, etc." tone={o?.errors ? "bad" : undefined} /></div>
    </section>
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">DATASET</p><h2>{detail.data?.name ?? "…"}</h2></div><div className="step-actions"><select aria-label="Dataset" value={datasetId} onChange={event => setPicked(Number(event.target.value))}>{usable.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{canManage ? <Button className="button-red" disabled={run.isPending || !checks.data?.some(check => check.enabled)} onClick={() => run.mutate({ workspaceId, datasetId })}>{run.isPending ? <><Loader2 size={14} className="spin" /> RUNNING</> : <><Play size={14} /> RUN CHECKS</>}</Button> : null}</div></div>
      <p className="panel-copy">Checks read this dataset's stored rows ({detail.data?.rowCount ?? "…"} rows). They also re-run automatically, on the rows just written, every time a pipeline successfully <b>overwrites</b> this dataset. A failing check opens an incident; a passing one closes it.</p>
      {checks.isLoading ? <div className="workspace-loading"><span>LOADING CHECKS…</span></div> : checks.data?.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>CHECK</th><th>SEVERITY</th><th>LATEST RESULT</th><th>ROWS FAILING</th><th>EXAMPLES</th><th>EVALUATED</th><th>ON</th></tr></thead><tbody>{checks.data.map(check => {
        const observed = (check.latest?.observed ?? null) as { message?: string; sample?: Array<{ rowIndex: number; value: string }> } | null;
        return <tr key={check.id} className={check.enabled ? "" : "ops-row-muted"}><td><b>{check.description}</b><small className="ops-cell-note">{observed?.message ?? "Not evaluated yet."}</small></td><td><span className={severityClass(check.severity)}>{check.severity.toUpperCase()}</span></td><td><span className={resultClass(check.latest?.status)}>{(check.latest?.status ?? "never").toUpperCase()}</span></td><td>{check.latest ? `${check.latest.failingRows} / ${check.latest.evaluatedRows}` : "—"}</td><td>{observed?.sample?.length ? observed.sample.map(item => `row ${item.rowIndex + 1}: ${item.value}`).join(" · ") : "—"}</td><td>{check.latest ? <>{when(check.latest.evaluatedAt)}<small className="ops-cell-note">{check.latest.trigger === "run" ? <Link href={`/pipelines/runs/${check.latest.runId}`}>after run #{check.latest.runId}</Link> : check.latest.trigger === "sync" ? "after source refresh" : "manual"} · {check.evaluations} total</small></> : "—"}</td><td>{canManage ? <input type="checkbox" aria-label={`Enable ${check.description}`} checked={check.enabled} onChange={event => toggle.mutate({ workspaceId, checkId: check.id, enabled: event.target.checked })} /> : check.enabled ? "YES" : "NO"}</td></tr>;
      })}</tbody></table></div> : <StateMessage title="No checks on this dataset" detail="Add a rule below, e.g. “email is never empty”. It is evaluated immediately on the stored rows." />}
    </section>
    {canManage && detail.data ? <section className="panel"><p className="eyebrow">NEW CHECK</p><h2>ADD A RULE</h2><AddCheckForm key={datasetId} workspaceId={workspaceId} datasetId={datasetId} columns={detail.data.columns.map(column => column.name)} onDone={() => void refresh()} /></section> : null}
    {o?.datasets.length ? <section className="panel"><p className="eyebrow">ALL DATASETS WITH CHECKS</p><div className="data-table-wrap"><table className="data-table"><thead><tr><th>DATASET</th><th>CHECKS</th><th>PASSING</th><th>FAILING</th><th>CANNOT RUN</th><th>LAST EVALUATED</th></tr></thead><tbody>{o.datasets.map(item => <tr key={item.datasetId} className="table-row-clickable" onClick={() => setPicked(item.datasetId)}><td><span className="table-name">{item.datasetName}</span></td><td>{item.checks}</td><td>{item.passing}</td><td>{item.failing ? <span className="status status--red">{item.failing}</span> : 0}</td><td>{item.errors ? <span className="status status--yellow">{item.errors}</span> : 0}</td><td>{when(item.lastEvaluatedAt)}</td></tr>)}</tbody></table></div></section> : null}
  </>;
}

export function QualityPage() {
  return <div className="page-stack"><Heading eyebrow="OPERATIONS · DATA QUALITY" title={<>DATA<br /><em>QUALITY.</em></>} description="Rules you define on a dataset, evaluated on its stored rows. Every result is kept and can be reproduced." /><WorkspaceGate subject="Data quality">{(workspaceId, role) => <QualityBody key={workspaceId} workspaceId={workspaceId} role={role} />}</WorkspaceGate></div>;
}

// ---------------------------------------------------------------- incidents

function IncidentsBody({ workspaceId }: { workspaceId: number }) {
  const [, setLocation] = useLocation();
  const [filter, setFilter] = useState<"active" | "all">("active");
  const list = trpc.incidents.list.useQuery({ workspaceId, filter });
  if (list.isLoading) return <div className="workspace-loading"><span>LOADING INCIDENTS…</span></div>;
  if (list.error) return <section className="panel"><StateMessage title="Incidents unavailable" detail={list.error.message} /></section>;
  const rows = list.data ?? [];
  return <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">INCIDENTS · DATABASE</p><h2>{rows.length} {filter === "active" ? "ACTIVE" : "TOTAL"}</h2></div><div className="module-filter"><select aria-label="Incident filter" value={filter} onChange={event => setFilter(event.target.value as "active" | "all")}><option value="active">OPEN & ACKNOWLEDGED</option><option value="all">ALL, INCLUDING RESOLVED</option></select></div></div>
    <p className="panel-copy">An incident is opened only by a defined event: a <b>failed pipeline run</b>, or a <b>quality check that fails or cannot run</b>. Repeats are counted on the same incident. The next successful run or passing check resolves it automatically.</p>
    {rows.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>INCIDENT</th><th>SEVERITY</th><th>STATUS</th><th>SOURCE</th><th>OCCURRENCES</th><th>LAST SEEN</th><th>OPEN</th></tr></thead><tbody>{rows.map(item => <tr key={item.id} className="table-row-clickable" onClick={() => setLocation(`/incidents/${item.id}`)}><td><b>#{item.id} · {item.title}</b><small className="ops-cell-note">{item.detail}</small></td><td><span className={severityClass(item.severity)}>{item.severity.toUpperCase()}</span></td><td><span className={incidentStatusClass(item.status)}>{item.status.toUpperCase()}</span></td><td>{item.sourceType === "pipeline_run_failed" ? `Pipeline · ${item.pipelineName ?? "deleted"}` : `Quality · ${item.datasetName ?? "deleted"}`}</td><td>{item.occurrences}</td><td>{when(item.lastSeenAt)}</td><td><ArrowUpRight size={14} /></td></tr>)}</tbody></table></div>
      : <StateMessage title={filter === "active" ? "No active incidents" : "No incidents yet"} detail="When a run fails or a quality check fails, it appears here with the evidence." />}
  </section>;
}

export function IncidentsPage() {
  return <div className="page-stack"><Heading eyebrow="OPERATIONS · INCIDENTS" title={<>INCIDENTS<br /><em>& RCA.</em></>} description="Operational problems opened by real failed runs and failing quality checks, with their evidence and history." /><WorkspaceGate subject="Incidents">{workspaceId => <IncidentsBody key={workspaceId} workspaceId={workspaceId} />}</WorkspaceGate></div>;
}

const ACTION_LABEL: Record<string, string> = { INCIDENT_OPENED: "Opened", INCIDENT_RECURRED: "Happened again", INCIDENT_ACKNOWLEDGED: "Acknowledged", INCIDENT_RESOLVED: "Resolved" };

function IncidentBody({ workspaceId, incidentId }: { workspaceId: number; incidentId: number }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const [note, setNote] = useState("");
  const incident = trpc.incidents.get.useQuery({ workspaceId, incidentId }, { retry: false });
  const update = trpc.incidents.update.useMutation({ onSuccess: async data => { await Promise.all([utils.incidents.invalidate(), utils.monitoring.invalidate()]); setNote(""); toast.success(`Incident ${data.status}`); }, onError: error => toast.error("Not updated", { description: error.message }) });
  if (incident.isLoading) return <div className="workspace-loading"><span>LOADING INCIDENT…</span></div>;
  if (incident.error) return <section className="panel"><StateMessage title={incident.error.data?.code === "NOT_FOUND" ? "Incident not found" : "Incident unavailable"} detail={incident.error.message} /></section>;
  const data = incident.data!;
  return <>
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">INCIDENT #{data.id} · {data.sourceType === "pipeline_run_failed" ? "FAILED PIPELINE RUN" : "FAILING QUALITY CHECK"}</p><h2>{data.title}</h2></div><div className="step-actions"><span className={severityClass(data.severity)}>{data.severity.toUpperCase()}</span><span className={incidentStatusClass(data.status)}>{data.status.toUpperCase()}</span></div></div>
      <p className="panel-copy">{data.detail}</p>
      <div className="detail-grid"><div><span>OPENED</span><b>{when(data.openedAt)}</b></div><div><span>LAST SEEN</span><b>{when(data.lastSeenAt)}</b></div><div><span>OCCURRENCES</span><b>{data.occurrences}</b></div><div><span>{data.status === "resolved" ? "RESOLVED" : data.status === "acknowledged" ? "ACKNOWLEDGED BY" : "OWNER"}</span><b>{data.status === "resolved" ? `${data.resolution === "auto" ? "Automatically" : data.resolvedByName ?? "—"} · ${when(data.resolvedAt)}` : data.status === "acknowledged" ? `${data.acknowledgedByName ?? "—"} · ${when(data.acknowledgedAt)}` : "Unassigned"}</b></div></div>
      {data.resolutionNote ? <p className="panel-copy"><b>Resolution:</b> {data.resolutionNote}</p> : null}
      <div className="step-actions">{data.pipeline ? <Button variant="outline" onClick={() => setLocation(`/pipelines/${data.pipeline!.id}`)}><ArrowUpRight size={13} /> PIPELINE · {data.pipeline.name}</Button> : null}{data.dataset ? <Button variant="outline" onClick={() => setLocation(`/quality?dataset=${data.dataset!.id}`)}><ArrowUpRight size={13} /> QUALITY · {data.dataset.name}</Button> : null}{data.pipeline ? <Button variant="outline" onClick={() => setLocation(`/lineage?focus=pipeline:${data.pipeline!.id}`)}><ArrowUpRight size={13} /> BLAST RADIUS</Button> : data.dataset ? <Button variant="outline" onClick={() => setLocation(`/lineage?focus=dataset:${data.dataset!.id}`)}><ArrowUpRight size={13} /> BLAST RADIUS</Button> : null}</div>
    </section>
    {data.status !== "resolved" ? <section className="panel"><p className="eyebrow">RESPOND</p><h2>ACKNOWLEDGE OR RESOLVE</h2>{data.canHandle ? <div className="workspace-form"><div><label htmlFor="incident-note">NOTE (REQUIRED TO RESOLVE)</label><Textarea id="incident-note" value={note} onChange={event => setNote(event.target.value)} placeholder="What was done, or why this is acceptable" /></div><div className="step-actions">{data.status === "open" ? <Button variant="outline" disabled={update.isPending} onClick={() => update.mutate({ workspaceId, incidentId, action: "acknowledge", note: note.trim() || null })}><ShieldAlert size={14} /> ACKNOWLEDGE</Button> : null}<Button className="button-red" disabled={update.isPending || note.trim().length < 5} onClick={() => update.mutate({ workspaceId, incidentId, action: "resolve", note })}><CheckCircle2 size={14} /> RESOLVE</Button></div><p className="panel-copy">If the problem is really fixed, you do not need to resolve by hand: the next successful run (or passing check) closes this automatically, with the evidence.</p></div> : <p className="panel-copy">Viewers can read incidents but not change them.</p>}</section> : null}
    <section className="split-grid">
      <section className="panel"><p className="eyebrow">EVIDENCE · SOURCE EVENTS</p><h2>{data.sourceType === "pipeline_run_failed" ? `${data.runs.length} RUNS` : `${data.results.length} CHECK RESULTS`}</h2>
        {data.sourceType === "pipeline_run_failed" ? <div className="history-list ops-history">{data.runs.map(run => <div key={run.id}><span><b><Link href={`/pipelines/runs/${run.id}`}>Run #{run.id}</Link> · <span className={run.status === "success" ? "status status--green" : run.status === "failed" ? "status status--red" : "status status--yellow"}>{run.status.toUpperCase()}</span></b><small>{when(run.startedAt)} · {run.rowsIn} → {run.rowsOut} rows</small>{run.errorMessage ? <small className="form-error">{run.errorMessage}</small> : null}</span></div>)}</div>
          : <div className="history-list ops-history">{data.results.map(result => { const observed = result.observed as { message?: string } | null; return <div key={result.id}><span><b>Result #{result.id} · <span className={resultClass(result.status)}>{result.status.toUpperCase()}</span></b><small>{when(result.evaluatedAt)} · {result.trigger === "run" ? <Link href={`/pipelines/runs/${result.runId}`}>after run #{result.runId}</Link> : result.trigger === "sync" ? "after source refresh" : "manual"} · {result.failingRows}/{result.evaluatedRows} rows failing</small>{observed?.message ? <small>{observed.message}</small> : null}</span></div>; })}</div>}
        {data.check ? <p className="panel-copy">Check: <b>{data.check.description}</b> ({data.check.severity}{data.check.enabled ? "" : ", disabled"})</p> : null}
      </section>
      <section className="panel"><p className="eyebrow">TIMELINE · AUDIT LOG</p><h2>{data.timeline.length} EVENTS</h2><div className="history-list ops-history">{data.timeline.map((event, index) => { const meta = (event.metadata ?? {}) as { note?: string; runId?: number | null; resultId?: number | null; occurrences?: number }; return <div key={index}><span><b>{event.action === "INCIDENT_RESOLVED" && (event.metadata as { resolution?: string })?.resolution === "auto" ? <><CheckCircle2 size={12} /> Resolved automatically</> : event.action === "INCIDENT_OPENED" ? <><XCircle size={12} /> Opened</> : event.action === "INCIDENT_RECURRED" ? <><AlertTriangle size={12} /> Happened again ({meta.occurrences}×)</> : ACTION_LABEL[event.action] ?? event.action}</b><small>{when(event.createdAt)} · {event.actor ?? "—"}{meta.runId ? ` · run #${meta.runId}` : ""}{meta.resultId ? ` · result #${meta.resultId}` : ""}</small>{meta.note ? <small>“{meta.note}”</small> : null}</span></div>; })}</div></section>
    </section>
  </>;
}

export function IncidentDetailPage({ id }: { id: string }) {
  const incidentId = Number(id);
  return <div className="page-stack"><Heading eyebrow="OPERATIONS · INCIDENT" title={<>INCIDENT<br /><em>DETAIL.</em></>} description="What happened, the stored evidence that caused it, and everything done about it." /><WorkspaceGate subject="Incidents">{workspaceId => Number.isInteger(incidentId) && incidentId > 0 ? <IncidentBody key={`${workspaceId}-${incidentId}`} workspaceId={workspaceId} incidentId={incidentId} /> : <section className="panel"><StateMessage title="Invalid incident id" detail={`“${id}” is not an incident id.`} /></section>}</WorkspaceGate></div>;
}
