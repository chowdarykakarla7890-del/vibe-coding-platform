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
  insert into private.project_archive_records(archive_id,ordinal,payload,digest)
    select job.id,row_number() over(order by case when kind='project' then 0 else 1 end,kind,key),
      payload,encode(sha256(convert_to(payload,'UTF8')),'hex') from encoded;
  update private.project_archives set record_count=(select count(*) from private.project_archive_records where archive_id=job.id),
    payload_bytes=(select coalesce(sum(octet_length(payload)),0) from private.project_archive_records where archive_id=job.id)
    where id=job.id returning * into job;
  return jsonb_build_object('id',job.id,'projectId',job.project_id,'createdAt',job.created_at,
    'expiresAt',job.expires_at,'recordCount',job.record_count,'payloadBytes',job.payload_bytes);
end $$;
revoke all on function public.create_project_archive(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.create_project_archive(uuid,uuid,uuid,jsonb) to service_role;
