create policy billing_customers_no_client_access on public.billing_customers
  for all to anon, authenticated using (false) with check (false);

create policy subscriptions_no_client_access on public.subscriptions
  for all to anon, authenticated using (false) with check (false);

create policy billing_events_no_client_access on public.billing_events
  for all to anon, authenticated using (false) with check (false);

create policy managed_ai_usage_no_client_access on public.managed_ai_usage
  for all to anon, authenticated using (false) with check (false);

create policy managed_ai_reservations_no_client_access on public.managed_ai_reservations
  for all to anon, authenticated using (false) with check (false);
;
