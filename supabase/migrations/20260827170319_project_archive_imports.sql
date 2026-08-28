-- Foreign history is evidence, never an authoritative chat/tool/assessment.
-- Receipts outlive project deletion; archive content cascades with its project.
create table private.project_archive_imports (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  manifest jsonb not null check(jsonb_typeof(manifest)='object' and octet_length(manifest::text)<4096),
  expected_digest text not null check(expected_digest ~ '^[a-f0-9]{64}$'),
  expected_count integer not null check(expected_count between 1 and 50000),
  expected_bytes integer not null check(expected_bytes between 1 and 268435456),
  uploaded_count integer not null default 0 check(uploaded_count between 0 and expected_count),
  uploaded_bytes integer not null default 0 check(uploaded_bytes between 0 and expected_bytes),
  state text not null default 'uploading' check(state in ('uploading','published','cancelled')),
  project_id uuid references public.projects(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp()+interval '2 hours'
);
create unique index project_archive_imports_active_user_idx on private.project_archive_imports(user_id) where state='uploading';
create index project_archive_imports_user_idx on private.project_archive_imports(user_id);
create index project_archive_imports_expiry_idx on private.project_archive_imports(expires_at);
create index project_archive_imports_project_idx on private.project_archive_imports(project_id);
create table private.imported_project_archives (
  id uuid primary key references private.project_archive_imports(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid unique,
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete cascade
);
create index imported_project_archives_user_idx on private.imported_project_archives(user_id);
create table private.imported_project_archive_records (
  archive_id uuid not null references private.imported_project_archives(id) on delete cascade,
  ordinal integer not null check(ordinal between 1 and 50000),
  kind text not null check(kind in ('project','source','message','conflict','conflict-copy','submission','submission-source','submission-file','assessment','activity','portfolio-project','capture-status')),
  record_key text not null check(char_length(record_key) between 1 and 256),
  payload text not null check(octet_length(payload)<=2097152),
  digest text not null check(digest ~ '^[a-f0-9]{64}$'),
  primary key(archive_id,ordinal), unique(archive_id,kind,record_key)
);
alter table private.project_archive_imports enable row level security;
alter table private.imported_project_archives enable row level security;
alter table private.imported_project_archive_records enable row level security;
revoke all on private.project_archive_imports,private.imported_project_archives,private.imported_project_archive_records from public,anon,authenticated;
grant all on private.project_archive_imports,private.imported_project_archives,private.imported_project_archive_records to service_role;

create function public.project_archive_import_operation(p_user_id uuid,p_import_id uuid,p_action text,p_input jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job private.project_archive_imports%rowtype; item jsonb; manifest jsonb; record jsonb; source jsonb; original jsonb;
  old_record private.imported_project_archive_records%rowtype; project jsonb; files jsonb; digest text;
  next_index integer; bytes integer; file_count integer; source_bytes integer;
begin
  if p_user_id is null or p_import_id is null or p_action is null
    or p_action not in ('begin','read','upload','publish','cancel') or jsonb_typeof(p_input) is distinct from 'object'
    or octet_length(p_input::text)>4202496 then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,8));
  select * into job from private.project_archive_imports where id=p_import_id and user_id=p_user_id for update;
  if p_action='begin' then
    manifest:=p_input->'manifest';
    if p_input-array['manifest','digest']<>'{}' or coalesce(p_input->>'digest','') !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(manifest) is distinct from 'object' or octet_length(manifest::text)>=4096
      or manifest-array['format','version','scope','includesUnsavedDrafts','includesLiveSandboxFiles','id','projectId','createdAt','expiresAt','recordCount','payloadBytes']<>'{}'
      or manifest->>'format' is distinct from 'codetutor-project-archive' or manifest->'version' is distinct from '2'::jsonb
      or manifest->>'scope' is distinct from 'saved-project' or manifest->'includesUnsavedDrafts' is distinct from 'false'::jsonb
      or manifest->'includesLiveSandboxFiles' is distinct from 'false'::jsonb
      or coalesce(manifest->>'id','') !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
      or coalesce(manifest->>'projectId','') !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
      or jsonb_typeof(manifest->'createdAt') is distinct from 'string' or jsonb_typeof(manifest->'expiresAt') is distinct from 'string'
      or coalesce(manifest->>'recordCount','') !~ '^[1-9][0-9]{0,4}$' or (manifest->>'recordCount')::integer>50000
      or coalesce(manifest->>'payloadBytes','') !~ '^[1-9][0-9]{0,8}$' or (manifest->>'payloadBytes')::integer>268435456
      then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
    if job.id is not null then
      if job.manifest<>manifest or job.expected_digest<>p_input->>'digest' then raise exception 'ARCHIVE_IMPORT_CONFLICT'; end if;
    else
      if exists(select 1 from private.project_archive_imports where id=p_import_id) or exists(select 1 from public.projects where id=p_import_id)
        or exists(select 1 from private.source_imports where id=p_import_id) then raise exception 'ARCHIVE_IMPORT_CONFLICT'; end if;
      delete from private.project_archive_imports where user_id=p_user_id and expires_at<=clock_timestamp() and state<>'published';
      if exists(select 1 from private.project_archive_imports where user_id=p_user_id and state='uploading') then raise exception 'ARCHIVE_IMPORT_IN_PROGRESS'; end if;
      -- Reserve the complete size at begin, not only bytes uploaded so far.
      if (select coalesce(sum(i.expected_bytes),0) from private.project_archive_imports i join private.imported_project_archives a on a.id=i.id where i.user_id=p_user_id)
        +(manifest->>'payloadBytes')::integer>536870912 then raise exception 'ARCHIVE_STORAGE_LIMIT'; end if;
      insert into private.project_archive_imports(id,user_id,manifest,expected_digest,expected_count,expected_bytes)
        values(p_import_id,p_user_id,manifest,p_input->>'digest',(manifest->>'recordCount')::integer,(manifest->>'payloadBytes')::integer) returning * into job;
      insert into private.imported_project_archives(id,user_id) values(job.id,job.user_id);
    end if;
  elsif job.id is null then raise exception 'ARCHIVE_IMPORT_NOT_FOUND'; end if;
  if job.expires_at<=clock_timestamp() and job.state<>'published' and p_action<>'cancel' then raise exception 'ARCHIVE_IMPORT_EXPIRED'; end if;
  if p_action in ('read','publish','cancel') and p_input<>'{}' then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
  if p_action='cancel' and job.state='uploading' then
    delete from private.imported_project_archives where id=job.id;
    update private.project_archive_imports set state='cancelled',uploaded_count=0,uploaded_bytes=0,expires_at=clock_timestamp()+interval '1 day' where id=job.id returning * into job;
  elsif p_action in ('upload','publish') and job.state='cancelled' then raise exception 'ARCHIVE_IMPORT_CANCELLED';
  elsif p_action='upload' and job.state='published' then raise exception 'ARCHIVE_IMPORT_ALREADY_PUBLISHED';
  elsif p_action='upload' then
    if p_input-'records'<>'{}' or jsonb_typeof(p_input->'records') is distinct from 'array'
      or jsonb_array_length(p_input->'records') not between 1 and 20 then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
    for item in select value from jsonb_array_elements(p_input->'records') loop
      if jsonb_typeof(item) is distinct from 'object' or item-array['index','record','sha256']<>'{}'
        or coalesce(item->>'index','') !~ '^[1-9][0-9]{0,4}$' or (item->>'index')::integer>job.expected_count
        or jsonb_typeof(item->'record') is distinct from 'string' or octet_length(item->>'record')>2097152
        or coalesce(item->>'sha256','') !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
      digest:=encode(sha256(convert_to(item->>'record','UTF8')),'hex');
      if digest<>item->>'sha256' then raise exception 'ARCHIVE_DIGEST_MISMATCH'; end if;
      next_index:=(item->>'index')::integer;
      select * into old_record from private.imported_project_archive_records r where r.archive_id=job.id and r.ordinal=next_index;
      if found then
        if old_record.digest<>digest or old_record.payload<>item->>'record' then raise exception 'ARCHIVE_IMPORT_CONFLICT'; end if;
        continue;
      end if;
      if next_index<>job.uploaded_count+1 then raise exception 'ARCHIVE_IMPORT_INCOMPLETE'; end if;
      begin record:=(item->>'record')::jsonb; exception when invalid_text_representation or untranslatable_character then raise exception 'INVALID_ARCHIVE_IMPORT'; end;
      if jsonb_typeof(record) is distinct from 'object' or record-array['kind','key','data']<>'{}'
        or record->>'kind' is null or record->>'kind' not in ('project','source','message','conflict','conflict-copy','submission','submission-source','submission-file','assessment','activity','portfolio-project','capture-status')
        or jsonb_typeof(record->'key') is distinct from 'string' or char_length(record->>'key') not between 1 and 256
        or jsonb_typeof(record->'data') is distinct from 'object' then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
      if next_index=1 then
        original:=record->'data';
        if record->>'kind'<>'project' or record->>'key'<>job.manifest->>'projectId' or original->>'id' is distinct from job.manifest->>'projectId'
          or jsonb_typeof(original->'title') is distinct from 'string' or char_length(original->>'title') not between 1 and 100
          or jsonb_typeof(original->'language') is distinct from 'string' or char_length(original->>'language') not between 1 and 40 then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
      elsif record->>'kind'='project' then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
      if record->>'kind'='source' then
        source:=record->'data';
        if jsonb_typeof(source->'path') is distinct from 'string' or not private.safe_capture_path(source->>'path')
          or record->>'key'<>source->>'path' or jsonb_typeof(source->'content') is distinct from 'string'
          or octet_length(source->>'content')>262144 or jsonb_typeof(source->'deleted') is distinct from 'boolean'
          or (source->>'deleted'='true' and source->>'content'<>'') then raise exception 'INVALID_ARCHIVE_SOURCE'; end if;
      end if;
      if exists(select 1 from private.imported_project_archive_records r where r.archive_id=job.id and r.kind=record->>'kind' and r.record_key=record->>'key') then raise exception 'ARCHIVE_IMPORT_CONFLICT'; end if;
      bytes:=octet_length(item->>'record');
      if job.uploaded_bytes+bytes>job.expected_bytes then raise exception 'ARCHIVE_IMPORT_LIMIT'; end if;
      insert into private.imported_project_archive_records(archive_id,ordinal,kind,record_key,payload,digest)
        values(job.id,next_index,record->>'kind',record->>'key',item->>'record',digest);
      job.uploaded_count:=next_index; job.uploaded_bytes:=job.uploaded_bytes+bytes;
    end loop;
    update private.project_archive_imports set uploaded_count=job.uploaded_count,uploaded_bytes=job.uploaded_bytes where id=job.id;
  end if;
  if p_action='publish' and job.state='uploading' then
    if job.uploaded_count<>job.expected_count or job.uploaded_bytes<>job.expected_bytes then raise exception 'ARCHIVE_IMPORT_INCOMPLETE'; end if;
    select encode(sha256(convert_to(string_agg(r.ordinal::text||':'||r.digest||chr(10),'' order by r.ordinal),'UTF8')),'hex') into digest
      from private.imported_project_archive_records r where r.archive_id=job.id;
    if digest is distinct from job.expected_digest then raise exception 'ARCHIVE_DIGEST_MISMATCH'; end if;
    select payload::jsonb->'data' into original from private.imported_project_archive_records where archive_id=job.id and ordinal=1;
    select count(*),coalesce(sum(octet_length(payload::jsonb->'data'->>'content')),0),
      jsonb_agg(jsonb_build_object('path',record_key,'content',payload::jsonb->'data'->>'content','revision',0) order by record_key)
      into file_count,source_bytes,files from private.imported_project_archive_records where archive_id=job.id and kind='source' and payload::jsonb->'data'->>'deleted'='false';
    if file_count>200 or source_bytes>10485760 then raise exception 'ARCHIVE_IMPORT_LIMIT'; end if;
    if exists(select 1 from jsonb_array_elements(coalesce(files,'[]')) a cross join jsonb_array_elements(coalesce(files,'[]')) b
      where starts_with(a->>'path',(b->>'path')||'/')) then raise exception 'SOURCE_PATH_CONFLICT'; end if;
    insert into public.projects(id,user_id,title,language,mode,status)
      values(job.id,job.user_id,left(original->>'title',69)||' (imported)',original->>'language','playground','active');
    if file_count>0 then perform public.save_source_revision_batch(job.user_id,job.id,files,true); end if;
    update private.imported_project_archives set project_id=job.id where id=job.id;
    update private.project_archive_imports set state='published',project_id=job.id,expires_at=clock_timestamp()+interval '1 day' where id=job.id returning * into job;
  end if;
  if job.state='published' then
    select to_jsonb(p) into project from public.projects p where p.id=job.project_id and p.user_id=p_user_id;
    if project is null then raise exception 'IMPORTED_PROJECT_DELETED'; end if;
  end if;
  return jsonb_build_object('id',job.id,'state',job.state,'expiresAt',job.expires_at,'manifest',job.manifest,'digest',job.expected_digest,
    'uploadedRecords',job.uploaded_count,'uploadedBytes',job.uploaded_bytes,'project',project);
end $$;

create function public.read_imported_project_archive(p_user_id uuid,p_project_id uuid,p_after integer default 0) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job private.project_archive_imports%rowtype; records jsonb; last_ordinal integer;
begin
  if p_user_id is null or p_project_id is null or p_after is null or p_after<0 or p_after>50000 then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
  select i.* into job from private.project_archive_imports i join private.imported_project_archives a on a.id=i.id
    where a.project_id=p_project_id and a.user_id=p_user_id and i.user_id=p_user_id and i.state='published';
  if not found then raise exception 'ARCHIVE_IMPORT_NOT_FOUND'; end if;
  if p_after>=job.expected_count then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
  with candidates as (
    select *,sum(octet_length(payload)) over(order by ordinal) as page_bytes,row_number() over(order by ordinal) as page_row
    from (select * from private.imported_project_archive_records where archive_id=job.id and ordinal>p_after order by ordinal limit 20) r
  ), page as (select * from candidates where page_bytes<=1048576 or page_row=1)
  select jsonb_agg(jsonb_build_object('index',ordinal,'record',payload,'sha256',digest) order by ordinal),max(ordinal) into records,last_ordinal from page;
  return jsonb_build_object('id',job.id,'manifest',job.manifest,'digest',job.expected_digest,'provenance','imported-unverified',
    'records',records,'nextCursor',case when last_ordinal<job.expected_count then last_ordinal else null end);
end $$;

create function public.purge_project_archive_imports() returns integer
language sql security invoker set search_path='' as $$
  -- Published tombstones are small and permanent until account deletion.
  -- Purging them would let a delayed begin recreate a deleted project.
  with expired as (select id from private.project_archive_imports where expires_at<=clock_timestamp() and state<>'published' order by expires_at for update skip locked limit 5),
  removed as (delete from private.project_archive_imports where id in(select id from expired) returning id) select count(*)::integer from removed;
$$;
revoke all on function public.project_archive_import_operation(uuid,uuid,text,jsonb),public.read_imported_project_archive(uuid,uuid,integer),public.purge_project_archive_imports() from public,anon,authenticated;
grant execute on function public.project_archive_import_operation(uuid,uuid,text,jsonb),public.read_imported_project_archive(uuid,uuid,integer),public.purge_project_archive_imports() to service_role;
