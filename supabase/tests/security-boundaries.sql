-- Transactional assertions, run with psql ON_ERROR_STOP after a clean replay.
-- No external services, persistent fixtures, email or paid resources.
begin;
do $$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
  pa uuid := gen_random_uuid(); pb uuid := gen_random_uuid();
  n integer; denied boolean; object_name text; role_name text;
begin
  if exists (
    select 1 from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
    where ns.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity
      and not exists(select 1 from pg_depend d where d.objid=c.oid and d.deptype='e')
  ) then raise exception 'An exposed application table is missing RLS'; end if;
  if not exists(select 1 from pg_class where oid='public.assessment_progress'::regclass
      and reloptions @> array['security_invoker=true']) then
    raise exception 'Progress view must obey caller RLS';
  end if;
  foreach object_name in array array[
    'public.sandbox_sessions','public.messages','public.source_files',
    'public.assessments','public.command_audits','public.sandbox_cleanup_jobs'
  ] loop
    foreach role_name in array array['anon','authenticated'] loop
      if has_table_privilege(role_name,object_name,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'Browser role can mutate authoritative server records: %',object_name;
      end if;
    end loop;
    if has_table_privilege('anon',object_name,'SELECT') then raise exception 'Anonymous table read: %',object_name; end if;
  end loop;
  foreach object_name in array array[
    'public.reserve_sandbox_session(uuid,uuid,integer[])',
    'public.claim_sandbox_cleanup(uuid)',
    'public.settle_sandbox_cleanup(uuid,uuid,text)',
    'public.source_import_operation(uuid,uuid,text,jsonb)'
  ] loop
    if has_function_privilege('anon',object_name,'EXECUTE')
      or has_function_privilege('authenticated',object_name,'EXECUTE') then
      raise exception 'Privileged function exposed: %',object_name;
    end if;
    if not has_function_privilege('service_role',object_name,'EXECUTE') then
      raise exception 'Service role cannot execute its worker function: %',object_name;
    end if;
  end loop;
  insert into auth.users(id) values(a),(b);
  insert into public.projects(id,user_id,title) values(pa,a,'RLS account A'),(pb,b,'RLS account B');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',a,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  select count(*) into n from public.projects where id in (pa,pb);
  if n<>1 or not exists(select 1 from public.projects where id=pa) then raise exception 'Account A read isolation failed'; end if;
  update public.projects set title='forged' where id=pb;
  get diagnostics n=row_count;
  if n<>0 then raise exception 'Cross-user update succeeded'; end if;
  denied:=false;
  begin update public.projects set user_id=b where id=pa;
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Ownership could be reassigned'; end if;
  denied:=false;
  begin perform public.claim_sandbox_cleanup(null);
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Browser could claim cleanup work'; end if;
  execute 'reset role';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',b,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  select count(*) into n from public.projects where id in (pa,pb);
  if n<>1 or not exists(select 1 from public.projects where id=pb) then raise exception 'Account B read isolation failed'; end if;
  execute 'reset role';
end $$;
rollback;
