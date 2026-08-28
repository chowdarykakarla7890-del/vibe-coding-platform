-- A capture job is committed with the command reservation, before VM dispatch.
-- Only server workers may lease or mutate jobs. Browser reads remain owner-only.
alter table public.command_audits add constraint command_audits_capture_owner_key unique(id,sandbox_session_id,user_id);
alter table public.sandbox_sessions add constraint sandbox_sessions_capture_owner_key unique(id,project_id,user_id);

create table public.source_capture_jobs (
  id uuid primary key,
  user_id uuid not null,
  project_id uuid not null,
  sandbox_session_id uuid not null,
  state text not null default 'queued' check(state in ('queued','capturing','acknowledging','done','conflicted','incomplete','expired')),
  baseline jsonb not null check(jsonb_typeof(baseline)='array' and jsonb_array_length(baseline)<=200),
  acknowledgements jsonb not null default '[]' check(jsonb_typeof(acknowledgements)='array' and jsonb_array_length(acknowledgements)<=400),
  capture_digest text check(capture_digest ~ '^[a-f0-9]{64}$'),
  capture_complete boolean not null default false,
  capture_terminal boolean not null default false,
  has_conflicts boolean not null default false,
  attempts integer not null default 0 check(attempts>=0),
  failures integer not null default 0 check(failures>=0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  failure_code text check(failure_code in ('capture_failed','workspace_changed','sandbox_expired','incomplete_source','source_conflict')),
  check((lease_token is null)=(lease_until is null)),
  foreign key(id,sandbox_session_id,user_id) references public.command_audits(id,sandbox_session_id,user_id) on delete cascade,
  foreign key(sandbox_session_id,project_id,user_id) references public.sandbox_sessions(id,project_id,user_id) on delete cascade,
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete cascade,
  unique(id,project_id,user_id)
);
create index source_capture_jobs_due_idx on public.source_capture_jobs(available_at,lease_until)
  where state in ('queued','capturing','acknowledging');
create index source_capture_jobs_project_idx on public.source_capture_jobs(project_id,user_id);
create index source_capture_jobs_session_idx on public.source_capture_jobs(sandbox_session_id,project_id,user_id);
alter table public.source_capture_jobs enable row level security;
revoke all on public.source_capture_jobs from public,anon,authenticated;
grant select on public.source_capture_jobs to authenticated;
grant all on public.source_capture_jobs to service_role;
create policy own_capture_jobs on public.source_capture_jobs for select to authenticated using((select auth.uid())=user_id);

create function private.safe_capture_path(path text) returns boolean
language sql immutable security invoker set search_path='' as $$
  select path is not null and char_length(path) between 1 and 240
    and path not like '/%' and path not like '%/' and path not like '%//%'
    and position(chr(92) in path)=0 and path !~ '[[:cntrl:]]'
    and path !~ '(^|/)[.][.]?(/|$)' and path !~ '(^|/)[.]codetutor-'
    and path !~ '(^|/)([.]aws|[.]cache|[.]config|[.]git|[.]gnupg|[.]next|[.]ssh|[.]turbo|build|coverage|dist|node_modules|out)(/|$)'
    and (path !~ '(^|/)[.]env([.]|$)' or path ~ '(^|/)[.]env[.]example$')
    and path !~* '[.](7z|avi|bin|bmp|class|db|dll|dmg|doc|docx|eot|exe|gif|gz|ico|jar|jpeg|jpg|lockb|mov|mp3|mp4|o|otf|pdf|png|so|sqlite|tar|ttf|p12|pem|pfx|key|wav|webm|webp|woff|woff2|xls|xlsx|zip)$';
$$;
revoke all on function private.safe_capture_path(text) from public,anon,authenticated;
grant execute on function private.safe_capture_path(text) to service_role;

create table public.source_capture_conflicts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  project_id uuid not null,
  capture_job_id uuid not null,
  path text not null check(private.safe_capture_path(path)),
  base_revision integer check(base_revision>=0),
  base_digest text check(base_digest ~ '^[a-f0-9]{64}$'),
  captured_content text check(octet_length(captured_content)<=262144),
  captured_digest text check(captured_digest ~ '^[a-f0-9]{64}$'),
  saved_revision integer not null check(saved_revision>=0),
  saved_content text check(octet_length(saved_content)<=262144),
  fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
  reason text not null check(reason in ('revision_conflict','uncertain_baseline','batch_conflict','source_limit','path_conflict')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check((captured_content is null)=(captured_digest is null)),
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete cascade,
  foreign key(capture_job_id,project_id,user_id) references public.source_capture_jobs(id,project_id,user_id) on delete cascade
);
create unique index source_capture_conflicts_pending_idx on public.source_capture_conflicts(project_id,path,fingerprint) where resolved_at is null;
create index source_capture_conflicts_owner_idx on public.source_capture_conflicts(project_id,user_id,created_at);
create index source_capture_conflicts_job_idx on public.source_capture_conflicts(capture_job_id);
alter table public.source_capture_conflicts enable row level security;
revoke all on public.source_capture_conflicts from public,anon,authenticated;
grant select on public.source_capture_conflicts to authenticated;
grant all on public.source_capture_conflicts to service_role;
create policy own_capture_conflicts on public.source_capture_conflicts for select to authenticated using((select auth.uid())=user_id);

create function private.enqueue_command_capture() returns trigger
language plpgsql security invoker set search_path='' as $$
declare project uuid; baseline jsonb;
begin
  select project_id into strict project from public.sandbox_sessions where id=new.sandbox_session_id and user_id=new.user_id;
  perform pg_advisory_xact_lock(hashtextextended(project::text,0));
  perform 1 from public.projects where id=project and user_id=new.user_id for key share;
  if not found then raise exception 'PROJECT_NOT_FOUND'; end if;
  -- Do not launch more arbitrary mutations when unresolved copies fill storage.
  if (select count(*) from public.source_capture_conflicts where project_id=project and resolved_at is null)>=400 then
    raise exception 'SOURCE_REVIEW_REQUIRED' using errcode='P0001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('path',path,'revision',revision,
    'digest',encode(sha256(convert_to(content,'UTF8')),'hex')) order by path),'[]')
    into baseline from public.source_files where project_id=project and user_id=new.user_id and not deleted;
  insert into public.source_capture_jobs(id,user_id,project_id,sandbox_session_id,baseline)
    values(new.id,new.user_id,project,new.sandbox_session_id,baseline);
  return new;
end $$;
revoke all on function private.enqueue_command_capture() from public,anon,authenticated;
create trigger command_capture_before_dispatch after insert on public.command_audits
  for each row execute function private.enqueue_command_capture();

create function private.wake_finished_command_capture() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  update public.source_capture_jobs set available_at=least(available_at,now())
    where id=new.id and state in ('queued','capturing','acknowledging');
  return new;
end $$;
revoke all on function private.wake_finished_command_capture() from public,anon,authenticated;
create trigger wake_finished_command_capture after update of status on public.command_audits
  for each row when (new.status in ('done','failed','cancelled','expired') and old.status is distinct from new.status)
  execute function private.wake_finished_command_capture();

create function public.claim_source_capture(p_job_id uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job public.source_capture_jobs%rowtype; s public.sandbox_sessions%rowtype; c public.command_audits%rowtype;
begin
  select * into job from public.source_capture_jobs
    where state in ('queued','capturing','acknowledging') and available_at<=now()
      and (lease_until is null or lease_until<=now()) and (p_job_id is null or id=p_job_id)
    order by available_at,id for update skip locked limit 1;
  if not found then return null; end if;
  update public.source_capture_jobs set state=case when state='queued' then 'capturing' else state end,
    lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',attempts=attempts+1,updated_at=now()
    where id=job.id returning * into job;
  select * into strict s from public.sandbox_sessions where id=job.sandbox_session_id and user_id=job.user_id;
  select * into strict c from public.command_audits where id=job.id and user_id=job.user_id;
  return to_jsonb(job)||jsonb_build_object('sandbox_id',s.sandbox_id,'sandbox_status',s.status,
    'expires_at',s.expires_at,'command_id',c.command_id,'command_status',c.status);
end $$;
revoke all on function public.claim_source_capture(uuid) from public,anon,authenticated;
grant execute on function public.claim_source_capture(uuid) to service_role;

-- Called only with the digest-checked receipt from the fixed VM reader. Validate
-- again here so the privileged transaction never silently accepts malformed data.
create function private.validate_source_capture(p_capture jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare e jsonb; bytes bigint:=0; files integer:=0; complete boolean:=true; rev numeric;
begin
  if jsonb_typeof(p_capture->'entries') is distinct from 'array'
    or jsonb_typeof(p_capture->'complete') is distinct from 'boolean'
    or jsonb_typeof(p_capture->'totalBytes') is distinct from 'number' then
    raise exception 'INVALID_SOURCE_CAPTURE' using errcode='22023';
  end if;
  if jsonb_array_length(p_capture->'entries')>400 or
    (select count(distinct value->>'path') from jsonb_array_elements(p_capture->'entries'))<>jsonb_array_length(p_capture->'entries') then
    raise exception 'INVALID_SOURCE_CAPTURE' using errcode='22023';
  end if;
  for e in select value from jsonb_array_elements(p_capture->'entries') loop
    if jsonb_typeof(e->'path') is distinct from 'string' or not private.safe_capture_path(e->>'path')
      or jsonb_typeof(e->'pending') is distinct from 'boolean'
      or not(e ? 'baseRevision') or jsonb_typeof(e->'baseRevision') not in ('number','null')
      or not(e ? 'baseDigest') or jsonb_typeof(e->'baseDigest') not in ('string','null')
      or (e->>'baseDigest' is not null and e->>'baseDigest' !~ '^[a-f0-9]{64}$')
      or e->>'kind' is null or e->>'kind' not in ('file','missing','skipped') then
      raise exception 'INVALID_SOURCE_CAPTURE' using errcode='22023';
    end if;
    rev:=(e->>'baseRevision')::numeric;
    if (rev is not null and (rev<0 or rev>2147483647 or trunc(rev)<>rev))
      or (rev=0 and e->>'baseDigest' is not null)
      or (rev is null and (not (e->>'pending')::boolean or e->>'baseDigest' is not null)) then
      raise exception 'INVALID_SOURCE_CAPTURE' using errcode='22023';
    end if;
    if (e->>'pending')::boolean or e->>'kind'='skipped' then complete:=false; end if;
    if e->>'kind'='file' then
      if jsonb_typeof(e->'content') is distinct from 'string' or octet_length(e->>'content')>262144
        or e->>'digest' is distinct from encode(sha256(convert_to(e->>'content','UTF8')),'hex') then
        raise exception 'INVALID_SOURCE_CAPTURE' using errcode='22023';
      end if;
      files:=files+1; bytes:=bytes+octet_length(e->>'content');
    elsif e->>'kind'='skipped' and (e->>'reason' is null or e->>'reason' not in ('unsafe','binary','too-large')) then
      raise exception 'INVALID_SOURCE_CAPTURE' using errcode='22023';
    elsif e->>'kind'='missing' and (e ? 'content' or e ? 'digest') then
      raise exception 'INVALID_SOURCE_CAPTURE' using errcode='22023';
    end if;
  end loop;
  if files>200 or bytes>10485760 or bytes<>(p_capture->>'totalBytes')::numeric
    or complete<>(p_capture->>'complete')::boolean then
    raise exception 'INVALID_SOURCE_CAPTURE' using errcode='22023';
  end if;
end $$;
revoke all on function private.validate_source_capture(jsonb) from public,anon,authenticated;
grant execute on function private.validate_source_capture(jsonb) to service_role;

create function public.reconcile_source_capture(p_job_id uuid,p_lease_token uuid,p_capture jsonb,p_terminal boolean default false) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job public.source_capture_jobs%rowtype; project uuid; e jsonb; saved public.source_files%rowtype;
  changes jsonb:='[]'; writes jsonb:='[]'; acks jsonb:='[]'; receipts jsonb;
  conflict boolean:=false; reason text:='revision_conflict'; digest text; saved_digest text; receipt_digest text;
begin
  select project_id into project from public.source_capture_jobs where id=p_job_id;
  if not found then raise exception 'CAPTURE_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended(project::text,0));
  perform 1 from public.projects where id=project for key share;
  select * into job from public.source_capture_jobs where id=p_job_id for update;
  if not found then raise exception 'CAPTURE_NOT_FOUND'; end if;
  if p_lease_token is null or job.lease_token is distinct from p_lease_token or job.lease_until<=now()
    or job.state not in ('capturing','acknowledging') then raise exception 'CAPTURE_LEASE_LOST'; end if;
  perform private.validate_source_capture(p_capture);
  if p_terminal is null or (p_terminal and exists(select 1 from public.command_audits where id=job.id and status in ('starting','running','unknown'))) then
    raise exception 'CAPTURE_COMMAND_RUNNING';
  end if;
  receipt_digest:=encode(sha256(convert_to(p_capture::text,'UTF8')),'hex');
  if job.state='acknowledging' then
    if job.capture_digest is distinct from receipt_digest then raise exception 'CAPTURE_ALREADY_RECONCILED'; end if;
    return jsonb_build_object('acknowledgements',job.acknowledgements,'conflicted',job.has_conflicts,'complete',job.capture_complete);
  end if;
  for e in select value from jsonb_array_elements(p_capture->'entries') loop
    if e->>'kind'='skipped' then continue; end if;
    digest:=case when e->>'kind'='file' then e->>'digest' else null end;
    -- An unchanged old VM copy is not evidence that a newer DB save is wrong.
    if not (e->>'pending')::boolean and digest is not distinct from e->>'baseDigest' then continue; end if;
    -- Missing with no confirmed baseline is uncertainty, not proof of deletion.
    if e->>'kind'='missing' and e->>'baseDigest' is null then continue; end if;
    changes:=changes||jsonb_build_array(e);
    select * into saved from public.source_files where project_id=project and user_id=job.user_id and path=e->>'path';
    saved_digest:=case when saved.revision is null or saved.deleted then null else encode(sha256(convert_to(saved.content,'UTF8')),'hex') end;
    if (e->>'pending')::boolean or e->>'baseRevision' is null then
      conflict:=true; reason:='uncertain_baseline';
    elsif not (
      (coalesce(saved.revision,0)=(e->>'baseRevision')::integer and saved_digest is not distinct from e->>'baseDigest')
      or (coalesce(saved.revision,0)>=(e->>'baseRevision')::integer and saved_digest is not distinct from digest)
    ) then conflict:=true;
    end if;
    writes:=writes||jsonb_build_array(jsonb_build_object('path',e->>'path','content',coalesce(e->>'content',''),
      'revision',coalesce((e->>'baseRevision')::integer,0),'deleted',e->>'kind'='missing'));
  end loop;
  if not conflict and jsonb_array_length(writes)>0 then
    begin
      receipts:=public.save_source_revision_batch(job.user_id,project,writes,false);
    exception
      when check_violation then conflict:=true; reason:='source_limit';
      when raise_exception then
        if sqlerrm='SOURCE_PATH_CONFLICT' then conflict:=true; reason:='path_conflict';
        elsif sqlerrm in ('SOURCE_CONFLICT','SOURCE_REVISION_EXHAUSTED') then conflict:=true; reason:='batch_conflict';
        else raise; end if;
    end;
  end if;
  if conflict then
    -- Preserve the entire changed batch if any entry conflicts (atomic renames).
    -- Never let successful siblings hide an unresolved overwrite/deletion.
    for e in select value from jsonb_array_elements(changes) loop
      select * into saved from public.source_files where project_id=project and user_id=job.user_id and path=e->>'path';
      insert into public.source_capture_conflicts(user_id,project_id,capture_job_id,path,base_revision,base_digest,
        captured_content,captured_digest,saved_revision,saved_content,fingerprint,reason)
      values(job.user_id,project,job.id,e->>'path',(e->>'baseRevision')::integer,e->>'baseDigest',
        case when e->>'kind'='file' then e->>'content' else null end,
        case when e->>'kind'='file' then e->>'digest' else null end,
        coalesce(saved.revision,0),case when saved.deleted then null else saved.content end,
        encode(sha256(convert_to(jsonb_build_array(job.sandbox_session_id,e->>'baseRevision',e->>'baseDigest',e->>'kind',e->>'digest')::text,'UTF8')),'hex'),reason)
      on conflict(project_id,path,fingerprint) where resolved_at is null do nothing;
    end loop;
    if (select count(*)>400 or coalesce(sum(coalesce(octet_length(captured_content),0)+coalesce(octet_length(saved_content),0)),0)>20971520
      from public.source_capture_conflicts where project_id=project and resolved_at is null) then
      raise exception 'SOURCE_REVIEW_REQUIRED';
    end if;
  elsif receipts is not null then
    select coalesce(jsonb_agg(jsonb_build_object('path',r.value->>'path','revision',(r.value->>'revision')::integer,
      'digest',e.value->>'digest') order by r.value->>'path'),'[]') into acks
      from jsonb_array_elements(receipts) r(value) join jsonb_array_elements(changes) e(value) on r.value->>'path'=e.value->>'path';
  end if;
  update public.source_capture_jobs set state='acknowledging',acknowledgements=acks,capture_digest=receipt_digest,
    capture_complete=(p_capture->>'complete')::boolean,capture_terminal=p_terminal,has_conflicts=conflict,captured_at=now(),updated_at=now(),failures=0,
    failure_code=case when conflict then 'source_conflict' when not (p_capture->>'complete')::boolean then 'incomplete_source' else null end
    where id=job.id;
  return jsonb_build_object('acknowledgements',acks,'conflicted',conflict,'complete',(p_capture->>'complete')::boolean);
end $$;
revoke all on function public.reconcile_source_capture(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.reconcile_source_capture(uuid,uuid,jsonb,boolean) to service_role;

create function public.settle_source_capture(p_job_id uuid,p_lease_token uuid,p_action text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare job public.source_capture_jobs%rowtype; running boolean;
begin
  if p_action is null or p_action not in ('acknowledged','rescan','retry','expired') then raise exception 'INVALID_CAPTURE_OUTCOME'; end if;
  select * into job from public.source_capture_jobs where id=p_job_id for update;
  if not found or p_lease_token is null or job.lease_token is distinct from p_lease_token or job.lease_until<=now() then return false; end if;
  if p_action='acknowledged' and job.state<>'acknowledging' then raise exception 'CAPTURE_NOT_RECONCILED'; end if;
  select c.status in ('starting','running','unknown') and s.status='running' and s.expires_at>now() into running
    from public.command_audits c join public.sandbox_sessions s on s.id=c.sandbox_session_id and s.user_id=c.user_id where c.id=job.id;
  update public.source_capture_jobs set
    state=case when p_action='expired' then 'expired'
      when p_action='rescan' then 'queued'
      when p_action='retry' then job.state
      when running or not job.capture_terminal then 'queued' when job.has_conflicts then 'conflicted'
      when not job.capture_complete then 'incomplete' else 'done' end,
    acknowledgements=case when p_action in ('acknowledged','rescan') then '[]'::jsonb else job.acknowledgements end,
    available_at=now()+make_interval(secs=>case when p_action='retry' then least(60,power(2,least(job.failures+1,6))::integer) else 30 end),
    failures=case when p_action='retry' then failures+1 else 0 end,
    failure_code=case when p_action='expired' then 'sandbox_expired' when p_action='retry' then 'capture_failed'
      when p_action='rescan' then 'workspace_changed' else failure_code end,
    lease_token=null,lease_until=null,updated_at=now() where id=job.id;
  return true;
end $$;
revoke all on function public.settle_source_capture(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.settle_source_capture(uuid,uuid,text) to service_role;
