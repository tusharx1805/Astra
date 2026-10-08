import { ENV } from "./env";

/**
 * Reads public.profiles from Supabase **as the calling user** (their access
 * token + the anon key), so Row Level Security applies exactly as it does in
 * the browser. No service-role key is used anywhere on the server.
 */

export type ProfileSummary = { id: string; username: string; full_name: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function fetchProfiles(accessToken: string | null, userIds: string[], fetchImpl: typeof fetch = fetch): Promise<Map<string, ProfileSummary>> {
  const ids = Array.from(new Set(userIds.filter(id => UUID_PATTERN.test(id))));
  const result = new Map<string, ProfileSummary>();
  if (!accessToken || !ids.length || !ENV.supabaseUrl || !ENV.supabaseAnonKey) return result;
  const url = new URL(`${ENV.supabaseUrl.replace(/\/+$/, "")}/rest/v1/profiles`);
  url.searchParams.set("select", "id,username,full_name");
  url.searchParams.set("id", `in.(${ids.join(",")})`);
  try {
    const response = await fetchImpl(url, { headers: { apikey: ENV.supabaseAnonKey, Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return result;
    const rows = (await response.json()) as ProfileSummary[];
    for (const row of rows) result.set(row.id, row);
  } catch (error) {
    console.warn("[Profiles] Could not load profile names:", error instanceof Error ? error.message : String(error));
  }
  return result;
}
