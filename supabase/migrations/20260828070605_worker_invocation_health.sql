-- One bounded operational record per worker. This is invocation evidence,
-- not proof of automatic scheduler delivery or of an empty job backlog.
create table private.worker_invocation_health (
  worker_name text primary key check (worker_name in ('source-capture','sandbox-cleanup','archive-cleanup')),
  run_id uuid not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  outcome text not null check (outcome in ('running','succeeded','failed')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  check ((outcome = 'running' and finished_at is null) or (outcome <> 'running' and finished_at is not null and finished_at >= started_at)),
  check (outcome <> 'succeeded' or (last_success_at is not null and last_success_at = finished_at)),
  check (outcome <> 'failed' or (last_failure_at is not null and last_failure_at = finished_at))
);
alter table private.worker_invocation_health enable row level security;
revoke all on private.worker_invocation_health from public, anon, authenticated;
grant select, insert, update on private.worker_invocation_health to service_role;

create function public.begin_worker_invocation(p_worker_name text, p_run_id uuid)
returns boolean language plpgsql security invoker set search_path = ''
set statement_timeout = '3s' set lock_timeout = '1s' as $$
declare n integer;
begin
  if p_worker_name is null or p_worker_name not in ('source-capture','sandbox-cleanup','archive-cleanup') or p_run_id is null then
    raise exception 'Invalid worker invocation' using errcode = '22023';
  end if;
  insert into private.worker_invocation_health as h(worker_name,run_id,started_at,outcome)
  values(p_worker_name,p_run_id,statement_timestamp(),'running')
  on conflict(worker_name) do update set run_id=excluded.run_id,
    started_at=excluded.started_at,finished_at=null,outcome='running'
  where h.run_id<>excluded.run_id and h.started_at<excluded.started_at;
  get diagnostics n=row_count;
  return n=1;
end $$;

create function public.finish_worker_invocation(p_worker_name text, p_run_id uuid, p_succeeded boolean)
returns boolean language plpgsql security invoker set search_path = ''
set statement_timeout = '3s' set lock_timeout = '1s' as $$
declare n integer; completed timestamptz := clock_timestamp();
begin
  if p_worker_name is null or p_worker_name not in ('source-capture','sandbox-cleanup','archive-cleanup') or p_run_id is null or p_succeeded is null then
    raise exception 'Invalid worker completion' using errcode = '22023';
  end if;
  update private.worker_invocation_health set finished_at=completed,
    outcome=case when p_succeeded then 'succeeded' else 'failed' end,
    last_success_at=case when p_succeeded then completed else last_success_at end,
    last_failure_at=case when p_succeeded then last_failure_at else completed end
  where worker_name=p_worker_name and run_id=p_run_id and outcome='running';
  get diagnostics n=row_count;
  return n=1;
end $$;

create function public.read_worker_invocation_health()
returns table(worker_name text,started_at timestamptz,finished_at timestamptz,
  outcome text,last_success_at timestamptz,last_failure_at timestamptz,checked_at timestamptz)
language sql stable security invoker set search_path = '' set statement_timeout = '3s' as $$
  select workers.name,h.started_at,h.finished_at,h.outcome,h.last_success_at,h.last_failure_at,statement_timestamp()
  from (values('source-capture'),('sandbox-cleanup'),('archive-cleanup')) as workers(name)
  left join private.worker_invocation_health h on h.worker_name=workers.name;
$$;

revoke all on function public.begin_worker_invocation(text,uuid) from public, anon, authenticated;
revoke all on function public.finish_worker_invocation(text,uuid,boolean) from public, anon, authenticated;
revoke all on function public.read_worker_invocation_health() from public, anon, authenticated;
grant execute on function public.begin_worker_invocation(text,uuid) to service_role;
grant execute on function public.finish_worker_invocation(text,uuid,boolean) to service_role;
grant execute on function public.read_worker_invocation_health() to service_role;
