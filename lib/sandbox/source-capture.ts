import { createHash, randomUUID } from 'node:crypto'
import type { Session } from '@vercel/sandbox'
import { z } from 'zod'
import { abortableRead } from '@/lib/abortable-read'
import { BINARY_EXTENSIONS, EXCLUDED_SEGMENTS, isSafeSnapshotPath, sourceByteLength } from '@/lib/learning/snapshots'
import { SOURCE_FILESYSTEM_PROGRAM } from './source-apply'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const baselineSchema = z.object({
  path: z.string().refine(isSafeSnapshotPath),
  baseRevision: z.number().int().min(0).max(2_147_483_647).nullable(),
  baseDigest: digestSchema.nullable(),
  pending: z.boolean(),
})
export const capturedSourceEntrySchema = z.discriminatedUnion('kind', [
  baselineSchema.extend({ kind: z.literal('file'), content: z.string().refine((value) => sourceByteLength(value) <= 262144), digest: digestSchema }),
  baselineSchema.extend({ kind: z.literal('missing') }),
  baselineSchema.extend({ kind: z.literal('skipped'), reason: z.enum(['unsafe', 'too-large', 'binary']) }),
])
export type CapturedSourceEntry = z.infer<typeof capturedSourceEntrySchema>
export const sourceCaptureSchema = z.object({
  entries: z.array(capturedSourceEntrySchema).max(400),
  complete: z.boolean(),
  totalBytes: z.number().int().min(0).max(10 * 1024 * 1024),
  excluded: z.number().int().nonnegative(),
}).superRefine((value, context) => {
  const files = value.entries.filter((entry) => entry.kind === 'file')
  if (new Set(value.entries.map((entry) => entry.path)).size !== value.entries.length || files.length > 200 ||
    value.totalBytes !== files.reduce((total, entry) => total + sourceByteLength(entry.content), 0) ||
    value.complete !== !value.entries.some((entry) => entry.kind === 'skipped' || entry.pending) ||
    files.some((entry) => createHash('sha256').update(entry.content).digest('hex') !== entry.digest) ||
    value.entries.some((entry) => (entry.baseRevision === 0 && entry.baseDigest !== null) ||
      (entry.baseRevision === null && (!entry.pending || entry.baseDigest !== null)))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid source capture receipt.' })
  }
})

/** Fixed, isolated reader. It returns only owned, regular source files, never
 * follows symlinks, and shares the source writer's protected revision lock. */
export const SOURCE_CAPTURE_FILESYSTEM_PROGRAM = SOURCE_FILESYSTEM_PROGRAM + `
EXCLUDED = set(${JSON.stringify([...EXCLUDED_SEGMENTS])})
BINARY = set(${JSON.stringify([...BINARY_EXTENSIONS])})
` + String.raw`

def safe_source(path, directory=False):
    if not isinstance(path, str) or re.search(r'[\\\x00-\x1f\x7f]', path): return False
    try:
        if not 1 <= len(path.encode('utf-16-le')) // 2 <= 240: return False
    except UnicodeEncodeError: return False
    parts = path.split('/')
    if any(part in ('', '.', '..') or part in EXCLUDED or part.startswith('.codetutor-') for part in parts): return False
    name = parts[-1]
    if name == '.env' or (name.startswith('.env.') and name != '.env.example'): return False
    return directory or '.' not in name or name.rsplit('.', 1)[-1].lower() not in BINARY

def read_source(root, path, owner):
    parent = os.dup(root)
    try:
        for part in path.split('/')[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            if os.fstat(next_fd).st_uid != owner:
                os.close(next_fd)
                fail('SOURCE_PATH_UNSAFE')
            os.close(parent)
            parent = next_fd
        # Replacing a source file with an owned directory deletes the file; it
        # is not equivalent to following a symlink or accepting a special file.
        try: target = os.stat(path.split('/')[-1], dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError: return None
        if stat.S_ISDIR(target.st_mode) and target.st_uid == owner: return None
        info = existing_file(parent, path.split('/')[-1])
        if info is not None and info.st_uid != owner: fail('SOURCE_PATH_UNSAFE')
        return file_content(parent, path.split('/')[-1])
    finally: os.close(parent)

def capture(workspace, tracked, state_path='/var/lib/codetutor-source-v1', trusted_uid=0):
    if not isinstance(tracked, list) or len(tracked) > 200 or any(not safe_source(path) for path in tracked): fail('INVALID_SOURCE')
    try: os.mkdir(state_path, 0o700)
    except FileExistsError: pass
    state = open_directory(state_path, trusted_uid)
    root = lock = None
    entries = []
    total = excluded = visited = file_count = 0
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
        root = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        owner = os.fstat(root).st_uid
        paths = set(tracked)
        # Journal paths make deleted files discoverable after browser closure.
        # Legacy journal records have no path; callers provide saved DB paths.
        for name in os.listdir(state):
            if not re.fullmatch('[0-9a-f]{64}\.json', name): continue
            record = read_record(state, name)
            path = record.get('path')
            if path is not None:
                # A prior image/scanner may have journaled a tool-home file.
                # Ignore newly excluded runtime metadata rather than reading
                # it or making every future project capture fail forever.
                if isinstance(path, str) and any(part in EXCLUDED for part in path.split('/')):
                    excluded += 1
                    continue
                if not safe_source(path) or hashlib.sha256(path.encode()).hexdigest() + '.json' != name: fail('SOURCE_JOURNAL_INVALID')
                # Confirmed absent paths need not consume scan capacity on
                # every run. If recreated, walking the workspace finds them
                # and their retained journal supplies the deletion revision.
                if record['digest'] is not None: paths.add(path)
            if len(paths) > 400: fail('SOURCE_SCAN_LIMIT')
        def walk(directory, prefix='', depth=0):
            nonlocal visited, excluded
            if depth > 120: fail('SOURCE_SCAN_LIMIT')
            with os.scandir(directory) as listing:
                for item in listing:
                    visited += 1
                    if visited > 20000: fail('SOURCE_SCAN_LIMIT')
                    path = prefix + item.name
                    directory_entry = item.is_dir(follow_symlinks=False)
                    if not safe_source(path, directory=directory_entry):
                        excluded += 1
                        continue
                    if directory_entry:
                        child = os.open(item.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                        try:
                            if os.fstat(child).st_uid != owner: fail('SOURCE_PATH_UNSAFE')
                            walk(child, path + '/', depth + 1)
                        finally: os.close(child)
                    else:
                        paths.add(path)
                        if len(paths) > 400: fail('SOURCE_SCAN_LIMIT')
        walk(root)
        for path in sorted(paths):
            record = read_record(state, hashlib.sha256(path.encode()).hexdigest() + '.json')
            data = None
            reason = None
            try: data = read_source(root, path, owner)
            except FileNotFoundError: pass
            except ApplyFailure as error:
                if error.code == 'SOURCE_FILE_TOO_LARGE': reason = 'too-large'
                elif error.code == 'SOURCE_PATH_UNSAFE': reason = 'unsafe'
                else: raise
            except OSError as error:
                if error.errno in (20, 40, 13): reason = 'unsafe'
                else: raise
            digest = hashlib.sha256(data).hexdigest() if data is not None else None
            base = applied_baseline(record, digest)
            entry = {'path': path, 'baseRevision': base['revision'], 'baseDigest': base['digest'], 'pending': base['pending']}
            if reason is None and data is not None:
                try:
                    content = data.decode('utf-8', errors='strict')
                    if '\x00' in content: reason = 'binary'
                except UnicodeDecodeError: reason = 'binary'
            if reason:
                entry.update({'kind': 'skipped', 'reason': reason})
            elif data is None:
                entry['kind'] = 'missing'
            else:
                total += len(data)
                file_count += 1
                if total > 10485760 or file_count > 200: fail('SOURCE_SCAN_LIMIT')
                entry.update({'kind': 'file', 'content': content, 'digest': digest})
            entries.append(entry)
        return {'entries': entries, 'complete': not any(entry['kind'] == 'skipped' or entry['pending'] for entry in entries), 'totalBytes': total, 'excluded': excluded}
    finally:
        if root is not None: os.close(root)
        if lock is not None: os.close(lock)
        os.close(state)

`

export const SOURCE_CAPTURE_PROGRAM = SOURCE_CAPTURE_FILESYSTEM_PROGRAM + String.raw`

def capture_main():
    stage, expected, output, workspace = sys.argv[1:]
    if not re.fullmatch(r'/tmp/codetutor-capture-input-[0-9a-f-]{36}\.json', stage) or not re.fullmatch(r'/tmp/codetutor-capture-output-[0-9a-f-]{36}\.json', output) or not re.fullmatch('[0-9a-f]{64}', expected): fail('INVALID_SOURCE')
    fd = os.open(stage, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): fail('INVALID_SOURCE')
        data = stream.read(512 * 1024 + 1)
    if len(data) > 512 * 1024 or hashlib.sha256(data).hexdigest() != expected: fail('SOURCE_PAYLOAD_CHANGED')
    data = json.dumps(capture(workspace, json.loads(data)), ensure_ascii=True, separators=(',', ':')).encode('ascii')
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({'bytes': len(data), 'digest': hashlib.sha256(data).hexdigest()}))

if __name__ == '__main__':
    try: capture_main()
    except ApplyFailure as error:
        print(json.dumps({'error': error.code}))
        sys.exit(1)
    except BaseException:
        print(json.dumps({'error': 'SOURCE_CAPTURE_FAILED'}))
        sys.exit(1)
`

export class SourceCaptureError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code; this.name = 'SourceCaptureError' }
}

/** Read-only with respect to workspace source; creates/deletes only its own
 * temporary capture artifacts. The source contents never enter command logs. */
export async function captureSandboxSource(vm: Pick<Session, 'cwd' | 'writeFiles' | 'runCommand' | 'readFile'>, trackedPaths: string[], callerSignal?: AbortSignal) {
  if (!vm.cwd || !vm.cwd.startsWith('/') || vm.cwd === '/' || vm.cwd.includes('\0') || trackedPaths.length > 200 || trackedPaths.some((path) => !isSafeSnapshotPath(path))) {
    throw new SourceCaptureError('INVALID_SOURCE')
  }
  const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(callerSignal ? [callerSignal] : [])])
  const id = randomUUID()
  const stage = `/tmp/codetutor-capture-input-${id}.json`
  const output = `/tmp/codetutor-capture-output-${id}.json`
  const data = Buffer.from(JSON.stringify(trackedPaths))
  try {
    signal.throwIfAborted()
    await vm.writeFiles([{ path: stage, content: data, mode: 0o600 }], { signal })
    const command = await vm.runCommand({ cmd: '/usr/bin/python3', args: ['-I', '-S', '-c', SOURCE_CAPTURE_PROGRAM, stage, createHash('sha256').update(data).digest('hex'), output, vm.cwd], cwd: '/', sudo: true, timeoutMs: 10_000, signal })
    const result: unknown = JSON.parse(await abortableRead(() => command.stdout(), signal))
    if (command.exitCode !== 0) {
      const error = z.object({ error: z.string().regex(/^SOURCE_[A-Z_]+$|^INVALID_SOURCE$/) }).safeParse(result)
      throw new SourceCaptureError(error.success ? error.data.error : 'SOURCE_CAPTURE_FAILED')
    }
    const receipt = z.object({ bytes: z.number().int().positive().max(64 * 1024 * 1024), digest: digestSchema }).parse(result)
    const stream = await vm.readFile({ path: output }, { signal })
    if (!stream) throw new SourceCaptureError('SOURCE_CAPTURE_MISSING')
    const iterator = stream[Symbol.asyncIterator]()
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const item = await abortableRead(() => iterator.next(), signal)
        if (item.done) break
        const chunk = Buffer.from(item.value)
        total += chunk.byteLength
        if (total > receipt.bytes) throw new SourceCaptureError('SOURCE_CAPTURE_CHANGED')
        chunks.push(chunk)
      }
    } finally { void iterator.return?.().catch(() => undefined) }
    const body = Buffer.concat(chunks)
    if (total !== receipt.bytes || createHash('sha256').update(body).digest('hex') !== receipt.digest) throw new SourceCaptureError('SOURCE_CAPTURE_CHANGED')
    return sourceCaptureSchema.parse(JSON.parse(body.toString('utf8')))
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof SourceCaptureError) throw error
    throw new SourceCaptureError('SOURCE_CAPTURE_FAILED')
  } finally {
    await vm.runCommand({ cmd: '/usr/bin/rm', args: ['-f', '--', stage, output], cwd: '/', sudo: true, timeoutMs: 1_000, signal: AbortSignal.timeout(3_000) }).catch(() => undefined)
  }
}
