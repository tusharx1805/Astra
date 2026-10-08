import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The single Supabase client for the browser. Only the public anon key is used
 * here; the service-role key must never appear in client code.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigError = !url || !anonKey
  ? "Sign-in is not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
  : null;

const REMEMBER_KEY = "astra-remember-session";

function safeStorage(kind: "local" | "session"): Storage | null {
  try {
    const storage = kind === "local" ? window.localStorage : window.sessionStorage;
    const probe = "__astra_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/** "Keep me signed in": when off, the session lives only for this browser tab session. */
export function setRememberSession(remember: boolean) {
  const local = safeStorage("local");
  if (!local) return;
  if (remember) local.removeItem(REMEMBER_KEY);
  else local.setItem(REMEMBER_KEY, "0");
}

export function getRememberSession() {
  return safeStorage("local")?.getItem(REMEMBER_KEY) !== "0";
}

const memory = new Map<string, string>();

/** Routes auth storage to localStorage (remembered) or sessionStorage (this tab session only). */
const authStorage = {
  getItem(key: string) {
    return safeStorage("local")?.getItem(key) ?? safeStorage("session")?.getItem(key) ?? memory.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    const target = getRememberSession() ? safeStorage("local") : safeStorage("session");
    const other = getRememberSession() ? safeStorage("session") : safeStorage("local");
    other?.removeItem(key);
    if (target) target.setItem(key, value);
    else memory.set(key, value);
  },
  removeItem(key: string) {
    safeStorage("local")?.removeItem(key);
    safeStorage("session")?.removeItem(key);
    memory.delete(key);
  },
};

export const supabase: SupabaseClient | null = supabaseConfigError
  ? null
  : createClient(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
        storage: authStorage,
      },
    });

/** Current access token for API calls (refreshes it first if it has expired). */
export async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
