create index if not exists managed_ai_credit_allocations_grant_idx
  on public.managed_ai_credit_allocations (grant_id);

create policy managed_ai_credit_grants_no_client_access on public.managed_ai_credit_grants
  for all to anon, authenticated using (false) with check (false);

create policy managed_ai_credit_allocations_no_client_access on public.managed_ai_credit_allocations
  for all to anon, authenticated using (false) with check (false);
;
