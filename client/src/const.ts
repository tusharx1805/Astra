export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/**
 * Send the user to ASTRA's sign-in page (Supabase Auth). Kept under its original
 * name so existing callers keep working; it no longer starts the Manus OAuth flow.
 * The current path is preserved so the user returns here after signing in.
 */
export const startLogin = () => {
  const next = `${window.location.pathname}${window.location.search}`;
  const target = next && next !== "/" && !next.startsWith("/login") ? `/login?next=${encodeURIComponent(next)}` : "/login";
  if (window.location.pathname !== "/login") window.location.assign(target);
};
