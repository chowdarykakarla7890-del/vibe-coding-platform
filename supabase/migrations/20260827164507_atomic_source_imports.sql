-- Source uploads are private staging, not visible projects. Publish metadata
-- and all source in one transaction; never delete a published project on an
-- uncertain receipt. Imported history, scores, identities and VM credentials
-- are deliberately not accepted by this source-only protocol.
create table private.source_imports (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check(char_length(title) between 1 and 80),
  language text not null check(char_length(language) between 1 and 40),
  expected_count integer not null check(expected_count between 0 and 200),
  expected_bytes integer not null check(expected_bytes between 0 and 10485760),
  expected_digest text not null check(expected_digest ~ '^[a-f0-9]{64}$'),
  state text not null default 'uploading' check(state in ('uploading','published','cancelled')),
  project_id uuid references public.projects(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp()+interval '30 minutes'
);
create unique index source_imports_active_user_idx on private.source_imports(user_id) where state='uploading';
create index source_imports_user_idx on private.source_imports(user_id);
create index source_imports_expiry_idx on private.source_imports(expires_at);
create index source_imports_project_idx on private.source_imports(project_id);
create table private.source_import_files (
  import_id uuid not null references private.source_imports(id) on delete cascade,
  path text not null check(private.safe_capture_path(path)),
  content text not null check(octet_length(content)<=262144),
  digest text not null check(digest ~ '^[a-f0-9]{64}$'),
  primary key(import_id,path)
);
alter table private.source_imports enable row level security;
alter table private.source_import_files enable row level security;
revoke all on private.source_imports,private.source_import_files from public,anon,authenticated;
grant all on private.source_imports,private.source_import_files to service_role;

create function public.source_import_operation(p_user_id uuid,p_import_id uuid,p_action text,p_input jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job private.source_imports%rowtype; item jsonb; files jsonb; project jsonb;
  count_files integer; bytes integer; digest text; old_digest text; old_content text;
begin
  if p_user_id is null or p_import_id is null or p_action is null
    or p_action not in ('begin','read','upload','publish','cancel') or jsonb_typeof(p_input) is distinct from 'object'
    or octet_length(p_input::text)>2097152 then raise exception 'INVALID_IMPORT'; end if;
  -- Every mutation/read shares the same account lock: cancel/publish are
  -- ordered, uploads cannot change after validation, parallel begins cannot
  -- bypass the staging quota, and retries cannot publish duplicate projects.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,7));
  select * into job from private.source_imports where id=p_import_id and user_id=p_user_id for update;
  if p_action='begin' then
    if jsonb_typeof(p_input->'title') is distinct from 'string' or jsonb_typeof(p_input->'language') is distinct from 'string'
      or char_length(btrim(p_input->>'title')) not between 1 and 80 or char_length(btrim(p_input->>'language')) not between 1 and 40
      or coalesce(p_input->>'fileCount','') !~ '^(0|[1-9][0-9]{0,2})$'
      or coalesce(p_input->>'sourceBytes','') !~ '^(0|[1-9][0-9]{0,7})$'
      or coalesce(p_input->>'digest','') !~ '^[a-f0-9]{64}$'
      or (p_input->>'fileCount')::integer>200 or (p_input->>'sourceBytes')::integer>10485760
      or p_input - array['title','language','fileCount','sourceBytes','digest'] <> '{}' then raise exception 'INVALID_IMPORT'; end if;
    if job.id is not null then
      if job.title<>p_input->>'title' or job.language<>p_input->>'language' or job.expected_count<>(p_input->>'fileCount')::integer
        or job.expected_bytes<>(p_input->>'sourceBytes')::integer or job.expected_digest<>p_input->>'digest' then raise exception 'IMPORT_CONFLICT'; end if;
    else
      if exists(select 1 from private.source_imports where id=p_import_id) or exists(select 1 from public.projects where id=p_import_id) then
        raise exception 'IMPORT_CONFLICT'; end if;
      delete from private.source_imports where user_id=p_user_id and expires_at<=clock_timestamp() and (state<>'published' or project_id is null);
      if exists(select 1 from private.source_imports where user_id=p_user_id and state='uploading') then raise exception 'IMPORT_IN_PROGRESS'; end if;
      insert into private.source_imports(id,user_id,title,language,expected_count,expected_bytes,expected_digest)
        values(p_import_id,p_user_id,p_input->>'title',p_input->>'language',(p_input->>'fileCount')::integer,
          (p_input->>'sourceBytes')::integer,p_input->>'digest') returning * into job;
    end if;
  elsif job.id is null then
    raise exception 'IMPORT_NOT_FOUND';
  end if;
  if job.expires_at<=clock_timestamp() and job.state<>'published' and p_action<>'cancel' then raise exception 'IMPORT_EXPIRED'; end if;
  if p_action in ('read','cancel','publish') and p_input<>'{}' then raise exception 'INVALID_IMPORT'; end if;
  if p_action='cancel' and job.state='uploading' then
    delete from private.source_import_files where import_id=job.id;
    update private.source_imports set state='cancelled',expires_at=clock_timestamp()+interval '1 day' where id=job.id returning * into job;
  elsif p_action in ('upload','publish') and job.state='cancelled' then raise exception 'IMPORT_CANCELLED';
  elsif p_action='upload' and job.state='published' then raise exception 'IMPORT_ALREADY_PUBLISHED';
  elsif p_action='upload' then
    if jsonb_typeof(p_input->'files') is distinct from 'array' or p_input - 'files' <> '{}'
      or jsonb_array_length(p_input->'files') not between 1 and 20 then raise exception 'INVALID_IMPORT'; end if;
    if (select count(distinct value->>'path') from jsonb_array_elements(p_input->'files'))<>jsonb_array_length(p_input->'files') then raise exception 'INVALID_IMPORT'; end if;
    for item in select value from jsonb_array_elements(p_input->'files') loop
      if jsonb_typeof(item) is distinct from 'object' or item-array['path','content','digest']<>'{}'
        or jsonb_typeof(item->'path') is distinct from 'string' or not private.safe_capture_path(item->>'path')
        or jsonb_typeof(item->'content') is distinct from 'string' or octet_length(item->>'content')>262144
        or coalesce(item->>'digest','') !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_IMPORT'; end if;
      digest:=encode(sha256(convert_to(item->>'content','UTF8')),'hex');
      if digest<>item->>'digest' then raise exception 'IMPORT_DIGEST_MISMATCH'; end if;
      select f.digest,f.content into old_digest,old_content from private.source_import_files f where f.import_id=job.id and f.path=item->>'path';
      if found and (old_digest<>digest or old_content<>item->>'content') then raise exception 'IMPORT_CONFLICT'; end if;
      if exists(select 1 from private.source_import_files f where f.import_id=job.id and
        (starts_with(f.path,item->>'path'||'/') or starts_with(item->>'path',f.path||'/'))) then raise exception 'SOURCE_PATH_CONFLICT'; end if;
      insert into private.source_import_files(import_id,path,content,digest) values(job.id,item->>'path',item->>'content',digest) on conflict do nothing;
    end loop;
  end if;
  select count(*),coalesce(sum(octet_length(f.content)),0) into count_files,bytes from private.source_import_files f where f.import_id=job.id;
  if count_files>job.expected_count or bytes>job.expected_bytes then raise exception 'IMPORT_LIMIT'; end if;
  if p_action='publish' and job.state='uploading' then
    select encode(sha256(convert_to(coalesce(string_agg(f.path||':'||f.digest||chr(10),'' order by f.path collate "C"),''),'UTF8')),'hex') into digest
      from private.source_import_files f where f.import_id=job.id;
    if count_files<>job.expected_count or bytes<>job.expected_bytes or digest<>job.expected_digest then raise exception 'IMPORT_INCOMPLETE'; end if;
    -- Imports always start an ungraded playground. No foreign activity ID,
    -- completed state, tool call or credential gains authority through import.
    insert into public.projects(id,user_id,title,language,mode,status) values(job.id,job.user_id,job.title,job.language,'playground','active');
    select jsonb_agg(jsonb_build_object('path',f.path,'content',f.content,'revision',0) order by f.path) into files
      from private.source_import_files f where f.import_id=job.id;
    if count_files>0 then perform public.save_source_revision_batch(job.user_id,job.id,files,true); end if;
    update private.source_imports set state='published',project_id=job.id,expires_at=clock_timestamp()+interval '1 day' where id=job.id returning * into job;
    delete from private.source_import_files where import_id=job.id;
  end if;
  if job.state='published' then
    select to_jsonb(p) into project from public.projects p where p.id=job.project_id and p.user_id=p_user_id;
    if project is null then raise exception 'IMPORTED_PROJECT_DELETED'; end if;
  end if;
  return jsonb_build_object('id',job.id,'state',job.state,'expiresAt',job.expires_at,
    'fileCount',job.expected_count,'sourceBytes',job.expected_bytes,'digest',job.expected_digest,
    'uploadedFiles',case when job.state='published' then job.expected_count else count_files end,
    'uploadedBytes',case when job.state='published' then job.expected_bytes else bytes end,'project',project);
end $$;
revoke all on function public.source_import_operation(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.source_import_operation(uuid,uuid,text,jsonb) to service_role;

create function public.purge_source_imports() returns integer
language sql security invoker set search_path='' as $$
  with expired as (select id from private.source_imports where expires_at<=clock_timestamp() and (state<>'published' or project_id is null) order by expires_at for update skip locked limit 5),
  removed as (delete from private.source_imports where id in (select id from expired) returning id) select count(*)::integer from removed;
$$;
revoke all on function public.purge_source_imports() from public,anon,authenticated;
grant execute on function public.purge_source_imports() to service_role;
