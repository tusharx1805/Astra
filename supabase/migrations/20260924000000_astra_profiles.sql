-- ASTRA · Supabase Auth profiles
-- Creates public.profiles keyed by auth.users.id, a trigger that creates the
-- profile atomically with the auth user, a username-availability RPC, and RLS.
-- Non-destructive: only creates objects (IF NOT EXISTS / OR REPLACE); drops nothing.
-- Passwords and credentials remain exclusively in auth.users (managed by Supabase).

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  username    text not null,
  full_name   text not null,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,30}$'),
  constraint profiles_full_name_length check (char_length(btrim(full_name)) between 1 and 120),
  constraint profiles_avatar_url_format check (avatar_url is null or avatar_url ~* '^https://')
);

comment on table public.profiles is 'ASTRA public profile, one row per auth.users row. Never holds credentials.';

-- Usernames are stored lowercase (enforced by the format check); this index makes them unique.
create unique index if not exists profiles_username_key on public.profiles (username);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.set_profiles_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_profiles_updated_at();

-- ---------------------------------------------------------------------------
-- Profile creation on signup
-- Runs inside the same transaction as the auth.users insert, so a signup whose
-- username is invalid or already taken fails as a whole (no orphan accounts).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  requested_full_name text := btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''));
begin
  if requested_username !~ '^[a-z0-9_]{3,30}$' then
    raise exception 'ASTRA_INVALID_USERNAME' using errcode = '22023';
  end if;
  if char_length(requested_full_name) not between 1 and 120 then
    raise exception 'ASTRA_INVALID_FULL_NAME' using errcode = '22023';
  end if;
  insert into public.profiles (id, username, full_name)
  values (new.id, requested_username, requested_full_name);
  return new;
exception
  when unique_violation then
    raise exception 'ASTRA_USERNAME_TAKEN' using errcode = '23505';
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Username availability (used by the signup form before calling signUp).
-- Usernames are public profile data, so exposing availability leaks nothing new.
-- ---------------------------------------------------------------------------
create or replace function public.username_available(candidate text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select lower(btrim(candidate)) ~ '^[a-z0-9_]{3,30}$'
     and not exists (select 1 from public.profiles p where p.username = lower(btrim(candidate)));
$$;

revoke all on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

-- Signed-in users can read profiles (username, name, avatar are public within ASTRA).
drop policy if exists "profiles are readable by signed-in users" on public.profiles;
create policy "profiles are readable by signed-in users"
  on public.profiles for select
  to authenticated
  using (true);

-- Users can update only their own row.
drop policy if exists "users update their own profile" on public.profiles;
create policy "users update their own profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- No INSERT or DELETE policies: rows are created by the trigger above and removed
-- by ON DELETE CASCADE when the auth user is deleted.

-- Column privileges: clients may change only these columns (not id / timestamps).
revoke all on table public.profiles from anon;
revoke insert, update, delete, truncate on table public.profiles from authenticated;
grant select on table public.profiles to authenticated;
grant update (username, full_name, avatar_url) on table public.profiles to authenticated;
