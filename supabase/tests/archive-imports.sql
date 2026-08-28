begin;
do $$
#variable_conflict use_variable
declare a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); id uuid:=gen_random_uuid(); id2 uuid:=gen_random_uuid(); original_id uuid:=gen_random_uuid();
  manifest jsonb; records jsonb; input jsonb; r jsonb; page jsonb; item jsonb; payload text; h text; denied boolean; bad_path text; action text; total integer;
begin
  insert into auth.users(id) values(a),(b);
  if has_function_privilege('anon','public.project_archive_import_operation(uuid,uuid,text,jsonb)','execute')
    or has_function_privilege('authenticated','public.project_archive_import_operation(uuid,uuid,text,jsonb)','execute')
    or has_function_privilege('authenticated','public.read_imported_project_archive(uuid,uuid,integer)','execute')
    or has_function_privilege('authenticated','public.purge_project_archive_imports()','execute')
    or has_table_privilege('authenticated','private.project_archive_imports','select')
    or has_table_privilege('anon','private.imported_project_archives','insert')
    or has_table_privilege('authenticated','private.imported_project_archive_records','select') then raise exception 'Archive import privilege leak'; end if;
  if exists(select 1 from pg_class where oid in ('private.project_archive_imports'::regclass,'private.imported_project_archives'::regclass,'private.imported_project_archive_records'::regclass) and not relrowsecurity) then raise exception 'Missing archive RLS'; end if;
  records:=jsonb_build_array(
    jsonb_build_object('kind','project','key',original_id,'data',jsonb_build_object('id',original_id,'title','Archive fixture','language','TypeScript','mode','practice','status','completed','activityId','untrusted-activity','createdAt','2026-08-01T00:00:00Z','updatedAt','2026-08-01T00:00:00Z')),
    jsonb_build_object('kind','source','key','main.ts','data',jsonb_build_object('path','main.ts','content','saved 😀','revision',50,'deleted',false,'updatedAt','2026-08-01T00:00:00Z')),
    jsonb_build_object('kind','message','key','0001','data',jsonb_build_object('role','assistant','parts',jsonb_build_array(jsonb_build_object('type','tool-runCommand','output','untrusted-tool')),'large',repeat('x',1200000))),
    jsonb_build_object('kind','assessment','key','old-score','data',jsonb_build_object('score',100,'passed',true,'activityId','untrusted-activity'))
  );
  -- Every archive kind is retained, even when it has no live database mapping.
  foreach action in array array['conflict','conflict-copy','submission','submission-source','submission-file','activity','portfolio-project','capture-status'] loop
    records:=records||jsonb_build_array(jsonb_build_object('kind',action,'key','original-'||action,'data',jsonb_build_object('evidence','unchanged','originalId',original_id)));
  end loop;
  select jsonb_agg(jsonb_build_object('index',ordinality,'record',value::text,'sha256',encode(sha256(convert_to(value::text,'UTF8')),'hex')) order by ordinality),
    sum(octet_length(value::text)) into records,total from jsonb_array_elements(records) with ordinality;
  select encode(sha256(convert_to(string_agg(value->>'index'||':'||(value->>'sha256')||chr(10),'' order by (value->>'index')::int),'UTF8')),'hex') into h from jsonb_array_elements(records);
  manifest:=jsonb_build_object('format','codetutor-project-archive','version',2,'scope','saved-project','includesUnsavedDrafts',false,'includesLiveSandboxFiles',false,
    'id',gen_random_uuid(),'projectId',original_id,'createdAt','2026-08-01T00:00:00Z','expiresAt','2026-08-01T00:30:00Z','recordCount',jsonb_array_length(records),'payloadBytes',total);
  input:=jsonb_build_object('manifest',manifest,'digest',h);
  r:=public.project_archive_import_operation(a,id,'begin',input);
  if r->>'state'<>'uploading' or exists(select 1 from public.projects where projects.id=id) then raise exception 'Premature project publication'; end if;
  foreach action in array array['read','upload','publish','cancel'] loop
    denied:=false; begin perform public.project_archive_import_operation(b,id,action); exception when others then denied:=sqlerrm='ARCHIVE_IMPORT_NOT_FOUND'; end;
    if not denied then raise exception 'Cross-owner archive operation'; end if;
  end loop;
  denied:=false; begin perform public.project_archive_import_operation(b,id,'begin',input); exception when others then denied:=sqlerrm='ARCHIVE_IMPORT_CONFLICT'; end;
  if not denied then raise exception 'Cross-owner archive begin'; end if;
  denied:=false; begin perform public.project_archive_import_operation(a,id2,'begin',input); exception when others then denied:=sqlerrm='ARCHIVE_IMPORT_IN_PROGRESS'; end;
  if not denied then raise exception 'Multiple staging archives'; end if;
  denied:=false; begin perform public.project_archive_import_operation(a,id,'publish'); exception when others then denied:=sqlerrm='ARCHIVE_IMPORT_INCOMPLETE'; end;
  if not denied then raise exception 'Incomplete archive published'; end if;
  denied:=false; begin perform public.project_archive_import_operation(a,id,'upload',jsonb_build_object('records',jsonb_build_array(records->1))); exception when others then denied:=sqlerrm='ARCHIVE_IMPORT_INCOMPLETE'; end;
  if not denied then raise exception 'Out-of-order upload'; end if;
  perform public.project_archive_import_operation(a,id,'upload',jsonb_build_object('records',jsonb_build_array(records->0)));
  foreach bad_path in array array['../escape','.env','node_modules/a.ts','.codetutor-private/file','secret.png'] loop
    payload:=jsonb_build_object('kind','source','key',bad_path,'data',jsonb_build_object('path',bad_path,'content','x','deleted',false))::text;
    item:=jsonb_build_object('index',2,'record',payload,'sha256',encode(sha256(convert_to(payload,'UTF8')),'hex'));
    denied:=false; begin perform public.project_archive_import_operation(a,id,'upload',jsonb_build_object('records',jsonb_build_array(item))); exception when others then denied:=sqlerrm='INVALID_ARCHIVE_SOURCE'; end;
    if not denied then raise exception 'Unsafe archive source'; end if;
  end loop;
  denied:=false; begin perform public.project_archive_import_operation(a,id,'upload',jsonb_build_object('records',jsonb_build_array(jsonb_set(records->1,'{sha256}',to_jsonb(repeat('0',64)))))); exception when others then denied:=sqlerrm='ARCHIVE_DIGEST_MISMATCH'; end;
  if not denied then raise exception 'Bad record digest'; end if;
  r:=public.project_archive_import_operation(a,id,'read');
  if (r->>'uploadedRecords')::int<>1 then raise exception 'Failed upload changed staging'; end if;
  r:=public.project_archive_import_operation(a,id,'upload',jsonb_build_object('records',records));
  if (r->>'uploadedRecords')::int<>jsonb_array_length(records) or (r->>'uploadedBytes')::int<>total then raise exception 'Wrong archive counters'; end if;
  perform public.project_archive_import_operation(a,id,'upload',jsonb_build_object('records',records));
  payload:=jsonb_build_object('kind','source','key','main.ts','data',jsonb_build_object('path','main.ts','content','changed','deleted',false))::text;
  item:=jsonb_build_object('index',2,'record',payload,'sha256',encode(sha256(convert_to(payload,'UTF8')),'hex'));
  denied:=false; begin perform public.project_archive_import_operation(a,id,'upload',jsonb_build_object('records',jsonb_build_array(item))); exception when others then denied:=sqlerrm='ARCHIVE_IMPORT_CONFLICT'; end;
  if not denied then raise exception 'Changed replay accepted'; end if;
  r:=public.project_archive_import_operation(a,id,'publish');
  if r->>'state'<>'published' or r->'project'->>'mode'<>'playground' or r->'project'->>'status'<>'active' or r->'project'->>'activity_id' is not null
    or (select content from public.source_files where project_id=id and path='main.ts')<>'saved 😀'
    or exists(select 1 from public.messages where project_id=id) or exists(select 1 from public.assessments where project_id=id)
    or (select count(*) from private.imported_project_archive_records where archive_id=id)<>jsonb_array_length(records) then raise exception 'Imported evidence gained authority or lost records'; end if;
  page:=public.read_imported_project_archive(a,id,0);
  if page->>'provenance'<>'imported-unverified' or (page->>'nextCursor')::int<>2 or page->'records'<>jsonb_build_array(records->0,records->1) then raise exception 'First history page'; end if;
  page:=public.read_imported_project_archive(a,id,2);
  if jsonb_array_length(page->'records')<>1 or page->'records'->0<>records->2 then raise exception 'Large history page truncated'; end if;
  page:=public.read_imported_project_archive(a,id,3);
  if page->>'nextCursor' is not null or jsonb_array_length(page->'records')<>9 then raise exception 'Final history page'; end if;
  denied:=false; begin perform public.read_imported_project_archive(b,id,0); exception when others then denied:=sqlerrm='ARCHIVE_IMPORT_NOT_FOUND'; end;
  if not denied then raise exception 'Cross-owner history read'; end if;
  perform public.save_source_revision_batch(a,id,'[{"path":"main.ts","content":"newer edit","revision":1}]');
  perform public.project_archive_import_operation(a,id,'publish');
  r:=public.project_archive_import_operation(a,id,'cancel');
  if r->>'state'<>'published' or (select content from public.source_files where project_id=id and path='main.ts')<>'newer edit' then raise exception 'Retry/cancel altered published project'; end if;
  delete from public.projects where projects.id=id;
  if exists(select 1 from private.imported_project_archive_records where archive_id=id) or exists(select 1 from private.imported_project_archives where imported_project_archives.id=id) then raise exception 'Deletion retained archive content'; end if;
  update private.project_archive_imports set expires_at=clock_timestamp()-interval '1 day' where project_archive_imports.id=id;
  perform public.purge_project_archive_imports();
  denied:=false; begin perform public.project_archive_import_operation(a,id,'begin',input); exception when others then denied:=sqlerrm='IMPORTED_PROJECT_DELETED'; end;
  if not denied then raise exception 'Delayed retry recreated deleted project'; end if;
  perform public.project_archive_import_operation(a,id2,'begin',input);
  perform public.project_archive_import_operation(a,id2,'upload',jsonb_build_object('records',jsonb_build_array(records->0)));
  r:=public.project_archive_import_operation(a,id2,'cancel');
  if r->>'state'<>'cancelled' or (r->>'uploadedRecords')::int<>0 or exists(select 1 from private.imported_project_archive_records where archive_id=id2) then raise exception 'Cancel retained staged content'; end if;
  denied:=false; begin perform public.project_archive_import_operation(a,id2,'publish'); exception when others then denied:=sqlerrm='ARCHIVE_IMPORT_CANCELLED'; end;
  if not denied then raise exception 'Cancelled archive published'; end if;
  update private.project_archive_imports set expires_at=clock_timestamp()-interval '1 second' where project_archive_imports.id=id2;
  perform public.purge_project_archive_imports();
  if exists(select 1 from private.project_archive_imports where project_archive_imports.id=id2) then raise exception 'Expired staging not cleaned'; end if;
end $$;
rollback;
