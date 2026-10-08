import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

/** Phase 7 checkpoint tests against a REAL Supabase-shaped Postgres (Phase 7 migration applied). Skipped unless TEST_DATABASE_URL is set. */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CSV = "customer_id,email,plan,seats,active,region\nC-1001,ada@example.com,pro,12,true,Mumbai\nC-1002,ben@example.com,starter,4,true,Nashik\nC-1003,,pro,8,false,Pune\nC-1004,\"drew, jr@example.com\",enterprise,41,true,Mumbai\nC-1005,esha@example.com,pro,15,true,\n";

describe.skipIf(!url)("Phase 7 — monitoring, quality and incidents (real database)", async () => {
  const { appRouter } = await import("./routers");
  const dbModule = await import("./db");
  const { randomUUID } = await import("node:crypto");
  const schema = await import("../drizzle/schema");
  type Ctx = TrpcContext;
  const users: Record<string, NonNullable<Ctx["user"]>> = {};
  const caller = (key: string) => appRouter.createCaller({ user: users[key]!, req: { protocol: "https", headers: {} } as Ctx["req"], res: {} as Ctx["res"] });
  const db = async () => (await dbModule.getDb())!;
  const owner = () => caller("owner");
  let ws = 0, wsB = 0, outsiderWs = 0, customers = 0, shared = 0, contactable = 0, refresh = 0;
  const update = async (pipelineId: number, patch: Record<string, unknown>) => {
    const current = await owner().pipeline.get({ workspaceId: ws, pipelineId });
    const steps = current.steps.map(({ id: _id, stepOrder: _o, ...step }) => step);
    return owner().pipeline.update({ workspaceId: ws, pipelineId, baseVersion: current.version, name: current.name, sourceDatasetId: current.sourceDatasetId!, destinationMode: current.destinationMode!, destinationDatasetId: current.destinationDatasetId, steps: steps as never, ...patch });
  };

  beforeAll(async () => {
    for (const key of ["owner", "viewer", "outsider"]) {
      const user = { id: randomUUID(), email: `${key}-p7-${suffix}@example.com`, name: key, role: "developer" as const };
      await (await db()).execute(sql`insert into auth.users (id, email, raw_user_meta_data) values (${user.id}, ${user.email}, ${JSON.stringify({ username: `p7${key}_${suffix}`.replace(/[^a-z0-9_]/g, "_").slice(0, 30), full_name: key })}::jsonb)`);
      users[key] = user;
    }
    ws = (await owner().workspace.create({ name: `P7 A ${suffix}` })).id;
    wsB = (await owner().workspace.create({ name: `P7 B ${suffix}` })).id;
    outsiderWs = (await caller("outsider").workspace.create({ name: `P7 O ${suffix}` })).id;
    await (await db()).insert(schema.workspaceMembers).values({ workspaceId: ws, userId: users.viewer!.id, role: "viewer" });
    customers = (await owner().dataset.importCsv({ workspaceId: ws, name: "customers", csvText: CSV })).id;
    shared = (await owner().dataset.importCsv({ workspaceId: ws, name: "customers_shared", csvText: CSV })).id;
    contactable = (await owner().pipeline.create({ workspaceId: ws, name: "contactable customers", sourceDatasetId: shared, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "email", operator: "is_not_null" }] })).id;
    refresh = (await owner().pipeline.create({ workspaceId: ws, name: "refresh shared", sourceDatasetId: customers, destinationMode: "overwrite_existing", destinationDatasetId: shared, steps: [] })).id;
  });

  let qualityIncident = 0;

  it("a new check is evaluated on the stored rows immediately; a failing check opens an incident", async () => {
    await owner().quality.createCheck({ workspaceId: ws, datasetId: shared, severity: "critical", definition: { checkType: "not_null", columnName: "email", config: {} } });
    await owner().quality.createCheck({ workspaceId: ws, datasetId: shared, severity: "warning", definition: { checkType: "row_count", columnName: null, config: { min: 5 } } });
    const checks = await owner().quality.checks({ workspaceId: ws, datasetId: shared });
    expect(checks.map(check => [check.description, check.latest?.status, check.latest?.failingRows])).toEqual([["email is never empty", "fail", 1], ["row count is at least 5 rows", "pass", 0]]);
    expect((checks[0]!.latest!.observed as any).sample).toEqual([{ rowIndex: 2, value: "∅" }]);
    const active = await owner().incidents.list({ workspaceId: ws });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ sourceType: "quality_check_failed", sourceKey: `check:${checks[0]!.id}`, severity: "critical", status: "open", occurrences: 1, datasetName: "customers_shared" });
    qualityIncident = active[0]!.id;
    await expect(owner().quality.createCheck({ workspaceId: ws, datasetId: shared, severity: "warning", definition: { checkType: "not_null", columnName: "phone", config: {} } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const overview = await owner().quality.overview({ workspaceId: ws });
    expect(overview).toMatchObject({ checks: 2, evaluated: 2, passing: 1, failing: 1, passRate: 50 });
  });

  it("a run that overwrites the dataset re-evaluates its checks on the rows it wrote (linked to the run)", async () => {
    await update(refresh, { steps: [{ operation: "drop_column", column: "email" }] });
    const run = await owner().pipeline.run({ workspaceId: ws, pipelineId: refresh });
    expect(run.status).toBe("success");
    expect(run.log.entries.some(entry => /Quality checks on "customers_shared": 1 passed, 1 failed/.test(entry.message))).toBe(true);
    const [emailCheck] = await owner().quality.checks({ workspaceId: ws, datasetId: shared });
    expect(emailCheck!.latest).toMatchObject({ status: "error", trigger: "run", runId: run.id });
    const incident = await owner().incidents.get({ workspaceId: ws, incidentId: qualityIncident });
    expect(incident).toMatchObject({ occurrences: 2, lastRunId: run.id, status: "open" });
    expect(incident.detail).toMatch(/does not exist/);
  });

  let pipelineIncident = 0;
  it("a failed run opens an incident; repeats count up and escalate to critical at 3", async () => {
    const failed = await owner().pipeline.run({ workspaceId: ws, pipelineId: contactable });
    expect(failed.status).toBe("failed");
    let active = (await owner().incidents.list({ workspaceId: ws })).find(item => item.sourceKey === `pipeline:${contactable}`)!;
    expect(active).toMatchObject({ sourceType: "pipeline_run_failed", severity: "warning", occurrences: 1, firstRunId: failed.id, pipelineName: "contactable customers" });
    pipelineIncident = active.id;
    await owner().pipeline.run({ workspaceId: ws, pipelineId: contactable });
    const third = await owner().pipeline.run({ workspaceId: ws, pipelineId: contactable });
    active = (await owner().incidents.list({ workspaceId: ws })).find(item => item.id === pipelineIncident)!;
    expect(active).toMatchObject({ occurrences: 3, severity: "critical", lastRunId: third.id });
    const detail = await owner().incidents.get({ workspaceId: ws, incidentId: pipelineIncident });
    expect(detail.runs.filter(item => item.status === "failed")).toHaveLength(3);
    expect(detail.timeline.map(item => item.action)).toEqual(["INCIDENT_OPENED", "INCIDENT_RECURRED", "INCIDENT_RECURRED"]);
  });

  it("monitoring numbers are plain counts of the stored runs; the failure is visible without any fake row", async () => {
    const summary = await owner().monitoring.summary({ workspaceId: ws, days: 7 });
    const [{ ok, bad }] = (await (await db()).execute(sql`select count(*) filter (where r.status='success')::int as ok, count(*) filter (where r.status='failed')::int as bad from pipeline_runs r join pipelines p on p.id = r.pipeline_id where p.workspace_id = ${ws}`)) as unknown as Array<{ ok: number; bad: number }>;
    expect(summary.kpis).toMatchObject({ runs: ok + bad, successes: ok, failures: bad });
    expect(summary.pipelines.find(item => item.pipelineId === contactable)).toMatchObject({ failures: 3, consecutiveFailures: 3, lastRun: { status: "failed" } });
    expect(summary.incidents).toMatchObject({ total: 2, critical: 2 });
    expect(summary.quality).toMatchObject({ checks: 2, failing: 1 });
    expect(summary.days.at(-1)!.failed).toBeGreaterThanOrEqual(3);
  });

  it("a successful run auto-resolves the pipeline incident", async () => {
    await update(contactable, { steps: [{ operation: "filter", column: "plan", operator: "equals", value: "pro" }] });
    const ok = await owner().pipeline.run({ workspaceId: ws, pipelineId: contactable });
    const detail = await owner().incidents.get({ workspaceId: ws, incidentId: pipelineIncident });
    expect(detail).toMatchObject({ status: "resolved", resolution: "auto", resolutionNote: `Run #${ok.id} succeeded.` });
    expect((await owner().incidents.list({ workspaceId: ws })).some(item => item.id === pipelineIncident)).toBe(false);
  });

  it("people acknowledge and resolve with a reason; a later failure opens a NEW incident", async () => {
    await expect(caller("viewer").incidents.update({ workspaceId: ws, incidentId: qualityIncident, action: "acknowledge" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await owner().incidents.update({ workspaceId: ws, incidentId: qualityIncident, action: "acknowledge" });
    await expect(owner().incidents.update({ workspaceId: ws, incidentId: qualityIncident, action: "acknowledge" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(owner().incidents.update({ workspaceId: ws, incidentId: qualityIncident, action: "resolve", note: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const resolved = await owner().incidents.update({ workspaceId: ws, incidentId: qualityIncident, action: "resolve", note: "email dropped on purpose; check to be retired" });
    expect(resolved).toMatchObject({ status: "resolved", resolution: "manual", resolvedByName: "You", acknowledgedByName: "You" });
    await owner().quality.run({ workspaceId: ws, datasetId: shared });
    const reopened = (await owner().incidents.list({ workspaceId: ws })).find(item => item.sourceType === "quality_check_failed")!;
    expect(reopened.id).not.toBe(qualityIncident);
    expect(reopened.occurrences).toBe(1);
  });

  it("anomalies name the run and the baseline runs they were compared with", async () => {
    const probe = (await owner().pipeline.create({ workspaceId: ws, name: "anomaly probe", sourceDatasetId: customers, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "plan", operator: "equals", value: "pro" }] })).id;
    const baseline = [];
    for (let i = 0; i < 3; i++) baseline.push((await owner().pipeline.run({ workspaceId: ws, pipelineId: probe })).id);
    await update(probe, { steps: [{ operation: "filter", column: "plan", operator: "equals", value: "starter" }] });
    const changed = await owner().pipeline.run({ workspaceId: ws, pipelineId: probe });
    const anomaly = (await owner().monitoring.summary({ workspaceId: ws, days: 7 })).anomalies.find(item => item.runId === changed.id)!;
    expect(anomaly).toMatchObject({ kind: "volume_change", observed: 1, baseline: 3, baselineRunIds: baseline, severity: "warning" });
  });

  it("an interrupted run (server crash) becomes a failed run AND an incident", async () => {
    const probe = (await owner().pipeline.create({ workspaceId: ws, name: "crash probe", sourceDatasetId: customers, destinationMode: "new_dataset", steps: [] })).id;
    await (await db()).insert(schema.pipelineRuns).values({ pipelineId: probe, status: "running", startedAt: new Date(Date.now() - 20 * 60_000) });
    await owner().monitoring.summary({ workspaceId: ws, days: 7 });
    const incident = (await owner().incidents.list({ workspaceId: ws })).find(item => item.sourceKey === `pipeline:${probe}`);
    expect(incident).toMatchObject({ sourceType: "pipeline_run_failed", status: "open" });
    expect(incident!.detail).toMatch(/Interrupted/);
  });

  it("is workspace-scoped; incident history survives on a fresh connection", async () => {
    const other = await owner().monitoring.summary({ workspaceId: wsB, days: 30 });
    expect(other.kpis.runs).toBe(0);
    expect(other.anomalies).toEqual([]);
    expect(await owner().incidents.list({ workspaceId: wsB, filter: "all" })).toEqual([]);
    await expect(owner().incidents.get({ workspaceId: wsB, incidentId: pipelineIncident })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller("outsider").monitoring.summary({ workspaceId: ws, days: 7 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await caller("outsider").incidents.list({ workspaceId: outsiderWs })).toEqual([]);
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const postgres = (await import("postgres")).default;
    const fresh = drizzle(postgres(url!, { prepare: false, max: 1 }));
    const rows = await fresh.select().from(schema.incidents).where(and(eq(schema.incidents.workspaceId, ws), eq(schema.incidents.id, pipelineIncident)));
    expect(rows[0]).toMatchObject({ status: "resolved", occurrences: 3, severity: "critical" });
  });
});
