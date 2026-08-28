-- Preserve old commands as raw; only new server-dispatched commands use the
-- byte-safe wire format. No command output or arguments are stored here.
alter table public.command_audits add column output_encoding text not null default 'raw'
  check (output_encoding in ('raw','base64-v1'));

-- Keep the original attachment RPC for older application deployments.
create function public.attach_encoded_command(p_user_id uuid,p_reservation_id uuid,p_command_id text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if p_command_id is null or p_command_id !~ '^[a-zA-Z0-9_-]{1,128}$' then
    raise exception 'INVALID_COMMAND_ID' using errcode='22023';
  end if;
  update public.command_audits c set command_id=p_command_id,status='running',output_encoding='base64-v1'
    where c.id=p_reservation_id and c.user_id=p_user_id and c.status='starting' and c.command_id is null and c.expires_at>now()
      and exists(select 1 from public.sandbox_sessions s where s.id=c.sandbox_session_id and s.user_id=p_user_id and s.status='running' and s.expires_at>now());
  return found;
end $$;
revoke all on function public.attach_encoded_command(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.attach_encoded_command(uuid,uuid,text) to service_role;
