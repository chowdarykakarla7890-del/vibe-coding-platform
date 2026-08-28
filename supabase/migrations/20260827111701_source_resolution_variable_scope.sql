-- Qualify the decision digest separately from the table's capture fingerprint.
create or replace function public.resolve_source_conflict(p_user_id uuid,p_project_id uuid,p_conflict_id uuid,
  p_revision integer,p_choice text,p_content text default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare conflict public.source_capture_conflicts%rowtype; saved public.source_files%rowtype;
  decision_digest text; receipt jsonb; next_revision integer; next_deleted boolean;
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
  decision_digest:=encode(sha256(convert_to(jsonb_build_array(p_revision,p_choice,p_content)::text,'UTF8')),'hex');
  if conflict.resolved_at is not null then
    if conflict.resolution_fingerprint is distinct from decision_digest then raise exception 'SOURCE_REVIEW_RESOLVED'; end if;
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
    resolution_fingerprint=decision_digest,resolution_revision=next_revision,resolution_deleted=next_deleted,
    reviewed_revision=p_revision,reviewed_content=case when saved.deleted then null else saved.content end where id=conflict.id;
  return jsonb_build_object('id',conflict.id,'path',conflict.path,'choice',p_choice,'revision',next_revision,'deleted',next_deleted);
end $$;
revoke all on function public.resolve_source_conflict(uuid,uuid,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.resolve_source_conflict(uuid,uuid,uuid,integer,text,text) to service_role;
