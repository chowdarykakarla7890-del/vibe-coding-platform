-- Fair service across accounts, not across a global oldest-job backlog.
-- This ledger contains scheduling metadata only and is never browser-writable.
create table private.source_capture_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_claimed_at timestamptz not null default '-infinity'
);
alter table private.source_capture_accounts enable row level security;
revoke all on private.source_capture_accounts from public,anon,authenticated;
grant select,insert,update,delete on private.source_capture_accounts to service_role;
create policy server_only on private.source_capture_accounts for all to service_role using(true) with check(true);
create index source_capture_accounts_fair_idx on private.source_capture_accounts(last_claimed_at,user_id);
create index source_capture_jobs_owner_due_idx on public.source_capture_jobs(user_id,available_at,id)
  where state in ('queued','capturing','acknowledging');
create index source_capture_jobs_owner_lease_idx on public.source_capture_jobs(user_id,lease_until)
  where state in ('capturing','acknowledging') and lease_until is not null;

insert into private.source_capture_accounts(user_id) select distinct user_id from public.source_capture_jobs;
create function private.register_capture_account() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  insert into private.source_capture_accounts(user_id) values(new.user_id) on conflict do nothing;
  return new;
end $$;
revoke all on function private.register_capture_account() from public,anon,authenticated;
create trigger register_capture_account after insert on public.source_capture_jobs
  for each row execute function private.register_capture_account();

-- A paused acknowledgment retains its exact durable receipt. Retrying must not
-- reinterpret its source bytes as a new capture or clear conflict copies.
alter table public.source_capture_jobs add column retry_state text
  check(retry_state in ('queued','capturing','acknowledging'));
alter table public.source_capture_jobs add constraint source_capture_retry_checkpoint
  check(retry_state is null or (state='incomplete' and failures>=12));

create or replace function public.claim_source_capture(p_job_id uuid default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job public.source_capture_jobs%rowtype; s public.sandbox_sessions%rowtype; c public.command_audits%rowtype;
  owner uuid; failed integer; scan integer;
begin
  -- Skip a bounded number of poison/crash-loop jobs per RPC. No VM/network work
  -- occurs while these transaction locks are held. Lock order: account -> job.
  for scan in 1..10 loop
    select q.user_id into owner from private.source_capture_accounts q
      where exists(select 1 from public.source_capture_jobs j where j.user_id=q.user_id
        and j.state in ('queued','capturing','acknowledging') and j.available_at<=clock_timestamp()
        and (j.lease_until is null or j.lease_until<=clock_timestamp()) and (p_job_id is null or j.id=p_job_id))
      and not exists(select 1 from public.source_capture_jobs j where j.user_id=q.user_id
        and j.state in ('capturing','acknowledging') and j.lease_until>clock_timestamp())
      order by q.last_claimed_at,q.user_id for update of q skip locked limit 1;
    if not found then return null; end if;
    -- A contender may have committed between the SELECT's snapshot and row
    -- lock. Recheck in a fresh statement while holding the account lock.
    if exists(select 1 from public.source_capture_jobs where user_id=owner
      and state in ('capturing','acknowledging') and lease_until>clock_timestamp()) then continue; end if;
    select * into job from public.source_capture_jobs where user_id=owner
      and state in ('queued','capturing','acknowledging') and available_at<=clock_timestamp()
      and (lease_until is null or lease_until<=clock_timestamp()) and (p_job_id is null or id=p_job_id)
      order by available_at,id for update skip locked limit 1;
    if not found then return null; end if;
    update private.source_capture_accounts set last_claimed_at=clock_timestamp() where user_id=owner;
    failed:=job.failures+case when job.lease_until is not null then 1 else 0 end;
    if failed>=12 then
      update public.source_capture_jobs set state='incomplete',retry_state=job.state,failures=failed,
        failure_code='capture_failed',lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=job.id;
      continue;
    end if;
    update public.source_capture_jobs set state=case when state='queued' then 'capturing' else state end,
      failures=failed,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',
      attempts=attempts+1,updated_at=clock_timestamp() where id=job.id returning * into job;
    select * into strict s from public.sandbox_sessions where id=job.sandbox_session_id and user_id=job.user_id;
    select * into strict c from public.command_audits where id=job.id and user_id=job.user_id;
    return to_jsonb(job)||jsonb_build_object('sandbox_id',s.sandbox_id,'sandbox_status',s.status,
      'expires_at',s.expires_at,'command_id',c.command_id,'command_status',c.status);
  end loop;
  return null;
end $$;
revoke all on function public.claim_source_capture(uuid) from public,anon,authenticated;
grant execute on function public.claim_source_capture(uuid) to service_role;

create or replace function public.settle_source_capture(p_job_id uuid,p_lease_token uuid,p_action text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare job public.source_capture_jobs%rowtype; running boolean; paused boolean;
begin
  if p_action is null or p_action not in ('acknowledged','rescan','retry','expired') then raise exception 'INVALID_CAPTURE_OUTCOME'; end if;
  select * into job from public.source_capture_jobs where id=p_job_id for update;
  if not found or p_lease_token is null or job.lease_token is distinct from p_lease_token or job.lease_until<=clock_timestamp() then return false; end if;
  if p_action='acknowledged' and job.state<>'acknowledging' then raise exception 'CAPTURE_NOT_RECONCILED'; end if;
  select c.status in ('starting','running','unknown') and s.status='running' and s.expires_at>clock_timestamp() into running
    from public.command_audits c join public.sandbox_sessions s on s.id=c.sandbox_session_id and s.user_id=c.user_id where c.id=job.id;
  paused:=p_action='retry' and job.failures+1>=12;
  update public.source_capture_jobs set
    state=case when p_action='expired' then 'expired' when paused then 'incomplete'
      when p_action='rescan' then 'queued' when p_action='retry' then job.state
      when running or not job.capture_terminal then 'queued' when job.has_conflicts then 'conflicted'
      when not job.capture_complete then 'incomplete' else 'done' end,
    retry_state=case when paused then job.state else null end,
    acknowledgements=case when p_action in ('acknowledged','rescan') then '[]'::jsonb else job.acknowledgements end,
    available_at=clock_timestamp()+make_interval(secs=>case when p_action='retry' then least(60,power(2,least(job.failures+1,6))::integer) else 30 end),
    failures=case when p_action='retry' then failures+1 else 0 end,
    failure_code=case when p_action='expired' then 'sandbox_expired' when p_action='retry' then 'capture_failed'
      when p_action='rescan' then 'workspace_changed' else failure_code end,
    lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=job.id;
  return true;
end $$;
revoke all on function public.settle_source_capture(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.settle_source_capture(uuid,uuid,text) to service_role;

-- Explicit owner-authorized recovery, limited to ten paused jobs per request.
-- No sandbox is restarted or replaced, and completed/expired captures stay put.
create function public.retry_source_captures(p_user_id uuid,p_project_id uuid) returns integer
language plpgsql security invoker set search_path='' as $$
declare resumed integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,0));
  perform 1 from public.projects where id=p_project_id and user_id=p_user_id for key share;
  if not found then raise exception 'PROJECT_NOT_FOUND'; end if;
  if not exists(select 1 from public.sandbox_sessions where project_id=p_project_id and user_id=p_user_id
    and status='running' and expires_at>clock_timestamp()) then raise exception 'SANDBOX_EXPIRED'; end if;
  with ready as (
    select j.id from public.source_capture_jobs j join public.sandbox_sessions s on s.id=j.sandbox_session_id and s.user_id=j.user_id
      where j.project_id=p_project_id and j.user_id=p_user_id and j.state='incomplete' and j.retry_state is not null
        and s.status='running' and s.expires_at>clock_timestamp()
      order by j.updated_at,j.id for update of j skip locked limit 10
  )
  update public.source_capture_jobs j set state=j.retry_state,retry_state=null,failures=0,
    failure_code=null,available_at=clock_timestamp(),updated_at=clock_timestamp()
    from ready where j.id=ready.id;
  get diagnostics resumed=row_count;
  return resumed;
end $$;
revoke all on function public.retry_source_captures(uuid,uuid) from public,anon,authenticated;
grant execute on function public.retry_source_captures(uuid,uuid) to service_role;
