import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

/**
 * Phase 1 checkpoint tests against a REAL Postgres database shaped like Supabase:
 * supabase/tests/auth_stub.sql + supabase/migrations/*.sql applied.
 * Run with: TEST_DATABASE_URL=postgres://user:pass@host:5432/astra_test pnpm test
 * NEVER point this at production: it creates auth.users rows. Skipped when unset.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CSV = "customer_id,email,plan,seats,active\nC-1001,ada@example.com,pro,12,true\nC-1002,ben@example.com,starter,4,true\nC-1003,,pro,8,false\nC-1004,\"drew, jr@example.com\",enterprise,41,true\n";

describe.skipIf(!url)("Phase 1 — persisted datasets (real database)", async () => {
  const { appRouter } = await import("./routers");
  const dbModule = await import("./db");
  const { randomUUID } = await import("node:crypto");
  const schema = await import("../drizzle/schema");

  type Ctx = TrpcContext;
  const makeCtx = (user: NonNullable<Ctx["user"]>): Ctx => ({ user, req: { protocol: "https", headers: {} } as Ctx["req"], res: {} as Ctx["res"] });
  const users: Record<string, NonNullable<Ctx["user"]>> = {};
  let ownerWorkspaceA = 0;
  let ownerWorkspaceB = 0;
  let outsiderWorkspace = 0;

  // Identities are Supabase Auth users (UUIDs); there is no application users table to seed.
  async function createUser(key: string) {
    const user = { id: randomUUID(), email: `${key}-${suffix}@example.com`, name: `Phase1 ${key}`, role: "developer" as const };
    // In Supabase the user exists in auth.users because they signed up; the test stub needs the row explicitly.
    const db = (await dbModule.getDb())!;
    const username = `${key}_${suffix}`.replace(/[^a-z0-9_]/g, "_").slice(0, 30);
    await db.execute(sql`insert into auth.users (id, email, raw_user_meta_data) values (${user.id}, ${user.email}, ${JSON.stringify({ username, full_name: user.name })}::jsonb)`);
    users[key] = user;
    return user;
  }

  beforeAll(async () => {
    await createUser("owner");
    await createUser("outsider");
    await createUser("viewer");
    const owner = appRouter.createCaller(makeCtx(users.owner!));
    ownerWorkspaceA = (await owner.workspace.create({ name: `Phase1 A ${suffix}` })).id;
    ownerWorkspaceB = (await owner.workspace.create({ name: `Phase1 B ${suffix}` })).id;
    outsiderWorkspace = (await appRouter.createCaller(makeCtx(users.outsider!)).workspace.create({ name: `Outsider ${suffix}` })).id;
    // Add the viewer to workspace A directly (invitation acceptance is not implemented yet).
    const db = (await dbModule.getDb())!;
    await db.insert(schema.workspaceMembers).values({ workspaceId: ownerWorkspaceA, userId: users.viewer!.id, role: "viewer" });
  });

  let datasetId = 0;

  it("imports a CSV and reads the same dataset, columns and rows back", async () => {
    const owner = appRouter.createCaller(makeCtx(users.owner!));
    const imported = await owner.dataset.importCsv({ workspaceId: ownerWorkspaceA, name: "customer_accounts", csvText: CSV, fileName: "customers.csv" });
    datasetId = imported.id;
    expect(imported).toMatchObject({ rowCount: 4, columnCount: 5, sourceType: "CSV / Files" });

    const detail = await owner.dataset.get({ workspaceId: ownerWorkspaceA, datasetId });
    expect(detail.columns.map(column => column.name)).toEqual(["customer_id", "email", "plan", "seats", "active"]);
    expect(detail.columns.find(column => column.name === "seats")).toMatchObject({ dataType: "number", nullable: false });
    expect(detail.columns.find(column => column.name === "email")).toMatchObject({ nullable: true, nullPercent: 25 });

    const page = await owner.dataset.rows({ workspaceId: ownerWorkspaceA, datasetId, offset: 0, limit: 50 });
    expect(page.total).toBe(4);
    expect(page.rows.map(row => row.data.customer_id)).toEqual(["C-1001", "C-1002", "C-1003", "C-1004"]);
    expect(page.rows[2]!.data.email).toBeNull();
    expect(page.rows[3]!.data.email).toBe("drew, jr@example.com");

    const stats = await owner.dataset.stats({ workspaceId: ownerWorkspaceA, datasetId });
    expect(stats.columns.find(column => column.name === "seats")).toMatchObject({ min: 4, max: 41, average: 16.25 });

    const listed = await owner.dataset.list({ workspaceId: ownerWorkspaceA });
    expect(listed.find(item => item.id === datasetId)).toMatchObject({ rowCount: 4, columnCount: 5, persisted: true });

    const views = await owner.workspace.views({ workspaceId: ownerWorkspaceA });
    expect(views.datasets.some(item => item.id === datasetId)).toBe(true);
  });

  it("paginates rows by rowIndex", async () => {
    const owner = appRouter.createCaller(makeCtx(users.owner!));
    const page = await owner.dataset.rows({ workspaceId: ownerWorkspaceA, datasetId, offset: 2, limit: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ rowIndex: 2, data: { customer_id: "C-1003" } });
  });

  it("is durable: a brand-new connection (as after a server restart) sees the same rows", async () => {
    const freshClient = postgres(url!, { prepare: false, max: 1 });
    const fresh = drizzle(freshClient);
    const [dataset] = await fresh.select().from(schema.datasets).where(eq(schema.datasets.id, datasetId));
    expect(dataset).toMatchObject({ workspaceId: ownerWorkspaceA, rowCount: 4, sourceType: "CSV / Files" });
    const rows = await fresh.select().from(schema.datasetRows).where(eq(schema.datasetRows.datasetId, datasetId));
    expect(rows).toHaveLength(4);
    const attempts = await fresh.select().from(schema.ingestionAttempts).where(and(eq(schema.ingestionAttempts.workspaceId, ownerWorkspaceA), eq(schema.ingestionAttempts.datasetName, "customer_accounts")));
    expect(attempts[0]).toMatchObject({ status: "complete", rowsIngested: 4 });
    const audits = await fresh.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "DATASET_IMPORTED"), eq(schema.auditLogs.resourceId, String(datasetId))));
    expect(audits).toHaveLength(1);
  });

  it("isolates workspaces: another workspace of the same owner cannot read it", async () => {
    const owner = appRouter.createCaller(makeCtx(users.owner!));
    await expect(owner.dataset.get({ workspaceId: ownerWorkspaceB, datasetId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(owner.dataset.rows({ workspaceId: ownerWorkspaceB, datasetId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await owner.dataset.list({ workspaceId: ownerWorkspaceB })).some(item => item.id === datasetId)).toBe(false);
    expect((await owner.workspace.views({ workspaceId: ownerWorkspaceB })).datasets.some(item => item.id === datasetId)).toBe(false);
  });

  it("isolates users: a non-member cannot read it through their own or the owner's workspace", async () => {
    const outsider = appRouter.createCaller(makeCtx(users.outsider!));
    await expect(outsider.dataset.get({ workspaceId: ownerWorkspaceA, datasetId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(outsider.dataset.get({ workspaceId: outsiderWorkspace, datasetId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lets a viewer read but not import", async () => {
    const viewer = appRouter.createCaller(makeCtx(users.viewer!));
    await expect(viewer.dataset.get({ workspaceId: ownerWorkspaceA, datasetId })).resolves.toMatchObject({ id: datasetId });
    await expect(viewer.dataset.importCsv({ workspaceId: ownerWorkspaceA, name: "viewer_upload", csvText: CSV })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects duplicates and invalid CSV without persisting anything", async () => {
    const owner = appRouter.createCaller(makeCtx(users.owner!));
    await expect(owner.dataset.importCsv({ workspaceId: ownerWorkspaceA, name: "customer_accounts", csvText: CSV })).rejects.toMatchObject({ code: "CONFLICT" });
    // Same name in a different workspace is allowed.
    await expect(owner.dataset.importCsv({ workspaceId: ownerWorkspaceB, name: "customer_accounts", csvText: CSV })).resolves.toMatchObject({ rowCount: 4 });

    await expect(owner.dataset.importCsv({ workspaceId: ownerWorkspaceA, name: "broken", csvText: "a,b\n1,2,3\n" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const db = (await dbModule.getDb())!;
    const broken = await db.select().from(schema.datasets).where(and(eq(schema.datasets.workspaceId, ownerWorkspaceA), eq(schema.datasets.name, "broken")));
    expect(broken).toHaveLength(0);
    const failed = await db.select().from(schema.ingestionAttempts).where(and(eq(schema.ingestionAttempts.workspaceId, ownerWorkspaceA), eq(schema.ingestionAttempts.datasetName, "broken")));
    expect(failed[0]).toMatchObject({ status: "failed", rowsIngested: 0 });
  });

  it("serves the development fixture to real (non-1) workspace ids", async () => {
    const owner = appRouter.createCaller(makeCtx(users.owner!));
    // Workspace B is always created second, so its id is never the old hardcoded fixture id 1.
    const fixtures = await owner.workspace.fixtureDatasets({ workspaceId: ownerWorkspaceB });
    expect(ownerWorkspaceB).not.toBe(1);
    expect(fixtures[0]).toMatchObject({ name: "customer_accounts_fixture", rowCount: 4 });
  });

  afterAll(async () => {
    // Test data is namespaced by suffix; leave it for inspection rather than deleting shared tables.
  });
});
