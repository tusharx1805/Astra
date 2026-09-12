import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { Check, ChevronDown, CirclePlus, Database, FolderKanban, MoreHorizontal, Settings2, ShieldCheck, UsersRound, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { startLogin } from "@/const";

type InviteRole = "admin" | "developer" | "reviewer" | "viewer";
type WorkspaceRole = InviteRole | "owner";

const technologies = ["PostgreSQL", "CSV / Files", "REST APIs", "GitHub", "MySQL", "MinIO / S3", "Airflow", "Other"];
const storageKey = "astra-active-workspace";

function roleLabel(role: string) { return role.toUpperCase().replaceAll("_", " "); }
function dateLabel(value: Date | string) { return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
function initials(value: string | null | undefined) { return (value ?? "ASTRA").split(" ").map(part => part[0]).join("").slice(0, 2).toUpperCase(); }

function useActiveWorkspaceId(workspaces: Array<{ id: number }>) {
  const [activeId, setActiveIdState] = useState<number | null>(null);
  useEffect(() => {
    const stored = Number(localStorage.getItem(storageKey));
    if (stored && workspaces.some(workspace => workspace.id === stored)) setActiveIdState(stored);
    else setActiveIdState(workspaces[0]?.id ?? null);
  }, [workspaces]);
  useEffect(() => {
    const syncWorkspace = (event: Event) => setActiveIdState((event as CustomEvent<number>).detail);
    window.addEventListener("astra-workspace-change", syncWorkspace);
    return () => window.removeEventListener("astra-workspace-change", syncWorkspace);
  }, []);
  const setActiveId = (id: number) => {
    localStorage.setItem(storageKey, String(id));
    setActiveIdState(id);
    window.dispatchEvent(new CustomEvent("astra-workspace-change", { detail: id }));
  };
  return [activeId, setActiveId] as const;
}

export function WorkspaceSelector({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const { isAuthenticated } = useAuth();
  const workspaceQuery = trpc.workspace.list.useQuery(undefined, { enabled: isAuthenticated });
  const [activeId, setActiveId] = useActiveWorkspaceId(workspaceQuery.data ?? []);
  const active = workspaceQuery.data?.find(workspace => workspace.id === activeId);

  if (!isAuthenticated) return <button className="project-select" onClick={onOpenWorkspace}><FolderKanban size={15} /><span>WORKSPACES</span><ChevronDown size={14} /></button>;
  return <Dialog><DialogTrigger asChild><button className="project-select"><FolderKanban size={15} /><span>{active?.name?.toUpperCase() ?? "SELECT WORKSPACE"}</span><ChevronDown size={14} /></button></DialogTrigger><DialogContent className="workspace-dialog"><DialogHeader><DialogTitle>Switch Workspace</DialogTitle><DialogDescription>Only workspaces you belong to appear here.</DialogDescription></DialogHeader><div className="workspace-switch-list">{workspaceQuery.isLoading ? <p className="workspace-muted">Loading workspaces…</p> : workspaceQuery.data?.map(workspace => <button key={workspace.id} onClick={() => setActiveId(workspace.id)}><span><b>{workspace.name}</b><small>{roleLabel(workspace.role)}</small></span>{workspace.id === activeId ? <Check size={16} /> : null}</button>)}{!workspaceQuery.data?.length ? <p className="workspace-muted">No workspaces yet.</p> : null}</div><DialogFooter><Button className="button-red" onClick={onOpenWorkspace}><CirclePlus size={14} /> CREATE WORKSPACE</Button></DialogFooter></DialogContent></Dialog>;
}

function CreateWorkspaceDialog({ onCreated }: { onCreated: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const utils = trpc.useUtils();
  const create = trpc.workspace.create.useMutation({
    onSuccess: workspace => {
      utils.workspace.list.invalidate();
      setOpen(false);
      setName("");
      setDescription("");
      onCreated(workspace.id);
      toast.success("Workspace created", { description: "You are its OWNER. Complete the data-environment setup next." });
    },
    onError: error => toast.error("Workspace could not be created", { description: error.message }),
  });
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button className="button-red"><CirclePlus size={14} /> CREATE WORKSPACE</Button></DialogTrigger><DialogContent className="workspace-dialog"><DialogHeader><DialogTitle>Create Workspace</DialogTitle><DialogDescription>Set up a scoped ASTRA environment for a team, data domain, or project group.</DialogDescription></DialogHeader><div className="workspace-form"><div><Label htmlFor="workspace-name">Workspace Name</Label><Input id="workspace-name" placeholder="E-commerce Data Platform" value={name} onChange={event => setName(event.target.value)} /></div><div><Label htmlFor="workspace-description">Description <span>OPTIONAL</span></Label><Textarea id="workspace-description" placeholder="Data pipelines and infrastructure used for our e-commerce platform." value={description} onChange={event => setDescription(event.target.value)} /></div></div><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>CANCEL</Button><Button className="button-red" disabled={name.trim().length < 3 || create.isPending} onClick={() => create.mutate({ name: name.trim(), description: description.trim() || undefined })}>{create.isPending ? "CREATING…" : "CONTINUE"}</Button></DialogFooter></DialogContent></Dialog>;
}

function SetupDialog({ workspaceId, name, open, onOpenChange }: { workspaceId: number; name: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const overview = trpc.workspace.overview.useQuery({ workspaceId }, { enabled: open });
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const utils = trpc.useUtils();
  useEffect(() => { if (overview.data) setSelected(overview.data.technologies.map(item => item.technology).filter(item => item !== "Other")); }, [overview.data]);
  const update = trpc.workspace.updateEnvironment.useMutation({
    onSuccess: () => { utils.workspace.overview.invalidate({ workspaceId }); onOpenChange(false); toast.success("Data environment saved", { description: "Declared technologies are now linked to this workspace." }); },
    onError: error => toast.error("Setup could not be saved", { description: error.message }),
  });
  const toggle = (technology: string) => setSelected(current => current.includes(technology) ? current.filter(item => item !== technology) : [...current, technology]);
  const hasOther = selected.includes("Other");
  const submit = () => update.mutate({ workspaceId, technologies: [...selected.filter(item => item !== "Other"), ...(hasOther && other.trim() ? [`Other: ${other.trim()}`] : [])] });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="workspace-dialog workspace-dialog--wide"><DialogHeader><DialogTitle>Tell us about your data environment</DialogTitle><DialogDescription>Select technologies your team already uses. ASTRA will connect to them as integrations are added — nothing is connected from this setup.</DialogDescription></DialogHeader><div className="setup-name"><span>WORKSPACE</span><b>{name}</b></div><div className="technology-grid">{technologies.map(technology => <button type="button" key={technology} className={selected.includes(technology) ? "selected" : ""} onClick={() => toggle(technology)}><span>{selected.includes(technology) ? <Check size={15} /> : null}</span><b>{technology}</b></button>)}</div>{hasOther ? <div className="workspace-form"><div><Label htmlFor="other-technology">Tell us what you use</Label><Input id="other-technology" placeholder="Snowflake" value={other} onChange={event => setOther(event.target.value)} /></div></div> : null}<DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>CANCEL</Button><Button className="button-red" disabled={update.isPending} onClick={submit}>{update.isPending ? "SAVING…" : "SAVE WORKSPACE SETUP"}</Button></DialogFooter></DialogContent></Dialog>;
}

function InviteDialog({ workspaceId }: { workspaceId: number }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("developer");
  const utils = trpc.useUtils();
  const invite = trpc.workspace.invite.useMutation({
    onSuccess: () => { utils.workspace.overview.invalidate({ workspaceId }); setOpen(false); setEmail(""); toast.success("Pending invitation created", { description: "No email was sent because this project has no configured Supabase invitation channel." }); },
    onError: error => toast.error("Invitation could not be created", { description: error.message }),
  });
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button className="button-red"><CirclePlus size={14} /> INVITE MEMBER</Button></DialogTrigger><DialogContent className="workspace-dialog"><DialogHeader><DialogTitle>Invite Member</DialogTitle><DialogDescription>The invitation is stored as Pending until email delivery and acceptance are configured.</DialogDescription></DialogHeader><div className="workspace-form"><div><Label htmlFor="invite-email">Email Address</Label><Input id="invite-email" type="email" placeholder="teammate@company.com" value={email} onChange={event => setEmail(event.target.value)} /></div><div><Label htmlFor="invite-role">Workspace Role</Label><select id="invite-role" value={role} onChange={event => setRole(event.target.value as InviteRole)}><option value="admin">ADMIN</option><option value="developer">DEVELOPER</option><option value="reviewer">REVIEWER</option><option value="viewer">VIEWER</option></select></div></div><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>CANCEL</Button><Button className="button-red" disabled={!email.includes("@") || invite.isPending} onClick={() => invite.mutate({ workspaceId, email: email.trim(), role })}>{invite.isPending ? "CREATING…" : "SEND INVITE"}</Button></DialogFooter></DialogContent></Dialog>;
}

function ConfirmationDialog({ open, title, detail, confirmLabel, destructive, onOpenChange, onConfirm }: { open: boolean; title: string; detail: string; confirmLabel: string; destructive?: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="workspace-dialog"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{detail}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>CANCEL</Button><Button className={destructive ? "button-red" : "button-red"} onClick={onConfirm}>{confirmLabel}</Button></DialogFooter></DialogContent></Dialog>;
}

function MemberRow({ member, actorRole, workspaceId }: { member: { id: number; userId: number; name: string | null; email: string | null; role: string; joinedAt: Date | string }; actorRole: WorkspaceRole; workspaceId: number }) {
  const canManage = (actorRole === "owner" || actorRole === "admin") && member.role !== "owner";
  const [action, setAction] = useState<"role" | "remove" | null>(null);
  const [nextRole, setNextRole] = useState<InviteRole>(member.role === "owner" ? "developer" : member.role as InviteRole);
  const utils = trpc.useUtils();
  const changeRole = trpc.workspace.changeMemberRole.useMutation({ onSuccess: () => { utils.workspace.overview.invalidate({ workspaceId }); setAction(null); toast.success("Workspace role changed"); }, onError: error => toast.error("Role could not be changed", { description: error.message }) });
  const remove = trpc.workspace.removeMember.useMutation({ onSuccess: () => { utils.workspace.overview.invalidate({ workspaceId }); setAction(null); toast.success("Member removed from workspace"); }, onError: error => toast.error("Member could not be removed", { description: error.message }) });
  return <>
    <div className="workspace-member">
      <Avatar><AvatarFallback>{initials(member.name)}</AvatarFallback></Avatar>
      <div><b>{member.name ?? "Workspace member"}</b><span>{member.email ?? "Email unavailable"}</span></div>
      <Badge variant="outline">{roleLabel(member.role)}</Badge>
      <small>{dateLabel(member.joinedAt)}</small>
      {canManage ? <div className="member-actions"><button className="member-action" onClick={() => setAction("role")}>ROLE</button><button className="member-action" onClick={() => setAction("remove")}>REMOVE</button></div> : <span className="member-lock">{member.role === "owner" ? "OWNER" : "—"}</span>}
    </div>
    <Dialog open={action === "role"} onOpenChange={() => setAction(null)}>
      <DialogContent className="workspace-dialog"><DialogHeader><DialogTitle>Change Role</DialogTitle><DialogDescription>Select a non-owner permission level for {member.name ?? "this member"}. Confirming this action updates their workspace access.</DialogDescription></DialogHeader><select value={nextRole} onChange={event => setNextRole(event.target.value as InviteRole)}><option value="admin">ADMIN</option><option value="developer">DEVELOPER</option><option value="reviewer">REVIEWER</option><option value="viewer">VIEWER</option></select><DialogFooter><Button variant="outline" onClick={() => setAction(null)}>CANCEL</Button><Button className="button-red" disabled={changeRole.isPending} onClick={() => changeRole.mutate({ workspaceId, memberId: member.id, role: nextRole })}>{changeRole.isPending ? "UPDATING…" : "CONFIRM ROLE CHANGE"}</Button></DialogFooter></DialogContent>
    </Dialog>
    <ConfirmationDialog open={action === "remove"} onOpenChange={() => setAction(null)} title={`Remove ${member.name ?? "member"}?`} detail="Are you sure you want to remove this person from the workspace? Their existing pending invitation and all future workspace access will need to be recreated manually." confirmLabel="REMOVE MEMBER" destructive onConfirm={() => remove.mutate({ workspaceId, memberId: member.id })} />
  </>;
}

export default function WorkspaceHub() {
  const { isAuthenticated } = useAuth();
  const workspaceQuery = trpc.workspace.list.useQuery(undefined, { enabled: isAuthenticated });
  const [selectedWorkspaceId, setActiveId] = useActiveWorkspaceId(workspaceQuery.data ?? []);
  const activeId = selectedWorkspaceId ?? 0;
  const overviewInput = useMemo(() => activeId ? { workspaceId: activeId } : { workspaceId: 0 }, [activeId]);
  const overviewQuery = trpc.workspace.overview.useQuery(overviewInput, { enabled: isAuthenticated && Boolean(activeId) });
  const [setupOpen, setSetupOpen] = useState(false);
  const active = workspaceQuery.data?.find(workspace => workspace.id === activeId);
  const actorRole = overviewQuery.data?.actorRole as WorkspaceRole | undefined;
  const canManage = actorRole === "owner" || actorRole === "admin";
  const handleCreated = (id: number) => { setActiveId(id); setSetupOpen(true); };

  if (!isAuthenticated) return <div className="page-stack"><section className="page-heading"><p className="eyebrow">WORKSPACE FOUNDATION</p><h1>YOUR DATA<br /><em>PERIMETER.</em></h1><p>Sign in to create organization-scoped workspaces and manage trusted collaborators.</p></section><section className="panel empty-panel"><ShieldCheck size={30} /><h3>Authentication required</h3><p>Workspace creation is always associated with the currently authenticated user and organization.</p><Button className="button-red" onClick={() => startLogin()}>SIGN IN TO CONTINUE</Button></section></div>;
  if (workspaceQuery.isLoading) return <div className="workspace-loading"><span>LOADING WORKSPACES…</span></div>;
  if (!workspaceQuery.data?.length) return <div className="page-stack"><section className="page-heading"><p className="eyebrow">WORKSPACE FOUNDATION</p><h1>YOUR DATA<br /><em>PERIMETER.</em></h1><p>Workspaces separate data environments, collaborators, and future ASTRA resources inside an organization.</p></section><section className="panel empty-panel"><FolderKanban size={30} /><h3>Your workspace is ready to begin</h3><p>Start by creating a workspace, then invite your team or declare the technologies you already use.</p><CreateWorkspaceDialog onCreated={handleCreated} /></section></div>;
  if (!active || overviewQuery.isLoading || !overviewQuery.data) return <div className="workspace-loading"><span>LOADING WORKSPACE CONTEXT…</span></div>;
  const { workspace, members, invitations, technologies: environment } = overviewQuery.data;
  return <div className="page-stack workspace-hub"><section className="page-heading heading-with-tools"><div><p className="eyebrow">WORKSPACE · ORGANIZATION SCOPED</p><h1>{workspace.name.split(" ").slice(0, 2).join(" ")}<br /><em>{workspace.name.split(" ").slice(2).join(" ") || "WORKSPACE"}</em></h1><p>{workspace.description || "A contained ASTRA boundary for the people, environment, and future resources that belong together."}</p></div><div className="workspace-switch-panel"><span>ACTIVE WORKSPACE</span><select value={activeId} onChange={event => setActiveId(Number(event.target.value))}>{workspaceQuery.data.map(item => <option key={item.id} value={item.id}>{item.name.toUpperCase()} · {roleLabel(item.role)}</option>)}</select><CreateWorkspaceDialog onCreated={handleCreated} /></div></section><section className="workspace-kpis"><div><UsersRound size={18} /><span>TEAM MEMBERS</span><b>{members.length}</b></div><div><Database size={18} /><span>CONNECTED TECHNOLOGIES</span><b>{environment.length}</b></div><div><ShieldCheck size={18} /><span>YOUR ROLE</span><b>{roleLabel(actorRole ?? "viewer")}</b></div><div><Settings2 size={18} /><span>CREATED</span><b>{dateLabel(workspace.createdAt)}</b></div></section><div className="split-grid"><section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">DECLARED ENVIRONMENT</p><h2>DATA STACK</h2></div>{canManage ? <Button variant="outline" onClick={() => setSetupOpen(true)}>EDIT ENVIRONMENT</Button> : null}</div>{environment.length ? <div className="technology-tags">{environment.map(item => <span key={item.id}>{item.technology}</span>)}</div> : <div className="workspace-empty"><Database size={20} /><p>No technologies declared yet.</p>{canManage ? <Button className="button-red" onClick={() => setSetupOpen(true)}>CONFIGURE ENVIRONMENT</Button> : null}</div>}</section><section className="panel"><div className="workspace-section-head"><div><p className="eyebrow">WORKSPACE CONTROL</p><h2>QUICK ACTIONS</h2></div></div><div className="quick-actions"><button onClick={() => document.getElementById("workspace-members")?.scrollIntoView({ behavior: "smooth" })}><UsersRound size={17} /><span>Manage Members</span></button><button disabled={!canManage} onClick={() => setSetupOpen(true)}><Database size={17} /><span>Edit Data Environment</span></button><button disabled><Settings2 size={17} /><span>Workspace Settings</span><small>COMING SOON</small></button></div></section></div><section className="panel" id="workspace-members"><div className="workspace-section-head"><div><p className="eyebrow">ACCESS DIRECTORY</p><h2>MEMBERS</h2><p className="section-title__detail">Member controls are enforced by the server using verified workspace role records.</p></div>{canManage ? <InviteDialog workspaceId={activeId} /> : null}</div><div className="workspace-members"><div className="workspace-member workspace-member--header"><span>PERSON</span><span>ROLE</span><span>JOINED</span><span>ACTIONS</span></div>{members.length ? members.map(member => <MemberRow key={member.id} member={member} actorRole={actorRole ?? "viewer"} workspaceId={activeId} />) : <div className="workspace-empty"><UsersRound size={20} /><p>No team members yet</p><small>Invite your team to collaborate inside this workspace.</small>{canManage ? <InviteDialog workspaceId={activeId} /> : null}</div>}</div>{invitations.length ? <div className="pending-invitations"><p className="eyebrow">PENDING INVITATIONS</p>{invitations.map(invite => <div key={invite.id}><span>{invite.email}</span><Badge variant="outline">{roleLabel(invite.role)}</Badge><small>PENDING · EXPIRES {dateLabel(invite.expiresAt)}</small></div>)}</div> : null}</section><SetupDialog workspaceId={activeId} name={workspace.name} open={setupOpen} onOpenChange={setSetupOpen} /></div>;
}
