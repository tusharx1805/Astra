import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const databaseRef = vi.hoisted(() => ({ current: null as any }));
const notifyRef = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./db", () => ({ getDb: async () => databaseRef.current }));
vi.mock("./_core/notification", () => ({ notifyOwner: async () => { notifyRef.calls += 1; return true; } }));

const { appRouter } = await import("./routers");
const { createWorkspacePostgresConnection } = await import("./workspaceDb");
const { getSessionCookieOptions } = await import("./_core/cookies");
const { listFixtureDatasets } = await import("./realDataFlow");

const user = { id: "00000000-0000-4000-8000-000000000007", name: "Bugfix", email: "b@example.com", role: "reviewer" } as NonNullable<TrpcContext["user"]>;

function ctx(withUser: boolean): TrpcContext {
  return { user: withUser ? user : null, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

function workspaceRoleDb(role: string) {
  const builder: any = { from: () => builder, innerJoin: () => builder, where: () => builder, limit: async () => [{ id: 5, name: "W", organizationId: 11, createdBy: 1, createdAt: new Date(), updatedAt: new Date(), role }] };
  return { select: vi.fn(() => builder), insert: vi.fn() };
}

beforeEach(() => { notifyRef.calls = 0; });

describe("bug fixes", () => {
  it("does not let anonymous callers trigger owner notifications from the simulated analyzer", async () => {
    const input = { title: "Anon change", source: "select 1", changeType: "SQL" as const };
    const anonymous = await appRouter.createCaller(ctx(false)).changeIntelligence.analyze(input);
    expect(anonymous.notificationDispatched).toBe(false);
    expect(notifyRef.calls).toBe(0);
    const signedIn = await appRouter.createCaller(ctx(true)).changeIntelligence.analyze(input);
    expect(signedIn.notificationDispatched).toBe(true);
    expect(notifyRef.calls).toBe(1);
  });

  it("forbids non-admin workspace members from saving PostgreSQL credentials", async () => {
    const db = workspaceRoleDb("viewer");
    databaseRef.current = db;
    await expect(createWorkspacePostgresConnection(user, { workspaceId: 5, name: "pg", host: "h", port: 5432, databaseName: "d", username: "u", password: "p", sslMode: "require" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("uses SameSite=Lax for plain-http sessions so browsers keep the cookie, and None+Secure over https", () => {
    expect(getSessionCookieOptions({ protocol: "http", headers: {} } as never)).toMatchObject({ sameSite: "lax", secure: false });
    expect(getSessionCookieOptions({ protocol: "https", headers: {} } as never)).toMatchObject({ sameSite: "none", secure: true });
  });

  it("seeds the development fixture for any workspace id, not only workspace 1", () => {
    const fixtures = listFixtureDatasets(4242);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({ name: "customer_accounts_fixture", rowCount: 4 });
    expect(listFixtureDatasets(4242)).toHaveLength(1);
  });
});

describe("database connection", () => {
  it("uses TLS for Supabase hosts and not for localhost", async () => {
    const { sslFor } = await vi.importActual<typeof import("./db")>("./db");
    expect(sslFor("postgresql://postgres.abcd:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres")).toBe("require");
    expect(sslFor("postgres://postgres:pw@localhost:5432/astra")).toBe(false);
  });
});
