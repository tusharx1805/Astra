-- =============================================================================
-- ASTRA · application data schema for Supabase Postgres
-- Postgres equivalent of drizzle/schema.ts (MySQL) after migrations 0000–0006.
--
-- * Identity: every user column is a uuid referencing auth.users(id). There is
--   no application users table.
-- * The Astra server reaches these tables over a direct Postgres connection
--   and enforces workspace/role rules itself. RLS is enabled on every table
--   with NO policies, so the public Data API (anon / authenticated keys)
--   cannot read or write them directly. public.profiles (separate migration)
--   stays readable by signed-in users.
-- * Non-destructive: CREATE ... IF NOT EXISTS only. Safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------- enum types
do $$ begin
  create type public.astra_role as enum ('admin', 'developer', 'reviewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.workspace_role as enum ('owner', 'admin', 'developer', 'reviewer', 'viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.invitation_status as enum ('pending', 'accepted', 'expired', 'revoked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.review_decision as enum ('approved', 'blocked', 'changes_requested');
exception when duplicate_object then null; end $$;

-- shared updated_at trigger function
create or replace function public.astra_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ------------------------------------------------------ organizations & people
create table if not exists public.organizations (
  id          bigint generated always as identity primary key,
  name        varchar(160) not null,
  slug        varchar(80)  not null unique,
  created_at  timestamptz  not null default now()
);

create table if not exists public.organization_members (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations (id) on delete cascade,
  user_id          uuid   not null references auth.users (id) on delete cascade,
  role             public.astra_role not null,
  created_at       timestamptz not null default now(),
  constraint organization_members_org_user_key unique (organization_id, user_id)
);
create index if not exists organization_members_user_idx on public.organization_members (user_id);

-- ------------------------------------------------------------------ workspaces
create table if not exists public.workspaces (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations (id) on delete cascade,
  name             varchar(160) not null,
  description      text,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint workspaces_org_name_key unique (organization_id, name)
);
drop trigger if exists workspaces_touch_updated_at on public.workspaces;
create trigger workspaces_touch_updated_at before update on public.workspaces
  for each row execute function public.astra_touch_updated_at();

create table if not exists public.workspace_members (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces (id) on delete cascade,
  user_id       uuid   not null references auth.users (id) on delete cascade,
  role          public.workspace_role not null,
  joined_at     timestamptz not null default now(),
  constraint workspace_members_workspace_user_key unique (workspace_id, user_id)
);
create index if not exists workspace_members_user_idx on public.workspace_members (user_id);

create table if not exists public.workspace_invitations (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces (id) on delete cascade,
  email         varchar(320) not null,
  role          public.workspace_role not null check (role <> 'owner'),
  invited_by    uuid references auth.users (id) on delete set null,
  status        public.invitation_status not null default 'pending',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  constraint workspace_invitations_workspace_email_key unique (workspace_id, email)
);

create table if not exists public.workspace_data_environment (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces (id) on delete cascade,
  technology    varchar(80) not null,
  created_at    timestamptz not null default now(),
  constraint workspace_data_environment_key unique (workspace_id, technology)
);

-- -------------------------------------------------------------------- projects
create table if not exists public.projects (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations (id) on delete cascade,
  name             varchar(160) not null,
  description      text,
  environment      varchar(32) not null check (environment in ('Production', 'Staging', 'Development')),
  created_at       timestamptz not null default now(),
  constraint projects_org_name_key unique (organization_id, name)
);

-- -------------------------------------------------------------------- datasets
create table if not exists public.datasets (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations (id) on delete cascade,
  workspace_id     bigint references public.workspaces (id) on delete cascade, -- null = legacy org-wide
  project_id       bigint references public.projects (id) on delete set null,
  name             varchar(160) not null,
  owner_id         uuid references auth.users (id) on delete set null,
  source_type      varchar(48) not null,
  quality_score    integer check (quality_score between 0 and 100),
  row_count        integer not null default 0 check (row_count >= 0),
  created_at       timestamptz not null default now(),
  constraint datasets_workspace_name_key unique (workspace_id, name)
);
create index if not exists datasets_workspace_idx on public.datasets (workspace_id);
create index if not exists datasets_organization_idx on public.datasets (organization_id);

create table if not exists public.dataset_columns (
  id             bigint generated always as identity primary key,
  dataset_id     bigint not null references public.datasets (id) on delete cascade,
  name           varchar(160) not null,
  data_type      varchar(32) not null,
  nullable       boolean not null default true,
  unique_values  integer not null default 0,
  null_percent   integer not null default 0 check (null_percent between 0 and 100),
  constraint dataset_columns_dataset_name_key unique (dataset_id, name)
);

create table if not exists public.dataset_rows (
  id          bigint generated always as identity primary key,
  dataset_id  bigint  not null references public.datasets (id) on delete cascade,
  row_index   integer not null check (row_index >= 0),
  data        jsonb   not null,
  constraint dataset_rows_dataset_index_key unique (dataset_id, row_index)
);

create table if not exists public.dataset_connections (
  id                  bigint generated always as identity primary key,
  workspace_id        bigint not null references public.workspaces (id) on delete cascade,
  name                varchar(160) not null,
  type                varchar(32)  not null,
  host                varchar(255) not null,
  port                integer not null check (port between 1 and 65535),
  database_name       varchar(160) not null,
  username            varchar(160) not null,
  encrypted_password  text not null, -- AES-256-GCM ciphertext (server/connectionCrypto.ts), never plaintext
  ssl_mode            varchar(32) not null,
  created_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now()
);

create table if not exists public.ingestion_attempts (
  id             bigint generated always as identity primary key,
  workspace_id   bigint not null references public.workspaces (id) on delete cascade,
  dataset_name   varchar(160) not null,
  source_type    varchar(80)  not null,
  status         varchar(32)  not null check (status in ('pending', 'complete', 'failed')),
  rows_ingested  integer not null default 0,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists ingestion_attempts_workspace_idx on public.ingestion_attempts (workspace_id, created_at desc);

-- ------------------------------------------------------------------- pipelines
create table if not exists public.pipelines (
  id                      bigint generated always as identity primary key,
  organization_id         bigint not null references public.organizations (id) on delete cascade,
  workspace_id            bigint references public.workspaces (id) on delete cascade, -- used from roadmap Phase 2
  project_id              bigint references public.projects (id) on delete set null,
  name                    varchar(160) not null,
  owner_id                uuid references auth.users (id) on delete set null,
  status                  varchar(32) not null,
  source_dataset_id       bigint references public.datasets (id) on delete set null,
  destination_mode        varchar(32) check (destination_mode in ('new_dataset', 'overwrite_existing')),
  destination_dataset_id  bigint references public.datasets (id) on delete set null,
  success_rate            integer,
  avg_duration_seconds    integer,
  failure_count           integer not null default 0,
  dag                     jsonb,
  created_at              timestamptz not null default now()
);
create index if not exists pipelines_workspace_idx on public.pipelines (workspace_id);

create table if not exists public.pipeline_steps (
  id           bigint generated always as identity primary key,
  pipeline_id  bigint  not null references public.pipelines (id) on delete cascade,
  step_order   integer not null check (step_order >= 0),
  operation    varchar(32) not null check (operation in ('filter', 'rename_column', 'change_datatype', 'drop_column', 'remove_nulls')),
  config       jsonb   not null,
  constraint pipeline_steps_order_key unique (pipeline_id, step_order)
);

create table if not exists public.pipeline_runs (
  id                 bigint generated always as identity primary key,
  pipeline_id        bigint not null references public.pipelines (id) on delete cascade,
  status             varchar(32) not null check (status in ('created', 'running', 'success', 'failed')),
  rows_in            integer not null default 0,
  rows_out           integer not null default 0,
  coercion_failures  integer not null default 0,
  duration_ms        integer not null default 0,
  error_message      text,
  logs               jsonb,
  started_at         timestamptz not null default now(),
  completed_at       timestamptz
);
create index if not exists pipeline_runs_pipeline_idx on public.pipeline_runs (pipeline_id, started_at desc);

-- ------------------------------------------------------------ change & review
create table if not exists public.changes (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations (id) on delete cascade,
  project_id       bigint references public.projects (id) on delete set null,
  author_id        uuid references auth.users (id) on delete set null,
  title            varchar(160) not null,
  change_type      varchar(32)  not null check (change_type in ('SQL', 'PYTHON', 'YAML', 'SCHEMA', 'CONFIG', 'GITHUB_PR')),
  source           text not null,
  created_at       timestamptz not null default now()
);

create table if not exists public.risk_analyses (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations (id) on delete cascade,
  change_id        bigint not null references public.changes (id) on delete cascade,
  score            integer not null check (score between 0 and 100),
  level            varchar(16) not null check (level in ('SAFE', 'MEDIUM', 'HIGH', 'CRITICAL')),
  engine_version   varchar(48) not null,
  result           jsonb not null,
  created_at       timestamptz not null default now()
);
create index if not exists risk_analyses_change_idx on public.risk_analyses (change_id);

create table if not exists public.reviews (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations (id) on delete cascade,
  change_id        bigint not null references public.changes (id) on delete cascade,
  reviewer_id      uuid references auth.users (id) on delete set null,
  decision         public.review_decision not null,
  comment          text,
  created_at       timestamptz not null default now()
);
create index if not exists reviews_change_idx on public.reviews (change_id);

-- ------------------------------------------------------- explore / utilities
create table if not exists public.recently_viewed (
  id            bigint generated always as identity primary key,
  user_id       uuid   not null references auth.users (id) on delete cascade,
  workspace_id  bigint not null references public.workspaces (id) on delete cascade,
  entity_type   varchar(32) not null check (entity_type in ('project', 'dataset', 'pipeline')),
  entity_id     varchar(64) not null,
  entity_label  varchar(160) not null,
  viewed_at     timestamptz not null default now(),
  constraint recently_viewed_user_entity_key unique (user_id, workspace_id, entity_type, entity_id)
);

create table if not exists public.saved_queries (
  id            bigint generated always as identity primary key,
  workspace_id  bigint not null references public.workspaces (id) on delete cascade,
  dataset_id    bigint not null references public.datasets (id) on delete cascade,
  created_by    uuid references auth.users (id) on delete set null,
  name          varchar(160) not null,
  sql_text      text not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.query_runs (
  id            bigint generated always as identity primary key,
  query_id      bigint not null references public.saved_queries (id) on delete cascade,
  workspace_id  bigint not null references public.workspaces (id) on delete cascade,
  run_by        uuid references auth.users (id) on delete set null,
  row_count     integer not null default 0,
  duration_ms   integer not null default 0,
  run_at        timestamptz not null default now()
);
create index if not exists query_runs_workspace_idx on public.query_runs (workspace_id, run_at desc);

-- ------------------------------------------------------------------ audit log
-- actor_id deliberately has no foreign key: audit history must survive user deletion.
create table if not exists public.audit_logs (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations (id) on delete cascade,
  workspace_id     bigint references public.workspaces (id) on delete set null,
  actor_id         uuid not null,
  action           varchar(96) not null,
  resource_type    varchar(64) not null,
  resource_id      varchar(64),
  result           varchar(32) not null,
  metadata         jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists audit_logs_workspace_idx on public.audit_logs (workspace_id, created_at desc);

-- ---------------------------------------------------------------- lock down
-- RLS on, no policies: the Data API (anon/authenticated) cannot touch these tables.
-- The Astra server connects directly (DATABASE_URL = Supabase connection string)
-- as the postgres role, which bypasses RLS and applies Astra's own rules.
do $$
declare t text;
begin
  foreach t in array array[
    'organizations','organization_members','workspaces','workspace_members','workspace_invitations',
    'workspace_data_environment','projects','datasets','dataset_columns','dataset_rows','dataset_connections',
    'ingestion_attempts','pipelines','pipeline_steps','pipeline_runs','changes','risk_analyses','reviews',
    'recently_viewed','saved_queries','query_runs','audit_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;
