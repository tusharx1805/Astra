import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { authenticateSupabaseRequest, type AuthUser } from "./supabaseAuth";

export type { AuthUser } from "./supabaseAuth";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  /** The Supabase Auth user behind the request's bearer token, or null. No database lookup is involved. */
  user: AuthUser | null;
  /** True when Supabase Auth could not be reached/configured, so "not signed in" would be the wrong answer. */
  authUnavailable?: boolean;
};

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  const result = await authenticateSupabaseRequest(opts.req);
  return {
    req: opts.req,
    res: opts.res,
    user: result.status === "authenticated" ? result.user : null,
    authUnavailable: result.status === "unavailable",
  };
}
