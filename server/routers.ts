import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { notifyOwner } from "./_core/notification";
import { notifyAnalysisComplete, notifyReviewChanged, withinNotificationBudget } from "./astraNotifications";
import { systemRouter } from "./_core/systemRouter";
import { bearerToken } from "./_core/supabaseAuth";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { mockRiskEngine, type RiskLevel } from "./mockRiskEngine";
import { mayRecordReview } from "./reviewPermissions";
import { recordReview } from "./reviewStore";
import { listWorkspaceReviews, recordChangeReview } from "./reviewDb";
import { getWorkspaceLineage } from "./lineageDb";
import { generateChangeBrief, getAiActivity, getAiStatus, listChangeBriefs } from "./aiBriefDb";
import { browseConnection, createConnection, deleteConnection, getConnection, getDatasetSource, importConnectionObject, listConnections, previewConnectionObject, refreshDatasetFromSource, testDraftConnection, testSavedConnection } from "./connectorDb";
import { connectionCreateSchema, connectionTargetSchema, PG_SOURCE_TYPE, sourceObjectSchema } from "../shared/pgConnector";
import { getMonitoring } from "./monitoringDb";
import { exportWorkspaceReport, getWorkspaceReport, listReportExports } from "./reportDb";
import { createQualityCheck, listQualityChecks, qualityOverview, runQualityChecks, setQualityCheckEnabled } from "./qualityDb";
import { getIncident, listIncidents, updateIncidentStatus } from "./incidentDb";
import { CHECK_SEVERITIES, checkDefinitionSchema } from "../shared/quality";
import { REVIEW_COMMENT_MAX, REVIEW_DECISIONS } from "../shared/review";
import {
  changeWorkspaceMemberRole,
  createWorkspaceForUser,
  getWorkspaceOverview,
  inviteWorkspaceMember,
  listMyInvitations,
  respondToInvitation,
  revokeInvitation,
  listWorkspacesForUser,
  getWorkspaceViews,
  removeWorkspaceMember,
  searchWorkspaceEntities,
  updateWorkspaceEnvironment,
  recordRecentView,
  listRecentViews,
  listSavedQueries,
  createSavedQuery,
  recordQueryRun,
  listQueryRuns,
  listIngestionAttempts,
  createIngestionAttempt,
  database,
} from "./workspaceDb";
import {
  browsePostgresTables,
  createFixturePipeline,
  getFixtureDataset,
  getFixtureDatasetStats,
  listFixtureDatasets,
  listFixturePipelines,
  listFixtureRuns,
  runFixturePipeline,
  testPostgresConnection,
  getFixtureDashboardMetrics,
  importFixturePostgresTable,
} from "./realDataFlow";
import { authorizeFixtureWorkspace } from "./fixtureAuthorization";
import { getDataset, getDatasetRows, getDatasetStats, importCsvDataset, listDatasets } from "./datasetDb";
import { createProject, listProjects } from "./projectDb";
import { createPipeline, getPipeline, listPipelines, updatePipeline } from "./pipelineDb";
import { getPipelineRun, listPipelineRuns, startPipelineRun } from "./pipelineRunDb";
import { analyzeProposedPipelineChange, getChange, listChanges, listRiskAnalyses, reanalyzeChange } from "./changeDb";
import { DESTINATION_MODES, PIPELINE_LIMITS, pipelineStepsSchema } from "../shared/pipelineDefinition";
import { DATASET_LIMITS } from "../shared/datasetProfile";

const changeInput = z.object({
  title: z.string().trim().min(3).max(160),
  source: z.string().trim().min(1).max(50000),
  changeType: z.enum(["SQL", "PYTHON", "YAML", "SCHEMA", "CONFIG", "GITHUB_PR"]),
});

const reviewInput = z.object({
  changeId: z.string().min(3).max(64),
  decision: z.enum(["APPROVED", "BLOCKED", "CHANGES_REQUESTED"]),
  comment: z.string().trim().max(2000).optional(),
  riskLevel: z.enum(["SAFE", "MEDIUM", "HIGH", "CRITICAL"]),
});

const workspaceIdInput = z.object({ workspaceId: z.number().int().positive() });
/** Viewer's UTC offset in minutes (IST = 330) so daily charts use local calendar days. */
const utcOffsetInput = z.number().int().min(-840).max(840).default(0);
const pipelineDefinitionInput = workspaceIdInput.extend({
  name: z.string().trim().min(3).max(PIPELINE_LIMITS.maxName),
  sourceDatasetId: z.number().int().positive(),
  destinationMode: z.enum(DESTINATION_MODES),
  destinationDatasetId: z.number().int().positive().nullish(),
  steps: pipelineStepsSchema,
});
const workspaceRoleInput = z.enum(["admin", "developer", "reviewer", "viewer"]);
const recentEntityInput = z.object({ entityType: z.enum(["project", "dataset", "pipeline"]), entityId: z.string().min(1).max(64), entityLabel: z.string().trim().min(1).max(160) });
const savedQueryInput = z.object({ workspaceId: z.number().int().positive(), datasetId: z.number().int().positive(), name: z.string().trim().min(2).max(160), sqlText: z.string().trim().min(1).max(10000) });
const queryRunInput = z.object({ workspaceId: z.number().int().positive(), queryId: z.number().int().positive(), rowCount: z.number().int().min(0).max(100000000), durationMs: z.number().int().min(0).max(600000) });
const ingestionInput = z.object({ workspaceId: z.number().int().positive(), datasetName: z.string().trim().min(2).max(160), sourceType: z.string().trim().min(2).max(80), status: z.enum(["pending", "complete", "failed"]).optional(), rowsIngested: z.number().int().min(0).max(100000000).optional() });

export const appRouter = router({
  system: systemRouter,
  auth: router({
    // The Supabase Auth identity behind the bearer token (no database lookup). Null when signed out.
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  changeIntelligence: router({
    // ---- Phase 4: real, persisted path (pipeline-impact engine; no mock fallback) ----
    analyzePipelineChange: protectedProcedure.input(workspaceIdInput.extend({
      pipelineId: z.number().int().positive().nullish(),
      baseVersion: z.string().regex(/^[0-9a-f]{16}$/).nullish(),
      definition: pipelineDefinitionInput.omit({ workspaceId: true }),
    })).mutation(({ ctx, input }) => analyzeProposedPipelineChange(ctx.user, input)),
    reanalyze: protectedProcedure.input(workspaceIdInput.extend({ changeId: z.number().int().positive() })).mutation(({ ctx, input }) => reanalyzeChange(ctx.user, input.workspaceId, input.changeId)),
    changes: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => listChanges(ctx.user, input.workspaceId, bearerToken(ctx.req))),
    change: protectedProcedure.input(workspaceIdInput.extend({ changeId: z.number().int().positive() })).query(({ ctx, input }) => getChange(ctx.user, input.workspaceId, input.changeId, bearerToken(ctx.req))),
    riskAnalyses: protectedProcedure.input(workspaceIdInput.extend({ scope: z.enum(["active", "all"]) })).query(({ ctx, input }) => listRiskAnalyses(ctx.user, input.workspaceId, input.scope)),
    // ---- Simulated sandbox (free-text SQL). Deterministic mock engine, never persisted, labelled SIMULATED. ----
    analyze: publicProcedure.input(changeInput).mutation(async ({ ctx, input }) => {
      const analysis = mockRiskEngine(input);
      // Signed-out preview visitors may still run the simulated engine, but only
      // authenticated users can trigger an owner notification (prevents anonymous spam).
      const notificationDispatched = ctx.user ? await withinNotificationBudget(notifyAnalysisComplete(notifyOwner, input.title, analysis)) : false;
      return { ...analysis, notificationDispatched };
    }),
    // ---- Phase 5: persisted review decisions (reviews table), workspace-role authorization ----
    recordReview: protectedProcedure.input(workspaceIdInput.extend({
      changeId: z.number().int().positive(),
      analysisId: z.number().int().positive(),
      decision: z.enum(REVIEW_DECISIONS),
      comment: z.string().max(REVIEW_COMMENT_MAX).nullish(),
    })).mutation(({ ctx, input }) => recordChangeReview(ctx.user, input, bearerToken(ctx.req))),
    reviews: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => listWorkspaceReviews(ctx.user, input.workspaceId, bearerToken(ctx.req))),
    // ---- SIMULATED sandbox review (in-memory reviewStore, global role). Not authoritative; never shown as history. ----
    recordSandboxReview: protectedProcedure.input(reviewInput).mutation(async ({ ctx, input }) => {
      if (!mayRecordReview(ctx.user.role)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only reviewers and administrators may record a decision.",
        });
      }
      const record = recordReview({
        changeId: input.changeId,
        decision: input.decision,
        comment: input.comment,
        reviewerId: ctx.user.id,
        reviewerName: ctx.user.name ?? "ASTRA reviewer",
        riskLevel: input.riskLevel as RiskLevel,
        createdAt: Date.now(),
      });
      const notificationDispatched = await withinNotificationBudget(notifyReviewChanged(notifyOwner, record));
      return { ...record, notificationDispatched };
    }),
  }),
  dataset: router({
    list: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => listDatasets(ctx.user, input.workspaceId)),
    get: protectedProcedure.input(workspaceIdInput.extend({ datasetId: z.number().int().positive() })).query(({ ctx, input }) => getDataset(ctx.user, input.workspaceId, input.datasetId)),
    rows: protectedProcedure.input(workspaceIdInput.extend({ datasetId: z.number().int().positive(), offset: z.number().int().min(0).max(DATASET_LIMITS.maxRows).optional(), limit: z.number().int().min(1).max(500).optional() }))
      .query(({ ctx, input }) => getDatasetRows(ctx.user, input.workspaceId, input.datasetId, { offset: input.offset, limit: input.limit })),
    stats: protectedProcedure.input(workspaceIdInput.extend({ datasetId: z.number().int().positive() })).query(({ ctx, input }) => getDatasetStats(ctx.user, input.workspaceId, input.datasetId)),
    importCsv: protectedProcedure.input(workspaceIdInput.extend({
      name: z.string().trim().min(2).max(160).regex(/^[\w .-]+$/, "Use letters, numbers, spaces, dots, dashes or underscores."),
      csvText: z.string().min(1).max(DATASET_LIMITS.maxCsvChars),
      fileName: z.string().trim().max(255).optional(),
    })).mutation(({ ctx, input }) => importCsvDataset(ctx.user, input)),
  }),
  /** Phase 9 — live, read-only external PostgreSQL. */
  connector: router({
    list: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => listConnections(ctx.user, input.workspaceId)),
    get: protectedProcedure.input(workspaceIdInput.extend({ connectionId: z.number().int().positive() })).query(({ ctx, input }) => getConnection(ctx.user, input.workspaceId, input.connectionId)),
    testDraft: protectedProcedure.input(workspaceIdInput.merge(connectionTargetSchema)).mutation(({ ctx, input }) => testDraftConnection(ctx.user, input)),
    create: protectedProcedure.input(workspaceIdInput.merge(connectionCreateSchema)).mutation(({ ctx, input }) => createConnection(ctx.user, input)),
    test: protectedProcedure.input(workspaceIdInput.extend({ connectionId: z.number().int().positive() })).mutation(({ ctx, input }) => testSavedConnection(ctx.user, input.workspaceId, input.connectionId)),
    remove: protectedProcedure.input(workspaceIdInput.extend({ connectionId: z.number().int().positive() })).mutation(({ ctx, input }) => deleteConnection(ctx.user, input.workspaceId, input.connectionId)),
    browse: protectedProcedure.input(workspaceIdInput.extend({ connectionId: z.number().int().positive() })).query(({ ctx, input }) => browseConnection(ctx.user, input.workspaceId, input.connectionId)),
    preview: protectedProcedure.input(workspaceIdInput.merge(sourceObjectSchema).extend({ connectionId: z.number().int().positive() })).query(({ ctx, input }) => previewConnectionObject(ctx.user, input)),
    importObject: protectedProcedure.input(workspaceIdInput.merge(sourceObjectSchema).extend({
      connectionId: z.number().int().positive(),
      datasetName: z.string().trim().min(2).max(160).regex(/^[\w .-]+$/, "Use letters, numbers, spaces, dots, dashes or underscores."),
    })).mutation(({ ctx, input }) => importConnectionObject(ctx.user, input)),
    datasetSource: protectedProcedure.input(workspaceIdInput.extend({ datasetId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      const dataset = await getDataset(ctx.user, input.workspaceId, input.datasetId); // authorizes + scopes to the workspace
      if (dataset.sourceType !== PG_SOURCE_TYPE) return { available: false as const, reason: "not_external" as const };
      // Connection details (host, database) are for roles that may use connections.
      const role = (await listWorkspacesForUser(ctx.user)).find(item => item.id === input.workspaceId)?.role;
      if (!role || !["owner", "admin", "developer"].includes(role)) return { available: false as const, reason: "restricted" as const };
      return getDatasetSource(await database(), dataset.id);
    }),
    refreshDataset: protectedProcedure.input(workspaceIdInput.extend({ datasetId: z.number().int().positive() })).mutation(({ ctx, input }) => refreshDatasetFromSource(ctx.user, input.workspaceId, input.datasetId)),
  }),
  /** Phase 10 — advisory AI review briefs (server-side model calls only). */
  ai: router({
    status: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => getAiStatus(ctx.user, input.workspaceId)),
    activity: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => getAiActivity(ctx.user, input.workspaceId)),
    changeBriefs: protectedProcedure.input(workspaceIdInput.extend({ changeId: z.number().int().positive() })).query(({ ctx, input }) => listChangeBriefs(ctx.user, input.workspaceId, input.changeId)),
    generateBrief: protectedProcedure.input(workspaceIdInput.extend({ changeId: z.number().int().positive(), analysisId: z.number().int().positive().optional(), regenerate: z.boolean().optional() }))
      .mutation(({ ctx, input }) => generateChangeBrief(ctx.user, input)),
  }),
  pipeline: router({
    list: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => listPipelines(ctx.user, input.workspaceId)),
    get: protectedProcedure.input(workspaceIdInput.extend({ pipelineId: z.number().int().positive() })).query(({ ctx, input }) => getPipeline(ctx.user, input.workspaceId, input.pipelineId)),
    create: protectedProcedure.input(pipelineDefinitionInput).mutation(({ ctx, input }) => createPipeline(ctx.user, input)),
    update: protectedProcedure.input(pipelineDefinitionInput.extend({ pipelineId: z.number().int().positive(), baseVersion: z.string().regex(/^[0-9a-f]{16}$/) }))
      .mutation(({ ctx, input }) => updatePipeline(ctx.user, input)),
    run: protectedProcedure.input(workspaceIdInput.extend({ pipelineId: z.number().int().positive() })).mutation(({ ctx, input }) => startPipelineRun(ctx.user, input)),
    runs: protectedProcedure.input(workspaceIdInput.extend({ pipelineId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).optional() }))
      .query(({ ctx, input }) => listPipelineRuns(ctx.user, input.workspaceId, { pipelineId: input.pipelineId, limit: input.limit })),
    getRun: protectedProcedure.input(workspaceIdInput.extend({ runId: z.number().int().positive() })).query(({ ctx, input }) => getPipelineRun(ctx.user, input.workspaceId, input.runId)),
  }),
  // ---- Phase 7: operations (monitoring, data quality, incidents) from stored records ----
  monitoring: router({
    summary: protectedProcedure.input(workspaceIdInput.extend({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30), utcOffsetMinutes: utcOffsetInput }))
      .query(({ ctx, input }) => getMonitoring(ctx.user, input.workspaceId, input.days, new Date(), input.utcOffsetMinutes)),
  }),
  // ---- Phase 8: dashboard & reports — one KPI builder for the Overview, the report and its export ----
  reports: router({
    workspace: protectedProcedure.input(workspaceIdInput.extend({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30), utcOffsetMinutes: utcOffsetInput })).query(({ ctx, input }) => getWorkspaceReport(ctx.user, input.workspaceId, input.days, new Date(), input.utcOffsetMinutes)),
    exportCsv: protectedProcedure.input(workspaceIdInput.extend({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30), utcOffsetMinutes: utcOffsetInput })).mutation(({ ctx, input }) => exportWorkspaceReport(ctx.user, input.workspaceId, input.days, new Date(), input.utcOffsetMinutes)),
    exports: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => listReportExports(ctx.user, input.workspaceId)),
  }),
  quality: router({
    overview: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => qualityOverview(ctx.user, input.workspaceId)),
    checks: protectedProcedure.input(workspaceIdInput.extend({ datasetId: z.number().int().positive().nullish() })).query(({ ctx, input }) => listQualityChecks(ctx.user, input.workspaceId, input.datasetId)),
    createCheck: protectedProcedure.input(workspaceIdInput.extend({ datasetId: z.number().int().positive(), severity: z.enum(CHECK_SEVERITIES), definition: checkDefinitionSchema }))
      .mutation(({ ctx, input }) => createQualityCheck(ctx.user, input)),
    setEnabled: protectedProcedure.input(workspaceIdInput.extend({ checkId: z.number().int().positive(), enabled: z.boolean() })).mutation(({ ctx, input }) => setQualityCheckEnabled(ctx.user, input)),
    run: protectedProcedure.input(workspaceIdInput.extend({ datasetId: z.number().int().positive() })).mutation(({ ctx, input }) => runQualityChecks(ctx.user, input)),
  }),
  incidents: router({
    list: protectedProcedure.input(workspaceIdInput.extend({ filter: z.enum(["active", "all"]).default("active") })).query(({ ctx, input }) => listIncidents(ctx.user, input.workspaceId, input.filter)),
    get: protectedProcedure.input(workspaceIdInput.extend({ incidentId: z.number().int().positive() })).query(({ ctx, input }) => getIncident(ctx.user, input.workspaceId, input.incidentId, bearerToken(ctx.req))),
    update: protectedProcedure.input(workspaceIdInput.extend({ incidentId: z.number().int().positive(), action: z.enum(["acknowledge", "resolve"]), note: z.string().max(2000).nullish() }))
      .mutation(({ ctx, input }) => updateIncidentStatus(ctx.user, input)),
  }),
  lineage: router({
    graph: protectedProcedure.input(workspaceIdInput.extend({ focus: z.string().regex(/^(dataset|pipeline):\d+$/).nullish() }))
      .query(({ ctx, input }) => getWorkspaceLineage(ctx.user, input.workspaceId, input.focus)),
  }),
  project: router({
    list: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => listProjects(ctx.user, input.workspaceId)),
    create: protectedProcedure.input(workspaceIdInput.extend({ name: z.string().trim().min(3).max(160), description: z.string().trim().max(1000).optional(), environment: z.enum(["Production", "Staging", "Development"]) }))
      .mutation(({ ctx, input }) => createProject(ctx.user, input.workspaceId, input)),
  }),
  workspace: router({
    list: protectedProcedure.query(({ ctx }) => listWorkspacesForUser(ctx.user)),
    search: protectedProcedure.input(workspaceIdInput.extend({ query: z.string().trim().min(1).max(120) })).query(({ ctx, input }) => searchWorkspaceEntities(ctx.user, input.workspaceId, input.query)),
    views: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => getWorkspaceViews(ctx.user, input.workspaceId)),
    overview: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => getWorkspaceOverview(ctx.user, input.workspaceId, bearerToken(ctx.req))),
    create: protectedProcedure.input(z.object({ name: z.string().trim().min(3).max(160), description: z.string().trim().max(1000).optional() }))
      .mutation(({ ctx, input }) => createWorkspaceForUser(ctx.user, input)),
    updateEnvironment: protectedProcedure.input(workspaceIdInput.extend({ technologies: z.array(z.string().trim().min(2).max(80)).max(9) }))
      .mutation(({ ctx, input }) => updateWorkspaceEnvironment(ctx.user, input.workspaceId, Array.from(new Set(input.technologies)))),
    invite: protectedProcedure.input(workspaceIdInput.extend({ email: z.string().trim().email().max(320), role: workspaceRoleInput }))
      .mutation(({ ctx, input }) => inviteWorkspaceMember(ctx.user, input.workspaceId, input)),
    myInvitations: protectedProcedure.query(({ ctx }) => listMyInvitations(ctx.user)),
    respondToInvitation: protectedProcedure.input(z.object({ invitationId: z.number().int().positive(), accept: z.boolean() }))
      .mutation(({ ctx, input }) => respondToInvitation(ctx.user, input.invitationId, input.accept)),
    revokeInvitation: protectedProcedure.input(workspaceIdInput.extend({ invitationId: z.number().int().positive() }))
      .mutation(({ ctx, input }) => revokeInvitation(ctx.user, input.workspaceId, input.invitationId)),
    changeMemberRole: protectedProcedure.input(workspaceIdInput.extend({ memberId: z.number().int().positive(), role: workspaceRoleInput }))
      .mutation(({ ctx, input }) => changeWorkspaceMemberRole(ctx.user, input.workspaceId, input.memberId, input.role)),
    removeMember: protectedProcedure.input(workspaceIdInput.extend({ memberId: z.number().int().positive() }))
      .mutation(({ ctx, input }) => removeWorkspaceMember(ctx.user, input.workspaceId, input.memberId)),
    recordRecent: protectedProcedure.input(workspaceIdInput.merge(recentEntityInput)).mutation(({ ctx, input }) => recordRecentView(ctx.user, input.workspaceId, input)),
    recents: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => listRecentViews(ctx.user, input.workspaceId)),
    savedQueries: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => listSavedQueries(ctx.user, input.workspaceId)),
    createSavedQuery: protectedProcedure.input(savedQueryInput).mutation(({ ctx, input }) => createSavedQuery(ctx.user, input.workspaceId, input)),
    recordQueryRun: protectedProcedure.input(queryRunInput).mutation(({ ctx, input }) => recordQueryRun(ctx.user, input.workspaceId, input)),
    queryRuns: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => listQueryRuns(ctx.user, input.workspaceId)),
    ingestionAttempts: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => listIngestionAttempts(ctx.user, input.workspaceId)),
    createIngestionAttempt: protectedProcedure.input(ingestionInput).mutation(({ ctx, input }) => createIngestionAttempt(ctx.user, input.workspaceId, input)),
    fixtureDatasets: protectedProcedure.input(workspaceIdInput).query(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return listFixtureDatasets(input.workspaceId); }),
    fixtureDataset: protectedProcedure.input(workspaceIdInput.extend({ datasetId: z.number().int().positive() })).query(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return getFixtureDataset(input.workspaceId, input.datasetId); }),
    fixtureDatasetStats: protectedProcedure.input(workspaceIdInput.extend({ datasetId: z.number().int().positive() })).query(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return getFixtureDatasetStats(input.workspaceId, input.datasetId); }),
    testPostgresConnection: protectedProcedure.input(workspaceIdInput.extend({ host: z.string().trim().min(1).max(255), port: z.number().int().min(1).max(65535), databaseName: z.string().trim().min(1).max(160), username: z.string().trim().min(1).max(160), ssl: z.boolean() })).mutation(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return testPostgresConnection(input); }),
    /** Kept for existing callers; delegates to the live connector (tests the connection, then stores it encrypted). */
    createPostgresConnection: protectedProcedure.input(workspaceIdInput.merge(connectionCreateSchema)).mutation(({ ctx, input }) => createConnection(ctx.user, input)),
    browsePostgresTables: protectedProcedure.input(workspaceIdInput).query(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return browsePostgresTables(); }),
    importPostgresTable: protectedProcedure.input(workspaceIdInput.extend({ tableName: z.string().trim().min(1).max(160) })).mutation(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return importFixturePostgresTable(input.workspaceId, input.tableName); }),
    fixturePipelines: protectedProcedure.input(workspaceIdInput).query(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return listFixturePipelines(input.workspaceId); }),
    createFixturePipeline: protectedProcedure.input(workspaceIdInput.extend({ name: z.string().trim().min(3).max(160), sourceDatasetId: z.number().int().positive(), destinationMode: z.enum(["new_dataset", "overwrite_existing"]), destinationDatasetId: z.number().int().positive().optional(), steps: pipelineStepsSchema })).mutation(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return createFixturePipeline({ ...input, steps: input.steps as never[] }); }),
    runFixturePipeline: protectedProcedure.input(workspaceIdInput.extend({ pipelineId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return runFixturePipeline(input.workspaceId, input.pipelineId); }),
    fixtureRuns: protectedProcedure.input(workspaceIdInput.extend({ pipelineId: z.number().int().positive().optional() })).query(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return listFixtureRuns(input.workspaceId, input.pipelineId); }),
    fixtureDashboardMetrics: protectedProcedure.input(workspaceIdInput).query(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return getFixtureDashboardMetrics(input.workspaceId); }),
  }),
});

export type AppRouter = typeof appRouter;
