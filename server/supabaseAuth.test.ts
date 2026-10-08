import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

// Authentication must never touch the application database. If anything in the
// auth path imports and calls it, these tests fail loudly.
const dbCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("./db", () => ({
  getDb: async () => {
    dbCalls.count += 1;
    // Simulates the reported production failure: the database host cannot be resolved.
    return { select: () => { throw new Error("getaddrinfo ENOTFOUND host (select `id` from `workspaces`)"); } };
  },
}));

const { authenticateSupabaseRequest, createSupabaseTokenVerifier, toAuthUser } = await import("./_core/supabaseAuth");
const { appRouter } = await import("./routers");

const URL_ = "https://abcd.supabase.co";
const UID = "5f1c2a3b-1111-4222-8333-944455556666";

function token(expSecondsFromNow = 3600) {
  const header = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: UID, exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })).toString("base64url");
  return `${header}.${payload}.signature-checked-by-supabase`;
}

function supabaseUser(overrides: Record<string, unknown> = {}) {
  return { id: UID, aud: "authenticated", role: "authenticated", email: "ada@example.com", user_metadata: { full_name: "Ada Lovelace", username: "ada" }, app_metadata: { provider: "email" }, ...overrides };
}

function mockFetch(response: () => Response | Promise<Response>) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
}

beforeEach(() => { dbCalls.count = 0; });

describe("Supabase token verification (no database)", () => {
  it("asks Supabase Auth who the token belongs to, using only the URL and anon key", async () => {
    const fetchImpl = mockFetch(() => Response.json(supabaseUser()));
    const verify = createSupabaseTokenVerifier({ url: URL_, anonKey: "anon-key", fetchImpl });
    const jwt = token();
    const result = await verify(jwt);
    expect(result).toEqual({ status: "authenticated", user: { id: UID, email: "ada@example.com", name: "Ada Lovelace", role: "developer", emailVerified: false } });
    const [endpoint, init] = fetchImpl.mock.calls[0]!;
    expect(String(endpoint)).toBe(`${URL_}/auth/v1/user`);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${jwt}`, apikey: "anon-key" });
    expect(dbCalls.count).toBe(0);
  });

  it("caches a verified token briefly (no network call per request)", async () => {
    const fetchImpl = mockFetch(() => Response.json(supabaseUser()));
    const verify = createSupabaseTokenVerifier({ url: URL_, anonKey: "k", fetchImpl });
    const jwt = token();
    await verify(jwt); await verify(jwt); await verify(jwt);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects tokens Supabase rejects, expired tokens and malformed tokens", async () => {
    const rejecting = createSupabaseTokenVerifier({ url: URL_, anonKey: "k", fetchImpl: mockFetch(() => new Response("{}", { status: 401 })) });
    expect(await rejecting(token())).toEqual({ status: "invalid" });
    const neverCalled = mockFetch(() => Response.json(supabaseUser()));
    const verify = createSupabaseTokenVerifier({ url: URL_, anonKey: "k", fetchImpl: neverCalled });
    expect(await verify(token(-60))).toEqual({ status: "invalid" });
    expect(await verify("not-a-jwt")).toEqual({ status: "invalid" });
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it("reports an outage as 'unavailable', not as 'signed out'", async () => {
    const down = createSupabaseTokenVerifier({ url: URL_, anonKey: "k", fetchImpl: mockFetch(() => { throw new TypeError("fetch failed"); }) });
    expect(await down(token())).toEqual({ status: "unavailable" });
    const erroring = createSupabaseTokenVerifier({ url: URL_, anonKey: "k", fetchImpl: mockFetch(() => new Response("{}", { status: 503 })) });
    expect(await erroring(token())).toEqual({ status: "unavailable" });
  });

  it("takes the role only from app_metadata (admin-controlled), never from user_metadata", () => {
    expect(toAuthUser(supabaseUser({ app_metadata: { astra_role: "admin" } }))?.role).toBe("admin");
    expect(toAuthUser(supabaseUser({ app_metadata: { astra_role: "superuser" } }))?.role).toBe("developer");
    expect(toAuthUser(supabaseUser({ user_metadata: { astra_role: "admin" } }))?.role).toBe("developer");
    expect(toAuthUser(supabaseUser({ id: "not-a-uuid" }))).toBeNull();
    expect(toAuthUser(supabaseUser({ aud: "anon" }))).toBeNull();
  });

  it("treats a request without a bearer token as signed out", async () => {
    expect(await authenticateSupabaseRequest({ headers: {} }, createSupabaseTokenVerifier({ url: URL_, anonKey: "k", fetchImpl: mockFetch(() => Response.json(supabaseUser())) }))).toEqual({ status: "invalid" });
  });
});

describe("tRPC behaviour without the database", () => {
  const user = { id: UID, email: "ada@example.com", name: "Ada", role: "developer" as const };
  const ctx = (overrides: Partial<TrpcContext>): TrpcContext => ({ user: null, req: { headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"], ...overrides });

  it("auth.me returns the Supabase identity with zero database access", async () => {
    await expect(appRouter.createCaller(ctx({ user })).auth.me()).resolves.toEqual(user);
    expect(dbCalls.count).toBe(0);
  });

  it("protected calls: signed out → UNAUTHORIZED; Supabase outage → not UNAUTHORIZED (session is kept)", async () => {
    await expect(appRouter.createCaller(ctx({})).workspace.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(appRouter.createCaller(ctx({ authUnavailable: true })).workspace.list()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("an unreachable database host (ENOTFOUND) surfaces as a safe message, never driver/SQL text", async () => {
    const { getHTTPStatusCodeFromError } = await import("@trpc/server/http");
    let caught: any;
    try { await appRouter.createCaller(ctx({ user })).workspace.list(); } catch (error) { caught = error; }
    expect(caught?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(getHTTPStatusCodeFromError(caught)).toBe(500);
    const shape = (appRouter as any)._def._config.errorFormatter({ shape: { message: caught.message, code: -32603, data: { code: "INTERNAL_SERVER_ERROR" } }, error: caught });
    expect(shape.message).toBe("The data store is unavailable. Please try again later.");
    expect(JSON.stringify(shape)).not.toMatch(/ENOTFOUND|select/);
  });
});

describe("e-mail confirmation flag (needed to accept invitations)", () => {
  it("is true only when Supabase reports a confirmation time", async () => {
    const { toAuthUser } = await import("./_core/supabaseAuth");
    const base = { id: "5f1c2a3b-1111-4222-8333-944455556666", aud: "authenticated", email: "ada@example.com" };
    expect(toAuthUser({ ...base, email_confirmed_at: "2026-09-30T10:00:00Z" })?.emailVerified).toBe(true);
    expect(toAuthUser({ ...base, email_confirmed_at: null })?.emailVerified).toBe(false);
  });
});
