-- The VM workspace contains tool-home directories. Exclude these from source
-- capture, including credential configuration and histories. No saved source
-- rows are deleted by this migration.
create or replace function private.safe_capture_path(path text) returns boolean
language sql immutable security invoker set search_path='' as $$
  select path is not null and char_length(path) between 1 and 240
    and path not like '/%' and path not like '%/' and path not like '%//%'
    and position(chr(92) in path)=0 and path !~ '[[:cntrl:]]'
    and not exists(select 1 from unnest(string_to_array(path,'/')) as segments(part) where
      part in ('.','..','.aws','.cache','.config','.git','.gnupg','.next','.ssh','.turbo','build','coverage','dist','node_modules','out',
        '.codex','.claude','.local','.npm','.pnpm-store','.bun','.cargo','.rustup','.m2','.gradle',
        '.venv','venv','__pycache__','.pytest_cache','.mypy_cache','.ruff_cache','.yarn',
        '.npmrc','.yarnrc','.yarnrc.yml','.netrc','.pypirc','.git-credentials','.gitconfig',
        '.bash_history','.zsh_history','.python_history','.node_repl_history','.sudo_as_admin_successful',
        '.bashrc','.bash_profile','.profile','.zshrc','.zprofile','.wget-hsts','.lesshst','.viminfo',
        'id_rsa','id_ed25519','id_ecdsa','.env') or starts_with(part,'.codetutor-'))
    and (path !~ '(^|/)[.]env([.]|$)' or path ~ '(^|/)[.]env[.]example$')
    and path !~* '[.](7z|avi|bin|bmp|class|db|dll|dmg|doc|docx|eot|exe|gif|gz|ico|jar|jpeg|jpg|lockb|mov|mp3|mp4|o|otf|pdf|png|so|sqlite|tar|ttf|p12|pem|pfx|key|wav|webm|webp|woff|woff2|xls|xlsx|zip)$';
$$;
revoke all on function private.safe_capture_path(text) from public,anon,authenticated;
grant execute on function private.safe_capture_path(text) to service_role;

create or replace function private.enqueue_command_capture() returns trigger
language plpgsql security invoker set search_path='' as $$
declare project uuid; baseline jsonb;
begin
  select project_id into strict project from public.sandbox_sessions where id=new.sandbox_session_id and user_id=new.user_id;
  perform pg_advisory_xact_lock(hashtextextended(project::text,0));
  perform 1 from public.projects where id=project and user_id=new.user_id for key share;
  if not found then raise exception 'PROJECT_NOT_FOUND'; end if;
  if (select count(*) from public.source_capture_conflicts where project_id=project and resolved_at is null)>=400 then
    raise exception 'SOURCE_REVIEW_REQUIRED' using errcode='P0001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('path',path,'revision',revision,
    'digest',encode(sha256(convert_to(content,'UTF8')),'hex')) order by path),'[]')
    into baseline from public.source_files where project_id=project and user_id=new.user_id and not deleted and private.safe_capture_path(path);
  insert into public.source_capture_jobs(id,user_id,project_id,sandbox_session_id,baseline)
    values(new.id,new.user_id,project,new.sandbox_session_id,baseline);
  return new;
end $$;
revoke all on function private.enqueue_command_capture() from public,anon,authenticated;

-- Filter metadata in queued jobs only; preserve saved source/conflicts for
-- explicit review. This never turns exclusion into a deletion instruction.
update public.source_capture_jobs j set baseline=(select coalesce(jsonb_agg(value),'[]')
  from jsonb_array_elements(j.baseline) where private.safe_capture_path(value->>'path'));
