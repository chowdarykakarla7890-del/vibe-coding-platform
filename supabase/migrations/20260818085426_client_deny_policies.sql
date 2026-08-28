create policy device_authorizations_no_client_access on public.device_authorizations
  for all to anon, authenticated
  using (false)
  with check (false);

create policy account_sessions_no_client_access on public.account_sessions
  for all to anon, authenticated
  using (false)
  with check (false);;
