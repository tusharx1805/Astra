import { Button } from "@/components/ui/button";
import { ModuleSubnav, type ModuleTab } from "@/components/ModuleSubnav";
import { PersistedBadge, StateMessage, WorkspaceGate } from "@/components/DatasetModules";
import { AiBriefPanel } from "@/components/AiModules";
import { canEditPipelines } from "@/hooks/useActiveWorkspace";
import { trpc } from "@/lib/trpc";
import type { ChangeRiskResult, PipelineDefinitionSnapshot, RiskLevel } from "../../../shared/changeRisk";
import { describeStep } from "../../../shared/pipelineDefinition";
import { ArrowUpRight, Ban, CheckCircle2, Loader2, MessageSquareWarning, RefreshCw, ShieldCheck } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { REVIEW_COMMENT_MAX, reviewPolicyViolation, type ReviewDecision } from "../../../shared/review";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

/**
 * Phase 4 — persisted change intelligence. Everything here is read from the
 * changes + risk_analyses tables. Results come from the server-side
 * pipeline-impact engine; the UI never computes or invents a risk result.
 * The old free-text SQL analyser lives on, clearly labelled, at /changes/sandbox.
 */

export const CHANGE_TABS: ModuleTab[] = [
  { label: "CHANGES", href: "/changes" },
  { label: "ANALYSIS HISTORY", href: "/changes/history" },
  { label: "REVIEWS", href: "/changes/reviews" },
  { label: "SIMULATED SANDBOX", href: "/changes/sandbox" },
];
const RISK_TABS: ModuleTab[] = [{ label: "ACTIVE", href: "/risk-analysis" }, { label: "HISTORY", href: "/risk-analysis/history" }];

export function reviewStatusClass(status: string) {
  if (status === "APPROVED") return "status status--green";
  if (status === "BLOCKED") return "status status--red";
  if (status === "CHANGES_REQUESTED" || status === "RE-REVIEW NEEDED") return "status status--yellow";
  return "status status--blue";
}

const decisionLabel = (value: string) => value.replace(/_/g, " ");

export function levelClass(level: string) {
  if (level === "CRITICAL") return "status status--red";
  if (level === "HIGH") return "status status--yellow";
  if (level === "MEDIUM") return "status status--blue";
  return "status status--green";
}

const when = (value: Date | string) => new Date(value).toLocaleString();

function Heading({ eyebrow, title, description, tabs, action }: { eyebrow: string; title: React.ReactNode; description: string; tabs: ModuleTab[]; action?: React.ReactNode }) {
  return <><section className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</section><ModuleSubnav tabs={tabs} /></>;
}

/** The persisted result, in the existing risk layout (score, factors, explanation, blast radius). */
export function RiskResultView({ result, compact = false }: { result: ChangeRiskResult; compact?: boolean }) {
  const [, setLocation] = useLocation();
  const visible = compact ? result.factors.slice(0, 4) : result.factors;
  return <>
    <section className="split-grid">
      <section className="panel risk-result">
        <div className="workspace-section-head"><div><p className="eyebrow">{result.engineVersion}</p></div><PersistedBadge /></div>
        <div className="score-block"><span>RISK SCORE</span><strong>{result.score}</strong><em>/100</em><b className={levelClass(result.level)}>{result.level}</b></div>
        <p className="risk-summary">{result.summary}</p>
        <div className="factor-bars">{visible.map(factor => <div key={factor.code + factor.label}><p><span>{factor.label}</span><b>+{factor.weight}</b></p><i className={factor.tone} style={{ width: `${Math.max(2, factor.weight)}%` }} /><small className="factor-evidence">{factor.evidence}</small></div>)}</div>
      </section>
      {compact ? null : <section className="panel"><p className="eyebrow">ANALYSIS STEPS · COMPUTED</p><ol className="stage-list">{result.analysisStages.map((stage, index) => <li key={stage.label}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{stage.label}</b><small>{stage.detail}</small></div><ShieldCheck size={15} /></li>)}</ol></section>}
    </section>
    {compact ? null : <section className="split-grid">
      <section className="panel"><p className="eyebrow">WHY ASTRA FLAGS THIS</p><h2>EXPLANATION</h2><ol className="numbered-explanation">{result.explanation.map((text, index) => <li key={index}><span>{index + 1}</span><p>{text}</p></li>)}</ol></section>
      <section className="panel"><p className="eyebrow">IMPACT SURFACE · REAL ENTITIES</p><h2>BLAST RADIUS</h2><div className="entity-grid">{result.affectedEntities.map(entity => <button type="button" key={`${entity.type}-${entity.id}`} className="entity-card" onClick={() => setLocation(entity.type === "dataset" ? `/datasets/${entity.id}` : `/pipelines/${entity.id}`)}><span>{entity.type.toUpperCase()}</span><b>{entity.name}</b><small>{entity.owner}</small><span className={levelClass(entity.severity)}>{entity.severity}</span></button>)}</div></section>
    </section>}
  </>;
}

// ---------------------------------------------------------------- change list

function ChangesBody({ workspaceId }: { workspaceId: number }) {
  const [, setLocation] = useLocation();
  const list = trpc.changeIntelligence.changes.useQuery({ workspaceId });
  if (list.isLoading) return <div className="workspace-loading"><span>LOADING CHANGES…</span></div>;
  if (list.error) return <section className="panel"><StateMessage title="Changes unavailable" detail={list.error.message} /></section>;
  const rows = list.data ?? [];
  return <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">CHANGES · DATABASE</p><h2>{rows.length} CHANGES</h2></div><PersistedBadge /></div>
    {rows.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>CHANGE</th><th>TITLE</th><th>PIPELINE</th><th>AUTHOR</th><th>LATEST RISK</th><th>REVIEW</th><th>ANALYSES</th><th>SUBMITTED</th><th>OPEN</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className="table-row-clickable" onClick={() => setLocation(`/changes/${row.id}`)}><td><span className="table-name">#{row.id}</span></td><td>{row.title}</td><td>{row.pipelineName ?? (row.pipelineId ? "Deleted" : "New pipeline")}</td><td>{row.author}</td><td>{row.latest ? <span className={levelClass(row.latest.level)}>{row.latest.level} · {row.latest.score}</span> : "—"}</td><td><span className={reviewStatusClass(row.reviewStatus)}>{decisionLabel(row.reviewStatus)}</span></td><td>{row.analysisCount}</td><td>{when(row.createdAt)}</td><td><ArrowUpRight size={14} /></td></tr>)}</tbody></table></div>
      : <StateMessage title="No changes yet" detail="Open a pipeline, edit it (or build a new one) and click ANALYZE RISK. The proposal and its risk analysis are stored here." action={<Button className="button-red" onClick={() => setLocation("/pipelines")}>OPEN PIPELINES</Button>} />}
  </section>;
}

export function ChangeIntelligencePage() {
  return <div className="page-stack"><Heading eyebrow="INTELLIGENCE · CHANGE INTELLIGENCE" title={<>CHANGE<br /><em>INTELLIGENCE.</em></>} description="Every proposed pipeline change and its risk analysis, computed on the server from your stored data and kept in the database." tabs={CHANGE_TABS} /><WorkspaceGate subject="Changes">{workspaceId => <ChangesBody key={workspaceId} workspaceId={workspaceId} />}</WorkspaceGate></div>;
}

// ---------------------------------------------------------------- analyses (history / risk lists)

function AnalysesBody({ workspaceId, scope }: { workspaceId: number; scope: "active" | "all" }) {
  const [, setLocation] = useLocation();
  const list = trpc.changeIntelligence.riskAnalyses.useQuery({ workspaceId, scope });
  if (list.isLoading) return <div className="workspace-loading"><span>LOADING ANALYSES…</span></div>;
  if (list.error) return <section className="panel"><StateMessage title="Analyses unavailable" detail={list.error.message} /></section>;
  const rows = list.data ?? [];
  return <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">RISK_ANALYSES · {scope === "active" ? "LATEST PER CHANGE, NOT SAFE" : "ALL"}</p><h2>{rows.length} ANALYSES</h2></div><PersistedBadge /></div>
    {rows.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>ANALYSIS</th><th>CHANGE</th><th>SCORE</th><th>LEVEL</th><th>ENGINE</th><th>ANALYSED</th><th>OPEN</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className="table-row-clickable" onClick={() => setLocation(`/changes/${row.changeId}?analysis=${row.id}`)}><td><span className="table-name">#{row.id}</span></td><td>#{row.changeId} · {row.title}</td><td><b>{row.score}/100</b></td><td><span className={levelClass(row.level)}>{row.level}</span></td><td>{row.engineVersion}</td><td>{when(row.createdAt)}</td><td><ArrowUpRight size={14} /></td></tr>)}</tbody></table></div>
      : <StateMessage title={scope === "active" ? "No active risks" : "No analyses yet"} detail={scope === "active" ? "Every change's latest analysis is SAFE, or nothing has been analysed yet." : "Analyse a pipeline change from the pipeline editor to create the first record."} />}
  </section>;
}

export function AnalysisHistoryPage() {
  return <div className="page-stack"><Heading eyebrow="INTELLIGENCE · ANALYSIS HISTORY" title={<>ANALYSIS<br /><em>HISTORY.</em></>} description="Every stored risk analysis, newest first. Re-analysing a change adds a new row; old results are never overwritten." tabs={CHANGE_TABS} /><WorkspaceGate subject="Risk analyses">{workspaceId => <AnalysesBody key={workspaceId} workspaceId={workspaceId} scope="all" />}</WorkspaceGate></div>;
}

export function RiskAnalysisPage({ history = false }: { history?: boolean }) {
  return <div className="page-stack"><Heading eyebrow="INTELLIGENCE · RISK ANALYSIS" title={history ? <>RISK<br /><em>HISTORY.</em></> : <>ACTIVE<br /><em>RISKS.</em></>} description={history ? "All stored analyses in the active workspace." : "Changes whose latest analysis is MEDIUM, HIGH or CRITICAL."} tabs={RISK_TABS} /><WorkspaceGate subject="Risk analyses">{workspaceId => <AnalysesBody key={`${workspaceId}-${history}`} workspaceId={workspaceId} scope={history ? "all" : "active"} />}</WorkspaceGate></div>;
}

// ---------------------------------------------------------------- change detail

function DefinitionColumn({ label, definition, names }: { label: string; definition: PipelineDefinitionSnapshot | null; names: Record<number, string> }) {
  return <section className="panel"><p className="eyebrow">{label}</p>{definition ? <><h2>{definition.name}</h2><p className="panel-copy">Source: {names[definition.sourceDatasetId] ?? `dataset #${definition.sourceDatasetId}`} · Destination: {definition.destinationMode === "overwrite_existing" ? `overwrite ${definition.destinationDatasetId ? names[definition.destinationDatasetId] ?? `dataset #${definition.destinationDatasetId}` : "?"}` : "new dataset per run"}</p>{definition.steps.length ? <div className="history-list">{definition.steps.map((step, index) => <div key={index}><span><b>{String(index + 1).padStart(2, "0")} · {describeStep(step)}</b><small>{step.operation}</small></span></div>)}</div> : <p className="panel-copy">No steps.</p>}</> : <><h2>—</h2><p className="panel-copy">New pipeline: nothing exists yet.</p></>}</section>;
}

function ChangeBody({ workspaceId, changeId, role }: { workspaceId: number; changeId: number; role: string | null }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const detail = trpc.changeIntelligence.change.useQuery({ workspaceId, changeId }, { retry: false });
  const [selected, setSelected] = useState<number | null>(() => Number(new URLSearchParams(window.location.search).get("analysis")) || null);
  const reanalyze = trpc.changeIntelligence.reanalyze.useMutation({
    onSuccess: async out => { await Promise.all([utils.changeIntelligence.change.invalidate(), utils.changeIntelligence.changes.invalidate(), utils.changeIntelligence.riskAnalyses.invalidate()]); setSelected(out.analysisId); toast.success(`Re-analysed: ${out.result.level} ${out.result.score}/100`, { description: "Stored as a new analysis computed from today's data." }); },
    onError: error => toast.error("Re-analysis failed; nothing was stored", { description: error.message }),
  });
  if (detail.isLoading) return <div className="workspace-loading"><span>LOADING CHANGE…</span></div>;
  if (detail.error) return <section className="panel"><StateMessage title={detail.error.data?.code === "NOT_FOUND" ? "Change not found" : "Change unavailable"} detail={detail.error.message} /></section>;
  const change = detail.data!;
  const analysis = change.analyses.find(item => item.id === selected) ?? change.analyses[0];
  return <>
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">CHANGES · #{change.id} · {change.changeType}</p><h2>{change.title}</h2></div><PersistedBadge /></div>
      <div className="detail-grid"><div><span>SUBMITTED BY</span><b>{change.author}</b></div><div><span>SUBMITTED</span><b>{when(change.createdAt)}</b></div><div><span>ANALYSES</span><b>{change.analyses.length}</b></div><div><span>PIPELINE NOW</span><b>{change.pipeline ? (change.pipeline.matchesProposal ? "Matches this proposal (saved)" : "Differs from this proposal") : change.pipelineId ? "Deleted" : "Not created from this proposal"}</b></div></div>
      <div className="step-actions">{change.pipeline ? <Button variant="outline" onClick={() => setLocation(`/pipelines/${change.pipeline!.id}`)}><ArrowUpRight size={13} /> OPEN PIPELINE</Button> : null}{canEditPipelines(role) && change.rawSourceIsPipelineChange ? <Button className="button-red" disabled={reanalyze.isPending} onClick={() => reanalyze.mutate({ workspaceId, changeId })}>{reanalyze.isPending ? <><Loader2 size={13} className="spin" /> ANALYSING</> : <><RefreshCw size={13} /> RE-ANALYSE WITH TODAY'S DATA</>}</Button> : null}</div>
    </section>
    <ReviewPanel workspaceId={workspaceId} change={change} viewingAnalysisId={analysis?.id ?? null} />
    <AiBriefPanel workspaceId={workspaceId} changeId={change.id} analysisId={analysis?.id ?? null} latestAnalysisId={change.analyses[0]?.id ?? null} />
    {change.source ? <section className="split-grid"><DefinitionColumn label="BEFORE · STORED AT SUBMISSION" definition={change.source.current} names={change.datasetNames} /><DefinitionColumn label="PROPOSED" definition={change.source.proposed} names={change.datasetNames} /></section> : <section className="panel"><StateMessage title="Unrecognised change input" detail="This record was not created by the pipeline analysis path." /></section>}
    {change.analyses.length > 1 ? <section className="panel"><p className="eyebrow">ANALYSES OF THIS CHANGE</p><div className="chip-row">{change.analyses.map(item => <button key={item.id} className={item.id === analysis?.id ? "chip chip--active" : "chip"} onClick={() => setSelected(item.id)}>#{item.id} · {item.level} {item.score} · {new Date(item.createdAt).toLocaleString()}</button>)}</div></section> : null}
    {analysis ? <><section className="panel"><p className="eyebrow">ANALYSIS #{analysis.id} · {when(analysis.createdAt)} · INPUT: {analysis.result.inputs.sourceDatasetName} ({analysis.result.inputs.sourceRowCount} rows)</p></section><RiskResultView result={analysis.result} /></> : <section className="panel"><StateMessage title="No analysis stored" detail="This change has no analysis record." /></section>}
  </>;
}

type ChangeData = inferRouterOutputs<AppRouter>["changeIntelligence"]["change"];

/** Phase 5: decisions are written to the reviews table and history is read back from it. */
function ReviewPanel({ workspaceId, change, viewingAnalysisId }: { workspaceId: number; change: ChangeData; viewingAnalysisId: number | null }) {
  const utils = trpc.useUtils();
  const [comment, setComment] = useState("");
  const latest = change.analyses[0] ?? null;
  const record = trpc.changeIntelligence.recordReview.useMutation({
    onSuccess: async review => {
      await Promise.all([utils.changeIntelligence.change.invalidate(), utils.changeIntelligence.changes.invalidate(), utils.changeIntelligence.reviews.invalidate()]);
      setComment("");
      toast.success(`${decisionLabel(review.decision)} recorded`, { description: `Saved as review #${review.id} against analysis #${review.reviewedAnalysisId}.` });
    },
    onError: error => toast.error("Decision not recorded", { description: error.message }),
  });
  const decide = (decision: ReviewDecision) => { if (latest) record.mutate({ workspaceId, changeId: change.id, analysisId: latest.id, decision, comment: comment.trim() || null }); };
  const blocked = (decision: ReviewDecision) => latest ? reviewPolicyViolation({ decision, isAuthor: change.isAuthor, level: latest.level, comment, allowSelfApproval: change.allowSelfApproval }) : "No analysis to review.";
  const approveBlockedReason = change.isAuthor && !change.allowSelfApproval ? blocked("APPROVED") : null;
  return <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">REVIEWS · DATABASE</p><h2>REVIEW DECISION</h2></div><span className={reviewStatusClass(change.reviewStatus)}>{decisionLabel(change.reviewStatus)}</span></div>
    {change.reviewStatus === "RE-REVIEW NEEDED" ? <p className="form-error" role="alert">The latest decision was made against an older analysis. This change has been re-analysed since, so it needs a new decision.</p> : null}
    {change.canReview && latest ? <div className="workspace-form">
      {viewingAnalysisId && viewingAnalysisId !== latest.id ? <p className="panel-copy">You are viewing an older analysis. Decisions always apply to the latest one: #{latest.id} ({latest.level} {latest.score}).</p> : <p className="panel-copy">Your decision applies to analysis #{latest.id} ({latest.level} {latest.score}/100).</p>}
      <div><label htmlFor="review-comment">COMMENT {latest.level === "HIGH" || latest.level === "CRITICAL" ? "(REQUIRED)" : "(REQUIRED TO BLOCK OR REQUEST CHANGES)"}</label><Textarea id="review-comment" value={comment} maxLength={REVIEW_COMMENT_MAX} onChange={event => setComment(event.target.value)} placeholder="Why are you approving, blocking or requesting changes?" /></div>
      <div className="step-actions">
        <Button variant="outline" disabled={record.isPending || Boolean(blocked("APPROVED"))} title={blocked("APPROVED") ?? undefined} onClick={() => decide("APPROVED")}><CheckCircle2 size={14} /> APPROVE</Button>
        <Button variant="outline" disabled={record.isPending || Boolean(blocked("CHANGES_REQUESTED"))} title={blocked("CHANGES_REQUESTED") ?? undefined} onClick={() => decide("CHANGES_REQUESTED")}><MessageSquareWarning size={14} /> REQUEST CHANGES</Button>
        <Button className="button-red" disabled={record.isPending || Boolean(blocked("BLOCKED"))} title={blocked("BLOCKED") ?? undefined} onClick={() => decide("BLOCKED")}><Ban size={14} /> BLOCK</Button>
      </div>
      {approveBlockedReason ? <p className="panel-copy">{approveBlockedReason}</p> : null}
    </div> : <p className="panel-copy">{latest ? "Only the workspace owner, admins and reviewers can record decisions. You can read the history below." : "This change has no analysis to review."}</p>}
    {change.reviews.length ? <div className="history-list">{change.reviews.map(review => <div key={review.id}><span><b><span className={reviewStatusClass(review.decision)}>{decisionLabel(review.decision)}</span> · {review.reviewer}</b><small>REVIEW #{review.id} · {when(review.createdAt)} · AGAINST ANALYSIS #{review.reviewedAnalysisId ?? "?"}{review.reviewedLevel ? ` (${review.reviewedLevel} ${review.reviewedScore})` : ""}{latest && review.reviewedAnalysisId !== latest.id ? " · OUTDATED" : ""}</small>{review.comment ? <small>“{review.comment}”</small> : null}</span></div>)}</div> : <p className="panel-copy">No decisions recorded yet.</p>}
  </section>;
}

function ReviewsBody({ workspaceId }: { workspaceId: number }) {
  const [, setLocation] = useLocation();
  const list = trpc.changeIntelligence.reviews.useQuery({ workspaceId });
  if (list.isLoading) return <div className="workspace-loading"><span>LOADING REVIEWS…</span></div>;
  if (list.error) return <section className="panel"><StateMessage title="Reviews unavailable" detail={list.error.message} /></section>;
  const rows = list.data ?? [];
  return <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">REVIEWS · DATABASE</p><h2>{rows.length} DECISIONS</h2></div><PersistedBadge /></div>
    {rows.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>REVIEW</th><th>DECISION</th><th>CHANGE</th><th>REVIEWER</th><th>AGAINST ANALYSIS</th><th>COMMENT</th><th>WHEN</th></tr></thead><tbody>{rows.map(review => <tr key={review.id} className="table-row-clickable" onClick={() => setLocation(`/changes/${review.changeId}`)}><td><span className="table-name">#{review.id}</span></td><td><span className={reviewStatusClass(review.decision)}>{decisionLabel(review.decision)}</span></td><td>#{review.changeId} · {review.changeTitle}</td><td>{review.reviewer}</td><td>{review.reviewedAnalysisId ? `#${review.reviewedAnalysisId} · ${review.reviewedLevel} ${review.reviewedScore}` : "—"}</td><td>{review.comment ?? "—"}</td><td>{when(review.createdAt)}</td></tr>)}</tbody></table></div>
      : <StateMessage title="No decisions yet" detail="Open a change and approve, block or request changes. Every decision is stored here." />}
  </section>;
}

export function ReviewsPage() {
  return <div className="page-stack"><Heading eyebrow="INTELLIGENCE · REVIEWS" title={<>REVIEW<br /><em>DECISIONS.</em></>} description="Every approval, block and change request in the active workspace, read from the reviews table." tabs={CHANGE_TABS} /><WorkspaceGate subject="Reviews">{workspaceId => <ReviewsBody key={workspaceId} workspaceId={workspaceId} />}</WorkspaceGate></div>;
}

export function ChangeDetailPage({ id }: { id: string }) {
  const changeId = Number(id);
  return <div className="page-stack"><Heading eyebrow="INTELLIGENCE · CHANGE · DETAIL" title={<>CHANGE<br /><em>DETAIL.</em></>} description="The stored proposal, what it was compared against, and every risk analysis computed for it." tabs={CHANGE_TABS} /><WorkspaceGate subject="Changes">{(workspaceId, role) => Number.isInteger(changeId) && changeId > 0 ? <ChangeBody key={`${workspaceId}-${changeId}`} workspaceId={workspaceId} changeId={changeId} role={role} /> : <section className="panel"><StateMessage title="Invalid change id" detail={`“${id}” is not a change id.`} /></section>}</WorkspaceGate></div>;
}

export type { RiskLevel };
