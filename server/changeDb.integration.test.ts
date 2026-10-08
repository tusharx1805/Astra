import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

/**
 * Phase 4 checkpoint tests against a REAL Supabase-shaped Postgres
 * (supabase/migrations/*.sql applied, including the Phase 4 change-scope migration).
 * Run with: TEST_DATABASE_URL=postgres://user:pass@host:5432/astra_test pnpm test. Skipped when unset.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CSV = "customer_id,email,plan,seats,active,region\nC-1001,ada@example.com,pro,12,true,Mumbai\nC-1002,ben@example.com,starter,4,true,Nashik\nC-1003,,pro,8,false,Pune\nC-1004,\"drew, jr@example.com\",enterprise,41,true,Mumbai\nC-1005,esha@example.com,pro,15,true,\n";

describe.skipIf(!url)("Phase 4 — persisted change & risk analysis (real database)", async () => {
  const { appRouter } = await import("./routers");
  const dbModule = await import("./db");
  const { randomUUID } = await import("node:crypto");
  const schema = await import("../drizzle/schema");
  const mock = await import("./mockRiskEngine");

  type Ctx = TrpcContext;
  const makeCtx = (user: NonNullable<Ctx["user"]>): Ctx => ({ user, req: { protocol: "https", headers: {} } as Ctx["req"], res: {} as Ctx["res"] });
  const users: Record<string, NonNullable<Ctx["user"]>> = {};
  const caller = (key: string) => appRouter.createCaller(makeCtx(users[key]!));
  const db = async () => (await dbModule.getDb())!;
  let ws = 0, wsB = 0, outsiderWs = 0, customers = 0, shared = 0, stripper = 0, reader = 0;

  beforeAll(async () => {
    for (const key of ["owner", "viewer", "outsider"]) {
      const user = { id: randomUUID(), email: `${key}-p4-${suffix}@example.com`, name: `Phase4 ${key}`, role: "developer" as const };
      await (await db()).execute(sql`insert into auth.users (id, email, raw_user_meta_data) values (${user.id}, ${user.email}, ${JSON.stringify({ username: `p4${key}_${suffix}`.replace(/[^a-z0-9_]/g, "_").slice(0, 30), full_name: user.name })}::jsonb)`);
      users[key] = user;
    }
    ws = (await caller("owner").workspace.create({ name: `P4 A ${suffix}` })).id;
    wsB = (await caller("owner").workspace.create({ name: `P4 B ${suffix}` })).id;
    outsiderWs = (await caller("outsider").workspace.create({ name: `P4 Outsider ${suffix}` })).id;
    await (await db()).insert(schema.workspaceMembers).values({ workspaceId: ws, userId: users.viewer!.id, role: "viewer" });
    customers = (await caller("owner").dataset.importCsv({ workspaceId: ws, name: "customers", csvText: CSV })).id;
    shared = (await caller("owner").dataset.importCsv({ workspaceId: ws, name: "customers_shared", csvText: CSV })).id;
    reader = (await caller("owner").pipeline.create({ workspaceId: ws, name: "contactable customers", sourceDatasetId: shared, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "email", operator: "is_not_null" }] })).id;
    stripper = (await caller("owner").pipeline.create({ workspaceId: ws, name: "refresh shared", sourceDatasetId: customers, destinationMode: "overwrite_existing", destinationDatasetId: shared, steps: [] })).id;
  });

  let changeId = 0, analysisId = 0;

  it("persists the change and its analysis; the result reflects the real downstream breakage", async () => {
    const current = await caller("owner").pipeline.get({ workspaceId: ws, pipelineId: stripper });
    const out = await caller("owner").changeIntelligence.analyzePipelineChange({
      workspaceId: ws, pipelineId: stripper, baseVersion: current.version,
      definition: { name: "refresh shared", sourceDatasetId: customers, destinationMode: "overwrite_existing", destinationDatasetId: shared, steps: [{ operation: "drop_column", column: "email" }] },
    });
    changeId = out.changeId; analysisId = out.analysisId;
    expect(out.result).toMatchObject({ engine: "pipeline-impact", level: "CRITICAL" });
    expect(out.result.metrics.downstreamBroken).toEqual([{ pipelineId: reader, name: "contactable customers", issues: [expect.stringMatching(/"email" does not exist/)] }]);
    expect(out.result.inputs).toMatchObject({ sourceDatasetId: customers, sourceRowCount: 5, destinationDatasetId: shared });
    expect((out.result as any).simulated).toBeUndefined();

    const fresh = drizzle(postgres(url!, { prepare: false, max: 1 }));
    const [change] = await fresh.select().from(schema.changes).where(eq(schema.changes.id, changeId));
    expect(change).toMatchObject({ workspaceId: ws, pipelineId: stripper, authorId: users.owner!.id, changeType: "CONFIG", title: 'Edit "refresh shared" (0 → 1 step)' });
    const stored = JSON.parse(change!.source);
    expect(stored).toMatchObject({ kind: "pipeline_definition", baseVersion: current.version, current: { steps: [] }, proposed: { steps: [{ operation: "drop_column", column: "email" }] } });
    const [analysis] = await fresh.select().from(schema.riskAnalyses).where(eq(schema.riskAnalyses.id, analysisId));
    expect(analysis).toMatchObject({ changeId, score: out.result.score, level: "CRITICAL", engineVersion: "pipeline-impact/1.0.0" });
    expect((analysis!.result as any).metrics.downstreamBroken[0].name).toBe("contactable customers");
    const audits = await fresh.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "CHANGE_ANALYZED"), eq(schema.auditLogs.resourceId, String(changeId))));
    expect(audits).toHaveLength(1);
    // Analysing does not modify the pipeline itself.
    expect((await caller("owner").pipeline.get({ workspaceId: ws, pipelineId: stripper })).version).toBe(current.version);
  });

  it("history is retrievable through tRPC (list, detail, risk lists) — traced to its change and input", async () => {
    const list = await caller("owner").changeIntelligence.changes({ workspaceId: ws });
    expect(list[0]).toMatchObject({ id: changeId, pipelineName: "refresh shared", author: "You", analysisCount: 1, latest: { id: analysisId, level: "CRITICAL" } });
    const detail = await caller("owner").changeIntelligence.change({ workspaceId: ws, changeId });
    expect(detail.analyses[0]).toMatchObject({ id: analysisId, level: "CRITICAL" });
    expect(detail.source?.proposed.steps).toEqual([{ operation: "drop_column", column: "email" }]);
    expect(detail.pipeline).toMatchObject({ id: stripper, matchesProposal: false });
    expect(detail.datasetNames[customers]).toBe("customers");
    const active = await caller("owner").changeIntelligence.riskAnalyses({ workspaceId: ws, scope: "active" });
    expect(active.map(item => item.id)).toContain(analysisId);
  });

  it("re-analysis appends a new analysis computed from today's data", async () => {
    // Make the downstream reader tolerant of the missing column, then re-analyse the SAME stored proposal.
    const readerNow = await caller("owner").pipeline.get({ workspaceId: ws, pipelineId: reader });
    await caller("owner").pipeline.update({ workspaceId: ws, pipelineId: reader, baseVersion: readerNow.version, name: "contactable customers", sourceDatasetId: shared, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "plan", operator: "equals", value: "pro" }] });
    const again = await caller("owner").changeIntelligence.reanalyze({ workspaceId: ws, changeId });
    expect(again.analysisId).not.toBe(analysisId);
    expect(again.result.metrics.downstreamBroken).toEqual([]);
    expect(again.result.level).not.toBe("CRITICAL");
    const detail = await caller("owner").changeIntelligence.change({ workspaceId: ws, changeId });
    expect(detail.analyses.map(item => item.id)).toEqual([again.analysisId, analysisId]);
  });

  it("a SAFE new-pipeline proposal is stored too, and stays out of the active risk list", async () => {
    const out = await caller("owner").changeIntelligence.analyzePipelineChange({ workspaceId: ws, definition: { name: "pro customers", sourceDatasetId: customers, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "plan", operator: "equals", value: "pro" }] } });
    expect(out.result.level).toBe("SAFE");
    const [row] = await (await db()).select().from(schema.changes).where(eq(schema.changes.id, out.changeId));
    expect(row).toMatchObject({ pipelineId: null, title: 'New pipeline "pro customers" (1 step)' });
    expect((await caller("owner").changeIntelligence.riskAnalyses({ workspaceId: ws, scope: "active" })).some(item => item.changeId === out.changeId)).toBe(false);
    expect((await caller("owner").changeIntelligence.riskAnalyses({ workspaceId: ws, scope: "all" })).some(item => item.changeId === out.changeId)).toBe(true);
  });

  it("no silent fallback: when analysis cannot be computed, nothing is stored", async () => {
    const before = (await caller("owner").changeIntelligence.changes({ workspaceId: ws })).length;
    await expect(caller("owner").changeIntelligence.analyzePipelineChange({ workspaceId: ws, definition: { name: "ghost", sourceDatasetId: 99999999, destinationMode: "new_dataset", steps: [] } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const current = await caller("owner").pipeline.get({ workspaceId: ws, pipelineId: stripper });
    await expect(caller("owner").changeIntelligence.analyzePipelineChange({ workspaceId: ws, pipelineId: stripper, baseVersion: "0000000000000000", definition: { name: "refresh shared", sourceDatasetId: customers, destinationMode: "new_dataset", steps: [] } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await caller("owner").changeIntelligence.changes({ workspaceId: ws })).length).toBe(before);
    expect(current.version).toBeTruthy();
  });

  it("authorization is enforced on the server", async () => {
    await expect(caller("viewer").changeIntelligence.change({ workspaceId: ws, changeId })).resolves.toMatchObject({ id: changeId });
    await expect(caller("viewer").changeIntelligence.analyzePipelineChange({ workspaceId: ws, definition: { name: "viewer try", sourceDatasetId: customers, destinationMode: "new_dataset", steps: [] } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("viewer").changeIntelligence.reanalyze({ workspaceId: ws, changeId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Same owner, other workspace: the change is invisible (this is what changes.workspace_id is for).
    await expect(caller("owner").changeIntelligence.change({ workspaceId: wsB, changeId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await caller("owner").changeIntelligence.changes({ workspaceId: wsB })).toHaveLength(0);
    expect(await caller("owner").changeIntelligence.riskAnalyses({ workspaceId: wsB, scope: "all" })).toHaveLength(0);
    await expect(caller("outsider").changeIntelligence.changes({ workspaceId: ws })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("outsider").changeIntelligence.change({ workspaceId: outsiderWs, changeId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller("outsider").changeIntelligence.analyzePipelineChange({ workspaceId: outsiderWs, definition: { name: "steal", sourceDatasetId: customers, destinationMode: "new_dataset", steps: [] } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the mock engine still exists for the labelled sandbox and deterministic tests, and never writes", async () => {
    const before = await (await db()).select({ n: sql<number>`count(*)` }).from(schema.riskAnalyses);
    const simulated = await caller("owner").changeIntelligence.analyze({ title: "sandbox", source: "ALTER TABLE customers DROP COLUMN email", changeType: "SQL" });
    expect(simulated.simulated).toBe(true);
    expect(mock.mockRiskEngine({ title: "x", source: "select 1", changeType: "SQL" })).toEqual(mock.mockRiskEngine({ title: "x", source: "select 1", changeType: "SQL" }));
    const after = await (await db()).select({ n: sql<number>`count(*)` }).from(schema.riskAnalyses);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
  });
});
