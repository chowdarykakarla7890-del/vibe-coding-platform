begin;
do $$
#variable_conflict use_variable
declare a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); id uuid:=gen_random_uuid(); id2 uuid:=gen_random_uuid();
  h text:=encode(sha256(convert_to('hello 😀','UTF8')),'hex'); manifest text; input jsonb; r jsonb; denied boolean; bad_path text;
begin
  insert into auth.users(id) values(a),(b);
  if has_function_privilege('anon','public.source_import_operation(uuid,uuid,text,jsonb)','execute')
    or has_function_privilege('authenticated','public.source_import_operation(uuid,uuid,text,jsonb)','execute')
    or has_function_privilege('authenticated','public.purge_source_imports()','execute')
    or has_table_privilege('authenticated','private.source_imports','select')
    or has_table_privilege('anon','private.source_import_files','insert') then raise exception 'Import privilege leak'; end if;
  if exists(select 1 from pg_class where oid in ('private.source_imports'::regclass,'private.source_import_files'::regclass) and not relrowsecurity) then raise exception 'Missing RLS'; end if;
  manifest:=encode(sha256(convert_to('main.ts:'||h||chr(10),'UTF8')),'hex');
  input:=jsonb_build_object('title','Imported fixture','language','TypeScript','fileCount',1,'sourceBytes',octet_length('hello 😀'),'digest',manifest);
  r:=public.source_import_operation(a,id,'begin',input);
  if r->>'state'<>'uploading' or exists(select 1 from public.projects where projects.id=id) then raise exception 'Premature project publication'; end if;
  denied:=false; begin perform public.source_import_operation(b,id,'read'); exception when others then denied:=sqlerrm='IMPORT_NOT_FOUND'; end;
  if not denied then raise exception 'Cross-owner read'; end if;
  denied:=false; begin perform public.source_import_operation(b,id,'cancel'); exception when others then denied:=sqlerrm='IMPORT_NOT_FOUND'; end;
  if not denied then raise exception 'Cross-owner cancel'; end if;
  denied:=false; begin perform public.source_import_operation(a,id2,'begin',input); exception when others then denied:=sqlerrm='IMPORT_IN_PROGRESS'; end;
  if not denied then raise exception 'Multiple staging uploads'; end if;
  denied:=false; begin perform public.source_import_operation(a,id,'publish'); exception when others then denied:=sqlerrm='IMPORT_INCOMPLETE'; end;
  if not denied or exists(select 1 from public.projects where projects.id=id) then raise exception 'Incomplete import published'; end if;
  denied:=false; begin perform public.source_import_operation(a,id,'upload',jsonb_build_object('files',jsonb_build_array(jsonb_build_object('path','main.ts','content','wrong','digest',h)))); exception when others then denied:=sqlerrm='IMPORT_DIGEST_MISMATCH'; end;
  if not denied or exists(select 1 from private.source_import_files where import_id=id) then raise exception 'Bad hash accepted'; end if;
  foreach bad_path in array array['../escape','.env','node_modules/a.ts','.codetutor-private/file','secret.png'] loop
    denied:=false; begin perform public.source_import_operation(a,id,'upload',jsonb_build_object('files',jsonb_build_array(jsonb_build_object('path',bad_path,'content','hello 😀','digest',h)))); exception when others then denied:=sqlerrm='INVALID_IMPORT'; end;
    if not denied then raise exception 'Unsafe path accepted'; end if;
  end loop;
  r:=public.source_import_operation(a,id,'upload',jsonb_build_object('files',jsonb_build_array(jsonb_build_object('path','main.ts','content','hello 😀','digest',h))));
  if (r->>'uploadedFiles')::int<>1 then raise exception 'Upload receipt'; end if;
  perform public.source_import_operation(a,id,'upload',jsonb_build_object('files',jsonb_build_array(jsonb_build_object('path','main.ts','content','hello 😀','digest',h))));
  denied:=false; begin perform public.source_import_operation(a,id,'upload',jsonb_build_object('files',jsonb_build_array(jsonb_build_object('path','main.ts/child','content','hello 😀','digest',h)))); exception when others then denied:=sqlerrm='SOURCE_PATH_CONFLICT'; end;
  if not denied then raise exception 'File/directory overlap'; end if;
  denied:=false; begin perform public.source_import_operation(a,id,'upload',jsonb_build_object('files',jsonb_build_array(jsonb_build_object('path','extra','content','hello 😀','digest',h)))); exception when others then denied:=sqlerrm='IMPORT_LIMIT'; end;
  if not denied or (select count(*) from private.source_import_files where import_id=id)<>1 then raise exception 'Upload bound not atomic'; end if;
  r:=public.source_import_operation(a,id,'publish');
  if r->>'state'<>'published' or r->'project'->>'mode'<>'playground' or r->'project'->>'status'<>'active'
    or (select content from public.source_files where project_id=id and user_id=a and path='main.ts')<>'hello 😀'
    or exists(select 1 from private.source_import_files where import_id=id)
    or exists(select 1 from public.assessments where project_id=id)
    or exists(select 1 from public.messages where project_id=id) then raise exception 'Publish mismatch'; end if;
  perform public.save_source_revision_batch(a,id,'[{"path":"main.ts","content":"newer edit","revision":1}]');
  r:=public.source_import_operation(a,id,'publish');
  if (select content from public.source_files where project_id=id and path='main.ts')<>'newer edit' then raise exception 'Retry overwrote source'; end if;
  r:=public.source_import_operation(a,id,'cancel');
  if r->>'state'<>'published' or not exists(select 1 from public.projects where projects.id=id) then raise exception 'Cancel removed committed project'; end if;
  update private.source_imports set expires_at=clock_timestamp()-interval '1 second' where source_imports.id=id;
  perform public.purge_source_imports();
  r:=public.source_import_operation(a,id,'publish');
  if r->>'state'<>'published' then raise exception 'Published receipt must survive cleanup'; end if;
  perform public.source_import_operation(a,id2,'begin',input);
  r:=public.source_import_operation(a,id2,'cancel');
  denied:=false; begin perform public.source_import_operation(a,id2,'publish'); exception when others then denied:=sqlerrm='IMPORT_CANCELLED'; end;
  if not denied then raise exception 'Cancelled import published'; end if;
  delete from public.projects where projects.id=id;
  denied:=false; begin perform public.source_import_operation(a,id,'publish'); exception when others then denied:=sqlerrm='IMPORTED_PROJECT_DELETED'; end;
  if not denied or exists(select 1 from public.projects where projects.id=id) then raise exception 'Deleted project recreated'; end if;
  update private.source_imports set expires_at=clock_timestamp()-interval '1 second' where user_id=a;
  denied:=false; begin perform public.source_import_operation(a,id2,'read'); exception when others then denied:=sqlerrm='IMPORT_EXPIRED'; end;
  if not denied then raise exception 'Expired import accessible'; end if;
  perform public.purge_source_imports();
  if exists(select 1 from private.source_imports where source_imports.id=id2) then raise exception 'Expired staging cleanup failed'; end if;
  denied:=false; begin perform public.source_import_operation(a,id,'begin',input); exception when others then denied:=sqlerrm='IMPORTED_PROJECT_DELETED'; end;
  if not denied then raise exception 'Cleanup allowed delayed retry to recreate a deleted project'; end if;
  -- A full-sized valid source import, including Unicode names and JSON escapes.
  id:=gen_random_uuid();
  select jsonb_agg(jsonb_build_object('path','source-'||n||'.txt','content',repeat(chr(1),262144),'digest',encode(sha256(convert_to(repeat(chr(1),262144),'UTF8')),'hex'))) into r from generate_series(1,40) n;
  select encode(sha256(convert_to(string_agg(value->>'path'||':'||(value->>'digest')||chr(10),'' order by (value->>'path') collate "C"),'UTF8')),'hex') into manifest from jsonb_array_elements(r);
  perform public.source_import_operation(a,id,'begin',jsonb_build_object('title','Large source','language','Any','fileCount',40,'sourceBytes',10485760,'digest',manifest));
  for input in select value from jsonb_array_elements(r) loop
    perform public.source_import_operation(a,id,'upload',jsonb_build_object('files',jsonb_build_array(input)));
  end loop;
  perform public.source_import_operation(a,id,'publish');
  if (select count(*) from public.source_files where project_id=id)<>40 or (select sum(octet_length(content)) from public.source_files where project_id=id)<>10485760 then raise exception 'Full source import lost data'; end if;
end $$;
rollback;
