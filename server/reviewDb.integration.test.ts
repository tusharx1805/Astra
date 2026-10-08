import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

/**
 * Phase 5 checkpoint tests against a REAL Supabase-shaped Postgres.
 * Run with: TEST_DATABASE_URL=postgres://user:pass@host:5432/astra_test pnpm test. Skipped when unset.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CSV = "customer_id,email,plan,seats,active,region\nC-1001,ada@example.com,pro,12,true,Mumbai\nC-1002,ben@example.com,starter,4,true,Nashik\nC-1003,,pro,8,false,Pune\nC-1004,\"drew, jr@example.com\",enterprise,41,true,Mumbai\nC-1005,esha@example.com,pro,15,true,\n";

describe.skipIf(!url)("Phase 5 — persisted reviews (real database)", async () => {
  const { appRouter } = await import("./routers");
  const dbModule = await import("./db");
  const { randomUUID } = await import("node:crypto");
  const schema = await import("../drizzle/schema");
  const store = await import("./reviewStore");

  type Ctx = TrpcContext;
  const makeCtx = (user: NonNullable<Ctx["user"]>): Ctx => ({ user, req: { protocol: "https", headers: {} } as Ctx["req"], res: {} as Ctx["res"] });
  const users: Record<string, NonNullable<Ctx["user"]>> = {};
  const caller = (key: string) => appRouter.createCaller(makeCtx(users[key]!));
  const db = async () => (await dbModule.getDb())!;
  let ws = 0, wsB = 0, customers = 0, shared = 0, refresher = 0;
  let critical = { changeId: 0, analysisId: 0 };
  let safe = { changeId: 0, analysisId: 0 };

  beforeAll(async () => {
    // owner (workspace owner, also the change author), developer, reviewer, admin, viewer, outsider
    for (const key of ["owner", "developer", "reviewer", "admin", "viewer", "outsider"]) {
      const user = { id: randomUUID(), email: `${key}-p5-${suffix}@example.com`, name: `Phase5 ${key}`, role: "developer" as const };
      await (await db()).execute(sql`insert into auth.users (id, email, raw_user_meta_data) values (${user.id}, ${user.email}, ${JSON.stringify({ username: `p5${key}_${suffix}`.replace(/[^a-z0-9_]/g, "_").slice(0, 30), full_name: user.name })}::jsonb)`);
      users[key] = user;
    }
    ws = (await caller("owner").workspace.create({ name: `P5 A ${suffix}` })).id;
    wsB = (await caller("owner").workspace.create({ name: `P5 B ${suffix}` })).id;
    await (await db()).insert(schema.workspaceMembers).values(["developer", "reviewer", "admin", "viewer"].map(role => ({ workspaceId: ws, userId: users[role]!.id, role: role as "developer" })));
    customers = (await caller("owner").dataset.importCsv({ workspaceId: ws, name: "customers", csvText: CSV })).id;
    shared = (await caller("owner").dataset.importCsv({ workspaceId: ws, name: "customers_shared", csvText: CSV })).id;
    await caller("owner").pipeline.create({ workspaceId: ws, name: "contactable customers", sourceDatasetId: shared, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "email", operator: "is_not_null" }] });
    refresher = (await caller("owner").pipeline.create({ workspaceId: ws, name: "refresh shared", sourceDatasetId: customers, destinationMode: "overwrite_existing", destinationDatasetId: shared, steps: [] })).id;
    // CRITICAL change authored by the DEVELOPER; SAFE change authored by the OWNER.
    const version = (await caller("developer").pipeline.get({ workspaceId: ws, pipelineId: refresher })).version;
    const a = await caller("developer").changeIntelligence.analyzePipelineChange({ workspaceId: ws, pipelineId: refresher, baseVersion: version, definition: { name: "refresh shared", sourceDatasetId: customers, destinationMode: "overwrite_existing", destinationDatasetId: shared, steps: [{ operation: "drop_column", column: "email" }] } });
    critical = { changeId: a.changeId, analysisId: a.analysisId };
    expect(a.result.level).toBe("CRITICAL");
    const b = await caller("owner").changeIntelligence.analyzePipelineChange({ workspaceId: ws, definition: { name: "pro customers", sourceDatasetId: customers, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "plan", operator: "equals", value: "pro" }] } });
    safe = { changeId: b.changeId, analysisId: b.analysisId };
  });

  let reviewId = 0;

  it("a reviewer's decision is written to the reviews table and read back from it", async () => {
    const out = await caller("reviewer").changeIntelligence.recordReview({ workspaceId: ws, ...critical, decision: "BLOCKED", comment: "Drops email that contactable customers needs." });
    reviewId = out.id;
    expect(out).toMatchObject({ changeId: critical.changeId, decision: "BLOCKED", reviewedAnalysisId: critical.analysisId, reviewedLevel: "CRITICAL", reviewer: "You" });
    // Proof of persistence = a separate connection sees the row (not the mutation response).
    const fresh = drizzle(postgres(url!, { prepare: false, max: 1 }));
    const [row] = await fresh.select().from(schema.reviews).where(eq(schema.reviews.id, reviewId));
    expect(row).toMatchObject({ changeId: critical.changeId, reviewerId: users.reviewer!.id, decision: "blocked", comment: "Drops email that contactable customers needs." });
    const [log] = await fresh.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "REVIEW_RECORDED"), eq(schema.auditLogs.resourceId, String(critical.changeId))));
    expect(log!.metadata).toMatchObject({ reviewId, decision: "BLOCKED", analysisId: critical.analysisId, level: "CRITICAL" });
  });

  it("the UI read path returns decisions from the database, not reviewStore", async () => {
    expect(store.listReviews(String(critical.changeId))).toEqual([]);
    const detail = await caller("owner").changeIntelligence.change({ workspaceId: ws, changeId: critical.changeId });
    expect(detail).toMatchObject({ reviewStatus: "BLOCKED", canReview: true, isAuthor: false });
    expect(detail.reviews[0]).toMatchObject({ id: reviewId, decision: "BLOCKED", reviewer: expect.any(String), reviewedAnalysisId: critical.analysisId });
    const list = await caller("viewer").changeIntelligence.changes({ workspaceId: ws });
    expect(list.find(item => item.id === critical.changeId)).toMatchObject({ reviewStatus: "BLOCKED", reviewCount: 1 });
    const history = await caller("viewer").changeIntelligence.reviews({ workspaceId: ws });
    expect(history[0]).toMatchObject({ id: reviewId, changeTitle: expect.stringContaining("refresh shared") });
  });

  it("disallowed actors cannot record decisions (server-side)", async () => {
    for (const key of ["developer", "viewer"]) {
      await expect(caller(key).changeIntelligence.recordReview({ workspaceId: ws, ...safe, decision: "APPROVED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(caller("outsider").changeIntelligence.recordReview({ workspaceId: ws, ...safe, decision: "APPROVED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Right user, wrong workspace: the change does not exist there.
    await expect(caller("owner").changeIntelligence.recordReview({ workspaceId: wsB, ...safe, decision: "BLOCKED", comment: "cross workspace" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const count = await (await db()).select({ n: sql<number>`count(*)` }).from(schema.reviews).where(eq(schema.reviews.changeId, safe.changeId));
    expect(Number(count[0]!.n)).toBe(0);
  });

  it("policy: no self-approval; blocks/requests and HIGH/CRITICAL approvals need a reason", async () => {
    // The owner authored the SAFE change → cannot approve it, but may block it with a reason.
    await expect(caller("owner").changeIntelligence.recordReview({ workspaceId: ws, ...safe, decision: "APPROVED" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/cannot approve/) });
    await expect(caller("admin").changeIntelligence.recordReview({ workspaceId: ws, ...safe, decision: "CHANGES_REQUESTED", comment: " " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller("admin").changeIntelligence.recordReview({ workspaceId: ws, ...critical, decision: "APPROVED" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/CRITICAL change needs a written justification/) });
    await expect(caller("admin").changeIntelligence.recordReview({ workspaceId: ws, ...safe, decision: "APPROVED" })).resolves.toMatchObject({ decision: "APPROVED", reviewedLevel: "SAFE" });
  });

  it("a decision is tied to the latest analysis; a newer analysis requires re-review", async () => {
    // Fix the downstream reader, re-analyse → the BLOCK now refers to an outdated analysis.
    const again = await caller("developer").changeIntelligence.reanalyze({ workspaceId: ws, changeId: critical.changeId });
    let detail = await caller("owner").changeIntelligence.change({ workspaceId: ws, changeId: critical.changeId });
    expect(detail.reviewStatus).toBe("RE-REVIEW NEEDED");
    // Reviewing the old analysis is refused.
    await expect(caller("reviewer").changeIntelligence.recordReview({ workspaceId: ws, ...critical, decision: "APPROVED", comment: "looks fine now" })).rejects.toMatchObject({ code: "CONFLICT" });
    const approved = await caller("reviewer").changeIntelligence.recordReview({ workspaceId: ws, changeId: critical.changeId, analysisId: again.analysisId, decision: "APPROVED", comment: "Re-analysed; accepted with the overwrite." });
    expect(approved.reviewedAnalysisId).toBe(again.analysisId);
    detail = await caller("owner").changeIntelligence.change({ workspaceId: ws, changeId: critical.changeId });
    expect(detail.reviewStatus).toBe("APPROVED");
    expect(detail.reviews.map(item => [item.decision, item.reviewedAnalysisId])).toEqual([["APPROVED", again.analysisId], ["BLOCKED", critical.analysisId]]);
  });

  it("durability: a brand-new connection (as after a restart) sees the full decision history", async () => {
    const fresh = drizzle(postgres(url!, { prepare: false, max: 1 }));
    const rows = await fresh.select({ decision: schema.reviews.decision }).from(schema.reviews).where(eq(schema.reviews.changeId, critical.changeId)).orderBy(schema.reviews.id);
    expect(rows.map(row => row.decision)).toEqual(["blocked", "approved"]);
  });

  it("the simulated sandbox review path is separate and still uses the global role", async () => {
    await expect(caller("reviewer").changeIntelligence.recordSandboxReview({ changeId: "RA-SANDBOX", decision: "BLOCKED", riskLevel: "HIGH" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
