import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

/** Release fix: invitations can be accepted, so a second person can review (and approve) changes. */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CSV = "customer_id,email,plan\nC-1,a@example.com,pro\nC-2,,starter\nC-3,c@example.com,pro\n";

describe.skipIf(!url)("Invitations → membership → review (real database)", async () => {
  const { appRouter } = await import("./routers");
  const dbModule = await import("./db");
  const { randomUUID } = await import("node:crypto");
  const schema = await import("../drizzle/schema");
  type Ctx = TrpcContext;
  const users: Record<string, NonNullable<Ctx["user"]>> = {};
  const caller = (key: string) => appRouter.createCaller({ user: users[key]!, req: { protocol: "https", headers: {} } as Ctx["req"], res: {} as Ctx["res"] });
  const db = async () => (await dbModule.getDb())!;
  let ws = 0;

  beforeAll(async () => {
    for (const [key, verified] of [["owner", true], ["reviewer", true], ["unverified", false], ["stranger", true]] as const) {
      const user = { id: randomUUID(), email: `${key}-inv-${suffix}@Example.com`, name: key, role: "developer" as const, emailVerified: verified };
      await (await db()).execute(sql`insert into auth.users (id, email, raw_user_meta_data) values (${user.id}, ${user.email.toLowerCase()}, ${JSON.stringify({ username: `inv${key}_${suffix}`.replace(/[^a-z0-9_]/g, "_").slice(0, 30), full_name: key })}::jsonb)`);
      users[key] = user;
    }
    ws = (await caller("owner").workspace.create({ name: `Team ${suffix}` })).id;
  });

  it("duplicate workspace names are a clear CONFLICT (not 'data store unavailable')", async () => {
    await expect(caller("owner").workspace.create({ name: `team ${suffix}` })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("the invitee sees the invitation (case-insensitive e-mail) and accepts it", async () => {
    await caller("owner").workspace.invite({ workspaceId: ws, email: `reviewer-inv-${suffix}@example.com`, role: "reviewer" });
    await caller("owner").workspace.invite({ workspaceId: ws, email: `unverified-inv-${suffix}@example.com`, role: "viewer" });
    const mine = await caller("reviewer").workspace.myInvitations();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ workspaceId: ws, role: "reviewer", emailVerified: true });
    expect(await caller("stranger").workspace.myInvitations()).toHaveLength(0);
    await expect(caller("stranger").workspace.respondToInvitation({ invitationId: mine[0]!.id, accept: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const joined = await caller("reviewer").workspace.respondToInvitation({ invitationId: mine[0]!.id, accept: true });
    expect(joined).toMatchObject({ workspaceId: ws, accepted: true, role: "reviewer" });
    expect((await caller("reviewer").workspace.list()).map(item => [item.id, item.role])).toContainEqual([ws, "reviewer"]);
    await expect(caller("reviewer").workspace.respondToInvitation({ invitationId: mine[0]!.id, accept: true })).rejects.toMatchObject({ code: "CONFLICT" });
    const members = await (await db()).select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.workspaceId, ws));
    expect(members.map(member => member.role).sort()).toEqual(["owner", "reviewer"]);
  });

  it("an unconfirmed e-mail cannot accept; an expired invitation cannot be accepted; admins can revoke", async () => {
    const [pending] = await caller("unverified").workspace.myInvitations();
    expect(pending!.emailVerified).toBe(false);
    await expect(caller("unverified").workspace.respondToInvitation({ invitationId: pending!.id, accept: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await (await db()).update(schema.workspaceInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.workspaceInvitations.id, pending!.id));
    users.unverified!.emailVerified = true;
    await expect(caller("unverified").workspace.respondToInvitation({ invitationId: pending!.id, accept: true })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/expired/) });
    await caller("owner").workspace.invite({ workspaceId: ws, email: `stranger-inv-${suffix}@example.com`, role: "viewer" });
    const [strangerInvite] = await caller("stranger").workspace.myInvitations();
    await expect(caller("reviewer").workspace.revokeInvitation({ workspaceId: ws, invitationId: strangerInvite!.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await caller("owner").workspace.revokeInvitation({ workspaceId: ws, invitationId: strangerInvite!.id });
    expect(await caller("stranger").workspace.myInvitations()).toHaveLength(0);
  });

  it("the joined reviewer can now APPROVE the owner's change — the path that was impossible before", async () => {
    const source = (await caller("owner").dataset.importCsv({ workspaceId: ws, name: "customers", csvText: CSV })).id;
    const out = await caller("owner").changeIntelligence.analyzePipelineChange({ workspaceId: ws, definition: { name: "contactable", sourceDatasetId: source, destinationMode: "new_dataset", steps: [{ operation: "filter", column: "email", operator: "is_not_null" }] } });
    await expect(caller("owner").changeIntelligence.recordReview({ workspaceId: ws, changeId: out.changeId, analysisId: out.analysisId, decision: "APPROVED", comment: "self" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const review = await caller("reviewer").changeIntelligence.recordReview({ workspaceId: ws, changeId: out.changeId, analysisId: out.analysisId, decision: "APPROVED", comment: "Checked the output." });
    expect(review).toMatchObject({ decision: "APPROVED" });
    expect((await caller("owner").changeIntelligence.change({ workspaceId: ws, changeId: out.changeId })).reviewStatus).toBe("APPROVED");
  });
});
