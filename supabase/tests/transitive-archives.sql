begin;
do $$
#variable_conflict use_variable
declare owner uuid:=gen_random_uuid(); other_user uuid:=gen_random_uuid(); original uuid:=gen_random_uuid(); imported uuid; current_project uuid; export_id uuid;
  receipt jsonb; manifest jsonb; records jsonb; expected_payload text; digest text; retained jsonb; item jsonb; corrupted jsonb;
  historical_count integer; generation integer; candidate uuid; marker_index integer;
begin
  insert into auth.users(id) values(owner),(other_user);
  insert into public.projects(id,user_id,title) values(original,owner,'Transitive archive fixture');
  insert into public.messages(project_id,user_id,id,role,status,parts) values(original,owner,'original-message','assistant','complete','[{"type":"text","text":"Earlier learning history must survive"}]');
  perform public.save_source_revision_batch(owner,original,'[{"path":"main.ts","content":"original source","revision":0}]',true);
  current_project:=original;
  for generation in 0..3 loop
    export_id:=gen_random_uuid(); imported:=gen_random_uuid();
    receipt:=public.create_project_archive(owner,current_project,export_id);
    if receipt->>'formatVersion'<>'3' then raise exception 'New exports must use v3'; end if;
    if public.create_project_archive(owner,current_project,gen_random_uuid())<>receipt then raise exception 'Export retries changed the frozen receipt'; end if;
    manifest:=(receipt-'formatVersion')||jsonb_build_object('format','codetutor-project-archive','version',3,'scope','saved-project','includesUnsavedDrafts',false,'includesLiveSandboxFiles',false);
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('index',ordinal,'record',payload,'sha256',r.digest,'sectionId',section_id,'sectionIndex',section_ordinal)) order by ordinal),
      encode(sha256(convert_to(string_agg(ordinal::text||':'||r.digest||':'||coalesce(section_id::text,'')||':'||coalesce(section_ordinal,0)::text||chr(10),'' order by ordinal),'UTF8')),'hex')
      into records,digest from private.project_archive_records r where archive_id=export_id;
    if generation=0 then select payload into expected_payload from private.project_archive_records where archive_id=export_id and payload::jsonb->>'kind'='message'; end if;
    if (select count(*) from private.project_archive_records where archive_id=export_id and payload=expected_payload)<>1 then raise exception 'Full export omitted or duplicated original imported history'; end if;
    select count(*) into historical_count from private.project_archive_records where archive_id=export_id and payload::jsonb->>'kind'='archive-section';
    if historical_count<>generation then raise exception 'Archive ancestry was not flat and complete'; end if;
    if (public.read_project_archive(owner,current_project,export_id)->'records')<>records then raise exception 'Export endpoint omitted section metadata'; end if;
    begin perform public.read_project_archive(other_user,current_project,export_id); raise exception 'Cross-owner archive access accepted';
      exception when raise_exception then if sqlerrm<>'ARCHIVE_NOT_FOUND' then raise; end if; end;
    -- Corrupted section boundaries and metadata must fail before publication.
    if generation=1 then
      select (e.value->>'index')::integer into marker_index from jsonb_array_elements(records) e where (e.value->>'record')::jsonb->>'kind'='archive-section';
      candidate:=gen_random_uuid();
      perform public.project_archive_import_operation(owner,candidate,'begin',jsonb_build_object('manifest',manifest,'digest',digest));
      corrupted:=jsonb_set(records,array[marker_index::text,'sectionIndex'],'2');
      begin perform public.project_archive_import_operation(owner,candidate,'upload',jsonb_build_object('records',corrupted)); raise exception 'Noncontiguous historical records accepted';
        exception when raise_exception then if sqlerrm<>'ARCHIVE_IMPORT_INCOMPLETE' then raise; end if; end;
      -- Failed batches roll back completely.
      if exists(select 1 from private.imported_project_archive_records where archive_id=candidate) then raise exception 'Failed batch left partial records'; end if;
      perform public.project_archive_import_operation(owner,candidate,'cancel');
      candidate:=gen_random_uuid();
      -- Keep the marker well-shaped but lie about its root digest; even a
      -- matching outer digest must not publish a broken historical section.
      item:=records->(marker_index-1); corrupted:=(item->>'record')::jsonb;
      corrupted:=jsonb_set(corrupted,'{data,rootDigest}',to_jsonb(repeat('0',64)));
      item:=jsonb_set(item,'{record}',to_jsonb(corrupted::text));
      item:=jsonb_set(item,'{sha256}',to_jsonb(encode(sha256(convert_to(corrupted::text,'UTF8')),'hex')));
      corrupted:=jsonb_set(records,array[(marker_index-1)::text],item);
      manifest:=jsonb_set(manifest,'{payloadBytes}',(select to_jsonb(sum(octet_length(e->>'record'))) from jsonb_array_elements(corrupted) e));
      perform public.project_archive_import_operation(owner,candidate,'begin',jsonb_build_object('manifest',manifest,'digest',
        (select encode(sha256(convert_to(string_agg((e->>'index')||':'||(e->>'sha256')||':'||coalesce(e->>'sectionId','')||':'||coalesce(e->>'sectionIndex','0')||chr(10),'' order by (e->>'index')::integer),'UTF8')),'hex') from jsonb_array_elements(corrupted) e)));
      perform public.project_archive_import_operation(owner,candidate,'upload',jsonb_build_object('records',corrupted));
      begin perform public.project_archive_import_operation(owner,candidate,'publish'); raise exception 'Corrupt historical root digest published';
        exception when raise_exception then if sqlerrm<>'ARCHIVE_IMPORT_INCOMPLETE' then raise; end if; end;
      perform public.project_archive_import_operation(owner,candidate,'cancel');
      manifest:=jsonb_set(manifest,'{payloadBytes}',receipt->'payloadBytes');
    end if;
    perform public.project_archive_import_operation(owner,imported,'begin',jsonb_build_object('manifest',manifest,'digest',digest));
    perform public.project_archive_import_operation(owner,imported,'upload',jsonb_build_object('records',records));
    perform public.project_archive_import_operation(owner,imported,'upload',jsonb_build_object('records',records));
    perform public.project_archive_import_operation(owner,imported,'publish');
    if exists(select 1 from public.messages where project_id=imported) or exists(select 1 from public.assessments where project_id=imported) then raise exception 'Foreign history became authoritative'; end if;
    if (select content from public.source_files where project_id=imported and path='main.ts') is distinct from
      (case when generation=0 then 'original source' else 'current source '||generation::text end) then raise exception 'Historical source overwrote current source'; end if;
    retained:=public.read_imported_project_archive(owner,imported);
    if retained->'records'<>records or retained->'manifest'<>manifest or retained->>'digest'<>digest then raise exception 'Read-only history bytes or section metadata changed'; end if;
    begin perform public.read_imported_project_archive(other_user,imported); raise exception 'Cross-owner imported history accepted';
      exception when raise_exception then if sqlerrm<>'ARCHIVE_IMPORT_NOT_FOUND' then raise; end if; end;
    perform public.save_source_revision_batch(owner,imported,jsonb_build_array(jsonb_build_object('path','main.ts','content','current source '||(generation+1)::text,'revision',1)),false);
    perform public.project_archive_import_operation(owner,imported,'publish');
    if (select content from public.source_files where project_id=imported and path='main.ts')<>'current source '||(generation+1)::text then raise exception 'Publish retry overwrote new edits'; end if;
    perform public.delete_project_archive(owner,current_project,export_id);
    if current_project<>original then
      delete from public.projects where id=current_project and user_id=owner;
      if exists(select 1 from private.imported_project_archive_records where archive_id=current_project) then raise exception 'Deleted project retained foreign content'; end if;
      begin perform public.project_archive_import_operation(owner,current_project,'publish'); raise exception 'Deleted project was resurrected';
        exception when raise_exception then if sqlerrm<>'IMPORTED_PROJECT_DELETED' then raise; end if; end;
    end if;
    current_project:=imported;
  end loop;
  -- Pair constraints must reject SQL NULL, not silently pass CHECK(NULL).
  begin
    insert into private.imported_project_archive_records(archive_id,ordinal,kind,record_key,payload,digest,section_id) values(imported,49999,'message','bad','{}',repeat('0',64),gen_random_uuid());
    raise exception 'Partial section metadata bypassed SQL constraint';
  exception when check_violation then null; end;
end $$;
rollback;
