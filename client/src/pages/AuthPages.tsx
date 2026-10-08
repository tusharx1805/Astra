import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthContext } from "@/contexts/AuthContext";
import { authMessage, type FriendlyAuthError } from "@/lib/authErrors";
import { normalizeUsername, passwordStrength, safeNextPath, validateConfirmPassword, validateEmail, validateLogin, validatePassword, validateSignup, validateUsername, type FieldErrors, type SignupFields } from "@/lib/authValidation";
import { getRememberSession } from "@/lib/supabase";
import { Eye, EyeOff, Loader2, MailCheck, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link, Redirect, useLocation } from "wouter";

/* ------------------------------------------------------------------ shared */

function readNext() {
  return safeNextPath(new URLSearchParams(window.location.search).get("next"));
}

/** Supabase reports failed email links as ?error=… or #error=… (error_code, error_description). */
function readUrlAuthError(): string | null {
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const code = params.get("error_code") ?? hash.get("error_code");
  const error = params.get("error") ?? hash.get("error");
  if (!code && !error) return null;
  if (code === "otp_expired") return "This link has expired or has already been used.";
  return "This link is invalid or has expired.";
}

export function AuthSplash({ label = "CHECKING SESSION…" }: { label?: string }) {
  return <div className="auth-splash" role="status" aria-live="polite"><span className="auth-brand">ASTRA</span><span><Loader2 size={14} className="spin" /> {label}</span></div>;
}

function AuthShell({ eyebrow, title, children, footer }: { eyebrow: string; title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="auth-page">
      <aside className="auth-aside" aria-hidden="true">
        <div><span className="auth-brand">ASTRA</span><small>RISK / OPS</small></div>
        <p className="auth-aside__line">Parse before you deploy.<br /><em>Decide before it breaks.</em></p>
        <p className="auth-aside__meta">DATA RISK INTELLIGENCE · SECURE ACCESS</p>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <span className="auth-brand auth-brand--mobile">ASTRA</span>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          {children}
          {footer ? <div className="auth-footer">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}

function FormAlert({ error, tone = "error", children }: { error?: FriendlyAuthError | null; tone?: "error" | "info" | "success"; children?: React.ReactNode }) {
  if (!error && !children) return null;
  return <div className={`auth-alert auth-alert--${tone}`} role={tone === "error" ? "alert" : "status"}>{error?.message}{children}</div>;
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: React.ReactNode; children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string }) => React.ReactNode }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-invalid": Boolean(error), "aria-describedby": describedBy })}
      {error ? <p id={`${id}-error`} className="auth-field__error">{error}</p> : hint ? <div id={`${id}-hint`} className="auth-field__hint">{hint}</div> : null}
    </div>
  );
}

function PasswordInput({ value, onChange, autoComplete, ...props }: { value: string; onChange: (value: string) => void; autoComplete: string; id: string; "aria-invalid": boolean; "aria-describedby"?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="auth-password">
      <Input {...props} type={visible ? "text" : "password"} value={value} onChange={event => onChange(event.target.value)} autoComplete={autoComplete} maxLength={72} />
      <button type="button" className="auth-password__toggle" onClick={() => setVisible(current => !current)} aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button>
    </div>
  );
}

function StrengthMeter({ password }: { password: string }) {
  if (!password) return <span>At least 8 characters, with a letter and a number.</span>;
  const strength = passwordStrength(password);
  return <span className="auth-strength" data-score={strength.score}><i aria-hidden="true"><b style={{ width: `${(strength.score / 4) * 100}%` }} /></i>Strength: {strength.label}</span>;
}

function SubmitButton({ pending, children, pendingLabel }: { pending: boolean; children: React.ReactNode; pendingLabel: string }) {
  return <Button type="submit" className="button-red auth-submit" disabled={pending} aria-busy={pending}>{pending ? <><Loader2 size={14} className="spin" /> {pendingLabel}</> : children}</Button>;
}

/* --------------------------------------------------------------- guards */

/** Protected area: nothing renders until the session AND the server-verified user are resolved. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuthContext();
  const [location] = useLocation();
  if (status === "loading") return <AuthSplash />;
  if (status === "unauthenticated") {
    const next = `${location}${window.location.search}`;
    return <Redirect to={next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login"} replace />;
  }
  return <>{children}</>;
}

/** Login/signup/forgot pages: signed-in users are sent to where they were going. */
export function GuestOnly({ children }: { children: React.ReactNode }) {
  const { status } = useAuthContext();
  if (status === "loading") return <AuthSplash />;
  if (status === "authenticated") return <Redirect to={readNext()} replace />;
  return <>{children}</>;
}

/* ---------------------------------------------------------------- login */

export function LoginPage() {
  const auth = useAuthContext();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(getRememberSession);
  const [errors, setErrors] = useState<FieldErrors<"email" | "password">>({});
  const [formError, setFormError] = useState<FriendlyAuthError | null>(null);
  const [pending, setPending] = useState(false);
  const [resent, setResent] = useState(false);
  const next = readNext();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateLogin({ email, password });
    setErrors(found);
    setFormError(null);
    setResent(false);
    if (Object.keys(found).length) return;
    setPending(true);
    const result = await auth.signIn({ email, password, remember });
    setPending(false);
    if (!result.ok) { setFormError(result.error); setPassword(""); }
    // On success the auth state listener flips status to "authenticated" and GuestOnly redirects to `next`.
  };

  const resend = async () => {
    const result = await auth.resendConfirmation(email);
    if (result.ok) setResent(true); else setFormError(result.error);
  };

  return (
    <AuthShell eyebrow="SECURE ACCESS · SIGN IN" title={<>WELCOME<br /><em>BACK.</em></>} footer={<p>New to ASTRA? <Link href={next !== "/" ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}>Create an account</Link></p>}>
      {auth.configError ? <FormAlert error={{ kind: "not_configured", message: auth.configError }} /> : null}
      {auth.notice ? <FormAlert tone="info">{auth.notice}</FormAlert> : null}
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field label="EMAIL" error={errors.email}>{props => <Input {...props} type="email" autoComplete="email" inputMode="email" value={email} onChange={event => setEmail(event.target.value)} autoFocus />}</Field>
        <Field label="PASSWORD" error={errors.password}>{props => <PasswordInput {...props} value={password} onChange={setPassword} autoComplete="current-password" />}</Field>
        <div className="auth-row">
          <label className="auth-check"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} /> Keep me signed in</label>
          <Link href="/forgot-password">Forgot password?</Link>
        </div>
        <FormAlert error={formError}>{formError?.kind === "email_not_confirmed" ? <button type="button" className="auth-link-button" onClick={resend}>Resend confirmation email</button> : null}</FormAlert>
        {resent ? <FormAlert tone="success">Confirmation email sent. Check your inbox.</FormAlert> : null}
        <SubmitButton pending={pending} pendingLabel="SIGNING IN">SIGN IN</SubmitButton>
      </form>
    </AuthShell>
  );
}

/* --------------------------------------------------------------- signup */

export function SignupPage() {
  const auth = useAuthContext();
  const [fields, setFields] = useState<SignupFields>({ fullName: "", username: "", email: "", password: "", confirmPassword: "" });
  const [errors, setErrors] = useState<FieldErrors<keyof SignupFields>>({});
  const [formError, setFormError] = useState<FriendlyAuthError | null>(null);
  const [pending, setPending] = useState(false);
  const [usernameState, setUsernameState] = useState<"idle" | "checking" | "available" | "taken">("idle");
  const [confirmationSentTo, setConfirmationSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const checkSeq = useRef(0);
  const set = (key: keyof SignupFields) => (value: string) => setFields(current => ({ ...current, [key]: value }));

  const checkUsername = async () => {
    if (validateUsername(fields.username)) { setUsernameState("idle"); return; }
    const seq = ++checkSeq.current;
    setUsernameState("checking");
    const available = await auth.isUsernameAvailable(fields.username);
    if (seq !== checkSeq.current) return;
    setUsernameState(available === null ? "idle" : available ? "available" : "taken");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateSignup(fields);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) return;
    setPending(true);
    const available = await auth.isUsernameAvailable(fields.username);
    if (available === false) {
      setPending(false);
      setUsernameState("taken");
      setErrors(current => ({ ...current, username: authMessage("username_taken") }));
      return;
    }
    const result = await auth.signUp({ email: fields.email, password: fields.password, username: fields.username, fullName: fields.fullName });
    setPending(false);
    if (!result.ok) {
      if (result.error.kind === "username_taken") { setUsernameState("taken"); setErrors(current => ({ ...current, username: result.error.message })); }
      else if (result.error.kind === "email_exists") setErrors(current => ({ ...current, email: result.error.message }));
      else if (result.error.kind === "weak_password") setErrors(current => ({ ...current, password: result.error.message }));
      else setFormError(result.error);
      return;
    }
    if (result.data.needsEmailConfirmation) setConfirmationSentTo(fields.email.trim());
    // Otherwise Supabase returned a session: the listener signs the user in and GuestOnly redirects.
  };

  if (confirmationSentTo) {
    return (
      <AuthShell eyebrow="ACCOUNT CREATED · VERIFY EMAIL" title={<>CHECK YOUR<br /><em>INBOX.</em></>} footer={<p>Already confirmed? <Link href="/login">Sign in</Link></p>}>
        <div className="auth-success"><MailCheck size={26} /><p>We sent a confirmation link to <b>{confirmationSentTo}</b>. Open it to activate your account; you can't sign in until the email is confirmed.</p></div>
        {resent ? <FormAlert tone="success">Sent again. It can take a minute to arrive.</FormAlert> : <Button variant="outline" onClick={async () => { const result = await auth.resendConfirmation(confirmationSentTo); if (result.ok) setResent(true); else setFormError(result.error); }}>RESEND EMAIL</Button>}
        <FormAlert error={formError} />
      </AuthShell>
    );
  }

  const usernameHint = usernameState === "checking" ? "Checking availability…" : usernameState === "available" ? <span className="auth-ok">@{normalizeUsername(fields.username)} is available</span> : usernameState === "taken" ? <span className="auth-field__error">That username is already taken.</span> : "Lowercase letters, numbers and underscores (3–30).";

  return (
    <AuthShell eyebrow="SECURE ACCESS · NEW ACCOUNT" title={<>CREATE YOUR<br /><em>ACCOUNT.</em></>} footer={<p>Already have an account? <Link href="/login">Sign in</Link></p>}>
      {auth.configError ? <FormAlert error={{ kind: "not_configured", message: auth.configError }} /> : null}
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field label="FULL NAME" error={errors.fullName}>{props => <Input {...props} autoComplete="name" value={fields.fullName} onChange={event => set("fullName")(event.target.value)} maxLength={120} autoFocus />}</Field>
        <Field label="USERNAME" error={errors.username} hint={usernameHint}>{props => <Input {...props} autoComplete="username" autoCapitalize="none" spellCheck={false} value={fields.username} onChange={event => { set("username")(event.target.value); setUsernameState("idle"); }} onBlur={checkUsername} maxLength={30} />}</Field>
        <Field label="EMAIL" error={errors.email}>{props => <Input {...props} type="email" autoComplete="email" inputMode="email" value={fields.email} onChange={event => set("email")(event.target.value)} />}</Field>
        <Field label="PASSWORD" error={errors.password} hint={<StrengthMeter password={fields.password} />}>{props => <PasswordInput {...props} value={fields.password} onChange={set("password")} autoComplete="new-password" />}</Field>
        <Field label="CONFIRM PASSWORD" error={errors.confirmPassword}>{props => <PasswordInput {...props} value={fields.confirmPassword} onChange={set("confirmPassword")} autoComplete="new-password" />}</Field>
        <FormAlert error={formError} />
        <SubmitButton pending={pending} pendingLabel="CREATING ACCOUNT">CREATE ACCOUNT</SubmitButton>
      </form>
    </AuthShell>
  );
}

/* ------------------------------------------------------- forgot password */

export function ForgotPasswordPage() {
  const auth = useAuthContext();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<FriendlyAuthError | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateEmail(email);
    setError(found);
    setFormError(null);
    if (found) return;
    setPending(true);
    const result = await auth.requestPasswordReset(email);
    setPending(false);
    if (result.ok) setSentTo(email.trim()); else setFormError(result.error);
  };

  return (
    <AuthShell eyebrow="SECURE ACCESS · RECOVERY" title={<>RESET YOUR<br /><em>PASSWORD.</em></>} footer={<p>Remembered it? <Link href="/login">Back to sign in</Link></p>}>
      {sentTo ? (
        <div className="auth-success"><MailCheck size={26} /><p>If an account exists for <b>{sentTo}</b>, a password reset link is on its way. The link opens a page where you can choose a new password.</p></div>
      ) : (
        <form className="auth-form" onSubmit={submit} noValidate>
          {auth.configError ? <FormAlert error={{ kind: "not_configured", message: auth.configError }} /> : null}
          <Field label="EMAIL" error={error}>{props => <Input {...props} type="email" autoComplete="email" inputMode="email" value={email} onChange={event => setEmail(event.target.value)} autoFocus />}</Field>
          <FormAlert error={formError} />
          <SubmitButton pending={pending} pendingLabel="SENDING">SEND RESET LINK</SubmitButton>
        </form>
      )}
    </AuthShell>
  );
}

/* -------------------------------------------------------- reset password */

export function ResetPasswordPage() {
  const auth = useAuthContext();
  const [, setLocation] = useLocation();
  const [urlError] = useState(readUrlAuthError);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<FriendlyAuthError | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setLocation("/", { replace: true }), 1800);
    return () => window.clearTimeout(timer);
  }, [done, setLocation]);

  // The recovery link signs the user in with a short-lived session (exchanged from the URL by supabase-js).
  if (!urlError && auth.status === "loading") return <AuthSplash label="VERIFYING RESET LINK…" />;
  if (urlError || !auth.session) {
    return (
      <AuthShell eyebrow="SECURE ACCESS · RECOVERY" title={<>LINK<br /><em>EXPIRED.</em></>} footer={<p><Link href="/login">Back to sign in</Link></p>}>
        <FormAlert error={{ kind: "session_expired", message: urlError ?? "This password reset link is invalid or has expired." }} />
        <Link href="/forgot-password" className="auth-cta">REQUEST A NEW LINK</Link>
      </AuthShell>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = { password: validatePassword(password), confirm: validateConfirmPassword(password, confirm) };
    setErrors(found);
    setFormError(null);
    if (found.password || found.confirm) return;
    setPending(true);
    const result = await auth.updatePassword(password);
    setPending(false);
    if (result.ok) { setDone(true); setPassword(""); setConfirm(""); } else setFormError(result.error);
  };

  return (
    <AuthShell eyebrow="SECURE ACCESS · RECOVERY" title={<>CHOOSE A NEW<br /><em>PASSWORD.</em></>}>
      {done ? (
        <div className="auth-success"><ShieldCheck size={26} /><p>Your password has been updated. Taking you to ASTRA…</p></div>
      ) : (
        <form className="auth-form" onSubmit={submit} noValidate>
          <p className="auth-muted">Resetting the password for <b>{auth.session.user.email}</b>.</p>
          <Field label="NEW PASSWORD" error={errors.password} hint={<StrengthMeter password={password} />}>{props => <PasswordInput {...props} value={password} onChange={setPassword} autoComplete="new-password" />}</Field>
          <Field label="CONFIRM NEW PASSWORD" error={errors.confirm}>{props => <PasswordInput {...props} value={confirm} onChange={setConfirm} autoComplete="new-password" />}</Field>
          <FormAlert error={formError} />
          <SubmitButton pending={pending} pendingLabel="UPDATING">UPDATE PASSWORD</SubmitButton>
        </form>
      )}
    </AuthShell>
  );
}

/* ------------------------------------------------- email confirmation link */

export function AuthCallbackPage() {
  const auth = useAuthContext();
  const [urlError] = useState(readUrlAuthError);
  if (!urlError && auth.status === "loading") return <AuthSplash label="CONFIRMING YOUR EMAIL…" />;
  if (!urlError && auth.status === "authenticated") return <Redirect to={readNext()} replace />;
  return (
    <AuthShell eyebrow="SECURE ACCESS · VERIFICATION" title={<>ALMOST<br /><em>THERE.</em></>} footer={<p>Need a new account? <Link href="/signup">Sign up</Link></p>}>
      <FormAlert tone={urlError ? "error" : "info"}>{urlError ? `${urlError} Sign in to request a new confirmation email.` : "If your email was just confirmed, sign in to continue. Links must be opened in the browser you signed up with."}</FormAlert>
      <Link href="/login" className="auth-cta">GO TO SIGN IN</Link>
    </AuthShell>
  );
}
