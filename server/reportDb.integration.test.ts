import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

/** Phase 8 checkpoint tests against a REAL Supabase-shaped Postgres. Skipped unless TEST_DATABASE_URL is set. */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CSV = "customer_id,email,plan,seats,active,region\nC-1001,ada@example.com,pro,12,true,Mumbai\nC-1002,ben@example.com,starter,4,true,Nashik\nC-1003,,pro,8,false,Pune\nC-1004,\"drew, jr@example.com\",enterprise,41,true,Mumbai\nC-1005,esha@example.com,pro,15,true,\n";

describe.skipIf(!url)("Phase 8 — dashboard & reports from stored records (real database)", async () => {
  const { appRouter } = await import("./routers");
  const dbModule = await import("./db");
  const { randomUUID } = await import("node:crypto");
  const schema = await import("../drizzle/schema");
  type Ctx = TrpcContext;
  const users: Record<string, NonNullable<Ctx["user"]>> = {};
  const caller = (key: string) => appRouter.createCaller({ user: users[key]!, req: { protocol: "https", headers: {} } as Ctx["req"], res: {} as Ctx["res"] });
  const owner = () => caller("owner");
  const db = async () => (await dbModule.getDb())!;
  let ws = 0, wsB = 0, customers = 0, shared = 0, contactable = 0;
  const value = (report: { kpis: Array<{ key: string; value: number | null }> }, key: string) => report.kpis.find(item => item.key === key)!.value;

  beforeAll(async () => {
    for (const key of ["owner", "viewer", "outsider"]) {
      const user = { id: randomUUID(), email: `${key}-p8-${suffix}@example.com`, name: key, role: "developer" as const };
      await (await db()).execute(sql`insert into auth.users (id, email, raw_user_meta_data) values (${user.id}, ${user.email}, ${JSON.stringify({ username: `p8${key}_${suffix}`.replace(/[^a-z0-9_]/g, "_").slice(0, 30), full_name: key })}::jsonb)`);
      users[key] = user;
    }
    ws = (await owner().workspace.create({ name: `P8 A ${suffix}` })).id;
    wsB = (await owner().workspace.create({ name: `P8 B ${suffix}` })).id;
    await (await db()).insert(schema.workspaceMembers).values({ workspaceId: ws, userId: users.viewer!.id, role: "viewer" });
    customers = (await owner().dataset.importCsv({ workspaceId: ws, name: "customers", csvText: CSV })).id;
    shared = (await owner().dataset.importCsv({ workspaceId: ws, name: "customers_shared", csvText: CSV })).id;
    contactable = (await owner().pipeline.create({ workspaceId: ws, name: "contactable customers", sourceDatasetId: shared, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "email", operator: "is_not_null" }] })).id;
  });

  it("an empty-ish workspace reports real zeros, not sample numbers", async () => {
    const report = await owner().reports.workspace({ workspaceId: ws, days: 30 });
    expect(value(report, "pipeline_health_pct")).toBeNull();
    expect(value(report, "runs_succeeded")).toBe(0);
    expect(value(report, "open_risks")).toBe(0);
    expect(value(report, "datasets_total")).toBe(2);
    expect(value(report, "stored_rows")).toBe(10);
    expect(report.topRisk).toBeNull();
  });

  it("KPIs equal direct SQL over the same tables after known actions", async () => {
    await owner().pipeline.run({ workspaceId: ws, pipelineId: contactable }); // success (5 → 4 rows) — also creates a 4-row dataset
    const refresh = (await owner().pipeline.create({ workspaceId: ws, name: "refresh shared", sourceDatasetId: customers, destinationMode: "overwrite_existing", destinationDatasetId: shared, steps: [{ operation: "drop_column", column: "email" }] })).id;
    await owner().pipeline.run({ workspaceId: ws, pipelineId: refresh });
    await owner().pipeline.run({ workspaceId: ws, pipelineId: contactable }); // now fails (email gone)
    await owner().quality.createCheck({ workspaceId: ws, datasetId: customers, severity: "critical", definition: { checkType: "not_null", columnName: "email", config: {} } });
    const report = await owner().reports.workspace({ workspaceId: ws, days: 30 });
    const [truth] = (await (await db()).execute(sql`
      select
        (select count(*) from pipeline_runs r join pipelines p on p.id=r.pipeline_id where p.workspace_id=${ws} and r.status='success')::int as ok,
        (select count(*) from pipeline_runs r join pipelines p on p.id=r.pipeline_id where p.workspace_id=${ws} and r.status='failed')::int as bad,
        (select count(*) from pipelines where workspace_id=${ws})::int as pipelines,
        (select count(*) from pipelines where workspace_id=${ws} and status='FAILED')::int as failing,
        (select count(*) from datasets where workspace_id=${ws})::int as datasets,
        (select coalesce(sum(row_count),0) from datasets where workspace_id=${ws})::int as rows,
        (select count(*) from incidents where workspace_id=${ws} and status<>'resolved')::int as incidents`)) as unknown as Array<Record<string, number>>;
    expect({
      ok: value(report, "runs_succeeded"), bad: value(report, "runs_failed"), pipelines: value(report, "pipelines_total"), failing: value(report, "pipelines_failing"),
      datasets: value(report, "datasets_total"), rows: value(report, "stored_rows"), incidents: value(report, "incidents_active"),
    }).toEqual(truth);
    expect(truth).toMatchObject({ ok: 2, bad: 1, failing: 1, incidents: 2 });
    expect(value(report, "pipeline_health_pct")).toBe(66.7);
    expect(value(report, "quality_checks_failing")).toBe(1);
    expect(report.recentRuns[0]).toMatchObject({ pipelineId: contactable, status: "failed" });
  });

  it("one more known failure moves the KPIs by exactly one run", async () => {
    const before = await owner().reports.workspace({ workspaceId: ws, days: 30 });
    await owner().pipeline.run({ workspaceId: ws, pipelineId: contactable });
    const after = await owner().reports.workspace({ workspaceId: ws, days: 30 });
    expect(value(after, "runs_failed")).toBe(value(before, "runs_failed")! + 1);
    expect(value(after, "runs_succeeded")).toBe(value(before, "runs_succeeded"));
    expect(value(after, "pipeline_health_pct")).toBe(50);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("risk KPIs follow stored analyses and reviews", async () => {
    const readers = (await owner().pipeline.create({ workspaceId: ws, name: "reads shared", sourceDatasetId: shared, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "plan", operator: "equals", value: "pro" }] })).id;
    const writer = await owner().pipeline.get({ workspaceId: ws, pipelineId: (await owner().pipeline.list({ workspaceId: ws })).find(item => item.name === "refresh shared")!.id });
    const out = await owner().changeIntelligence.analyzePipelineChange({ workspaceId: ws, pipelineId: writer.id, baseVersion: writer.version, definition: { name: "refresh shared", sourceDatasetId: customers, destinationMode: "overwrite_existing", destinationDatasetId: shared, steps: [{ operation: "drop_column", column: "plan" }] } });
    expect(out.result.level).toBe("CRITICAL");
    const report = await owner().reports.workspace({ workspaceId: ws, days: 30 });
    expect(value(report, "open_risks")).toBe(1);
    expect(value(report, "critical_risks")).toBe(1);
    expect(value(report, "pending_reviews")).toBe(1);
    expect(report.topRisk).toMatchObject({ changeId: out.changeId, level: "CRITICAL", score: out.result.score });
    void readers;
  });

  it("refreshing gives the same report (same fingerprint); the export is the same data", async () => {
    const a = await owner().reports.workspace({ workspaceId: ws, days: 30 });
    const b = await owner().reports.workspace({ workspaceId: ws, days: 30 });
    expect(b.fingerprint).toBe(a.fingerprint);
    const exported = await owner().reports.exportCsv({ workspaceId: ws, days: 30 });
    expect(exported.fingerprint).toBe(a.fingerprint);
    expect(exported.csv).toContain(`# fingerprint,${a.fingerprint}`);
    const summary = Object.fromEntries(exported.csv.split("\n").filter(line => line.startsWith("summary,")).map(line => { const [, key, v] = line.split(","); return [key, v === "" ? null : Number(v)]; }));
    expect(summary).toEqual(Object.fromEntries(a.kpis.map(item => [item.key, item.value])));
    const pipelineLines = exported.csv.split("\n").filter(line => line.startsWith("pipelines,"));
    expect(pipelineLines).toHaveLength(a.pipelines.length);
    const history = await owner().reports.exports({ workspaceId: ws });
    expect(history[0]).toMatchObject({ fingerprint: a.fingerprint, byYou: true });
  });

  it("workspace-scoped: another workspace and other users see their own numbers only", async () => {
    const other = await owner().reports.workspace({ workspaceId: wsB, days: 30 });
    expect(other.kpis.every(item => item.value === 0 || item.value === null)).toBe(true);
    await expect(caller("outsider").reports.workspace({ workspaceId: ws, days: 30 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("outsider").reports.exportCsv({ workspaceId: ws, days: 30 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const viewer = await caller("viewer").reports.workspace({ workspaceId: ws, days: 30 });
    expect(viewer.kpis.map(item => item.value)).toEqual((await owner().reports.workspace({ workspaceId: ws, days: 30 })).kpis.map(item => item.value));
  });
});
