-- Deletions retain their revision fence. Never physically remove a path row
-- while its project exists: delayed writers must not see revision zero again.
alter table public.source_files add column deleted boolean not null default false;
alter table public.source_files add constraint deleted_source_is_empty check (not deleted or content = '');
create index source_files_active_project_path_idx on public.source_files(project_id,path) where not deleted;

create or replace function private.enforce_source_quota() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare file_count bigint; total_bytes bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.project_id::text,0));
  if new.deleted then return new; end if;
  if exists (
    select 1 from public.source_files
    where project_id = new.project_id and not deleted and path <> new.path
      and (pg_catalog.starts_with(path, new.path || '/') or pg_catalog.starts_with(new.path, path || '/'))
  ) then
    raise exception 'SOURCE_PATH_CONFLICT' using errcode='P0001';
  end if;
  select count(*), coalesce(sum(octet_length(content)),0)
    into file_count,total_bytes from public.source_files
    where project_id = new.project_id and not deleted and path <> new.path;
  if file_count >= 200 or total_bytes + octet_length(new.content) > 10485760 then
    raise exception 'Source snapshot exceeds project limits' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function private.enforce_source_quota() from public,anon,authenticated;

create or replace function public.save_source_revision_batch(p_user_id uuid, p_project_id uuid, p_files jsonb, p_create_only boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare item jsonb; current_revision integer; current_content text; current_deleted boolean;
  expected_revision integer; requested_deleted boolean; changed boolean; receipts jsonb;
begin
  if p_user_id is null or p_project_id is null or p_create_only is null or jsonb_typeof(p_files) is distinct from 'array' then
    raise exception 'INVALID_SOURCE' using errcode = '22023';
  end if;
  -- Internal capture may replace 200 old paths with 200 new paths atomically.
  -- Public source-write requests retain their 200-file bound.
  if jsonb_array_length(p_files) < 1 or jsonb_array_length(p_files) > 400 then
    raise exception 'INVALID_SOURCE' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_project_id::text, 0));
  perform 1 from public.projects where id = p_project_id and user_id = p_user_id for key share;
  if not found then raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0001'; end if;
  if (select count(distinct value->>'path') from jsonb_array_elements(p_files)) <> jsonb_array_length(p_files) then
    raise exception 'INVALID_SOURCE' using errcode = '22023';
  end if;
  for item in select value from jsonb_array_elements(p_files) loop
    if jsonb_typeof(item->'path') is distinct from 'string' or jsonb_typeof(item->'content') is distinct from 'string'
      or (item ? 'revision' and jsonb_typeof(item->'revision') not in ('number','null'))
      or (item ? 'deleted' and jsonb_typeof(item->'deleted') is distinct from 'boolean') then
      raise exception 'INVALID_SOURCE' using errcode = '22023';
    end if;
    expected_revision := coalesce((item->>'revision')::integer, 0);
    requested_deleted := coalesce((item->>'deleted')::boolean, false);
    if expected_revision < 0 or (requested_deleted and (item->>'content' <> '' or p_create_only)) then
      raise exception 'INVALID_SOURCE' using errcode = '22023';
    end if;
    select revision, content, deleted into current_revision, current_content, current_deleted from public.source_files
      where project_id = p_project_id and user_id = p_user_id and path = item->>'path';
    if p_create_only and current_revision is not null and not current_deleted then
      raise exception 'FILE_ALREADY_EXISTS' using errcode = '23505';
    end if;
    changed := current_content is distinct from item->>'content' or current_deleted is distinct from requested_deleted;
    -- Idempotent lost-receipt retries must match BOTH content and deletion
    -- state. An empty live file is not equivalent to a tombstone.
    if expected_revision > coalesce(current_revision, 0) or
      (coalesce(current_revision, 0) <> expected_revision and changed) then
      raise exception 'SOURCE_CONFLICT' using errcode = 'P0001';
    end if;
    if changed and current_revision = 2147483647 then
      raise exception 'SOURCE_REVISION_EXHAUSTED' using errcode = 'P0001';
    end if;
  end loop;

  -- Free namespace/quota before adding new paths. Shrinking files precede
  -- growing files so valid final batches do not fail on transient byte limits.
  for item in
    select source.value from jsonb_array_elements(p_files) as source(value)
    left join public.source_files as saved on saved.project_id = p_project_id and saved.path = source.value->>'path'
    order by coalesce((source.value->>'deleted')::boolean,false) desc,
      octet_length(source.value->>'content') - coalesce(octet_length(saved.content),0),
      source.value->>'path'
  loop
    insert into public.source_files(project_id,user_id,path,content,revision,deleted,updated_at)
      values(p_project_id,p_user_id,item->>'path',item->>'content',1,coalesce((item->>'deleted')::boolean,false),now())
    on conflict(project_id,path) do update set
      content = excluded.content,
      deleted = excluded.deleted,
      revision = case when source_files.content = excluded.content and source_files.deleted = excluded.deleted
        then source_files.revision else source_files.revision + 1 end,
      updated_at = case when source_files.content = excluded.content and source_files.deleted = excluded.deleted
        then source_files.updated_at else now() end;
  end loop;
  select jsonb_agg(jsonb_build_object('path', saved.path, 'revision', saved.revision) order by input.ordinality) into receipts
    from jsonb_array_elements(p_files) with ordinality as input(value, ordinality)
    join public.source_files as saved on saved.project_id = p_project_id and saved.path = input.value->>'path';
  return receipts;
end $$;
revoke all on function public.save_source_revision_batch(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.save_source_revision_batch(uuid,uuid,jsonb,boolean) to service_role;
