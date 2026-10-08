import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * ASTRA application data model — Supabase Postgres.
 *
 * Mirrors the live Supabase schema (supabase/migrations/20260924010000_astra_app_schema.sql,
 * "Astra Supabase Schema Agent Reference"). The database is created and changed by those SQL
 * migrations; this file only describes it to Drizzle. Do NOT run `drizzle-kit push` against
 * Supabase.
 *
 * Identity: Supabase Auth (auth.users) is the only user store. Every user column is a uuid
 * holding auth.users.id; there is no application users table.
 */

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const ref = (name: string) => bigint(name, { mode: "number" });
const createdAt = (name = "created_at") => timestamp(name, { withTimezone: true }).defaultNow().notNull();

export const astraRoles = ["admin", "developer", "reviewer"] as const;
export const reviewDecisions = ["approved", "blocked", "changes_requested"] as const;
export const workspaceRoles = ["owner", "admin", "developer", "reviewer", "viewer"] as const;
export const workspaceInvitationStatuses = ["pending", "accepted", "expired", "revoked"] as const;

export const astraRoleEnum = pgEnum("astra_role", astraRoles);
export const workspaceRoleEnum = pgEnum("workspace_role", workspaceRoles);
export const invitationStatusEnum = pgEnum("invitation_status", workspaceInvitationStatuses);
export const reviewDecisionEnum = pgEnum("review_decision", reviewDecisions);

export const organizations = pgTable("organizations", {
  id: id(),
  name: varchar("name", { length: 160 }).notNull(),
  slug: varchar("slug", { length: 80 }).notNull().unique(),
  createdAt: createdAt(),
});

export const organizationMembers = pgTable("organization_members", {
  id: id(),
  organizationId: ref("organization_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: astraRoleEnum("role").notNull(),
  createdAt: createdAt(),
}, table => [unique("organization_members_org_user_key").on(table.organizationId, table.userId)]);

export const workspaces = pgTable("workspaces", {
  id: id(),
  organizationId: ref("organization_id").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [unique("workspaces_org_name_key").on(table.organizationId, table.name)]);

export const workspaceMembers = pgTable("workspace_members", {
  id: id(),
  workspaceId: ref("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: workspaceRoleEnum("role").notNull(),
  joinedAt: createdAt("joined_at"),
}, table => [unique("workspace_members_workspace_user_key").on(table.workspaceId, table.userId)]);

export const workspaceInvitations = pgTable("workspace_invitations", {
  id: id(),
  workspaceId: ref("workspace_id").notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  role: workspaceRoleEnum("role").notNull(),
  invitedBy: uuid("invited_by"),
  status: invitationStatusEnum("status").default("pending").notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, table => [unique("workspace_invitations_workspace_email_key").on(table.workspaceId, table.email)]);

export const workspaceDataEnvironment = pgTable("workspace_data_environment", {
  id: id(),
  workspaceId: ref("workspace_id").notNull(),
  technology: varchar("technology", { length: 80 }).notNull(),
  // created_at is not listed in the schema reference; the app never reads it, so it is not declared.
}, table => [unique("workspace_data_environment_key").on(table.workspaceId, table.technology)]);

export const projects = pgTable("projects", {
  id: id(),
  organizationId: ref("organization_id").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  environment: varchar("environment", { length: 32 }).notNull(),
  createdAt: createdAt(),
}, table => [unique("projects_org_name_key").on(table.organizationId, table.name)]);

export const datasets = pgTable("datasets", {
  id: id(),
  organizationId: ref("organization_id").notNull(),
  // NULL = legacy organization-wide dataset; datasets created through Astra always have one.
  workspaceId: ref("workspace_id"),
  projectId: ref("project_id"),
  name: varchar("name", { length: 160 }).notNull(),
  ownerId: uuid("owner_id"),
  sourceType: varchar("source_type", { length: 48 }).notNull(),
  qualityScore: integer("quality_score"),
  rowCount: integer("row_count").default(0).notNull(),
  createdAt: createdAt(),
}, table => [
  unique("datasets_workspace_name_key").on(table.workspaceId, table.name),
  index("datasets_workspace_idx").on(table.workspaceId),
]);

export const datasetColumns = pgTable("dataset_columns", {
  id: id(),
  datasetId: ref("dataset_id").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  dataType: varchar("data_type", { length: 32 }).notNull(),
  nullable: boolean("nullable").default(true).notNull(),
  uniqueValues: integer("unique_values").default(0).notNull(),
  nullPercent: integer("null_percent").default(0).notNull(),
}, table => [unique("dataset_columns_dataset_name_key").on(table.datasetId, table.name)]);

export const datasetRows = pgTable("dataset_rows", {
  id: id(),
  datasetId: ref("dataset_id").notNull(),
  rowIndex: integer("row_index").notNull(),
  data: jsonb("data").notNull(),
}, table => [unique("dataset_rows_dataset_index_key").on(table.datasetId, table.rowIndex)]);

export const datasetConnections = pgTable("dataset_connections", {
  id: id(),
  workspaceId: ref("workspace_id").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  type: varchar("type", { length: 32 }).notNull(),
  host: varchar("host", { length: 255 }).notNull(),
  port: integer("port").notNull(),
  databaseName: varchar("database_name", { length: 160 }).notNull(),
  username: varchar("username", { length: 160 }).notNull(),
  encryptedPassword: text("encrypted_password").notNull(),
  sslMode: varchar("ssl_mode", { length: 32 }).notNull(),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});

export const ingestionAttempts = pgTable("ingestion_attempts", {
  id: id(),
  workspaceId: ref("workspace_id").notNull(),
  datasetName: varchar("dataset_name", { length: 160 }).notNull(),
  sourceType: varchar("source_type", { length: 80 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  rowsIngested: integer("rows_ingested").default(0).notNull(),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});

// Note: the live schema has no pipelines.created_at column (per the schema reference), so none is declared.
export const pipelines = pgTable("pipelines", {
  id: id(),
  organizationId: ref("organization_id").notNull(),
  workspaceId: ref("workspace_id"),
  projectId: ref("project_id"),
  name: varchar("name", { length: 160 }).notNull(),
  ownerId: uuid("owner_id"),
  status: varchar("status", { length: 32 }).notNull(),
  sourceDatasetId: ref("source_dataset_id"),
  destinationMode: varchar("destination_mode", { length: 32 }),
  destinationDatasetId: ref("destination_dataset_id"),
  successRate: integer("success_rate"),
  avgDurationSeconds: integer("avg_duration_seconds"),
  failureCount: integer("failure_count").default(0).notNull(),
  dag: jsonb("dag"),
});

export const pipelineSteps = pgTable("pipeline_steps", {
  id: id(),
  pipelineId: ref("pipeline_id").notNull(),
  stepOrder: integer("step_order").notNull(),
  operation: varchar("operation", { length: 32 }).notNull(),
  config: jsonb("config").notNull(),
}, table => [unique("pipeline_steps_order_key").on(table.pipelineId, table.stepOrder)]);

export const pipelineRuns = pgTable("pipeline_runs", {
  id: id(),
  pipelineId: ref("pipeline_id").notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  rowsIn: integer("rows_in").default(0).notNull(),
  rowsOut: integer("rows_out").default(0).notNull(),
  coercionFailures: integer("coercion_failures").default(0).notNull(),
  durationMs: integer("duration_ms").default(0).notNull(),
  errorMessage: text("error_message"),
  logs: jsonb("logs"),
  startedAt: createdAt("started_at"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const changes = pgTable("changes", {
  id: id(),
  organizationId: ref("organization_id").notNull(),
  // Added by supabase/migrations/20260924020000_astra_phase4_change_scope.sql (Phase 4).
  workspaceId: ref("workspace_id"),
  pipelineId: ref("pipeline_id"),
  projectId: ref("project_id"),
  authorId: uuid("author_id"),
  title: varchar("title", { length: 160 }).notNull(),
  changeType: varchar("change_type", { length: 32 }).notNull(),
  source: text("source").notNull(),
  createdAt: createdAt(),
});

export const riskAnalyses = pgTable("risk_analyses", {
  id: id(),
  organizationId: ref("organization_id").notNull(),
  changeId: ref("change_id").notNull(),
  score: integer("score").notNull(),
  level: varchar("level", { length: 16 }).notNull(),
  engineVersion: varchar("engine_version", { length: 48 }).notNull(),
  result: jsonb("result").notNull(),
  createdAt: createdAt(),
});

export const reviews = pgTable("reviews", {
  id: id(),
  organizationId: ref("organization_id").notNull(),
  changeId: ref("change_id").notNull(),
  reviewerId: uuid("reviewer_id"),
  decision: reviewDecisionEnum("decision").notNull(),
  comment: text("comment"),
  createdAt: createdAt(),
});

export const recentlyViewed = pgTable("recently_viewed", {
  id: id(),
  userId: uuid("user_id").notNull(),
  workspaceId: ref("workspace_id").notNull(),
  entityType: varchar("entity_type", { length: 32 }).notNull(),
  entityId: varchar("entity_id", { length: 64 }).notNull(),
  entityLabel: varchar("entity_label", { length: 160 }).notNull(),
  viewedAt: createdAt("viewed_at"),
}, table => [unique("recently_viewed_user_entity_key").on(table.userId, table.workspaceId, table.entityType, table.entityId)]);

export const savedQueries = pgTable("saved_queries", {
  id: id(),
  workspaceId: ref("workspace_id").notNull(),
  datasetId: ref("dataset_id").notNull(),
  createdBy: uuid("created_by"),
  name: varchar("name", { length: 160 }).notNull(),
  sqlText: text("sql_text").notNull(),
  createdAt: createdAt(),
});

export const queryRuns = pgTable("query_runs", {
  id: id(),
  queryId: ref("query_id").notNull(),
  workspaceId: ref("workspace_id").notNull(),
  runBy: uuid("run_by"),
  rowCount: integer("row_count").default(0).notNull(),
  durationMs: integer("duration_ms").default(0).notNull(),
  runAt: createdAt("run_at"),
});

export const auditLogs = pgTable("audit_logs", {
  id: id(),
  organizationId: ref("organization_id").notNull(),
  workspaceId: ref("workspace_id"),
  actorId: uuid("actor_id").notNull(),
  action: varchar("action", { length: 96 }).notNull(),
  resourceType: varchar("resource_type", { length: 64 }).notNull(),
  resourceId: varchar("resource_id", { length: 64 }),
  result: varchar("result", { length: 32 }).notNull(),
  metadata: jsonb("metadata"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- Phase 7
// Added by supabase/migrations/20260930000000_astra_phase7_quality_incidents.sql.

export const qualityChecks = pgTable("quality_checks", {
  id: id(),
  organizationId: ref("organization_id").notNull(),
  workspaceId: ref("workspace_id").notNull(),
  datasetId: ref("dataset_id").notNull(),
  checkType: varchar("check_type", { length: 32 }).notNull(),
  columnName: varchar("column_name", { length: 160 }),
  config: jsonb("config").notNull(),
  severity: varchar("severity", { length: 16 }).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
}, table => [index("quality_checks_dataset_idx").on(table.datasetId), index("quality_checks_workspace_idx").on(table.workspaceId)]);

export const qualityResults = pgTable("quality_results", {
  id: id(),
  checkId: ref("check_id").notNull(),
  datasetId: ref("dataset_id").notNull(),
  workspaceId: ref("workspace_id").notNull(),
  runId: ref("run_id"),
  trigger: varchar("trigger", { length: 16 }).notNull(),
  status: varchar("status", { length: 8 }).notNull(),
  evaluatedRows: integer("evaluated_rows").default(0).notNull(),
  failingRows: integer("failing_rows").default(0).notNull(),
  observed: jsonb("observed"),
  evaluatedBy: uuid("evaluated_by"),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const incidents = pgTable("incidents", {
  id: id(),
  organizationId: ref("organization_id").notNull(),
  workspaceId: ref("workspace_id").notNull(),
  sourceType: varchar("source_type", { length: 32 }).notNull(),
  sourceKey: varchar("source_key", { length: 96 }).notNull(),
  pipelineId: ref("pipeline_id"),
  datasetId: ref("dataset_id"),
  qualityCheckId: ref("quality_check_id"),
  firstRunId: ref("first_run_id"),
  lastRunId: ref("last_run_id"),
  lastResultId: ref("last_result_id"),
  title: varchar("title", { length: 200 }).notNull(),
  detail: text("detail"),
  severity: varchar("severity", { length: 16 }).notNull(),
  status: varchar("status", { length: 16 }).default("open").notNull(),
  occurrences: integer("occurrences").default(1).notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  acknowledgedBy: uuid("acknowledged_by"),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  resolvedBy: uuid("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolution: varchar("resolution", { length: 16 }),
  resolutionNote: text("resolution_note"),
});

// ---------------------------------------------------------------- Phase 9
// Added by supabase/migrations/20261001000000_astra_phase9_postgres_sources.sql.

/** Provenance of a dataset imported from an external PostgreSQL connection. */
export const datasetSources = pgTable("dataset_sources", {
  datasetId: bigint("dataset_id", { mode: "number" }).primaryKey(),
  workspaceId: ref("workspace_id").notNull(),
  connectionId: ref("connection_id"),
  sourceSchema: varchar("source_schema", { length: 128 }).notNull(),
  sourceTable: varchar("source_table", { length: 128 }).notNull(),
  sourceKind: varchar("source_kind", { length: 24 }).notNull(),
  orderColumns: jsonb("order_columns").notNull(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow().notNull(),
  lastSyncedBy: uuid("last_synced_by"),
  lastSyncRows: integer("last_sync_rows").default(0).notNull(),
  syncCount: integer("sync_count").default(1).notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- Phase 10
// Added by supabase/migrations/20261002000000_astra_phase10_ai_briefs.sql.

/** Advisory, model-written review brief for one stored risk analysis. */
export const aiBriefs = pgTable("ai_briefs", {
  id: id(),
  organizationId: ref("organization_id").notNull(),
  workspaceId: ref("workspace_id").notNull(),
  changeId: ref("change_id").notNull(),
  analysisId: ref("analysis_id").notNull(),
  promptVersion: varchar("prompt_version", { length: 48 }).notNull(),
  provider: varchar("provider", { length: 24 }).notNull(),
  model: varchar("model", { length: 120 }).notNull(),
  contextHash: varchar("context_hash", { length: 64 }).notNull(),
  context: jsonb("context").notNull(),
  brief: jsonb("brief").notNull(),
  dropped: jsonb("dropped").notNull(),
  adjusted: text("adjusted"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  latencyMs: integer("latency_ms").notNull(),
  createdBy: uuid("created_by"),
  createdAt: createdAt(),
});
