/**
 * Client-side validation for the auth forms. The same username rule is enforced
 * again in the database (profiles_username_format + handle_new_user trigger),
 * and Supabase enforces its own password policy on top of this one.
 */

export const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72; // bcrypt input limit used by Supabase Auth

export type FieldErrors<T extends string> = Partial<Record<T, string>>;

export function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

export function validateEmail(value: string): string | undefined {
  const email = value.trim();
  if (!email) return "Enter your email address.";
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return "Enter a valid email address.";
  return undefined;
}

export function validateUsername(value: string): string | undefined {
  const username = normalizeUsername(value);
  if (!username) return "Choose a username.";
  if (!USERNAME_PATTERN.test(username)) return "Use 3–30 characters: lowercase letters, numbers or underscores.";
  return undefined;
}

export function validateFullName(value: string): string | undefined {
  const name = value.trim();
  if (!name) return "Enter your full name.";
  if (name.length > 120) return "Keep your name under 120 characters.";
  return undefined;
}

export type PasswordStrength = { score: 0 | 1 | 2 | 3 | 4; label: "Too short" | "Weak" | "Fair" | "Good" | "Strong" };

export function passwordStrength(password: string): PasswordStrength {
  if (password.length < PASSWORD_MIN_LENGTH) return { score: 0, label: "Too short" };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(password)).length;
  let score = classes - 1 + (password.length >= 12 ? 1 : 0);
  score = Math.max(1, Math.min(4, score));
  return { score: score as PasswordStrength["score"], label: (["Too short", "Weak", "Fair", "Good", "Strong"] as const)[score] };
}

export function validatePassword(password: string): string | undefined {
  if (!password) return "Enter a password.";
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Include at least one letter and one number.";
  return undefined;
}

export function validateConfirmPassword(password: string, confirm: string): string | undefined {
  if (!confirm) return "Confirm your password.";
  if (password !== confirm) return "Passwords do not match.";
  return undefined;
}

export type SignupFields = { fullName: string; username: string; email: string; password: string; confirmPassword: string };

export function validateSignup(fields: SignupFields): FieldErrors<keyof SignupFields> {
  const errors: FieldErrors<keyof SignupFields> = {
    fullName: validateFullName(fields.fullName),
    username: validateUsername(fields.username),
    email: validateEmail(fields.email),
    password: validatePassword(fields.password),
    confirmPassword: validateConfirmPassword(fields.password, fields.confirmPassword),
  };
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => message)) as FieldErrors<keyof SignupFields>;
}

export function validateLogin(fields: { email: string; password: string }): FieldErrors<"email" | "password"> {
  const errors: FieldErrors<"email" | "password"> = { email: validateEmail(fields.email), password: fields.password ? undefined : "Enter your password." };
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => message)) as FieldErrors<"email" | "password">;
}

const AUTH_PAGES = ["/login", "/signup", "/forgot-password", "/reset-password", "/auth/callback"];

/** Only same-origin app paths are allowed as post-login destinations (prevents open redirects and loops). */
export function safeNextPath(raw: string | null | undefined, fallback = "/"): string {
  if (!raw) return fallback;
  let value = raw;
  try { value = decodeURIComponent(raw); } catch { return fallback; }
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || /[\u0000-\u001f]/.test(value)) return fallback;
  const path = value.split(/[?#]/)[0] ?? "";
  if (AUTH_PAGES.includes(path)) return fallback;
  return value;
}
