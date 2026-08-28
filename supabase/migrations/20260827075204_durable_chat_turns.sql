-- Ordered, server-owned conversation turns. Clients can read their own rows,
-- but only the trusted application can start or finalize a generation.
alter table public.messages add column ordinal bigint generated always as identity;
alter table public.messages add column reply_to text;
alter table public.messages add constraint messages_reply_to_fkey
  foreign key(project_id,reply_to) references public.messages(project_id,id) on delete cascade;
create index messages_reply_to_idx on public.messages(project_id,reply_to);
create index messages_project_ordinal_idx on public.messages(project_id,ordinal);
create unique index messages_one_pending_turn_idx on public.messages(project_id)
  where role='assistant' and status='pending';

create function public.begin_chat_turn(
  p_user_id uuid, p_project_id uuid, p_message_id text, p_parts jsonb,
  p_model_id text, p_request_id uuid, p_retry boolean default false
) returns text language plpgsql security invoker set search_path = '' as $$
declare user_message public.messages; assistant_message public.messages; new_id text;
begin
  if p_message_id is null or char_length(p_message_id) not between 1 and 128
     or jsonb_typeof(p_parts) is distinct from 'array' or jsonb_array_length(p_parts) not between 1 and 16
     or octet_length(p_parts::text)>200000 or p_request_id is null then
    raise exception 'INVALID_MESSAGE' using errcode='22023';
  end if;
  perform 1 from public.projects where id=p_project_id and user_id=p_user_id for update;
  if not found then raise exception 'PROJECT_NOT_FOUND' using errcode='P0001'; end if;
  update public.messages set status='interrupted',updated_at=now()
    where project_id=p_project_id and user_id=p_user_id and role='assistant'
      and status='pending' and updated_at < now()-interval '2 minutes';
  if exists(select 1 from public.messages where project_id=p_project_id and status='pending') then
    raise exception 'CHAT_BUSY' using errcode='P0001';
  end if;
  select * into user_message from public.messages where project_id=p_project_id and id=p_message_id;
  if found then
    if user_message.role<>'user' or user_message.parts<>p_parts
       or user_message.ordinal<>(select max(ordinal) from public.messages where project_id=p_project_id and role='user') then
      raise exception 'MESSAGE_CONFLICT' using errcode='P0001';
    end if;
    select * into assistant_message from public.messages
      where project_id=p_project_id and reply_to=p_message_id order by ordinal desc limit 1;
    if not p_retry then raise exception 'MESSAGE_EXISTS' using errcode='P0001'; end if;
    if assistant_message.id is not null then
      update public.messages set parts='[]',status='pending',request_id=p_request_id,model_id=p_model_id,updated_at=now()
        where project_id=p_project_id and id=assistant_message.id;
      return assistant_message.id;
    end if;
  else
    insert into public.messages(project_id,user_id,id,role,parts,status,request_id)
      values(p_project_id,p_user_id,p_message_id,'user',p_parts,'complete',p_request_id);
  end if;
  new_id:=gen_random_uuid()::text;
  insert into public.messages(project_id,user_id,id,role,parts,status,request_id,model_id,reply_to)
    values(p_project_id,p_user_id,new_id,'assistant','[]','pending',p_request_id,p_model_id,p_message_id);
  update public.projects set updated_at=now() where id=p_project_id and user_id=p_user_id;
  return new_id;
end $$;
revoke all on function public.begin_chat_turn(uuid,uuid,text,jsonb,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.begin_chat_turn(uuid,uuid,text,jsonb,text,uuid,boolean) to service_role;
