-- Shutdowns use the existing durable/fair queue, without inventing a learner
-- command audit. Existing command IDs, source receipts and review copies survive.
alter table public.source_capture_jobs
  add column purpose text not null default 'command' check(purpose in ('command','shutdown')),
  add column command_audit_id uuid,
  add column quiesced_at timestamptz;
update public.source_capture_jobs set command_audit_id=id;
alter table public.source_capture_jobs drop constraint source_capture_jobs_id_sandbox_session_id_user_id_fkey;
alter table public.source_capture_jobs add constraint source_capture_command_owner_fk
  foreign key(command_audit_id,sandbox_session_id,user_id) references public.command_audits(id,sandbox_session_id,user_id) on delete cascade;
alter table public.source_capture_jobs add constraint source_capture_purpose_check
  check((purpose='command' and command_audit_id is not null and command_audit_id=id and quiesced_at is null)
    or (purpose='shutdown' and command_audit_id is null));
create index source_capture_command_owner_idx on public.source_capture_jobs(command_audit_id,sandbox_session_id,user_id);
create unique index source_capture_one_shutdown_idx on public.source_capture_jobs(sandbox_session_id) where purpose='shutdown';

create or replace function private.enqueue_command_capture() returns trigger
language plpgsql security invoker set search_path='' as $$
declare project uuid; baseline jsonb;
begin
  select project_id into strict project from public.sandbox_sessions where id=new.sandbox_session_id and user_id=new.user_id;
  perform pg_advisory_xact_lock(hashtextextended(project::text,0));
  perform 1 from public.projects where id=project and user_id=new.user_id for key share;
  if not found then raise exception 'PROJECT_NOT_FOUND'; end if;
  if (select count(*) from public.source_capture_conflicts where project_id=project and resolved_at is null)>=400 then
    raise exception 'SOURCE_REVIEW_REQUIRED' using errcode='P0001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('path',path,'revision',revision,
    'digest',encode(sha256(convert_to(content,'UTF8')),'hex')) order by path),'[]')
    into baseline from public.source_files where project_id=project and user_id=new.user_id and not deleted and private.safe_capture_path(path);
  insert into public.source_capture_jobs(id,command_audit_id,user_id,project_id,sandbox_session_id,baseline)
    values(new.id,new.id,new.user_id,project,new.sandbox_session_id,baseline);
  return new;
end $$;
revoke all on function private.enqueue_command_capture() from public,anon,authenticated;

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
      order by case when purpose='shutdown' then 0 else 1 end,available_at,id for update skip locked limit 1;
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
    select * into c from public.command_audits where id=job.command_audit_id and user_id=job.user_id;
    return to_jsonb(job)||jsonb_build_object('sandbox_id',s.sandbox_id,'sandbox_status',s.status,
      'expires_at',s.expires_at,'command_id',c.command_id,'command_status',coalesce(c.status,'done'));
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
  if job.purpose='shutdown' then raise exception 'SHUTDOWN_SETTLEMENT_REQUIRED'; end if;
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


-- Reservation lock order: command-account -> project advisory -> project row ->
-- session -> job. No network work occurs inside these short transactions.
create function public.begin_sandbox_shutdown(p_user_id uuid,p_sandbox_id text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare s public.sandbox_sessions%rowtype; job public.source_capture_jobs%rowtype; project uuid; source_baseline jsonb;
begin
  select project_id into project from public.sandbox_sessions where sandbox_id=p_sandbox_id and user_id=p_user_id;
  if not found then raise exception 'SANDBOX_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,3));
  perform pg_advisory_xact_lock(hashtextextended(project::text,0));
  perform 1 from public.projects where id=project and user_id=p_user_id for key share;
  if not found then raise exception 'SANDBOX_NOT_FOUND'; end if;
  select * into s from public.sandbox_sessions where sandbox_id=p_sandbox_id and user_id=p_user_id for no key update;
  if not found then raise exception 'SANDBOX_NOT_FOUND'; end if;
  select * into job from public.source_capture_jobs where sandbox_session_id=s.id and purpose='shutdown' for update;
  if found then
    if job.state='incomplete' and s.status='stopping' and s.expires_at>clock_timestamp() then
      update public.source_capture_jobs set state=coalesce(retry_state,'capturing'),retry_state=null,
        failures=0,failure_code=null,available_at=clock_timestamp(),updated_at=clock_timestamp() where id=job.id;
    end if;
    return job.id;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('path',path,'revision',revision,
    'digest',encode(sha256(convert_to(content,'UTF8')),'hex')) order by path),'[]')
    into source_baseline from public.source_files where project_id=project and user_id=p_user_id and not deleted and private.safe_capture_path(path);
  insert into public.source_capture_jobs(id,user_id,project_id,sandbox_session_id,purpose,baseline,state,failure_code)
    values(gen_random_uuid(),p_user_id,project,s.id,'shutdown',source_baseline,
      case when s.status in ('stopped','expired','failed') or s.expires_at<=clock_timestamp() then 'expired' else 'queued' end,
      case when s.status in ('stopped','expired','failed') or s.expires_at<=clock_timestamp() then 'sandbox_expired' else null end)
    returning * into job;
  update public.sandbox_sessions set status=case when job.state='expired' then 'expired' else 'stopping' end,
    preview_origin=null,updated_at=clock_timestamp() where id=s.id;
  return job.id;
end $$;
revoke all on function public.begin_sandbox_shutdown(uuid,text) from public,anon,authenticated;
grant execute on function public.begin_sandbox_shutdown(uuid,text) to service_role;

-- Reconciliation may mark a shutdown snapshot final only after the VM boundary
-- was closed. The unchanged CAS/conflict protocol persists all supported source.
create function private.guard_shutdown_capture() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.purpose='shutdown' and new.state='acknowledging' and
    (new.quiesced_at is null or not new.capture_terminal) then raise exception 'SHUTDOWN_NOT_QUIESCED'; end if;
  return new;
end $$;
revoke all on function private.guard_shutdown_capture() from public,anon,authenticated;
create trigger guard_shutdown_capture before update on public.source_capture_jobs
  for each row execute function private.guard_shutdown_capture();

create function public.advance_sandbox_shutdown(p_job_id uuid,p_lease_token uuid,p_action text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare job public.source_capture_jobs%rowtype; s public.sandbox_sessions%rowtype; project uuid; paused boolean; saved boolean;
begin
  if p_action is null or p_action not in ('quiesced','ready','stopped','expired','retry','rescan','incomplete') then
    raise exception 'INVALID_SHUTDOWN_ACTION'; end if;
  select project_id into project from public.source_capture_jobs where id=p_job_id and purpose='shutdown';
  if not found then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(project::text,0));
  perform 1 from public.projects where id=project for key share;
  select s0.* into s from public.sandbox_sessions s0 join public.source_capture_jobs j on j.sandbox_session_id=s0.id
    where j.id=p_job_id for no key update of s0;
  select * into job from public.source_capture_jobs where id=p_job_id for update;
  if not found or p_lease_token is null or job.lease_token is distinct from p_lease_token
    or job.lease_until<=clock_timestamp() or job.state not in ('capturing','acknowledging') then return false; end if;
  saved:=job.state='acknowledging' and job.capture_complete and job.capture_terminal and job.quiesced_at is not null;
  if p_action in ('ready','stopped') and not saved then raise exception 'SHUTDOWN_SOURCE_NOT_SAVED'; end if;
  if p_action='ready' then
    return s.status='stopping' and job.lease_until>clock_timestamp()+interval '15 seconds';
  end if;
  if p_action='quiesced' then
    if s.status<>'stopping' then return false; end if;
    update public.source_capture_jobs set quiesced_at=coalesce(quiesced_at,clock_timestamp()),updated_at=clock_timestamp() where id=job.id;
    update public.command_audits set status='cancelled',finished_at=clock_timestamp()
      where sandbox_session_id=s.id and user_id=job.user_id and status in ('starting','running','unknown');
    return true;
  end if;
  if p_action in ('stopped','expired') then
    update public.sandbox_sessions set status=case when p_action='stopped' then 'stopped' else 'expired' end,
      preview_origin=null,updated_at=clock_timestamp() where id=s.id;
  end if;
  paused:=p_action='incomplete' or (p_action='retry' and job.failures+1>=12);
  update public.source_capture_jobs set
    state=case when p_action='stopped' or (p_action='expired' and saved) then case when job.has_conflicts then 'conflicted' else 'done' end
      when p_action='expired' then 'expired' when paused then 'incomplete'
      when p_action='rescan' then 'capturing' else job.state end,
    retry_state=case when paused then case when p_action='incomplete' then 'capturing' else job.state end else null end,
    failures=case when paused then 12 when p_action='retry' then job.failures+1 else 0 end,
    failure_code=case when p_action='expired' and not saved then 'sandbox_expired'
      when p_action='retry' then 'capture_failed' when p_action='incomplete' then 'incomplete_source'
      when p_action='rescan' then 'workspace_changed' else job.failure_code end,
    available_at=clock_timestamp()+make_interval(secs=>case when p_action='retry' then least(60,power(2,least(job.failures+1,6))::integer) else 0 end),
    lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=job.id;
  return true;
end $$;
revoke all on function public.advance_sandbox_shutdown(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.advance_sandbox_shutdown(uuid,uuid,text) to service_role;
