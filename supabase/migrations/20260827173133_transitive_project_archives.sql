-- v3 preserves imported history as flat sections with original payload bytes.
-- Existing v2 staging/receipts remain readable; only new exports use v3.
alter table private.project_archives add column format_version integer not null default 2 check(format_version in (2,3));
alter table private.project_archive_records add column section_id uuid, add column section_ordinal integer;
alter table private.project_archive_records add constraint archive_record_section_pair check(
  (section_id is null and section_ordinal is null) or (section_id is not null and section_ordinal is not null and section_ordinal between 1 and 50000));
alter table private.imported_project_archive_records add column section_id uuid, add column section_ordinal integer;
alter table private.imported_project_archive_records add constraint imported_archive_section_pair check(
  (section_id is null and section_ordinal is null) or (section_id is not null and section_ordinal is not null and section_ordinal between 1 and 50000));
alter table private.imported_project_archive_records drop constraint imported_project_archive_records_archive_id_kind_record_key_key;
alter table private.imported_project_archive_records add constraint imported_archive_section_keys unique nulls not distinct(archive_id,section_id,kind,record_key);
alter table private.imported_project_archive_records add constraint imported_archive_section_ordinals unique(archive_id,section_id,section_ordinal);
alter table private.imported_project_archive_records drop constraint imported_project_archive_records_kind_check;
alter table private.imported_project_archive_records add constraint imported_archive_record_kind check(
  kind in ('project','source','message','conflict','conflict-copy','submission','submission-source','submission-file','assessment','activity','portfolio-project','capture-status','archive-section'));

create function private.valid_project_archive_manifest(value jsonb) returns boolean
language plpgsql stable security invoker set search_path='' as $$
begin
  if jsonb_typeof(value) is distinct from 'object' or octet_length(value::text)>=4096
    or value-array['format','version','scope','includesUnsavedDrafts','includesLiveSandboxFiles','id','projectId','createdAt','expiresAt','recordCount','payloadBytes']<>'{}'
    or value->>'format' is distinct from 'codetutor-project-archive' or value->'version' not in ('2'::jsonb,'3'::jsonb) or not value ? 'version'
    or value->>'scope' is distinct from 'saved-project' or value->'includesUnsavedDrafts' is distinct from 'false'::jsonb
    or value->'includesLiveSandboxFiles' is distinct from 'false'::jsonb
    or coalesce(value->>'id','') !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
    or coalesce(value->>'projectId','') !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
    or jsonb_typeof(value->'recordCount') is distinct from 'number' or coalesce(value->>'recordCount','') !~ '^[1-9][0-9]{0,4}$'
    or jsonb_typeof(value->'payloadBytes') is distinct from 'number' or coalesce(value->>'payloadBytes','') !~ '^[1-9][0-9]{0,8}$'
    or jsonb_typeof(value->'createdAt') is distinct from 'string' or length(value->>'createdAt')>50
    or jsonb_typeof(value->'expiresAt') is distinct from 'string' or length(value->>'expiresAt')>50 then return false; end if;
  if (value->>'recordCount')::integer>50000 or (value->>'payloadBytes')::integer>268435456 then return false; end if;
  perform (value->>'createdAt')::timestamptz,(value->>'expiresAt')::timestamptz;
  return true;
exception when invalid_datetime_format or datetime_field_overflow then return false;
end $$;
create function private.valid_project_archive_section(value jsonb) returns boolean
language plpgsql stable security invoker set search_path='' as $$
begin
  if jsonb_typeof(value) is distinct from 'object' or value-array['manifest','digest','rootRecordCount','rootPayloadBytes','rootDigest']<>'{}'
    or not private.valid_project_archive_manifest(value->'manifest') or coalesce(value->>'digest','') !~ '^[a-f0-9]{64}$'
    or coalesce(value->>'rootDigest','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(value->'rootRecordCount') is distinct from 'number' or coalesce(value->>'rootRecordCount','') !~ '^[1-9][0-9]{0,4}$'
    or jsonb_typeof(value->'rootPayloadBytes') is distinct from 'number' or coalesce(value->>'rootPayloadBytes','') !~ '^[1-9][0-9]{0,8}$' then return false; end if;
  if (value->>'rootRecordCount')::integer>(value->'manifest'->>'recordCount')::integer
    or (value->>'rootPayloadBytes')::integer>(value->'manifest'->>'payloadBytes')::integer then return false; end if;
  return value->'manifest'->>'version'='3' or (
    value->'rootRecordCount'=value->'manifest'->'recordCount' and value->'rootPayloadBytes'=value->'manifest'->'payloadBytes' and value->>'rootDigest'=value->>'digest');
end $$;
revoke all on function private.valid_project_archive_manifest(jsonb),private.valid_project_archive_section(jsonb) from public,anon,authenticated;
grant execute on function private.valid_project_archive_manifest(jsonb),private.valid_project_archive_section(jsonb) to service_role;
-- Valid 256 KiB conflict versions can exceed the response limit together after
-- JSON escaping. Preserve each copy separately, never truncate its contents.
create or replace function public.create_project_archive(p_user_id uuid,p_project_id uuid,p_archive_id uuid,p_catalog jsonb default '[]') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job private.project_archives%rowtype;
begin
  if p_user_id is null or p_project_id is null or p_archive_id is null or jsonb_typeof(p_catalog)<>'array'
    or octet_length(p_catalog::text)>2097152 then raise exception 'INVALID_ARCHIVE'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,6));
  perform 1 from public.projects where id=p_project_id and user_id=p_user_id for key share;
  if not found then raise exception 'PROJECT_NOT_FOUND'; end if;
  delete from private.project_archives where user_id=p_user_id and expires_at<=clock_timestamp();
  select * into job from private.project_archives where user_id=p_user_id;
  if found then
    if job.project_id<>p_project_id then raise exception 'ARCHIVE_IN_PROGRESS'; end if;
    return jsonb_build_object('id',job.id,'projectId',job.project_id,'createdAt',job.created_at,
      'expiresAt',job.expires_at,'recordCount',job.record_count,'payloadBytes',job.payload_bytes,'formatVersion',job.format_version);
  end if;
  insert into private.project_archives(id,user_id,project_id,format_version) values(p_archive_id,p_user_id,p_project_id,3) returning * into job;

  -- ONE source-reading statement: every UNION branch shares its MVCC snapshot.
  -- No pagination across mutable source/history and no VM/provider calls or
  -- long-lived transaction during the browser's download. Explicit projections
  -- ensure future credential/billing columns cannot silently enter an export.
  with records(kind,key,data) as (
    select 'project',p.id::text,jsonb_build_object('id',p.id,'title',p.title,'mode',p.mode,'activityId',p.activity_id,
      'language',p.language,'status',p.status,'createdAt',p.created_at,'updatedAt',p.updated_at)
      from public.projects p where p.id=p_project_id and p.user_id=p_user_id
    union all select 'source',s.path,jsonb_build_object('path',s.path,'content',s.content,'revision',s.revision,'deleted',s.deleted,'updatedAt',s.updated_at)
      from public.source_files s where s.project_id=p_project_id and s.user_id=p_user_id
    union all select 'message',lpad(m.ordinal::text,20,'0'),jsonb_build_object('id',m.id,'role',m.role,'parts',private.archive_message_parts(m.parts),
      'status',m.status,'modelId',m.model_id,'ordinal',m.ordinal,'replyTo',m.reply_to,'createdAt',m.created_at,'updatedAt',m.updated_at)
      from public.messages m where m.project_id=p_project_id and m.user_id=p_user_id
    union all select 'conflict',c.id::text,jsonb_build_object('id',c.id,'path',c.path,'reason',c.reason,'baseRevision',c.base_revision,
      'baseDigest',c.base_digest,'capturedDigest',c.captured_digest,'savedRevision',c.saved_revision,
      'reviewedRevision',c.reviewed_revision,'resolutionChoice',c.resolution_choice,'resolutionRevision',c.resolution_revision,
      'resolutionDeleted',c.resolution_deleted,'createdAt',c.created_at,'resolvedAt',c.resolved_at)
      from public.source_capture_conflicts c where c.project_id=p_project_id and c.user_id=p_user_id
    union all select 'conflict-copy',c.id::text||':'||e.slot,jsonb_build_object('conflictId',c.id,'path',c.path,'version',e.slot,'content',e.content)
      from public.source_capture_conflicts c cross join lateral
        (values ('captured',c.captured_content),('saved',c.saved_content),('reviewed',c.reviewed_content)) e(slot,content)
      where c.project_id=p_project_id and c.user_id=p_user_id
    union all select 'submission',s.id::text,jsonb_build_object('id',s.id,'sourceId',s.source_id,'activityId',s.activity_id,'manifest',s.manifest,
      'sourceVersions',s.source_versions,'language',s.language,'modelId',s.model_id,'reflection',s.reflection,'state',s.state,
      'failureCode',s.failure_code,'createdAt',s.created_at,'expiresAt',s.expires_at,'finishedAt',s.finished_at)
      from public.activity_submissions s where s.project_id=p_project_id and s.user_id=p_user_id
    union all select 'submission-source',s.id::text,jsonb_build_object('id',s.id,'digest',s.digest,'fileCount',jsonb_array_length(s.files),'createdAt',s.created_at)
      from public.submission_sources s where s.project_id=p_project_id and s.user_id=p_user_id
    union all select 'submission-file',s.id::text||':'||lpad(e.n::text,4,'0'),jsonb_build_object('sourceId',s.id,'index',e.n-1,'file',e.file)
      from public.submission_sources s cross join lateral jsonb_array_elements(s.files) with ordinality e(file,n)
      where s.project_id=p_project_id and s.user_id=p_user_id
    union all select 'assessment',a.id::text,jsonb_build_object('id',a.id,'submissionId',a.submission_id,'activityId',a.activity_id,'score',a.score,
      'passed',a.passed,'aiAssessed',a.ai_assessed,'feedback',a.feedback,'concepts',a.concepts,'language',a.language,'modelId',a.model_id,
      'sourceCurrentAtAssessment',a.source_current,'verificationKind',a.verification_kind,'createdAt',a.created_at)
      from public.assessments a where a.project_id=p_project_id and a.user_id=p_user_id
    union all select 'activity',a.id,jsonb_build_object('manifest',a.manifest,'createdAt',a.created_at)
      from public.generated_activities a where a.user_id=p_user_id and
        (a.id=(select activity_id from public.projects where id=p_project_id) or exists(select 1 from public.activity_submissions s where s.project_id=p_project_id and s.user_id=p_user_id and s.activity_id=a.id))
    union all select 'activity',a->>'id',jsonb_build_object('manifest',a,'source','bundled-catalog')
      from jsonb_array_elements(p_catalog) a where a->>'id'=(select activity_id from public.projects where id=p_project_id)
        and not exists(select 1 from public.generated_activities g where g.user_id=p_user_id and g.id=a->>'id')
    union all select 'portfolio-project',p_project_id::text,e.item
      from public.portfolios p cross join lateral jsonb_array_elements(coalesce(p.document->'projects','[]')) e(item)
      where p.user_id=p_user_id and e.item->>'projectId'=p_project_id::text
    union all select 'capture-status',c.id::text,jsonb_build_object('id',c.id,'purpose',c.purpose,'state',c.state,'complete',c.capture_complete,
      'terminal',c.capture_terminal,'hasConflicts',c.has_conflicts,'failureCode',c.failure_code,'createdAt',c.created_at,'capturedAt',c.captured_at)
      from public.source_capture_jobs c where c.project_id=p_project_id and c.user_id=p_user_id
  )
  , encoded as (select kind,key,jsonb_build_object('kind',kind,'key',key,'data',data)::text payload from records)
  , current_records as (
    select row_number() over(order by case when kind='project' then 0 else 1 end,kind,key) sequence,payload from encoded
  ), imported as (
    select i.* from private.project_archive_imports i join private.imported_project_archives a on a.id=i.id
      where a.project_id=p_project_id and a.user_id=p_user_id and i.user_id=p_user_id and i.state='published'
  ), history as (
    select 0::bigint sequence,jsonb_build_object('kind','archive-section','key',lower(i.manifest->>'id'),'data',
      jsonb_build_object('manifest',i.manifest,'digest',i.expected_digest,'rootRecordCount',s.record_count,'rootPayloadBytes',s.payload_bytes,'rootDigest',s.root_digest))::text payload,
      null::uuid section_id,null::integer section_ordinal
    from imported i cross join lateral (
      select count(*) record_count,sum(octet_length(r.payload)) payload_bytes,
        encode(sha256(convert_to(string_agg(r.ordinal::text||':'||r.digest||chr(10),'' order by r.ordinal),'UTF8')),'hex') root_digest
      from private.imported_project_archive_records r where r.archive_id=i.id and r.section_id is null and r.kind<>'archive-section'
    ) s
    union all select r.ordinal,r.payload,
      case when r.section_id is not null or r.kind='archive-section' then r.section_id else (i.manifest->>'id')::uuid end,
      case when r.section_id is not null or r.kind='archive-section' then r.section_ordinal else r.ordinal end
    from imported i join private.imported_project_archive_records r on r.archive_id=i.id
  ), combined as (
    select 0 section_order,sequence,payload,null::uuid section_id,null::integer section_ordinal from current_records
    union all select 1,sequence,payload,section_id,section_ordinal from history
  )
  insert into private.project_archive_records(archive_id,ordinal,payload,digest,section_id,section_ordinal)
    select job.id,row_number() over(order by section_order,sequence),payload,encode(sha256(convert_to(payload,'UTF8')),'hex'),section_id,section_ordinal from combined;
  update private.project_archives set record_count=(select count(*) from private.project_archive_records where archive_id=job.id),
    payload_bytes=(select coalesce(sum(octet_length(payload)),0) from private.project_archive_records where archive_id=job.id)
    where id=job.id returning * into job;
  return jsonb_build_object('id',job.id,'projectId',job.project_id,'createdAt',job.created_at,
    'expiresAt',job.expires_at,'recordCount',job.record_count,'payloadBytes',job.payload_bytes,'formatVersion',job.format_version);
end $$;
revoke all on function public.create_project_archive(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.create_project_archive(uuid,uuid,uuid,jsonb) to service_role;
create or replace function public.project_archive_import_operation(p_user_id uuid,p_import_id uuid,p_action text,p_input jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job private.project_archive_imports%rowtype; item jsonb; manifest jsonb; record jsonb; source jsonb; original jsonb;
  old_record private.imported_project_archive_records%rowtype; project jsonb; files jsonb; digest text;
  next_index integer; bytes integer; file_count integer; source_bytes integer;
  record_section uuid; record_position integer; previous_record private.imported_project_archive_records%rowtype; section_metadata jsonb;
begin
  if p_user_id is null or p_import_id is null or p_action is null
    or p_action not in ('begin','read','upload','publish','cancel') or jsonb_typeof(p_input) is distinct from 'object'
    or octet_length(p_input::text)>4202496 then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,8));
  select * into job from private.project_archive_imports where id=p_import_id and user_id=p_user_id for update;
  if p_action='begin' then
    manifest:=p_input->'manifest';
    if p_input-array['manifest','digest']<>'{}' or coalesce(p_input->>'digest','') !~ '^[a-f0-9]{64}$'
      or not private.valid_project_archive_manifest(manifest)
      then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
    if job.id is not null then
      if job.manifest<>manifest or job.expected_digest<>p_input->>'digest' then raise exception 'ARCHIVE_IMPORT_CONFLICT'; end if;
    else
      if exists(select 1 from private.project_archive_imports where id=p_import_id) or exists(select 1 from public.projects where id=p_import_id)
        or exists(select 1 from private.source_imports where id=p_import_id) then raise exception 'ARCHIVE_IMPORT_CONFLICT'; end if;
      delete from private.project_archive_imports where user_id=p_user_id and expires_at<=clock_timestamp() and state<>'published';
      if exists(select 1 from private.project_archive_imports where user_id=p_user_id and state='uploading') then raise exception 'ARCHIVE_IMPORT_IN_PROGRESS'; end if;
      -- Reserve the complete size at begin, not only bytes uploaded so far.
      if (select coalesce(sum(i.expected_bytes),0) from private.project_archive_imports i join private.imported_project_archives a on a.id=i.id where i.user_id=p_user_id)
        +(manifest->>'payloadBytes')::integer>536870912 then raise exception 'ARCHIVE_STORAGE_LIMIT'; end if;
      insert into private.project_archive_imports(id,user_id,manifest,expected_digest,expected_count,expected_bytes)
        values(p_import_id,p_user_id,manifest,p_input->>'digest',(manifest->>'recordCount')::integer,(manifest->>'payloadBytes')::integer) returning * into job;
      insert into private.imported_project_archives(id,user_id) values(job.id,job.user_id);
    end if;
  elsif job.id is null then raise exception 'ARCHIVE_IMPORT_NOT_FOUND'; end if;
  if job.expires_at<=clock_timestamp() and job.state<>'published' and p_action<>'cancel' then raise exception 'ARCHIVE_IMPORT_EXPIRED'; end if;
  if p_action in ('read','publish','cancel') and p_input<>'{}' then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
  if p_action='cancel' and job.state='uploading' then
    delete from private.imported_project_archives where id=job.id;
    update private.project_archive_imports set state='cancelled',uploaded_count=0,uploaded_bytes=0,expires_at=clock_timestamp()+interval '1 day' where id=job.id returning * into job;
  elsif p_action in ('upload','publish') and job.state='cancelled' then raise exception 'ARCHIVE_IMPORT_CANCELLED';
  elsif p_action='upload' and job.state='published' then raise exception 'ARCHIVE_IMPORT_ALREADY_PUBLISHED';
  elsif p_action='upload' then
    if p_input-'records'<>'{}' or jsonb_typeof(p_input->'records') is distinct from 'array'
      or jsonb_array_length(p_input->'records') not between 1 and 20 then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
    for item in select value from jsonb_array_elements(p_input->'records') loop
      if jsonb_typeof(item) is distinct from 'object' or item-array['index','record','sha256','sectionId','sectionIndex']<>'{}'
        or jsonb_typeof(item->'index') is distinct from 'number' or coalesce(item->>'index','') !~ '^[1-9][0-9]{0,4}$' or (item->>'index')::integer>job.expected_count
        or jsonb_typeof(item->'record') is distinct from 'string' or octet_length(item->>'record')>2097152
        or coalesce(item->>'sha256','') !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
      if (item ? 'sectionId')<>(item ? 'sectionIndex') then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
      record_section:=null; record_position:=null;
      if item ? 'sectionId' then
        if job.manifest->>'version'<>'3' or coalesce(item->>'sectionId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
          or jsonb_typeof(item->'sectionIndex') is distinct from 'number' or coalesce(item->>'sectionIndex','') !~ '^[1-9][0-9]{0,4}$'
          then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
        record_section:=(item->>'sectionId')::uuid; record_position:=(item->>'sectionIndex')::integer;
        if record_position>50000 then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
      end if;
      digest:=encode(sha256(convert_to(item->>'record','UTF8')),'hex');
      if digest<>item->>'sha256' then raise exception 'ARCHIVE_DIGEST_MISMATCH'; end if;
      next_index:=(item->>'index')::integer;
      select * into old_record from private.imported_project_archive_records r where r.archive_id=job.id and r.ordinal=next_index;
      if found then
        if old_record.digest<>digest or old_record.payload<>item->>'record' or old_record.section_id is distinct from record_section or old_record.section_ordinal is distinct from record_position then raise exception 'ARCHIVE_IMPORT_CONFLICT'; end if;
        continue;
      end if;
      if next_index<>job.uploaded_count+1 then raise exception 'ARCHIVE_IMPORT_INCOMPLETE'; end if;
      begin record:=(item->>'record')::jsonb; exception when invalid_text_representation or untranslatable_character then raise exception 'INVALID_ARCHIVE_IMPORT'; end;
      if jsonb_typeof(record) is distinct from 'object' or record-array['kind','key','data']<>'{}'
        or record->>'kind' is null or record->>'kind' not in ('project','source','message','conflict','conflict-copy','submission','submission-source','submission-file','assessment','activity','portfolio-project','capture-status','archive-section')
        or jsonb_typeof(record->'key') is distinct from 'string' or char_length(record->>'key') not between 1 and 256
        or jsonb_typeof(record->'data') is distinct from 'object' then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
      select * into previous_record from private.imported_project_archive_records r where r.archive_id=job.id and r.ordinal=next_index-1;
      if record->>'kind'='archive-section' then
        if job.manifest->>'version'<>'3' or record_section is not null or next_index=1 or octet_length(item->>'record')>4096
          or not private.valid_project_archive_section(record->'data')
          or record->>'key' is distinct from lower(record->'data'->'manifest'->>'id')
          or record->>'key'=lower(job.manifest->>'id') then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
      elsif record_section is not null then
        if ((previous_record.kind='archive-section' and previous_record.record_key=record_section::text and record_position=1)
          or (previous_record.section_id=record_section and record_position=previous_record.section_ordinal+1)) is not true
          then raise exception 'ARCHIVE_IMPORT_INCOMPLETE'; end if;
        select r.payload::jsonb->'data' into section_metadata from private.imported_project_archive_records r
          where r.archive_id=job.id and r.section_id is null and r.kind='archive-section' and r.record_key=record_section::text;
        if section_metadata is null or record_position>(section_metadata->>'rootRecordCount')::integer then raise exception 'ARCHIVE_IMPORT_INCOMPLETE'; end if;
        if record_position=1 then
          if record->>'kind'<>'project' or record->>'key' is distinct from section_metadata->'manifest'->>'projectId'
            or record->'data'->>'id' is distinct from section_metadata->'manifest'->>'projectId' then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
        elsif record->>'kind'='project' then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
      else
        if previous_record.kind='archive-section' or previous_record.section_id is not null then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
        if next_index=1 then
          if record->>'kind'<>'project' or record->>'key' is distinct from job.manifest->>'projectId'
            or record->'data'->>'id' is distinct from job.manifest->>'projectId' then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
        elsif record->>'kind'='project' then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
      end if;
      if record->>'kind'='project' then
        original:=record->'data';
        if jsonb_typeof(original->'title') is distinct from 'string' or char_length(original->>'title') not between 1 and 100
          or jsonb_typeof(original->'language') is distinct from 'string' or char_length(original->>'language') not between 1 and 40 then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
      end if;
      if record->>'kind'='source' then
        source:=record->'data';
        if jsonb_typeof(source->'path') is distinct from 'string' or not private.safe_capture_path(source->>'path')
          or record->>'key'<>source->>'path' or jsonb_typeof(source->'content') is distinct from 'string'
          or octet_length(source->>'content')>262144 or jsonb_typeof(source->'deleted') is distinct from 'boolean'
          or (source->>'deleted'='true' and source->>'content'<>'') then raise exception 'INVALID_ARCHIVE_SOURCE'; end if;
      end if;
      if exists(select 1 from private.imported_project_archive_records r where r.archive_id=job.id and r.section_id is not distinct from record_section and r.kind=record->>'kind' and r.record_key=record->>'key') then raise exception 'ARCHIVE_IMPORT_CONFLICT'; end if;
      bytes:=octet_length(item->>'record');
      if job.uploaded_bytes+bytes>job.expected_bytes then raise exception 'ARCHIVE_IMPORT_LIMIT'; end if;
      insert into private.imported_project_archive_records(archive_id,ordinal,kind,record_key,payload,digest,section_id,section_ordinal)
        values(job.id,next_index,record->>'kind',record->>'key',item->>'record',digest,record_section,record_position);
      job.uploaded_count:=next_index; job.uploaded_bytes:=job.uploaded_bytes+bytes;
    end loop;
    update private.project_archive_imports set uploaded_count=job.uploaded_count,uploaded_bytes=job.uploaded_bytes where id=job.id;
  end if;
  if p_action='publish' and job.state='uploading' then
    if job.uploaded_count<>job.expected_count or job.uploaded_bytes<>job.expected_bytes then raise exception 'ARCHIVE_IMPORT_INCOMPLETE'; end if;
    select encode(sha256(convert_to(string_agg(r.ordinal::text||':'||r.digest||case when job.manifest->>'version'='3' then ':'||coalesce(r.section_id::text,'')||':'||coalesce(r.section_ordinal,0)::text else '' end||chr(10),'' order by r.ordinal),'UTF8')),'hex') into digest
      from private.imported_project_archive_records r where r.archive_id=job.id;
    if digest is distinct from job.expected_digest then raise exception 'ARCHIVE_DIGEST_MISMATCH'; end if;
    -- Validate all flat section totals/digests in one grouped scan. No partial
    -- section, metadata rewrite, orphan history, or recursive wrapper publishes.
    if exists(
      with sections as (
        select r.record_key id,r.payload::jsonb->'data' metadata from private.imported_project_archive_records r where r.archive_id=job.id and r.kind='archive-section'
      ), totals as (
        select r.section_id::text id,count(*) count,sum(octet_length(r.payload)) bytes,
          encode(sha256(convert_to(string_agg(r.section_ordinal::text||':'||r.digest||chr(10),'' order by r.section_ordinal),'UTF8')),'hex') digest
        from private.imported_project_archive_records r where r.archive_id=job.id and r.section_id is not null group by r.section_id
      )
      select 1 from sections s full join totals t on s.id=t.id
      where s.id is null or t.id is null or t.count<>(s.metadata->>'rootRecordCount')::integer
        or t.bytes<>(s.metadata->>'rootPayloadBytes')::integer or t.digest<>s.metadata->>'rootDigest'
    ) then raise exception 'ARCHIVE_IMPORT_INCOMPLETE'; end if;
    select payload::jsonb->'data' into original from private.imported_project_archive_records where archive_id=job.id and ordinal=1;
    select count(*),coalesce(sum(octet_length(payload::jsonb->'data'->>'content')),0),
      jsonb_agg(jsonb_build_object('path',record_key,'content',payload::jsonb->'data'->>'content','revision',0) order by record_key)
      into file_count,source_bytes,files from private.imported_project_archive_records where archive_id=job.id and section_id is null and kind='source' and payload::jsonb->'data'->>'deleted'='false';
    if file_count>200 or source_bytes>10485760 then raise exception 'ARCHIVE_IMPORT_LIMIT'; end if;
    if exists(select 1 from jsonb_array_elements(coalesce(files,'[]')) a cross join jsonb_array_elements(coalesce(files,'[]')) b
      where starts_with(a->>'path',(b->>'path')||'/')) then raise exception 'SOURCE_PATH_CONFLICT'; end if;
    insert into public.projects(id,user_id,title,language,mode,status)
      values(job.id,job.user_id,left(original->>'title',69)||' (imported)',original->>'language','playground','active');
    if file_count>0 then perform public.save_source_revision_batch(job.user_id,job.id,files,true); end if;
    update private.imported_project_archives set project_id=job.id where id=job.id;
    update private.project_archive_imports set state='published',project_id=job.id,expires_at=clock_timestamp()+interval '1 day' where id=job.id returning * into job;
  end if;
  if job.state='published' then
    select to_jsonb(p) into project from public.projects p where p.id=job.project_id and p.user_id=p_user_id;
    if project is null then raise exception 'IMPORTED_PROJECT_DELETED'; end if;
  end if;
  return jsonb_build_object('id',job.id,'state',job.state,'expiresAt',job.expires_at,'manifest',job.manifest,'digest',job.expected_digest,
    'uploadedRecords',job.uploaded_count,'uploadedBytes',job.uploaded_bytes,'project',project);
end $$;

create or replace function public.read_imported_project_archive(p_user_id uuid,p_project_id uuid,p_after integer default 0) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job private.project_archive_imports%rowtype; records jsonb; last_ordinal integer;
begin
  if p_user_id is null or p_project_id is null or p_after is null or p_after<0 or p_after>50000 then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
  select i.* into job from private.project_archive_imports i join private.imported_project_archives a on a.id=i.id
    where a.project_id=p_project_id and a.user_id=p_user_id and i.user_id=p_user_id and i.state='published';
  if not found then raise exception 'ARCHIVE_IMPORT_NOT_FOUND'; end if;
  if p_after>=job.expected_count then raise exception 'INVALID_ARCHIVE_IMPORT'; end if;
  with candidates as (
    select *,sum(octet_length(payload)) over(order by ordinal) as page_bytes,row_number() over(order by ordinal) as page_row
    from (select * from private.imported_project_archive_records where archive_id=job.id and ordinal>p_after order by ordinal limit 20) r
  ), page as (select * from candidates where page_bytes<=1048576 or page_row=1)
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('index',ordinal,'record',payload,'sha256',digest,'sectionId',section_id,'sectionIndex',section_ordinal)) order by ordinal),max(ordinal) into records,last_ordinal from page;
  return jsonb_build_object('id',job.id,'manifest',job.manifest,'digest',job.expected_digest,'provenance','imported-unverified',
    'records',records,'nextCursor',case when last_ordinal<job.expected_count then last_ordinal else null end);
end $$;

create or replace function public.read_project_archive(p_user_id uuid,p_project_id uuid,p_archive_id uuid,p_after integer default 0) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare job private.project_archives%rowtype; result jsonb;
begin
  select * into job from private.project_archives where id=p_archive_id and project_id=p_project_id and user_id=p_user_id;
  if not found then raise exception 'ARCHIVE_NOT_FOUND'; end if;
  if job.expires_at<=statement_timestamp() then raise exception 'ARCHIVE_EXPIRED'; end if;
  if p_after is null or p_after<0 or p_after>job.record_count then raise exception 'INVALID_ARCHIVE_CURSOR'; end if;
  -- A single payload is at most 2 MiB. JSON-string escaping in the response
  -- can approach twice that; all ordinary pages remain under 1 MiB payload.
  with page as (
    select ordinal,payload,digest,section_id,section_ordinal, sum(octet_length(payload)) over(order by ordinal) bytes
      from (select * from private.project_archive_records where archive_id=job.id and ordinal>p_after order by ordinal limit 20) r
  ) select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('index',ordinal,'record',payload,'sha256',digest,'sectionId',section_id,'sectionIndex',section_ordinal)) order by ordinal),'[]') into result
      from page where bytes<=1048576 or ordinal=p_after+1;
  return jsonb_build_object('id',job.id,'records',result,'nextCursor',case when p_after+jsonb_array_length(result)<job.record_count
    then p_after+jsonb_array_length(result) else null end);
end $$;

revoke all on function public.project_archive_import_operation(uuid,uuid,text,jsonb),public.read_imported_project_archive(uuid,uuid,integer),public.read_project_archive(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.project_archive_import_operation(uuid,uuid,text,jsonb),public.read_imported_project_archive(uuid,uuid,integer),public.read_project_archive(uuid,uuid,uuid,integer) to service_role;
