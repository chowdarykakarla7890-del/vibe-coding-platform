-- Learning history is server-authored and account-scoped. Preserve old rows;
-- provenance fields remain nullable for records created before this migration.
alter table public.assessments add column model_id text;
alter table public.assessments add column verification_kind text
  check (verification_kind in ('command','rubric'));
alter table public.assessments add column language text check (char_length(language)<=40);

-- Keep the legacy lesson-progress table intact; this is a projection of
-- independently verified assessment records, never client-written progress.
create view public.assessment_progress with (security_invoker=true, security_barrier=true) as
select a.user_id,a.activity_id,count(*)::integer as attempts,
  bool_or(a.passed) as completed,max(a.score) as best_score,max(a.created_at) as updated_at,
  array(select distinct concept from public.assessments c
    cross join lateral unnest(c.concepts) as concept
    where c.user_id=a.user_id and c.activity_id=a.activity_id and c.passed
    order by concept) as concepts
from public.assessments a group by a.user_id,a.activity_id;
revoke all on public.assessment_progress from public,anon,authenticated;
grant select on public.assessment_progress to authenticated,service_role;

create function public.record_assessment(
  p_user_id uuid,p_project_id uuid,p_assessment_id uuid,p_activity_id text,
  p_score integer,p_passed boolean,p_ai_assessed boolean,p_feedback jsonb,p_concepts text[],
  p_model_id text,p_verification_kind text,p_language text
) returns uuid language plpgsql security invoker set search_path='' as $$
begin
  if p_assessment_id is null or p_score is null or p_score not between 0 and 100
    or p_passed is null or p_ai_assessed is null or (p_passed and p_score<70)
    or jsonb_typeof(p_feedback) is distinct from 'array' or octet_length(p_feedback::text)>65536
    or p_concepts is null or cardinality(p_concepts)>10
    or p_verification_kind not in ('command','rubric') or p_verification_kind is null then
    raise exception 'INVALID_ASSESSMENT' using errcode='22023';
  end if;
  perform 1 from public.projects where id=p_project_id and user_id=p_user_id and activity_id=p_activity_id for update;
  if not found then raise exception 'ACTIVITY_PROJECT_NOT_FOUND' using errcode='P0001'; end if;
  if exists(select 1 from public.assessments where id=p_assessment_id) then
    if not exists(select 1 from public.assessments where id=p_assessment_id and user_id=p_user_id and project_id=p_project_id) then
      raise exception 'ASSESSMENT_CONFLICT' using errcode='P0001';
    end if;
    return p_assessment_id;
  end if;
  insert into public.assessments(id,user_id,project_id,activity_id,score,passed,ai_assessed,feedback,concepts,model_id,verification_kind,language)
    values(p_assessment_id,p_user_id,p_project_id,p_activity_id,p_score,p_passed,p_ai_assessed,p_feedback,p_concepts,p_model_id,p_verification_kind,p_language);
  update public.projects set updated_at=now(),status=case when p_passed then 'completed' else status end
    where id=p_project_id and user_id=p_user_id;
  return p_assessment_id;
end $$;
revoke all on function public.record_assessment(uuid,uuid,uuid,text,integer,boolean,boolean,jsonb,text[],text,text,text) from public,anon,authenticated;
grant execute on function public.record_assessment(uuid,uuid,uuid,text,integer,boolean,boolean,jsonb,text[],text,text,text) to service_role;
