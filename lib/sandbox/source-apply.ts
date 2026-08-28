import { createHash, randomUUID } from 'node:crypto'
import type { Session } from '@vercel/sandbox'
import { RUNTIME_GATE_PROGRAM } from './runtime-programs.mjs'

export interface AppliedSourceFile { path: string; content: string; revision: number }

/**
 * Trusted, fixed program, never model-supplied code. The default workspace user
 * cannot change its root-owned lock or revision journal. Python isolated mode
 * prevents imports from the learner's cwd/PYTHONPATH. Payloads are uploaded as
 * data (not argv-sized code) and authenticated by a server-computed digest.
 *
 * A journal entry advances BEFORE the workspace rename. If the process dies
 * between the two, older writers remain fenced; the same revision can repair
 * the unfinished application. The VM lock is released by the kernel on exit.
 */
export const SOURCE_FILESYSTEM_PROGRAM = RUNTIME_GATE_PROGRAM + String.raw`
import fcntl, hashlib, json, os, re, stat, sys, time, uuid

class ApplyFailure(Exception):
    def __init__(self, code): self.code = code

def fail(code): raise ApplyFailure(code)

def open_directory(path, owner):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if info.st_uid != owner:
        os.close(fd)
        fail('SOURCE_PATH_UNSAFE')
    return fd

def parent_for(root, path, uid, gid):
    current = os.dup(root)
    try:
        for part in path.split('/')[:-1]:
            created = False
            try:
                os.mkdir(part, 0o755, dir_fd=current)
                created = True
            except FileExistsError: pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            if created: os.fchown(next_fd, uid, gid)
            if os.fstat(next_fd).st_uid != uid:
                os.close(next_fd)
                fail('SOURCE_PATH_UNSAFE')
            os.close(current)
            current = next_fd
        return current
    except BaseException:
        os.close(current)
        raise

def existing_file(parent, name):
    try: info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError: return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: fail('SOURCE_PATH_UNSAFE')
    return info

def file_content(parent, name):
    try: fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError: return None
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1: fail('SOURCE_PATH_UNSAFE')
        if before.st_size > 262144: fail('SOURCE_FILE_TOO_LARGE')
        content = stream.read(262145)
        after = os.fstat(stream.fileno())
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        signature = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if signature(before) != signature(after) or signature(after) != signature(current): fail('SOURCE_CAPTURE_BUSY')
        if len(content) > 262144: fail('SOURCE_FILE_TOO_LARGE')
        return content

def atomic_write(parent, name, content, uid, gid, mode):
    temporary = '.codetutor-write-' + uuid.uuid4().hex
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fchown(stream.fileno(), uid, gid)
            os.fsync(stream.fileno())
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try: os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError: pass

def read_record(state, key):
    try: fd = os.open(key, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=state)
    except FileNotFoundError: return {'revision': 0, 'digest': None, 'appliedRevision': 0, 'appliedDigest': None}
    with os.fdopen(fd, 'rb') as stream:
        record = json.loads(stream.read(1024))
    if type(record.get('revision')) is not int or not 0 < record['revision'] <= 2147483647:
        fail('SOURCE_JOURNAL_INVALID')
    if 'digest' not in record or (record['digest'] is not None and (not isinstance(record['digest'], str) or not re.fullmatch('[0-9a-f]{64}', record['digest']))):
        fail('SOURCE_JOURNAL_INVALID')
    # Recovery can reserve a deletion before unlinking. Its explicit marker
    # retains the last applied baseline if the process dies before unlink.
    if record['digest'] is None and (record.get('appliedRevision') != record['revision'] or record.get('appliedDigest') is not None):
        if record.get('pendingDeletion') is not True: fail('SOURCE_JOURNAL_INVALID')
    if 'appliedRevision' in record:
        revision, digest = record.get('appliedRevision'), record.get('appliedDigest')
        if type(revision) is not int or not 0 <= revision <= record['revision']: fail('SOURCE_JOURNAL_INVALID')
        if 'appliedDigest' not in record or (revision == 0 and digest is not None) or (digest is not None and (not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest))):
            fail('SOURCE_JOURNAL_INVALID')
    return record

def applied_baseline(record, disk_digest):
    # A crash after atomic replacement but before its final journal update can
    # be proved complete by the bytes. Never assume a reserved revision was
    # applied just because it appears in the write-ahead journal.
    if record['revision'] and disk_digest == record['digest']:
        return {'revision': record['revision'], 'digest': record['digest'], 'pending': False}
    return {'revision': record.get('appliedRevision'), 'digest': record.get('appliedDigest'),
            'pending': record.get('appliedRevision') != record['revision']}

def validate(files):
    if not isinstance(files, list) or not 1 <= len(files) <= 200: fail('INVALID_SOURCE')
    paths = set()
    total = 0
    for item in files:
        if not isinstance(item, dict): fail('INVALID_SOURCE')
        path, content, revision = item.get('path'), item.get('content'), item.get('revision')
        if not isinstance(path, str) or not 1 <= len(path) <= 240 or path in paths: fail('INVALID_SOURCE')
        if re.search(r'[\\\x00-\x1f\x7f]', path) or any(part in ('', '.', '..') for part in path.split('/')): fail('SOURCE_PATH_UNSAFE')
        if not isinstance(content, str) or type(revision) is not int or not 1 <= revision <= 2147483647: fail('INVALID_SOURCE')
        size = len(content.encode('utf-8'))
        if size > 262144: fail('INVALID_SOURCE')
        total += size
        paths.add(path)
    if total > 10485760: fail('INVALID_SOURCE')

def apply(files, workspace, state_path='/var/lib/codetutor-source-v1', trusted_uid=0, runtime_path='/var/lib/codetutor-runtime-v1'):
    validate(files)
    try: os.mkdir(state_path, 0o700)
    except FileExistsError: pass
    state = open_directory(state_path, trusted_uid)
    lock = root = None
    parents = []
    try:
        if stat.S_IMODE(os.fstat(state).st_mode) & 0o077: fail('SOURCE_JOURNAL_INVALID')
        lock = os.open('apply.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=state)
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline: fail('SOURCE_APPLY_BUSY')
                time.sleep(0.02)
        try: assert_runtime_open(runtime_path, trusted_uid)
        except RuntimeGateFailure as error: fail(error.code)
        root = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        owner = os.fstat(root)
        prepared = []
        # Reject a stale batch before applying any of its files.
        for item in files:
            path = item['path']
            key = hashlib.sha256(path.encode()).hexdigest() + '.json'
            digest = hashlib.sha256(item['content'].encode('utf-8')).hexdigest()
            record = read_record(state, key)
            if record['revision'] > item['revision']: fail('SOURCE_SUPERSEDED')
            if record['revision'] == item['revision'] and record['digest'] != digest: fail('SOURCE_REVISION_MISMATCH')
            parent = parent_for(root, path, owner.st_uid, owner.st_gid)
            parents.append(parent)
            name = path.split('/')[-1]
            info = existing_file(parent, name)
            content = file_content(parent, name)
            disk_digest = hashlib.sha256(content).hexdigest() if content is not None else None
            baseline = applied_baseline(record, disk_digest)
            # Terminal edits/deletions and untracked files are not permission
            # to overwrite them with an editor retry or delayed generation.
            if disk_digest != digest and (baseline['revision'] is None or disk_digest != baseline['digest']):
                fail('SOURCE_WORKSPACE_CHANGED')
            prepared.append((item, key, digest, parent, name, stat.S_IMODE(info.st_mode) & 0o777 if info else 0o644, baseline))
        for item, key, digest, parent, name, mode, baseline in prepared:
            record = {'path': item['path'], 'revision': item['revision'], 'digest': digest,
                      'appliedRevision': baseline['revision'] or 0, 'appliedDigest': baseline['digest']}
            atomic_write(state, key, json.dumps(record, separators=(',', ':')).encode(), trusted_uid, os.fstat(state).st_gid, 0o600)
            atomic_write(parent, name, item['content'].encode('utf-8'), owner.st_uid, owner.st_gid, mode)
            record.update({'appliedRevision': item['revision'], 'appliedDigest': digest})
            atomic_write(state, key, json.dumps(record, separators=(',', ':')).encode(), trusted_uid, os.fstat(state).st_gid, 0o600)
        return [{'path': item['path'], 'revision': item['revision']} for item in files]
    finally:
        for parent in parents: os.close(parent)
        if root is not None: os.close(root)
        if lock is not None: os.close(lock)
        os.close(state)

`

export const SOURCE_APPLY_PROGRAM = SOURCE_FILESYSTEM_PROGRAM + String.raw`

def main():
    stage, expected, workspace = sys.argv[1:]
    if not re.fullmatch(r'/tmp/codetutor-source-[0-9a-f-]{36}\.json', stage) or not re.fullmatch('[0-9a-f]{64}', expected):
        fail('INVALID_SOURCE')
    try:
        fd = os.open(stage, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024 * 1024: fail('INVALID_SOURCE')
            data = stream.read(64 * 1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != expected: fail('SOURCE_PAYLOAD_CHANGED')
        print(json.dumps({'applied': apply(json.loads(data), workspace)}, ensure_ascii=True))
    finally:
        try: os.unlink(stage)
        except FileNotFoundError: pass

if __name__ == '__main__':
    try: main()
    except ApplyFailure as error:
        print(json.dumps({'error': error.code}))
        sys.exit(1)
    except BaseException:
        # No paths, source text or raw OS/provider errors in output.
        print(json.dumps({'error': 'SOURCE_APPLY_FAILED'}))
        sys.exit(1)
`

export class SourceApplyError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code; this.name = 'SourceApplyError' }
}

/** Requires a fixed Session, not an auto-resuming Sandbox. */
export async function applySandboxSource(vm: Pick<Session, 'writeFiles' | 'runCommand' | 'cwd'>, files: AppliedSourceFile[]) {
  // Sandbox 3's image defines its cwd. It is not necessarily /vercel/sandbox.
  if (!vm.cwd || !vm.cwd.startsWith('/') || vm.cwd === '/' || vm.cwd.includes('\0')) throw new SourceApplyError('SOURCE_WORKSPACE_INVALID')
  const data = Buffer.from(JSON.stringify(files), 'utf8')
  const stage = `/tmp/codetutor-source-${randomUUID()}.json`
  const digest = createHash('sha256').update(data).digest('hex')
  try {
    await vm.writeFiles([{ path: stage, content: data, mode: 0o600 }], { signal: AbortSignal.timeout(15_000) })
    const result = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', SOURCE_APPLY_PROGRAM, stage, digest, vm.cwd],
      cwd: '/', sudo: true, timeoutMs: 10_000, signal: AbortSignal.timeout(15_000) })
    const response: unknown = JSON.parse(await result.stdout())
    if (!response || typeof response !== 'object') throw new SourceApplyError('SOURCE_RECEIPT_INVALID')
    if (result.exitCode !== 0) {
      throw new SourceApplyError('error' in response && typeof response.error === 'string' ? response.error : 'SOURCE_APPLY_FAILED')
    }
    const applied = 'applied' in response ? response.applied : undefined
    if (!Array.isArray(applied) || applied.length !== files.length || applied.some((item, index) =>
      !item || item.path !== files[index].path || item.revision !== files[index].revision)) {
      throw new SourceApplyError('SOURCE_RECEIPT_INVALID')
    }
  } catch (error) {
    // The normal path unlinks its staging file itself. Also clean up uploads
    // that never reached the program; this exact random path is ours alone.
    await vm.runCommand({ cmd: '/usr/bin/rm', args: ['-f', '--', stage], cwd: '/', sudo: false,
      timeoutMs: 1_000, signal: AbortSignal.timeout(3_000) }).catch(() => undefined)
    if (error instanceof SourceApplyError) throw error
    throw new SourceApplyError('SOURCE_APPLY_FAILED')
  }
}
