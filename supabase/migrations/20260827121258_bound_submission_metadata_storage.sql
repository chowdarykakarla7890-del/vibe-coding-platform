-- Bound retained evidence, including JSON escaping and repeated manifests.
-- Stored generated counts cannot be forged by API callers and avoid repeatedly
-- detoasting every saved source blob while checking a user's quota.
alter table public.submission_sources add column storage_bytes integer
  generated always as (octet_length(files::text)) stored;
alter table public.activity_submissions add column metadata_bytes integer
  generated always as (octet_length(manifest::text)+octet_length(source_versions::text)+octet_length(reflection)) stored;

-- Generated values are computed AFTER BEFORE triggers. Compare immutable base
-- columns explicitly; inspecting NEW.metadata_bytes here would reject valid
-- pending -> complete/failed transitions.
create or replace function private.immutable_submission_content() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_table_name='submission_sources' then
    raise exception 'SUBMISSION_IMMUTABLE' using errcode='P0001';
  end if;
  if row(new.id,new.project_id,new.user_id,new.source_id,new.source_versions,new.activity_id,
    new.manifest,new.language,new.model_id,new.reflection,new.created_at,new.expires_at) is distinct from
    row(old.id,old.project_id,old.user_id,old.source_id,old.source_versions,old.activity_id,
    old.manifest,old.language,old.model_id,old.reflection,old.created_at,old.expires_at)
    or (old.state<>'pending' and row(new.state,new.failure_code,new.finished_at) is distinct from row(old.state,old.failure_code,old.finished_at)) then
    raise exception 'SUBMISSION_IMMUTABLE' using errcode='P0001';
  end if;
  return new;
end $$;
revoke all on function private.immutable_submission_content() from public,anon,authenticated;

create or replace function public.begin_activity_submission(p_user_id uuid,p_project_id uuid,p_submission_id uuid,
  p_manifest jsonb,p_language text,p_model_id text,p_reflection text default '')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.projects%rowtype; previous public.activity_submissions%rowtype;
  source_row public.submission_sources%rowtype; source_files jsonb; versions jsonb; source_bytes bigint;
  source_digest text; user_bytes bigint; project_bytes bigint; file_count integer;
  user_metadata bigint; project_metadata bigint; source_charge bigint; metadata_charge bigint;
begin
  if p_user_id is null or p_project_id is null or p_submission_id is null
    or jsonb_typeof(p_manifest) is distinct from 'object' or octet_length(p_manifest::text)>1000000
    or coalesce(p_manifest->>'id','') !~ '^[a-z0-9][a-z0-9-]{2,79}$'
    or jsonb_typeof(p_manifest->'concepts') is distinct from 'array' or jsonb_array_length(p_manifest->'concepts')>10
    or coalesce(char_length(p_language),0) not between 1 and 40
    or coalesce(char_length(p_model_id),0) not between 1 and 120
    or p_reflection is null or char_length(p_reflection)>4000 then
    raise exception 'INVALID_SUBMISSION' using errcode='22023';
  end if;
  -- Same order as before: user evidence quota -> project source -> project row.
  -- Independent projects of one user cannot race around the account quota.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,4));
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,0));
  select * into p from public.projects where id=p_project_id and user_id=p_user_id for update;
  if not found or p.activity_id is distinct from p_manifest->>'id' or p.language<>p_language then
    raise exception 'ACTIVITY_PROJECT_NOT_FOUND' using errcode='P0001';
  end if;
  select * into previous from public.activity_submissions where id=p_submission_id;
  if found then
    if previous.user_id<>p_user_id or previous.project_id<>p_project_id or previous.manifest<>p_manifest
      or previous.language<>p_language or previous.model_id<>p_model_id or previous.reflection<>p_reflection then
      raise exception 'SUBMISSION_CONFLICT' using errcode='P0001';
    end if;
    return to_jsonb(previous);
  end if;
  if exists(select 1 from public.source_capture_conflicts where project_id=p_project_id and user_id=p_user_id and resolved_at is null) then
    raise exception 'SOURCE_REVIEW_REQUIRED' using errcode='P0001';
  end if;
  if exists(select 1 from public.source_capture_jobs j join public.command_audits c on c.id=j.id
    where j.project_id=p_project_id and j.user_id=p_user_id and not c.background and j.state in ('queued','capturing','acknowledging')) then
    raise exception 'SOURCE_CAPTURE_PENDING' using errcode='P0001';
  end if;
  if (select count(*) from public.activity_submissions where user_id=p_user_id)>=5000
    or (select count(*) from public.activity_submissions where project_id=p_project_id)>=1000 then
    raise exception 'SUBMISSION_STORAGE_LIMIT' using errcode='P0001';
  end if;
  select count(*),coalesce(sum(octet_length(content)),0) into file_count,source_bytes
    from public.source_files where project_id=p_project_id and user_id=p_user_id and not deleted;
  if file_count=0 or source_bytes=0 then raise exception 'SUBMISSION_SOURCE_MISSING' using errcode='P0001'; end if;
  if file_count>200 or source_bytes>10485760 then raise exception 'SUBMISSION_SOURCE_LIMIT' using errcode='22023'; end if;
  select jsonb_agg(jsonb_build_object('path',path,'content',content) order by path),
    jsonb_agg(jsonb_build_object('path',path,'revision',revision) order by path)
    into source_files,versions from public.source_files where project_id=p_project_id and user_id=p_user_id and not deleted;
  source_digest:=encode(sha256(convert_to(source_files::text,'UTF8')),'hex');
  select * into source_row from public.submission_sources where project_id=p_project_id and digest=source_digest;
  if source_row.id is not null and (source_row.files<>source_files or source_row.user_id<>p_user_id) then
    raise exception 'SUBMISSION_DIGEST_CONFLICT' using errcode='P0001';
  end if;
  source_charge:=case when source_row.id is null then octet_length(source_files::text) else 0 end;
  metadata_charge:=octet_length(p_manifest::text)+octet_length(versions::text)+octet_length(p_reflection);
  select coalesce(sum(storage_bytes),0),coalesce(sum(storage_bytes) filter(where project_id=p_project_id),0)
    into user_bytes,project_bytes from public.submission_sources where user_id=p_user_id;
  select coalesce(sum(metadata_bytes),0),coalesce(sum(metadata_bytes) filter(where project_id=p_project_id),0)
    into user_metadata,project_metadata from public.activity_submissions where user_id=p_user_id;
  if user_bytes+user_metadata+source_charge+metadata_charge>209715200
    or project_bytes+project_metadata+source_charge+metadata_charge>52428800 then
    raise exception 'SUBMISSION_STORAGE_LIMIT' using errcode='P0001';
  end if;
  if source_row.id is null then
    insert into public.submission_sources(project_id,user_id,digest,files,byte_size)
      values(p_project_id,p_user_id,source_digest,source_files,source_bytes) returning * into source_row;
  end if;
  update public.activity_submissions set state='failed',failure_code='SUBMISSION_INTERRUPTED',finished_at=now()
    where project_id=p_project_id and user_id=p_user_id and state='pending' and expires_at<=now();
  insert into public.activity_submissions(id,project_id,user_id,source_id,source_versions,activity_id,manifest,language,model_id,reflection)
    values(p_submission_id,p_project_id,p_user_id,source_row.id,versions,p_manifest->>'id',p_manifest,p_language,p_model_id,p_reflection)
    returning * into previous;
  return to_jsonb(previous);
end $$;
revoke all on function public.begin_activity_submission(uuid,uuid,uuid,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.begin_activity_submission(uuid,uuid,uuid,jsonb,text,text,text) to service_role;
