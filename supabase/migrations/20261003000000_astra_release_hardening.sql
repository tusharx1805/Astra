-- Astra release hardening (final deployment).
-- 1) Profiles are no longer readable by EVERY signed-in user across all tenants.
--    A user can read their own profile and the profiles of people who share a workspace with them
--    (needed to show reviewer / author / member names). Signup keeps working: username checks go
--    through the security-definer function public.username_available().
-- 2) Helpful indexes for tables that grow with every run / evaluation.
-- Safe to run more than once. RLS stays ON everywhere; nothing is granted to anon.

create or replace function public.shares_workspace_with(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = auth.uid() and theirs.user_id = target
  );
$$;
revoke all on function public.shares_workspace_with(uuid) from public, anon;
grant execute on function public.shares_workspace_with(uuid) to authenticated;

drop policy if exists "profiles are readable by signed-in users" on public.profiles;
drop policy if exists "profiles readable by self and workspace peers" on public.profiles;
create policy "profiles readable by self and workspace peers"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id or public.shares_workspace_with(id));

-- Growth: runs, quality results and audit rows accumulate forever; keep the hot lookups indexed.
create index if not exists audit_logs_workspace_action_idx on public.audit_logs (workspace_id, action, created_at desc);
