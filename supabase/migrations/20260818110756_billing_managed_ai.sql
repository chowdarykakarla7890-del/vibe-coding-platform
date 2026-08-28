create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_subscription_id text not null unique,
  stripe_price_id text,
  plan text not null default 'free' check (plan in ('free', 'starter', 'pro')),
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_events (
  event_id text primary key,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

create table if not exists public.managed_ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start date not null,
  request_count integer not null default 0 check (request_count >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cost_nanos bigint not null default 0 check (cost_nanos >= 0),
  reserved_tokens bigint not null default 0 check (reserved_tokens >= 0),
  reserved_cost_nanos bigint not null default 0 check (reserved_cost_nanos >= 0),
  active_requests integer not null default 0 check (active_requests >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, period_start)
);

create table if not exists public.managed_ai_reservations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start date not null,
  plan text not null check (plan in ('starter', 'pro')),
  model text not null,
  reserved_tokens bigint not null check (reserved_tokens >= 0),
  reserved_cost_nanos bigint not null check (reserved_cost_nanos >= 0),
  status text not null default 'pending' check (status in ('pending', 'completed', 'released')),
  actual_input_tokens bigint,
  actual_output_tokens bigint,
  actual_cost_nanos bigint,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists subscriptions_status_idx on public.subscriptions (status);
create index if not exists managed_ai_reservations_user_created_idx
  on public.managed_ai_reservations (user_id, created_at desc);
create index if not exists managed_ai_reservations_pending_idx
  on public.managed_ai_reservations (user_id, created_at) where status = 'pending';

alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.billing_events enable row level security;
alter table public.managed_ai_usage enable row level security;
alter table public.managed_ai_reservations enable row level security;

revoke all on public.billing_customers, public.subscriptions, public.billing_events,
  public.managed_ai_usage, public.managed_ai_reservations from anon, authenticated;
grant select, insert, update, delete on public.billing_customers, public.subscriptions, public.billing_events,
  public.managed_ai_usage, public.managed_ai_reservations to service_role;

create or replace function public.reserve_managed_ai_usage(
  p_user_id uuid,
  p_request_id uuid,
  p_plan text,
  p_model text,
  p_reserved_tokens bigint,
  p_reserved_cost_nanos bigint,
  p_request_limit integer,
  p_token_limit bigint,
  p_cost_limit_nanos bigint,
  p_rpm_limit integer,
  p_concurrency_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period date := (date_trunc('month', timezone('utc', now())))::date;
  v_usage public.managed_ai_usage%rowtype;
  v_recent integer;
  v_expired_tokens bigint;
  v_expired_cost bigint;
  v_expired_count integer;
begin
  select coalesce(sum(reserved_tokens), 0), coalesce(sum(reserved_cost_nanos), 0), count(*)
    into v_expired_tokens, v_expired_cost, v_expired_count
  from public.managed_ai_reservations
  where user_id = p_user_id and status = 'pending' and created_at < now() - interval '15 minutes';

  if v_expired_count > 0 then
    update public.managed_ai_reservations
      set status = 'released', completed_at = now()
      where user_id = p_user_id and status = 'pending' and created_at < now() - interval '15 minutes';
    update public.managed_ai_usage
      set reserved_tokens = greatest(0, reserved_tokens - v_expired_tokens),
          reserved_cost_nanos = greatest(0, reserved_cost_nanos - v_expired_cost),
          active_requests = greatest(0, active_requests - v_expired_count),
          updated_at = now()
      where user_id = p_user_id and period_start = v_period;
  end if;

  insert into public.managed_ai_usage (user_id, period_start)
    values (p_user_id, v_period)
    on conflict (user_id, period_start) do nothing;

  select * into v_usage
  from public.managed_ai_usage
  where user_id = p_user_id and period_start = v_period
  for update;

  select count(*) into v_recent
  from public.managed_ai_reservations
  where user_id = p_user_id and created_at >= now() - interval '1 minute';

  if v_usage.request_count >= p_request_limit then
    return jsonb_build_object('ok', false, 'error', 'monthly_request_limit');
  end if;
  if v_usage.input_tokens + v_usage.output_tokens + v_usage.reserved_tokens + p_reserved_tokens > p_token_limit then
    return jsonb_build_object('ok', false, 'error', 'monthly_token_limit');
  end if;
  if v_usage.cost_nanos + v_usage.reserved_cost_nanos + p_reserved_cost_nanos > p_cost_limit_nanos then
    return jsonb_build_object('ok', false, 'error', 'monthly_spend_limit');
  end if;
  if v_recent >= p_rpm_limit then
    return jsonb_build_object('ok', false, 'error', 'rate_limit');
  end if;
  if v_usage.active_requests >= p_concurrency_limit then
    return jsonb_build_object('ok', false, 'error', 'concurrency_limit');
  end if;

  insert into public.managed_ai_reservations
    (id, user_id, period_start, plan, model, reserved_tokens, reserved_cost_nanos)
  values
    (p_request_id, p_user_id, v_period, p_plan, p_model, p_reserved_tokens, p_reserved_cost_nanos);

  update public.managed_ai_usage
    set request_count = request_count + 1,
        reserved_tokens = reserved_tokens + p_reserved_tokens,
        reserved_cost_nanos = reserved_cost_nanos + p_reserved_cost_nanos,
        active_requests = active_requests + 1,
        updated_at = now()
    where user_id = p_user_id and period_start = v_period
    returning * into v_usage;

  return jsonb_build_object(
    'ok', true,
    'request_count', v_usage.request_count,
    'reserved_tokens', v_usage.reserved_tokens,
    'reserved_cost_nanos', v_usage.reserved_cost_nanos
  );
end;
$$;

create or replace function public.finalize_managed_ai_usage(
  p_user_id uuid,
  p_request_id uuid,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cost_nanos bigint,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.managed_ai_reservations%rowtype;
begin
  select * into v_reservation
  from public.managed_ai_reservations
  where id = p_request_id and user_id = p_user_id
  for update;

  if v_reservation.id is null or v_reservation.status <> 'pending' then return; end if;

  update public.managed_ai_reservations
    set status = case when p_status = 'completed' then 'completed' else 'released' end,
        actual_input_tokens = greatest(0, p_input_tokens),
        actual_output_tokens = greatest(0, p_output_tokens),
        actual_cost_nanos = greatest(0, p_cost_nanos),
        completed_at = now()
    where id = p_request_id;

  update public.managed_ai_usage
    set input_tokens = input_tokens + greatest(0, p_input_tokens),
        output_tokens = output_tokens + greatest(0, p_output_tokens),
        cost_nanos = cost_nanos + greatest(0, p_cost_nanos),
        reserved_tokens = greatest(0, reserved_tokens - v_reservation.reserved_tokens),
        reserved_cost_nanos = greatest(0, reserved_cost_nanos - v_reservation.reserved_cost_nanos),
        active_requests = greatest(0, active_requests - 1),
        updated_at = now()
    where user_id = p_user_id and period_start = v_reservation.period_start;
end;
$$;

revoke all on function public.reserve_managed_ai_usage(uuid, uuid, text, text, bigint, bigint, integer, bigint, bigint, integer, integer)
  from public, anon, authenticated;
revoke all on function public.finalize_managed_ai_usage(uuid, uuid, bigint, bigint, bigint, text)
  from public, anon, authenticated;
grant execute on function public.reserve_managed_ai_usage(uuid, uuid, text, text, bigint, bigint, integer, bigint, bigint, integer, integer)
  to service_role;
grant execute on function public.finalize_managed_ai_usage(uuid, uuid, bigint, bigint, bigint, text)
  to service_role;
;
