-- Execution slots are acquired before any VM command is dispatched. Only the
-- trusted server can mutate them; user-visible records contain metadata only.
alter table public.command_audits drop constraint command_audits_status_check;
alter table public.command_audits add constraint command_audits_status_check
  check (status in ('starting','running','unknown','done','failed','cancelled','expired'));
alter table public.command_audits
  add column origin text not null default 'terminal' check (origin in ('terminal','ai','verification')),
  add column timeout_ms integer not null default 60000 check (timeout_ms between 1000 and 2700000),
  add column expires_at timestamptz not null default (now()+interval '45 minutes');
create unique index command_audits_request_idx on public.command_audits(user_id,request_id);
create unique index command_audits_command_idx on public.command_audits(sandbox_session_id,command_id) where command_id is not null;
create index command_audits_active_idx on public.command_audits(user_id,expires_at)
  where status in ('starting','running','unknown');

create function public.reserve_command_execution(
  p_user_id uuid, p_session_id uuid, p_request_id uuid, p_executable text,
  p_origin text, p_background boolean
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare s public.sandbox_sessions%rowtype; reservation uuid; timeout integer;
  recent_count integer; reset_time timestamptz;
begin
  if p_user_id is null or p_session_id is null or p_request_id is null
    or p_background is null or p_origin is null or p_origin not in ('terminal','ai','verification')
    or p_executable is null or p_executable !~ '^[a-zA-Z0-9._+-]{1,128}$'
    or (p_origin='verification' and p_background) then
    raise exception 'INVALID_COMMAND_RESERVATION' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text,3));
  select * into s from public.sandbox_sessions where id=p_session_id and user_id=p_user_id for key share;
  if not found then return jsonb_build_object('code','SANDBOX_NOT_FOUND'); end if;
  if s.status<>'running' or s.expires_at<=now()+interval '2 seconds' then
    return jsonb_build_object('code','SANDBOX_EXPIRED');
  end if;
  if exists(select 1 from public.command_audits where user_id=p_user_id and request_id=p_request_id) then
    return jsonb_build_object('code','COMMAND_ALREADY_RESERVED');
  end if;
  -- Never reclaim an uncertain command just because its launch HTTP request
  -- timed out. The slot remains occupied until VM expiry or confirmed cleanup.
  update public.command_audits c set status='expired',finished_at=now()
    where c.user_id=p_user_id and c.status in ('starting','running','unknown')
      and (c.expires_at<=now() or exists(select 1 from public.sandbox_sessions x
        where x.id=c.sandbox_session_id and x.user_id=c.user_id and x.status in ('stopped','expired','failed')));
  if (select count(*) from public.command_audits where user_id=p_user_id and status in ('starting','running','unknown'))>=3 then
    return jsonb_build_object('code','COMMAND_CONCURRENCY_LIMIT');
  end if;
  select count(*), min(created_at)+interval '60 seconds' into recent_count,reset_time
    from public.command_audits where user_id=p_user_id and created_at>now()-interval '60 seconds';
  if recent_count>=30 then
    return jsonb_build_object('code','COMMAND_RATE_LIMIT','reset_at',reset_time);
  end if;
  timeout := least(case when p_background then 2700000 else 60000 end,
    floor(extract(epoch from (s.expires_at-now()))*1000)::integer-1000);
  insert into public.command_audits(user_id,sandbox_session_id,request_id,executable,origin,background,status,timeout_ms,expires_at)
    values(p_user_id,s.id,p_request_id,p_executable,p_origin,p_background,'starting',timeout,s.expires_at)
    returning id into reservation;
  return jsonb_build_object('id',reservation,'timeout_ms',timeout,'remaining',29-recent_count,
    'reset_at',coalesce(reset_time,now()+interval '60 seconds'));
end $$;
revoke all on function public.reserve_command_execution(uuid,uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.reserve_command_execution(uuid,uuid,uuid,text,text,boolean) to service_role;

create function public.attach_command_execution(p_user_id uuid,p_reservation_id uuid,p_command_id text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_command_id is null or p_command_id !~ '^[a-zA-Z0-9_-]{1,128}$' then
    raise exception 'INVALID_COMMAND_ID' using errcode='22023';
  end if;
  update public.command_audits c set command_id=p_command_id,status='running'
    where c.id=p_reservation_id and c.user_id=p_user_id and c.status='starting' and c.expires_at>now()
      and exists(select 1 from public.sandbox_sessions s where s.id=c.sandbox_session_id and s.user_id=p_user_id and s.status='running' and s.expires_at>now());
  return found;
end $$;
revoke all on function public.attach_command_execution(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.attach_command_execution(uuid,uuid,text) to service_role;

create function public.finish_command_execution(p_user_id uuid,p_reservation_id uuid,p_status text,p_exit_code integer default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_status is null or p_status not in ('done','failed','cancelled','expired','unknown')
     or (p_status='done' and p_exit_code is null) then
    raise exception 'INVALID_COMMAND_OUTCOME' using errcode='22023';
  end if;
  update public.command_audits set status=p_status,exit_code=p_exit_code,
    finished_at=case when p_status='unknown' then null else now() end
    where id=p_reservation_id and user_id=p_user_id and status in ('starting','running','unknown');
  return found;
end $$;
revoke all on function public.finish_command_execution(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.finish_command_execution(uuid,uuid,text,integer) to service_role;
