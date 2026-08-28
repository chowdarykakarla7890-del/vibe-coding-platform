update public.managed_ai_reservations
set actual_cost_nanos = 0
where plan = 'free'
  and model = 'poolside/laguna-s-2.1-free'
  and actual_cost_nanos is distinct from 0;

update public.managed_ai_usage as usage
set cost_nanos = (
  select coalesce(sum(reservation.actual_cost_nanos), 0)
  from public.managed_ai_reservations as reservation
  where reservation.user_id = usage.user_id
    and reservation.period_start = usage.period_start
    and reservation.status = 'completed'
)
where exists (
  select 1
  from public.managed_ai_reservations as reservation
  where reservation.user_id = usage.user_id
    and reservation.period_start = usage.period_start
    and reservation.plan = 'free'
    and reservation.model = 'poolside/laguna-s-2.1-free'
);;
