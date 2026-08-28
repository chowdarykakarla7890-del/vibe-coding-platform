-- Transactional hosted regression: only synthetic users/projects; no session,
-- email, AI or sandbox. Every fixture and mutation is rolled back.
begin;
set local statement_timeout='30s';
do $$
#variable_conflict use_variable
declare
  owner_id uuid:=gen_random_uuid(); other_id uuid:=gen_random_uuid();
  project_id uuid; other_project uuid; submission jsonb; unprepared jsonb;
  compile_submission jsonb; closed_submission jsonb; source_digest text;
  plan jsonb; report jsonb; receipt jsonb; summary jsonb; repeated jsonb;
  bad jsonb; archive jsonb; role_name text; fn text; field text;
  manifest jsonb:='{"id":"dsa-python-two-sum","title":"Grading evidence fixture","concepts":["arrays"],"source":"curated"}';
begin
  assert (select relrowsecurity from pg_class where oid='private.submission_grading'::regclass),'Private evidence needs RLS';
  foreach role_name in array array['anon','authenticated'] loop
    assert not has_table_privilege(role_name,'private.submission_grading','SELECT,INSERT,UPDATE,DELETE'),'Browser can access raw evidence';
    foreach fn in array array[
      'public.prepare_submission_grading(uuid,uuid,jsonb)',
      'public.finish_submission_grading(uuid,uuid,text,jsonb)',
      'public.read_submission_grading_summary(uuid,uuid,uuid)',
      'private.submission_grading_summary(uuid,uuid)'
    ] loop
      assert not has_function_privilege(role_name,fn,'EXECUTE'),'Browser can call grading RPC';
      assert has_function_privilege('service_role',fn,'EXECUTE'),'Server cannot call grading RPC';
      assert not (select prosecdef from pg_proc where oid=fn::regprocedure),'Grading unexpectedly bypasses invoker permissions';
    end loop;
  end loop;

  insert into auth.users(id,email) values
    (owner_id,'grading-'||owner_id||'@example.invalid'),
    (other_id,'grading-'||other_id||'@example.invalid');
  insert into public.projects(user_id,title,activity_id,language)
    values(owner_id,'Disposable grading evidence',manifest->>'id','JavaScript') returning id into project_id;
  insert into public.projects(user_id,title,activity_id,language)
    values(other_id,'Disposable other owner',manifest->>'id','JavaScript') returning id into other_project;

  set local role service_role;
  perform public.save_source_revision_batch(owner_id,project_id,'[{"path":"main.js","content":"retained solution","revision":0}]');
  submission:=public.begin_activity_submission(owner_id,project_id,gen_random_uuid(),manifest,'JavaScript','test/model');
  unprepared:=public.begin_activity_submission(owner_id,project_id,gen_random_uuid(),manifest,'JavaScript','test/model');
  compile_submission:=public.begin_activity_submission(owner_id,project_id,gen_random_uuid(),manifest,'JavaScript','test/model');
  closed_submission:=public.begin_activity_submission(owner_id,project_id,gen_random_uuid(),manifest,'JavaScript','test/model');
  select digest into source_digest from public.submission_sources where id=(submission->>'source_id')::uuid;
  plan:=jsonb_build_object('version',1,'checkVersion','test-v1','activityId',manifest->>'id','language','JavaScript',
    'sourceDigest',source_digest,'harnessDigest',repeat('b',64),'runtimeDigest',repeat('c',64),
    'cases',(select jsonb_agg(jsonb_build_object('input',jsonb_build_object('hidden','PRIVATE_CASE_SENTINEL','n',n),'label','Check '||n)) from generate_series(1,24) n));
  report:=jsonb_build_object('compileFailure',null,'cases',
    (select jsonb_agg(jsonb_build_object('output','PRIVATE_OUTPUT_SENTINEL','failure',null,'passed',n<=23)) from generate_series(1,24) n));

  begin
    perform public.record_submission_assessment(owner_id,(unprepared->>'id')::uuid,100,true,false,'[]','command');
    raise exception 'Trusted score accepted without plan';
  exception when raise_exception then if sqlerrm<>'GRADING_EVIDENCE_REQUIRED' then raise; end if; end;
  begin
    perform public.prepare_submission_grading(other_id,(submission->>'id')::uuid,plan);
    raise exception 'Another user prepared evidence';
  exception when raise_exception then if sqlerrm<>'SUBMISSION_NOT_FOUND' then raise; end if; end;
  foreach field in array array['sourceDigest','activityId','language'] loop
    bad:=jsonb_set(plan,array[field],to_jsonb(case when field='sourceDigest' then repeat('f',64) else 'mismatch' end));
    begin
      perform public.prepare_submission_grading(owner_id,(submission->>'id')::uuid,bad);
      raise exception 'Accepted mismatched plan';
    exception when raise_exception then if sqlerrm<>'GRADING_PLAN_MISMATCH' then raise; end if; end;
  end loop;
  foreach bad in array array[
    plan-'checkVersion',jsonb_set(plan,'{checkVersion}','123'),
    jsonb_set(plan,'{harnessDigest}',to_jsonb(repeat('1',64)::numeric)),
    jsonb_set(plan,'{cases}','[]'),plan||'{"unexpected":true}',
    jsonb_set(plan,'{cases,0,label}','null'),jsonb_set(plan,'{cases,0}',plan->'cases'->0||'{"extra":1}'),
    jsonb_set(plan,'{cases,0,input}',to_jsonb(repeat('x',131072)))
  ] loop
    begin
      perform public.prepare_submission_grading(owner_id,(submission->>'id')::uuid,bad);
      raise exception 'Accepted malformed plan';
    exception when raise_exception then if sqlerrm<>'INVALID_GRADING_PLAN' then raise; end if; end;
  end loop;

  receipt:=public.prepare_submission_grading(owner_id,(submission->>'id')::uuid,plan);
  assert receipt->>'planDigest'=encode(sha256(convert_to(plan::text,'UTF8')),'hex'),'Canonical digest mismatch';
  assert (select e.plan=plan from private.submission_grading e where e.submission_id=(submission->>'id')::uuid),'Cases not retained exactly';
  assert public.prepare_submission_grading(owner_id,(submission->>'id')::uuid,plan)=receipt,'Plan retry not idempotent';
  summary:=public.read_submission_grading_summary(owner_id,project_id,(submission->>'id')::uuid);
  assert summary->>'status'='prepared' and summary->'passedCount'='null' and summary->'outcomes'='[]','Prepared summary implies a result';
  assert summary->>'sourceDigest'=source_digest;
  begin
    perform public.record_submission_assessment(owner_id,(submission->>'id')::uuid,100,true,false,'[]','command');
    raise exception 'Trusted score accepted before report';
  exception when raise_exception then if sqlerrm<>'GRADING_EVIDENCE_REQUIRED' then raise; end if; end;
  begin
    perform public.prepare_submission_grading(owner_id,(submission->>'id')::uuid,jsonb_set(plan,'{cases,0,input}','"different"'));
    raise exception 'Plan retry replaced checks';
  exception when raise_exception then if sqlerrm<>'GRADING_PLAN_MISMATCH' then raise; end if; end;
  begin
    update private.submission_grading set plan_digest=repeat('d',64) where submission_id=(submission->>'id')::uuid;
    raise exception 'Digest was editable';
  exception when raise_exception then if sqlerrm<>'GRADING_EVIDENCE_IMMUTABLE' then raise; end if; end;
  begin
    update private.submission_grading set plan=plan||'{"extra":1}' where submission_id=(submission->>'id')::uuid;
    raise exception 'Cases were editable';
  exception when raise_exception then if sqlerrm<>'GRADING_EVIDENCE_IMMUTABLE' then raise; end if; end;
  begin
    update private.submission_grading set user_id=other_id where submission_id=(submission->>'id')::uuid;
    raise exception 'Owner was editable';
  exception when raise_exception then if sqlerrm<>'GRADING_EVIDENCE_IMMUTABLE' then raise; end if; end;

  foreach bad in array array[
    report-'compileFailure',report||'{"extra":true}',jsonb_set(report,'{cases}','[]'),
    jsonb_set(report,'{compileFailure}','"unknown"'),jsonb_set(report,'{compileFailure}','"timeout"'),
    jsonb_set(report,'{cases,0,passed}','"true"'),jsonb_set(report,'{cases,0,failure}','"timeout"'),
    jsonb_set(report,'{cases,0,output}','null'),jsonb_set(report,'{cases,0,output}',to_jsonb(repeat('x',8193))),
    jsonb_set(report,'{cases,0}',report->'cases'->0||'{"extra":true}'),
    jsonb_build_object('compileFailure',null,'cases',(select jsonb_agg(jsonb_build_object('output',repeat('x',8192),'failure',null,'passed',false)) from generate_series(1,24)))
  ] loop
    begin
      perform public.finish_submission_grading(owner_id,(submission->>'id')::uuid,receipt->>'planDigest',bad);
      raise exception 'Accepted malformed report';
    exception when raise_exception then if sqlerrm<>'INVALID_GRADING_REPORT' then raise; end if; end;
  end loop;
  begin
    perform public.finish_submission_grading(other_id,(submission->>'id')::uuid,receipt->>'planDigest',report);
    raise exception 'Another user finished evidence';
  exception when raise_exception then if sqlerrm<>'SUBMISSION_NOT_FOUND' then raise; end if; end;
  begin
    perform public.finish_submission_grading(owner_id,(submission->>'id')::uuid,repeat('f',64),report);
    raise exception 'Report accepted wrong plan';
  exception when raise_exception then if sqlerrm<>'GRADING_PLAN_MISMATCH' then raise; end if; end;
  summary:=public.finish_submission_grading(owner_id,(submission->>'id')::uuid,receipt->>'planDigest',report);
  assert summary->>'status'='complete' and summary->>'passedCount'='23' and summary->'outcomes'->>23='wrong-answer';
  assert (select e.report=report from private.submission_grading e where e.submission_id=(submission->>'id')::uuid),'Outputs not retained exactly';
  assert public.finish_submission_grading(owner_id,(submission->>'id')::uuid,receipt->>'planDigest',report)=summary,'Report retry not idempotent';
  assert summary::text not like '%PRIVATE_%','Summary exposed hidden input or output';
  begin
    perform public.finish_submission_grading(owner_id,(submission->>'id')::uuid,receipt->>'planDigest',jsonb_set(report,'{cases,0,output}','"changed"'));
    raise exception 'Completed report changed';
  exception when raise_exception then if sqlerrm<>'GRADING_EVIDENCE_IMMUTABLE' then raise; end if; end;
  begin
    update private.submission_grading set report=null,completed_at=null where submission_id=(submission->>'id')::uuid;
    raise exception 'Completed report was erased';
  exception when raise_exception then if sqlerrm<>'GRADING_EVIDENCE_IMMUTABLE' then raise; end if; end;
  begin
    perform public.record_submission_assessment(owner_id,(submission->>'id')::uuid,100,true,false,'[]','command');
    raise exception 'Inflated score accepted';
  exception when raise_exception then if sqlerrm<>'GRADING_SCORE_MISMATCH' then raise; end if; end;
  begin
    perform public.record_submission_assessment(owner_id,(submission->>'id')::uuid,95,true,false,'[]','command');
    raise exception 'Partial score awarded completion';
  exception when raise_exception then if sqlerrm<>'GRADING_SCORE_MISMATCH' then raise; end if; end;
  repeated:=public.record_submission_assessment(owner_id,(submission->>'id')::uuid,95,false,false,'["23/24 checks"]','command');
  assert public.record_submission_assessment(owner_id,(submission->>'id')::uuid,95,false,false,'["23/24 checks"]','command')=repeated;
  assert (select state from public.activity_submissions where id=(submission->>'id')::uuid)='complete';

  repeated:=public.prepare_submission_grading(owner_id,(compile_submission->>'id')::uuid,plan);
  repeated:=public.finish_submission_grading(owner_id,(compile_submission->>'id')::uuid,repeated->>'planDigest','{"compileFailure":"execution-error","cases":[]}');
  assert repeated->>'passedCount'='0' and repeated->'outcomes'='[]';
  perform public.record_submission_assessment(owner_id,(compile_submission->>'id')::uuid,0,false,false,'["Did not compile"]','command');
  perform public.fail_activity_submission(owner_id,(closed_submission->>'id')::uuid,'TEST_CANCELLED');
  begin
    perform public.prepare_submission_grading(owner_id,(closed_submission->>'id')::uuid,plan);
    raise exception 'Closed submission accepted new plan';
  exception when raise_exception then if sqlerrm<>'SUBMISSION_CLOSED' then raise; end if; end;
  assert public.read_submission_grading_summary(owner_id,project_id,(unprepared->>'id')::uuid) is null,'Legacy/no-plan history must remain readable';
  begin
    perform public.read_submission_grading_summary(other_id,project_id,(submission->>'id')::uuid);
    raise exception 'Another user read summary';
  exception when raise_exception then if sqlerrm<>'SUBMISSION_NOT_FOUND' then raise; end if; end;
  begin
    perform public.read_submission_grading_summary(owner_id,other_project,(submission->>'id')::uuid);
    raise exception 'Summary accepted wrong project';
  exception when raise_exception then if sqlerrm<>'SUBMISSION_NOT_FOUND' then raise; end if; end;

  archive:=public.create_project_archive(owner_id,project_id,gen_random_uuid());
  assert exists(select 1 from private.project_archive_records r where r.archive_id=(archive->>'id')::uuid
    and r.payload::jsonb->>'kind'='submission' and r.payload::jsonb->'data'->'gradingSummary'=summary),'Archive omitted safe grading summary';
  assert not exists(select 1 from private.project_archive_records r where r.archive_id=(archive->>'id')::uuid and r.payload like '%PRIVATE_%'),'Archive leaked private evidence';

  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  set local role authenticated;
  assert exists(select 1 from public.activity_submissions s where s.id=(submission->>'id')::uuid),'Owner cannot read retained submission';
  begin perform 1 from private.submission_grading;
    raise exception 'Even owner can directly read hidden cases';
  exception when insufficient_privilege then null; end;
  begin perform public.read_submission_grading_summary(owner_id,project_id,(submission->>'id')::uuid);
    raise exception 'Browser directly called server RPC';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other_id,'role','authenticated')::text,true);
  set local role authenticated;
  assert not exists(select 1 from public.activity_submissions s where s.id=(submission->>'id')::uuid),'RLS leaked submission to another user';
  reset role;

  delete from public.projects p where p.id=project_id and p.user_id=owner_id;
  assert not exists(select 1 from private.submission_grading e where e.submission_id=(submission->>'id')::uuid),'Project deletion did not cascade evidence';
  assert exists(select 1 from public.projects p where p.id=other_project),'Deletion touched another owner';
end $$;
rollback;
select 'PASS: grading evidence ownership, private grants/RLS, validation, idempotence, immutability, score matching, safe archives and cascade deletion' as result;
