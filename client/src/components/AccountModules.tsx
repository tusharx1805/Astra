import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthContext } from "@/contexts/AuthContext";
import { useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { trpc } from "@/lib/trpc";
import { ArrowUpRight, ShieldCheck, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

/**
 * Account & Admin and Settings. Everything shown is the signed-in user's real
 * account, role and workspace membership (the old page showed a local preview
 * role and three invented members).
 */

const label = (value: string | null | undefined) => (value ?? "—").toUpperCase();

export function AdminPage() {
  const [, setLocation] = useLocation();
  const { appUser, profile } = useAuthContext();
  const active = useActiveWorkspace();
  const overview = trpc.workspace.overview.useQuery({ workspaceId: active.workspaceId }, { enabled: Boolean(active.workspaceId), retry: false });
  return <div className="page-stack">
    <section className="page-heading"><div><p className="eyebrow">ACCOUNT & GOVERNANCE</p><h1>ROLE-AWARE<br /><em>CONTROL.</em></h1><p>Your real account and the roles the server enforces. Workspace roles decide what you can do inside a workspace; every check happens on the server.</p></div></section>
    <section className="workspace-kpis">
      <div><ShieldCheck size={18} /><span>WORKSPACE ROLE</span><b>{label(active.role)}</b><small>{active.workspace?.name ?? "No workspace"}</small></div>
      <div><ShieldCheck size={18} /><span>ACCOUNT ROLE</span><b>{label(appUser?.role)}</b><small>Supabase app_metadata.astra_role (set by an admin)</small></div>
      <div><UsersRound size={18} /><span>WORKSPACE MEMBERS</span><b>{overview.data?.members.length ?? "—"}</b></div>
      <div><UsersRound size={18} /><span>SIGNED IN AS</span><b className="account-email">{profile?.username ? `@${profile.username}` : appUser?.email ?? "—"}</b></div>
    </section>
    <div className="split-grid">
      <section className="panel"><p className="eyebrow">WORKSPACE ROLES</p><h2>WHAT EACH ROLE CAN DO</h2><div className="access-model">
        <div><span>OWNER / ADMIN</span><b>Members & invitations, database connections, projects, plus everything below</b></div>
        <div><span>DEVELOPER</span><b>Import datasets, build & run pipelines, analyse changes, quality checks</b></div>
        <div><span>REVIEWER</span><b>Approve / block / request changes (not on own changes), AI briefs, incidents</b></div>
        <div><span>VIEWER</span><b>Read everything in the workspace; no changes</b></div>
      </div></section>
      <section className="panel"><p className="eyebrow">AUTHENTICATION</p><h2>SUPABASE AUTH</h2><p className="panel-copy">Sign-in uses Supabase Auth only. Every API call carries your Supabase access token; the server verifies it with Supabase and uses your Supabase user id directly. Data is scoped by workspace and role on the server; Row Level Security stays on for every table.</p></section>
    </div>
    <section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">PEOPLE · {active.workspace?.name?.toUpperCase() ?? "NO WORKSPACE"}</p><h2>WORKSPACE MEMBERS</h2></div><Button variant="outline" onClick={() => setLocation("/workspaces")}><ArrowUpRight size={13} /> MANAGE IN WORKSPACES</Button></div>
      {!active.workspaceId ? <p className="panel-copy">Create or join a workspace to see its members.</p>
        : overview.isLoading ? <div className="workspace-loading"><span>LOADING MEMBERS…</span></div>
        : overview.error ? <p className="form-error">{overview.error.message}</p>
        : <div className="history-list" data-testid="admin-members">{overview.data!.members.map(member => <div key={member.id}><span><b>{member.name ?? member.username ?? "Member"}</b><small>{member.username ? `@${member.username}` : member.userId.slice(0, 8)}</small></span><span><b>{label(member.role)}</b><small>ROLE</small></span><span><b>{new Date(member.joinedAt).toLocaleDateString()}</b><small>JOINED</small></span></div>)}</div>}
    </section>
  </div>;
}

export function SettingsPage() {
  const { profile, appUser, updateProfile, signOut } = useAuthContext();
  const [fullName, setFullName] = useState(profile?.full_name ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setFullName(profile?.full_name ?? ""); }, [profile?.full_name]);
  const save = async () => {
    setSaving(true);
    const result = await updateProfile({ full_name: fullName.trim() });
    setSaving(false);
    if (result.ok) toast.success("Profile updated"); else toast.error("Profile not updated", { description: result.error.message });
  };
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <div className="page-stack">
    <section className="page-heading"><div><p className="eyebrow">ACCOUNT</p><h1>YOUR<br /><em>SETTINGS.</em></h1><p>Your profile as other members of your workspaces see it. Workspace settings (members, data environment) live under Workspaces.</p></div></section>
    <div className="split-grid">
      <section className="panel"><p className="eyebrow">PROFILE</p><h2>HOW YOU APPEAR</h2><div className="workspace-form">
        <div><label htmlFor="settings-name">FULL NAME</label><Input id="settings-name" value={fullName} maxLength={120} onChange={event => setFullName(event.target.value)} /></div>
        <div><label>USERNAME</label><Input value={profile?.username ? `@${profile.username}` : "—"} disabled /></div>
        <div><label>E-MAIL</label><Input value={appUser?.email ?? "—"} disabled /></div>
        <Button className="button-red" disabled={saving || fullName.trim().length < 2 || fullName.trim() === (profile?.full_name ?? "")} onClick={() => void save()}>{saving ? "SAVING…" : "SAVE PROFILE"}</Button>
      </div></section>
      <section className="panel"><p className="eyebrow">SESSION</p><h2>THIS DEVICE</h2><p className="panel-copy">Times and daily charts use this browser's time zone: <b>{zone}</b>.</p><p className="panel-copy">Password changes go through the “Forgot password” e-mail flow on the sign-in page.</p><Button variant="outline" onClick={() => void signOut()}>SIGN OUT</Button></section>
    </div>
  </div>;
}
