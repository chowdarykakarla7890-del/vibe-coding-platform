alter table public.managed_ai_reservations
  drop constraint if exists managed_ai_reservations_plan_check;

alter table public.managed_ai_reservations
  add constraint managed_ai_reservations_plan_check
  check (plan in ('free', 'starter', 'pro'));;
