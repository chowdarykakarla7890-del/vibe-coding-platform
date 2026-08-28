create policy managed_ai_overrides_no_client_access on public.managed_ai_overrides
  for all to anon, authenticated using (false) with check (false);;
