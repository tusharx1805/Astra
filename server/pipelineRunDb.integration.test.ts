import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, asc, eq, sql } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

/**
 * Phase 3 checkpoint tests against a REAL Supabase-shaped Postgres.
 * Run with: TEST_DATABASE_URL=postgres://user:pass@host:5432/astra_test pnpm test
 * NEVER point this at production: it creates auth.users rows and a temporary trigger. Skipped when unset.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CSV = "customer_id,email,plan,seats,active\nC-1001,ada@example.com,pro,12,true\nC-1002,ben@example.com,starter,4,true\nC-1003,,pro,8,false\nC-1004,drew@example.com,enterprise,41,true\n";

describe.skipIf(!url)("Phase 3 — persisted pipeline runs (real database)", async () => {
  const { appRouter } = await import("./routers");
  const dbModule = await import("./db");
  const { randomUUID } = await import("node:crypto");
  const schema = await import("../drizzle/schema");
  const { parseCsvDataset } = await import("../shared/datasetProfile");
  const { applyTransformSteps } = await import("../shared/transformations");

  type Ctx = TrpcContext;
  const makeCtx = (user: NonNullable<Ctx["user"]>): Ctx => ({ user, req: { protocol: "https", headers: {} } as Ctx["req"], res: {} as Ctx["res"] });
  const users: Record<string, NonNullable<Ctx["user"]>> = {};
  const caller = (key: string) => appRouter.createCaller(makeCtx(users[key]!));
  const db = async () => (await dbModule.getDb())!;
  let ws = 0, wsB = 0, outsiderWs = 0, customers = 0, shared = 0, sink = 0;

  async function createUser(key: string) {
    const user = { id: randomUUID(), email: `${key}-p3-${suffix}@example.com`, name: `Phase3 ${key}`, role: "developer" as const };
    const username = `p3${key}_${suffix}`.replace(/[^a-z0-9_]/g, "_").slice(0, 30);
    await (await db()).execute(sql`insert into auth.users (id, email, raw_user_meta_data) values (${user.id}, ${user.email}, ${JSON.stringify({ username, full_name: user.name })}::jsonb)`);
    users[key] = user;
  }
  const steps = [
    { operation: "filter" as const, column: "active", operator: "equals" as const, value: "true" },
    { operation: "rename_column" as const, from: "customer_id", to: "customer_key" },
    { operation: "change_datatype" as const, column: "seats", toType: "number" as const },
    { operation: "drop_column" as const, column: "email" },
  ];
  const newPipeline = (name: string, sourceDatasetId: number, pipelineSteps: any[], destination: { mode: "new_dataset" | "overwrite_existing"; id?: number } = { mode: "new_dataset" }) =>
    caller("owner").pipeline.create({ workspaceId: ws, name, sourceDatasetId, destinationMode: destination.mode, destinationDatasetId: destination.id ?? null, steps: pipelineSteps });

  beforeAll(async () => {
    for (const key of ["owner", "viewer", "outsider"]) await createUser(key);
    ws = (await caller("owner").workspace.create({ name: `P3 A ${suffix}` })).id;
    wsB = (await caller("owner").workspace.create({ name: `P3 B ${suffix}` })).id;
    outsiderWs = (await caller("outsider").workspace.create({ name: `P3 Outsider ${suffix}` })).id;
    await (await db()).insert(schema.workspaceMembers).values({ workspaceId: ws, userId: users.viewer!.id, role: "viewer" });
    customers = (await caller("owner").dataset.importCsv({ workspaceId: ws, name: "customers", csvText: CSV })).id;
    shared = (await caller("owner").dataset.importCsv({ workspaceId: ws, name: "shared_customers", csvText: CSV })).id;
    sink = (await caller("owner").dataset.importCsv({ workspaceId: ws, name: "sink", csvText: CSV })).id;
  });

  let pipelineId = 0, runId = 0, outputId = 0;

  it("a run creates a database record, executes the stored steps and writes output that matches the engine", async () => {
    pipelineId = (await newPipeline("active customers", customers, steps)).id;
    const run = await caller("owner").pipeline.run({ workspaceId: ws, pipelineId });
    runId = run.id;
    expect(run).toMatchObject({ status: "success", pipelineId, rowsIn: 4, rowsOut: 3, coercionFailures: 0, errorMessage: null, outputAvailable: true });
    expect(run.completedAt).not.toBeNull();
    expect(run.log.steps.map(step => [step.rowsIn, step.rowsOut])).toEqual([[4, 3], [3, 3], [3, 3], [3, 3]]);
    outputId = run.log.output!.datasetId;
    expect(run.log.output).toMatchObject({ mode: "new_dataset", datasetName: `active customers · run ${runId}`, columns: ["customer_key", "plan", "seats", "active"], rowCount: 3 });

    // Independent check: the rows stored in dataset_rows equal the engine applied to the parsed CSV.
    const expected = applyTransformSteps(parseCsvDataset(CSV).rows, steps).rows;
    const stored = await (await db()).select({ data: schema.datasetRows.data }).from(schema.datasetRows).where(eq(schema.datasetRows.datasetId, outputId)).orderBy(asc(schema.datasetRows.rowIndex));
    expect(stored.map(row => row.data)).toEqual(expected);
    expect(run.log.sample).toEqual(expected);
    const columns = await caller("owner").dataset.get({ workspaceId: ws, datasetId: outputId });
    expect(columns).toMatchObject({ sourceType: "Pipeline output", rowCount: 3, workspaceId: ws });
    expect(columns.columns.find(column => column.name === "seats")?.dataType).toBe("number");

    const pipeline = await caller("owner").pipeline.get({ workspaceId: ws, pipelineId });
    expect(pipeline.status).toBe("HEALTHY");
    const [stats] = await (await db()).select().from(schema.pipelines).where(eq(schema.pipelines.id, pipelineId));
    expect(stats).toMatchObject({ successRate: 100, failureCount: 0 });
  });

  it("the run is durable: a fresh connection (as after restart) loads it by its real id", async () => {
    const fresh = drizzle(postgres(url!, { prepare: false, max: 1 }));
    const [row] = await fresh.select().from(schema.pipelineRuns).where(eq(schema.pipelineRuns.id, runId));
    expect(row).toMatchObject({ pipelineId, status: "success", rowsIn: 4, rowsOut: 3 });
    expect((row!.logs as any).output.datasetId).toBe(outputId);
    const audits = await fresh.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "PIPELINE_RUN_SUCCEEDED"), eq(schema.auditLogs.resourceId, String(runId))));
    expect(audits).toHaveLength(1);
    await expect(caller("owner").pipeline.getRun({ workspaceId: ws, runId })).resolves.toMatchObject({ id: runId, pipelineName: "active customers" });
    const history = await caller("owner").pipeline.runs({ workspaceId: ws, pipelineId });
    expect(history[0]).toMatchObject({ id: runId, status: "success", outputDatasetId: outputId, outputDatasetName: `active customers · run ${runId}` });
  });

  it("every new-dataset run gets its own output dataset (no name clash on the second run)", async () => {
    const second = await caller("owner").pipeline.run({ workspaceId: ws, pipelineId });
    expect(second.status).toBe("success");
    expect(second.log.output!.datasetId).not.toBe(outputId);
  });

  it("overwrite mode replaces the destination; a later pipeline that needs a dropped column fails meaningfully", async () => {
    const overwrite = (await newPipeline("slim shared", customers, [{ operation: "drop_column", column: "email" }], { mode: "overwrite_existing", id: shared })).id;
    const reader = (await newPipeline("emails from shared", shared, [{ operation: "filter", column: "email", operator: "is_not_null" }])).id;
    const ok = await caller("owner").pipeline.run({ workspaceId: ws, pipelineId: overwrite });
    expect(ok).toMatchObject({ status: "success", rowsOut: 4 });
    expect((await caller("owner").dataset.get({ workspaceId: ws, datasetId: shared })).columns.map(column => column.name)).toEqual(["customer_id", "plan", "seats", "active"]);

    const datasetsBefore = (await caller("owner").dataset.list({ workspaceId: ws })).length;
    const failed = await caller("owner").pipeline.run({ workspaceId: ws, pipelineId: reader });
    expect(failed).toMatchObject({ status: "failed", rowsIn: 4, rowsOut: 0, outputAvailable: false });
    expect(failed.log.source).toMatchObject({ name: "shared_customers", rowCount: 4 });
    expect(failed.errorMessage).toMatch(/no longer matches this pipeline.*column "email" does not exist/);
    expect(failed.log.entries.at(-1)).toMatchObject({ level: "error" });
    expect((await caller("owner").dataset.list({ workspaceId: ws })).length).toBe(datasetsBefore);
    const [stats] = await (await db()).select().from(schema.pipelines).where(eq(schema.pipelines.id, reader));
    expect(stats).toMatchObject({ status: "FAILED", failureCount: 1, successRate: 0 });
  });

  it("coercion failures are recorded and mark the pipeline WARNING, not a silent success", async () => {
    const id = (await newPipeline("plans as numbers", customers, [{ operation: "change_datatype", column: "plan", toType: "number" }])).id;
    const run = await caller("owner").pipeline.run({ workspaceId: ws, pipelineId: id });
    expect(run).toMatchObject({ status: "success", coercionFailures: 4 });
    expect((await caller("owner").pipeline.get({ workspaceId: ws, pipelineId: id })).status).toBe("WARNING");
  });

  it("a failure while writing output rolls back everything and never reports success", async () => {
    const database = await db();
    await database.execute(sql`create or replace function p3_test_boom() returns trigger language plpgsql as $$ begin if new.name like 'boom%' then raise exception 'simulated storage failure'; end if; return new; end $$`);
    await database.execute(sql`create trigger p3_test_boom before insert on public.datasets for each row execute function p3_test_boom()`);
    try {
      const id = (await newPipeline("boom pipeline", customers, steps)).id;
      const before = (await caller("owner").dataset.list({ workspaceId: ws })).length;
      const run = await caller("owner").pipeline.run({ workspaceId: ws, pipelineId: id });
      expect(run.status).toBe("failed");
      expect(run.errorMessage).toMatch(/output could not be saved, so nothing was written/);
      expect(run.errorMessage).not.toMatch(/simulated storage failure|insert|datasets/);
      expect((await caller("owner").dataset.list({ workspaceId: ws })).length).toBe(before);
    } finally {
      await database.execute(sql`drop trigger if exists p3_test_boom on public.datasets`);
      await database.execute(sql`drop function if exists p3_test_boom()`);
    }
  });

  it("blocks a second concurrent run and closes runs left behind by a crashed server as failed", async () => {
    const database = await db();
    const [inFlight] = await database.insert(schema.pipelineRuns).values({ pipelineId, status: "running" }).returning({ id: schema.pipelineRuns.id });
    await expect(caller("owner").pipeline.run({ workspaceId: ws, pipelineId })).rejects.toMatchObject({ code: "CONFLICT" });
    await database.update(schema.pipelineRuns).set({ startedAt: new Date(Date.now() - 20 * 60 * 1000) }).where(eq(schema.pipelineRuns.id, inFlight!.id));
    const next = await caller("owner").pipeline.run({ workspaceId: ws, pipelineId });
    expect(next.status).toBe("success");
    const stale = await caller("owner").pipeline.getRun({ workspaceId: ws, runId: inFlight!.id });
    expect(stale).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/^Interrupted/) });
  });

  it("authorization: viewers read but cannot run; other workspaces and users cannot see runs", async () => {
    await expect(caller("viewer").pipeline.getRun({ workspaceId: ws, runId })).resolves.toMatchObject({ id: runId });
    await expect(caller("viewer").pipeline.run({ workspaceId: ws, pipelineId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("owner").pipeline.getRun({ workspaceId: wsB, runId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await caller("owner").pipeline.runs({ workspaceId: wsB })).toHaveLength(0);
    await expect(caller("outsider").pipeline.getRun({ workspaceId: outsiderWs, runId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller("outsider").pipeline.run({ workspaceId: ws, pipelineId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("outsider").pipeline.run({ workspaceId: outsiderWs, pipelineId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  afterAll(async () => { void sink; });
});
