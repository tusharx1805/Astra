import { Button } from "@/components/ui/button";
import { ModuleSubnav } from "@/components/ModuleSubnav";
import { PersistedBadge, StateMessage, WorkspaceGate } from "@/components/DatasetModules";
import { PIPELINE_TABS } from "@/components/PipelineModules";
import { trpc } from "@/lib/trpc";
import { ArrowUpRight, Play } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

/**
 * Phase 3 — persisted pipeline runs. Every value here is read from pipeline_runs
 * (and the output dataset it wrote) through pipeline.runs / pipeline.getRun.
 * There are no synthetic run identifiers: a run is addressed by its database id.
 */

export function runStatusClass(status: string) {
  if (status === "success") return "status status--green";
  if (status === "failed") return "status status--red";
  return "status status--yellow";
}

export function formatDuration(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

function formatTime(value: Date | string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}

/** Start a run; on completion (success OR recorded failure) open the run's own detail page. */
export function useRunPipeline(_workspaceId: number) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  return trpc.pipeline.run.useMutation({
    onSuccess: async run => {
      await Promise.all([utils.pipeline.runs.invalidate(), utils.pipeline.get.invalidate(), utils.pipeline.list.invalidate(), utils.dataset.list.invalidate(), utils.dataset.get.invalidate(), utils.dataset.rows.invalidate(), utils.dataset.stats.invalidate(), utils.workspace.views.invalidate(), utils.incidents.invalidate(), utils.monitoring.invalidate(), utils.quality.invalidate(), utils.reports.invalidate()]);
      if (run.status === "success") toast.success(`Run #${run.id} succeeded`, { description: `${run.rowsIn} rows in · ${run.rowsOut} rows out · ${formatDuration(run.durationMs)}` });
      else toast.error(`Run #${run.id} failed`, { description: run.errorMessage ?? "See the run detail." });
      setLocation(`/pipelines/runs/${run.id}`);
    },
    onError: error => toast.error("The run could not be started", { description: error.message }),
  });
}

type RunRow = { id: number; pipelineId: number; pipelineName: string; status: string; rowsIn: number; rowsOut: number; coercionFailures: number; durationMs: number; errorMessage: string | null; startedAt: Date | string; outputDatasetName: string | null };

export function RunHistoryTable({ runs, showPipeline = true, empty }: { runs: RunRow[]; showPipeline?: boolean; empty: string }) {
  const [, setLocation] = useLocation();
  if (!runs.length) return <StateMessage title="No runs yet" detail={empty} />;
  return <div className="data-table-wrap"><table className="data-table"><thead><tr><th>RUN</th>{showPipeline ? <th>PIPELINE</th> : null}<th>STATUS</th><th>ROWS IN → OUT</th><th>DURATION</th><th>STARTED</th><th>OUTPUT / ERROR</th><th>OPEN</th></tr></thead><tbody>{runs.map(run => <tr key={run.id} className="table-row-clickable" onClick={() => setLocation(`/pipelines/runs/${run.id}`)}><td><span className="table-name">#{run.id}</span></td>{showPipeline ? <td>{run.pipelineName}</td> : null}<td><span className={runStatusClass(run.status)}>{run.status.toUpperCase()}</span></td><td>{run.status === "success" ? `${run.rowsIn.toLocaleString()} → ${run.rowsOut.toLocaleString()}${run.coercionFailures ? ` · ${run.coercionFailures} coercion` : ""}` : "—"}</td><td>{run.status === "success" || run.status === "failed" ? formatDuration(run.durationMs) : "…"}</td><td>{formatTime(run.startedAt)}</td><td>{run.status === "failed" ? <span className="form-error">{(run.errorMessage ?? "Failed").slice(0, 90)}{(run.errorMessage?.length ?? 0) > 90 ? "…" : ""}</span> : run.outputDatasetName ?? "—"}</td><td><ArrowUpRight size={14} /></td></tr>)}</tbody></table></div>;
}

function Heading({ eyebrow, title, description }: { eyebrow: string; title: React.ReactNode; description: string }) {
  return <><section className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div></section><ModuleSubnav tabs={PIPELINE_TABS} /></>;
}

function HistoryBody({ workspaceId }: { workspaceId: number }) {
  const runs = trpc.pipeline.runs.useQuery({ workspaceId, limit: 100 });
  if (runs.isLoading) return <div className="workspace-loading"><span>LOADING RUNS…</span></div>;
  if (runs.error) return <section className="panel"><StateMessage title="Runs unavailable" detail={runs.error.message} /></section>;
  const data = runs.data ?? [];
  const finished = data.filter(run => run.status === "success" || run.status === "failed");
  const failures = finished.filter(run => run.status === "failed").length;
  return <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">PIPELINE_RUNS · WORKSPACE</p><h2>{data.length} RUNS{finished.length ? ` · ${failures} FAILED` : ""}</h2></div><PersistedBadge /></div><RunHistoryTable runs={data} empty="Open a pipeline and use RUN PIPELINE. Each run is stored here with its status, row counts and output." /></section>;
}

export function PipelineRunHistoryPage() {
  return <div className="page-stack"><Heading eyebrow="BUILD · PIPELINES · RUNS" title={<>PIPELINE<br /><em>RUNS.</em></>} description="Every run in the active workspace, newest first, read from the pipeline_runs table." /><WorkspaceGate subject="Pipeline runs">{workspaceId => <HistoryBody key={workspaceId} workspaceId={workspaceId} />}</WorkspaceGate></div>;
}

function RunBody({ workspaceId, runId }: { workspaceId: number; runId: number }) {
  const [, setLocation] = useLocation();
  const detail = trpc.pipeline.getRun.useQuery({ workspaceId, runId }, { retry: false, refetchInterval: query => (query.state.data && (query.state.data.status === "created" || query.state.data.status === "running") ? 2000 : false) });
  const pipeline = trpc.pipeline.get.useQuery({ workspaceId, pipelineId: detail.data?.pipelineId ?? 0 }, { enabled: Boolean(detail.data), retry: false });
  const rerun = useRunPipeline(workspaceId);
  if (detail.isLoading) return <div className="workspace-loading"><span>LOADING RUN…</span></div>;
  if (detail.error) return <section className="panel"><StateMessage title={detail.error.data?.code === "NOT_FOUND" ? "Run not found" : "Run unavailable"} detail={detail.error.message} /></section>;
  const run = detail.data!;
  const { log } = run;
  const output = log.output;
  return <>
    <section className="split-grid">
      <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">PIPELINE_RUNS · #{run.id}</p><h2>{run.pipelineName}</h2></div><span className={runStatusClass(run.status)}>{run.status.toUpperCase()}</span></div>
        <div className="detail-grid"><div><span>RUN ID</span><b>{run.id}</b></div><div><span>ROWS IN → OUT</span><b>{run.rowsIn.toLocaleString()} → {run.rowsOut.toLocaleString()}</b></div><div><span>DURATION</span><b>{run.completedAt ? formatDuration(run.durationMs) : "In progress"}</b></div><div><span>COERCION FAILURES</span><b>{run.coercionFailures}</b></div><div><span>STARTED</span><b>{formatTime(run.startedAt)}</b></div><div><span>COMPLETED</span><b>{formatTime(run.completedAt)}</b></div></div>
        {run.errorMessage ? <p className="form-error" role="alert">{run.errorMessage}</p> : null}
        <div className="step-actions"><Button variant="outline" onClick={() => setLocation(`/pipelines/${run.pipelineId}`)}><ArrowUpRight size={13} /> OPEN PIPELINE</Button>{pipeline.data?.editable ? <Button className="button-red" disabled={rerun.isPending || run.status === "created" || run.status === "running"} onClick={() => rerun.mutate({ workspaceId, pipelineId: run.pipelineId })}><Play size={13} /> {rerun.isPending ? "RUNNING" : "RUN AGAIN"}</Button> : null}</div>
      </section>
      <section className="panel"><p className="eyebrow">SOURCE → OUTPUT</p><h2>{output ? "WRITTEN" : run.status === "failed" ? "NOTHING WRITTEN" : "PENDING"}</h2>
        <div className="history-list">
          <div><span><b>{log.source?.name ?? "—"}</b><small>SOURCE · {log.source ? `${log.source.rowCount} rows loaded` : "not loaded"}</small></span></div>
          {output ? <div><span><b>{output.datasetName}</b><small>{output.mode === "overwrite_existing" ? "REPLACED" : "NEW DATASET"} · {output.rowCount} rows · {output.columns.length} columns · completeness {output.qualityScore}%</small></span>{run.outputAvailable ? <Button variant="outline" onClick={() => setLocation(`/datasets/${output.datasetId}`)}><ArrowUpRight size={13} /> OPEN</Button> : <small>DATASET REMOVED</small>}</div> : null}
        </div>
        {output?.mode === "overwrite_existing" ? <p className="panel-copy">The destination may have been replaced by a later run; the sample below is what THIS run wrote.</p> : null}
      </section>
    </section>
    <section className="panel"><p className="eyebrow">EXECUTED STEPS · ROW COUNTS</p><h2>{log.steps.length} STEPS</h2>{log.steps.length ? <div className="history-list">{log.steps.map(step => <div key={step.order}><span><b>{String(step.order + 1).padStart(2, "0")} · {step.description}</b><small>{step.effect}</small></span><span><b>{step.rowsIn} → {step.rowsOut}</b><small>ROWS</small></span><span><b>{step.coercionFailures}</b><small>COERCION</small></span></div>)}</div> : <p className="panel-copy">{run.status === "failed" ? "No step was executed: the run failed before or while preparing execution." : "No steps: the source was copied unchanged."}</p>}</section>
    {output ? <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">OUTPUT SAMPLE · FROM THIS RUN</p><h2>FIRST {log.sample.length} OF {output.rowCount} ROWS</h2></div></div>{log.sample.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr>{output.columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{log.sample.map((row, index) => <tr key={index}>{output.columns.map(column => <td key={column}>{row[column] === null || row[column] === undefined ? "∅" : String(row[column])}</td>)}</tr>)}</tbody></table></div> : <p className="panel-copy">The run produced no rows.</p>}</section> : null}
    <section className="panel"><p className="eyebrow">RUN LOG</p><h2>{log.entries.length} ENTRIES</h2><div className="history-list">{log.entries.map((entry, index) => <div key={index}><span><b className={entry.level === "error" ? "form-error" : undefined}>{entry.message}</b><small>{entry.level.toUpperCase()} · {new Date(entry.at).toLocaleTimeString()}</small></span></div>)}</div></section>
  </>;
}

export function PersistedRunDetail({ id }: { id: string }) {
  const runId = Number(id);
  return <div className="page-stack"><Heading eyebrow="BUILD · PIPELINES · RUNS · DETAIL" title={<>RUN<br /><em>DETAIL.</em></>} description="The stored record of one execution: status, row counts per step, output and log." /><WorkspaceGate subject="Pipeline runs">{workspaceId => Number.isInteger(runId) && runId > 0 ? <RunBody key={`${workspaceId}-${runId}`} workspaceId={workspaceId} runId={runId} /> : <section className="panel"><StateMessage title="Invalid run id" detail={`“${id}” is not a run id.`} /></section>}</WorkspaceGate></div>;
}
