-- Run against an idle test database as the migration owner. Refuses to touch a
-- nonempty live queue; synthetic users and all claims are rolled back together.
begin;
set local statement_timeout='15s';
do $$
declare a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); c uuid:=gen_random_uuid();
  owner uuid; project uuid; session uuid; first_a uuid; held jsonb; next_job jsonb;
  served uuid[]:='{}'; i integer; role_name text;
begin
  if exists(select 1 from public.source_capture_jobs where state in ('queued','capturing','acknowledging')) then
    raise exception 'Use an idle test database for global queue ordering checks';
  end if;
  foreach role_name in array array['anon','authenticated'] loop
    assert not has_table_privilege(role_name,'private.source_capture_accounts','SELECT,INSERT,UPDATE,DELETE'), 'Account scheduler is exposed to browser roles';
    assert not has_function_privilege(role_name,'public.claim_source_capture(uuid)','EXECUTE'), 'Browser can claim jobs';
    assert not has_function_privilege(role_name,'public.settle_source_capture(uuid,uuid,text)','EXECUTE'), 'Browser can settle jobs';
    assert not has_function_privilege(role_name,'public.retry_source_captures(uuid,uuid)','EXECUTE'), 'Browser can bypass retry quotas';
  end loop;
  assert (select relrowsecurity from pg_class where oid='private.source_capture_accounts'::regclass), 'Scheduler defense-in-depth RLS is missing';
  foreach owner in array array[a,b,c] loop
    insert into auth.users(id,email) values(owner,'fairness-'||owner||'@example.invalid');
    insert into public.projects(user_id,title) values(owner,'Disposable fairness check') returning id into project;
    insert into public.sandbox_sessions(user_id,project_id,sandbox_id,status,expires_at)
      values(owner,project,'test-only-'||gen_random_uuid(),'running',now()+interval '1 hour') returning id into session;
    for i in 1..case when owner=a then 8 else 1 end loop
      insert into public.command_audits(user_id,sandbox_session_id,request_id,executable,status,exit_code)
        values(owner,session,gen_random_uuid(),'node','done',0);
    end loop;
  end loop;
  assert (select count(*) from private.source_capture_accounts where user_id in (a,b,c))=3, 'New jobs did not register their accounts';
  update public.source_capture_jobs set available_at='1980-01-01' where user_id=a;
  select id into first_a from public.source_capture_jobs where user_id=a order by id limit 1;
  held:=public.claim_source_capture(first_a);
  assert held->>'user_id'=a::text,'Direct claim did not use its registered owner';
  perform public.settle_source_capture(first_a,(held->>'lease_token')::uuid,'expired');
  for i in 1..2 loop
    next_job:=public.claim_source_capture();
    assert next_job is not null and next_job->>'user_id'<>a::text,'Old busy-account backlog starved another user';
    served:=array_append(served,(next_job->>'user_id')::uuid);
    perform public.settle_source_capture((next_job->>'id')::uuid,(next_job->>'lease_token')::uuid,'expired');
  end loop;
  assert b=any(served) and c=any(served),'Both other accounts must receive service before the busy account repeats';
  held:=public.claim_source_capture();
  assert held->>'user_id'=a::text,'Busy account was not served again after others';
  assert public.claim_source_capture() is null,'An active account lease allowed a second job';
  perform public.settle_source_capture((held->>'id')::uuid,(held->>'lease_token')::uuid,'expired');
  assert public.claim_source_capture() is not null,'Settlement failed to release account capacity';
  delete from auth.users where id=a;
  assert not exists(select 1 from private.source_capture_accounts where user_id=a),'Account deletion leaked scheduler metadata';
  assert not exists(select 1 from public.source_capture_jobs where user_id=a),'Account deletion left orphan capture jobs';
end $$;
rollback;
select 'Fair ordering, lease capacity, private privileges, RLS and cleanup passed (fixtures rolled back)' as result;
