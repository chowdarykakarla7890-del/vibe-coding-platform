-- Server-only sandbox reservations serialize quotas across application instances.
create function public.reserve_sandbox_session(p_user_id uuid, p_project_id uuid, p_ports integer[])
returns uuid language plpgsql security invoker set search_path = '' as $$
declare reservation_id uuid;
begin
  if cardinality(p_ports) not between 1 and 4 or array_position(p_ports,null) is not null
     or not (1024 <= all(p_ports) and 65535 >= all(p_ports)) then
    raise exception 'INVALID_PORTS' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 1));
  perform 1 from public.projects where id=p_project_id and user_id=p_user_id for update;
  if not found then raise exception 'PROJECT_NOT_FOUND' using errcode='P0001'; end if;
  update public.sandbox_sessions set status='expired', updated_at=now()
    where user_id=p_user_id and status in ('creating','running','stopping') and expires_at<=now();
  if exists(select 1 from public.sandbox_sessions where project_id=p_project_id and status in ('creating','running','stopping')) then
    raise exception 'PROJECT_SANDBOX_ACTIVE' using errcode='P0001';
  end if;
  if (select count(*) from public.sandbox_sessions where user_id=p_user_id and status in ('creating','running','stopping'))>=2 then
    raise exception 'SANDBOX_QUOTA' using errcode='P0001';
  end if;
  insert into public.sandbox_sessions(user_id,project_id,ports,status,expires_at)
    values(p_user_id,p_project_id,p_ports,'creating',now()+interval '2 minutes')
    returning id into reservation_id;
  return reservation_id;
end $$;
revoke all on function public.reserve_sandbox_session(uuid,uuid,integer[]) from public,anon,authenticated;
grant execute on function public.reserve_sandbox_session(uuid,uuid,integer[]) to service_role;
