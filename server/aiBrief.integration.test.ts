import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";
import { startFakeLlm, type FakeLlm } from "./testing/fakeLlm";

/** Phase 10 checkpoints: real Postgres (Phase 10 migration applied) + a real HTTP model endpoint (local fake). */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CSV = "customer_id,email,plan,seats,active,region\nC-1001,ada@example.com,pro,12,true,Mumbai\nC-1002,ben@example.com,starter,4,true,Nashik\nC-1003,,pro,8,false,Pune\nC-1004,drew@example.com,enterprise,41,true,Mumbai\nC-1005,esha@example.com,pro,15,true,\n";

describe.skipIf(!url)("Phase 10 — AI review briefs (real database, real HTTP)", async () => {
  const { appRouter } = await import("./routers");
  const dbModule = await import("./db");
  const { randomUUID } = await import("node:crypto");
  const schema = await import("../drizzle/schema");
  type Ctx = TrpcContext;
  const users: Record<string, NonNullable<Ctx["user"]>> = {};
  const caller = (key: string) => appRouter.createCaller({ user: users[key]!, req: { protocol: "https", headers: {} } as Ctx["req"], res: {} as Ctx["res"] });
  const db = async () => (await dbModule.getDb())!;
  let fake: FakeLlm;
  let ws = 0, otherWs = 0, changeId = 0, analysisId = 0;
  const setAi = (model: string, provider = "anthropic", extra: Record<string, string> = {}) => {
    Object.assign(process.env, { AI_PROVIDER: provider, AI_API_KEY: "test-ai-key", AI_MODEL: model, AI_BASE_URL: provider === "anthropic" ? `http://127.0.0.1:${fake.port}` : `http://127.0.0.1:${fake.port}/v1`, AI_TIMEOUT_MS: "3000", ...extra });
  };
  const snapshot = async () => {
    const d = await db();
    const [analyses] = await d.execute(sql`select count(*)::int as n, max(score) as s from public.risk_analyses where change_id = ${changeId}`) as any;
    const [reviews] = await d.execute(sql`select count(*)::int as n from public.reviews where change_id = ${changeId}`) as any;
    return `${analyses.n}|${analyses.s}|${reviews.n}`;
  };

  beforeAll(async () => {
    fake = await startFakeLlm();
    for (const key of ["owner", "reviewer", "viewer", "outsider"]) {
      const user = { id: randomUUID(), email: `${key}-p10-${suffix}@example.com`, name: `Secret Person ${key}`, role: "developer" as const };
      await (await db()).execute(sql`insert into auth.users (id, email, raw_user_meta_data) values (${user.id}, ${user.email}, ${JSON.stringify({ username: `p10${key}_${suffix}`.replace(/[^a-z0-9_]/g, "_").slice(0, 30), full_name: user.name })}::jsonb)`);
      users[key] = user;
    }
    ws = (await caller("owner").workspace.create({ name: `P10 ${suffix}` })).id;
    otherWs = (await caller("outsider").workspace.create({ name: `P10 O ${suffix}` })).id;
    await (await db()).insert(schema.workspaceMembers).values([{ workspaceId: ws, userId: users.reviewer!.id, role: "reviewer" }, { workspaceId: ws, userId: users.viewer!.id, role: "viewer" }]);
    const customers = (await caller("owner").dataset.importCsv({ workspaceId: ws, name: "customers", csvText: CSV })).id;
    const shared = (await caller("owner").dataset.importCsv({ workspaceId: ws, name: "customers_shared", csvText: CSV })).id;
    await caller("owner").pipeline.create({ workspaceId: ws, name: "contactable customers", sourceDatasetId: shared, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "email", operator: "is_not_null" }] });
    const stripper = (await caller("owner").pipeline.create({ workspaceId: ws, name: "refresh shared", sourceDatasetId: customers, destinationMode: "overwrite_existing", destinationDatasetId: shared, steps: [] })).id;
    const current = await caller("owner").pipeline.get({ workspaceId: ws, pipelineId: stripper });
    const out = await caller("owner").changeIntelligence.analyzePipelineChange({ workspaceId: ws, pipelineId: stripper, baseVersion: current.version, definition: { name: "refresh shared", sourceDatasetId: customers, destinationMode: "overwrite_existing", destinationDatasetId: shared, steps: [{ operation: "drop_column", column: "email" }] } });
    changeId = out.changeId; analysisId = out.analysisId;
    expect(out.result.level).toBe("CRITICAL");
  });
  afterAll(async () => { await fake?.close(); for (const k of ["AI_PROVIDER", "AI_API_KEY", "AI_MODEL", "AI_BASE_URL", "AI_TIMEOUT_MS", "AI_MAX_CALLS_PER_WORKSPACE_HOUR"]) delete process.env[k]; });

  it("without configuration the feature says so clearly, and nothing else changes", async () => {
    for (const k of ["AI_PROVIDER", "AI_API_KEY", "AI_MODEL"]) delete process.env[k];
    const before = await snapshot();
    expect(await caller("owner").ai.status({ workspaceId: ws })).toMatchObject({ enabled: false, reason: expect.stringMatching(/AI_PROVIDER is not set/), migrationApplied: true, canGenerate: true });
    await expect(caller("owner").ai.generateBrief({ workspaceId: ws, changeId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/risk analysis and reviews are unaffected/) });
    expect(await snapshot()).toBe(before);
    expect(fake.requests).toHaveLength(0);
  });

  it("the brief is based on the real selected analysis, sent server-side with only metadata", async () => {
    setAi("fake-good");
    const out = await caller("reviewer").ai.generateBrief({ workspaceId: ws, changeId });
    expect(out.cached).toBe(false);
    const { brief } = out;
    expect(brief).toMatchObject({ analysisId, changeId, provider: "anthropic", model: "fake-good", stale: false, dropped: [], adjusted: null });
    expect(brief.brief.headline).toMatch(/^CRITICAL \d+\/100/);
    expect(brief.brief.suggestion).toBe("block");
    const analysis = (await caller("owner").changeIntelligence.change({ workspaceId: ws, changeId })).analyses[0]!;
    const factorCodes = analysis.result.factors.map(f => f.code);
    expect(brief.brief.riskPoints.length).toBeGreaterThan(0);
    brief.brief.riskPoints.forEach(point => expect(factorCodes).toContain(point.factor));
    expect(brief.brief.riskPoints[0]!.factor).toBe("downstream_break");
    // What actually went over the wire:
    const sent = fake.requests.at(-1)!;
    expect(sent.url).toBe("/v1/messages");
    expect(sent.key).toBe("test-ai-key");
    const wire = JSON.stringify(sent.body);
    const userContent = String(sent.body.messages[0].content);
    expect(JSON.parse(userContent.slice(userContent.indexOf("{"), userContent.lastIndexOf("}") + 1)).analysis.id).toBe(analysisId);
    for (const secret of ["ada@example.com", "ben@example.com", "C-1001", "Secret Person", "@example.com", users.owner!.id]) expect(wire).not.toContain(secret);
    expect(brief.context.analysis.factors.map(f => f.code)).toEqual(factorCodes);
    const [row] = await (await db()).select().from(schema.aiBriefs).where(eq(schema.aiBriefs.id, brief.id));
    expect(row).toMatchObject({ workspaceId: ws, analysisId, promptVersion: "review-brief/1", createdBy: users.reviewer!.id });
    expect(row!.latencyMs).toBeGreaterThanOrEqual(0);
    const audits = await (await db()).select().from(schema.auditLogs).where(and(eq(schema.auditLogs.workspaceId, ws), eq(schema.auditLogs.action, "AI_BRIEF_GENERATED")));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain("test-ai-key");
  });

  it("the same analysis is served from the stored brief (no second model call); regenerate forces one", async () => {
    const calls = fake.requests.length;
    const again = await caller("owner").ai.generateBrief({ workspaceId: ws, changeId });
    expect(again.cached).toBe(true);
    expect(fake.requests.length).toBe(calls);
    const forced = await caller("owner").ai.generateBrief({ workspaceId: ws, changeId, regenerate: true });
    expect(forced.cached).toBe(false);
    expect(fake.requests.length).toBe(calls + 1);
    const list = await caller("viewer").ai.changeBriefs({ workspaceId: ws, changeId });
    expect(list.briefs.map(b => b.id)).toEqual([forced.brief.id, again.brief.id]);
  });

  it("model output never overwrites authoritative records, and invented points are removed", async () => {
    const before = await snapshot();
    setAi("fake-hallucinate");
    const out = await caller("owner").ai.generateBrief({ workspaceId: ws, changeId, regenerate: true });
    expect(out.brief.dropped).toEqual([{ factor: "made_up_factor", point: expect.any(String) }]);
    expect(out.brief.brief.riskPoints.every(p => p.factor !== "made_up_factor")).toBe(true);
    expect(out.brief.brief.suggestion).toBe("needs_human_judgment");
    expect(out.brief.adjusted).toMatch(/suggested "approve" on a CRITICAL analysis/);
    expect(await snapshot()).toBe(before);
    const review = await caller("reviewer").changeIntelligence.change({ workspaceId: ws, changeId });
    expect(review.reviewStatus).not.toMatch(/APPROVED/);
  });

  it("failures are explicit, retried once when transient, audited, and change nothing", async () => {
    const before = await snapshot();
    const cases: Array<[string, string, RegExp]> = [
      ["fake-garbage", "INTERNAL_SERVER_ERROR", /did not return JSON/],
      ["fake-badshape", "INTERNAL_SERVER_ERROR", /did not match the brief format/],
      ["fake-500", "INTERNAL_SERVER_ERROR", /unavailable \(HTTP 500\)/],
      ["fake-429", "TOO_MANY_REQUESTS", /rate-limiting/],
      ["fake-404", "INTERNAL_SERVER_ERROR", /does not know this model/],
      ["fake-slow", "TIMEOUT", /did not answer within 3 seconds/],
    ];
    for (const [model, code, message] of cases) {
      setAi(model);
      await expect(caller("owner").ai.generateBrief({ workspaceId: ws, changeId, regenerate: true }), model).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
    }
    expect(fake.counts["fake-500"]).toBe(2); // one retry
    expect(fake.counts["fake-404"]).toBe(1); // not retried
    setAi("fake-good", "anthropic", { AI_API_KEY: "wrong-key" });
    await expect(caller("owner").ai.generateBrief({ workspaceId: ws, changeId, regenerate: true })).rejects.toMatchObject({ message: expect.stringMatching(/rejected the API key/) });
    expect(await snapshot()).toBe(before);
    const failures = await (await db()).select().from(schema.auditLogs).where(and(eq(schema.auditLogs.workspaceId, ws), eq(schema.auditLogs.action, "AI_BRIEF_FAILED")));
    expect(failures.map(f => (f.metadata as any).kind).sort()).toEqual(["auth", "disabled", "invalid_output", "invalid_output", "model", "rate_limited", "timeout", "unavailable"].sort());
    expect(JSON.stringify(failures)).not.toMatch(/wrong-key|test-ai-key/);
  }, 30_000);

  it("the OpenAI-compatible adapter works through the same boundary", async () => {
    setAi("fake-good", "openai");
    const out = await caller("owner").ai.generateBrief({ workspaceId: ws, changeId, regenerate: true });
    expect(out.brief).toMatchObject({ provider: "openai", model: "fake-good" });
    expect(fake.requests.at(-1)!.url).toBe("/v1/chat/completions");
    expect(fake.requests.at(-1)!.body.response_format).toEqual({ type: "json_object" });
  });

  it("a newer analysis makes older briefs stale", async () => {
    await caller("owner").changeIntelligence.reanalyze({ workspaceId: ws, changeId });
    const list = await caller("owner").ai.changeBriefs({ workspaceId: ws, changeId });
    expect(list.briefs.every(b => b.stale)).toBe(true);
  });

  it("authorization and a per-workspace hourly ceiling", async () => {
    setAi("fake-good");
    await expect(caller("viewer").ai.generateBrief({ workspaceId: ws, changeId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("outsider").ai.generateBrief({ workspaceId: otherWs, changeId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller("outsider").ai.changeBriefs({ workspaceId: ws, changeId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    process.env.AI_MAX_CALLS_PER_WORKSPACE_HOUR = "3";
    await expect(caller("owner").ai.generateBrief({ workspaceId: ws, changeId, regenerate: true })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: expect.stringMatching(/3 AI calls/) });
    delete process.env.AI_MAX_CALLS_PER_WORKSPACE_HOUR;
    const activity = await caller("viewer").ai.activity({ workspaceId: ws });
    expect(activity.totals).toMatchObject({ briefs: 4, droppedPoints: 1, adjusted: 1, analyses: 2 });
    expect(activity.failures.reduce((sum, f) => sum + f.total, 0)).toBe(8);
  });

  it("the hourly ceiling holds under concurrent requests (reservation under a lock)", async () => {
    setAi("fake-good");
    const used = (await caller("owner").ai.status({ workspaceId: ws })).usedThisHour;
    process.env.AI_MAX_CALLS_PER_WORKSPACE_HOUR = String(used + 2);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => caller("owner").ai.generateBrief({ workspaceId: ws, changeId, regenerate: true })));
    delete process.env.AI_MAX_CALLS_PER_WORKSPACE_HOUR;
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter(result => result.status === "rejected").every(result => (result as PromiseRejectedResult).reason.code === "TOO_MANY_REQUESTS")).toBe(true);
  });
});
