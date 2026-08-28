create table if not exists public.managed_ai_credit_grants (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_checkout_session_id text not null unique,
  stripe_payment_intent_id text,
  pack_id text not null check (pack_id in ('5', '10', '25')),
  original_nanos bigint not null check (original_nanos > 0),
  remaining_nanos bigint not null check (remaining_nanos >= 0),
  status text not null default 'active' check (status in ('active', 'refunded', 'disputed')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.managed_ai_credit_allocations (
  request_id uuid not null references public.managed_ai_reservations(id) on delete cascade,
  grant_id uuid not null references public.managed_ai_credit_grants(id),
  reserved_nanos bigint not null check (reserved_nanos >= 0),
  consumed_nanos bigint not null default 0 check (consumed_nanos >= 0),
  primary key (request_id, grant_id)
);

alter table public.managed_ai_usage
  add column if not exists period_end date,
  add column if not exists included_cost_nanos bigint not null default 0 check (included_cost_nanos >= 0),
  add column if not exists topup_cost_nanos bigint not null default 0 check (topup_cost_nanos >= 0),
  add column if not exists reserved_included_cost_nanos bigint not null default 0 check (reserved_included_cost_nanos >= 0);

alter table public.managed_ai_reservations
  add column if not exists reserved_included_cost_nanos bigint not null default 0 check (reserved_included_cost_nanos >= 0);

update public.managed_ai_usage
set period_end = (period_start + interval '1 month')::date,
    included_cost_nanos = cost_nanos
where period_end is null;

alter table public.managed_ai_usage alter column period_end set not null;

create index if not exists managed_ai_credit_grants_user_expiry_idx
  on public.managed_ai_credit_grants (user_id, expires_at)
  where status = 'active' and remaining_nanos > 0;

alter table public.managed_ai_credit_grants enable row level security;
alter table public.managed_ai_credit_allocations enable row level security;
revoke all on public.managed_ai_credit_grants, public.managed_ai_credit_allocations from public, anon, authenticated;
grant select, insert, update, delete on public.managed_ai_credit_grants, public.managed_ai_credit_allocations to service_role;

create or replace function public.reserve_managed_ai_usage_v2(
  p_user_id uuid,
  p_request_id uuid,
  p_plan text,
  p_model text,
  p_period_start date,
  p_period_end date,
  p_reserved_tokens bigint,
  p_reserved_cost_nanos bigint,
  p_request_limit integer,
  p_token_limit bigint,
  p_included_cost_limit_nanos bigint,
  p_rpm_limit integer,
  p_concurrency_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usage public.managed_ai_usage%rowtype;
  v_recent integer;
  v_included_available bigint;
  v_reserved_included bigint;
  v_topup_needed bigint;
  v_topup_available bigint;
  v_take bigint;
  v_grant record;
  v_expired record;
  v_allocation record;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  for v_expired in
    select *
    from public.managed_ai_reservations
    where user_id = p_user_id and status = 'pending' and created_at < now() - interval '15 minutes'
    for update
  loop
    for v_allocation in
      select grant_id, reserved_nanos
      from public.managed_ai_credit_allocations
      where request_id = v_expired.id
    loop
      update public.managed_ai_credit_grants
        set remaining_nanos = remaining_nanos + v_allocation.reserved_nanos, updated_at = now()
        where id = v_allocation.grant_id and status = 'active';
    end loop;
    update public.managed_ai_usage
      set reserved_tokens = greatest(0, reserved_tokens - v_expired.reserved_tokens),
          reserved_cost_nanos = greatest(0, reserved_cost_nanos - v_expired.reserved_cost_nanos),
          reserved_included_cost_nanos = greatest(
            0,
            reserved_included_cost_nanos - v_expired.reserved_included_cost_nanos
          ),
          active_requests = greatest(0, active_requests - 1),
          updated_at = now()
      where user_id = p_user_id and period_start = v_expired.period_start;
    update public.managed_ai_reservations
      set status = 'released', completed_at = now()
      where id = v_expired.id;
  end loop;

  insert into public.managed_ai_usage (user_id, period_start, period_end)
    values (p_user_id, p_period_start, p_period_end)
    on conflict (user_id, period_start) do update set period_end = excluded.period_end;

  select * into v_usage
  from public.managed_ai_usage
  where user_id = p_user_id and period_start = p_period_start
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
  if v_recent >= p_rpm_limit then
    return jsonb_build_object('ok', false, 'error', 'rate_limit');
  end if;
  if v_usage.active_requests >= p_concurrency_limit then
    return jsonb_build_object('ok', false, 'error', 'concurrency_limit');
  end if;

  v_included_available := greatest(
    0,
    p_included_cost_limit_nanos - v_usage.included_cost_nanos - v_usage.reserved_included_cost_nanos
  );
  v_reserved_included := least(p_reserved_cost_nanos, v_included_available);
  v_topup_needed := greatest(0, p_reserved_cost_nanos - v_reserved_included);

  select coalesce(sum(remaining_nanos), 0) into v_topup_available
  from public.managed_ai_credit_grants
  where user_id = p_user_id and status = 'active' and expires_at > now();

  if v_topup_available < v_topup_needed then
    return jsonb_build_object('ok', false, 'error', 'monthly_spend_limit');
  end if;

  insert into public.managed_ai_reservations
    (id, user_id, period_start, plan, model, reserved_tokens, reserved_cost_nanos, reserved_included_cost_nanos)
  values
    (p_request_id, p_user_id, p_period_start, p_plan, p_model, p_reserved_tokens, p_reserved_cost_nanos, v_reserved_included);

  for v_grant in
    select id, remaining_nanos
    from public.managed_ai_credit_grants
    where user_id = p_user_id and status = 'active' and expires_at > now() and remaining_nanos > 0
    order by expires_at, created_at
    for update
  loop
    exit when v_topup_needed = 0;
    v_take := least(v_topup_needed, v_grant.remaining_nanos);
    update public.managed_ai_credit_grants
      set remaining_nanos = remaining_nanos - v_take, updated_at = now()
      where id = v_grant.id;
    insert into public.managed_ai_credit_allocations (request_id, grant_id, reserved_nanos)
      values (p_request_id, v_grant.id, v_take);
    v_topup_needed := v_topup_needed - v_take;
  end loop;

  update public.managed_ai_usage
    set request_count = request_count + 1,
        reserved_tokens = reserved_tokens + p_reserved_tokens,
        reserved_cost_nanos = reserved_cost_nanos + p_reserved_cost_nanos,
        reserved_included_cost_nanos = reserved_included_cost_nanos + v_reserved_included,
        active_requests = active_requests + 1,
        updated_at = now()
    where user_id = p_user_id and period_start = p_period_start;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.finalize_managed_ai_usage_v2(
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
  v_allocation record;
  v_topup_needed bigint;
  v_consumed bigint;
  v_included bigint;
  v_take bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_reservation
  from public.managed_ai_reservations
  where id = p_request_id and user_id = p_user_id
  for update;

  if v_reservation.id is null or v_reservation.status <> 'pending' then return; end if;

  if p_status <> 'completed' then
    for v_allocation in
      select grant_id, reserved_nanos from public.managed_ai_credit_allocations where request_id = p_request_id
    loop
      update public.managed_ai_credit_grants
        set remaining_nanos = remaining_nanos + v_allocation.reserved_nanos, updated_at = now()
        where id = v_allocation.grant_id and status = 'active';
    end loop;
    v_included := 0;
    v_consumed := 0;
  else
    v_included := least(greatest(0, p_cost_nanos), v_reservation.reserved_included_cost_nanos);
    v_topup_needed := greatest(0, p_cost_nanos - v_included);
    v_consumed := 0;
    for v_allocation in
      select grant_id, reserved_nanos from public.managed_ai_credit_allocations where request_id = p_request_id
    loop
      v_take := least(v_topup_needed, v_allocation.reserved_nanos);
      update public.managed_ai_credit_allocations
        set consumed_nanos = v_take
        where request_id = p_request_id and grant_id = v_allocation.grant_id;
      update public.managed_ai_credit_grants
        set remaining_nanos = remaining_nanos + (v_allocation.reserved_nanos - v_take), updated_at = now()
        where id = v_allocation.grant_id and status = 'active';
      v_topup_needed := v_topup_needed - v_take;
      v_consumed := v_consumed + v_take;
    end loop;
    v_included := greatest(0, p_cost_nanos - v_consumed);
  end if;

  update public.managed_ai_reservations
    set status = case when p_status = 'completed' then 'completed' else 'released' end,
        actual_input_tokens = greatest(0, p_input_tokens),
        actual_output_tokens = greatest(0, p_output_tokens),
        actual_cost_nanos = case when p_status = 'completed' then greatest(0, p_cost_nanos) else 0 end,
        completed_at = now()
    where id = p_request_id;

  update public.managed_ai_usage
    set input_tokens = input_tokens + case when p_status = 'completed' then greatest(0, p_input_tokens) else 0 end,
        output_tokens = output_tokens + case when p_status = 'completed' then greatest(0, p_output_tokens) else 0 end,
        cost_nanos = cost_nanos + case when p_status = 'completed' then greatest(0, p_cost_nanos) else 0 end,
        included_cost_nanos = included_cost_nanos + v_included,
        topup_cost_nanos = topup_cost_nanos + v_consumed,
        reserved_tokens = greatest(0, reserved_tokens - v_reservation.reserved_tokens),
        reserved_cost_nanos = greatest(0, reserved_cost_nanos - v_reservation.reserved_cost_nanos),
        reserved_included_cost_nanos = greatest(
          0,
          reserved_included_cost_nanos - v_reservation.reserved_included_cost_nanos
        ),
        active_requests = greatest(0, active_requests - 1),
        updated_at = now()
    where user_id = p_user_id and period_start = v_reservation.period_start;
end;
$$;

revoke all on function public.reserve_managed_ai_usage_v2(uuid, uuid, text, text, date, date, bigint, bigint, integer, bigint, bigint, integer, integer)
  from public, anon, authenticated;
revoke all on function public.finalize_managed_ai_usage_v2(uuid, uuid, bigint, bigint, bigint, text)
  from public, anon, authenticated;
grant execute on function public.reserve_managed_ai_usage_v2(uuid, uuid, text, text, date, date, bigint, bigint, integer, bigint, bigint, integer, integer)
  to service_role;
grant execute on function public.finalize_managed_ai_usage_v2(uuid, uuid, bigint, bigint, bigint, text)
  to service_role;
;
