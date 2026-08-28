-- Run as migration owner. Synthetic records and all writes roll back. The
-- cleanup check refuses to touch any unrelated expired temporary archive.
begin;
set local statement_timeout='30s';
do $$
declare owner_id uuid:=gen_random_uuid(); project_id uuid; session_id uuid; command_id uuid;
  receipt jsonb; page jsonb; client_role text; relation_name text; copied integer;
  escaped_source text:=repeat(chr(1),262144);
begin
  foreach client_role in array array['anon','authenticated'] loop
    foreach relation_name in array array['private.project_archives','private.project_archive_records'] loop
      assert not has_table_privilege(client_role,relation_name,'SELECT,INSERT,UPDATE,DELETE');
      assert (select relrowsecurity from pg_class where oid=relation_name::regclass);
    end loop;
    assert not has_function_privilege(client_role,'public.create_project_archive(uuid,uuid,uuid,jsonb)','EXECUTE');
    assert not has_function_privilege(client_role,'public.read_project_archive(uuid,uuid,uuid,integer)','EXECUTE');
    assert not has_function_privilege(client_role,'public.delete_project_archive(uuid,uuid,uuid)','EXECUTE');
    assert not has_function_privilege(client_role,'public.purge_project_archives()','EXECUTE');
  end loop;
  insert into auth.users(id,email) values(owner_id,'archive-boundary-'||owner_id||'@example.invalid');
  insert into public.projects(user_id,title) values(owner_id,'Disposable archive boundary') returning id into project_id;
  perform public.save_source_revision_batch(owner_id,project_id,jsonb_build_array(jsonb_build_object('path','escaped.ts','content',escaped_source,'revision',0)));
  insert into public.sandbox_sessions(user_id,project_id,sandbox_id,status,expires_at)
    values(owner_id,project_id,'test-only-'||owner_id,'expired',now()-interval '1 day') returning id into session_id;
  insert into public.command_audits(user_id,sandbox_session_id,executable,status,exit_code,request_id)
    values(owner_id,session_id,'node','done',0,gen_random_uuid()) returning id into command_id;
  insert into public.source_capture_conflicts(user_id,project_id,capture_job_id,path,saved_revision,saved_content,captured_content,captured_digest,fingerprint,reason)
    values(owner_id,project_id,command_id,'escaped.ts',1,escaped_source,escaped_source,
      encode(sha256(convert_to(escaped_source,'UTF8')),'hex'),repeat('a',64),'revision_conflict');
  receipt:=public.create_project_archive(owner_id,project_id,gen_random_uuid());
  assert (receipt->>'payloadBytes')::bigint>3145728,'JSON escaping must count toward export bytes';
  copied:=0;
  loop
    page:=public.read_project_archive(owner_id,project_id,(receipt->>'id')::uuid,copied);
    assert octet_length(page::text)<4500000,'An escaped page exceeded the hosting response limit';
    assert jsonb_array_length(page->'records')>0;
    copied:=copied+jsonb_array_length(page->'records');
    exit when page->>'nextCursor' is null;
  end loop;
  assert copied=(receipt->>'recordCount')::integer;
  assert (select count(*) from private.project_archive_records r where r.archive_id=(receipt->>'id')::uuid
    and r.payload::jsonb->>'kind'='conflict-copy')=3,'Keep captured/saved/reviewed copies in individually bounded records';
  begin
    insert into private.project_archive_records(archive_id,ordinal,payload,digest)
      values((receipt->>'id')::uuid,50001,'{}',repeat('0',64));
    raise exception 'Archive accepted an over-limit ordinal';
  exception when check_violation then null; end;
  begin
    update private.project_archives set payload_bytes=268435457 where id=(receipt->>'id')::uuid;
    raise exception 'Archive accepted an over-limit byte count';
  exception when check_violation then null; end;
  update private.project_archives set expires_at=now()-interval '1 second' where id=(receipt->>'id')::uuid;
  begin
    perform public.read_project_archive(owner_id,project_id,(receipt->>'id')::uuid);
    raise exception 'Expired archive was readable';
  exception when raise_exception then if sqlerrm<>'ARCHIVE_EXPIRED' then raise; end if; end;
  if not exists(select 1 from private.project_archives where user_id<>owner_id and expires_at<=clock_timestamp()) then
    assert public.purge_project_archives()=1;
    assert not exists(select 1 from private.project_archive_records where archive_id=(receipt->>'id')::uuid);
    assert exists(select 1 from public.source_files where user_id=owner_id and content=escaped_source),'Cleanup deleted original source';
  end if;
end $$;
rollback;
select 'archive permissions, escaping, bounds and expiration passed' as verification;
