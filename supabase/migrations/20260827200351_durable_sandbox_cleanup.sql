-- Operational tombstones intentionally survive project/account cascades. No
-- source, prompts, credentials, names supplied by clients, or output is stored.
create table public.sandbox_cleanup_jobs (
  id uuid primary key,
  user_id uuid not null,
  project_id uuid not null,
  sandbox_name text not null check (sandbox_name ~ '^[a-zA-Z0-9_-]{1,128}$'),
  state text not null check (state in ('armed','attached','pending','leased','complete')),
  reason text not null check (reason in ('startup','deleted')),
  outcome text check (outcome in ('stopped','unavailable','not_started')),
  next_attempt_at timestamptz not null default now(),
  observe_until timestamptz not null,
  attempts integer not null default 0 check (attempts between 0 and 1000000),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state='leased') = (lease_token is not null and lease_until is not null))
);
alter table public.sandbox_cleanup_jobs enable row level security;
revoke all on public.sandbox_cleanup_jobs from public,anon,authenticated;
grant all on public.sandbox_cleanup_jobs to service_role;
create index sandbox_cleanup_due_idx on public.sandbox_cleanup_jobs(next_attempt_at,id)
  where state in ('armed','pending','leased');
create index sandbox_cleanup_owner_idx on public.sandbox_cleanup_jobs(user_id,project_id)
  where state in ('armed','pending','leased');

-- Trigger ownership is necessary for authenticated project/account cascade
-- deletion to enqueue operational cleanup. It is not a callable browser RPC.
-- Names/ownership come exclusively from the server-controlled session row.
create function private.track_sandbox_cleanup()
returns trigger language plpgsql security definer set search_path='' as $$
declare job public.sandbox_cleanup_jobs%rowtype;
begin
  if tg_op='INSERT' then
    insert into public.sandbox_cleanup_jobs(id,user_id,project_id,sandbox_name,state,reason,next_attempt_at,observe_until)
      values(new.id,new.user_id,new.project_id,coalesce(new.sandbox_id,'codetutor-'||new.id::text),
        case when new.status='creating' then 'armed' else 'attached' end,'startup',
        now()+interval '3 minutes',greatest(new.expires_at+interval '3 minutes',now()+interval '50 minutes'));
    return new;
  end if;
  select * into job from public.sandbox_cleanup_jobs where id=old.id for update;
  if tg_op='DELETE' then
    insert into public.sandbox_cleanup_jobs(id,user_id,project_id,sandbox_name,state,reason,next_attempt_at,observe_until)
      values(old.id,old.user_id,old.project_id,coalesce(old.sandbox_id,'codetutor-'||old.id::text),
        'pending','deleted',now(),greatest(old.expires_at+interval '3 minutes',now()+interval '3 minutes'))
      on conflict(id) do update set
        state=case when sandbox_cleanup_jobs.state in ('leased','complete') then sandbox_cleanup_jobs.state else 'pending' end,
        reason='deleted',next_attempt_at=now(),updated_at=now();
    return old;
  end if;
  if (new.id,new.user_id,new.project_id) is distinct from (old.id,old.user_id,old.project_id) then
    raise exception 'SANDBOX_OWNERSHIP_IMMUTABLE' using errcode='23514';
  end if;
  if old.sandbox_id is not null and new.sandbox_id is distinct from old.sandbox_id then
    raise exception 'SANDBOX_HANDLE_IMMUTABLE' using errcode='23514';
  end if;
  if old.status='creating' and new.status='running' then
    if job.id is null or job.state<>'armed' or job.next_attempt_at<=now() then
      raise exception 'SANDBOX_START_EXPIRED' using errcode='P0001';
    end if;
    update public.sandbox_cleanup_jobs set state='attached',sandbox_name=coalesce(new.sandbox_id,job.sandbox_name),
      observe_until=greatest(observe_until,new.expires_at+interval '3 minutes'),updated_at=now() where id=old.id;
  elsif old.status='creating' and new.status in ('failed','expired','stopped') or new.status='failed' and old.status='running' then
    update public.sandbox_cleanup_jobs set
      state=case when state in ('leased','complete') then state else 'pending' end,
      next_attempt_at=now(),updated_at=now() where id=old.id;
  end if;
  return new;
end $$;
revoke all on function private.track_sandbox_cleanup() from public,anon,authenticated;
create trigger sandbox_cleanup_on_insert after insert on public.sandbox_sessions
  for each row execute function private.track_sandbox_cleanup();
create trigger sandbox_cleanup_on_change before update or delete on public.sandbox_sessions
  for each row execute function private.track_sandbox_cleanup();

-- Existing sessions remain attached, unless a creation was already unfinished.
-- No existing VM is stopped or resumed by applying this migration.
insert into public.sandbox_cleanup_jobs(id,user_id,project_id,sandbox_name,state,reason,next_attempt_at,observe_until)
  select id,user_id,project_id,coalesce(sandbox_id,'codetutor-'||id::text),
    case when status='creating' then 'armed' else 'attached' end,'startup',
    greatest(created_at+interval '3 minutes',now()),greatest(expires_at+interval '3 minutes',now()+interval '50 minutes')
  from public.sandbox_sessions;

create or replace function public.reserve_sandbox_session(p_user_id uuid,p_project_id uuid,p_ports integer[])
returns uuid language plpgsql security invoker set search_path='' as $$
declare reservation_id uuid;
begin
  if p_user_id is null or p_project_id is null or p_ports is null or cardinality(p_ports) not between 1 and 4
    or array_position(p_ports,null) is not null or not(1024<=all(p_ports) and 65535>=all(p_ports)) then
    raise exception 'INVALID_PORTS' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text,1));
  perform 1 from public.projects where id=p_project_id and user_id=p_user_id for update;
  if not found then raise exception 'PROJECT_NOT_FOUND' using errcode='P0001'; end if;
  update public.sandbox_sessions set status='expired',updated_at=now()
    where user_id=p_user_id and status in ('creating','running','stopping') and expires_at<=now();
  if exists(select 1 from public.sandbox_sessions where project_id=p_project_id and status in ('creating','running','stopping'))
    or exists(select 1 from public.sandbox_cleanup_jobs where project_id=p_project_id and user_id=p_user_id and state in ('armed','pending','leased')) then
    raise exception 'PROJECT_SANDBOX_ACTIVE' using errcode='P0001';
  end if;
  if (select count(*) from (
    select id from public.sandbox_sessions where user_id=p_user_id and status in ('creating','running','stopping')
    union select id from public.sandbox_cleanup_jobs where user_id=p_user_id and state in ('armed','pending','leased')
  ) active)>=2 then raise exception 'SANDBOX_QUOTA' using errcode='P0001'; end if;
  insert into public.sandbox_sessions(user_id,project_id,ports,status,expires_at)
    values(p_user_id,p_project_id,p_ports,'creating',now()+interval '3 minutes') returning id into reservation_id;
  return reservation_id;
end $$;

create function public.claim_sandbox_cleanup(p_job_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.sandbox_cleanup_jobs%rowtype;
begin
  select * into job from public.sandbox_cleanup_jobs
    where (p_job_id is null or id=p_job_id) and
      ((state in ('armed','pending') and next_attempt_at<=now()) or (state='leased' and lease_until<=now()))
    order by next_attempt_at,id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.sandbox_cleanup_jobs set state='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '40 seconds',
    attempts=least(attempts+1,1000000),updated_at=now() where id=job.id returning * into job;
  return jsonb_build_object('id',job.id,'sandbox_name',job.sandbox_name,'lease_token',job.lease_token);
end $$;

create function public.settle_sandbox_cleanup(p_job_id uuid,p_lease_token uuid,p_outcome text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare job public.sandbox_cleanup_jobs%rowtype; finished boolean;
begin
  if p_outcome is null or p_outcome not in ('stopped','unavailable','retry') then
    raise exception 'INVALID_CLEANUP_OUTCOME' using errcode='22023';
  end if;
  select * into job from public.sandbox_cleanup_jobs where id=p_job_id for update;
  if not found or job.state<>'leased' or job.lease_token is distinct from p_lease_token or job.lease_until<=now() then return false; end if;
  -- Early missing receipts remain pending for a conservative visibility window
  -- covering the maximum VM lifetime plus creation latency. Never assume one
  -- 404 immediately after a cancelled creation proves no VM can appear.
  finished:=p_outcome='stopped' or (p_outcome='unavailable' and now()>=job.observe_until);
  update public.sandbox_cleanup_jobs set state=case when finished then 'complete' else 'pending' end,
    outcome=case when finished then p_outcome else null end,lease_token=null,lease_until=null,
    next_attempt_at=now()+make_interval(secs=>least(300,15*power(2,least(job.attempts,5)))::int),updated_at=now()
    where id=job.id;
  return true;
end $$;

revoke all on function public.reserve_sandbox_session(uuid,uuid,integer[]),
  public.claim_sandbox_cleanup(uuid),public.settle_sandbox_cleanup(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_sandbox_session(uuid,uuid,integer[]),
  public.claim_sandbox_cleanup(uuid),public.settle_sandbox_cleanup(uuid,uuid,text) to service_role;
