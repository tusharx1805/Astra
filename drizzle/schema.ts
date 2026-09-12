import { int, json, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const astraRoles = ["admin", "developer", "reviewer"] as const;
export const reviewDecisions = ["approved", "blocked", "changes_requested"] as const;
export const workspaceRoles = ["owner", "admin", "developer", "reviewer", "viewer"] as const;
export const workspaceInvitationStatuses = ["pending", "accepted", "expired", "revoked"] as const;

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", astraRoles).default("developer").notNull(),
  organizationId: int("organizationId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const organizations = mysqlTable("organizations", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  slug: varchar("slug", { length: 80 }).notNull().unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const organizationMembers = mysqlTable("organizationMembers", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  userId: int("userId").notNull(),
  role: mysqlEnum("role", astraRoles).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("organization_user_unq").on(table.organizationId, table.userId)]);

export const workspaces = mysqlTable("workspaces", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [uniqueIndex("workspace_organization_name_unq").on(table.organizationId, table.name)]);

export const workspaceMembers = mysqlTable("workspaceMembers", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  userId: int("userId").notNull(),
  role: mysqlEnum("role", workspaceRoles).notNull(),
  joinedAt: timestamp("joinedAt").defaultNow().notNull(),
}, table => [uniqueIndex("workspace_user_unq").on(table.workspaceId, table.userId)]);

export const workspaceInvitations = mysqlTable("workspaceInvitations", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  role: mysqlEnum("role", ["admin", "developer", "reviewer", "viewer"]).notNull(),
  invitedBy: int("invitedBy").notNull(),
  status: mysqlEnum("status", workspaceInvitationStatuses).default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
}, table => [uniqueIndex("workspace_invite_email_unq").on(table.workspaceId, table.email)]);

export const workspaceDataEnvironment = mysqlTable("workspaceDataEnvironment", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  technology: varchar("technology", { length: 80 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("workspace_technology_unq").on(table.workspaceId, table.technology)]);

export const projects = mysqlTable("projects", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  environment: varchar("environment", { length: 32 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const datasets = mysqlTable("datasets", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  projectId: int("projectId").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  ownerId: int("ownerId"),
  sourceType: varchar("sourceType", { length: 48 }).notNull(),
  qualityScore: int("qualityScore"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const pipelines = mysqlTable("pipelines", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  projectId: int("projectId").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  ownerId: int("ownerId"),
  status: varchar("status", { length: 32 }).notNull(),
  sourceDatasetId: int("sourceDatasetId"),
  destinationMode: varchar("destinationMode", { length: 32 }),
  destinationDatasetId: int("destinationDatasetId"),
  successRate: int("successRate"),
  avgDurationSeconds: int("avgDurationSeconds"),
  failureCount: int("failureCount").default(0).notNull(),
  dag: json("dag"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const changes = mysqlTable("changes", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  projectId: int("projectId").notNull(),
  authorId: int("authorId").notNull(),
  title: varchar("title", { length: 160 }).notNull(),
  changeType: varchar("changeType", { length: 32 }).notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const riskAnalyses = mysqlTable("riskAnalyses", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  changeId: int("changeId").notNull(),
  score: int("score").notNull(),
  level: varchar("level", { length: 16 }).notNull(),
  engineVersion: varchar("engineVersion", { length: 48 }).notNull(),
  result: json("result").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const reviews = mysqlTable("reviews", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  changeId: int("changeId").notNull(),
  reviewerId: int("reviewerId").notNull(),
  decision: mysqlEnum("decision", reviewDecisions).notNull(),
  comment: text("comment"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const recentlyViewed = mysqlTable("recently_viewed", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  workspaceId: int("workspace_id").notNull(),
  entityType: varchar("entity_type", { length: 32 }).notNull(),
  entityId: varchar("entity_id", { length: 64 }).notNull(),
  entityLabel: varchar("entity_label", { length: 160 }).notNull(),
  viewedAt: timestamp("viewed_at").defaultNow().notNull(),
}, table => [uniqueIndex("recently_viewed_user_entity_unq").on(table.userId, table.workspaceId, table.entityType, table.entityId)]);

export const savedQueries = mysqlTable("saved_queries", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspace_id").notNull(),
  datasetId: int("dataset_id").notNull(),
  createdBy: int("created_by").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  sqlText: text("sql_text").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const queryRuns = mysqlTable("query_runs", {
  id: int("id").autoincrement().primaryKey(),
  queryId: int("query_id").notNull(),
  workspaceId: int("workspace_id").notNull(),
  runBy: int("run_by").notNull(),
  rowCount: int("row_count").notNull(),
  durationMs: int("duration_ms").notNull(),
  runAt: timestamp("run_at").defaultNow().notNull(),
});

export const ingestionAttempts = mysqlTable("ingestion_attempts", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspace_id").notNull(),
  datasetName: varchar("dataset_name", { length: 160 }).notNull(),
  sourceType: varchar("source_type", { length: 80 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  rowsIngested: int("rows_ingested").default(0).notNull(),
  createdBy: int("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const datasetConnections = mysqlTable("dataset_connections", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  type: varchar("type", { length: 32 }).notNull(),
  host: varchar("host", { length: 255 }).notNull(),
  port: int("port").notNull(),
  databaseName: varchar("databaseName", { length: 160 }).notNull(),
  username: varchar("username", { length: 160 }).notNull(),
  encryptedPassword: text("encryptedPassword").notNull(),
  sslMode: varchar("sslMode", { length: 32 }).notNull(),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const datasetColumns = mysqlTable("dataset_columns", {
  id: int("id").autoincrement().primaryKey(),
  datasetId: int("datasetId").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  dataType: varchar("dataType", { length: 32 }).notNull(),
  nullable: int("nullable").notNull().default(1),
  uniqueValues: int("uniqueValues").notNull().default(0),
  nullPercent: int("nullPercent").notNull().default(0),
}, table => [uniqueIndex("dataset_column_name_unq").on(table.datasetId, table.name)]);

export const datasetRows = mysqlTable("dataset_rows", {
  id: int("id").autoincrement().primaryKey(),
  datasetId: int("datasetId").notNull(),
  rowIndex: int("rowIndex").notNull(),
  data: json("data").notNull(),
}, table => [uniqueIndex("dataset_row_index_unq").on(table.datasetId, table.rowIndex)]);

export const pipelineSteps = mysqlTable("pipeline_steps", {
  id: int("id").autoincrement().primaryKey(),
  pipelineId: int("pipelineId").notNull(),
  stepOrder: int("stepOrder").notNull(),
  operation: varchar("operation", { length: 32 }).notNull(),
  config: json("config").notNull(),
}, table => [uniqueIndex("pipeline_step_order_unq").on(table.pipelineId, table.stepOrder)]);

export const pipelineRuns = mysqlTable("pipeline_runs", {
  id: int("id").autoincrement().primaryKey(),
  pipelineId: int("pipelineId").notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  rowsIn: int("rowsIn").default(0).notNull(),
  rowsOut: int("rowsOut").default(0).notNull(),
  coercionFailures: int("coercionFailures").default(0).notNull(),
  durationMs: int("durationMs").default(0).notNull(),
  errorMessage: text("errorMessage"),
  logs: json("logs"),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
});

export const auditLogs = mysqlTable("auditLogs", {
  id: int("id").autoincrement().primaryKey(),
  organizationId: int("organizationId").notNull(),
  workspaceId: int("workspaceId"),
  actorId: int("actorId").notNull(),
  action: varchar("action", { length: 96 }).notNull(),
  resourceType: varchar("resourceType", { length: 64 }).notNull(),
  resourceId: varchar("resourceId", { length: 64 }),
  result: varchar("result", { length: 32 }).notNull(),
  metadata: json("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
