-- Hidden cases and program outputs never enter the browser Data API. The
-- application exposes only the explicitly projected summary below.
create table private.submission_grading (
  submission_id uuid primary key,
  project_id uuid not null,
  user_id uuid not null,
  plan jsonb not null check(jsonb_typeof(plan)='object' and octet_length(plan::text)<=131072),
  plan_digest text not null check(plan_digest ~ '^[a-f0-9]{64}$'),
  report jsonb check(jsonb_typeof(report)='object' and octet_length(report::text)<=131072),
  -- Reserve the maximum report before spending VM time. Finalization at quota
  -- can never fail just because its outputs consumed more than an estimate.
  reserved_bytes integer generated always as (octet_length(plan::text)+131072) stored,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key(submission_id,project_id,user_id) references public.activity_submissions(id,project_id,user_id) on delete cascade,
  check((report is null)=(completed_at is null))
);
create index submission_grading_owner_idx on private.submission_grading(user_id,project_id);
create index submission_grading_project_idx on private.submission_grading(project_id,user_id);
alter table private.submission_grading enable row level security;
revoke all on private.submission_grading from public,anon,authenticated;
grant select,insert,update,delete on private.submission_grading to service_role;

create function private.immutable_grading_evidence() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  -- convert_to is STABLE, so it cannot be used in a generated column. Seal
  -- the canonical UTF-8 digest on insertion and forbid subsequent changes.
  if tg_op='INSERT' then
    new.plan_digest:=encode(sha256(convert_to(new.plan::text,'UTF8')),'hex');
    return new;
  end if;
  if row(new.submission_id,new.project_id,new.user_id,new.plan,new.plan_digest,new.created_at) is distinct from
    row(old.submission_id,old.project_id,old.user_id,old.plan,old.plan_digest,old.created_at)
    or (old.report is not null and row(new.report,new.completed_at) is distinct from row(old.report,old.completed_at)) then
    raise exception 'GRADING_EVIDENCE_IMMUTABLE';
  end if;
  return new;
end $$;
revoke all on function private.immutable_grading_evidence() from public,anon,authenticated;
create trigger immutable_grading_evidence before insert or update on private.submission_grading
  for each row execute function private.immutable_grading_evidence();

-- Count source, manifests, and reserved grading evidence in the SAME existing
-- 50 MiB/project and 200 MiB/account budget. All admission paths use lock 4.
create function private.enforce_submission_storage() returns trigger
language plpgsql security invoker set search_path='' as $$
declare charge bigint; used_account bigint; used_project bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,4));
  if tg_table_name='submission_sources' then charge:=octet_length(new.files::text);
  elsif tg_table_name='activity_submissions' then charge:=octet_length(new.manifest::text)+octet_length(new.source_versions::text)+octet_length(new.reflection);
  else charge:=octet_length(new.plan::text)+131072; end if;
  select coalesce(sum(bytes),0),coalesce(sum(bytes) filter(where project_id=new.project_id),0)
    into used_account,used_project from (
      select storage_bytes::bigint bytes,project_id from public.submission_sources where user_id=new.user_id
      union all select metadata_bytes::bigint,project_id from public.activity_submissions where user_id=new.user_id
      union all select reserved_bytes::bigint,project_id from private.submission_grading where user_id=new.user_id
    ) usage;
  if used_account+charge>209715200 or used_project+charge>52428800 then raise exception 'SUBMISSION_STORAGE_LIMIT'; end if;
  return new;
end $$;
revoke all on function private.enforce_submission_storage() from public,anon,authenticated;
create trigger submission_source_storage before insert on public.submission_sources for each row execute function private.enforce_submission_storage();
create trigger submission_metadata_storage before insert on public.activity_submissions for each row execute function private.enforce_submission_storage();
create trigger submission_grading_storage before insert on private.submission_grading for each row execute function private.enforce_submission_storage();

create function public.prepare_submission_grading(p_user_id uuid,p_submission_id uuid,p_plan jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s public.activity_submissions%rowtype; e private.submission_grading%rowtype; test jsonb; source_digest text;
begin
  if p_user_id is null or p_submission_id is null or jsonb_typeof(p_plan) is distinct from 'object'
    or p_plan-array['version','checkVersion','activityId','language','sourceDigest','harnessDigest','runtimeDigest','cases']<>'{}'
    or p_plan->'version' is distinct from '1'::jsonb
    or jsonb_typeof(p_plan->'checkVersion') is distinct from 'string'
    or jsonb_typeof(p_plan->'activityId') is distinct from 'string'
    or jsonb_typeof(p_plan->'language') is distinct from 'string'
    or jsonb_typeof(p_plan->'sourceDigest') is distinct from 'string'
    or jsonb_typeof(p_plan->'harnessDigest') is distinct from 'string'
    or jsonb_typeof(p_plan->'runtimeDigest') is distinct from 'string'
    or coalesce(p_plan->>'checkVersion','') !~ '^[a-zA-Z0-9._-]{1,80}$'
    or coalesce(p_plan->>'sourceDigest','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_plan->>'harnessDigest','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_plan->>'runtimeDigest','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_plan->'cases') is distinct from 'array' then raise exception 'INVALID_GRADING_PLAN'; end if;
  if jsonb_array_length(p_plan->'cases')<>24 or octet_length(p_plan::text)>131072 then raise exception 'INVALID_GRADING_PLAN'; end if;
  for test in select value from jsonb_array_elements(p_plan->'cases') loop
    if jsonb_typeof(test) is distinct from 'object' or test-array['input','label']<>'{}' or not test ? 'input'
      or jsonb_typeof(test->'label') is distinct from 'string' or length(test->>'label') not between 1 and 120 then raise exception 'INVALID_GRADING_PLAN'; end if;
  end loop;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,4));
  select * into s from public.activity_submissions where id=p_submission_id and user_id=p_user_id;
  if not found then raise exception 'SUBMISSION_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.project_id::text,0));
  perform 1 from public.projects where id=s.project_id and user_id=p_user_id for key share;
  if not found then raise exception 'SUBMISSION_NOT_FOUND'; end if;
  select * into s from public.activity_submissions where id=p_submission_id and user_id=p_user_id for update;
  if not found then raise exception 'SUBMISSION_NOT_FOUND'; end if;
  select digest into source_digest from public.submission_sources where id=s.source_id and user_id=p_user_id and project_id=s.project_id;
  if p_plan->>'sourceDigest' is distinct from source_digest or p_plan->>'activityId' is distinct from s.activity_id
    or p_plan->>'language' is distinct from s.language or s.manifest->>'source' is distinct from 'curated' then raise exception 'GRADING_PLAN_MISMATCH'; end if;
  select * into e from private.submission_grading where submission_id=s.id;
  if found then
    if e.plan<>p_plan or e.user_id<>p_user_id then raise exception 'GRADING_PLAN_MISMATCH'; end if;
  else
    if s.state<>'pending' or s.expires_at<=now() then raise exception 'SUBMISSION_CLOSED'; end if;
    insert into private.submission_grading(submission_id,project_id,user_id,plan)
      values(s.id,s.project_id,s.user_id,p_plan) returning * into e;
  end if;
  return jsonb_build_object('submissionId',e.submission_id,'planDigest',e.plan_digest,'caseCount',24);
end $$;
revoke all on function public.prepare_submission_grading(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_submission_grading(uuid,uuid,jsonb) to service_role;

create function private.submission_grading_summary(p_submission_id uuid,p_user_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('version',1,'checkVersion',e.plan->>'checkVersion','planDigest',e.plan_digest,
    'sourceDigest',e.plan->>'sourceDigest','harnessDigest',e.plan->>'harnessDigest','runtimeDigest',e.plan->>'runtimeDigest',
    'caseCount',jsonb_array_length(e.plan->'cases'),'status',case when e.report is null then 'prepared' else 'complete' end,
    'passedCount',case when e.report is null then null else (select count(*) from jsonb_array_elements(e.report->'cases') c where c->'passed'='true'::jsonb) end,
    'compileFailure',e.report->'compileFailure','outcomes',coalesce((select jsonb_agg(
      case when c->>'failure' is not null then c->>'failure' when c->'passed'='true'::jsonb then 'passed' else 'wrong-answer' end order by n)
      from jsonb_array_elements(e.report->'cases') with ordinality t(c,n)),'[]'::jsonb),
    'createdAt',e.created_at,'completedAt',e.completed_at)
  from private.submission_grading e where e.submission_id=p_submission_id and e.user_id=p_user_id;
$$;
revoke all on function private.submission_grading_summary(uuid,uuid) from public,anon,authenticated;
grant execute on function private.submission_grading_summary(uuid,uuid) to service_role;

create function public.finish_submission_grading(p_user_id uuid,p_submission_id uuid,p_plan_digest text,p_report jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s public.activity_submissions%rowtype; e private.submission_grading%rowtype; result jsonb;
begin
  if p_user_id is null or p_submission_id is null or p_plan_digest is null
    or jsonb_typeof(p_report) is distinct from 'object' or p_report-array['compileFailure','cases']<>'{}'
    or not p_report ? 'compileFailure' or jsonb_typeof(p_report->'cases') is distinct from 'array'
    or octet_length(p_report::text)>131072 then raise exception 'INVALID_GRADING_REPORT'; end if;
  if (p_report->'compileFailure'<>'null'::jsonb and coalesce(p_report->>'compileFailure','') not in ('timeout','output-limit','execution-error','invalid-output'))
    or (p_report->'compileFailure'='null'::jsonb and jsonb_array_length(p_report->'cases')<>24)
    or (p_report->'compileFailure'<>'null'::jsonb and jsonb_array_length(p_report->'cases')<>0) then raise exception 'INVALID_GRADING_REPORT'; end if;
  for result in select value from jsonb_array_elements(p_report->'cases') loop
    if jsonb_typeof(result) is distinct from 'object' or result-array['output','failure','passed']<>'{}'
      or jsonb_typeof(result->'output') is distinct from 'string' or length(result->>'output')>8192
      or jsonb_typeof(result->'passed') is distinct from 'boolean' or not result ? 'failure'
      or (result->'failure'<>'null'::jsonb and coalesce(result->>'failure','') not in ('timeout','output-limit','execution-error','invalid-output'))
      or (result->'failure'<>'null'::jsonb and result->'passed'='true'::jsonb) then raise exception 'INVALID_GRADING_REPORT'; end if;
  end loop;
  select * into s from public.activity_submissions where id=p_submission_id and user_id=p_user_id;
  if not found then raise exception 'SUBMISSION_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.project_id::text,0));
  perform 1 from public.projects where id=s.project_id and user_id=p_user_id for key share;
  if not found then raise exception 'SUBMISSION_NOT_FOUND'; end if;
  select * into s from public.activity_submissions where id=p_submission_id and user_id=p_user_id for update;
  if not found then raise exception 'SUBMISSION_NOT_FOUND'; end if;
  select * into e from private.submission_grading where submission_id=s.id and project_id=s.project_id and user_id=p_user_id for update;
  if not found or e.plan_digest<>p_plan_digest then raise exception 'GRADING_PLAN_MISMATCH'; end if;
  if e.report is not null then
    if e.report<>p_report then raise exception 'GRADING_EVIDENCE_IMMUTABLE'; end if;
  else
    if s.state<>'pending' or s.expires_at<=now() then raise exception 'SUBMISSION_CLOSED'; end if;
    update private.submission_grading set report=p_report,completed_at=now() where submission_id=s.id;
  end if;
  return private.submission_grading_summary(s.id,p_user_id);
end $$;
revoke all on function public.finish_submission_grading(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.finish_submission_grading(uuid,uuid,text,jsonb) to service_role;

create function public.read_submission_grading_summary(p_user_id uuid,p_project_id uuid,p_submission_id uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
begin
  if not exists(select 1 from public.activity_submissions where id=p_submission_id and project_id=p_project_id and user_id=p_user_id) then raise exception 'SUBMISSION_NOT_FOUND'; end if;
  return private.submission_grading_summary(p_submission_id,p_user_id);
end $$;
revoke all on function public.read_submission_grading_summary(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_submission_grading_summary(uuid,uuid,uuid) to service_role;

-- Existing historical assessments stay intact. New trusted scores must match
-- the retained report; an application bug cannot save a score without evidence.
create function private.require_grading_evidence() returns trigger
language plpgsql security invoker set search_path='' as $$
declare summary jsonb; expected_score integer;
begin
  if new.submission_id is null or new.ai_assessed then return new; end if;
  summary:=private.submission_grading_summary(new.submission_id,new.user_id);
  if summary is null or summary->>'status'<>'complete' then raise exception 'GRADING_EVIDENCE_REQUIRED'; end if;
  expected_score:=100*(summary->>'passedCount')::integer/(summary->>'caseCount')::integer;
  if new.score<>expected_score or new.passed is distinct from (expected_score=100) or new.verification_kind<>'command' then raise exception 'GRADING_SCORE_MISMATCH'; end if;
  return new;
end $$;
revoke all on function private.require_grading_evidence() from public,anon,authenticated;
create trigger assessment_grading_evidence before insert on public.assessments for each row execute function private.require_grading_evidence();

-- Keep v2/v3 archive formats compatible: add a safe optional summary to each
-- existing submission record. Never export private cases or captured output.
do $migration$
declare definition text; old_fragment text := '''finishedAt'',s.finished_at)';
begin
  definition:=pg_get_functiondef('public.create_project_archive(uuid,uuid,uuid,jsonb)'::regprocedure);
  if position(old_fragment in definition)=0 then raise exception 'ARCHIVE_PROJECTION_CHANGED'; end if;
  execute replace(definition,old_fragment,'''finishedAt'',s.finished_at,''gradingSummary'',private.submission_grading_summary(s.id,s.user_id))');
end $migration$;
