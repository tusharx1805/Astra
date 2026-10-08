import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { changes, datasetColumns, datasets, pipelineRuns, pipelineSteps, pipelines, riskAnalyses } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { fetchProfiles } from "./_core/supabaseProfiles";
import { analyzePipelineChange, CHANGE_SOURCE_KIND, changeTitle, RISK_ENGINE_VERSION, type ChangeRiskResult, type ImpactContext, type PipelineChangeSource, type PipelineDefinitionSnapshot, type RiskLevel } from "../shared/changeRisk";
import { fromStepRecord, normalizeStep } from "../shared/pipelineDefinition";
import type { TransformStep } from "../shared/transformations";
import { loadAllDatasetRows } from "./datasetDb";
import { getPipeline } from "./pipelineDb";
import { audit, datasetVisibleInWorkspace, extractInsertId, getWorkspaceContext, type Database } from "./workspaceDb";
import { CHANGE_AUDIT_ACTIONS, mayAnalyzeChange, mayReadChanges } from "./workspaceContracts";
import { loadReviews, reviewStates } from "./reviewDb";
import { ALLOW_SELF_APPROVAL, mayRecordWorkspaceReview } from "./reviewPermissions";
import { reviewStatus } from "../shared/review";

/**
 * Phase 4 — Real Change & Risk Analysis.
 * Source of truth: changes (the proposal, stored verbatim as JSON in changes.source)
 * + risk_analyses (one row per analysis; a change can be re-analysed as data evolves).
 * The analysis service is shared/changeRisk.ts (pipeline-impact engine) over data
 * loaded here. The mock engine is NOT used on this path and there is no fallback:
 * if analysis cannot be computed, nothing is stored and the caller gets an error.
 */

export const PIPELINE_CHANGE_TYPE = "CONFIG";
const HISTORY_WINDOW = 20;

type Workspace = { id: number; organizationId: number };
export type ProposedDefinition = { name: string; sourceDatasetId: number; destinationMode: "new_dataset" | "overwrite_existing"; destinationDatasetId?: number | null; steps: TransformStep[] };

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function snapshot(definition: ProposedDefinition): PipelineDefinitionSnapshot {
  return {
    name: definition.name.trim(),
    sourceDatasetId: definition.sourceDatasetId,
    destinationMode: definition.destinationMode,
    destinationDatasetId: definition.destinationMode === "overwrite_existing" ? definition.destinationDatasetId ?? null : null,
    steps: definition.steps.map(normalizeStep),
  };
}

/** Parse changes.source. Only pipeline-definition changes are produced by the real path. */
export function parseChangeSource(source: string): PipelineChangeSource | null {
  try {
    const value = JSON.parse(source) as PipelineChangeSource;
    return value && value.kind === CHANGE_SOURCE_KIND && value.version === 1 && value.proposed ? value : null;
  } catch {
    return null;
  }
}

/** Load everything the engine needs from the database. Datasets must belong to this workspace. */
async function buildImpactContext(db: Database, workspace: Workspace, change: PipelineChangeSource): Promise<ImpactContext> {
  const { proposed } = change;
  const [source] = await db.select({ id: datasets.id, name: datasets.name, workspaceId: datasets.workspaceId }).from(datasets)
    .where(and(eq(datasets.id, proposed.sourceDatasetId), datasetVisibleInWorkspace(workspace))).limit(1);
  if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Source dataset not found in the active workspace." });
  if (source.workspaceId !== workspace.id) badRequest(`"${source.name}" is a legacy registry entry without stored rows and cannot be analysed.`);
  const columns = (await db.select({ name: datasetColumns.name }).from(datasetColumns).where(eq(datasetColumns.datasetId, source.id)).orderBy(asc(datasetColumns.id))).map(column => column.name);
  if (!columns.length) badRequest(`"${source.name}" has no stored columns to analyse against.`);
  const rows = await loadAllDatasetRows(db, source.id);

  let destination: ImpactContext["destination"] = null;
  let downstream: ImpactContext["downstream"] = [];
  if (proposed.destinationMode === "overwrite_existing") {
    if (!proposed.destinationDatasetId) badRequest("Choose the dataset to overwrite.");
    if (proposed.destinationDatasetId === proposed.sourceDatasetId) badRequest("A pipeline cannot overwrite its own source dataset.");
    const [target] = await db.select({ id: datasets.id, name: datasets.name, rowCount: datasets.rowCount, workspaceId: datasets.workspaceId }).from(datasets)
      .where(and(eq(datasets.id, proposed.destinationDatasetId), datasetVisibleInWorkspace(workspace))).limit(1);
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Destination dataset not found in the active workspace." });
    if (target.workspaceId !== workspace.id) badRequest("Legacy registry datasets cannot be used as a destination.");
    const targetColumns = (await db.select({ name: datasetColumns.name }).from(datasetColumns).where(eq(datasetColumns.datasetId, target.id)).orderBy(asc(datasetColumns.id))).map(column => column.name);
    destination = { id: target.id, name: target.name, rowCount: target.rowCount, columns: targetColumns };

    // Every other pipeline in this workspace that reads the dataset this change would overwrite.
    const readers = await db.select({ id: pipelines.id, name: pipelines.name }).from(pipelines)
      .where(and(eq(pipelines.workspaceId, workspace.id), eq(pipelines.sourceDatasetId, target.id), ...(change.pipelineId ? [ne(pipelines.id, change.pipelineId)] : [])));
    if (readers.length) {
      const stepRows = await db.select({ pipelineId: pipelineSteps.pipelineId, operation: pipelineSteps.operation, config: pipelineSteps.config }).from(pipelineSteps)
        .where(inArray(pipelineSteps.pipelineId, readers.map(reader => reader.id))).orderBy(asc(pipelineSteps.pipelineId), asc(pipelineSteps.stepOrder));
      downstream = readers.map(reader => ({ id: reader.id, name: reader.name, steps: stepRows.filter(row => row.pipelineId === reader.id).map(row => fromStepRecord(row)).filter((step): step is TransformStep => step !== null) }));
    }
  }

  let history = { finished: 0, failed: 0 };
  if (change.pipelineId) {
    const recent = await db.select({ status: pipelineRuns.status }).from(pipelineRuns)
      .where(and(eq(pipelineRuns.pipelineId, change.pipelineId), inArray(pipelineRuns.status, ["success", "failed"]))).orderBy(desc(pipelineRuns.id)).limit(HISTORY_WINDOW);
    history = { finished: recent.length, failed: recent.filter(run => run.status === "failed").length };
  }
  return { change, source: { id: source.id, name: source.name, columns, rows }, destination, downstream, history };
}

async function storeAnalysis(db: Database, workspace: Workspace, user: User, changeId: number, result: ChangeRiskResult, action: string) {
  const id = extractInsertId(await db.insert(riskAnalyses).values({ organizationId: workspace.organizationId, changeId, score: result.score, level: result.level, engineVersion: RISK_ENGINE_VERSION, result, createdAt: sql`clock_timestamp()` }).returning({ id: riskAnalyses.id }));
  await audit(db, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action, resourceType: "change", resourceId: String(changeId), metadata: { analysisId: id, score: result.score, level: result.level, engine: RISK_ENGINE_VERSION } });
  return id;
}

/** Record a proposed pipeline definition as a change and store its risk analysis (one transaction). */
export async function analyzeProposedPipelineChange(user: User, input: { workspaceId: number; pipelineId?: number | null; baseVersion?: string | null; definition: ProposedDefinition }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, input.workspaceId);
  if (!mayAnalyzeChange(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners, admins and developers can submit changes for analysis." });
  const proposed = snapshot(input.definition);
  if (proposed.name.length < 3) badRequest("Pipeline name must be at least 3 characters.");

  let current: PipelineDefinitionSnapshot | null = null;
  let baseVersion: string | null = null;
  if (input.pipelineId) {
    const existing = await getPipeline(user, input.workspaceId, input.pipelineId);
    if (existing.legacy) throw new TRPCError({ code: "FORBIDDEN", message: "Legacy organisation-level pipelines are read-only." });
    if (input.baseVersion && input.baseVersion !== existing.version) throw new TRPCError({ code: "CONFLICT", message: "This pipeline was changed by someone else since you opened it. Reload before analysing." });
    if (existing.sourceDatasetId === null) badRequest("The pipeline's current source dataset was removed; save a new source first.");
    current = {
      name: existing.name,
      sourceDatasetId: existing.sourceDatasetId,
      destinationMode: existing.destinationMode ?? "new_dataset",
      destinationDatasetId: existing.destinationDatasetId,
      steps: existing.steps.map(({ id: _id, stepOrder: _order, ...step }) => step as TransformStep),
    };
    baseVersion = existing.version;
  }
  const change: PipelineChangeSource = { kind: CHANGE_SOURCE_KIND, version: 1, workspaceId: workspace.id, pipelineId: input.pipelineId ?? null, baseVersion, current, proposed };
  // Compute first: if analysis fails, nothing is stored and there is no mock fallback.
  const result = analyzePipelineChange(await buildImpactContext(db, workspace, change));

  const ids = await db.transaction(async tx => {
    const tdb = tx as unknown as Database;
    const changeId = extractInsertId(await tx.insert(changes).values({
      organizationId: workspace.organizationId, workspaceId: workspace.id, pipelineId: input.pipelineId ?? null, projectId: null,
      authorId: user.id, title: changeTitle(change), changeType: PIPELINE_CHANGE_TYPE, source: JSON.stringify(change),
    }).returning({ id: changes.id }));
    const analysisId = await storeAnalysis(tdb, workspace, user, changeId, result, CHANGE_AUDIT_ACTIONS.analyzed);
    return { changeId, analysisId };
  });
  return { ...ids, result };
}

async function loadChange(db: Database, workspace: Workspace, changeId: number) {
  const [row] = await db.select().from(changes).where(and(eq(changes.id, changeId), eq(changes.workspaceId, workspace.id))).limit(1);
  // NOT_FOUND (not FORBIDDEN) so change ids from other workspaces are not disclosed.
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Change not found in the active workspace." });
  return row;
}

/** Re-run the analysis of a stored proposal against today's data (new risk_analyses row; the change is unchanged). */
export async function reanalyzeChange(user: User, workspaceId: number, changeId: number) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayAnalyzeChange(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners, admins and developers can re-analyse changes." });
  const row = await loadChange(db, workspace, changeId);
  const change = parseChangeSource(row.source);
  if (!change) badRequest("This change was not produced by the pipeline analysis path and cannot be re-analysed.");
  const result = analyzePipelineChange(await buildImpactContext(db, workspace, { ...change, pipelineId: row.pipelineId }));
  const analysisId = await db.transaction(async tx => {
    // Same lock as review recording (server/reviewDb.ts) so analyses and decisions are strictly ordered.
    await tx.select({ id: changes.id }).from(changes).where(eq(changes.id, changeId)).for("update");
    return storeAnalysis(tx as unknown as Database, workspace, user, changeId, result, CHANGE_AUDIT_ACTIONS.reanalyzed);
  });
  return { changeId, analysisId, result };
}

type AnalysisSummary = { id: number; score: number; level: RiskLevel; engineVersion: string; createdAt: Date };

async function authorNames(accessToken: string | null, user: User, ids: Array<string | null>) {
  const profiles = await fetchProfiles(accessToken, Array.from(new Set(ids.filter((id): id is string => Boolean(id))))).catch(() => new Map());
  return (id: string | null) => (!id ? "Deleted user" : id === user.id ? "You" : profiles.get(id) ? `@${profiles.get(id)!.username}` : "Workspace member");
}

export async function listChanges(user: User, workspaceId: number, accessToken: string | null = null) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadChanges(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read changes in this workspace." });
  const rows = await db.select({ id: changes.id, title: changes.title, changeType: changes.changeType, authorId: changes.authorId, pipelineId: changes.pipelineId, pipelineName: pipelines.name, createdAt: changes.createdAt })
    .from(changes).leftJoin(pipelines, eq(changes.pipelineId, pipelines.id))
    .where(eq(changes.workspaceId, workspace.id)).orderBy(desc(changes.id)).limit(100);
  if (!rows.length) return [];
  const analyses = await db.select({ id: riskAnalyses.id, changeId: riskAnalyses.changeId, score: riskAnalyses.score, level: riskAnalyses.level, engineVersion: riskAnalyses.engineVersion, createdAt: riskAnalyses.createdAt })
    .from(riskAnalyses).where(inArray(riskAnalyses.changeId, rows.map(row => row.id))).orderBy(desc(riskAnalyses.id));
  const author = await authorNames(accessToken, user, rows.map(row => row.authorId));
  const states = await reviewStates(db, user, rows.map(row => row.id));
  return rows.map(row => {
    const own = analyses.filter(item => item.changeId === row.id);
    const state = states.get(row.id)!;
    return { ...row, author: author(row.authorId), analysisCount: own.length, latest: (own[0] ?? null) as AnalysisSummary | null, reviewStatus: state.status, reviewCount: state.reviewCount, latestReview: state.latestReview };
  });
}

export async function getChange(user: User, workspaceId: number, changeId: number, accessToken: string | null = null) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadChanges(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read changes in this workspace." });
  const row = await loadChange(db, workspace, changeId);
  const analyses = await db.select().from(riskAnalyses).where(eq(riskAnalyses.changeId, row.id)).orderBy(desc(riskAnalyses.id));
  const source = parseChangeSource(row.source);
  let pipeline: { id: number; name: string; version: string; matchesProposal: boolean } | null = null;
  if (row.pipelineId) {
    const current = await getPipeline(user, workspaceId, row.pipelineId).catch(() => null);
    if (current && source) {
      const proposal = JSON.stringify([source.proposed.name, source.proposed.sourceDatasetId, source.proposed.destinationMode, source.proposed.destinationDatasetId, source.proposed.steps]);
      const now = JSON.stringify([current.name, current.sourceDatasetId, current.destinationMode, current.destinationDatasetId, current.steps.map(({ id: _id, stepOrder: _order, ...step }) => normalizeStep(step as TransformStep))]);
      pipeline = { id: current.id, name: current.name, version: current.version, matchesProposal: proposal === now };
    }
  }
  const datasetIds = source ? [source.proposed.sourceDatasetId, source.proposed.destinationDatasetId, source.current?.sourceDatasetId, source.current?.destinationDatasetId].filter((id): id is number => typeof id === "number") : [];
  const datasetNames = datasetIds.length ? Object.fromEntries((await db.select({ id: datasets.id, name: datasets.name }).from(datasets).where(and(inArray(datasets.id, datasetIds), datasetVisibleInWorkspace(workspace)))).map(item => [item.id, item.name])) : {};
  const author = await authorNames(accessToken, user, [row.authorId]);
  const reviewHistory = await loadReviews(db, user, [row.id], accessToken);
  return {
    id: row.id, title: row.title, changeType: row.changeType, pipelineId: row.pipelineId, createdAt: row.createdAt, author: author(row.authorId),
    isAuthor: row.authorId === user.id,
    reviews: reviewHistory,
    reviewStatus: reviewStatus(analyses[0]?.id ?? null, reviewHistory[0] ?? null),
    canReview: mayRecordWorkspaceReview(actorRole),
    allowSelfApproval: ALLOW_SELF_APPROVAL,
    source, rawSourceIsPipelineChange: Boolean(source), datasetNames: datasetNames as Record<number, string>, pipeline,
    analyses: analyses.map(item => ({ id: item.id, score: item.score, level: item.level as RiskLevel, engineVersion: item.engineVersion, createdAt: item.createdAt, result: item.result as ChangeRiskResult })),
  };
}

/** Risk analyses of the workspace. "active" = the latest analysis of each change when it is not SAFE. */
export async function listRiskAnalyses(user: User, workspaceId: number, scope: "active" | "all") {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadChanges(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read risk analyses in this workspace." });
  const rows = await db.select({ id: riskAnalyses.id, changeId: riskAnalyses.changeId, score: riskAnalyses.score, level: riskAnalyses.level, engineVersion: riskAnalyses.engineVersion, createdAt: riskAnalyses.createdAt, title: changes.title, pipelineId: changes.pipelineId })
    .from(riskAnalyses).innerJoin(changes, eq(riskAnalyses.changeId, changes.id))
    .where(eq(changes.workspaceId, workspace.id)).orderBy(desc(riskAnalyses.id)).limit(scope === "all" ? 200 : 1000);
  if (scope === "all") return rows;
  const seen = new Set<number>();
  return rows.filter(row => (seen.has(row.changeId) ? false : (seen.add(row.changeId), true))).filter(row => row.level !== "SAFE").slice(0, 200);
}
