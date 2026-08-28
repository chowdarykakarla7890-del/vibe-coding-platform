-- Submission content is copied from saved source under the same per-project
-- lock as editor/capture writes. No browser-provided source enters this path.
create table public.submission_sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null,
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  files jsonb not null check (jsonb_typeof(files)='array' and jsonb_array_length(files) between 1 and 200),
  byte_size integer not null check (byte_size between 1 and 10485760),
  created_at timestamptz not null default now(),
  unique(project_id,digest),
  unique(id,project_id,user_id),
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete cascade
);
create index submission_sources_owner_idx on public.submission_sources(user_id,project_id);
create index submission_sources_project_owner_idx on public.submission_sources(project_id,user_id);
alter table public.submission_sources enable row level security;
revoke all on public.submission_sources from public,anon,authenticated;
grant select on public.submission_sources to authenticated;
grant all on public.submission_sources to service_role;
create policy own_submission_sources on public.submission_sources for select to authenticated using((select auth.uid())=user_id);

create table public.activity_submissions (
  id uuid primary key,
  project_id uuid not null,
  user_id uuid not null,
  source_id uuid not null,
  source_versions jsonb not null check (jsonb_typeof(source_versions)='array' and jsonb_array_length(source_versions) between 1 and 200),
  activity_id text not null,
  manifest jsonb not null check (jsonb_typeof(manifest)='object' and octet_length(manifest::text)<=1000000),
  language text not null check (char_length(language) between 1 and 40),
  model_id text not null check (char_length(model_id) between 1 and 120),
  reflection text not null default '' check(char_length(reflection)<=4000),
  state text not null default 'pending' check(state in ('pending','complete','failed')),
  failure_code text check(failure_code ~ '^[A-Z_]{3,80}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '5 minutes'),
  finished_at timestamptz,
  unique(id,project_id,user_id),
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete cascade,
  foreign key(source_id,project_id,user_id) references public.submission_sources(id,project_id,user_id) on delete cascade,
  check((state='pending' and finished_at is null and failure_code is null)
    or (state='complete' and finished_at is not null and failure_code is null)
    or (state='failed' and finished_at is not null and failure_code is not null))
);
create index activity_submissions_owner_idx on public.activity_submissions(user_id,project_id);
create index activity_submissions_project_idx on public.activity_submissions(project_id,user_id,created_at desc,id desc);
create index activity_submissions_source_idx on public.activity_submissions(source_id,project_id,user_id);
alter table public.activity_submissions enable row level security;
revoke all on public.activity_submissions from public,anon,authenticated;
grant select on public.activity_submissions to authenticated;
grant all on public.activity_submissions to service_role;
create policy own_activity_submissions on public.activity_submissions for select to authenticated using((select auth.uid())=user_id);

create function private.immutable_submission_content() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_table_name='submission_sources' then
    raise exception 'SUBMISSION_IMMUTABLE' using errcode='P0001';
  end if;
  if (to_jsonb(new)-array['state','failure_code','finished_at']) is distinct from
    (to_jsonb(old)-array['state','failure_code','finished_at']) or
    (old.state<>'pending' and to_jsonb(new) is distinct from to_jsonb(old)) then
    raise exception 'SUBMISSION_IMMUTABLE' using errcode='P0001';
  end if;
  return new;
end $$;
revoke all on function private.immutable_submission_content() from public,anon,authenticated;
create trigger immutable_submission_source before update on public.submission_sources for each row execute function private.immutable_submission_content();
create trigger immutable_submission before update on public.activity_submissions for each row execute function private.immutable_submission_content();

alter table public.assessments add column submission_id uuid;
alter table public.assessments add column source_current boolean;
alter table public.assessments add constraint assessment_submission_owner_fk foreign key(submission_id,project_id,user_id)
  references public.activity_submissions(id,project_id,user_id) on delete cascade;
alter table public.assessments add constraint assessment_source_provenance check(submission_id is null or source_current is not null);
create unique index assessments_submission_idx on public.assessments(submission_id) where submission_id is not null;
create index assessments_submission_owner_idx on public.assessments(submission_id,project_id,user_id);

create function public.begin_activity_submission(p_user_id uuid,p_project_id uuid,p_submission_id uuid,
  p_manifest jsonb,p_language text,p_model_id text,p_reflection text default '')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.projects%rowtype; previous public.activity_submissions%rowtype;
  source_row public.submission_sources%rowtype; source_files jsonb; versions jsonb; source_bytes bigint;
  source_digest text; user_bytes bigint; project_bytes bigint; file_count integer;
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
  -- Always user quota -> project source -> project row. Source writers take
  -- project source -> project row, never the user submission quota lock.
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
  if not found then
    select coalesce(sum(byte_size),0),coalesce(sum(byte_size) filter(where project_id=p_project_id),0)
      into user_bytes,project_bytes from public.submission_sources where user_id=p_user_id;
    if user_bytes+source_bytes>209715200 or project_bytes+source_bytes>52428800 then
      raise exception 'SUBMISSION_STORAGE_LIMIT' using errcode='P0001';
    end if;
    insert into public.submission_sources(project_id,user_id,digest,files,byte_size)
      values(p_project_id,p_user_id,source_digest,source_files,source_bytes) returning * into source_row;
  elsif source_row.files<>source_files or source_row.user_id<>p_user_id then
    raise exception 'SUBMISSION_DIGEST_CONFLICT' using errcode='P0001';
  end if;
  -- Abandoned requests remain visible as failed records, never learner scores.
  update public.activity_submissions set state='failed',failure_code='SUBMISSION_INTERRUPTED',finished_at=now()
    where project_id=p_project_id and user_id=p_user_id and state='pending' and expires_at<=now();
  insert into public.activity_submissions(id,project_id,user_id,source_id,source_versions,activity_id,manifest,language,model_id,reflection)
    values(p_submission_id,p_project_id,p_user_id,source_row.id,versions,p_manifest->>'id',p_manifest,p_language,p_model_id,p_reflection)
    returning * into previous;
  return to_jsonb(previous);
end $$;
revoke all on function public.begin_activity_submission(uuid,uuid,uuid,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.begin_activity_submission(uuid,uuid,uuid,jsonb,text,text,text) to service_role;

create function public.fail_activity_submission(p_user_id uuid,p_submission_id uuid,p_code text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if p_code is null or p_code !~ '^[A-Z_]{3,80}$' then raise exception 'INVALID_SUBMISSION_FAILURE' using errcode='22023'; end if;
  update public.activity_submissions set state='failed',failure_code=p_code,finished_at=now()
    where id=p_submission_id and user_id=p_user_id and state='pending';
  return found;
end $$;
revoke all on function public.fail_activity_submission(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fail_activity_submission(uuid,uuid,text) to service_role;

create function public.record_submission_assessment(p_user_id uuid,p_submission_id uuid,p_score integer,p_passed boolean,
  p_ai_assessed boolean,p_feedback jsonb,p_verification_kind text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.activity_submissions%rowtype; a public.assessments%rowtype; project uuid; versions jsonb; is_current boolean; concepts text[];
begin
  if p_score is null or p_score not between 0 and 100 or p_passed is null or p_ai_assessed is null
    or (p_passed and p_score<70) or jsonb_typeof(p_feedback) is distinct from 'array' or octet_length(p_feedback::text)>65536
    or p_verification_kind is null or p_verification_kind not in ('command','rubric') then
    raise exception 'INVALID_ASSESSMENT' using errcode='22023';
  end if;
  select project_id into project from public.activity_submissions where id=p_submission_id and user_id=p_user_id;
  if not found then raise exception 'SUBMISSION_NOT_FOUND' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended(project::text,0));
  perform 1 from public.projects where id=project and user_id=p_user_id for update;
  if not found then raise exception 'SUBMISSION_NOT_FOUND' using errcode='P0001'; end if;
  select * into s from public.activity_submissions where id=p_submission_id and user_id=p_user_id for update;
  if not found then raise exception 'SUBMISSION_NOT_FOUND' using errcode='P0001'; end if;
  select * into a from public.assessments where submission_id=s.id;
  if found then
    if a.score<>p_score or a.passed<>p_passed or a.ai_assessed<>p_ai_assessed or a.feedback<>p_feedback or a.verification_kind<>p_verification_kind then
      raise exception 'ASSESSMENT_CONFLICT' using errcode='P0001';
    end if;
    return jsonb_build_object('id',a.id,'sourceCurrent',a.source_current);
  end if;
  if s.state<>'pending' or s.expires_at<=now() then raise exception 'SUBMISSION_CLOSED' using errcode='P0001'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('path',path,'revision',revision) order by path),'[]')
    into versions from public.source_files where project_id=project and user_id=p_user_id and not deleted;
  is_current:=versions=s.source_versions and exists(select 1 from public.projects where id=project and activity_id=s.activity_id and language=s.language);
  select array_agg(value) into concepts from jsonb_array_elements_text(s.manifest->'concepts');
  insert into public.assessments(id,user_id,project_id,activity_id,score,passed,ai_assessed,feedback,concepts,model_id,verification_kind,language,submission_id,source_current)
    values(s.id,s.user_id,s.project_id,s.activity_id,p_score,p_passed,p_ai_assessed,p_feedback,coalesce(concepts,'{}'),s.model_id,p_verification_kind,s.language,s.id,is_current);
  update public.activity_submissions set state='complete',finished_at=now() where id=s.id;
  update public.projects set updated_at=now(),status=case when p_passed and is_current then 'completed' else status end where id=project and user_id=p_user_id;
  return jsonb_build_object('id',s.id,'sourceCurrent',is_current);
end $$;
revoke all on function public.record_submission_assessment(uuid,uuid,integer,boolean,boolean,jsonb,text) from public,anon,authenticated;
grant execute on function public.record_submission_assessment(uuid,uuid,integer,boolean,boolean,jsonb,text) to service_role;
