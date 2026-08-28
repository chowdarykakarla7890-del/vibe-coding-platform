-- Temporary, consistent project archives. Not a new authority for source or
-- scores: originals are never updated/deleted by archive creation or cleanup.
create table private.project_archives (
  id uuid primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  project_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp()+interval '30 minutes',
  record_count integer not null default 0 check(record_count between 0 and 50000),
  payload_bytes bigint not null default 0 check(payload_bytes between 0 and 268435456),
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete cascade
);
create index project_archives_expiry_idx on private.project_archives(expires_at);
create index project_archives_project_idx on private.project_archives(project_id,user_id);
create table private.project_archive_records (
  archive_id uuid not null references private.project_archives(id) on delete cascade,
  ordinal integer not null check(ordinal between 1 and 50000),
  payload text not null check(octet_length(payload)<=2097152),
  digest text not null check(digest ~ '^[a-f0-9]{64}$'),
  primary key(archive_id,ordinal)
);
alter table private.project_archives enable row level security;
alter table private.project_archive_records enable row level security;
revoke all on private.project_archives,private.project_archive_records from public,anon,authenticated;
grant all on private.project_archives,private.project_archive_records to service_role;

-- Strip structured runtime credentials/identities without changing prose or
-- source strings. User-authored strings may themselves contain secrets; exports
-- are private user data, not a secret-detection guarantee or executable history.
create function private.archive_message_parts(value jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare result jsonb;
begin
  if jsonb_typeof(value)='array' then
    select coalesce(jsonb_agg(private.archive_message_parts(v) order by n),'[]') into result
      from jsonb_array_elements(value) with ordinality e(v,n);
    return result;
  elsif jsonb_typeof(value)='object' then
    select coalesce(jsonb_object_agg(k,private.archive_message_parts(v)),'{}') into result
      from jsonb_each(value) e(k,v)
      where lower(replace(k,'_','')) not in
        ('accesstoken','refreshtoken','authorization','capability','sandboxcapability','apikey','leasetoken','sandboxid','commandid','previewurl')
        and not (k='url' and jsonb_typeof(v)='string' and v#>>'{}' ~ '^https://[^/]+[.]vercel[.]run([/:]|$)');
    return result;
  end if;
  return value;
end $$;
revoke all on function private.archive_message_parts(jsonb) from public,anon,authenticated;
grant execute on function private.archive_message_parts(jsonb) to service_role;

create function public.create_project_archive(p_user_id uuid,p_project_id uuid,p_archive_id uuid,p_catalog jsonb default '[]') returns jsonb
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
      'expiresAt',job.expires_at,'recordCount',job.record_count,'payloadBytes',job.payload_bytes);
  end if;
  insert into private.project_archives(id,user_id,project_id) values(p_archive_id,p_user_id,p_project_id) returning * into job;

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
      'baseDigest',c.base_digest,'captured',c.captured_content,'capturedDigest',c.captured_digest,'saved',c.saved_content,'savedRevision',c.saved_revision,
      'reviewed',c.reviewed_content,'reviewedRevision',c.reviewed_revision,'resolutionChoice',c.resolution_choice,'resolutionRevision',c.resolution_revision,
      'resolutionDeleted',c.resolution_deleted,'createdAt',c.created_at,'resolvedAt',c.resolved_at)
      from public.source_capture_conflicts c where c.project_id=p_project_id and c.user_id=p_user_id
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
  insert into private.project_archive_records(archive_id,ordinal,payload,digest)
    select job.id,row_number() over(order by case when kind='project' then 0 else 1 end,kind,key),
      payload,encode(sha256(convert_to(payload,'UTF8')),'hex') from encoded;
  update private.project_archives set record_count=(select count(*) from private.project_archive_records where archive_id=job.id),
    payload_bytes=(select coalesce(sum(octet_length(payload)),0) from private.project_archive_records where archive_id=job.id)
    where id=job.id returning * into job;
  return jsonb_build_object('id',job.id,'projectId',job.project_id,'createdAt',job.created_at,
    'expiresAt',job.expires_at,'recordCount',job.record_count,'payloadBytes',job.payload_bytes);
end $$;

create function public.read_project_archive(p_user_id uuid,p_project_id uuid,p_archive_id uuid,p_after integer default 0) returns jsonb
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
    select ordinal,payload,digest, sum(octet_length(payload)) over(order by ordinal) bytes
      from (select * from private.project_archive_records where archive_id=job.id and ordinal>p_after order by ordinal limit 20) r
  ) select coalesce(jsonb_agg(jsonb_build_object('index',ordinal,'record',payload,'sha256',digest) order by ordinal),'[]') into result
      from page where bytes<=1048576 or ordinal=p_after+1;
  return jsonb_build_object('id',job.id,'records',result,'nextCursor',case when p_after+jsonb_array_length(result)<job.record_count
    then p_after+jsonb_array_length(result) else null end);
end $$;

create function public.delete_project_archive(p_user_id uuid,p_project_id uuid,p_archive_id uuid) returns boolean
language plpgsql security invoker set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,6));
  delete from private.project_archives where id=p_archive_id and project_id=p_project_id and user_id=p_user_id;
  return true;
end $$;

create function public.purge_project_archives() returns integer
language plpgsql security invoker set search_path='' as $$
declare removed integer;
begin
  with expired as (select id from private.project_archives where expires_at<=clock_timestamp() order by expires_at for update skip locked limit 5),
  deleted as (delete from private.project_archives where id in(select id from expired) returning id)
  select count(*) into removed from deleted;
  return removed;
end $$;

revoke all on function public.create_project_archive(uuid,uuid,uuid,jsonb),public.read_project_archive(uuid,uuid,uuid,integer),
  public.delete_project_archive(uuid,uuid,uuid),public.purge_project_archives() from public,anon,authenticated;
grant execute on function public.create_project_archive(uuid,uuid,uuid,jsonb),public.read_project_archive(uuid,uuid,uuid,integer),
  public.delete_project_archive(uuid,uuid,uuid),public.purge_project_archives() to service_role;
