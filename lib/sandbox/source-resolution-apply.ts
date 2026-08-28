import { createHash, randomUUID } from 'node:crypto'
import type { Session } from '@vercel/sandbox'
import { SOURCE_FILESYSTEM_PROGRAM, SourceApplyError } from './source-apply'
import { abortableRead } from '@/lib/abortable-read'

export interface ResolvedSourceApplication {
  path: string
  content: string | null
  revision: number
  expectedDigest: string | null
}

// An exclusive admission lock excludes every gated learner namespace, including
// background preview servers. Never kill processes or overwrite changed bytes
// as an implicit side effect of applying a review. Management writers and the
// capture worker additionally serialize on apply.lock.
export const SOURCE_RESOLUTION_PROGRAM = SOURCE_FILESYSTEM_PROGRAM + String.raw`
def apply_resolution(item, workspace, state_path='/var/lib/codetutor-source-v1', runtime_path='/var/lib/codetutor-runtime-v1', trusted_uid=0):
    if not isinstance(item, dict): fail('INVALID_SOURCE')
    path, content, revision, expected = item.get('path'), item.get('content'), item.get('revision'), item.get('expectedDigest')
    validate([{'path': path, 'content': content if content is not None else '', 'revision': max(1, revision) if type(revision) is int else revision}])
    if revision == 0 and content is not None: fail('INVALID_SOURCE')
    if type(revision) is not int or revision < 0: fail('INVALID_SOURCE')
    if content is not None and not isinstance(content, str): fail('INVALID_SOURCE')
    if 'expectedDigest' not in item or (expected is not None and (not isinstance(expected, str) or not re.fullmatch('[a-f0-9]{64}', expected))): fail('INVALID_SOURCE')
    runtime = command_lock = state = lock = root = parent = None
    try:
        initialize_runtime(runtime_path, trusted_uid)
        runtime = runtime_directory(runtime_path, trusted_uid)
        command_lock = runtime_file(runtime, 'commands.lock', os.O_RDONLY, owner=trusted_uid)
        try: fcntl.flock(command_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: fail('SOURCE_COMMANDS_RUNNING')
        if runtime_closed(runtime): fail('SANDBOX_CLOSING')
        try: os.mkdir(state_path, 0o700)
        except FileExistsError: pass
        state = open_directory(state_path, trusted_uid)
        if stat.S_IMODE(os.fstat(state).st_mode) & 0o077: fail('SOURCE_JOURNAL_INVALID')
        lock = open_source_lock(state, trusted_uid, time.monotonic() + 0.05)
        # Bounded, no lock-order deadlock with shutdown or normal writes.
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: fail('SOURCE_APPLY_BUSY')
        if runtime_closed(runtime): fail('SANDBOX_CLOSING')
        root = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        owner = os.fstat(root)
        key = hashlib.sha256(path.encode()).hexdigest() + '.json'
        record = read_record(state, key)
        digest = hashlib.sha256(content.encode('utf-8')).hexdigest() if content is not None else None
        if record['revision'] > revision: fail('SOURCE_SUPERSEDED')
        if record['revision'] == revision and record['digest'] != digest: fail('SOURCE_REVISION_MISMATCH')
        parent = parent_for(root, path, owner.st_uid, owner.st_gid)
        name = path.split('/')[-1]
        info = existing_file(parent, name)
        disk = file_content(parent, name)
        disk_digest = hashlib.sha256(disk).hexdigest() if disk is not None else None
        # The captured comparison is server-owned. Identical desired bytes are
        # also safe (lost receipt or restoration into a replacement VM).
        if disk_digest != expected and disk_digest != digest: fail('SOURCE_WORKSPACE_CHANGED')
        baseline = applied_baseline(record, disk_digest)
        pending = {'path': path, 'revision': revision, 'digest': digest,
                   'appliedRevision': baseline['revision'] or 0, 'appliedDigest': baseline['digest']}
        if content is None: pending['pendingDeletion'] = True
        if revision:
            atomic_write(state, key, json.dumps(pending, separators=(',', ':')).encode(), trusted_uid, os.fstat(state).st_gid, 0o600)
        if content is None:
            try: os.unlink(name, dir_fd=parent)
            except FileNotFoundError: pass
            os.fsync(parent)
        else:
            atomic_write(parent, name, content.encode('utf-8'), owner.st_uid, owner.st_gid, stat.S_IMODE(info.st_mode) & 0o777 if info else 0o644)
        if revision:
            pending.pop('pendingDeletion', None)
            pending.update({'appliedRevision': revision, 'appliedDigest': digest})
            atomic_write(state, key, json.dumps(pending, separators=(',', ':')).encode(), trusted_uid, os.fstat(state).st_gid, 0o600)
        return {'path': path, 'revision': revision, 'deleted': content is None}
    except RuntimeGateFailure as error: fail(error.code)
    finally:
        for fd in (parent, root, lock, state, command_lock, runtime):
            if fd is not None: os.close(fd)

def resolution_main():
    stage, expected, workspace = sys.argv[1:]
    if not re.fullmatch(r'/tmp/codetutor-resolution-[0-9a-f-]{36}\.json', stage) or not re.fullmatch('[a-f0-9]{64}', expected): fail('INVALID_SOURCE')
    try:
        fd = os.open(stage, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): fail('INVALID_SOURCE')
            data = stream.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected: fail('SOURCE_PAYLOAD_CHANGED')
        print(json.dumps({'applied': apply_resolution(json.loads(data), workspace)}))
    finally:
        try: os.unlink(stage)
        except FileNotFoundError: pass

if __name__ == '__main__':
    try: resolution_main()
    except ApplyFailure as error:
        print(json.dumps({'error': error.code})); sys.exit(1)
    except BaseException:
        print(json.dumps({'error': 'SOURCE_APPLY_FAILED'})); sys.exit(1)
`

/** Separate bounded application after the database resolution is already saved.
 * Browser cancellation cannot roll back VM writes; receipt retries recheck the
 * revision, the captured bytes and both locks before acknowledging success. */
export async function applySandboxResolution(vm: Pick<Session, 'cwd' | 'writeFiles' | 'runCommand'>, file: ResolvedSourceApplication) {
  if (!vm.cwd?.startsWith('/') || vm.cwd === '/' || vm.cwd.includes('\0')) throw new SourceApplyError('SOURCE_WORKSPACE_INVALID')
  const signal = AbortSignal.timeout(25_000)
  const data = Buffer.from(JSON.stringify(file))
  const stage = `/tmp/codetutor-resolution-${randomUUID()}.json`
  try {
    await vm.writeFiles([{ path: stage, content: data, mode: 0o600 }], { signal })
    const command = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', SOURCE_RESOLUTION_PROGRAM, stage, createHash('sha256').update(data).digest('hex'), vm.cwd],
      cwd: '/', sudo: true, timeoutMs: 5_000, signal })
    const result: unknown = JSON.parse(await abortableRead(() => command.stdout({ signal }), signal))
    if (!result || typeof result !== 'object') throw new SourceApplyError('SOURCE_RECEIPT_INVALID')
    if (command.exitCode !== 0) throw new SourceApplyError('error' in result && typeof result.error === 'string' ? result.error : 'SOURCE_APPLY_FAILED')
    const applied = 'applied' in result ? result.applied : undefined
    if (!applied || typeof applied !== 'object' || !('path' in applied) || applied.path !== file.path || !('revision' in applied) || applied.revision !== file.revision || !('deleted' in applied) || applied.deleted !== (file.content === null)) throw new SourceApplyError('SOURCE_RECEIPT_INVALID')
  } catch (error) {
    if (error instanceof SourceApplyError) throw error
    throw new SourceApplyError('SOURCE_APPLY_FAILED')
  } finally {
    await vm.runCommand({ cmd: '/usr/bin/rm', args: ['-f', '--', stage], cwd: '/', sudo: false, timeoutMs: 1_000, signal: AbortSignal.timeout(3_000) }).catch(() => undefined)
  }
}
