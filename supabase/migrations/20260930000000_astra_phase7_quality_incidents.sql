-- Astra Phase 7 — data-quality checks, their results, and incidents.
-- Additive only: three NEW tables + indexes. No existing table or column is changed.
-- Safe to run more than once. Server-only access (RLS on, no policies), like every Astra table.

-- A rule a workspace defines on one dataset. Evaluated against the dataset's stored rows.
create table if not exists public.quality_checks (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations (id) on delete cascade,
  workspace_id     bigint not null references public.workspaces (id) on delete cascade,
  dataset_id       bigint not null references public.datasets (id) on delete cascade,
  check_type       varchar(32) not null check (check_type in ('not_null', 'unique', 'allowed_values', 'range', 'row_count')),
  column_name      varchar(160),
  config           jsonb not null default '{}'::jsonb,
  severity         varchar(16) not null default 'warning' check (severity in ('warning', 'critical')),
  enabled          boolean not null default true,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists quality_checks_dataset_idx on public.quality_checks (dataset_id);
create index if not exists quality_checks_workspace_idx on public.quality_checks (workspace_id);

-- One row per evaluation of one check (manual, or automatically after a run that overwrote the dataset).
create table if not exists public.quality_results (
  id               bigint generated always as identity primary key,
  check_id         bigint not null references public.quality_checks (id) on delete cascade,
  dataset_id       bigint not null references public.datasets (id) on delete cascade,
  workspace_id     bigint not null references public.workspaces (id) on delete cascade,
  run_id           bigint references public.pipeline_runs (id) on delete set null,
  trigger          varchar(16) not null check (trigger in ('manual', 'run')),
  status           varchar(8)  not null check (status in ('pass', 'fail', 'error')),
  evaluated_rows   integer not null default 0,
  failing_rows     integer not null default 0,
  observed         jsonb,
  evaluated_by     uuid references auth.users (id) on delete set null,
  evaluated_at     timestamptz not null default now()
);
create index if not exists quality_results_check_idx on public.quality_results (check_id, evaluated_at desc);
create index if not exists quality_results_workspace_idx on public.quality_results (workspace_id, evaluated_at desc);

-- An operational problem with a DEFINED source event: a failed pipeline run, or a failing quality check.
create table if not exists public.incidents (
  id                bigint generated always as identity primary key,
  organization_id   bigint not null references public.organizations (id) on delete cascade,
  workspace_id      bigint not null references public.workspaces (id) on delete cascade,
  source_type       varchar(32) not null check (source_type in ('pipeline_run_failed', 'quality_check_failed')),
  source_key        varchar(96) not null,
  pipeline_id       bigint references public.pipelines (id) on delete set null,
  dataset_id        bigint references public.datasets (id) on delete set null,
  quality_check_id  bigint references public.quality_checks (id) on delete set null,
  first_run_id      bigint references public.pipeline_runs (id) on delete set null,
  last_run_id       bigint references public.pipeline_runs (id) on delete set null,
  last_result_id    bigint references public.quality_results (id) on delete set null,
  title             varchar(200) not null,
  detail            text,
  severity          varchar(16) not null check (severity in ('warning', 'critical')),
  status            varchar(16) not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  occurrences       integer not null default 1,
  opened_at         timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  acknowledged_by   uuid references auth.users (id) on delete set null,
  acknowledged_at   timestamptz,
  resolved_by       uuid references auth.users (id) on delete set null,
  resolved_at       timestamptz,
  resolution        varchar(16) check (resolution in ('auto', 'manual')),
  resolution_note   text
);
-- At most one unresolved incident per source (a pipeline, or a check) in a workspace.
create unique index if not exists incidents_one_active_per_source on public.incidents (workspace_id, source_key) where status <> 'resolved';
create index if not exists incidents_workspace_idx on public.incidents (workspace_id, status, last_seen_at desc);

alter table public.quality_checks enable row level security;
alter table public.quality_results enable row level security;
alter table public.incidents enable row level security;
revoke all on table public.quality_checks from anon, authenticated;
revoke all on table public.quality_results from anon, authenticated;
revoke all on table public.incidents from anon, authenticated;
