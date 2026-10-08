-- Astra Phase 10 — AI review briefs (advisory; never authoritative).
-- Additive only: ONE new table. No existing table or column is changed.
-- Safe to run more than once. Server-only access (RLS on, no policies), like every Astra table.

-- A model-written brief for ONE stored risk analysis. risk_analyses and reviews are never
-- written by the AI path; this table keeps the exact context sent (metadata only, no dataset
-- rows, no names) so every brief can be audited and reproduced.
create table if not exists public.ai_briefs (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations (id) on delete cascade,
  workspace_id     bigint not null references public.workspaces (id) on delete cascade,
  change_id        bigint not null references public.changes (id) on delete cascade,
  analysis_id      bigint not null references public.risk_analyses (id) on delete cascade,
  prompt_version   varchar(48) not null,
  provider         varchar(24) not null,
  model            varchar(120) not null,
  context_hash     varchar(64) not null,
  context          jsonb not null,
  brief            jsonb not null,
  dropped          jsonb not null default '[]'::jsonb,
  adjusted         text,
  input_tokens     integer,
  output_tokens    integer,
  latency_ms       integer not null,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists ai_briefs_analysis_idx on public.ai_briefs (analysis_id, created_at desc);
create index if not exists ai_briefs_workspace_idx on public.ai_briefs (workspace_id, created_at desc);

alter table public.ai_briefs enable row level security;
revoke all on table public.ai_briefs from anon, authenticated;
