-- Astra Phase 9 — external PostgreSQL sources (read-only).
-- Additive: ONE new table (dataset provenance) + one widened CHECK constraint.
-- No existing column is changed, so every Phase 1–8 query keeps working even
-- before this runs; only the new PostgreSQL import/refresh actions need it.
-- Safe to run more than once. Server-only access (RLS on, no policies), like every Astra table.

-- Where an imported dataset came from, so it can be traced and refreshed from its source.
-- Credentials stay in dataset_connections (encrypted); nothing secret is stored here.
create table if not exists public.dataset_sources (
  dataset_id        bigint primary key references public.datasets (id) on delete cascade,
  workspace_id      bigint not null references public.workspaces (id) on delete cascade,
  connection_id     bigint references public.dataset_connections (id) on delete set null,
  source_schema     varchar(128) not null,
  source_table      varchar(128) not null,
  source_kind       varchar(24)  not null default 'table',
  order_columns     jsonb not null default '[]'::jsonb,
  last_synced_at    timestamptz not null default now(),
  last_synced_by    uuid references auth.users (id) on delete set null,
  last_sync_rows    integer not null default 0,
  sync_count        integer not null default 1,
  created_at        timestamptz not null default now()
);
create index if not exists dataset_sources_connection_idx on public.dataset_sources (connection_id);
create index if not exists dataset_sources_workspace_idx on public.dataset_sources (workspace_id);

alter table public.dataset_sources enable row level security;
revoke all on table public.dataset_sources from anon, authenticated;

-- Quality checks re-run after a refresh from source; record that trigger as 'sync'.
alter table public.quality_results drop constraint if exists quality_results_trigger_check;
alter table public.quality_results add constraint quality_results_trigger_check check (trigger in ('manual', 'run', 'sync'));
