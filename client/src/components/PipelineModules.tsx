import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModuleSubnav, type ModuleTab } from "@/components/ModuleSubnav";
import { PersistedBadge, StateMessage, WorkspaceGate } from "@/components/DatasetModules";
import { canEditPipelines } from "@/hooks/useActiveWorkspace";
import { useRecentView } from "@/hooks/useRecentView";
import { trpc } from "@/lib/trpc";
import { applyTransformSteps, type Row, type TransformStep } from "../../../shared/transformations";
import { columnsAfterSteps, DATATYPES, describeStep, FILTER_OPERATORS, normalizeStep, PIPELINE_LIMITS, validatePipelineSteps, VALUELESS_FILTER_OPERATORS, type DestinationMode, type PipelineOperation } from "../../../shared/pipelineDefinition";
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Database, Filter, Loader2, GitBranch, Pencil, Play, Plus, RefreshCw, Save, ShieldAlert, Trash2 } from "lucide-react";
import { RunHistoryTable, useRunPipeline } from "@/components/PipelineRunModules";
import { RiskResultView } from "@/components/ChangeModules";
import type { ChangeRiskResult } from "../../../shared/changeRisk";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

/**
 * Phase 2 — persisted pipeline definitions.
 * Definitions are read from and written to pipelines + pipeline_steps through the
 * pipeline.* tRPC procedures. The preview runs the shared deterministic engine in
 * the browser over the first rows of the stored source dataset; it is not a run.
 */

export const PIPELINE_TABS: ModuleTab[] = [
  { label: "ALL PIPELINES", href: "/pipelines" },
  { label: "NEW PIPELINE", href: "/pipelines/create" },
  { label: "RUNS", href: "/pipelines/runs" },
  { label: "DEV FIXTURE", href: "/pipelines/fixtures" },
];

const PREVIEW_ROWS = 500;
const OPERATION_LABELS: Record<PipelineOperation, string> = { filter: "Filter rows", rename_column: "Rename column", change_datatype: "Change datatype", drop_column: "Drop column", remove_nulls: "Remove nulls" };

function Heading({ eyebrow, title, description, action }: { eyebrow: string; title: React.ReactNode; description: string; action?: React.ReactNode }) {
  return <><section className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</section><ModuleSubnav tabs={PIPELINE_TABS} /></>;
}

export function pipelineStatusClass(status: string) {
  const value = status.toUpperCase();
  if (value === "FAILED") return "status status--red";
  if (value === "WARNING") return "status status--yellow";
  if (value === "DRAFT") return "status status--blue";
  return "status status--green";
}

function destinationLabel(mode: string | null | undefined, name: string | null | undefined) {
  if (mode === "overwrite_existing") return name ? `Overwrite ${name}` : "Overwrite (dataset removed)";
  return "New dataset";
}

// ---------------------------------------------------------------- registry

function RegistryBody({ workspaceId }: { workspaceId: number }) {
  const [, setLocation] = useLocation();
  const [filter, setFilter] = useState("all");
  const list = trpc.pipeline.list.useQuery({ workspaceId });
  const rows = useMemo(() => (list.data ?? []).filter(item => filter === "all" || item.status.toLowerCase() === filter), [list.data, filter]);
  if (list.isLoading) return <div className="workspace-loading"><span>LOADING PIPELINES…</span></div>;
  if (list.error) return <section className="panel"><StateMessage title="Pipelines unavailable" detail={list.error.message} /></section>;
  return <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">WORKSPACE PIPELINES · DATABASE</p><h2>{list.data?.length ?? 0} DEFINITIONS</h2></div><div className="module-filter"><Filter size={14} /><select aria-label="Filter pipelines" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">ALL STATUS</option><option value="draft">DRAFT</option><option value="healthy">HEALTHY</option><option value="warning">WARNING</option><option value="failed">FAILED</option></select></div></div>
    {rows.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>PIPELINE</th><th>STATUS</th><th>SOURCE</th><th>STEPS</th><th>DESTINATION</th><th>OPEN</th></tr></thead><tbody>{rows.map(item => <tr key={item.id} className="table-row-clickable" onClick={() => setLocation(`/pipelines/${item.id}`)}><td><span className="table-name">{item.name}</span></td><td><span className={pipelineStatusClass(item.status)}>{item.status}</span></td><td>{item.sourceDatasetName ?? (item.legacy ? "LEGACY" : "—")}</td><td>{item.stepCount}</td><td>{item.legacy ? "—" : destinationLabel(item.destinationMode, null)}</td><td><ArrowUpRight size={14} /></td></tr>)}</tbody></table></div>
      : <StateMessage title={list.data?.length ? "No pipelines match" : "No pipelines yet"} detail={list.data?.length ? "Try a different status filter." : "Build this workspace's first pipeline from one of its imported datasets."} action={<Button className="button-red" onClick={() => setLocation("/pipelines/create")}><Plus size={14} /> NEW PIPELINE</Button>} />}
  </section>;
}

export function PipelineRegistry() {
  const [, setLocation] = useLocation();
  return <div className="page-stack"><Heading eyebrow="BUILD · PIPELINES" title={<>PIPELINE<br /><em>REGISTRY.</em></>} description="Every pipeline definition saved in the active workspace, read back from the database." action={<Button className="button-red" onClick={() => setLocation("/pipelines/create")}><Plus size={14} /> NEW PIPELINE</Button>} /><WorkspaceGate subject="Pipelines">{workspaceId => <RegistryBody key={workspaceId} workspaceId={workspaceId} />}</WorkspaceGate></div>;
}

// ---------------------------------------------------------------- detail

function DetailBody({ workspaceId, pipelineId }: { workspaceId: number; pipelineId: number }) {
  const [, setLocation] = useLocation();
  const detail = trpc.pipeline.get.useQuery({ workspaceId, pipelineId }, { retry: false });
  const runs = trpc.pipeline.runs.useQuery({ workspaceId, pipelineId, limit: 10 }, { enabled: detail.isSuccess });
  const run = useRunPipeline(workspaceId);
  useRecentView({ workspaceId, entityType: "pipeline", entityId: detail.data ? String(detail.data.id) : undefined, entityLabel: detail.data?.name });
  if (detail.isLoading) return <div className="workspace-loading"><span>LOADING PIPELINE…</span></div>;
  if (detail.error) return <section className="panel"><StateMessage title={detail.error.data?.code === "NOT_FOUND" ? "Pipeline not found" : "Pipeline unavailable"} detail={detail.error.message} /></section>;
  const pipeline = detail.data!;
  return <>
    <section className="pipeline-flow">
      <article><Database size={20} /><p>SOURCE</p><h3>{pipeline.sourceDatasetName ?? (pipeline.legacy ? "Not recorded" : "Dataset removed")}</h3>{pipeline.sourceDatasetId && pipeline.sourceDatasetName ? <Button variant="outline" onClick={() => setLocation(`/datasets/${pipeline.sourceDatasetId}`)}><ArrowUpRight size={13} /> OPEN DATASET</Button> : null}</article>
      <ArrowRight />
      <article><RefreshCw size={20} /><p>TRANSFORMATION</p><h3>{pipeline.steps.length ? `${pipeline.steps.length} ordered steps` : "Pass-through"}</h3></article>
      <ArrowRight />
      <article><Database size={20} /><p>DESTINATION</p><h3>{pipeline.legacy ? "Not recorded" : destinationLabel(pipeline.destinationMode, pipeline.destinationDatasetName)}</h3></article>
    </section>
    <section className="split-grid">
      <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">PIPELINE_STEPS · STORED ORDER</p><h2>{pipeline.steps.length} STEPS</h2></div><PersistedBadge /></div>
        {pipeline.invalidStepOrders.length ? <p className="form-error" role="alert">Stored step(s) at position {pipeline.invalidStepOrders.map(order => order + 1).join(", ")} no longer match the supported step format and are not shown. Re-save the pipeline to replace them.</p> : null}
        {pipeline.steps.length ? <div className="history-list">{pipeline.steps.map(step => <div key={step.id}><span><b>{String(step.stepOrder + 1).padStart(2, "0")} · {describeStep(step)}</b><small>{step.operation}</small></span></div>)}</div> : <p className="panel-copy">{pipeline.legacy ? "Legacy registry entry: no steps were stored for this pipeline." : "No steps: the pipeline copies the source unchanged."}</p>}
      </section>
      <section className="panel"><p className="eyebrow">DEFINITION</p><h2>{pipeline.name}</h2><div className="detail-grid"><div><span>STATUS</span><b><span className={pipelineStatusClass(pipeline.status)}>{pipeline.status}</span></b></div><div><span>VERSION</span><b>{pipeline.version}</b></div><div><span>SCOPE</span><b>{pipeline.legacy ? "Organisation (legacy)" : "This workspace"}</b></div></div>
        {pipeline.editable ? <div className="step-actions"><Button className="button-red" disabled={run.isPending} onClick={() => run.mutate({ workspaceId, pipelineId: pipeline.id })}>{run.isPending ? <><Loader2 size={14} className="spin" /> RUNNING</> : <><Play size={14} /> RUN PIPELINE</>}</Button><Button variant="outline" onClick={() => setLocation(`/pipelines/${pipeline.id}/edit`)}><Pencil size={14} /> EDIT</Button><Button variant="outline" onClick={() => setLocation(`/lineage?focus=pipeline:${pipeline.id}`)}><GitBranch size={14} /> LINEAGE</Button></div> : <p className="panel-copy">{pipeline.legacy ? "Legacy pipelines are read-only." : "Your role can read this pipeline and its runs, but not edit or run it."}</p>}
        <p className="panel-copy">A run executes these stored steps on the server against the source dataset's stored rows, writes the output dataset and records the run. {pipeline.destinationMode === "overwrite_existing" ? "This pipeline REPLACES the destination dataset's rows on every successful run." : "Each successful run creates a new output dataset."}</p>
      </section>
    </section>
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">PIPELINE_RUNS · THIS PIPELINE</p><h2>RUN HISTORY</h2></div><PersistedBadge /></div>
      {runs.isLoading ? <div className="workspace-loading"><span>LOADING RUNS…</span></div> : runs.error ? <p className="form-error" role="alert">{runs.error.message}</p> : <RunHistoryTable runs={runs.data ?? []} showPipeline={false} empty="No runs yet. Use RUN PIPELINE to execute this definition." />}
    </section>
  </>;
}

export function PersistedPipelineDetail({ id }: { id: string }) {
  const pipelineId = Number(id);
  return <div className="page-stack"><Heading eyebrow="BUILD · PIPELINES · DETAIL" title={<>PIPELINE<br /><em>DETAIL.</em></>} description="The saved definition exactly as stored: source, ordered steps and destination." /><WorkspaceGate subject="Pipelines">{workspaceId => Number.isInteger(pipelineId) && pipelineId > 0 ? <DetailBody key={`${workspaceId}-${pipelineId}`} workspaceId={workspaceId} pipelineId={pipelineId} /> : <section className="panel"><StateMessage title="Invalid pipeline id" detail={`“${id}” is not a pipeline id.`} /></section>}</WorkspaceGate></div>;
}

// ---------------------------------------------------------------- editor

/** "Step 3: column …" → "Column …" for inline display next to the step itself. */
function sentence(message: string) {
  const text = message.replace(/^Step \d+: /, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type Draft = { operation: PipelineOperation; column: string; operator: (typeof FILTER_OPERATORS)[number]; value: string; renameTo: string; toType: (typeof DATATYPES)[number] };

function draftToStep(draft: Draft): TransformStep {
  if (draft.operation === "filter") return (VALUELESS_FILTER_OPERATORS as readonly string[]).includes(draft.operator) ? { operation: "filter", column: draft.column, operator: draft.operator } : { operation: "filter", column: draft.column, operator: draft.operator, value: draft.value };
  if (draft.operation === "rename_column") return { operation: "rename_column", from: draft.column, to: draft.renameTo.trim() };
  if (draft.operation === "change_datatype") return { operation: "change_datatype", column: draft.column, toType: draft.toType };
  if (draft.operation === "drop_column") return { operation: "drop_column", column: draft.column };
  return { operation: "remove_nulls", column: draft.column };
}

function EditorBody({ workspaceId, role, pipelineId }: { workspaceId: number; role: string | null; pipelineId?: number }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const datasets = trpc.dataset.list.useQuery({ workspaceId });
  const existing = trpc.pipeline.get.useQuery({ workspaceId, pipelineId: pipelineId ?? 0 }, { enabled: Boolean(pipelineId), retry: false });
  const usable = useMemo(() => (datasets.data ?? []).filter(item => item.persisted), [datasets.data]);

  const [initialised, setInitialised] = useState(!pipelineId);
  const [name, setName] = useState("");
  const [sourceId, setSourceId] = useState(0);
  const [destinationMode, setDestinationMode] = useState<DestinationMode>("new_dataset");
  const [destinationId, setDestinationId] = useState(0);
  const [steps, setSteps] = useState<TransformStep[]>([]);
  const [baseVersion, setBaseVersion] = useState("");
  const [serverError, setServerError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [draft, setDraft] = useState<Draft>({ operation: "filter", column: "", operator: "equals", value: "", renameTo: "", toType: "number" });

  const loadFrom = (data: NonNullable<typeof existing.data>) => {
    setName(data.name);
    setSourceId(data.sourceDatasetId ?? 0);
    setDestinationMode(data.destinationMode ?? "new_dataset");
    setDestinationId(data.destinationDatasetId ?? 0);
    setSteps(data.steps.map(({ id: _id, stepOrder: _order, ...step }) => step as TransformStep));
    setBaseVersion(data.version);
    setServerError(null);
    setInitialised(true);
  };
  useEffect(() => { if (existing.data && !initialised) loadFrom(existing.data); }, [existing.data, initialised]);
  useEffect(() => { if (initialised && !sourceId && usable.length) setSourceId(usable[0]!.id); }, [initialised, sourceId, usable]);

  const source = trpc.dataset.get.useQuery({ workspaceId, datasetId: sourceId }, { enabled: sourceId > 0, retry: false });
  const sample = trpc.dataset.rows.useQuery({ workspaceId, datasetId: sourceId, offset: 0, limit: PREVIEW_ROWS }, { enabled: source.isSuccess });
  const sourceColumns = useMemo(() => source.data?.columns.map(column => column.name) ?? [], [source.data]);
  const available = useMemo(() => columnsAfterSteps(steps, sourceColumns), [steps, sourceColumns]);
  useEffect(() => { if (available.length && !available.includes(draft.column) && !(draft.operation === "remove_nulls" && draft.column === "any")) setDraft(current => ({ ...current, column: available[0]! })); }, [available, draft.column, draft.operation]);

  const issues = useMemo(() => (source.isSuccess ? validatePipelineSteps(steps, sourceColumns) : []), [steps, sourceColumns, source.isSuccess]);
  const draftStep = draftToStep(draft);
  const draftIssue = source.isSuccess ? validatePipelineSteps([...steps, draftStep], sourceColumns).find(issue => issue.stepIndex === steps.length)?.message : undefined;
  const sampleRows = useMemo(() => (sample.data?.rows ?? []).map(row => row.data as Row), [sample.data]);
  const preview = useMemo(() => applyTransformSteps(sampleRows, steps.map(normalizeStep)), [sampleRows, steps]);
  const previewColumns = issues.length ? [] : columnsAfterSteps(steps, sourceColumns);

  const onSaved = async (saved: { id: number }) => {
    await Promise.all([utils.pipeline.list.invalidate(), utils.pipeline.get.invalidate(), utils.workspace.views.invalidate()]);
    toast.success(pipelineId ? "Pipeline updated" : "Pipeline saved", { description: "The definition and its ordered steps are stored in the database." });
    setLocation(`/pipelines/${saved.id}`);
  };
  const onFailed = (error: { message: string; data?: { code?: string } | null }) => setServerError({ message: error.message, conflict: error.data?.code === "CONFLICT" && Boolean(pipelineId) && /changed by someone else/.test(error.message) });
  const create = trpc.pipeline.create.useMutation({ onSuccess: onSaved, onError: onFailed });
  const update = trpc.pipeline.update.useMutation({ onSuccess: onSaved, onError: onFailed });
  const saving = create.isPending || update.isPending;
  // Phase 4: submit the CURRENT editor state as a change; the server computes and stores the risk analysis.
  const [analysis, setAnalysis] = useState<{ changeId: number; key: string; result: ChangeRiskResult } | null>(null);
  const definitionKey = JSON.stringify([name.trim(), sourceId, destinationMode, destinationMode === "overwrite_existing" ? destinationId : null, steps]);
  const analyze = trpc.changeIntelligence.analyzePipelineChange.useMutation({
    onSuccess: async (out, variables) => { setAnalysis({ changeId: out.changeId, key: JSON.stringify([variables.definition.name, variables.definition.sourceDatasetId, variables.definition.destinationMode, variables.definition.destinationDatasetId ?? null, steps]), result: out.result }); await Promise.all([utils.changeIntelligence.changes.invalidate(), utils.changeIntelligence.riskAnalyses.invalidate()]); },
    onError: error => { setAnalysis(null); toast.error("Risk analysis failed; nothing was stored", { description: error.message }); },
  });

  if (datasets.isLoading || (pipelineId && existing.isLoading)) return <div className="workspace-loading"><span>LOADING…</span></div>;
  if (existing.error) return <section className="panel"><StateMessage title={existing.error.data?.code === "NOT_FOUND" ? "Pipeline not found" : "Pipeline unavailable"} detail={existing.error.message} /></section>;
  if (datasets.error) return <section className="panel"><StateMessage title="Datasets unavailable" detail={datasets.error.message} /></section>;
  if (!canEditPipelines(role) || (existing.data && !existing.data.editable)) return <section className="panel"><StateMessage title="Read-only" detail={existing.data?.legacy ? "Legacy pipelines are read-only." : "Only workspace owners, admins and developers can create or edit pipelines."} /></section>;
  if (!usable.length) return <section className="panel"><StateMessage title="No datasets to build from" detail="A pipeline reads from a dataset stored in this workspace. Import a CSV first." action={<Button className="button-red" onClick={() => setLocation("/datasets/import")}>IMPORT CSV</Button>} /></section>;

  const destinations = usable.filter(item => item.id !== sourceId);
  const destinationMissing = destinationMode === "overwrite_existing" && !destinations.some(item => item.id === destinationId);
  const canSave = initialised && name.trim().length >= 3 && sourceId > 0 && source.isSuccess && !issues.length && !destinationMissing && !saving;
  const save = () => {
    setServerError(null);
    const definition = { workspaceId, name: name.trim(), sourceDatasetId: sourceId, destinationMode, destinationDatasetId: destinationMode === "overwrite_existing" ? destinationId : null, steps: steps.map(normalizeStep) };
    if (pipelineId) update.mutate({ ...definition, pipelineId, baseVersion });
    else create.mutate(definition);
  };
  const move = (index: number, direction: -1 | 1) => setSteps(current => { const target = index + direction; if (target < 0 || target >= current.length) return current; const next = [...current]; [next[index], next[target]] = [next[target]!, next[index]!]; return next; });
  const columnChoices = draft.operation === "remove_nulls" ? ["any", ...available] : available;

  return <>
    <section className="pipeline-flow">
      <article><Database size={20} /><p>SOURCE</p><h3>{source.data?.name ?? "Select dataset"}</h3><select aria-label="Source dataset" value={sourceId} onChange={event => setSourceId(Number(event.target.value))}>{usable.map(item => <option key={item.id} value={item.id}>{item.name} · {item.rowCount.toLocaleString()} rows</option>)}</select>{source.data ? <span className="module-meta">{source.data.columns.length} COLUMNS · {source.data.rowCount.toLocaleString()} ROWS</span> : null}</article>
      <ArrowRight />
      <article><RefreshCw size={20} /><p>ADD STEP</p>
        <select aria-label="Step operation" value={draft.operation} onChange={event => setDraft(current => ({ ...current, operation: event.target.value as PipelineOperation }))}>{(Object.keys(OPERATION_LABELS) as PipelineOperation[]).map(operation => <option key={operation} value={operation}>{OPERATION_LABELS[operation]}</option>)}</select>
        <select aria-label="Step column" value={draft.column} onChange={event => setDraft(current => ({ ...current, column: event.target.value }))}>{columnChoices.map(column => <option key={column} value={column}>{column === "any" ? "any column" : column}</option>)}</select>
        {draft.operation === "filter" ? <select aria-label="Filter operator" value={draft.operator} onChange={event => setDraft(current => ({ ...current, operator: event.target.value as Draft["operator"] }))}>{FILTER_OPERATORS.map(operator => <option key={operator} value={operator}>{operator.replace(/_/g, " ")}</option>)}</select> : null}
        {draft.operation === "filter" && !(VALUELESS_FILTER_OPERATORS as readonly string[]).includes(draft.operator) ? <Input aria-label="Filter value" value={draft.value} onChange={event => setDraft(current => ({ ...current, value: event.target.value }))} placeholder="Value" maxLength={PIPELINE_LIMITS.maxValue} /> : null}
        {draft.operation === "rename_column" ? <Input aria-label="New column name" value={draft.renameTo} onChange={event => setDraft(current => ({ ...current, renameTo: event.target.value }))} placeholder="New column name" maxLength={PIPELINE_LIMITS.maxIdentifier} /> : null}
        {draft.operation === "change_datatype" ? <select aria-label="Target datatype" value={draft.toType} onChange={event => setDraft(current => ({ ...current, toType: event.target.value as Draft["toType"] }))}>{DATATYPES.map(type => <option key={type} value={type}>{type}</option>)}</select> : null}
        {draftIssue && !/needs a value|enter the new column name/.test(draftIssue) ? <small className="form-error">{sentence(draftIssue)}</small> : null}
        <Button variant="outline" disabled={Boolean(draftIssue) || !draft.column || steps.length >= PIPELINE_LIMITS.maxSteps} onClick={() => { setSteps(current => [...current, draftStep]); setDraft(current => ({ ...current, value: "", renameTo: "" })); }}><Plus size={13} /> ADD STEP</Button>
      </article>
      <ArrowRight />
      <article><Database size={20} /><p>DESTINATION</p><select aria-label="Destination mode" value={destinationMode} onChange={event => setDestinationMode(event.target.value as DestinationMode)}><option value="new_dataset">New dataset</option><option value="overwrite_existing" disabled={!destinations.length}>Overwrite existing dataset</option></select>{destinationMode === "overwrite_existing" ? <select aria-label="Destination dataset" value={destinationId} onChange={event => setDestinationId(Number(event.target.value))}><option value={0}>Choose dataset…</option>{destinations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select> : <span className="module-meta">CREATED ON FIRST RUN</span>}</article>
    </section>
    <section className="split-grid">
      <section className="panel"><p className="eyebrow">ORDERED STEPS</p><h2>{steps.length} CONFIGURED</h2>
        {steps.length ? <div className="history-list">{steps.map((step, index) => { const stepIssues = issues.filter(issue => issue.stepIndex === index); return <div key={`${index}-${step.operation}`}><span><b>{String(index + 1).padStart(2, "0")} · {describeStep(step)}</b><small className={stepIssues.length ? "form-error" : undefined}>{stepIssues.length ? stepIssues.map(issue => sentence(issue.message)).join(" ") : step.operation}</small></span><span className="step-actions"><Button variant="outline" aria-label={`Move step ${index + 1} up`} onClick={() => move(index, -1)} disabled={index === 0}><ArrowUp size={13} /></Button><Button variant="outline" aria-label={`Move step ${index + 1} down`} onClick={() => move(index, 1)} disabled={index === steps.length - 1}><ArrowDown size={13} /></Button><Button variant="outline" aria-label={`Remove step ${index + 1}`} onClick={() => setSteps(current => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={13} /></Button></span></div>; })}</div> : <p className="panel-copy">No steps yet: the pipeline would copy the source unchanged. Column pickers only offer columns that exist at that point, after earlier renames and drops.</p>}
      </section>
      <section className="panel"><p className="eyebrow">{pipelineId ? "EDIT DEFINITION" : "NEW DEFINITION"}</p><h2>SAVE PIPELINE</h2><div className="workspace-form"><div><label htmlFor="pipeline-name">PIPELINE NAME</label><Input id="pipeline-name" value={name} onChange={event => setName(event.target.value)} placeholder="active customers" maxLength={PIPELINE_LIMITS.maxName} /></div>
        {issues.length ? <p className="form-error" role="alert">Fix {issues.length} step issue{issues.length === 1 ? "" : "s"} before saving (for example after changing the source dataset).</p> : null}
        {destinationMissing ? <p className="form-error">Choose the dataset to overwrite.</p> : null}
        {serverError ? <p className="form-error" role="alert">{serverError.message}</p> : null}
        {serverError?.conflict ? <Button variant="outline" onClick={() => void existing.refetch().then(result => result.data && loadFrom(result.data))}><RefreshCw size={13} /> RELOAD LATEST (DISCARDS YOUR EDITS)</Button> : null}
        <Button className="button-red" disabled={!canSave} onClick={save}>{saving ? <><Loader2 size={14} className="spin" /> SAVING</> : <><Save size={14} /> {pipelineId ? "SAVE CHANGES" : "SAVE PIPELINE"}</>}</Button></div>
        <Button variant="outline" disabled={!canSave || analyze.isPending} onClick={() => analyze.mutate({ workspaceId, pipelineId: pipelineId ?? null, baseVersion: pipelineId ? baseVersion : null, definition: { name: name.trim(), sourceDatasetId: sourceId, destinationMode, destinationDatasetId: destinationMode === "overwrite_existing" ? destinationId : null, steps: steps.map(normalizeStep) } })}>{analyze.isPending ? <><Loader2 size={14} className="spin" /> ANALYSING</> : <><ShieldAlert size={14} /> ANALYZE RISK</>}</Button>
        <p className="panel-copy">Saving stores the definition and each step, in order, in the database. It does not run the pipeline; run it from its detail page. ANALYZE RISK records this proposal as a change and scores it against your stored data before you save.</p>
      </section>
    </section>
    {analysis ? <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">CHANGE #{analysis.changeId} · RISK ANALYSIS (STORED)</p><h2>{analysis.result.level} · {analysis.result.score}/100</h2></div><a className="button-link" href={`/changes/${analysis.changeId}`} target="_blank" rel="noreferrer"><ArrowUpRight size={13} /> OPEN FULL ANALYSIS</a></div>{analysis.key !== definitionKey ? <p className="form-error" role="alert">You have edited the pipeline since this analysis. Analyse again before relying on it.</p> : null}<RiskResultView result={analysis.result} compact /></section> : null}
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">PREVIEW · NOT A RUN</p><h2>{issues.length ? "PREVIEW PAUSED" : `${preview.rows.length} OF ${sampleRows.length} SAMPLE ROWS OUT`}</h2></div><span className="module-meta">FIRST {Math.min(PREVIEW_ROWS, source.data?.rowCount ?? 0).toLocaleString()} STORED ROWS · SAME ENGINE AS EXECUTION</span></div>
      {issues.length ? <p className="panel-copy">Fix the step issues above to see the preview.</p> : sample.isLoading ? <div className="workspace-loading"><span>LOADING SAMPLE…</span></div> : <><p className="panel-copy">{preview.effects.join(" · ") || "Pass-through copy"}{preview.coercionFailures ? ` · ${preview.coercionFailures} coercion failures` : ""}</p>{preview.rows.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr>{previewColumns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{preview.rows.slice(0, 10).map((row, index) => <tr key={index}>{previewColumns.map(column => <td key={column}>{row[column] === null || row[column] === undefined ? "∅" : String(row[column])}</td>)}</tr>)}</tbody></table></div> : <p className="panel-copy">No sample rows survive these steps.</p>}</>}
    </section>
  </>;
}

export function PipelineEditor({ pipelineId }: { pipelineId?: number }) {
  const editing = Boolean(pipelineId);
  return <div className="page-stack"><Heading eyebrow={editing ? "BUILD · PIPELINES · EDIT" : "BUILD · PIPELINES · NEW"} title={editing ? <>EDIT<br /><em>PIPELINE.</em></> : <>PIPELINE<br /><em>BUILDER.</em></>} description="Source → ordered transformation steps → destination, validated against the stored dataset and saved to the database." /><WorkspaceGate subject="Pipelines">{(workspaceId, role) => <EditorBody key={`${workspaceId}-${pipelineId ?? "new"}`} workspaceId={workspaceId} role={role} pipelineId={pipelineId} />}</WorkspaceGate></div>;
}
