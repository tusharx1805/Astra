import type { Request } from "express";
import { createHash } from "node:crypto";
import { ENV } from "./env";

/**
 * Supabase Auth is ASTRA's only identity source. There is no application
 * users table: the authenticated user IS the Supabase user (auth.users).
 *
 * The browser sends its Supabase access token as `Authorization: Bearer <jwt>`.
 * The server asks Supabase Auth who that token belongs to
 * (GET {VITE_SUPABASE_URL}/auth/v1/user with the anon key). This works for both
 * legacy (HS256) and asymmetric-key projects, needs no JWT secret, and rejects
 * revoked sessions. Results are cached briefly per token to avoid a network
 * round-trip on every tRPC call.
 */

export const ASTRA_ROLES = ["admin", "developer", "reviewer"] as const;
export type AstraRole = (typeof ASTRA_ROLES)[number];

/** The request identity. `id` is the Supabase Auth user UUID (auth.users.id). */
export type AuthUser = {
  id: string;
  email: string | null;
  name: string | null;
  /** Organization-wide role from Supabase app_metadata.astra_role (only admins/service role can set it). */
  role: AstraRole;
  /** True when Supabase reports the e-mail address as confirmed (required to accept invitations). */
  emailVerified?: boolean;
};

export type VerifyResult =
  | { status: "authenticated"; user: AuthUser }
  | { status: "invalid" }
  | { status: "unavailable" };

type SupabaseUserResponse = {
  id?: string;
  aud?: string;
  role?: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  user_metadata?: { full_name?: string; username?: string } | null;
  app_metadata?: { astra_role?: string } | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 2_000;

export function toAuthUser(payload: SupabaseUserResponse): AuthUser | null {
  if (!payload.id || !UUID_PATTERN.test(payload.id)) return null;
  if (payload.aud && payload.aud !== "authenticated") return null;
  const requestedRole = payload.app_metadata?.astra_role;
  const role: AstraRole = (ASTRA_ROLES as readonly string[]).includes(requestedRole ?? "") ? (requestedRole as AstraRole) : "developer";
  const name = payload.user_metadata?.full_name?.trim() || payload.user_metadata?.username?.trim() || null;
  return { id: payload.id.toLowerCase(), email: payload.email ?? null, name, role, emailVerified: Boolean(payload.email_confirmed_at ?? payload.confirmed_at) };
}

function tokenExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export type SupabaseVerifierOptions = { url: string; anonKey: string; fetchImpl?: typeof fetch; now?: () => number };

export function createSupabaseTokenVerifier(options: SupabaseVerifierOptions) {
  const endpoint = `${options.url.replace(/\/+$/, "")}/auth/v1/user`;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { user: AuthUser; expiresAt: number }>();

  return async function verify(token: string): Promise<VerifyResult> {
    const expiry = tokenExpiryMs(token);
    if (expiry === null || expiry <= now()) return { status: "invalid" };
    const key = createHash("sha256").update(token).digest("base64url");
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return { status: "authenticated", user: cached.user };
    if (cached) cache.delete(key);

    let response: Response;
    try {
      response = await doFetch(endpoint, { headers: { Authorization: `Bearer ${token}`, apikey: options.anonKey }, signal: AbortSignal.timeout(8_000) });
    } catch (error) {
      console.error("[Auth] Supabase Auth unreachable:", error instanceof Error ? error.message : String(error));
      return { status: "unavailable" };
    }
    if (response.status === 401 || response.status === 403) return { status: "invalid" };
    if (!response.ok) {
      console.error(`[Auth] Supabase Auth returned ${response.status}`);
      return response.status >= 500 ? { status: "unavailable" } : { status: "invalid" };
    }
    const user = toAuthUser((await response.json().catch(() => ({}))) as SupabaseUserResponse);
    if (!user) return { status: "invalid" };
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, { user, expiresAt: Math.min(now() + CACHE_TTL_MS, expiry) });
    return { status: "authenticated", user };
  };
}

let cachedVerifier: ReturnType<typeof createSupabaseTokenVerifier> | null = null;

export function supabaseConfigProblem(): string | null {
  if (!ENV.supabaseUrl && !ENV.supabaseAnonKey) return "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set";
  if (!ENV.supabaseUrl) return "VITE_SUPABASE_URL is not set";
  if (!ENV.supabaseAnonKey) return "VITE_SUPABASE_ANON_KEY is not set";
  return null;
}

function defaultVerifier() {
  if (supabaseConfigProblem()) return null;
  cachedVerifier ??= createSupabaseTokenVerifier({ url: ENV.supabaseUrl, anonKey: ENV.supabaseAnonKey });
  return cachedVerifier;
}

export function bearerToken(req: Pick<Request, "headers">): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/** Resolve the request identity from the Supabase token only. Never touches the application database. */
export async function authenticateSupabaseRequest(req: Pick<Request, "headers">, verifier = defaultVerifier()): Promise<VerifyResult> {
  const token = bearerToken(req);
  if (!token) return { status: "invalid" };
  if (!verifier) return { status: "unavailable" };
  return verifier(token);
}
