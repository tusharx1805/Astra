import { useAuthContext } from "@/contexts/AuthContext";
import { useCallback, useEffect } from "react";
import { useLocation } from "wouter";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

/**
 * App-wide auth hook (same shape existing components already use).
 * Backed by the Supabase AuthProvider; `user` is the Supabase Auth user from the
 * current session (no backend call), `profile` is the Supabase public.profiles row.
 */
export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath = "/login" } = options ?? {};
  const auth = useAuthContext();
  const [, setLocation] = useLocation();

  const logout = useCallback(async () => {
    await auth.signOut();
    setLocation("/login", { replace: true });
  }, [auth, setLocation]);

  useEffect(() => {
    if (!redirectOnUnauthenticated || auth.status !== "unauthenticated") return;
    if (window.location.pathname === redirectPath) return;
    setLocation(redirectPath, { replace: true });
  }, [redirectOnUnauthenticated, redirectPath, auth.status, setLocation]);

  return {
    user: auth.appUser ?? null,
    profile: auth.profile,
    supabaseUser: auth.supabaseUser,
    session: auth.session,
    loading: auth.status === "loading",
    error: null,
    isAuthenticated: auth.status === "authenticated",
    refresh: () => auth.refreshProfile(),
    logout,
  };
}
