import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { notifyOwner } from "./_core/notification";
import { notifyAnalysisComplete, notifyReviewChanged } from "./astraNotifications";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { mockRiskEngine, type RiskLevel } from "./mockRiskEngine";
import { mayRecordReview } from "./reviewPermissions";
import { recordReview } from "./reviewStore";
import {
  changeWorkspaceMemberRole,
  createWorkspaceForUser,
  getWorkspaceOverview,
  inviteWorkspaceMember,
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
  createWorkspacePostgresConnection,
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
const workspaceRoleInput = z.enum(["admin", "developer", "reviewer", "viewer"]);
const recentEntityInput = z.object({ entityType: z.enum(["project", "dataset", "pipeline"]), entityId: z.string().min(1).max(64), entityLabel: z.string().trim().min(1).max(160) });
const savedQueryInput = z.object({ workspaceId: z.number().int().positive(), datasetId: z.number().int().positive(), name: z.string().trim().min(2).max(160), sqlText: z.string().trim().min(1).max(10000) });
const queryRunInput = z.object({ workspaceId: z.number().int().positive(), queryId: z.number().int().positive(), rowCount: z.number().int().min(0).max(100000000), durationMs: z.number().int().min(0).max(600000) });
const ingestionInput = z.object({ workspaceId: z.number().int().positive(), datasetName: z.string().trim().min(2).max(160), sourceType: z.string().trim().min(2).max(80), status: z.enum(["pending", "complete", "failed"]).optional(), rowsIngested: z.number().int().min(0).max(100000000).optional() });

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  changeIntelligence: router({
    analyze: publicProcedure.input(changeInput).mutation(async ({ input }) => {
      const analysis = mockRiskEngine(input);
      const notificationDispatched = await notifyAnalysisComplete(notifyOwner, input.title, analysis).catch(() => false);
      return { ...analysis, notificationDispatched };
    }),
    recordReview: protectedProcedure.input(reviewInput).mutation(async ({ ctx, input }) => {
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
      const notificationDispatched = await notifyReviewChanged(notifyOwner, record).catch(() => false);
      return { ...record, notificationDispatched };
    }),
  }),
  workspace: router({
    list: protectedProcedure.query(({ ctx }) => listWorkspacesForUser(ctx.user)),
    search: protectedProcedure.input(workspaceIdInput.extend({ query: z.string().trim().min(1).max(120) })).query(({ ctx, input }) => searchWorkspaceEntities(ctx.user, input.workspaceId, input.query)),
    views: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => getWorkspaceViews(ctx.user, input.workspaceId)),
    overview: protectedProcedure.input(workspaceIdInput).query(({ ctx, input }) => getWorkspaceOverview(ctx.user, input.workspaceId)),
    create: protectedProcedure.input(z.object({ name: z.string().trim().min(3).max(160), description: z.string().trim().max(1000).optional() }))
      .mutation(({ ctx, input }) => createWorkspaceForUser(ctx.user, input)),
    updateEnvironment: protectedProcedure.input(workspaceIdInput.extend({ technologies: z.array(z.string().trim().min(2).max(80)).max(9) }))
      .mutation(({ ctx, input }) => updateWorkspaceEnvironment(ctx.user, input.workspaceId, Array.from(new Set(input.technologies)))),
    invite: protectedProcedure.input(workspaceIdInput.extend({ email: z.string().trim().email().max(320), role: workspaceRoleInput }))
      .mutation(({ ctx, input }) => inviteWorkspaceMember(ctx.user, input.workspaceId, input)),
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
    createPostgresConnection: protectedProcedure.input(workspaceIdInput.extend({ name: z.string().trim().min(3).max(160), host: z.string().trim().min(1).max(255), port: z.number().int().min(1).max(65535), databaseName: z.string().trim().min(1).max(160), username: z.string().trim().min(1).max(160), password: z.string().min(1).max(512), sslMode: z.string().trim().min(1).max(32) })).mutation(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return createWorkspacePostgresConnection(ctx.user, input); }),
    browsePostgresTables: protectedProcedure.input(workspaceIdInput).query(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return browsePostgresTables(); }),
    importPostgresTable: protectedProcedure.input(workspaceIdInput.extend({ tableName: z.string().trim().min(1).max(160) })).mutation(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return importFixturePostgresTable(input.workspaceId, input.tableName); }),
    fixturePipelines: protectedProcedure.input(workspaceIdInput).query(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return listFixturePipelines(input.workspaceId); }),
    createFixturePipeline: protectedProcedure.input(workspaceIdInput.extend({ name: z.string().trim().min(3).max(160), sourceDatasetId: z.number().int().positive(), destinationMode: z.enum(["new_dataset", "overwrite_existing"]), destinationDatasetId: z.number().int().positive().optional(), steps: z.array(z.unknown()).max(32) })).mutation(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return createFixturePipeline({ ...input, steps: input.steps as never[] }); }),
    runFixturePipeline: protectedProcedure.input(workspaceIdInput.extend({ pipelineId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return runFixturePipeline(input.workspaceId, input.pipelineId); }),
    fixtureRuns: protectedProcedure.input(workspaceIdInput.extend({ pipelineId: z.number().int().positive().optional() })).query(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return listFixtureRuns(input.workspaceId, input.pipelineId); }),
    fixtureDashboardMetrics: protectedProcedure.input(workspaceIdInput).query(async ({ ctx, input }) => { authorizeFixtureWorkspace(input.workspaceId, (await listWorkspacesForUser(ctx.user)).map(workspace => workspace.id)); return getFixtureDashboardMetrics(input.workspaceId); }),
  }),
});

export type AppRouter = typeof appRouter;
