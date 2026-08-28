-- CodeTutor SaaS foundation. Source files are durable; sandbox processes are ephemeral.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  mode text not null default 'playground' check (mode in ('playground','practice','debug','challenge','project','dsa')),
  activity_id text check (char_length(activity_id) <= 128),
  language text not null default 'Any' check (char_length(language) between 1 and 40),
  status text not null default 'active' check (status in ('active','completed','archived')),
  imported_local_id text check (char_length(imported_local_id) <= 128),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, imported_local_id)
);
create index projects_user_updated_idx on public.projects(user_id, updated_at desc);

create table public.messages (
  project_id uuid not null,
  user_id uuid not null,
  id text not null check (char_length(id) between 1 and 128),
  role text not null check (role in ('user','assistant')),
  parts jsonb not null check (jsonb_typeof(parts) = 'array' and octet_length(parts::text) <= 1048576),
  model_id text,
  status text not null default 'pending' check (status in ('pending','complete','failed','interrupted')),
  request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(project_id,id),
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete cascade
);
create index messages_user_project_created_idx on public.messages(user_id,project_id,created_at,id);

create table public.source_files (
  project_id uuid not null,
  user_id uuid not null,
  path text not null check (char_length(path) between 1 and 240 and path !~ '(^/|\\\\|(^|/)\\.\\.(/|$)|[[:cntrl:]])'),
  content text not null check (octet_length(content) <= 262144),
  updated_at timestamptz not null default now(),
  primary key(project_id,path),
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete cascade
);
create index source_files_user_project_idx on public.source_files(user_id,project_id);

create table public.generated_activities (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (char_length(id) between 1 and 128),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and octet_length(manifest::text) <= 1048576),
  created_at timestamptz not null default now(),
  primary key(user_id,id)
);
create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  project_id uuid not null,
  activity_id text not null check (char_length(activity_id) between 1 and 128),
  score numeric not null check (score between 0 and 100),
  passed boolean not null,
  ai_assessed boolean not null,
  feedback jsonb not null check (jsonb_typeof(feedback) = 'array' and octet_length(feedback::text) <= 65536),
  concepts text[] not null default '{}',
  created_at timestamptz not null default now(),
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete cascade
);
create index assessments_user_activity_idx on public.assessments(user_id,activity_id,created_at desc);
create index assessments_project_user_idx on public.assessments(project_id,user_id);

create table public.portfolios (
  user_id uuid primary key references auth.users(id) on delete cascade,
  document jsonb not null default '{}' check (jsonb_typeof(document) = 'object' and octet_length(document::text) <= 2097152),
  updated_at timestamptz not null default now()
);

create table public.sandbox_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  project_id uuid not null,
  sandbox_id text unique check (char_length(sandbox_id) between 1 and 128),
  status text not null default 'creating' check (status in ('creating','running','stopping','stopped','expired','failed')),
  ports integer[] not null default '{3000}' check (cardinality(ports) between 1 and 4),
  preview_origin text check (preview_origin ~ '^https://[a-zA-Z0-9-]+\\.vercel\\.run$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete cascade,
  unique(id,user_id)
);
create index sandbox_sessions_user_status_idx on public.sandbox_sessions(user_id,status,expires_at);
create index sandbox_sessions_project_user_idx on public.sandbox_sessions(project_id,user_id);
create unique index sandbox_sessions_one_active_project_idx on public.sandbox_sessions(project_id)
  where status in ('creating','running','stopping');

create table public.command_audits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  sandbox_session_id uuid not null,
  command_id text,
  executable text not null check (char_length(executable) between 1 and 128),
  -- Arguments/output are intentionally not retained; they may contain secrets.
  background boolean not null default false,
  status text not null check (status in ('running','done','failed','cancelled')),
  exit_code integer,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key(sandbox_session_id,user_id) references public.sandbox_sessions(id,user_id) on delete cascade
);
create index command_audits_user_created_idx on public.command_audits(user_id,created_at desc);
create index command_audits_session_user_idx on public.command_audits(sandbox_session_id,user_id);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid,
  request_id uuid not null,
  kind text not null check (kind in ('chat','generation','assessment','sandbox','command','file')),
  model_id text,
  input_tokens bigint check (input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  duration_ms integer check (duration_ms >= 0),
  outcome text not null check (outcome in ('started','complete','failed','cancelled')),
  created_at timestamptz not null default now(),
  foreign key(project_id,user_id) references public.projects(id,user_id) on delete cascade,
  unique(user_id,request_id,kind)
);
create index usage_events_user_created_idx on public.usage_events(user_id,created_at desc);
create index usage_events_project_user_idx on public.usage_events(project_id,user_id);

create table private.rate_limit_buckets (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket_key text not null,
  window_start timestamptz not null,
  count integer not null check (count >= 0),
  primary key(user_id,bucket_key,window_start)
);
alter table private.rate_limit_buckets enable row level security;
revoke all on private.rate_limit_buckets from public,anon,authenticated;
grant select,insert,update,delete on private.rate_limit_buckets to service_role;

-- No user metadata or client-controlled identity is used in authorization.
do $$
declare table_name text;
begin
  foreach table_name in array array['projects','messages','source_files','generated_activities','assessments','portfolios','sandbox_sessions','command_audits','usage_events']
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select auth.uid()) = user_id)', table_name);
  end loop;
  foreach table_name in array array['projects','source_files','portfolios']
  loop
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', table_name);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', table_name);
  end loop;
end $$;
grant insert on public.projects to authenticated;
grant update(title,mode,activity_id,language,status,updated_at) on public.projects to authenticated;
grant insert,update on public.source_files,public.portfolios to authenticated;
grant delete on public.source_files to authenticated;
create policy owner_delete on public.source_files for delete to authenticated using ((select auth.uid()) = user_id);

-- Source quota is enforced under a per-project transaction lock, not just in JS.
create function private.enforce_source_quota() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare file_count bigint; total_bytes bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.project_id::text,0));
  select count(*), coalesce(sum(octet_length(content)),0)
    into file_count,total_bytes from public.source_files
    where project_id = new.project_id and path <> new.path;
  if file_count >= 200 or total_bytes + octet_length(new.content) > 10485760 then
    raise exception 'Source snapshot exceeds project limits' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function private.enforce_source_quota() from public,anon,authenticated;
create trigger source_quota before insert or update on public.source_files
  for each row execute function private.enforce_source_quota();

-- Only the trusted server can consume/reset usage counters. Users cannot select
-- a higher limit or write a forged sandbox ID by calling the public Data API.
create function public.consume_rate_limit(p_user_id uuid,p_bucket_key text,p_limit integer,p_window_seconds integer)
returns table(allowed boolean,remaining integer,reset_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare start_at timestamptz; current_count integer;
begin
  if p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 or length(p_bucket_key) > 80 then
    raise exception 'Invalid rate limit policy' using errcode='22023';
  end if;
  start_at := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into private.rate_limit_buckets(user_id,bucket_key,window_start,count)
    values(p_user_id,p_bucket_key,start_at,1)
    on conflict(user_id,bucket_key,window_start) do update
      set count=private.rate_limit_buckets.count+1
      where private.rate_limit_buckets.count < p_limit
    returning count into current_count;
  return query select current_count is not null,
    greatest(0,p_limit-coalesce(current_count,p_limit)),
    start_at + make_interval(secs=>p_window_seconds);
end $$;
revoke all on function public.consume_rate_limit(uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.consume_rate_limit(uuid,text,integer,integer) to service_role;
;
