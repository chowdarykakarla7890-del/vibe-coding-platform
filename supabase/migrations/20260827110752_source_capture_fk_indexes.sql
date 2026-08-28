-- Cover the complete ownership foreign keys used by audit/job cleanup.
-- This changes indexes only; source, jobs and preserved conflicts are retained.
create index source_capture_jobs_command_owner_idx
  on public.source_capture_jobs(id,sandbox_session_id,user_id);
create index source_capture_conflicts_job_owner_idx
  on public.source_capture_conflicts(capture_job_id,project_id,user_id);
-- The composite index retains the same capture_job_id lookup prefix.
drop index public.source_capture_conflicts_job_idx;
