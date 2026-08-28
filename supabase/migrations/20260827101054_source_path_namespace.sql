-- Keep namespace and quota checks inside the existing per-project lock. The
-- source CAS transaction uses this same lock before any writes, so competing
-- requests cannot each create a file and a descendant of that file.
-- No saved rows, grants, ownership policies or revision semantics are changed.
create or replace function private.enforce_source_quota() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare file_count bigint; total_bytes bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.project_id::text,0));
  if exists (
    select 1 from public.source_files
    where project_id = new.project_id and path <> new.path
      and (pg_catalog.starts_with(path, new.path || '/') or pg_catalog.starts_with(new.path, path || '/'))
  ) then
    raise exception 'SOURCE_PATH_CONFLICT' using errcode='P0001';
  end if;
  select count(*), coalesce(sum(octet_length(content)),0)
    into file_count,total_bytes from public.source_files
    where project_id = new.project_id and path <> new.path;
  if file_count >= 200 or total_bytes + octet_length(new.content) > 10485760 then
    raise exception 'Source snapshot exceeds project limits' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function private.enforce_source_quota() from public,anon,authenticated;
