-- Service-only operational metadata. All fixtures roll back; no provider calls.
begin;
delete from private.worker_invocation_health;
do $$
declare fn text; role_name text; denied boolean; n integer;
begin
  if not (select relrowsecurity from pg_class where oid='private.worker_invocation_health'::regclass) then
    raise exception 'Worker health requires RLS defense in depth';
  end if;
  foreach role_name in array array['anon','authenticated'] loop
    if has_table_privilege(role_name,'private.worker_invocation_health','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'Worker metadata is exposed to a browser role';
    end if;
  end loop;
  foreach fn in array array['public.begin_worker_invocation(text,uuid)',
    'public.finish_worker_invocation(text,uuid,boolean)','public.read_worker_invocation_health()'] loop
    if has_function_privilege('anon',fn,'EXECUTE') or has_function_privilege('authenticated',fn,'EXECUTE') then
      raise exception 'Worker health function is exposed';
    end if;
    if not has_function_privilege('service_role',fn,'EXECUTE') then raise exception 'Worker cannot report health'; end if;
    if (select prosecdef from pg_proc where oid=fn::regprocedure) then raise exception 'Worker health must use invoker privileges'; end if;
    if not (select proconfig @> array['search_path=""'] from pg_proc where oid=fn::regprocedure) then raise exception 'Worker function search path is not pinned'; end if;
  end loop;
  foreach role_name in array array['anon','authenticated'] loop
    execute format('set local role %I',role_name);
    denied:=false;
    begin perform public.begin_worker_invocation('source-capture',gen_random_uuid());
    exception when insufficient_privilege then denied:=true; end;
    if not denied then raise exception 'Browser can forge a worker start'; end if;
    denied:=false;
    begin perform public.finish_worker_invocation('source-capture',gen_random_uuid(),true);
    exception when insufficient_privilege then denied:=true; end;
    if not denied then raise exception 'Browser can forge worker success'; end if;
    denied:=false;
    begin perform public.read_worker_invocation_health();
    exception when insufficient_privilege then denied:=true; end;
    if not denied then raise exception 'Browser can read worker metadata'; end if;
    denied:=false;
    begin perform 1 from private.worker_invocation_health;
    exception when insufficient_privilege then denied:=true; end;
    if not denied then raise exception 'Browser can read private worker table'; end if;
    execute 'reset role';
  end loop;
  execute 'set local role service_role';
  select count(*) into n from public.read_worker_invocation_health()
    where started_at is null and outcome is null and last_success_at is null and checked_at is not null;
  if n<>3 then raise exception 'Never-run workers must be included'; end if;
  execute 'reset role';
end $$;

-- Separate statements model distinct arrivals; retries of the same identity
-- never reset timestamps, and a superseded completion cannot change health.
set local role service_role;
select public.begin_worker_invocation('source-capture','11111111-1111-4111-8111-111111111111');
do $$
declare previous private.worker_invocation_health%rowtype;
begin
  select * into previous from private.worker_invocation_health where worker_name='source-capture';
  if previous.outcome<>'running' or previous.finished_at is not null then raise exception 'Invalid running state'; end if;
  if public.begin_worker_invocation('source-capture',previous.run_id) then raise exception 'Duplicate start was accepted'; end if;
  if (select started_at<>previous.started_at from private.worker_invocation_health where worker_name='source-capture') then raise exception 'Duplicate start refreshed health'; end if;
end $$;
select public.begin_worker_invocation('source-capture','22222222-2222-4222-8222-222222222222');
do $$
begin
  if (select run_id<>'22222222-2222-4222-8222-222222222222'::uuid from private.worker_invocation_health where worker_name='source-capture') then raise exception 'New invocation did not supersede the old one'; end if;
  if public.finish_worker_invocation('source-capture','11111111-1111-4111-8111-111111111111',true) then raise exception 'Old completion changed current health'; end if;
  if not public.finish_worker_invocation('source-capture','22222222-2222-4222-8222-222222222222',false) then raise exception 'Current completion failed'; end if;
  if public.finish_worker_invocation('source-capture','22222222-2222-4222-8222-222222222222',true) then raise exception 'Duplicate completion changed failure to success'; end if;
  if not exists(select 1 from private.worker_invocation_health where worker_name='source-capture' and outcome='failed' and last_success_at is null and finished_at=last_failure_at and finished_at>=started_at) then raise exception 'Failure was not retained'; end if;
end $$;
select public.begin_worker_invocation('source-capture','33333333-3333-4333-8333-333333333333');
do $$
declare failure timestamptz;
begin
  select last_failure_at into failure from private.worker_invocation_health where worker_name='source-capture';
  if failure is null then raise exception 'Retry erased the prior failure'; end if;
  if not public.finish_worker_invocation('source-capture','33333333-3333-4333-8333-333333333333',true) then raise exception 'Successful recovery failed'; end if;
  if not exists(select 1 from private.worker_invocation_health where worker_name='source-capture' and outcome='succeeded' and last_failure_at=failure and last_success_at=finished_at and last_success_at>failure) then raise exception 'Recovery history is inconsistent'; end if;
end $$;

select public.begin_worker_invocation('sandbox-cleanup','44444444-4444-4444-8444-444444444444');
select public.begin_worker_invocation('archive-cleanup','55555555-5555-4555-8555-555555555555');
do $$
declare denied boolean; before_read jsonb; after_read jsonb;
begin
  if (select count(*) from private.worker_invocation_health)<>3 then raise exception 'Worker table must have exactly the three fixed workers'; end if;
  denied:=false;
  begin perform public.begin_worker_invocation('injected',gen_random_uuid());
  exception when invalid_parameter_value then denied:=true; end;
  if not denied then raise exception 'Arbitrary worker names can expand metadata storage'; end if;
  denied:=false;
  begin perform public.begin_worker_invocation('source-capture',null);
  exception when invalid_parameter_value then denied:=true; end;
  if not denied then raise exception 'Null run identity accepted'; end if;
  denied:=false;
  begin perform public.finish_worker_invocation('source-capture',gen_random_uuid(),null);
  exception when invalid_parameter_value then denied:=true; end;
  if not denied then raise exception 'Null result accepted'; end if;
  denied:=false;
  begin update private.worker_invocation_health set last_success_at=null where worker_name='source-capture';
  exception when check_violation then denied:=true; end;
  if not denied then raise exception 'Incomplete success metadata accepted'; end if;
  denied:=false;
  begin update private.worker_invocation_health set finished_at=null where worker_name='source-capture';
  exception when check_violation then denied:=true; end;
  if not denied then raise exception 'Completed worker with no finish accepted'; end if;
  select jsonb_agg(to_jsonb(h) order by h.worker_name) into before_read from private.worker_invocation_health h;
  perform public.read_worker_invocation_health();
  select jsonb_agg(to_jsonb(h) order by h.worker_name) into after_read from private.worker_invocation_health h;
  if before_read<>after_read then raise exception 'Reading health refreshed worker evidence'; end if;
  if (select count(distinct checked_at) from public.read_worker_invocation_health())<>1 then raise exception 'Health snapshot has inconsistent clock'; end if;
end $$;
reset role;
rollback;
