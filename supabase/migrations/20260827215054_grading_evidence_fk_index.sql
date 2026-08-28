-- Cover the complete submission/project/account foreign key without changing
-- the private evidence table's default-deny access controls.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create index submission_grading_submission_owner_idx
  on private.submission_grading (submission_id, project_id, user_id);
