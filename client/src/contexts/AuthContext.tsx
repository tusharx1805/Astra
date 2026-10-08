import { friendlyAuthError, type FriendlyAuthError } from "@/lib/authErrors";
import { normalizeUsername } from "@/lib/authValidation";
import { setRememberSession, supabase, supabaseConfigError } from "@/lib/supabase";
import type { Session, User as SupabaseUser } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export type Profile = { id: string; username: string; full_name: string; avatar_url: string | null; created_at: string; updated_at: string };

/**
 * The signed-in user, taken directly from the Supabase session (auth.users).
 * There is no application users table and no backend call involved in signing in.
 */
export type AppUser = { id: string; email: string | null; name: string | null; role: "admin" | "developer" | "reviewer" };

/**
 * loading          – Supabase has not yet reported the initial session (render nothing protected yet)
 * authenticated    – a Supabase session exists
 * unauthenticated  – no Supabase session
 */
export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

type Result<T = void> = { ok: true; data: T } | { ok: false; error: FriendlyAuthError };
export const AUTH_UNAUTHORIZED_EVENT = "astra-auth-unauthorized";
const USER_SCOPED_STORAGE_KEYS = ["astra-active-workspace", "manus-runtime-user-info"];

type AuthContextValue = {
  status: AuthStatus;
  session: Session | null;
  supabaseUser: SupabaseUser | null;
  profile: Profile | null;
  appUser: AppUser | null;
  configError: string | null;
  notice: string | null;
  clearNotice: () => void;
  signIn: (input: { email: string; password: string; remember: boolean }) => Promise<Result>;
  signUp: (input: { email: string; password: string; username: string; fullName: string }) => Promise<Result<{ needsEmailConfirmation: boolean }>>;
  resendConfirmation: (email: string) => Promise<Result>;
  isUsernameAvailable: (username: string) => Promise<boolean | null>;
  requestPasswordReset: (email: string) => Promise<Result>;
  updatePassword: (password: string) => Promise<Result>;
  updateProfile: (changes: Partial<Pick<Profile, "username" | "full_name" | "avatar_url">>) => Promise<Result<Profile>>;
  refreshProfile: () => Promise<void>;
  signOut: (reason?: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const notConfigured = (): { ok: false; error: FriendlyAuthError } => ({ ok: false, error: { kind: "not_configured", message: supabaseConfigError ?? "Sign-in is not configured." } });

function clearUserScopedStorage() {
  for (const key of USER_SCOPED_STORAGE_KEYS) {
    try { window.localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
  try { window.sessionStorage.removeItem("manus-cookie"); } catch { /* storage unavailable */ }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [initialized, setInitialized] = useState(!supabase);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lastUserId = useRef<string | null>(null);

  // 1) Session: read the stored session once, then stay in sync with onAuthStateChange
  //    (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED, SIGNED_OUT).
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void supabase.auth.getSession().then(({ data: current }) => {
      if (!active) return;
      setSession(current.session);
      lastUserId.current ??= current.session?.user.id ?? null;
      setInitialized(true);
    });
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      // Keep this callback synchronous: calling other supabase methods inside it can deadlock.
      setSession(next);
      setInitialized(true);
      const nextUserId = next?.user.id ?? null;
      if (nextUserId !== lastUserId.current) {
        // Different identity (sign in, sign out, account switch): drop every user-scoped cache.
        if (lastUserId.current !== null) { queryClient.clear(); clearUserScopedStorage(); }
        lastUserId.current = nextUserId;
      }
      if (event === "SIGNED_OUT") setProfile(null);
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [queryClient]);

  // 2) The user comes straight from the session: no server round-trip decides who is signed in.
  const appUser = useMemo<AppUser | null>(() => {
    const user = session?.user;
    if (!user) return null;
    const role = user.app_metadata?.astra_role;
    const metadata = (user.user_metadata ?? {}) as { full_name?: string; username?: string };
    return { id: user.id, email: user.email ?? null, name: metadata.full_name?.trim() || metadata.username || null, role: role === "admin" || role === "reviewer" ? role : "developer" };
  }, [session?.user]);

  // 3) Profile row from Supabase (RLS: readable by signed-in users, updatable only by its owner).
  const refreshProfile = useCallback(async () => {
    const userId = session?.user.id;
    if (!supabase || !userId) { setProfile(null); return; }
    const { data, error } = await supabase.from("profiles").select("id, username, full_name, avatar_url, created_at, updated_at").eq("id", userId).maybeSingle();
    if (error) { friendlyAuthError(error, "profile load"); return; }
    setProfile((data as Profile | null) ?? null);
  }, [session?.user.id]);
  useEffect(() => { void refreshProfile(); }, [refreshProfile]);

  const signOut = useCallback(async (reason?: string) => {
    try { await supabase?.auth.signOut({ scope: "local" }); } catch (error) { friendlyAuthError(error, "sign out"); }
    setSession(null);
    setProfile(null);
    lastUserId.current = null;
    queryClient.clear();
    clearUserScopedStorage();
    if (reason) setNotice(reason);
  }, [queryClient]);

  // 4) Server said UNAUTHORIZED while we think we are signed in: try one refresh, else sign out.
  const handlingUnauthorized = useRef(false);
  useEffect(() => {
    const onUnauthorized = async () => {
      if (!supabase || handlingUnauthorized.current || !session) return;
      handlingUnauthorized.current = true;
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (error || !data.session) await signOut("Your session has expired. Please sign in again.");
        else void queryClient.invalidateQueries();
      } finally {
        handlingUnauthorized.current = false;
      }
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
  }, [session, signOut, queryClient]);

  const status: AuthStatus = !initialized ? "loading" : session ? "authenticated" : "unauthenticated";

  const value = useMemo<AuthContextValue>(() => ({
    status,
    session,
    supabaseUser: session?.user ?? null,
    profile,
    appUser,
    configError: supabaseConfigError,
    notice,
    clearNotice: () => setNotice(null),
    async signIn({ email, password, remember }) {
      if (!supabase) return notConfigured();
      setRememberSession(remember);
      setNotice(null);
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      return error ? { ok: false, error: friendlyAuthError(error, "sign in") } : { ok: true, data: undefined };
    },
    async signUp({ email, password, username, fullName }) {
      if (!supabase) return notConfigured();
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { username: normalizeUsername(username), full_name: fullName.trim() },
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) return { ok: false, error: friendlyAuthError(error, "sign up") };
      // With email confirmation on, Supabase hides existing accounts by returning a user with no identities.
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) return { ok: false, error: friendlyAuthError({ code: "user_already_exists" }) };
      return { ok: true, data: { needsEmailConfirmation: !data.session } };
    },
    async resendConfirmation(email) {
      if (!supabase) return notConfigured();
      const { error } = await supabase.auth.resend({ type: "signup", email: email.trim(), options: { emailRedirectTo: `${window.location.origin}/auth/callback` } });
      return error ? { ok: false, error: friendlyAuthError(error, "resend") } : { ok: true, data: undefined };
    },
    async isUsernameAvailable(username) {
      if (!supabase) return null;
      const { data, error } = await supabase.rpc("username_available", { candidate: normalizeUsername(username) });
      if (error) { friendlyAuthError(error, "username check"); return null; }
      return Boolean(data);
    },
    async requestPasswordReset(email) {
      if (!supabase) return notConfigured();
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/reset-password` });
      // Rate limits are worth reporting; any other outcome is reported as "email sent" so accounts can't be enumerated.
      if (error && friendlyAuthError(error).kind === "rate_limited") return { ok: false, error: friendlyAuthError(error) };
      if (error && friendlyAuthError(error).kind === "network") return { ok: false, error: friendlyAuthError(error) };
      return { ok: true, data: undefined };
    },
    async updatePassword(password) {
      if (!supabase) return notConfigured();
      const { error } = await supabase.auth.updateUser({ password });
      return error ? { ok: false, error: friendlyAuthError(error, "update password") } : { ok: true, data: undefined };
    },
    async updateProfile(changes) {
      if (!supabase || !session) return notConfigured();
      const payload = { ...changes, ...(changes.username ? { username: normalizeUsername(changes.username) } : {}) };
      const { data, error } = await supabase.from("profiles").update(payload).eq("id", session.user.id).select("id, username, full_name, avatar_url, created_at, updated_at").single();
      if (error) return { ok: false, error: error.code === "23505" ? friendlyAuthError({ message: "ASTRA_USERNAME_TAKEN" }) : friendlyAuthError(error, "update profile") };
      setProfile(data as Profile);
      return { ok: true, data: data as Profile };
    },
    refreshProfile,
    signOut,
  }), [status, session, profile, appUser, notice, refreshProfile, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuthContext must be used inside <AuthProvider>.");
  return context;
}
