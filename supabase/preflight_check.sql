-- Astra release preflight — READ ONLY. Paste into Supabase → SQL Editor and run.
-- Every row must say OK before you deploy. Anything MISSING names the migration to run.
with checks(item, ok, fix) as (
  values
  ('Phase 1–3 app schema (workspaces, datasets, pipelines, runs)', to_regclass('public.pipeline_runs') is not null, '20260924010000_astra_app_schema.sql'),
  ('Profiles + signup trigger', to_regclass('public.profiles') is not null and exists (select 1 from pg_proc where proname = 'handle_new_user'), '20260924000000_astra_profiles.sql'),
  ('Phase 4 change scope (changes.workspace_id / pipeline_id)', exists (select 1 from information_schema.columns where table_schema='public' and table_name='changes' and column_name='pipeline_id'), '20260924020000_astra_phase4_change_scope.sql'),
  ('Phase 7 quality checks, results, incidents', to_regclass('public.incidents') is not null and to_regclass('public.quality_results') is not null, '20260930000000_astra_phase7_quality_incidents.sql'),
  ('Phase 9 dataset provenance (dataset_sources)', to_regclass('public.dataset_sources') is not null, '20261001000000_astra_phase9_postgres_sources.sql'),
  ('Phase 9 quality trigger ''sync'' allowed', exists (select 1 from pg_constraint where conname = 'quality_results_trigger_check' and pg_get_constraintdef(oid) like '%sync%'), '20261001000000_astra_phase9_postgres_sources.sql'),
  ('Phase 10 AI briefs (ai_briefs)', to_regclass('public.ai_briefs') is not null, '20261002000000_astra_phase10_ai_briefs.sql'),
  ('Release: profiles visible only to self + workspace peers', exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles readable by self and workspace peers')
      and not exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles are readable by signed-in users'), '20261003000000_astra_release_hardening.sql'),
  ('RLS enabled on every public table', not exists (select 1 from pg_tables where schemaname='public' and not rowsecurity), 'enable RLS on the tables listed by: select tablename from pg_tables where schemaname=''public'' and not rowsecurity;'),
  ('No app table readable by anon', not exists (select 1 from information_schema.role_table_grants where table_schema='public' and grantee='anon' and table_name <> 'profiles'), 'revoke all on the listed tables from anon')
)
select case when ok then 'OK' else 'MISSING' end as status, item, case when ok then '' else 'run: ' || fix end as action
from checks order by ok, item;
