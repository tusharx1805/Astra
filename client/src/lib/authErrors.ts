/**
 * Converts Supabase Auth / network errors into user-facing messages.
 * Raw details are logged in development only and never shown to users.
 */

export type AuthErrorKind =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "email_exists"
  | "username_taken"
  | "weak_password"
  | "rate_limited"
  | "same_password"
  | "session_expired"
  | "signup_disabled"
  | "network"
  | "not_configured"
  | "unknown";

export type FriendlyAuthError = { kind: AuthErrorKind; message: string };

const MESSAGES: Record<AuthErrorKind, string> = {
  invalid_credentials: "Incorrect email or password.",
  email_not_confirmed: "Please confirm your email address first. Check your inbox for the confirmation link.",
  email_exists: "An account with this email already exists. Sign in instead, or reset your password.",
  username_taken: "That username is already taken. Choose a different one.",
  weak_password: "That password is too weak. Use a longer password with a mix of letters, numbers and symbols.",
  rate_limited: "Too many attempts. Please wait a minute and try again.",
  same_password: "Your new password must be different from your current password.",
  session_expired: "Your session has expired. Please sign in again.",
  signup_disabled: "New sign-ups are currently disabled.",
  network: "We couldn't reach the sign-in service. Check your connection and try again.",
  not_configured: "Sign-in is not configured for this environment yet.",
  unknown: "Something went wrong. Please try again.",
};

type ErrorLike = { name?: string; code?: string; status?: number; message?: string };

export function classifyAuthError(error: unknown): AuthErrorKind {
  if (!error) return "unknown";
  const { name = "", code = "", status, message = "" } = error as ErrorLike;
  const text = message.toLowerCase();
  if (code === "invalid_credentials" || text.includes("invalid login credentials")) return "invalid_credentials";
  if (code === "email_not_confirmed" || text.includes("email not confirmed")) return "email_not_confirmed";
  if (code === "user_already_exists" || code === "email_exists" || text.includes("already registered")) return "email_exists";
  if (code === "weak_password" || text.includes("password should be") || text.includes("weak password")) return "weak_password";
  if (code === "same_password" || text.includes("should be different")) return "same_password";
  if (code.startsWith("over_") || status === 429 || text.includes("rate limit")) return "rate_limited";
  if (code === "signup_disabled" || text.includes("signups not allowed")) return "signup_disabled";
  if (["session_not_found", "session_expired", "refresh_token_not_found", "refresh_token_already_used", "bad_jwt"].includes(code) || text.includes("jwt expired")) return "session_expired";
  // The profile trigger rejects duplicate/invalid usernames, which Supabase reports generically.
  if (code === "unexpected_failure" || text.includes("database error saving new user") || text.includes("astra_username_taken")) return "username_taken";
  if (name === "AuthRetryableFetchError" || (name === "TypeError" && text.includes("fetch")) || status === 0 || text.includes("failed to fetch") || text.includes("network")) return "network";
  return "unknown";
}

export function friendlyAuthError(error: unknown, context?: string): FriendlyAuthError {
  const kind = classifyAuthError(error);
  if (import.meta.env?.DEV && kind === "unknown") console.error(`[Auth]${context ? ` ${context}` : ""}`, error);
  return { kind, message: MESSAGES[kind] };
}

export function authMessage(kind: AuthErrorKind) {
  return MESSAGES[kind];
}
