import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { aiBriefs, auditLogs, changes, riskAnalyses } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { AI_BRIEF_PROMPT_VERSION, AI_LIMITS, BRIEF_SYSTEM_PROMPT, BriefOutputError, briefUserPrompt, buildBriefContext, parseBrief, type BriefContext, type ReviewBrief } from "../shared/aiBrief";
import { AiCallError, callModel, describeAiConfig, getAiConfig, type AiConfig } from "./aiProvider";
import { getChange } from "./changeDb";
import { audit, extractInsertId, getWorkspaceContext, type Database } from "./workspaceDb";
import { AI_AUDIT_ACTIONS, mayGenerateAiBrief, mayReadChanges } from "./workspaceContracts";

/**
 * Phase 10 — AI review briefs. Source of truth for risk stays risk_analyses (Phase 4)
 * and for decisions stays reviews (Phase 5); this module only ever INSERTs into ai_briefs
 * and audit_logs. A failed or unavailable model changes nothing else.
 */

export function contextHash(context: BriefContext) {
  return createHash("sha256").update(AI_BRIEF_PROMPT_VERSION).update(JSON.stringify(context)).digest("hex").slice(0, 24);
}

/** Per-workspace ceiling on model calls (successes + failures) in a rolling hour. */
export function hourlyLimit(env: NodeJS.ProcessEnv = process.env) {
  return Math.max(1, Math.min(1_000, Number(env.AI_MAX_CALLS_PER_WORKSPACE_HOUR) || 30));
}

let tableReady = false;
async function briefsTableReady(db: Database) {
  if (tableReady) return true;
  const [row] = await db.execute<{ ok: boolean }>(sql`select to_regclass('public.ai_briefs') is not null as ok`) as unknown as Array<{ ok: boolean }>;
  tableReady = Boolean(row?.ok);
  return tableReady;
}
const MIGRATION_MESSAGE = "The Phase 10 database migration (ai_briefs) has not been applied yet. Run supabase/migrations/20261002000000_astra_phase10_ai_briefs.sql.";

/** Model calls started in the last hour (workspace and user), counted from AI_CALL_STARTED reservations. */
async function callsInLastHour(db: Database, filter: { workspaceId?: number; userId?: string }) {
  const [row] = await db.select({ total: count() }).from(auditLogs).where(and(
    eq(auditLogs.action, AI_AUDIT_ACTIONS.callStarted),
    gte(auditLogs.createdAt, sql`now() - interval '1 hour'`),
    filter.workspaceId ? eq(auditLogs.workspaceId, filter.workspaceId) : undefined,
    filter.userId ? eq(auditLogs.actorId, filter.userId) : undefined,
  ));
  return Number(row?.total ?? 0);
}

export function hourlyUserLimit(env: NodeJS.ProcessEnv = process.env) {
  return Math.max(1, Math.min(5_000, Number(env.AI_MAX_CALLS_PER_USER_HOUR) || 60));
}

/**
 * Reserve one model call BEFORE calling the model. Advisory locks (workspace, then user — always
 * in that order) serialise concurrent requests, so N parallel clicks cannot all pass the check.
 */
async function reserveModelCall(db: Database, workspace: { id: number; organizationId: number }, userId: string, meta: Record<string, unknown>) {
  await db.transaction(async tx => {
    const tdb = tx as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('astra-ai-workspace'), ${workspace.id}::int)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('astra-ai-user'), hashtext(${userId}))`);
    if (await callsInLastHour(tdb, { workspaceId: workspace.id }) >= hourlyLimit()) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `This workspace has used its ${hourlyLimit()} AI calls for the last hour. Try again later.` });
    if (await callsInLastHour(tdb, { userId }) >= hourlyUserLimit()) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `You have used your ${hourlyUserLimit()} AI calls for the last hour (across all workspaces). Try again later.` });
    await audit(tdb, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: userId, action: AI_AUDIT_ACTIONS.callStarted, resourceType: "change", resourceId: String(meta.changeId ?? ""), metadata: meta });
  });
}

type BriefRow = typeof aiBriefs.$inferSelect;
function briefView(row: BriefRow, latestAnalysisId: number | null) {
  return {
    id: row.id, changeId: row.changeId, analysisId: row.analysisId, provider: row.provider, model: row.model, promptVersion: row.promptVersion,
    brief: row.brief as ReviewBrief, dropped: (row.dropped ?? []) as Array<{ factor: string; point: string }>, adjusted: row.adjusted,
    inputTokens: row.inputTokens, outputTokens: row.outputTokens, latencyMs: row.latencyMs, createdAt: row.createdAt, createdBy: row.createdBy,
    stale: latestAnalysisId !== null && row.analysisId !== latestAnalysisId,
    context: row.context as BriefContext,
  };
}

export async function getAiStatus(user: User, workspaceId: number) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadChanges(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read this workspace." });
  const ready = await briefsTableReady(db);
  return {
    ...describeAiConfig(getAiConfig()),
    migrationApplied: ready,
    canGenerate: mayGenerateAiBrief(actorRole),
    hourlyLimit: hourlyLimit(),
    usedThisHour: ready ? await callsInLastHour(db, { workspaceId: workspace.id }) : 0,
    promptVersion: AI_BRIEF_PROMPT_VERSION,
  };
}

/** Briefs of one change, newest first. Viewers may read them; the change itself is authorized by getChange. */
export async function listChangeBriefs(user: User, workspaceId: number, changeId: number) {
  const change = await getChange(user, workspaceId, changeId);
  const { db } = await getWorkspaceContext(user, workspaceId);
  if (!(await briefsTableReady(db))) return { migrationApplied: false as const, briefs: [] };
  const rows = await db.select().from(aiBriefs).where(and(eq(aiBriefs.changeId, change.id), eq(aiBriefs.workspaceId, workspaceId))).orderBy(desc(aiBriefs.id)).limit(20);
  const latest = change.analyses[0]?.id ?? null;
  return { migrationApplied: true as const, briefs: rows.map(row => briefView(row, latest)) };
}

function trpcFor(error: AiCallError): TRPCError {
  const code = error.kind === "disabled" ? "PRECONDITION_FAILED" : error.kind === "rate_limited" ? "TOO_MANY_REQUESTS" : error.kind === "timeout" ? "TIMEOUT" : "INTERNAL_SERVER_ERROR";
  return new TRPCError({ code, message: `No brief was generated — ${error.message} The risk analysis and reviews are unaffected.` });
}

/**
 * Generate (or return the cached) brief for one stored analysis of a change.
 * Cached = same analysis, same context, same prompt version, same provider+model.
 */
export async function generateChangeBrief(user: User, input: { workspaceId: number; changeId: number; analysisId?: number; regenerate?: boolean }, config: AiConfig = getAiConfig()) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, input.workspaceId);
  if (!mayGenerateAiBrief(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Viewers can read AI briefs but not request them." });
  if (!(await briefsTableReady(db))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: MIGRATION_MESSAGE });
  const change = await getChange(user, input.workspaceId, input.changeId);
  if (!change.source) throw new TRPCError({ code: "BAD_REQUEST", message: "This change was not created by the pipeline analysis path, so there is nothing grounded to brief on." });
  const analysis = input.analysisId ? change.analyses.find(item => item.id === input.analysisId) : change.analyses[0];
  if (!analysis) throw new TRPCError({ code: "NOT_FOUND", message: "That analysis does not belong to this change." });
  const context = buildBriefContext({ change, source: change.source, datasetNames: change.datasetNames, analysis, reviews: change.reviews });
  const hash = contextHash(context);
  const latest = change.analyses[0]?.id ?? null;

  if (!config.enabled) {
    await audit(db, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: AI_AUDIT_ACTIONS.briefFailed, resourceType: "change", resourceId: String(change.id), result: "failure", metadata: { analysisId: analysis.id, kind: "disabled", calledModel: false } });
    throw trpcFor(new AiCallError("disabled", config.reason));
  }
  if (!input.regenerate) {
    const [cached] = await db.select().from(aiBriefs).where(and(eq(aiBriefs.analysisId, analysis.id), eq(aiBriefs.contextHash, hash), eq(aiBriefs.provider, config.provider), eq(aiBriefs.model, config.model))).orderBy(desc(aiBriefs.id)).limit(1);
    if (cached) return { cached: true as const, brief: briefView(cached, latest) };
  }
  await reserveModelCall(db, workspace, user.id, { changeId: change.id, analysisId: analysis.id, provider: config.provider, model: config.model });

  let parsed: ReturnType<typeof parseBrief>;
  let call: Awaited<ReturnType<typeof callModel>>;
  try {
    call = await callModel({ system: BRIEF_SYSTEM_PROMPT, user: briefUserPrompt(context), maxTokens: AI_LIMITS.maxOutputTokens }, config);
    parsed = parseBrief(call.text, context);
  } catch (error) {
    const failure = error instanceof AiCallError ? error : error instanceof BriefOutputError ? new AiCallError("invalid_output", `${error.message}`) : new AiCallError("network", "The AI call failed unexpectedly.");
    console.warn("[AI] brief failed", { kind: failure.kind, status: failure.status, changeId: change.id, analysisId: analysis.id });
    await audit(db, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: AI_AUDIT_ACTIONS.briefFailed, resourceType: "change", resourceId: String(change.id), result: "failure", metadata: { analysisId: analysis.id, kind: failure.kind, status: failure.status, provider: config.provider, model: config.model, calledModel: true } }).catch(() => undefined);
    throw trpcFor(failure);
  }

  const id = await db.transaction(async tx => {
    const created = extractInsertId(await tx.insert(aiBriefs).values({
      organizationId: workspace.organizationId, workspaceId: workspace.id, changeId: change.id, analysisId: analysis.id,
      promptVersion: AI_BRIEF_PROMPT_VERSION, provider: config.provider, model: call.model.slice(0, 120), contextHash: hash, context,
      brief: parsed.brief, dropped: parsed.dropped, adjusted: parsed.adjusted, inputTokens: call.inputTokens, outputTokens: call.outputTokens, latencyMs: call.latencyMs, createdBy: user.id,
    }).returning({ id: aiBriefs.id }));
    await audit(tx as unknown as Database, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: AI_AUDIT_ACTIONS.briefGenerated, resourceType: "ai_brief", resourceId: String(created), metadata: { changeId: change.id, analysisId: analysis.id, provider: config.provider, model: call.model, latencyMs: call.latencyMs, inputTokens: call.inputTokens, outputTokens: call.outputTokens, droppedPoints: parsed.dropped.length, adjusted: Boolean(parsed.adjusted), regenerate: Boolean(input.regenerate) } });
    return created;
  });
  const [row] = await db.select().from(aiBriefs).where(eq(aiBriefs.id, id)).limit(1);
  return { cached: false as const, brief: briefView(row!, latest) };
}

/** Real activity for the AI page: what the model did in this workspace, from ai_briefs + audit_logs. */
export async function getAiActivity(user: User, workspaceId: number) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadChanges(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read this workspace." });
  const status = describeAiConfig(getAiConfig());
  if (!(await briefsTableReady(db))) return { status, migrationApplied: false as const, totals: null, failures: [], recent: [], engines: null };
  const since = sql`now() - interval '7 days'`;
  const [totals] = await db.select({
    briefs: count(),
    avgLatency: sql<number | null>`round(avg(${aiBriefs.latencyMs}))::int`,
    inputTokens: sql<number | null>`sum(${aiBriefs.inputTokens})::int`,
    outputTokens: sql<number | null>`sum(${aiBriefs.outputTokens})::int`,
    dropped: sql<number>`coalesce(sum(jsonb_array_length(${aiBriefs.dropped})), 0)::int`,
    adjusted: sql<number>`count(*) filter (where ${aiBriefs.adjusted} is not null)::int`,
  }).from(aiBriefs).where(and(eq(aiBriefs.workspaceId, workspace.id), gte(aiBriefs.createdAt, since)));
  const failures = await db.select({ kind: sql<string>`${auditLogs.metadata} ->> 'kind'`, total: count() }).from(auditLogs)
    .where(and(eq(auditLogs.workspaceId, workspace.id), eq(auditLogs.action, AI_AUDIT_ACTIONS.briefFailed), gte(auditLogs.createdAt, since))).groupBy(sql`${auditLogs.metadata} ->> 'kind'`);
  const recent = await db.select({ id: aiBriefs.id, changeId: aiBriefs.changeId, analysisId: aiBriefs.analysisId, model: aiBriefs.model, latencyMs: aiBriefs.latencyMs, createdAt: aiBriefs.createdAt, suggestion: sql<string>`${aiBriefs.brief} ->> 'suggestion'`, headline: sql<string>`${aiBriefs.brief} ->> 'headline'`, title: changes.title })
    .from(aiBriefs).innerJoin(changes, eq(changes.id, aiBriefs.changeId)).where(eq(aiBriefs.workspaceId, workspace.id)).orderBy(desc(aiBriefs.id)).limit(10);
  const [analysesCount] = await db.select({ total: count() }).from(riskAnalyses).innerJoin(changes, eq(changes.id, riskAnalyses.changeId)).where(and(eq(changes.workspaceId, workspace.id), gte(riskAnalyses.createdAt, since)));
  return {
    status, migrationApplied: true as const,
    totals: { briefs: Number(totals?.briefs ?? 0), avgLatencyMs: totals?.avgLatency ?? null, inputTokens: totals?.inputTokens ?? 0, outputTokens: totals?.outputTokens ?? 0, droppedPoints: Number(totals?.dropped ?? 0), adjusted: Number(totals?.adjusted ?? 0), analyses: Number(analysesCount?.total ?? 0) },
    failures: failures.map(item => ({ kind: item.kind ?? "unknown", total: Number(item.total) })),
    recent,
  };
}

