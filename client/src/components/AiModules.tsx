import { Button } from "@/components/ui/button";
import { StateMessage, WorkspaceGate } from "@/components/DatasetModules";
import { trpc } from "@/lib/trpc";
import { SUGGESTION_LABEL, type AiSuggestion } from "../../../shared/aiBrief";
import { ArrowUpRight, Bot, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

/**
 * Phase 10 — the AI review brief. Advisory only: it explains a STORED analysis.
 * Model calls happen on the server; the browser never sees an API key.
 */

const when = (value: Date | string) => new Date(value).toLocaleString();
const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const suggestionClass = (value: AiSuggestion) => (value === "block" ? "status status--red" : value === "approve" ? "status status--green" : "status status--yellow");

export function AiBriefPanel({ workspaceId, changeId, analysisId, latestAnalysisId }: { workspaceId: number; changeId: number; analysisId: number | null; latestAnalysisId: number | null }) {
  const status = trpc.ai.status.useQuery({ workspaceId }, { retry: false });
  const list = trpc.ai.changeBriefs.useQuery({ workspaceId, changeId }, { retry: false });
  const [showContext, setShowContext] = useState(false);
  const utils = trpc.useUtils();
  const generate = trpc.ai.generateBrief.useMutation({
    onSuccess: out => { utils.ai.changeBriefs.invalidate({ workspaceId, changeId }); utils.ai.status.invalidate({ workspaceId }); utils.ai.activity.invalidate({ workspaceId }); toast.success(out.cached ? "Showing the stored brief for this analysis" : "AI brief generated", { description: out.cached ? "No new model call was needed." : `${out.brief.model} · ${secs(out.brief.latencyMs)}` }); },
    onError: error => { utils.ai.status.invalidate({ workspaceId }); toast.error("No brief generated", { description: error.message }); },
  });
  if (status.isLoading || list.isLoading) return <section className="panel"><p className="eyebrow">AI REVIEW BRIEF</p><div className="workspace-loading ai-loading"><span>LOADING…</span></div></section>;
  if (status.error) return null;
  const ai = status.data!;
  const briefs = list.data?.briefs ?? [];
  const brief = briefs.find(item => item.analysisId === analysisId) ?? null;
  const olderForOther = !brief && briefs.length > 0;
  const canRun = ai.enabled && ai.migrationApplied && ai.canGenerate && analysisId !== null;
  const button = (regenerate: boolean) => <Button className={regenerate ? undefined : "button-red"} variant={regenerate ? "outline" : "default"} disabled={!canRun || generate.isPending} onClick={() => generate.mutate({ workspaceId, changeId, analysisId: analysisId ?? undefined, regenerate })}>{generate.isPending ? <><Loader2 size={13} className="spin" /> ASKING THE MODEL…</> : regenerate ? <><RefreshCw size={13} /> REGENERATE</> : <><Sparkles size={13} /> GENERATE AI BRIEF</>}</Button>;
  return <section className="panel ai-brief" data-testid="ai-brief">
    <div className="workspace-section-head"><div><p className="eyebrow">AI REVIEW BRIEF · ADVISORY · ANALYSIS #{analysisId ?? "—"}</p><h2>{brief ? brief.brief.headline : "EXPLAIN THIS ANALYSIS"}</h2></div><span className="step-actions">{brief ? button(true) : button(false)}</span></div>
    {!ai.migrationApplied ? <p className="form-error">AI briefs need the Phase 10 database migration (ai_briefs).</p>
      : !ai.enabled ? <p className="panel-copy" data-testid="ai-disabled"><b>AI is off on this server.</b> {ai.reason} The deterministic risk analysis below is complete without it.</p>
      : !ai.canGenerate ? <p className="panel-copy">Viewers can read briefs; owners, admins, developers and reviewers can request them.</p>
      : !brief ? <p className="panel-copy">Sends the stored analysis of this change (definitions, column names, counts, factor evidence and review decisions — <b>never dataset rows or people's names</b>) to {ai.enabled ? `${ai.provider} · ${ai.model}` : "the model"} and asks for a reviewer's brief. {ai.usedThisHour}/{ai.hourlyLimit} calls used this hour in this workspace.</p> : null}
    {olderForOther ? <p className="panel-copy">Briefs exist for other analyses of this change; pick that analysis above to see them.</p> : null}
    {brief ? <>
      {brief.stale || (latestAnalysisId !== null && brief.analysisId !== latestAnalysisId) ? <p className="form-error">A newer analysis of this change exists. This brief explains analysis #{brief.analysisId}.</p> : null}
      <div className="ai-suggestion"><span className={suggestionClass(brief.brief.suggestion)} data-testid="ai-suggestion">AI SUGGESTION · {SUGGESTION_LABEL[brief.brief.suggestion].toUpperCase()}</span><span>{brief.brief.suggestionReason}</span><small>Not a decision. Only a reviewer's recorded decision counts.</small></div>
      {brief.adjusted ? <p className="form-error ai-adjusted" data-testid="ai-adjusted">{brief.adjusted}</p> : null}
      <div className="ai-columns">
        <div><p className="eyebrow">WHAT CHANGES</p><ul>{brief.brief.whatChanges.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
        <div><p className="eyebrow">WHY IT IS RISKY · CITED FACTORS</p>{brief.brief.riskPoints.length ? <ul>{brief.brief.riskPoints.map((item, index) => <li key={index}><code>{item.factor}</code> {item.point}</li>)}</ul> : <p className="panel-copy">No factor-backed risk points.</p>}</div>
        <div><p className="eyebrow">CHECK BEFORE APPROVING</p><ul>{brief.brief.checkBeforeApproving.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
      </div>
      {brief.dropped.length ? <p className="panel-copy ai-dropped" data-testid="ai-dropped">Astra removed {brief.dropped.length} point{brief.dropped.length === 1 ? "" : "s"} that cited no factor of this analysis: {brief.dropped.map(item => `“${item.factor}”`).join(", ")}.</p> : null}
      <p className="module-meta ai-meta">{brief.provider} · {brief.model} · {secs(brief.latencyMs)} · {brief.inputTokens ?? "?"} in / {brief.outputTokens ?? "?"} out tokens · {when(brief.createdAt)} · prompt {brief.promptVersion} · <button className="link-button" onClick={() => setShowContext(value => !value)}>{showContext ? "HIDE" : "VIEW"} EXACT CONTEXT SENT</button></p>
      {showContext ? <pre className="ai-context" data-testid="ai-context">{JSON.stringify(brief.context, null, 2)}</pre> : null}
    </> : null}
  </section>;
}

function ActivityBody({ workspaceId }: { workspaceId: number }) {
  const [, setLocation] = useLocation();
  const activity = trpc.ai.activity.useQuery({ workspaceId }, { retry: false });
  if (activity.isLoading) return <div className="workspace-loading"><span>LOADING AI ACTIVITY…</span></div>;
  if (activity.error) return <section className="panel"><StateMessage title="AI activity unavailable" detail={activity.error.message} /></section>;
  const data = activity.data!;
  const failures = data.failures.reduce((sum, item) => sum + item.total, 0);
  return <>
    <section className="panel" data-testid="ai-status"><div className="workspace-section-head"><div><p className="eyebrow">MODEL CONNECTION · SERVER-SIDE</p><h2>{data.status.enabled ? `${data.status.provider.toUpperCase()} · ${data.status.model}` : "AI IS OFF"}</h2></div><span className={data.status.enabled ? "status status--green" : "status status--yellow"}>{data.status.enabled ? "CONFIGURED" : "NOT CONFIGURED"}</span></div>
      <p className="panel-copy">{data.status.enabled ? `Calls time out after ${Math.round(data.status.timeoutMs / 1000)} s and are retried once on transient errors. The API key lives only in the server environment.` : `${data.status.reason} Everything else in Astra works without it.`}</p>
      {!data.migrationApplied ? <p className="form-error">Run the Phase 10 migration (ai_briefs) to store briefs.</p> : null}
    </section>
    {data.totals ? <section className="workspace-kpis ai-kpis">
      <div><Sparkles size={18} /><span>BRIEFS · 7 DAYS</span><b>{data.totals.briefs}</b></div>
      <div><Bot size={18} /><span>FAILED CALLS · 7 DAYS</span><b>{failures}</b><small>{data.failures.map(item => `${item.kind} ${item.total}`).join(" · ") || "none"}</small></div>
      <div><RefreshCw size={18} /><span>AVG LATENCY</span><b>{data.totals.avgLatencyMs === null ? "—" : secs(data.totals.avgLatencyMs)}</b><small>{data.totals.inputTokens.toLocaleString()} in / {data.totals.outputTokens.toLocaleString()} out tokens</small></div>
      <div><ArrowUpRight size={18} /><span>GUARDRAIL ACTIONS</span><b>{data.totals.droppedPoints + data.totals.adjusted}</b><small>{data.totals.droppedPoints} uncited points removed · {data.totals.adjusted} suggestions overridden</small></div>
    </section> : null}
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">RECENT BRIEFS</p><h2>WHAT THE MODEL WROTE</h2></div><span className="module-meta">{data.totals ? `${data.totals.analyses} DETERMINISTIC ANALYSES IN 7 DAYS` : ""}</span></div>
      {data.recent.length ? <div className="history-list">{data.recent.map(item => <div key={item.id}><span><b>{item.title}</b><small>{item.headline}</small></span><span><span className={suggestionClass(item.suggestion as AiSuggestion)}>{SUGGESTION_LABEL[item.suggestion as AiSuggestion] ?? item.suggestion}</span></span><span><b>{secs(item.latencyMs)}</b><small>{item.model} · {when(item.createdAt)}</small></span><span><Button variant="outline" onClick={() => setLocation(`/changes/${item.changeId}?analysis=${item.analysisId}`)}><ArrowUpRight size={13} /> OPEN</Button></span></div>)}</div>
        : <StateMessage title="No AI briefs yet" detail="Open a change and click GENERATE AI BRIEF. The deterministic analysis stays the source of truth." />}
    </section>
    <section className="panel"><p className="eyebrow">HOW ASTRA USES AI</p><h2>ONE WORKFLOW, WITH GUARDRAILS</h2><ul className="ai-rules">
      <li><b>One use case:</b> a reviewer's brief for a stored pipeline-change analysis. No general chatbot.</li>
      <li><b>Grounded:</b> the model sees only that analysis — definitions, column names, counts, factor evidence, review decisions. Never dataset rows or people's names.</li>
      <li><b>Checked:</b> the output must match a strict format; points that cite no real factor are removed; an “approve” on a HIGH/CRITICAL analysis is overridden to “needs human judgment”.</li>
      <li><b>Never authoritative:</b> briefs are stored separately (ai_briefs). Risk scores and review decisions are never written by the model.</li>
      <li><b>Bounded:</b> server-side only, {data.status.enabled ? `${Math.round(data.status.timeoutMs / 1000)} s` : "30 s"} timeout, one retry, a per-workspace hourly limit, and a cached brief per analysis.</li>
    </ul></section>
  </>;
}

export function AiActivityPage() {
  return <div className="page-stack"><section className="page-heading"><div><p className="eyebrow">INTELLIGENCE · AI ASSISTANT</p><h1>AI<br /><em>BRIEFS.</em></h1><p>What the AI layer did in this workspace, read from stored briefs and the audit log. It explains analyses; it never makes decisions.</p></div><Bot size={30} className="module-mark" /></section><WorkspaceGate subject="AI activity">{workspaceId => <ActivityBody key={workspaceId} workspaceId={workspaceId} />}</WorkspaceGate></div>;
}
