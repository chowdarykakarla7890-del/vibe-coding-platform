-- Correct escaped regexes and add composite foreign-key indexes.
alter table public.source_files drop constraint source_files_path_check;
alter table public.source_files add constraint source_files_path_check check (
  char_length(path) between 1 and 240
  and path not like '/%'
  and position(chr(92) in path) = 0
  and path !~ '(^|/)[.][.]?(/|$)'
  and path !~ '[[:cntrl:]]'
  and path not like '%//%'
);
alter table public.sandbox_sessions drop constraint sandbox_sessions_preview_origin_check;
alter table public.sandbox_sessions add constraint sandbox_sessions_preview_origin_check
  check (preview_origin ~ '^https://[a-zA-Z0-9-]+[.]vercel[.]run$');
alter table public.sandbox_sessions drop constraint sandbox_sessions_ports_check;
alter table public.sandbox_sessions add constraint sandbox_sessions_ports_check
  check (cardinality(ports) between 1 and 4 and 1 <= all(ports) and 65535 >= all(ports) and array_position(ports,null) is null);
create index messages_project_user_idx on public.messages(project_id,user_id);
create index source_files_project_user_idx on public.source_files(project_id,user_id);
-- Explicitly document the private table's service-only policy.
create policy server_only on private.rate_limit_buckets
  for all to service_role using (true) with check (true);
