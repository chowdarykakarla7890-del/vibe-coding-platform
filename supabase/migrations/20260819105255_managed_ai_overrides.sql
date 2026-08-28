create table if not exists public.managed_ai_overrides (
  user_id uuid primary key references auth.users(id) on delete cascade,
  unlimited boolean not null default false,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.managed_ai_overrides enable row level security;
revoke all on public.managed_ai_overrides from public, anon, authenticated;
grant select, insert, update, delete on public.managed_ai_overrides to service_role;

alter table public.managed_ai_reservations
  drop constraint if exists managed_ai_reservations_plan_check;

alter table public.managed_ai_reservations
  add constraint managed_ai_reservations_plan_check
  check (plan in ('free', 'starter', 'pro', 'unlimited'));;
