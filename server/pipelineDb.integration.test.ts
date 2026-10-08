import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, asc, eq, sql } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

/**
 * Phase 2 checkpoint tests against a REAL Supabase-shaped Postgres.
 * Run with: TEST_DATABASE_URL=postgres://user:pass@host:5432/astra_test pnpm test
 * NEVER point this at production: it creates auth.users rows. Skipped when unset.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CSV = "customer_id,email,plan,seats,active\nC-1001,ada@example.com,pro,12,true\nC-1002,ben@example.com,starter,4,true\nC-1003,,pro,8,false\nC-1004,drew@example.com,enterprise,41,true\n";

describe.skipIf(!url)("Phase 2 — persisted pipeline definitions (real database)", async () => {
  const { appRouter } = await import("./routers");
  const dbModule = await import("./db");
  const { randomUUID } = await import("node:crypto");
  const schema = await import("../drizzle/schema");

  type Ctx = TrpcContext;
  const makeCtx = (user: NonNullable<Ctx["user"]>): Ctx => ({ user, req: { protocol: "https", headers: {} } as Ctx["req"], res: {} as Ctx["res"] });
  const users: Record<string, NonNullable<Ctx["user"]>> = {};
  let workspaceA = 0, workspaceB = 0, outsiderWorkspace = 0;
  let sourceA = 0, otherA = 0, sourceB = 0, outsiderDataset = 0;

  async function createUser(key: string) {
    const user = { id: randomUUID(), email: `${key}-p2-${suffix}@example.com`, name: `Phase2 ${key}`, role: "developer" as const };
    const db = (await dbModule.getDb())!;
    const username = `p2${key}_${suffix}`.replace(/[^a-z0-9_]/g, "_").slice(0, 30);
    await db.execute(sql`insert into auth.users (id, email, raw_user_meta_data) values (${user.id}, ${user.email}, ${JSON.stringify({ username, full_name: user.name })}::jsonb)`);
    users[key] = user;
  }
  const caller = (key: string) => appRouter.createCaller(makeCtx(users[key]!));

  beforeAll(async () => {
    for (const key of ["owner", "outsider", "viewer", "reviewer"]) await createUser(key);
    workspaceA = (await caller("owner").workspace.create({ name: `P2 A ${suffix}` })).id;
    workspaceB = (await caller("owner").workspace.create({ name: `P2 B ${suffix}` })).id;
    outsiderWorkspace = (await caller("outsider").workspace.create({ name: `P2 Outsider ${suffix}` })).id;
    const db = (await dbModule.getDb())!;
    await db.insert(schema.workspaceMembers).values([{ workspaceId: workspaceA, userId: users.viewer!.id, role: "viewer" }, { workspaceId: workspaceA, userId: users.reviewer!.id, role: "reviewer" }]);
    sourceA = (await caller("owner").dataset.importCsv({ workspaceId: workspaceA, name: "customers", csvText: CSV })).id;
    otherA = (await caller("owner").dataset.importCsv({ workspaceId: workspaceA, name: "customers_clean", csvText: CSV })).id;
    sourceB = (await caller("owner").dataset.importCsv({ workspaceId: workspaceB, name: "customers", csvText: CSV })).id;
    outsiderDataset = (await caller("outsider").dataset.importCsv({ workspaceId: outsiderWorkspace, name: "secret", csvText: CSV })).id;
  });

  const steps = [
    { operation: "filter" as const, column: "active", operator: "equals" as const, value: "true" },
    { operation: "rename_column" as const, from: "customer_id", to: "customer_key" },
    { operation: "change_datatype" as const, column: "seats", toType: "number" as const },
    { operation: "drop_column" as const, column: "email" },
  ];
  let pipelineId = 0;
  let version = "";

  it("creates a pipeline whose steps are stored as ordered pipeline_steps rows", async () => {
    const created = await caller("owner").pipeline.create({ workspaceId: workspaceA, name: "active customers", sourceDatasetId: sourceA, destinationMode: "new_dataset", steps });
    pipelineId = created.id;
    version = created.version;
    expect(created).toMatchObject({ status: "DRAFT", workspaceId: workspaceA, sourceDatasetId: sourceA, sourceDatasetName: "customers", destinationMode: "new_dataset", editable: true });
    expect(created.steps.map(({ id: _id, stepOrder: _order, ...step }) => step)).toEqual(steps);

    const fresh = drizzle(postgres(url!, { prepare: false, max: 1 }));
    const rows = await fresh.select().from(schema.pipelineSteps).where(eq(schema.pipelineSteps.pipelineId, pipelineId)).orderBy(asc(schema.pipelineSteps.stepOrder));
    expect(rows.map(row => [row.stepOrder, row.operation])).toEqual([[0, "filter"], [1, "rename_column"], [2, "change_datatype"], [3, "drop_column"]]);
    expect(rows[1]!.config).toEqual({ from: "customer_id", to: "customer_key" });
    const [pipeline] = await fresh.select().from(schema.pipelines).where(eq(schema.pipelines.id, pipelineId));
    expect(pipeline).toMatchObject({ organizationId: expect.any(Number), workspaceId: workspaceA, ownerId: users.owner!.id, dag: null });
    const audits = await fresh.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "PIPELINE_CREATED"), eq(schema.auditLogs.resourceId, String(pipelineId))));
    expect(audits).toHaveLength(1);
  });

  it("reads the same definition back (as after leaving the page / a restart)", async () => {
    const again = await caller("owner").pipeline.get({ workspaceId: workspaceA, pipelineId });
    expect(again.version).toBe(version);
    expect(again.steps.map(step => step.operation)).toEqual(["filter", "rename_column", "change_datatype", "drop_column"]);
    const listed = await caller("owner").pipeline.list({ workspaceId: workspaceA });
    expect(listed.find(item => item.id === pipelineId)).toMatchObject({ stepCount: 4, sourceDatasetName: "customers", status: "DRAFT" });
    expect((await caller("owner").workspace.views({ workspaceId: workspaceA })).pipelines.some(item => item.id === pipelineId)).toBe(true);
  });

  it("updates: reordered/removed steps replace the stored order exactly, and the version changes", async () => {
    const reordered = [steps[3]!, steps[0]!, steps[2]!];
    const updated = await caller("owner").pipeline.update({ workspaceId: workspaceA, pipelineId, baseVersion: version, name: "active customers v2", sourceDatasetId: sourceA, destinationMode: "overwrite_existing", destinationDatasetId: otherA, steps: reordered });
    expect(updated.version).not.toBe(version);
    expect(updated).toMatchObject({ name: "active customers v2", destinationMode: "overwrite_existing", destinationDatasetName: "customers_clean" });
    expect(updated.steps.map(({ id: _id, stepOrder, ...step }) => [stepOrder, step])).toEqual(reordered.map((step, index) => [index, step]));
    const db = (await dbModule.getDb())!;
    expect(await db.select().from(schema.pipelineSteps).where(eq(schema.pipelineSteps.pipelineId, pipelineId))).toHaveLength(3);
    const stale = caller("owner").pipeline.update({ workspaceId: workspaceA, pipelineId, baseVersion: version, name: "lost update", sourceDatasetId: sourceA, destinationMode: "new_dataset", steps: [] });
    await expect(stale).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await caller("owner").pipeline.get({ workspaceId: workspaceA, pipelineId })).name).toBe("active customers v2");
    version = updated.version;
  });

  it("validates step order and required inputs on the server and persists nothing on failure", async () => {
    const bad = [{ operation: "drop_column" as const, column: "email" }, { operation: "filter" as const, column: "email", operator: "is_null" as const }];
    await expect(caller("owner").pipeline.create({ workspaceId: workspaceA, name: "broken order", sourceDatasetId: sourceA, destinationMode: "new_dataset", steps: bad })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/Step 2: column "email"/) });
    await expect(caller("owner").pipeline.create({ workspaceId: workspaceA, name: "no value", sourceDatasetId: sourceA, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "seats", operator: "gt" }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller("owner").pipeline.create({ workspaceId: workspaceA, name: "self overwrite", sourceDatasetId: sourceA, destinationMode: "overwrite_existing", destinationDatasetId: sourceA, steps: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller("owner").pipeline.create({ workspaceId: workspaceA, name: "active customers v2", sourceDatasetId: sourceA, destinationMode: "new_dataset", steps: [] })).rejects.toMatchObject({ code: "CONFLICT" });
    // Invalid shapes never reach the service.
    await expect(caller("owner").pipeline.create({ workspaceId: workspaceA, name: "injection", sourceDatasetId: sourceA, destinationMode: "new_dataset", steps: [{ operation: "sql", query: "drop table datasets" } as never] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const db = (await dbModule.getDb())!;
    const names = (await db.select({ name: schema.pipelines.name }).from(schema.pipelines).where(eq(schema.pipelines.workspaceId, workspaceA))).map(row => row.name);
    expect(names).toEqual(["active customers v2"]);
  });

  it("cannot reference datasets outside the authorized workspace", async () => {
    // Same owner, other workspace's dataset.
    await expect(caller("owner").pipeline.create({ workspaceId: workspaceA, name: "cross workspace", sourceDatasetId: sourceB, destinationMode: "new_dataset", steps: [] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller("owner").pipeline.create({ workspaceId: workspaceA, name: "cross dest", sourceDatasetId: sourceA, destinationMode: "overwrite_existing", destinationDatasetId: sourceB, steps: [] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Another user's dataset, through the attacker's own workspace and through the victim's.
    await expect(caller("owner").pipeline.create({ workspaceId: workspaceA, name: "steal", sourceDatasetId: outsiderDataset, destinationMode: "new_dataset", steps: [] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller("outsider").pipeline.create({ workspaceId: workspaceA, name: "intrude", sourceDatasetId: sourceA, destinationMode: "new_dataset", steps: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("outsider").pipeline.get({ workspaceId: outsiderWorkspace, pipelineId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller("owner").pipeline.get({ workspaceId: workspaceB, pipelineId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await caller("owner").workspace.views({ workspaceId: workspaceB })).pipelines.some(item => item.id === pipelineId)).toBe(false);
    expect((await caller("owner").workspace.search({ workspaceId: workspaceB, query: "active" })).pipelines).toHaveLength(0);
  });

  it("viewers and reviewers can read but not create or edit", async () => {
    for (const key of ["viewer", "reviewer"]) {
      await expect(caller(key).pipeline.get({ workspaceId: workspaceA, pipelineId })).resolves.toMatchObject({ id: pipelineId, editable: false });
      await expect(caller(key).pipeline.create({ workspaceId: workspaceA, name: `by ${key}`, sourceDatasetId: sourceA, destinationMode: "new_dataset", steps: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller(key).pipeline.update({ workspaceId: workspaceA, pipelineId, baseVersion: version, name: "edit", sourceDatasetId: sourceA, destinationMode: "new_dataset", steps: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
});
