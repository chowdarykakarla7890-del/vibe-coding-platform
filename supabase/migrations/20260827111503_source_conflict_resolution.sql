-- Resolution commits under the same project lock as source saves/capture.
-- Original captured/saved copies remain intact; only server RPCs can resolve.
alter table public.source_capture_conflicts
  add column resolution_choice text check(resolution_choice in ('saved','captured','merged')),
  add column resolution_fingerprint text check(resolution_fingerprint ~ '^[a-f0-9]{64}$'),
  add column resolution_revision integer check(resolution_revision >= 0),
  add column resolution_deleted boolean,
  add column reviewed_revision integer check(reviewed_revision >= 0),
  add column reviewed_content text check(octet_length(reviewed_content) <= 262144),
  add constraint complete_source_resolution check(
    (resolved_at is null and resolution_choice is null and resolution_fingerprint is null
      and resolution_revision is null and resolution_deleted is null and reviewed_revision is null and reviewed_content is null)
    or (resolved_at is not null and resolution_choice is not null and resolution_fingerprint is not null
      and resolution_revision is not null and resolution_deleted is not null and reviewed_revision is not null));
create index source_capture_conflicts_resolved_fingerprint_idx
  on public.source_capture_conflicts(project_id,path,fingerprint) where resolved_at is not null;

create function public.resolve_source_conflict(p_user_id uuid,p_project_id uuid,p_conflict_id uuid,
  p_revision integer,p_choice text,p_content text default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare conflict public.source_capture_conflicts%rowtype; saved public.source_files%rowtype;
  fingerprint text; receipt jsonb; next_revision integer; next_deleted boolean;
begin
  if p_user_id is null or p_project_id is null or p_conflict_id is null or p_revision is null or p_revision<0
    or p_choice is null or p_choice not in ('saved','captured','merged')
    or (p_choice='merged' and (p_content is null or octet_length(p_content)>262144))
    or (p_choice<>'merged' and p_content is not null) then
    raise exception 'INVALID_RESOLUTION' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,0));
  perform 1 from public.projects where id=p_project_id and user_id=p_user_id for key share;
  if not found then raise exception 'PROJECT_NOT_FOUND'; end if;
  select * into conflict from public.source_capture_conflicts
    where id=p_conflict_id and project_id=p_project_id and user_id=p_user_id for update;
  if not found then raise exception 'SOURCE_REVIEW_NOT_FOUND'; end if;
  fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_revision,p_choice,p_content)::text,'UTF8')),'hex');
  if conflict.resolved_at is not null then
    if conflict.resolution_fingerprint is distinct from fingerprint then raise exception 'SOURCE_REVIEW_RESOLVED'; end if;
    -- A lost response is a replay, not another write against newer source.
    return jsonb_build_object('id',conflict.id,'path',conflict.path,'choice',conflict.resolution_choice,
      'revision',conflict.resolution_revision,'deleted',conflict.resolution_deleted);
  end if;
  if not private.safe_capture_path(conflict.path) then raise exception 'INVALID_RESOLUTION'; end if;
  select * into saved from public.source_files where project_id=p_project_id and user_id=p_user_id and path=conflict.path;
  -- Require the exact reviewed revision even if its contents happen to match.
  if coalesce(saved.revision,0)<>p_revision then raise exception 'SOURCE_CONFLICT'; end if;
  next_revision:=coalesce(saved.revision,0);
  next_deleted:=saved.revision is null or saved.deleted;
  if p_choice<>'saved' then
    next_deleted:=p_choice='captured' and conflict.captured_content is null;
    receipt:=public.save_source_revision_batch(p_user_id,p_project_id,jsonb_build_array(jsonb_build_object(
      'path',conflict.path,'content',case when p_choice='merged' then p_content else coalesce(conflict.captured_content,'') end,
      'revision',p_revision,'deleted',next_deleted)),false);
    next_revision:=(receipt->0->>'revision')::integer;
  end if;
  update public.source_capture_conflicts set resolved_at=now(), resolution_choice=p_choice,
    resolution_fingerprint=fingerprint,resolution_revision=next_revision,resolution_deleted=next_deleted,
    reviewed_revision=p_revision,reviewed_content=case when saved.deleted then null else saved.content end where id=conflict.id;
  return jsonb_build_object('id',conflict.id,'path',conflict.path,'choice',p_choice,'revision',next_revision,'deleted',next_deleted);
end $$;
revoke all on function public.resolve_source_conflict(uuid,uuid,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.resolve_source_conflict(uuid,uuid,uuid,integer,text,text) to service_role;

create or replace function public.reconcile_source_capture(p_job_id uuid,p_lease_token uuid,p_capture jsonb,p_terminal boolean default false) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job public.source_capture_jobs%rowtype; project uuid; e jsonb; saved public.source_files%rowtype;
  changes jsonb:='[]'; writes jsonb:='[]'; acks jsonb:='[]'; receipts jsonb;
  conflict boolean:=false; reason text:='revision_conflict'; digest text; saved_digest text; receipt_digest text;
begin
  select project_id into project from public.source_capture_jobs where id=p_job_id;
  if not found then raise exception 'CAPTURE_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended(project::text,0));
  perform 1 from public.projects where id=project for key share;
  select * into job from public.source_capture_jobs where id=p_job_id for update;
  if not found then raise exception 'CAPTURE_NOT_FOUND'; end if;
  if p_lease_token is null or job.lease_token is distinct from p_lease_token or job.lease_until<=now()
    or job.state not in ('capturing','acknowledging') then raise exception 'CAPTURE_LEASE_LOST'; end if;
  perform private.validate_source_capture(p_capture);
  if p_terminal is null or (p_terminal and exists(select 1 from public.command_audits where id=job.id and status in ('starting','running','unknown'))) then
    raise exception 'CAPTURE_COMMAND_RUNNING';
  end if;
  receipt_digest:=encode(sha256(convert_to(p_capture::text,'UTF8')),'hex');
  if job.state='acknowledging' then
    if job.capture_digest is distinct from receipt_digest then raise exception 'CAPTURE_ALREADY_RECONCILED'; end if;
    return jsonb_build_object('acknowledgements',job.acknowledgements,'conflicted',job.has_conflicts,'complete',job.capture_complete);
  end if;
  for e in select value from jsonb_array_elements(p_capture->'entries') loop
    if e->>'kind'='skipped' then continue; end if;
    digest:=case when e->>'kind'='file' then e->>'digest' else null end;
    -- An unchanged old VM copy is not evidence that a newer DB save is wrong.
    if not (e->>'pending')::boolean and digest is not distinct from e->>'baseDigest' then continue; end if;
    -- Missing with no confirmed baseline is uncertainty, not proof of deletion.
    if e->>'kind'='missing' and e->>'baseDigest' is null then continue; end if;
    -- A reviewed exact VM version is not a new conflict. Different bytes,
    -- baselines, or sandbox sessions have a different fingerprint and are reviewed again.
    if exists(select 1 from public.source_capture_conflicts
      where project_id=project and user_id=job.user_id and path=e->>'path' and resolved_at is not null
        and fingerprint=encode(sha256(convert_to(jsonb_build_array(job.sandbox_session_id,e->>'baseRevision',e->>'baseDigest',e->>'kind',e->>'digest')::text,'UTF8')),'hex')) then continue; end if;
    changes:=changes||jsonb_build_array(e);
    select * into saved from public.source_files where project_id=project and user_id=job.user_id and path=e->>'path';
    saved_digest:=case when saved.revision is null or saved.deleted then null else encode(sha256(convert_to(saved.content,'UTF8')),'hex') end;
    if (e->>'pending')::boolean or e->>'baseRevision' is null then
      conflict:=true; reason:='uncertain_baseline';
    elsif not (
      (coalesce(saved.revision,0)=(e->>'baseRevision')::integer and saved_digest is not distinct from e->>'baseDigest')
      or (coalesce(saved.revision,0)>=(e->>'baseRevision')::integer and saved_digest is not distinct from digest)
    ) then conflict:=true;
    end if;
    writes:=writes||jsonb_build_array(jsonb_build_object('path',e->>'path','content',coalesce(e->>'content',''),
      'revision',coalesce((e->>'baseRevision')::integer,0),'deleted',e->>'kind'='missing'));
  end loop;
  if not conflict and jsonb_array_length(writes)>0 then
    begin
      receipts:=public.save_source_revision_batch(job.user_id,project,writes,false);
    exception
      when check_violation then conflict:=true; reason:='source_limit';
      when raise_exception then
        if sqlerrm='SOURCE_PATH_CONFLICT' then conflict:=true; reason:='path_conflict';
        elsif sqlerrm in ('SOURCE_CONFLICT','SOURCE_REVISION_EXHAUSTED') then conflict:=true; reason:='batch_conflict';
        else raise; end if;
    end;
  end if;
  if conflict then
    -- Preserve the entire changed batch if any entry conflicts (atomic renames).
    -- Never let successful siblings hide an unresolved overwrite/deletion.
    for e in select value from jsonb_array_elements(changes) loop
      select * into saved from public.source_files where project_id=project and user_id=job.user_id and path=e->>'path';
      insert into public.source_capture_conflicts(user_id,project_id,capture_job_id,path,base_revision,base_digest,
        captured_content,captured_digest,saved_revision,saved_content,fingerprint,reason)
      values(job.user_id,project,job.id,e->>'path',(e->>'baseRevision')::integer,e->>'baseDigest',
        case when e->>'kind'='file' then e->>'content' else null end,
        case when e->>'kind'='file' then e->>'digest' else null end,
        coalesce(saved.revision,0),case when saved.deleted then null else saved.content end,
        encode(sha256(convert_to(jsonb_build_array(job.sandbox_session_id,e->>'baseRevision',e->>'baseDigest',e->>'kind',e->>'digest')::text,'UTF8')),'hex'),reason)
      on conflict(project_id,path,fingerprint) where resolved_at is null do nothing;
    end loop;
    if (select count(*)>400 or coalesce(sum(coalesce(octet_length(captured_content),0)+coalesce(octet_length(saved_content),0)),0)>20971520
      from public.source_capture_conflicts where project_id=project and resolved_at is null) then
      raise exception 'SOURCE_REVIEW_REQUIRED';
    end if;
  elsif receipts is not null then
    select coalesce(jsonb_agg(jsonb_build_object('path',r.value->>'path','revision',(r.value->>'revision')::integer,
      'digest',e.value->>'digest') order by r.value->>'path'),'[]') into acks
      from jsonb_array_elements(receipts) r(value) join jsonb_array_elements(changes) e(value) on r.value->>'path'=e.value->>'path';
  end if;
  update public.source_capture_jobs set state='acknowledging',acknowledgements=acks,capture_digest=receipt_digest,
    capture_complete=(p_capture->>'complete')::boolean,capture_terminal=p_terminal,has_conflicts=conflict,captured_at=now(),updated_at=now(),failures=0,
    failure_code=case when conflict then 'source_conflict' when not (p_capture->>'complete')::boolean then 'incomplete_source' else null end
    where id=job.id;
  return jsonb_build_object('acknowledgements',acks,'conflicted',conflict,'complete',(p_capture->>'complete')::boolean);
end $$;
revoke all on function public.reconcile_source_capture(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.reconcile_source_capture(uuid,uuid,jsonb,boolean) to service_role;
