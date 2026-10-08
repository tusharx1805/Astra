-- Astra Phase 4 — scope change records to a workspace and link them to the pipeline they propose to change.
-- Additive and non-destructive: two NULLABLE columns + indexes. Safe to run more than once.
-- Why: public.changes only had organization_id; one owner's workspaces share an organization, so
-- organization scoping alone would let a member of workspace A read workspace B's change/risk records.

alter table public.changes
  add column if not exists workspace_id bigint references public.workspaces (id) on delete cascade;

alter table public.changes
  add column if not exists pipeline_id bigint references public.pipelines (id) on delete set null;

create index if not exists changes_workspace_created_idx on public.changes (workspace_id, created_at desc);
create index if not exists changes_pipeline_idx on public.changes (pipeline_id);

-- RLS stays enabled with no policies (server-only access), exactly as for every other Astra table.
alter table public.changes enable row level security;
