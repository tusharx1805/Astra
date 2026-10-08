import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { datasetColumns, datasets, pipelineSteps, pipelines } from "../drizzle/schema";
import type { AuthUser as User } from "./_core/supabaseAuth";
import { fromStepRecord, normalizeStep, toStepRecord, validatePipelineSteps, type DestinationMode } from "../shared/pipelineDefinition";
import type { TransformStep } from "../shared/transformations";
import { audit, datasetVisibleInWorkspace, extractInsertId, getWorkspaceContext, pipelineVisibleInWorkspace, type Database } from "./workspaceDb";
import { mayEditPipeline, mayReadPipeline, PIPELINE_AUDIT_ACTIONS } from "./workspaceContracts";

/**
 * Phase 2 — Real Pipeline (definitions only).
 * Source of truth: pipelines (one row per definition) + pipeline_steps (one row per ordered step).
 * This module persists and reads definitions. It never executes transformations;
 * execution (and pipeline_runs) is Phase 3 and will call applyTransformSteps() on these steps.
 */

/** A saved definition that has never been run. Phase 3 moves status on from here. */
export const PIPELINE_STATUS_DRAFT = "DRAFT";

export type PipelineDefinitionInput = {
  workspaceId: number;
  name: string;
  sourceDatasetId: number;
  destinationMode: DestinationMode;
  destinationDatasetId?: number | null;
  steps: TransformStep[];
};

type Workspace = { id: number; organizationId: number };

/**
 * Optimistic-concurrency token. The live schema has no updated_at on pipelines,
 * so the version is a hash of the stored definition itself: any change by anyone
 * (name, source, destination or any step) changes it.
 */
export function definitionVersion(definition: { name: string; sourceDatasetId: number | null; destinationMode: string | null; destinationDatasetId: number | null; steps: Array<{ operation: string; config: unknown }> }) {
  const canonical = JSON.stringify([definition.name, definition.sourceDatasetId, definition.destinationMode, definition.destinationDatasetId, definition.steps.map(step => [step.operation, sortKeys(step.config)])]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function sortKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
}

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/** The source must be a dataset of THIS workspace with persisted column metadata. */
async function loadSourceColumns(db: Database, workspace: Workspace, datasetId: number) {
  const [dataset] = await db.select({ id: datasets.id, name: datasets.name, workspaceId: datasets.workspaceId }).from(datasets)
    .where(and(eq(datasets.id, datasetId), datasetVisibleInWorkspace(workspace))).limit(1);
  // NOT_FOUND (not FORBIDDEN) so ids from other workspaces are not disclosed.
  if (!dataset) throw new TRPCError({ code: "NOT_FOUND", message: "Source dataset not found in the active workspace." });
  if (dataset.workspaceId !== workspace.id) badRequest(`"${dataset.name}" is a legacy registry entry without stored rows; choose a dataset imported into this workspace.`);
  const columns = await db.select({ name: datasetColumns.name }).from(datasetColumns).where(eq(datasetColumns.datasetId, dataset.id)).orderBy(asc(datasetColumns.id));
  if (!columns.length) badRequest(`"${dataset.name}" has no stored column metadata.`);
  return { dataset, columns: columns.map(column => column.name) };
}

async function assertDestination(db: Database, workspace: Workspace, input: PipelineDefinitionInput) {
  if (input.destinationMode === "new_dataset") {
    if (input.destinationDatasetId) badRequest("A new-dataset destination cannot also name an existing dataset.");
    return null;
  }
  if (!input.destinationDatasetId) badRequest("Choose the dataset to overwrite.");
  if (input.destinationDatasetId === input.sourceDatasetId) badRequest("A pipeline cannot overwrite its own source dataset.");
  const [destination] = await db.select({ id: datasets.id, workspaceId: datasets.workspaceId }).from(datasets)
    .where(and(eq(datasets.id, input.destinationDatasetId), datasetVisibleInWorkspace(workspace))).limit(1);
  if (!destination) throw new TRPCError({ code: "NOT_FOUND", message: "Destination dataset not found in the active workspace." });
  if (destination.workspaceId !== workspace.id) badRequest("Legacy registry datasets cannot be used as a destination.");
  return destination.id;
}

/** Server-side validation of everything the client sent, against persisted data. */
async function validateDefinition(db: Database, workspace: Workspace, input: PipelineDefinitionInput) {
  const name = input.name.trim();
  if (name.length < 3) badRequest("Pipeline name must be at least 3 characters.");
  const steps = input.steps.map(normalizeStep);
  const source = await loadSourceColumns(db, workspace, input.sourceDatasetId);
  const destinationDatasetId = await assertDestination(db, workspace, input);
  const issues = validatePipelineSteps(steps, source.columns);
  if (issues.length) badRequest(issues.map(issue => issue.message).join(" "));
  return { name, steps, destinationDatasetId };
}

async function assertUniqueName(db: Database, workspaceId: number, name: string, exceptId?: number) {
  const clash = await db.select({ id: pipelines.id }).from(pipelines)
    .where(and(eq(pipelines.workspaceId, workspaceId), eq(pipelines.name, name), ...(exceptId ? [ne(pipelines.id, exceptId)] : []))).limit(1);
  if (clash[0]) throw new TRPCError({ code: "CONFLICT", message: `A pipeline named "${name}" already exists in this workspace.` });
}

async function insertSteps(db: Database, pipelineId: number, steps: TransformStep[]) {
  if (!steps.length) return;
  await db.insert(pipelineSteps).values(steps.map((step, index) => ({ pipelineId, ...toStepRecord(step, index) })));
}

export async function createPipeline(user: User, input: PipelineDefinitionInput) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, input.workspaceId);
  if (!mayEditPipeline(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners, admins and developers can create pipelines." });
  const definition = await validateDefinition(db, workspace, input);
  await assertUniqueName(db, workspace.id, definition.name);
  const pipelineId = await db.transaction(async tx => {
    const id = extractInsertId(await tx.insert(pipelines).values({
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      projectId: null,
      name: definition.name,
      ownerId: user.id,
      status: PIPELINE_STATUS_DRAFT,
      sourceDatasetId: input.sourceDatasetId,
      destinationMode: input.destinationMode,
      destinationDatasetId: definition.destinationDatasetId,
    }).returning({ id: pipelines.id }));
    await insertSteps(tx as unknown as Database, id, definition.steps);
    await audit(tx as unknown as Database, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: PIPELINE_AUDIT_ACTIONS.created, resourceType: "pipeline", resourceId: String(id), metadata: { name: definition.name, sourceDatasetId: input.sourceDatasetId, steps: definition.steps.length } });
    return id;
  });
  return getPipeline(user, input.workspaceId, pipelineId);
}

export async function updatePipeline(user: User, input: PipelineDefinitionInput & { pipelineId: number; baseVersion: string }) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, input.workspaceId);
  if (!mayEditPipeline(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners, admins and developers can edit pipelines." });
  const [visible] = await db.select({ id: pipelines.id, workspaceId: pipelines.workspaceId }).from(pipelines)
    .where(and(eq(pipelines.id, input.pipelineId), pipelineVisibleInWorkspace(workspace))).limit(1);
  if (!visible) throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in the active workspace." });
  if (visible.workspaceId !== workspace.id) throw new TRPCError({ code: "FORBIDDEN", message: "Legacy organisation-level pipelines are read-only." });
  const definition = await validateDefinition(db, workspace, input);
  await assertUniqueName(db, workspace.id, definition.name, input.pipelineId);

  await db.transaction(async tx => {
    // Lock the pipeline row so two concurrent saves are serialised and the version check is exact.
    const [current] = await tx.select().from(pipelines).where(eq(pipelines.id, input.pipelineId)).for("update");
    if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in the active workspace." });
    const currentSteps = await tx.select({ operation: pipelineSteps.operation, config: pipelineSteps.config }).from(pipelineSteps)
      .where(eq(pipelineSteps.pipelineId, current.id)).orderBy(asc(pipelineSteps.stepOrder));
    if (definitionVersion({ ...current, steps: currentSteps }) !== input.baseVersion) {
      throw new TRPCError({ code: "CONFLICT", message: "This pipeline was changed by someone else since you opened it. Reload to see the latest definition." });
    }
    await tx.update(pipelines).set({ name: definition.name, sourceDatasetId: input.sourceDatasetId, destinationMode: input.destinationMode, destinationDatasetId: definition.destinationDatasetId }).where(eq(pipelines.id, current.id));
    // Replace the ordered steps as a unit (unique (pipeline_id, step_order) forbids gaps being re-used mid-way).
    await tx.delete(pipelineSteps).where(eq(pipelineSteps.pipelineId, current.id));
    await insertSteps(tx as unknown as Database, current.id, definition.steps);
    await audit(tx as unknown as Database, { organizationId: workspace.organizationId, workspaceId: workspace.id, actorId: user.id, action: PIPELINE_AUDIT_ACTIONS.updated, resourceType: "pipeline", resourceId: String(current.id), metadata: { name: definition.name, previousSteps: currentSteps.length, steps: definition.steps.length } });
  });
  return getPipeline(user, input.workspaceId, input.pipelineId);
}

export async function getPipeline(user: User, workspaceId: number, pipelineId: number) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadPipeline(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read pipelines in this workspace." });
  const [pipeline] = await db.select().from(pipelines).where(and(eq(pipelines.id, pipelineId), pipelineVisibleInWorkspace(workspace))).limit(1);
  if (!pipeline) throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in the active workspace." });
  const stepRows = await db.select({ id: pipelineSteps.id, stepOrder: pipelineSteps.stepOrder, operation: pipelineSteps.operation, config: pipelineSteps.config })
    .from(pipelineSteps).where(eq(pipelineSteps.pipelineId, pipeline.id)).orderBy(asc(pipelineSteps.stepOrder));
  const datasetIds = [pipeline.sourceDatasetId, pipeline.destinationDatasetId].filter((id): id is number => typeof id === "number");
  const names = datasetIds.length
    ? new Map((await db.select({ id: datasets.id, name: datasets.name }).from(datasets).where(and(inArray(datasets.id, datasetIds), datasetVisibleInWorkspace(workspace)))).map(row => [row.id, row.name]))
    : new Map<number, string>();
  const steps = stepRows.map(row => ({ id: row.id, stepOrder: row.stepOrder, step: fromStepRecord(row) }));
  return {
    id: pipeline.id,
    name: pipeline.name,
    status: pipeline.status,
    workspaceId: pipeline.workspaceId,
    projectId: pipeline.projectId,
    ownerId: pipeline.ownerId,
    sourceDatasetId: pipeline.sourceDatasetId,
    sourceDatasetName: pipeline.sourceDatasetId ? names.get(pipeline.sourceDatasetId) ?? null : null,
    destinationMode: pipeline.destinationMode as DestinationMode | null,
    destinationDatasetId: pipeline.destinationDatasetId,
    destinationDatasetName: pipeline.destinationDatasetId ? names.get(pipeline.destinationDatasetId) ?? null : null,
    steps: steps.filter(item => item.step !== null).map(item => ({ id: item.id, stepOrder: item.stepOrder, ...item.step! })),
    /** Stored steps that no longer match the engine contract (never silently dropped from view). */
    invalidStepOrders: steps.filter(item => item.step === null).map(item => item.stepOrder),
    version: definitionVersion({ ...pipeline, steps: stepRows }),
    editable: pipeline.workspaceId === workspace.id && mayEditPipeline(actorRole),
    legacy: pipeline.workspaceId === null,
  };
}

export async function listPipelines(user: User, workspaceId: number) {
  const { db, workspace, actorRole } = await getWorkspaceContext(user, workspaceId);
  if (!mayReadPipeline(actorRole)) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot read pipelines in this workspace." });
  const rows = await db.select({ id: pipelines.id, name: pipelines.name, status: pipelines.status, workspaceId: pipelines.workspaceId, projectId: pipelines.projectId, sourceDatasetId: pipelines.sourceDatasetId, destinationMode: pipelines.destinationMode })
    .from(pipelines).where(pipelineVisibleInWorkspace(workspace)).orderBy(desc(pipelines.id));
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const sourceIds = Array.from(new Set(rows.map(row => row.sourceDatasetId).filter((id): id is number => typeof id === "number")));
  const [stepCounts, sources] = await Promise.all([
    db.select({ pipelineId: pipelineSteps.pipelineId, total: count() }).from(pipelineSteps).where(inArray(pipelineSteps.pipelineId, ids)).groupBy(pipelineSteps.pipelineId),
    sourceIds.length ? db.select({ id: datasets.id, name: datasets.name }).from(datasets).where(and(inArray(datasets.id, sourceIds), datasetVisibleInWorkspace(workspace))) : Promise.resolve([]),
  ]);
  const stepsBy = new Map(stepCounts.map(row => [row.pipelineId, Number(row.total)]));
  const sourceBy = new Map(sources.map(row => [row.id, row.name]));
  return rows.map(row => ({ ...row, stepCount: stepsBy.get(row.id) ?? 0, sourceDatasetName: row.sourceDatasetId ? sourceBy.get(row.sourceDatasetId) ?? null : null, legacy: row.workspaceId === null }));
}
