create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.device_authorizations (
  device_code_hash text primary key,
  user_code_hash text not null unique,
  client_id text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'consumed')),
  user_id uuid references auth.users(id) on delete cascade,
  interval_seconds integer not null default 5 check (interval_seconds between 5 and 60),
  expires_at timestamptz not null,
  last_polled_at timestamptz,
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.account_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  access_token_hash text not null unique,
  refresh_token_hash text not null unique,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.learning_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_id text not null,
  status text not null check (status in ('not_started', 'in_progress', 'completed')),
  attempts integer not null default 0 check (attempts >= 0),
  hint_index integer not null default 0 check (hint_index >= 0),
  solution_revealed boolean not null default false,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

create index if not exists device_authorizations_user_id_idx on public.device_authorizations (user_id);
create index if not exists device_authorizations_expires_at_idx on public.device_authorizations (expires_at);
create index if not exists account_sessions_user_id_idx on public.account_sessions (user_id);
create index if not exists account_sessions_refresh_expires_at_idx on public.account_sessions (refresh_expires_at);

alter table public.profiles enable row level security;
alter table public.device_authorizations enable row level security;
alter table public.account_sessions enable row level security;
alter table public.learning_progress enable row level security;

revoke all on public.profiles, public.device_authorizations, public.account_sessions, public.learning_progress from anon, authenticated;
grant select, insert, update, delete on public.device_authorizations, public.account_sessions to service_role;
grant select, insert, update on public.profiles, public.learning_progress to service_role;
grant select, insert, update on public.profiles, public.learning_progress to authenticated;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists learning_progress_select_own on public.learning_progress;
create policy learning_progress_select_own on public.learning_progress
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists learning_progress_insert_own on public.learning_progress;
create policy learning_progress_insert_own on public.learning_progress
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists learning_progress_update_own on public.learning_progress;
create policy learning_progress_update_own on public.learning_progress
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function private.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke execute on function private.create_profile_for_new_user() from public, anon, authenticated;

drop trigger if exists create_profile_after_signup on auth.users;
create trigger create_profile_after_signup
  after insert on auth.users
  for each row execute function private.create_profile_for_new_user();;
