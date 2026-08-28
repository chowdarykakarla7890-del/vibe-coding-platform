-- Compare-and-swap is the only source mutation path. Clients retain RLS-scoped
-- reads, but cannot bypass the revision check with a direct REST upsert.
alter table public.source_files add column revision integer not null default 1 check (revision > 0);
revoke insert, update, delete on public.source_files from anon, authenticated;

create function public.save_source_revision_batch(p_user_id uuid, p_project_id uuid, p_files jsonb, p_create_only boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare item jsonb; current_revision integer; current_content text; expected_revision integer;
  receipts jsonb := '[]'::jsonb; next_revision integer;
begin
  if p_user_id is null or p_project_id is null or jsonb_typeof(p_files) is distinct from 'array' then
    raise exception 'INVALID_SOURCE' using errcode = '22023';
  end if;
  if jsonb_array_length(p_files) < 1 or jsonb_array_length(p_files) > 200 then
    raise exception 'INVALID_SOURCE' using errcode = '22023';
  end if;
  -- Same lock as the existing quota trigger; no external calls in this transaction.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_project_id::text, 0));
  perform 1 from public.projects where id = p_project_id and user_id = p_user_id for key share;
  if not found then raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0001'; end if;
  if (select count(distinct value->>'path') from jsonb_array_elements(p_files)) <> jsonb_array_length(p_files) then
    raise exception 'INVALID_SOURCE' using errcode = '22023';
  end if;
  for item in select value from jsonb_array_elements(p_files) loop
    if jsonb_typeof(item->'path') is distinct from 'string' or jsonb_typeof(item->'content') is distinct from 'string'
      or (item ? 'revision' and jsonb_typeof(item->'revision') not in ('number','null')) then
      raise exception 'INVALID_SOURCE' using errcode = '22023';
    end if;
    expected_revision := coalesce((item->>'revision')::integer, 0);
    if expected_revision < 0 then raise exception 'INVALID_SOURCE' using errcode = '22023'; end if;
    select revision, content into current_revision, current_content from public.source_files
      where project_id = p_project_id and user_id = p_user_id and path = item->>'path';
    if p_create_only and current_revision is not null then
      raise exception 'FILE_ALREADY_EXISTS' using errcode = '23505';
    end if;
    -- Identical content is a safe idempotent retry, even after a lost receipt.
    if coalesce(current_revision, 0) <> expected_revision and current_content is distinct from item->>'content' then
      raise exception 'SOURCE_CONFLICT' using errcode = 'P0001';
    end if;
  end loop;
  for item in select value from jsonb_array_elements(p_files) loop
    insert into public.source_files(project_id,user_id,path,content,revision,updated_at)
      values(p_project_id,p_user_id,item->>'path',item->>'content',1,now())
    on conflict(project_id,path) do update set
      content = excluded.content,
      revision = case when source_files.content = excluded.content then source_files.revision else source_files.revision + 1 end,
      updated_at = case when source_files.content = excluded.content then source_files.updated_at else now() end
    returning revision into next_revision;
    receipts := receipts || jsonb_build_array(jsonb_build_object('path',item->>'path','revision',next_revision));
  end loop;
  return receipts;
end $$;
revoke all on function public.save_source_revision_batch(uuid,uuid,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.save_source_revision_batch(uuid,uuid,jsonb,boolean) to service_role;
