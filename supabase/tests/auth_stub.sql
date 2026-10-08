-- Local verification harness for supabase/migrations (NOT a migration; never run against Supabase).
-- Usage: psql -d <scratch_db> -f supabase/tests/auth_stub.sql -f supabase/migrations/20260924000000_astra_profiles.sql -f supabase/tests/profiles_rls.test.sql
-- Minimal stand-in for the Supabase platform objects the migration depends on.
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text unique, encrypted_password text, raw_user_meta_data jsonb default '{}'::jsonb);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
